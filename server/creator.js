import bcrypt from "bcrypt";
import { getPool } from "./database.js";
import { isCreatorUsername } from "./auth.js";
import { creatorNetworkDirectory, creatorNetworkStatistics, updateCreatorNetworkDirectory } from "./partner-connections.js";
import { createOrganization, getOrganization, getOrganizationHistory, organizationInterfaceAccessMessage, updateOrganization } from "./organizations.js";
import { calculateSubscriptionPriceCents, normalizeSubscriptionTier, subscriptionRoleAccessMessage, subscriptionTierConfig } from "./subscription-tiers.js";
import { createNotification } from "./collaboration.js";
import { deliverSubscriptionProration, prepareSubscriptionProration } from "./invoicing.js";
import { decryptElectronicInvoicingCredentials, encryptElectronicInvoicingCredentials, getElectronicInvoicingProvider } from "./electronic-invoicing.js";

const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;
const MIN_PASSWORD_LENGTH = 12;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MEMBER_ROLES = new Set(["admin", "pc_standard", "accountant", "mobile_admin", "team_lead", "technician"]);
const SUBSCRIPTION_STATUSES = new Set(["active", "trial", "past_due", "suspended", "cancelled"]);
const SUBSCRIPTION_REQUEST_STATUSES = new Set(["new", "under_review", "accepted", "refused", "cancelled"]);
const QUOTE_TEMPLATE_POLICIES = new Set(["integrated_only", "company_choice", "external_only"]);
const EINVOICE_PLATFORM_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,59}$/;
const EINVOICE_AUTHENTICATION_TYPES = new Set(["api_key", "oauth_client", "access_token", "identifier_secret", "custom_secret", "provider_specific"]);
const EINVOICE_LIFECYCLE_STATUSES = new Set(["documentation_required", "specification_review", "development", "validation", "deployed", "suspended"]);

export function registerCreatorRoutes(app, requireCreator, requireAuthentication) {
    app.get("/api/creator/request-notifications", requireCreator, asyncHandler(async (_request, response) => {
        const [subscriptions, support, partners] = await Promise.all([
            getPool().query(`SELECT change.id,'subscription' AS source,COALESCE(NULLIF(profile.company_name,''),NULLIF(owner.company_name,''),owner.full_name,owner.username) AS "senderName",'Demande d’offre ou de postes' AS title,change.status,change.created_at AS "createdAt" FROM depannhome_subscription_change_requests change JOIN depannhome_users owner ON owner.id=change.owner_id LEFT JOIN depannhome_billing_profiles profile ON profile.owner_id=owner.id WHERE change.status IN ('new','under_review') ORDER BY change.created_at DESC LIMIT 50`),
            getPool().query(`SELECT support.id,'support' AS source,COALESCE(NULLIF(profile.company_name,''),NULLIF(owner.company_name,''),support.sender_name,support.sender_username) AS "senderName",'Message Support interne' AS title,support.status,support.created_at AS "createdAt" FROM depannhome_support_requests support JOIN depannhome_users owner ON owner.id=support.owner_id LEFT JOIN depannhome_billing_profiles profile ON profile.owner_id=owner.id WHERE support.status IN ('new','under_review') ORDER BY support.created_at DESC LIMIT 50`),
            getPool().query(`SELECT id,'partner' AS source,company_name AS "senderName",'Demande de partenariat externe' AS title,status,created_at AS "createdAt" FROM depannhome_partner_requests WHERE status IN ('new','under_review') ORDER BY created_at DESC LIMIT 50`)
        ]);
        const items = [...subscriptions.rows, ...support.rows, ...partners.rows].sort((first, second) => new Date(second.createdAt) - new Date(first.createdAt)).slice(0, 100);
        response.json({ total: items.length, counts: { subscriptions: subscriptions.rowCount, support: support.rowCount, partners: partners.rowCount }, items });
    }));
    app.get("/api/subscription-change-requests", requireAuthentication, asyncHandler(async (request, response) => {
        if (request.user?.role !== "admin") return response.status(403).json({ message: "La gestion de l’offre est réservée à l’Administrateur de l’entreprise." });
        const [requestsResult, accountResult, invoiceResult] = await Promise.all([
            getPool().query(`SELECT id,current_tier AS "currentTier",requested_tier AS "requestedTier",requested_pc_seats AS "requestedPcSeats",requested_mobile_seats AS "requestedMobileSeats",status,company_message AS "companyMessage",created_at AS "createdAt",updated_at AS "updatedAt" FROM depannhome_subscription_change_requests WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 20`, [request.user.accountOwnerId]),
            getPool().query(`SELECT subscription_tier AS "subscriptionTier",subscription_label AS "subscriptionLabel",subscription_plan AS "subscriptionPlan",subscription_status AS "subscriptionStatus",TO_CHAR(subscription_renewal_date,'YYYY-MM-DD') AS "subscriptionRenewalDate",billing_reference AS "billingReference",subscription_discount_label AS "discountLabel",subscription_discount_mode AS "discountMode",subscription_discount_value::float AS "discountValue",max_pc_users AS "maxPcUsers",max_technicians AS "maxMobileUsers" FROM depannhome_users WHERE id=$1 AND account_owner_id=id`, [request.user.accountOwnerId]),
            getPool().query(`SELECT invoice.invoice_number AS "invoiceNumber",TO_CHAR(invoice.billing_period,'YYYY-MM-DD') AS "billingPeriod",TO_CHAR(invoice.issue_date,'YYYY-MM-DD') AS "issueDate",TO_CHAR(invoice.due_date,'YYYY-MM-DD') AS "dueDate",invoice.amount_cents AS "amountCents",invoice.net_amount_cents AS "netAmountCents",invoice.status,invoice.sent_at AS "sentAt",invoice.payment_status AS "paymentStatus",invoice.paid_amount_cents AS "paidAmountCents",TO_CHAR(invoice.paid_date,'YYYY-MM-DD') AS "paidDate",invoice.receipt_delivery_status AS "receiptDeliveryStatus",COALESCE(credits.total,0)::integer AS "creditedAmountCents",COALESCE(credits.pending_refund,0)::integer AS "pendingRefundCents",GREATEST(invoice.net_amount_cents-COALESCE(credits.total,0)-invoice.paid_amount_cents,0)::integer AS "outstandingAmountCents" FROM depannhome_subscription_invoices invoice LEFT JOIN LATERAL (SELECT SUM(credit.amount_cents)::integer AS total,SUM(credit.amount_cents) FILTER (WHERE credit.refund_status='pending')::integer AS pending_refund FROM depannhome_subscription_credit_notes credit WHERE credit.source_invoice_id=invoice.id) credits ON TRUE WHERE invoice.account_owner_id=$1 AND invoice.status<>'cancelled' ORDER BY invoice.billing_period DESC,invoice.id DESC LIMIT 1`, [request.user.accountOwnerId])
        ]);
        const account = accountResult.rows[0];
        if (!account) return response.status(404).json({ message: "Entreprise introuvable." });
        response.json({ requests: requestsResult.rows, account: { ...account, monthlyPriceCents: calculateSubscriptionPriceCents(account.subscriptionTier, account.maxPcUsers, account.maxMobileUsers), latestInvoice: invoiceResult.rows[0] || null } });
    }));
    app.post("/api/subscription-change-requests", requireAuthentication, asyncHandler(async (request, response) => {
        if (request.user?.role !== "admin") return response.status(403).json({ message: "La demande de changement d’offre est réservée à l’Administrateur de l’entreprise." });
        const requestedTier = normalizeSubscriptionTier(request.body?.requestedTier, "");
        const requestedPcSeats = positiveLimit(request.body?.requestedPcSeats, 1, 100);
        const requestedMobileSeats = positiveLimit(request.body?.requestedMobileSeats, 0, 500);
        const companyMessage = cleanMultilineText(request.body?.companyMessage, 1000);
        const owner = await findAccountOwner(getPool(), positiveId(request.user.accountOwnerId));
        if (!owner) return response.status(404).json({ message: "Entreprise introuvable." });
        if (!requestedTier || requestedPcSeats === null || requestedMobileSeats === null) return response.status(400).json({ message: "Choisissez une offre et des nombres de postes valides." });
        const requestsTierChange = requestedTier !== owner.subscriptionTier;
        const requestsMoreSeats = requestedPcSeats > owner.maxPcUsers || requestedMobileSeats > owner.maxTechnicians;
        if (!requestsTierChange && !requestsMoreSeats) return response.status(400).json({ message: "Augmentez au moins un nombre de postes ou choisissez une autre offre." });
        const duplicate = await getPool().query("SELECT id FROM depannhome_subscription_change_requests WHERE owner_id=$1 AND status IN ('new','under_review') LIMIT 1", [owner.id]);
        if (duplicate.rowCount) return response.status(409).json({ message: "Une demande de changement d’offre est déjà en cours de traitement." });
        const { rows } = await getPool().query(`INSERT INTO depannhome_subscription_change_requests(owner_id,requested_by,current_tier,requested_tier,requested_pc_seats,requested_mobile_seats,company_message) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,current_tier AS "currentTier",requested_tier AS "requestedTier",requested_pc_seats AS "requestedPcSeats",requested_mobile_seats AS "requestedMobileSeats",status,company_message AS "companyMessage",created_at AS "createdAt"`, [owner.id, request.user.sub, owner.subscriptionTier, requestedTier, requestedPcSeats, requestedMobileSeats, companyMessage]);
        await notifyCreatorsOfSubscriptionRequest(rows[0], owner);
        response.status(201).json({ request: rows[0], message: "Votre demande a été transmise au Support. Votre offre actuelle reste inchangée pendant son étude." });
    }));
    app.get("/api/creator/subscription-change-requests", requireCreator, asyncHandler(async (_request, response) => {
        const { rows } = await getPool().query(`SELECT change.id,change.owner_id AS "ownerId",COALESCE(NULLIF(profile.company_name,''),NULLIF(owner.company_name,''),owner.full_name,owner.username) AS "companyName",change.current_tier AS "currentTier",change.requested_tier AS "requestedTier",change.requested_pc_seats AS "requestedPcSeats",change.requested_mobile_seats AS "requestedMobileSeats",change.status,change.company_message AS "companyMessage",change.creator_note AS "creatorNote",change.created_at AS "createdAt",change.updated_at AS "updatedAt" FROM depannhome_subscription_change_requests change JOIN depannhome_users owner ON owner.id=change.owner_id LEFT JOIN depannhome_billing_profiles profile ON profile.owner_id=owner.id ORDER BY CASE change.status WHEN 'new' THEN 0 WHEN 'under_review' THEN 1 ELSE 2 END,change.created_at DESC LIMIT 200`);
        response.json({ requests: rows });
    }));
    app.patch("/api/creator/subscription-change-requests/:requestId", requireCreator, asyncHandler(async (request, response) => {
        const requestId = positiveId(request.params.requestId);
        const status = SUBSCRIPTION_REQUEST_STATUSES.has(request.body?.status) ? request.body.status : "";
        const creatorNote = cleanMultilineText(request.body?.creatorNote, 2000);
        if (!requestId || !status) return response.status(400).json({ message: "Suivi de demande invalide." });
        const terminal = ["accepted", "refused", "cancelled"].includes(status);
        const { rows } = await getPool().query(`UPDATE depannhome_subscription_change_requests SET status=$2,creator_note=$3,resolved_by=CASE WHEN $4::boolean THEN $5::bigint ELSE NULL::bigint END,resolved_at=CASE WHEN $4::boolean THEN NOW() ELSE NULL::timestamptz END,updated_at=NOW() WHERE id=$1 RETURNING id,status,creator_note AS "creatorNote",updated_at AS "updatedAt"`, [requestId, status, creatorNote, terminal, request.user.sub]);
        if (!rows[0]) return response.status(404).json({ message: "Demande introuvable." });
        response.json({ request: rows[0] });
    }));
    app.get("/api/creator/platform-announcement/current", requireAuthentication, asyncHandler(async (request, response) => {
        const { rows } = await getPool().query(`
            SELECT message, updated_at AS "updatedAt"
            FROM depannhome_platform_announcements
            WHERE id = TRUE AND is_active = TRUE
        `);
        response.json({ announcement: rows[0] || null });
    }));
    app.get("/api/creator/platform-announcement", requireCreator, asyncHandler(async (request, response) => {
        const { rows } = await getPool().query(`
            SELECT message, is_active AS "isActive", updated_at AS "updatedAt"
            FROM depannhome_platform_announcements
            WHERE id = TRUE
        `);
        response.json({ announcement: rows[0] || { message: "", isActive: false, updatedAt: null } });
    }));
    app.put("/api/creator/platform-announcement", requireCreator, asyncHandler(async (request, response) => {
        const message = cleanMultilineText(request.body?.message, 2000);
        const isActive = Boolean(request.body?.isActive);
        if (isActive && !message) return response.status(400).json({ message: "Saisissez le message à diffuser avant de l’activer." });
        const { rows } = await getPool().query(`
            INSERT INTO depannhome_platform_announcements (id, message, is_active, updated_by)
            VALUES (TRUE, $1, $2, $3)
            ON CONFLICT (id) DO UPDATE
            SET message = EXCLUDED.message, is_active = EXCLUDED.is_active, updated_by = EXCLUDED.updated_by, updated_at = NOW()
            RETURNING message, is_active AS "isActive", updated_at AS "updatedAt"
        `, [message, isActive, request.user.sub]);
        response.json({ announcement: rows[0] });
    }));
    app.get("/api/creator/e-invoicing-platforms", requireCreator, asyncHandler(async (_request, response) => {
        const { rows } = await getPool().query(`SELECT id,platform_code AS "platformCode",platform_label AS "platformLabel",documentation_url AS "documentationUrl",authentication_type AS "authenticationType",lifecycle_status AS "lifecycleStatus",planned_capabilities AS "plannedCapabilities",notes,created_at AS "createdAt",updated_at AS "updatedAt" FROM depannhome_einvoice_platform_catalog ORDER BY CASE lifecycle_status WHEN 'deployed' THEN 0 WHEN 'validation' THEN 1 WHEN 'development' THEN 2 WHEN 'specification_review' THEN 3 WHEN 'documentation_required' THEN 4 ELSE 5 END,LOWER(platform_label)`);
        response.json({ platforms: rows.map(publicCreatorEInvoicingPlatform) });
    }));
    app.get("/api/creator/e-invoicing-monitoring", requireCreator, asyncHandler(async (request, response) => {
        const database = getPool();
        const [connections, transmissions, subscriptions, profile] = await Promise.all([
            database.query(`SELECT owner_id AS "ownerId",environment,status,active,platform_code AS "platformCode",platform_label AS "platformLabel",last_checked_at AS "lastCheckedAt" FROM depannhome_einvoice_connections ORDER BY active DESC,updated_at DESC`),
            database.query(`SELECT status,COUNT(*)::integer AS count FROM depannhome_einvoice_transmissions GROUP BY status ORDER BY status`),
            database.query(`SELECT COUNT(*) FILTER (WHERE status='sent')::integer AS sent,COUNT(*) FILTER (WHERE status IN ('pending','sending'))::integer AS pending,COUNT(*) FILTER (WHERE status='failed')::integer AS failed,COUNT(*) FILTER (WHERE payment_status='unpaid' AND status='sent')::integer AS unpaid FROM depannhome_subscription_invoices WHERE status<>'cancelled'`),
            database.query(`SELECT company_name,address,postal_code,city,email,registration_number,tax_number,vat_regime FROM depannhome_subscription_billing_profile WHERE id=TRUE`)
        ]);
        const senderConnection = connections.rows.find(connection => Number(connection.ownerId) === Number(request.user.sub) && connection.active && connection.environment === "production" && connection.status === "connected") || null;
        const billingProfile = profile.rows[0] || {};
        const requiredProfileFields = ["company_name", "address", "postal_code", "city", "email", "registration_number"];
        const missingProfileFields = requiredProfileFields.filter(field => !String(billingProfile[field] || "").trim());
        response.json({
            compliance: {
                operational: false,
                subscriptionChannel: "email_pdf",
                profileComplete: missingProfileFields.length === 0,
                missingProfileFields,
                productionSenderConnected: Boolean(senderConnection),
                message: "Les factures d’abonnement sont archivées et suivies, mais elles ne sont pas encore transmises par une plateforme agréée. L’envoi PDF par e-mail ne vaut pas facturation électronique structurée."
            },
            subscriptions: subscriptions.rows[0] || { sent: 0, pending: 0, failed: 0, unpaid: 0 },
            connections: connections.rows,
            transmissionStatuses: transmissions.rows,
            senderConnection
        });
    }));
    app.post("/api/creator/e-invoicing-platforms", requireCreator, asyncHandler(async (request, response) => {
        const platform = sanitizeCreatorEInvoicingPlatform(request.body);
        if (!platform.ok) return response.status(400).json({ message: platform.message });
        try {
            const { rows } = await getPool().query(`INSERT INTO depannhome_einvoice_platform_catalog(platform_code,platform_label,documentation_url,authentication_type,lifecycle_status,planned_capabilities,notes,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$8) RETURNING id,platform_code AS "platformCode",platform_label AS "platformLabel",documentation_url AS "documentationUrl",authentication_type AS "authenticationType",lifecycle_status AS "lifecycleStatus",planned_capabilities AS "plannedCapabilities",notes,created_at AS "createdAt",updated_at AS "updatedAt"`, [platform.platformCode, platform.platformLabel, platform.documentationUrl, platform.authenticationType, platform.lifecycleStatus, JSON.stringify(platform.plannedCapabilities), platform.notes, request.user.sub]);
            response.status(201).json({ platform: publicCreatorEInvoicingPlatform(rows[0]) });
        } catch (error) {
            if (error.code === "23505") return response.status(409).json({ message: "Ce code de plateforme existe déjà." });
            throw error;
        }
    }));
    app.patch("/api/creator/e-invoicing-platforms/:platformId", requireCreator, asyncHandler(async (request, response) => {
        const platformId = positiveId(request.params.platformId);
        const existing = platformId && (await getPool().query("SELECT platform_code FROM depannhome_einvoice_platform_catalog WHERE id=$1", [platformId])).rows[0];
        if (!existing) return response.status(404).json({ message: "Plateforme introuvable." });
        const platform = sanitizeCreatorEInvoicingPlatform({ ...request.body, platformCode: existing.platform_code });
        if (!platform.ok) return response.status(400).json({ message: platform.message });
        const { rows } = await getPool().query(`UPDATE depannhome_einvoice_platform_catalog SET platform_label=$2,documentation_url=$3,authentication_type=$4,lifecycle_status=$5,planned_capabilities=$6::jsonb,notes=$7,updated_by=$8,updated_at=NOW() WHERE id=$1 RETURNING id,platform_code AS "platformCode",platform_label AS "platformLabel",documentation_url AS "documentationUrl",authentication_type AS "authenticationType",lifecycle_status AS "lifecycleStatus",planned_capabilities AS "plannedCapabilities",notes,created_at AS "createdAt",updated_at AS "updatedAt"`, [platformId, platform.platformLabel, platform.documentationUrl, platform.authenticationType, platform.lifecycleStatus, JSON.stringify(platform.plannedCapabilities), platform.notes, request.user.sub]);
        response.json({ platform: publicCreatorEInvoicingPlatform(rows[0]) });
    }));
    app.get("/api/creator/super-pdp-sandbox", requireCreator, asyncHandler(async (request, response) => {
        const { rows } = await getPool().query(`SELECT test_status AS "testStatus",last_test_result AS "lastTestResult",last_tested_at AS "lastTestedAt",updated_at AS "updatedAt" FROM depannhome_creator_super_pdp_sandbox WHERE creator_id=$1`, [request.user.sub]);
        response.json({ sandbox: rows[0] ? { configured: true, ...rows[0] } : { configured: false, testStatus: "", lastTestResult: {}, lastTestedAt: null, updatedAt: null } });
    }));
    app.put("/api/creator/super-pdp-sandbox", requireCreator, asyncHandler(async (request, response) => {
        const { rows } = await getPool().query("SELECT encrypted_credentials FROM depannhome_creator_super_pdp_sandbox WHERE creator_id=$1", [request.user.sub]);
        const existing = rows[0]?.encrypted_credentials ? decryptElectronicInvoicingCredentials(rows[0].encrypted_credentials) : {};
        const credentials = sanitizeSuperPdpSandboxCredentials(request.body, existing);
        if (!credentials.ok) return response.status(400).json({ message: credentials.message });
        await getPool().query(`INSERT INTO depannhome_creator_super_pdp_sandbox(creator_id,encrypted_credentials,test_status,last_test_result) VALUES($1,$2,'configured','{}'::jsonb) ON CONFLICT(creator_id) DO UPDATE SET encrypted_credentials=EXCLUDED.encrypted_credentials,test_status='configured',last_test_result='{}'::jsonb,last_tested_at=NULL,updated_at=NOW()`, [request.user.sub, encryptElectronicInvoicingCredentials(credentials.value)]);
        response.json({ message: "Identifiants sandbox SUPER PDP chiffrés et enregistrés." });
    }));
    app.post("/api/creator/super-pdp-sandbox/test", requireCreator, asyncHandler(async (request, response) => {
        const provider = getElectronicInvoicingProvider("super_pdp");
        if (!provider || typeof provider.runClientCredentialsSandboxTest !== "function") return response.status(503).json({ message: "L’adaptateur sandbox SUPER PDP est indisponible." });
        const { rows } = await getPool().query(`UPDATE depannhome_creator_super_pdp_sandbox SET test_status='running',updated_at=NOW() WHERE creator_id=$1 AND (test_status<>'running' OR updated_at<NOW()-INTERVAL '2 minutes') RETURNING encrypted_credentials`, [request.user.sub]);
        if (!rows[0]) {
            const exists = await getPool().query("SELECT 1 FROM depannhome_creator_super_pdp_sandbox WHERE creator_id=$1", [request.user.sub]);
            return response.status(exists.rowCount ? 409 : 404).json({ message: exists.rowCount ? "Un test SUPER PDP est déjà en cours." : "Enregistrez d’abord les deux couples d’identifiants sandbox." });
        }
        try {
            const result = await provider.runClientCredentialsSandboxTest(decryptElectronicInvoicingCredentials(rows[0].encrypted_credentials));
            await getPool().query("UPDATE depannhome_creator_super_pdp_sandbox SET test_status='passed',last_test_result=$2::jsonb,last_tested_at=NOW(),updated_at=NOW() WHERE creator_id=$1", [request.user.sub, JSON.stringify(result)]);
            response.json({ message: result.received ? "Test réussi : facture reçue par l’entreprise fictive acheteuse." : "Dépôt et validation réussis ; la réception acheteur reste en traitement asynchrone.", result });
        } catch (error) {
            const message = safeSuperPdpSandboxError(error);
            await getPool().query("UPDATE depannhome_creator_super_pdp_sandbox SET test_status='failed',last_test_result=$2::jsonb,last_tested_at=NOW(),updated_at=NOW() WHERE creator_id=$1", [request.user.sub, JSON.stringify({ message })]);
            response.status(502).json({ message });
        }
    }));
    app.delete("/api/creator/super-pdp-sandbox", requireCreator, asyncHandler(async (request, response) => {
        await getPool().query("DELETE FROM depannhome_creator_super_pdp_sandbox WHERE creator_id=$1", [request.user.sub]);
        response.status(204).end();
    }));
    app.get("/api/creator/network-directory", requireCreator, asyncHandler(async (request, response) => {
        response.json({ companies: await creatorNetworkDirectory(request.query?.q), statistics: await creatorNetworkStatistics() });
    }));
    app.patch("/api/creator/network-directory/:accountId", requireCreator, asyncHandler(async (request, response) => {
        const accountId = positiveId(request.params.accountId);
        const owner = accountId && await findAccountOwner(getPool(), accountId);
        if (!canManageAccount(owner, request)) return response.status(404).json({ message: "Entreprise introuvable dans le Réseau DepannHomePro." });
        if (owner.is_archived) return response.status(409).json({ message: "Réactivez d’abord cette entreprise pour modifier sa fiche Réseau." });
        await updateCreatorNetworkDirectory(accountId, request.body);
        response.status(204).end();
    }));
    app.patch("/api/creator/network-directory/:accountId/restore", requireCreator, asyncHandler(async (request, response) => {
        const accountId = positiveId(request.params.accountId);
        const owner = accountId && await findAccountOwner(getPool(), accountId);
        if (!canManageAccount(owner, request)) return response.status(404).json({ message: "Entreprise introuvable dans le Réseau DepannHomePro." });
        if (owner.is_archived) return response.status(409).json({ message: "Réactivez d’abord l’entreprise avant de restaurer sa fiche Réseau." });
        await getPool().query("UPDATE depannhome_partner_directory SET is_listed=TRUE, creator_suspended=FALSE, updated_at=NOW() WHERE owner_id=$1", [accountId]);
        response.status(204).end();
    }));
    app.delete("/api/creator/network-directory/:accountId", requireCreator, asyncHandler(async (request, response) => {
        const accountId = positiveId(request.params.accountId);
        const owner = accountId && await findAccountOwner(getPool(), accountId);
        if (!canManageAccount(owner, request)) return response.status(404).json({ message: "Entreprise introuvable dans le Réseau DepannHomePro." });
        await getPool().query("UPDATE depannhome_partner_directory SET is_listed=FALSE, creator_suspended=TRUE, updated_at=NOW() WHERE owner_id=$1", [accountId]);
        response.status(204).end();
    }));
    app.get("/api/creator/accounts", requireCreator, asyncHandler(async (request, response) => {
        const { rows } = await getPool().query(`
            SELECT
                owner.id,
                owner.company_name AS "companyName",
                owner.username AS "ownerUsername",
                owner.full_name AS "ownerFullName",
                owner.phone AS "ownerPhone",
                owner.email AS "billingEmail",
                owner.is_active AS "isActive",
                owner.is_archived AS "isArchived",
                owner.archived_at AS "archivedAt",
                owner.max_pc_users AS "maxPcUsers",
                owner.max_technicians AS "maxTechnicians",
                owner.subscription_plan AS "subscriptionPlan",
                owner.subscription_tier AS "subscriptionTier",
                owner.subscription_label AS "subscriptionLabel",
                owner.monthly_price_cents AS "monthlyPriceCents",
                owner.subscription_discount_label AS "subscriptionDiscountLabel",
                owner.subscription_discount_mode AS "subscriptionDiscountMode",
                owner.subscription_discount_value::float AS "subscriptionDiscountValue",
                owner.subscription_status AS "subscriptionStatus",
                TO_CHAR(owner.subscription_renewal_date, 'YYYY-MM-DD') AS "subscriptionRenewalDate",
                owner.billing_reference AS "billingReference",
                owner.creator_note AS "creatorNote",
                owner.quote_template_policy AS "quoteTemplatePolicy",
                owner.quitus_template_policy AS "quitusTemplatePolicy",
                owner.report_template_policy AS "reportTemplatePolicy",
                owner.created_at AS "createdAt",
                COUNT(DISTINCT member.id) FILTER (WHERE member.role IN ('admin','pc_standard','accountant') AND member.is_active)::int AS "activePcUsers",
                COUNT(DISTINCT member.id) FILTER (WHERE member.role IN ('mobile_admin','team_lead','technician') AND member.is_active)::int
                    + COUNT(DISTINCT admin_mobile.id) FILTER (WHERE admin_mobile.status='approved')::int AS "activeTechnicians",
                COUNT(DISTINCT member.id)::int AS "memberCount"
            FROM depannhome_users owner
            LEFT JOIN depannhome_users member ON member.account_owner_id = owner.id
            LEFT JOIN depannhome_users admin_account ON admin_account.account_owner_id=owner.id AND admin_account.role='admin' AND admin_account.is_active
            LEFT JOIN depannhome_auth_devices admin_mobile ON admin_mobile.user_id=admin_account.id AND admin_mobile.device_type='mobile'
            WHERE owner.account_owner_id = owner.id
            GROUP BY owner.id
            ORDER BY LOWER(COALESCE(NULLIF(owner.company_name, ''), owner.full_name, owner.username))
        `);
        const profiles = await loadCompanyProfiles(getPool(), rows.map(account => account.id));
        const accounts = await Promise.all(rows
            .filter(account => !isCreatorUsername(account.ownerUsername) || String(account.id) === String(request.user.sub))
            .map(async account => ({ ...account, companyProfile: profiles.get(String(account.id)) || emptyCompanyProfile(), organization: await getOrganization(account.id) })));
        response.json({ accounts });
    }));
    app.get("/api/creator/accounts/:accountId/organization-history", requireCreator, asyncHandler(async (request, response) => {
        const accountId = positiveId(request.params.accountId);
        const owner = accountId && await findAccountOwner(getPool(), accountId);
        if (!canManageAccount(owner, request)) return response.status(404).json({ message: "Organisation introuvable." });
        response.json({ history: await getOrganizationHistory(accountId) });
    }));
    app.get("/api/creator/accounts/:accountId/e-invoicing", requireCreator, asyncHandler(async (request, response) => {
        const accountId = positiveId(request.params.accountId);
        const owner = accountId && await findAccountOwner(getPool(), accountId);
        if (!canManageAccount(owner, request)) return response.status(404).json({ message: "Entreprise introuvable." });
        const database = getPool();
        const [connections, transmissions, statuses] = await Promise.all([
            database.query(`SELECT id,platform_code AS "platformCode",platform_label AS "platformLabel",environment,status,active,external_account_id AS "externalAccountId",external_account_label AS "externalAccountLabel",last_connected_at AS "lastConnectedAt",last_checked_at AS "lastCheckedAt",updated_at AS "updatedAt" FROM depannhome_einvoice_connections WHERE owner_id=$1 ORDER BY active DESC,updated_at DESC`, [accountId]),
            database.query(`SELECT id,document_id AS "documentId",document_type AS "documentType",platform_code AS "platformCode",remote_id AS "remoteId",status,external_status AS "externalStatus",message,transmitted_at AS "transmittedAt",status_checked_at AS "statusCheckedAt",updated_at AS "updatedAt" FROM depannhome_einvoice_transmissions WHERE owner_id=$1 ORDER BY updated_at DESC LIMIT 100`, [accountId]),
            database.query(`SELECT status,COUNT(*)::integer AS count FROM depannhome_einvoice_transmissions WHERE owner_id=$1 GROUP BY status ORDER BY status`, [accountId])
        ]);
        response.json({ connections: connections.rows, activeConnection: connections.rows.find(connection => connection.active) || null, transmissions: transmissions.rows, transmissionStatuses: statuses.rows });
    }));

    app.post("/api/creator/accounts", requireCreator, asyncHandler(async (request, response) => {
        const account = sanitizeAccount(request.body, true);
        const credentials = sanitizeCredentials(request.body);
        if (!account.ok) return response.status(400).json({ message: account.message });
        if (!credentials.ok) return response.status(400).json({ message: credentials.message });

        try {
            const database = getPool(); const connection = await database.connect();
            try {
                await connection.query("BEGIN");
                const { rows } = await connection.query(`
                INSERT INTO depannhome_users (username, password_hash, role, full_name, phone, email, company_name, max_pc_users, max_technicians,
                    subscription_plan, subscription_tier, subscription_label, monthly_price_cents, subscription_discount_label, subscription_discount_mode, subscription_discount_value,
                    subscription_status, subscription_renewal_date, billing_reference, creator_note, quote_template_policy, quitus_template_policy, report_template_policy)
                VALUES ($1, $2, 'admin', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::date, $18, $19, $20, $21, $22)
                RETURNING id
            `, [credentials.username, await bcrypt.hash(credentials.password, 12), account.fullName, account.phone, account.billingEmail, account.companyName, account.maxPcUsers, account.maxTechnicians,
                account.subscriptionPlan, account.subscriptionTier, account.subscriptionLabel, account.monthlyPriceCents, account.subscriptionDiscountLabel, account.subscriptionDiscountMode, account.subscriptionDiscountValue,
                account.subscriptionStatus, account.subscriptionRenewalDate || null, account.billingReference, account.creatorNote, account.quoteTemplatePolicy, account.quitusTemplatePolicy, account.reportTemplatePolicy]);
                const id = rows[0].id;
                await connection.query("UPDATE depannhome_users SET account_owner_id = id WHERE id = $1", [id]);
                await synchronizeCompanyProfile(connection, id, account.companyProfile, { initializeNetwork: account.subscriptionTier === "pro" });
                await connection.query("COMMIT");
            await createOrganization(id, request.body?.organization, request.user.sub);
            response.status(201).json({ id: String(id) });
            } catch (error) { await connection.query("ROLLBACK"); throw error; } finally { connection.release(); }
        } catch (error) {
            if (error.code === "23505") return response.status(409).json({ message: "Cet identifiant est déjà utilisé." });
            throw error;
        }
    }));

    app.patch("/api/creator/accounts/:accountId", requireCreator, asyncHandler(async (request, response) => {
        const accountId = positiveId(request.params.accountId);
        if (!accountId) return response.status(400).json({ message: "Compte entreprise invalide." });
        const account = sanitizeAccount(request.body);
        if (!account.ok) return response.status(400).json({ message: account.message });

        const database = getPool();
        const owner = await findAccountOwner(database, accountId);
        if (!canManageAccount(owner, request)) return response.status(404).json({ message: "Compte entreprise introuvable." });
        if (owner.is_archived) return response.status(409).json({ message: "Réactivez cette entreprise avant de modifier ses informations." });
        const counts = await countActiveSeats(database, accountId);
        const convertsToPartner = request.body?.organization?.interfaceType === "partner";
        if (!convertsToPartner && (account.maxPcUsers < counts.activePcUsers || account.maxTechnicians < counts.activeTechnicians)) {
            return response.status(400).json({ message: "Les limites ne peuvent pas être inférieures aux accès actifs existants." });
        }
        const connection = await database.connect();
        let proration = null;
        try {
            await connection.query("BEGIN");
            const { rows: lockedOwners } = await connection.query(`
                SELECT id,subscription_plan AS "subscriptionPlan",subscription_tier AS "subscriptionTier",subscription_label AS "subscriptionLabel",
                    monthly_price_cents AS "monthlyPriceCents",max_pc_users AS "maxPcUsers",max_technicians AS "maxTechnicians",
                    subscription_discount_label AS "discountLabel",subscription_discount_mode AS "discountMode",
                    subscription_discount_value::float AS "discountValue",TO_CHAR(subscription_renewal_date,'YYYY-MM-DD') AS "subscriptionRenewalDate",
                    updated_at AS "changeVersion"
                FROM depannhome_users WHERE id=$1 AND account_owner_id=id FOR UPDATE
            `, [accountId]);
            const ownerBefore = lockedOwners[0];
            if (!ownerBefore) throw new Error("Compte entreprise introuvable.");
            await connection.query(`
            UPDATE depannhome_users
            SET company_name = $2, full_name = $3, phone = $4, email = $5, max_pc_users = $6, max_technicians = $7, is_active = $8,
                subscription_plan = $9, subscription_tier = $10, subscription_label = $11, monthly_price_cents = $12, subscription_status = $13,
                subscription_renewal_date = $14::date, billing_reference = $15, creator_note = $16, quote_template_policy = $17,
                quitus_template_policy = $18, report_template_policy = $19, subscription_discount_label = $20,
                subscription_discount_mode = $21, subscription_discount_value = $22, updated_at = NOW()
            WHERE id = $1 AND account_owner_id = id
            `, [accountId, account.companyName, account.fullName, account.phone, account.billingEmail, account.maxPcUsers, account.maxTechnicians, owner.is_active,
            account.subscriptionPlan, account.subscriptionTier, account.subscriptionLabel, account.monthlyPriceCents, account.subscriptionStatus, account.subscriptionRenewalDate || null, account.billingReference, account.creatorNote, account.quoteTemplatePolicy, account.quitusTemplatePolicy, account.reportTemplatePolicy,
            account.subscriptionDiscountLabel, account.subscriptionDiscountMode, account.subscriptionDiscountValue]);
            if (convertsToPartner) {
                await connection.query("UPDATE depannhome_users SET is_active=FALSE,updated_at=NOW() WHERE account_owner_id=$1 AND id<>$1 AND is_active=TRUE", [accountId]);
                await connection.query(`UPDATE depannhome_auth_devices device SET status='rejected',session_id=NULL FROM depannhome_users member WHERE device.user_id=member.id AND member.account_owner_id=$1 AND device.device_type='mobile' AND device.status<>'rejected'`, [accountId]);
            }
            await synchronizeCompanyProfile(connection, accountId, account.companyProfile, { initializeNetwork: account.subscriptionTier === "pro" });
            proration = await prepareSubscriptionProration(connection, {
                ownerBefore,
                ownerAfter: {
                    id: accountId, subscriptionPlan: account.subscriptionPlan, subscriptionTier: account.subscriptionTier,
                    subscriptionLabel: account.subscriptionLabel, monthlyPriceCents: account.monthlyPriceCents,
                    maxPcUsers: account.maxPcUsers, maxTechnicians: account.maxTechnicians,
                    discountLabel: account.subscriptionDiscountLabel, discountMode: account.subscriptionDiscountMode,
                    discountValue: account.subscriptionDiscountValue, subscriptionRenewalDate: account.subscriptionRenewalDate
                },
                actorId: request.user.sub
            });
            await connection.query("COMMIT");
        } catch (error) { await connection.query("ROLLBACK"); throw error; } finally { connection.release(); }
        await updateOrganization(accountId, request.body?.organization, request.user.sub);
        if (proration) {
            const delivery = await deliverSubscriptionProration(proration, request.user.sub);
            if (!delivery.sent && !delivery.skipped) console.warn("[subscription-proration] document created but delivery failed", { accountId, proration, message: delivery.message || "Échec d’envoi" });
        }
        response.status(204).end();
    }));

    app.patch("/api/creator/accounts/:accountId/activation", requireCreator, asyncHandler(async (request, response) => {
        const accountId = positiveId(request.params.accountId);
        if (!accountId || typeof request.body?.isActive !== "boolean") return response.status(400).json({ message: "Le statut de l’entreprise est invalide." });
        const database = getPool();
        const owner = await findAccountOwner(database, accountId);
        if (!canManageAccount(owner, request)) return response.status(404).json({ message: "Compte entreprise introuvable." });
        if (isOwnCreatorAccount(owner, request)) return response.status(403).json({ message: "Le compte Créateur ne peut pas être suspendu." });
        if (owner.is_archived) return response.status(409).json({ message: "Utilisez la réactivation d’archive pour remettre cette entreprise en service." });
        const { rows } = await database.query(`
            UPDATE depannhome_users
            SET is_active = $2, updated_at = NOW()
            WHERE id = $1 AND account_owner_id = id
            RETURNING is_active AS "isActive"
        `, [accountId, request.body.isActive]);
        response.json({ isActive: Boolean(rows[0]?.isActive) });
    }));

    app.delete("/api/creator/accounts/:accountId", requireCreator, asyncHandler(async (request, response) => {
        const accountId = positiveId(request.params.accountId);
        if (!accountId) return response.status(400).json({ message: "Compte entreprise invalide." });
        if (String(accountId) === String(request.user.sub)) return response.status(403).json({ message: "Le compte Créateur ne peut pas être supprimé." });
        const database = getPool();
        const owner = await findAccountOwner(database, accountId);
        if (!owner || isCreatorUsername(owner.username)) return response.status(404).json({ message: "Compte entreprise introuvable." });
        if (owner.is_archived) return response.status(409).json({ message: "Cette entreprise est déjà archivée." });
        const connection = await database.connect();
        try {
            await connection.query("BEGIN");
            const result = await connection.query(`UPDATE depannhome_users SET is_archived=TRUE,is_active=FALSE,archived_at=NOW(),archived_by=$2,updated_at=NOW() WHERE id=$1 AND account_owner_id=id AND is_archived=FALSE RETURNING id,archived_at AS "archivedAt"`, [accountId, request.user.sub]);
            if (!result.rowCount) { await connection.query("ROLLBACK"); return response.status(404).json({ message: "Compte entreprise introuvable." }); }
            await connection.query("INSERT INTO depannhome_account_lifecycle_audit(account_owner_id,actor_id,action,reason) VALUES($1,$2,'archived',$3)", [accountId, request.user.sub, cleanText(request.body?.reason, 500)]);
            await connection.query("COMMIT");
            response.json({ archived: true, archivedAt: result.rows[0].archivedAt });
        } catch (error) { await connection.query("ROLLBACK"); throw error; } finally { connection.release(); }
    }));

    app.patch("/api/creator/accounts/:accountId/restore", requireCreator, asyncHandler(async (request, response) => {
        const accountId = positiveId(request.params.accountId);
        if (!accountId) return response.status(400).json({ message: "Compte entreprise invalide." });
        const database = getPool();
        const owner = await findAccountOwner(database, accountId);
        if (!canManageAccount(owner, request) || isCreatorUsername(owner.username)) return response.status(404).json({ message: "Compte entreprise introuvable." });
        if (!owner.is_archived) return response.status(409).json({ message: "Cette entreprise n’est pas archivée." });
        const connection = await database.connect();
        try {
            await connection.query("BEGIN");
            const result = await connection.query(`UPDATE depannhome_users SET is_archived=FALSE,is_active=TRUE,archived_at=NULL,archived_by=NULL,updated_at=NOW() WHERE id=$1 AND account_owner_id=id AND is_archived=TRUE RETURNING id`, [accountId]);
            if (!result.rowCount) { await connection.query("ROLLBACK"); return response.status(404).json({ message: "Archive introuvable." }); }
            await connection.query("INSERT INTO depannhome_account_lifecycle_audit(account_owner_id,actor_id,action) VALUES($1,$2,'restored')", [accountId, request.user.sub]);
            await connection.query("COMMIT");
            response.json({ restored: true });
        } catch (error) { await connection.query("ROLLBACK"); throw error; } finally { connection.release(); }
    }));

    app.get("/api/creator/accounts/:accountId/members", requireCreator, asyncHandler(async (request, response) => {
        const startedAt = Date.now();
        const accountId = positiveId(request.params.accountId);
        console.info("[creator-members] request", { accountId, creatorId: request.user.sub });
        const owner = accountId && await findAccountOwner(getPool(), accountId);
        if (!canManageAccount(owner, request)) {
            console.info("[creator-members] account unavailable", { accountId, durationMs: Date.now() - startedAt });
            return response.status(404).json({ message: "Compte entreprise introuvable." });
        }
        const { rows } = await getPool().query(`
            SELECT id, username, role, full_name AS "fullName", phone, email, is_active AS "isActive", created_at AS "createdAt"
            FROM depannhome_users WHERE account_owner_id = $1
            ORDER BY CASE WHEN id = $1 THEN 0 ELSE 1 END, role, LOWER(full_name), username
        `, [accountId]);
        console.info("[creator-members] response", { accountId, count: rows.length, durationMs: Date.now() - startedAt });
        response.json({ members: rows });
    }));

    app.post("/api/creator/accounts/:accountId/members", requireCreator, asyncHandler(async (request, response) => {
        const accountId = positiveId(request.params.accountId);
        const role = MEMBER_ROLES.has(request.body?.role) ? request.body.role : "";
        const profile = sanitizeMemberProfile(request.body, role);
        const credentials = sanitizeCredentials(request.body);
        const database = getPool();
        const owner = accountId && await findAccountOwner(database, accountId);
        if (!canManageAccount(owner, request)) return response.status(404).json({ message: "Compte entreprise introuvable." });
        if (owner.is_archived) return response.status(409).json({ message: "Réactivez d’abord l’entreprise pour créer un accès." });
        if (!role) return response.status(400).json({ message: "Choisissez le type d’accès." });
        if (!profile.ok) return response.status(400).json({ message: profile.message });
        if (!credentials.ok) return response.status(400).json({ message: credentials.message });
        if (!owner.is_active) return response.status(400).json({ message: "Réactivez d’abord l’entreprise pour créer un accès." });

        const client = await database.connect();
        try {
            await client.query("BEGIN");
            await ensureSeatAvailable(client, accountId, role);
            const { rows } = await client.query(`
                INSERT INTO depannhome_users (username, password_hash, role, account_owner_id, full_name, phone, email)
                VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
            `, [credentials.username, await bcrypt.hash(credentials.password, 12), role, accountId, profile.fullName, profile.phone, profile.email]);
            await client.query("COMMIT");
            response.status(201).json({ id: String(rows[0].id) });
        } catch (error) {
            await client.query("ROLLBACK");
            if (error.code === "23505") return response.status(409).json({ message: "Cet identifiant est déjà utilisé." });
            if (error.message?.startsWith("LIMIT:")) return response.status(400).json({ message: error.message.slice(6) });
            throw error;
        } finally {
            client.release();
        }
    }));

    app.patch("/api/creator/accounts/:accountId/members/:memberId", requireCreator, asyncHandler(async (request, response) => {
        const accountId = positiveId(request.params.accountId);
        const memberId = positiveId(request.params.memberId);
        const database = getPool();
        const owner = accountId && await findAccountOwner(database, accountId);
        if (!canManageAccount(owner, request)) return response.status(404).json({ message: "Compte entreprise introuvable." });
        if (owner.is_archived) return response.status(409).json({ message: "Réactivez d’abord l’entreprise pour modifier ses accès." });
        const member = await findMember(database, accountId, memberId);
        if (!member) return response.status(404).json({ message: "Accès introuvable." });
        const profile = sanitizeMemberProfile(request.body, member.role);
        if (!profile.ok) return response.status(400).json({ message: profile.message });
        const username = normalizeUsername(request.body?.username);
        if (!USERNAME_PATTERN.test(username)) return response.status(400).json({ message: usernameMessage() });
        const password = String(request.body?.password || "");
        if (password && password.length < MIN_PASSWORD_LENGTH) return response.status(400).json({ message: passwordMessage() });
        const isActive = member.id === accountId ? owner.is_active : Boolean(request.body?.isActive);

        const client = await database.connect();
        try {
            await client.query("BEGIN");
            if (isActive && !member.isActive) await ensureSeatAvailable(client, accountId, member.role);
            await client.query(`
                UPDATE depannhome_users
                SET username = $3, full_name = $4, phone = $5, email = $6, is_active = $7,
                    password_hash = CASE WHEN $8 <> '' THEN $9 ELSE password_hash END, updated_at = NOW()
                WHERE id = $1 AND account_owner_id = $2
            `, [memberId, accountId, username, profile.fullName, profile.phone, profile.email, isActive, password, password ? await bcrypt.hash(password, 12) : ""]);
            await client.query("COMMIT");
            response.status(204).end();
        } catch (error) {
            await client.query("ROLLBACK");
            if (error.code === "23505") return response.status(409).json({ message: "Cet identifiant est déjà utilisé." });
            if (error.message?.startsWith("LIMIT:")) return response.status(400).json({ message: error.message.slice(6) });
            throw error;
        } finally {
            client.release();
        }
    }));

    app.delete("/api/creator/accounts/:accountId/members/:memberId", requireCreator, asyncHandler(async (request, response) => {
        const accountId = positiveId(request.params.accountId);
        const memberId = positiveId(request.params.memberId);
        if (!accountId || !memberId) return response.status(400).json({ message: "Accès invalide." });
        if (accountId === memberId) return response.status(400).json({ message: "Supprimez l’entreprise entière pour retirer son compte d’ancrage technique." });
        const owner = await findAccountOwner(getPool(), accountId);
        if (!canManageAccount(owner, request)) return response.status(404).json({ message: "Compte entreprise introuvable." });
        if (owner.is_archived) return response.status(409).json({ message: "Réactivez d’abord l’entreprise pour modifier ses accès." });
        const result = await getPool().query("DELETE FROM depannhome_users WHERE id = $1 AND account_owner_id = $2", [memberId, accountId]);
        if (!result.rowCount) return response.status(404).json({ message: "Accès introuvable." });
        response.status(204).end();
    }));
}

async function notifyCreatorsOfSubscriptionRequest(changeRequest, owner) {
    const { rows } = await getPool().query("SELECT id,account_owner_id AS \"ownerId\",username FROM depannhome_users WHERE is_active=TRUE");
    const creators = rows.filter(account => isCreatorUsername(account.username));
    await Promise.all(creators.map(account => createNotification(account.ownerId || account.id, account.id, "subscription_request_received", { entityType: "subscription_request", entityId: String(changeRequest.id) }, "Nouvelle demande d’offre ou de postes", `${owner.company_name || owner.full_name || owner.username} · ${changeRequest.currentTier} → ${changeRequest.requestedTier}`, { requestId: String(changeRequest.id), companyOwnerId: String(owner.id), requestedTier: changeRequest.requestedTier })));
}

async function findAccountOwner(database, id) {
    const { rows } = await database.query(`
        SELECT id, username, is_active, is_archived, max_pc_users AS "maxPcUsers", max_technicians AS "maxTechnicians",
            subscription_plan AS "subscriptionPlan", subscription_tier AS "subscriptionTier", subscription_status AS "subscriptionStatus"
        FROM depannhome_users WHERE id = $1 AND account_owner_id = id
    `, [id]);
    return rows[0] || null;
}

function isOwnCreatorAccount(owner, request) {
    return Boolean(owner) && isCreatorUsername(owner.username) && String(owner.id) === String(request.user.sub);
}

function canManageAccount(owner, request) {
    return Boolean(owner) && (!isCreatorUsername(owner.username) || isOwnCreatorAccount(owner, request));
}

async function findMember(database, accountId, memberId) {
    const { rows } = await database.query(`
        SELECT id, username, role, full_name AS "fullName", phone, email, is_active AS "isActive"
        FROM depannhome_users WHERE id = $1 AND account_owner_id = $2
    `, [memberId, accountId]);
    return rows[0] || null;
}

async function countActiveSeats(database, accountId) {
    const { rows } = await database.query(`
        SELECT
            COUNT(DISTINCT member.id) FILTER (WHERE member.role IN ('admin','pc_standard','accountant') AND member.is_active)::int AS "activePcUsers",
            COUNT(DISTINCT member.id) FILTER (WHERE member.role IN ('mobile_admin','team_lead','technician') AND member.is_active)::int
                + COUNT(DISTINCT admin_mobile.id) FILTER (WHERE admin_mobile.status='approved')::int AS "activeTechnicians"
        FROM depannhome_users member
        LEFT JOIN depannhome_users admin_account ON admin_account.account_owner_id=$1 AND admin_account.role='admin' AND admin_account.is_active
        LEFT JOIN depannhome_auth_devices admin_mobile ON admin_mobile.user_id=admin_account.id AND admin_mobile.device_type='mobile'
        WHERE member.account_owner_id = $1
    `, [accountId]);
    return rows[0];
}

async function ensureSeatAvailable(database, accountId, role) {
    const { rows: owners } = await database.query(`
        SELECT max_pc_users AS "maxPcUsers", max_technicians AS "maxTechnicians", subscription_tier AS "subscriptionTier"
        FROM depannhome_users WHERE id = $1 AND account_owner_id = id FOR UPDATE
    `, [accountId]);
    if (!owners[0]) throw new Error("LIMIT:Compte entreprise introuvable.");
    const roleAccessError = subscriptionRoleAccessMessage(owners[0].subscriptionTier, role);
    if (roleAccessError) throw new Error(`LIMIT:${roleAccessError}`);
    const counts = await countActiveSeats(database, accountId);
    const isPcRole = ["admin", "pc_standard", "accountant"].includes(role);
    const maximum = isPcRole ? owners[0].maxPcUsers : owners[0].maxTechnicians;
    const active = isPcRole ? counts.activePcUsers : counts.activeTechnicians;
    if (active >= maximum) throw new Error(`LIMIT:La limite de ${isPcRole ? "postes PC" : "postes mobiles"} est atteinte.`);
}

function sanitizeAccount(value, requireCompleteProfile = false) {
    const companyName = cleanText(value?.companyName, 160);
    const fullName = cleanText(value?.fullName, 100);
    const phone = cleanText(value?.phone, 30);
    const billingEmail = cleanText(value?.billingEmail, 160).toLowerCase();
    const requestedMaxPcUsers = positiveLimit(value?.maxPcUsers, 1, 100);
    const requestedMaxTechnicians = positiveLimit(value?.maxTechnicians, 0, 500);
    const subscriptionTier = normalizeSubscriptionTier(value?.subscriptionTier, "basic");
    const tierConfig = subscriptionTierConfig(subscriptionTier);
    const requestedInterface = value?.organization?.interfaceType || "standard";
    const isFreePartner = requestedInterface === "partner";
    const maxPcUsers = isFreePartner ? 1 : requestedMaxPcUsers;
    const maxTechnicians = isFreePartner ? 0 : requestedMaxTechnicians;
    const subscriptionPlan = isFreePartner ? "free" : "paid";
    const subscriptionLabel = isFreePartner ? "Portail Partenaire gratuit" : tierConfig.label;
    const monthlyPriceCents = isFreePartner ? 0 : calculateSubscriptionPriceCents(subscriptionTier, maxPcUsers, maxTechnicians);
    const subscriptionDiscountLabel = isFreePartner ? "" : cleanText(value?.subscriptionDiscountLabel, 160);
    const subscriptionDiscountMode = isFreePartner ? "fixed" : value?.subscriptionDiscountMode === "percentage" ? "percentage" : "fixed";
    const subscriptionDiscountValue = isFreePartner ? 0 : decimalInRange(value?.subscriptionDiscountValue, 0, subscriptionDiscountMode === "percentage" ? 100 : 999999.99);
    const subscriptionStatus = SUBSCRIPTION_STATUSES.has(value?.subscriptionStatus) ? value.subscriptionStatus : "active";
    const subscriptionRenewalDate = isFreePartner ? "" : sanitizeDate(value?.subscriptionRenewalDate);
    const billingReference = cleanText(value?.billingReference, 100);
    const creatorNote = cleanText(value?.creatorNote, 1000);
    const quoteTemplatePolicy = QUOTE_TEMPLATE_POLICIES.has(value?.quoteTemplatePolicy) ? value.quoteTemplatePolicy : "company_choice";
    const quitusTemplatePolicy = QUOTE_TEMPLATE_POLICIES.has(value?.quitusTemplatePolicy) ? value.quitusTemplatePolicy : "company_choice";
    const reportTemplatePolicy = QUOTE_TEMPLATE_POLICIES.has(value?.reportTemplatePolicy) ? value.reportTemplatePolicy : "company_choice";
    const isActive = value?.isActive !== false;
    if (!companyName) return { ok: false, message: "Le nom de l’entreprise est obligatoire." };
    if (!fullName) return { ok: false, message: "Le nom du responsable est obligatoire." };
    if (!isFreePartner && !maxPcUsers) return { ok: false, message: "Indiquez au moins un poste PC." };
    if (!isFreePartner && maxTechnicians === null) return { ok: false, message: "Le nombre de techniciens est invalide." };
    if (subscriptionDiscountValue === null) return { ok: false, message: "La réduction commerciale est invalide." };
    if (subscriptionPlan === "paid" && monthlyPriceCents <= 0) return { ok: false, message: "Indiquez un tarif mensuel supérieur à zéro pour un abonnement payant." };
    if (subscriptionPlan === "paid" && subscriptionDiscountMode === "fixed" && Math.round(subscriptionDiscountValue * 100) > monthlyPriceCents) return { ok: false, message: "La réduction fixe ne peut pas dépasser le tarif mensuel." };
    if (billingEmail && !EMAIL_PATTERN.test(billingEmail)) return { ok: false, message: "L’e-mail de facturation est invalide." };
    if (subscriptionPlan === "paid" && !billingEmail) return { ok: false, message: "L’e-mail de facturation est obligatoire pour un abonnement payant." };
    const interfaceAccessError = organizationInterfaceAccessMessage(subscriptionTier, requestedInterface);
    if (interfaceAccessError) return { ok: false, message: interfaceAccessError };
    const companyProfile = sanitizeCompanyProfile(value, { companyName, billingEmail, phone, requireCompleteProfile });
    if (!companyProfile.ok) return companyProfile;
    return { ok: true, companyName, fullName, phone, billingEmail, maxPcUsers, maxTechnicians, subscriptionPlan, subscriptionTier, subscriptionLabel,
        monthlyPriceCents, subscriptionStatus, subscriptionRenewalDate,
        subscriptionDiscountLabel, subscriptionDiscountMode, subscriptionDiscountValue,
        billingReference, creatorNote, quoteTemplatePolicy, quitusTemplatePolicy, reportTemplatePolicy, isActive, companyProfile };
}

async function loadCompanyProfiles(database, ownerIds) {
    if (!ownerIds.length) return new Map();
    const { rows } = await database.query(`SELECT owner.id,profile.company_name AS "legalName",profile.address,profile.postal_code AS "postalCode",profile.city,profile.phone,profile.secondary_phone AS "secondaryPhone",profile.email,profile.registration_number AS "siret",profile.country,directory.commercial_name AS "commercialName",directory.description,directory.specialties,directory.service_area AS "serviceArea",directory.service_radius_km AS "serviceRadiusKm",directory.departments,directory.region,directory.regions,directory.coverage_mode AS "coverageMode",directory.website,directory.accepts_partner_missions AS "acceptsPartnerMissions",directory.availability_status AS "availabilityStatus",(profile.logo_data IS NOT NULL) AS "hasLogo" FROM depannhome_users owner LEFT JOIN depannhome_billing_profiles profile ON profile.owner_id=owner.id LEFT JOIN depannhome_partner_directory directory ON directory.owner_id=owner.id WHERE owner.id=ANY($1::bigint[])`, [ownerIds]);
    return new Map(rows.map(row => [String(row.id), { ...emptyCompanyProfile(), ...row, specialties: Array.isArray(row.specialties) ? row.specialties : [], departments: Array.isArray(row.departments) ? row.departments : [], regions: Array.isArray(row.regions) ? row.regions : [] }]));
}

function emptyCompanyProfile() { return { legalName: "", commercialName: "", siret: "", address: "", postalCode: "", city: "", departments: [], region: "", regions: [], country: "France", phone: "", secondaryPhone: "", email: "", website: "", specialties: [], coverageMode: "custom", serviceArea: "", serviceRadiusKm: 0, description: "", acceptsPartnerMissions: true, availabilityStatus: "available", hasLogo: false }; }

function sanitizeCompanyProfile(value, defaults) {
    const legalName = cleanText(value?.legalName || defaults.companyName, 160), commercialName = cleanText(value?.commercialName, 160), siret = String(value?.siret || "").replace(/\s/g, "").slice(0, 14);
    const address = cleanText(value?.address, 255), postalCode = cleanText(value?.postalCode, 20), city = cleanText(value?.city, 100), country = cleanText(value?.country || "France", 100);
    const phone = cleanText(value?.companyPhone || defaults.phone, 50), secondaryPhone = cleanText(value?.secondaryPhone, 50), email = cleanText(value?.companyEmail || defaults.billingEmail, 160).toLowerCase();
    const specialties = cleanList(value?.specialties, 30, 80), departments = cleanList(value?.departments, 30, 20), regions = cleanList(value?.regions, 20, 100);
    const website = cleanText(value?.website, 500); const coverageMode = ["france", "departments", "regions", "radius", "custom"].includes(value?.coverageMode) ? value.coverageMode : "custom";
    const serviceRadiusKm = positiveLimit(value?.serviceRadiusKm, 0, 500); const acceptsPartnerMissions = value?.acceptsPartnerMissions !== false;
    const logo = parseLogo(value?.logoDataUrl);
    if (siret && !/^\d{14}$/.test(siret)) return { ok: false, message: "Le numéro SIRET doit comporter 14 chiffres." };
    if (email && !EMAIL_PATTERN.test(email)) return { ok: false, message: "L’adresse e-mail de l’entreprise est invalide." };
    if (website && !/^https?:\/\/[^\s]+$/i.test(website)) return { ok: false, message: "Le site Internet doit commencer par http:// ou https://." };
    if (logo.error) return { ok: false, message: logo.error };
    if (defaults.requireCompleteProfile && (!siret || !address || !postalCode || !city || !phone || !email)) return { ok: false, message: "Complétez le SIRET, l’adresse, le code postal, la ville, le téléphone et l’e-mail de l’entreprise." };
    return { ok: true, legalName, commercialName, siret, address, postalCode, city, country, phone, secondaryPhone, email, website, specialties, departments, regions, coverageMode, serviceArea: coverageMode === "france" ? "France entière" : cleanText(value?.serviceArea, 500), serviceRadiusKm: coverageMode === "radius" ? serviceRadiusKm || 0 : 0, description: cleanMultilineText(value?.description, 1000), acceptsPartnerMissions, availabilityStatus: acceptsPartnerMissions ? "available" : "temporarily_unavailable", logoBuffer: logo.buffer, logoMimeType: logo.mimeType };
}

function parseLogo(value) { if (!value) return {}; const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(value)); if (!match) return { error: "Le logo doit être une image PNG, JPEG ou WebP." }; const buffer = Buffer.from(match[2], "base64"); return buffer.length > 2 * 1024 * 1024 ? { error: "Le logo ne doit pas dépasser 2 Mo." } : { buffer, mimeType: match[1] }; }

async function synchronizeCompanyProfile(connection, ownerId, profile, options = {}) {
    await connection.query(`INSERT INTO depannhome_billing_profiles(owner_id,company_name,address,postal_code,city,phone,secondary_phone,email,registration_number,siren,country,logo_data,logo_mime_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(owner_id) DO UPDATE SET company_name=EXCLUDED.company_name,address=EXCLUDED.address,postal_code=EXCLUDED.postal_code,city=EXCLUDED.city,phone=EXCLUDED.phone,secondary_phone=EXCLUDED.secondary_phone,email=EXCLUDED.email,registration_number=EXCLUDED.registration_number,siren=EXCLUDED.siren,country=EXCLUDED.country,logo_data=CASE WHEN $14 THEN EXCLUDED.logo_data ELSE depannhome_billing_profiles.logo_data END,logo_mime_type=CASE WHEN $14 THEN EXCLUDED.logo_mime_type ELSE depannhome_billing_profiles.logo_mime_type END,updated_at=NOW()`, [ownerId, profile.legalName, profile.address, profile.postalCode, profile.city, profile.phone, profile.secondaryPhone, profile.email, profile.siret, profile.siret.slice(0, 9), profile.country, profile.logoBuffer || null, profile.logoMimeType || "", Boolean(profile.logoBuffer)]);
    const initializeNetwork = options.initializeNetwork === true;
    await connection.query(`INSERT INTO depannhome_partner_directory(owner_id,is_listed,visibility_explicit,description,trades,specialties,service_area,service_radius_km,departments,website,accepts_partner_missions,availability_status,commercial_name,region,regions,coverage_mode,share_phone,share_email,updated_at) VALUES($1,$14,$14,$2,'[]'::jsonb,$3::jsonb,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12::jsonb,$13,TRUE,TRUE,NOW()) ON CONFLICT(owner_id) DO UPDATE SET description=EXCLUDED.description,specialties=EXCLUDED.specialties,service_area=EXCLUDED.service_area,service_radius_km=EXCLUDED.service_radius_km,departments=EXCLUDED.departments,website=EXCLUDED.website,commercial_name=EXCLUDED.commercial_name,region=EXCLUDED.region,regions=EXCLUDED.regions,coverage_mode=EXCLUDED.coverage_mode,share_phone=TRUE,share_email=TRUE,updated_at=NOW()`, [ownerId, profile.description, JSON.stringify(profile.specialties), profile.serviceArea, profile.serviceRadiusKm, JSON.stringify(profile.departments), profile.website, profile.acceptsPartnerMissions, profile.acceptsPartnerMissions ? profile.availabilityStatus : "temporarily_unavailable", profile.commercialName, profile.regions[0] || "", JSON.stringify(profile.regions), profile.coverageMode, initializeNetwork]);
}

function cleanList(value, maximumItems, maximumLength) { const items = Array.isArray(value) ? value : String(value || "").split(/[,;\n|]/); return [...new Set(items.map(item => cleanText(item, maximumLength)).filter(Boolean))].slice(0, maximumItems); }

function sanitizeMemberProfile(value, role) {
    const fullName = cleanText(value?.fullName, 100);
    const phone = cleanText(value?.phone, 30);
    const email = cleanText(value?.email, 160).toLowerCase();
    if (!fullName) return { ok: false, message: "Le nom est obligatoire." };
    if (["mobile_admin", "team_lead", "technician"].includes(role) && !phone) return { ok: false, message: "Le téléphone du poste mobile est obligatoire." };
    if (["mobile_admin", "team_lead", "technician"].includes(role) && !EMAIL_PATTERN.test(email)) return { ok: false, message: "L’e-mail professionnel du poste mobile est obligatoire." };
    return { ok: true, fullName, phone, email };
}

function sanitizeCredentials(value) {
    const username = normalizeUsername(value?.username);
    const password = String(value?.password || "");
    if (!USERNAME_PATTERN.test(username)) return { ok: false, message: usernameMessage() };
    if (password.length < MIN_PASSWORD_LENGTH) return { ok: false, message: passwordMessage() };
    return { ok: true, username, password };
}

function normalizeUsername(value) {
    return String(value || "").trim().toLowerCase();
}

function cleanText(value, maximumLength) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximumLength);
}

function cleanMultilineText(value, maximumLength) {
    return String(value || "").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim().slice(0, maximumLength);
}

function sanitizeCreatorEInvoicingPlatform(value) {
    const platformCode = cleanText(value?.platformCode, 60).toLowerCase();
    const platformLabel = cleanText(value?.platformLabel, 160);
    const documentationUrl = cleanText(value?.documentationUrl, 1000);
    const authenticationType = EINVOICE_AUTHENTICATION_TYPES.has(value?.authenticationType) ? value.authenticationType : "";
    const lifecycleStatus = EINVOICE_LIFECYCLE_STATUSES.has(value?.lifecycleStatus) ? value.lifecycleStatus : "";
    if (!EINVOICE_PLATFORM_CODE_PATTERN.test(platformCode)) return { ok: false, message: "Le code doit contenir 2 à 60 caractères minuscules, chiffres, tirets ou soulignés." };
    if (!platformLabel || !authenticationType || !lifecycleStatus) return { ok: false, message: "Le nom, l’authentification et l’état du projet sont obligatoires." };
    if (documentationUrl && !/^https:\/\/[^\s]+$/i.test(documentationUrl)) return { ok: false, message: "La documentation officielle doit utiliser une adresse HTTPS." };
    if (["development", "validation", "deployed"].includes(lifecycleStatus) && !documentationUrl) return { ok: false, message: "La documentation officielle est obligatoire avant le développement de l’adaptateur." };
    if (lifecycleStatus === "deployed" && !getElectronicInvoicingProvider(platformCode)) return { ok: false, message: "Impossible de déclarer cette plateforme déployée : aucun adaptateur serveur correspondant n’est enregistré." };
    return {
        ok: true, platformCode, platformLabel, documentationUrl, authenticationType, lifecycleStatus,
        plannedCapabilities: { invoices: Boolean(value?.invoices), creditNotes: Boolean(value?.creditNotes), status: Boolean(value?.status), refresh: Boolean(value?.refresh), webhooks: Boolean(value?.webhooks) },
        notes: cleanMultilineText(value?.notes, 4000)
    };
}

function publicCreatorEInvoicingPlatform(row) {
    const adapter = getElectronicInvoicingProvider(row.platformCode);
    return { ...row, plannedCapabilities: row.plannedCapabilities && typeof row.plannedCapabilities === "object" ? row.plannedCapabilities : {}, runtimeIntegrated: Boolean(adapter), runtimeDefinition: adapter?.publicDefinition() || null };
}

function sanitizeSuperPdpSandboxCredentials(value, existing = {}) {
    const fields = {
        seller: {
            clientId: cleanText(value?.sellerClientId, 500) || cleanText(existing?.seller?.clientId, 500),
            clientSecret: String(value?.sellerClientSecret || "").trim().slice(0, 4000) || String(existing?.seller?.clientSecret || "").trim().slice(0, 4000)
        },
        buyer: {
            clientId: cleanText(value?.buyerClientId, 500) || cleanText(existing?.buyer?.clientId, 500),
            clientSecret: String(value?.buyerClientSecret || "").trim().slice(0, 4000) || String(existing?.buyer?.clientSecret || "").trim().slice(0, 4000)
        }
    };
    if (Object.values(fields).some(credentials => !credentials.clientId || !credentials.clientSecret)) return { ok: false, message: "Renseignez le Client ID et le Client Secret des deux entreprises fictives SUPER PDP." };
    if (fields.seller.clientId === fields.buyer.clientId) return { ok: false, message: "Le vendeur et l’acheteur doivent utiliser deux applications SUPER PDP distinctes." };
    return { ok: true, value: fields };
}

function safeSuperPdpSandboxError(error) {
    const status = Number(error?.status);
    if (status === 401 || status === 403) return status === 403 && /environnement sandbox/i.test(String(error?.publicMessage || error?.message)) ? cleanText(error.publicMessage || error.message, 500) : "SUPER PDP a refusé les identifiants sandbox ou leur autorisation.";
    if (status === 408 || error?.name === "AbortError") return "SUPER PDP n’a pas répondu dans le délai prévu.";
    if (status >= 400 && /^SUPER PDP\s*:/i.test(String(error?.publicMessage || error?.message))) return `SUPER PDP a refusé une étape du test (HTTP ${status}).`;
    return cleanText(error?.publicMessage || error?.message || "Le test SUPER PDP a échoué.", 500).replace(/(?:bearer|token|secret|client_secret|password)\s*[:=]\s*\S+/gi, "Identifiant sensible [masqué]");
}

function positiveId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function positiveLimit(value, minimum, maximum) {
    const limit = Number(value);
    return Number.isSafeInteger(limit) && limit >= minimum && limit <= maximum ? limit : null;
}

function decimalInRange(value, minimum, maximum) {
    const normalized = String(value ?? "").trim().replace(",", ".");
    if (!normalized) return 0;
    if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(normalized)) return null;
    const number = Number(normalized);
    return Number.isFinite(number) && number >= minimum && number <= maximum ? Math.round(number * 100) / 100 : null;
}

function sanitizeDate(value) {
    const date = String(value || "");
    return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(new Date(`${date}T12:00:00`).getTime()) ? date : "";
}

function usernameMessage() {
    return "L’identifiant doit contenir de 3 à 32 caractères : lettres minuscules, chiffres, point, tiret ou souligné.";
}

function passwordMessage() {
    return `Le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères.`;
}

function asyncHandler(handler) {
    return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}
