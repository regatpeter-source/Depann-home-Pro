import { getPool } from "./database.js";
import { createBillingPdf, normalizeVatRegime } from "./billing.js";
import { sendDocumentEmail } from "./email.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IBAN_PATTERN = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;
const BIC_PATTERN = /^[A-Z0-9]{8}(?:[A-Z0-9]{3})?$/;
let schedulerTimer = null;

export async function initializeSubscriptionInvoicing() {
    const database = getPool();
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_subscription_billing_profile (
            id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
            company_name VARCHAR(160) NOT NULL DEFAULT '',
            legal_form VARCHAR(100) NOT NULL DEFAULT '',
            address VARCHAR(255) NOT NULL DEFAULT '',
            postal_code VARCHAR(20) NOT NULL DEFAULT '',
            city VARCHAR(100) NOT NULL DEFAULT '',
            phone VARCHAR(50) NOT NULL DEFAULT '',
            email VARCHAR(160) NOT NULL DEFAULT '',
            registration_number VARCHAR(100) NOT NULL DEFAULT '',
            tax_number VARCHAR(100) NOT NULL DEFAULT '',
            vat_regime VARCHAR(20) NOT NULL DEFAULT 'standard' CHECK (vat_regime IN ('standard','franchise')),
            bank_iban VARCHAR(34) NOT NULL DEFAULT '',
            bank_bic VARCHAR(11) NOT NULL DEFAULT '',
            vat_rate NUMERIC(5,2) NOT NULL DEFAULT 20 CHECK (vat_rate >= 0 AND vat_rate <= 100),
            payment_terms VARCHAR(500) NOT NULL DEFAULT '',
            footer_note VARCHAR(1000) NOT NULL DEFAULT '',
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await database.query("ALTER TABLE depannhome_subscription_billing_profile ADD COLUMN IF NOT EXISTS vat_regime VARCHAR(20) NOT NULL DEFAULT 'standard'");
    await database.query("ALTER TABLE depannhome_subscription_billing_profile DROP CONSTRAINT IF EXISTS depannhome_subscription_billing_profile_vat_regime_check");
    await database.query("ALTER TABLE depannhome_subscription_billing_profile ADD CONSTRAINT depannhome_subscription_billing_profile_vat_regime_check CHECK (vat_regime IN ('standard','franchise'))");
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_subscription_invoices (
            id BIGSERIAL PRIMARY KEY,
            account_owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            billing_period DATE NOT NULL,
            invoice_number VARCHAR(80) NOT NULL UNIQUE,
            recipient_name VARCHAR(160) NOT NULL,
            recipient_email VARCHAR(160) NOT NULL,
            recipient_address VARCHAR(500) NOT NULL DEFAULT '',
            subscription_label VARCHAR(80) NOT NULL DEFAULT '',
            amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
            vat_rate NUMERIC(5,2) NOT NULL CHECK (vat_rate >= 0 AND vat_rate <= 100),
            issue_date DATE NOT NULL,
            due_date DATE NOT NULL,
            issuer_profile JSONB NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
            sent_at TIMESTAMPTZ,
            last_error VARCHAR(1000) NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT depannhome_subscription_invoices_owner_period_unique UNIQUE (account_owner_id, billing_period)
        )
    `);
    await database.query(`ALTER TABLE depannhome_subscription_invoices ADD COLUMN IF NOT EXISTS recipient_address VARCHAR(500) NOT NULL DEFAULT ''`);
    await database.query(`ALTER TABLE depannhome_subscription_invoices ADD COLUMN IF NOT EXISTS issue_date DATE NOT NULL DEFAULT CURRENT_DATE`);
    await database.query(`CREATE INDEX IF NOT EXISTS depannhome_subscription_invoices_status_idx ON depannhome_subscription_invoices (status, created_at)`);
}

export function registerSubscriptionInvoicingRoutes(app, requireCreator) {
    app.get("/api/creator/subscription-billing-profile", requireCreator, asyncHandler(async (request, response) => {
        const { rows } = await getPool().query(`
            SELECT company_name AS "companyName", legal_form AS "legalForm", address, postal_code AS "postalCode", city, phone, email,
                registration_number AS "registrationNumber", tax_number AS "taxNumber", vat_regime AS "vatRegime", bank_iban AS "bankIban", bank_bic AS "bankBic",
                vat_rate::float AS "vatRate", payment_terms AS "paymentTerms", footer_note AS "footerNote"
            FROM depannhome_subscription_billing_profile WHERE id = TRUE
        `);
        response.json({ profile: rows[0] || emptyProfile() });
    }));

    app.put("/api/creator/subscription-billing-profile", requireCreator, asyncHandler(async (request, response) => {
        const profile = sanitizeProfile(request.body);
        if (!profile.ok) return response.status(400).json({ message: profile.message });
        await getPool().query(`
            INSERT INTO depannhome_subscription_billing_profile
                (id, company_name, legal_form, address, postal_code, city, phone, email, registration_number, tax_number, vat_regime, bank_iban, bank_bic, vat_rate, payment_terms, footer_note)
            VALUES (TRUE,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
            ON CONFLICT (id) DO UPDATE SET company_name=EXCLUDED.company_name, legal_form=EXCLUDED.legal_form, address=EXCLUDED.address,
                postal_code=EXCLUDED.postal_code, city=EXCLUDED.city, phone=EXCLUDED.phone, email=EXCLUDED.email,
                registration_number=EXCLUDED.registration_number, tax_number=EXCLUDED.tax_number, vat_regime=EXCLUDED.vat_regime, bank_iban=EXCLUDED.bank_iban,
                bank_bic=EXCLUDED.bank_bic, vat_rate=EXCLUDED.vat_rate, payment_terms=EXCLUDED.payment_terms, footer_note=EXCLUDED.footer_note, updated_at=NOW()
        `, [profile.companyName, profile.legalForm, profile.address, profile.postalCode, profile.city, profile.phone, profile.email,
            profile.registrationNumber, profile.taxNumber, profile.vatRegime, profile.bankIban, profile.bankBic, profile.vatRate, profile.paymentTerms, profile.footerNote]);
        response.status(204).end();
    }));

    app.get("/api/creator/subscription-invoices", requireCreator, asyncHandler(async (request, response) => {
        const { rows } = await getPool().query(`
            SELECT invoice.id, invoice.invoice_number AS "invoiceNumber", invoice.recipient_name AS "recipientName", invoice.recipient_email AS "recipientEmail",
                invoice.subscription_label AS "subscriptionLabel", invoice.amount_cents AS "amountCents", invoice.vat_rate::float AS "vatRate",
                TO_CHAR(invoice.issue_date, 'YYYY-MM-DD') AS "issueDate", TO_CHAR(invoice.due_date, 'YYYY-MM-DD') AS "dueDate",
                invoice.status, invoice.sent_at AS "sentAt", invoice.last_error AS "lastError", invoice.created_at AS "createdAt",
                owner.company_name AS "companyName"
            FROM depannhome_subscription_invoices invoice
            JOIN depannhome_users owner ON owner.id = invoice.account_owner_id
            ORDER BY invoice.issue_date DESC, invoice.id DESC
        `);
        response.json({ invoices: rows, processing: await subscriptionInvoicingStatus() });
    }));

    app.post("/api/creator/subscription-invoices/process", requireCreator, asyncHandler(async (request, response) => {
        const result = await processDueSubscriptionInvoices();
        if (result.skippedReason === "incomplete_profile") {
            return response.status(409).json({ ...result, message: `Complétez le profil de facturation de la plateforme : ${result.missingProfileFields.join(", ")}.` });
        }
        if (result.skippedReason === "already_running") return response.status(409).json({ ...result, message: "Un traitement de facturation est déjà en cours. Réessayez dans quelques instants." });
        response.json({ ...result, message: processingMessage(result) });
    }));

    app.get("/api/creator/subscription-invoices/:invoiceId/pdf", requireCreator, asyncHandler(async (request, response) => {
        const invoiceId = positiveId(request.params.invoiceId);
        if (!invoiceId) return response.status(400).json({ message: "Facture invalide." });
        const { rows } = await getPool().query(`
            SELECT id, invoice_number AS "invoiceNumber", recipient_name AS "recipientName", recipient_address AS "recipientAddress",
                subscription_label AS "subscriptionLabel", amount_cents AS "amountCents", vat_rate::float AS "vatRate",
                TO_CHAR(issue_date, 'YYYY-MM-DD') AS "issueDate", TO_CHAR(due_date, 'YYYY-MM-DD') AS "dueDate", issuer_profile AS "issuerProfile"
            FROM depannhome_subscription_invoices WHERE id = $1
        `, [invoiceId]);
        const invoice = rows[0];
        if (!invoice) return response.status(404).json({ message: "Facture introuvable." });
        const pdf = await createBillingPdf(subscriptionInvoiceDocument(invoice), invoice.issuerProfile || emptyProfile());
        response.set({
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="${subscriptionInvoicePdfFileName(invoice)}"`,
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff"
        });
        response.send(pdf);
    }));
}

export function startSubscriptionInvoicingScheduler() {
    if (schedulerTimer) return;
    const check = async source => {
        try {
            const result = await processDueSubscriptionInvoices();
            console.info("[subscription-invoicing] completed", { source, ...result });
        } catch (error) {
            console.error("[subscription-invoicing] failed", { source, error: error.message });
        }
    };
    const scheduleNext = () => {
        const delay = millisecondsUntilConfiguredRun();
        schedulerTimer = setTimeout(async () => { await check("scheduled"); schedulerTimer = null; scheduleNext(); }, delay);
        console.info(`[subscription-invoicing] scheduled daily run in ${Math.round(delay / 60000)} minute(s).`);
    };
    void check("startup");
    scheduleNext();
}

export async function processDueSubscriptionInvoices() {
    const database = getPool();
    const lockConnection = await database.connect();
    let lockAcquired = false;
    try {
        const lock = await lockConnection.query("SELECT pg_try_advisory_lock(842301) AS acquired");
        lockAcquired = Boolean(lock.rows[0]?.acquired);
        if (!lockAcquired) return { skipped: true, skippedReason: "already_running", created: 0, sent: 0, failed: 0 };
        const issuer = await getIssuerProfile();
        if (!isCompleteProfile(issuer)) {
            const missingProfileFields = incompleteProfileFields(issuer);
            console.warn("[subscription-invoicing] skipped: platform billing profile is incomplete", { missingProfileFields });
            return { skipped: true, skippedReason: "incomplete_profile", missingProfileFields, created: 0, sent: 0, failed: 0 };
        }
        const { rows: subscriptions } = await database.query(`
            SELECT owner.id, owner.company_name AS "companyName", owner.full_name AS "fullName", owner.email, owner.subscription_label AS "subscriptionLabel",
                owner.monthly_price_cents AS "monthlyPriceCents", owner.subscription_renewal_date AS "renewalDate", owner.billing_reference AS "billingReference",
                COALESCE(NULLIF(profile.address, ''), '') || CASE WHEN COALESCE(profile.postal_code, '') <> '' OR COALESCE(profile.city, '') <> ''
                    THEN CASE WHEN COALESCE(profile.address, '') <> '' THEN E'\n' ELSE '' END || TRIM(CONCAT_WS(' ', profile.postal_code, profile.city)) ELSE '' END AS "recipientAddress"
            FROM depannhome_users owner
            LEFT JOIN depannhome_billing_profiles profile ON profile.owner_id = owner.id
            WHERE owner.account_owner_id = owner.id AND owner.is_active = TRUE AND owner.is_archived = FALSE AND owner.subscription_plan = 'paid'
                AND owner.subscription_status = 'active' AND owner.monthly_price_cents > 0
                AND owner.subscription_renewal_date IS NOT NULL AND owner.subscription_renewal_date <= CURRENT_DATE
            ORDER BY owner.subscription_renewal_date, owner.id
        `);
        let created = 0;
        let skippedAccounts = 0;
        for (const subscription of subscriptions) {
            if (!EMAIL_PATTERN.test(String(subscription.email || ""))) {
                console.warn("[subscription-invoicing] skipped account without billing email", { accountId: subscription.id });
                skippedAccounts += 1;
                continue;
            }
            const invoice = await createInvoiceIfNeeded(subscription, issuer);
            if (invoice.created) created += 1;
        }
        const delivery = await deliverPendingInvoices();
        return { skipped: false, dueAccounts: subscriptions.length, skippedAccounts, created, ...delivery };
    } finally {
        try {
            if (lockAcquired) await lockConnection.query("SELECT pg_advisory_unlock(842301)");
        } finally {
            lockConnection.release();
        }
    }
}

async function createInvoiceIfNeeded(subscription, issuer) {
    const database = getPool();
    const billingPeriod = dateString(subscription.renewalDate);
    const invoiceNumber = `DHP-${billingPeriod.slice(0, 7).replace("-", "")}-${String(subscription.id).padStart(5, "0")}`;
    const dueDate = addDays(billingPeriod, 30);
    const recipientName = String(subscription.companyName || subscription.fullName || "Entreprise").trim();
    const { rows } = await database.query(`
        INSERT INTO depannhome_subscription_invoices
            (account_owner_id, billing_period, invoice_number, recipient_name, recipient_email, recipient_address, subscription_label, amount_cents, vat_rate, issue_date, due_date, issuer_profile)
        VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8,$9,$10::date,$11::date,$12::jsonb)
        ON CONFLICT (account_owner_id, billing_period) DO NOTHING
        RETURNING id
    `, [subscription.id, billingPeriod, invoiceNumber, recipientName, subscription.email, String(subscription.recipientAddress || "").slice(0, 500), subscription.subscriptionLabel || "Abonnement Depann’Home Pro",
        subscription.monthlyPriceCents, issuer.vatRegime === "franchise" ? 0 : issuer.vatRate, billingPeriod, dueDate, JSON.stringify(issuer)]);
    return { created: Boolean(rows[0]) };
}

async function deliverPendingInvoices() {
    const database = getPool();
    await database.query(`UPDATE depannhome_subscription_invoices SET status='failed',last_error='Traitement interrompu avant confirmation de l’envoi ; nouvelle tentative autorisée.',updated_at=NOW() WHERE status='sending' AND updated_at<NOW()-INTERVAL '15 minutes'`);
    const { rows: invoices } = await database.query(`
        SELECT invoice.id, invoice_number AS "invoiceNumber", recipient_name AS "recipientName", recipient_email AS "recipientEmail", recipient_address AS "recipientAddress", subscription_label AS "subscriptionLabel",
            amount_cents AS "amountCents", vat_rate::float AS "vatRate", issue_date AS "issueDate", due_date AS "dueDate", issuer_profile AS "issuerProfile"
        FROM depannhome_subscription_invoices invoice
        JOIN depannhome_users owner ON owner.id = invoice.account_owner_id
        WHERE invoice.status IN ('pending', 'failed') AND owner.is_active = TRUE AND owner.is_archived = FALSE
            AND owner.subscription_plan = 'paid' AND owner.subscription_status = 'active'
        ORDER BY invoice.created_at
    `);
    let sent = 0;
    let failed = 0;
    for (const invoice of invoices) {
        const claimed = await database.query(`UPDATE depannhome_subscription_invoices SET status='sending', updated_at=NOW() WHERE id=$1 AND status IN ('pending', 'failed') RETURNING id`, [invoice.id]);
        if (!claimed.rowCount) continue;
        try {
            const document = subscriptionInvoiceDocument(invoice);
            const pdf = await createBillingPdf(document, invoice.issuerProfile);
            const delivery = await sendDocumentEmail({
                recipient: invoice.recipientEmail, recipientName: invoice.recipientName, documentLabel: `Facture d’abonnement ${invoice.invoiceNumber}`,
                attachment: { filename: `facture-abonnement-${invoice.invoiceNumber}.pdf`, content: pdf, contentType: "application/pdf" }
            });
            await database.query(`
                UPDATE depannhome_subscription_invoices SET status='sent', sent_at=NOW(), last_error='', updated_at=NOW() WHERE id=$1
            `, [invoice.id]);
            await database.query(`
                UPDATE depannhome_users SET subscription_renewal_date = subscription_renewal_date + INTERVAL '1 month', updated_at=NOW()
                WHERE id=(SELECT account_owner_id FROM depannhome_subscription_invoices WHERE id=$1)
            `, [invoice.id]);
            console.info("[subscription-invoicing] invoice accepted by SMTP", { invoiceId: invoice.id, messageId: delivery?.messageId || "" });
            sent += 1;
        } catch (error) {
            await database.query(`UPDATE depannhome_subscription_invoices SET status='failed', last_error=$2, updated_at=NOW() WHERE id=$1`, [invoice.id, String(error.message || "Échec d’envoi").slice(0, 1000)]);
            failed += 1;
            console.error("[subscription-invoicing] invoice delivery failed", { invoiceId: invoice.id, error: error.message });
        }
    }
    return { sent, failed };
}

async function getIssuerProfile() {
    const { rows } = await getPool().query(`
        SELECT company_name AS "companyName", legal_form AS "legalForm", address, postal_code AS "postalCode", city, phone, email,
            registration_number AS "registrationNumber", tax_number AS "taxNumber", vat_regime AS "vatRegime", bank_iban AS "bankIban", bank_bic AS "bankBic",
            vat_rate::float AS "vatRate", payment_terms AS "paymentTerms", footer_note AS "footerNote"
        FROM depannhome_subscription_billing_profile WHERE id = TRUE
    `);
    return rows[0] || emptyProfile();
}

async function subscriptionInvoicingStatus() {
    const issuer = await getIssuerProfile();
    const { rows } = await getPool().query(`
        SELECT
            COUNT(*) FILTER (WHERE owner.account_owner_id=owner.id AND owner.is_active AND NOT owner.is_archived AND owner.subscription_plan='paid' AND owner.subscription_status='active' AND owner.monthly_price_cents>0 AND owner.subscription_renewal_date IS NOT NULL AND owner.subscription_renewal_date<=CURRENT_DATE)::int AS "dueAccounts",
            (SELECT COUNT(*)::int FROM depannhome_subscription_invoices WHERE status='pending') AS pending,
            (SELECT COUNT(*)::int FROM depannhome_subscription_invoices WHERE status='failed') AS failed,
            (SELECT COUNT(*)::int FROM depannhome_subscription_invoices WHERE status='sending') AS sending
        FROM depannhome_users owner
    `);
    return { profileComplete: isCompleteProfile(issuer), missingProfileFields: incompleteProfileFields(issuer), dueAccounts: rows[0]?.dueAccounts || 0, pending: rows[0]?.pending || 0, failed: rows[0]?.failed || 0, sending: rows[0]?.sending || 0 };
}

function sanitizeProfile(value) {
    const profile = {
        companyName: cleanText(value?.companyName, 160), legalForm: cleanText(value?.legalForm, 100), address: cleanText(value?.address, 255),
        postalCode: cleanText(value?.postalCode, 20), city: cleanText(value?.city, 100), phone: cleanText(value?.phone, 50), email: cleanText(value?.email, 160).toLowerCase(),
        registrationNumber: cleanText(value?.registrationNumber, 100), taxNumber: cleanText(value?.taxNumber, 100),
        vatRegime: normalizeVatRegime(value?.vatRegime), bankIban: String(value?.bankIban || "").replace(/\s/g, "").toUpperCase().slice(0, 34), bankBic: String(value?.bankBic || "").replace(/\s/g, "").toUpperCase().slice(0, 11),
        vatRate: numberInRange(value?.vatRate, 0, 100), paymentTerms: cleanText(value?.paymentTerms, 500), footerNote: cleanText(value?.footerNote, 1000)
    };
    if (!profile.companyName || !profile.address || !profile.postalCode || !profile.city || !profile.registrationNumber || !EMAIL_PATTERN.test(profile.email)) return { ok: false, message: "Renseignez les coordonnées légales et l’e-mail de facturation de la plateforme." };
    if (!IBAN_PATTERN.test(profile.bankIban) || !BIC_PATTERN.test(profile.bankBic)) return { ok: false, message: "L’IBAN ou le BIC est invalide." };
    if (profile.vatRate === null) return { ok: false, message: "Le taux de TVA est invalide." };
    if (profile.vatRegime === "franchise") profile.vatRate = 0;
    return { ok: true, ...profile };
}

function isCompleteProfile(profile) {
    return Boolean(profile.companyName && profile.address && profile.postalCode && profile.city && profile.registrationNumber && EMAIL_PATTERN.test(profile.email || "") && IBAN_PATTERN.test(profile.bankIban || "") && BIC_PATTERN.test(profile.bankBic || ""));
}

function incompleteProfileFields(profile) {
    const missing = [];
    if (!profile.companyName) missing.push("raison sociale");
    if (!profile.address) missing.push("adresse");
    if (!profile.postalCode) missing.push("code postal");
    if (!profile.city) missing.push("ville");
    if (!profile.registrationNumber) missing.push("SIRET / immatriculation");
    if (!EMAIL_PATTERN.test(profile.email || "")) missing.push("e-mail");
    if (!IBAN_PATTERN.test(profile.bankIban || "")) missing.push("IBAN");
    if (!BIC_PATTERN.test(profile.bankBic || "")) missing.push("BIC");
    return missing;
}

function processingMessage(result) {
    if (result.failed) return `${result.sent} facture(s) envoyée(s), ${result.failed} en échec. Consultez le détail ci-dessous.`;
    if (result.sent) return `${result.sent} facture(s) envoyée(s) avec succès par Brevo.`;
    if (result.skippedAccounts) return `${result.skippedAccounts} entreprise(s) ignorée(s) car leur e-mail de facturation est absent ou invalide.`;
    return "Aucune facture arrivée à échéance ni en attente d’envoi.";
}

function emptyProfile() {
    return { companyName: "", legalForm: "", address: "", postalCode: "", city: "", phone: "", email: "", registrationNumber: "", taxNumber: "", vatRegime: "standard", bankIban: "", bankBic: "", vatRate: 20, paymentTerms: "", footerNote: "" };
}

function millisecondsUntilConfiguredRun() {
    const now = new Date();
    const hour = integerInRange(process.env.SUBSCRIPTION_INVOICING_HOUR, 0, 23, 0);
    const minute = integerInRange(process.env.SUBSCRIPTION_INVOICING_MINUTE, 0, 59, 10);
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
}

function dateString(value) {
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const date = new Date(value);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function addDays(date, days) {
    const result = new Date(`${date}T12:00:00`);
    result.setDate(result.getDate() + days);
    return dateString(result);
}

function amountExcludingVat(amountCents, vatRate) {
    return Math.round(Number(amountCents) * 100 / (100 + Number(vatRate || 0))) / 100;
}

function subscriptionInvoiceDocument(invoice) {
    return {
        documentType: "invoice",
        documentNumber: invoice.invoiceNumber,
        customerName: invoice.recipientName,
        customerAddress: invoice.recipientAddress,
        issueDate: dateString(invoice.issueDate),
        dueDate: dateString(invoice.dueDate),
        vatRegime: normalizeVatRegime(invoice.issuerProfile?.vatRegime),
        issuerTaxNumber: invoice.issuerProfile?.taxNumber || "",
        lines: [{
            description: `${invoice.subscriptionLabel} — abonnement mensuel`,
            quantity: 1,
            unit: "mois",
            unitPrice: amountExcludingVat(invoice.amountCents, invoice.vatRate),
            vatRate: invoice.vatRate
        }],
        notes: invoice.issuerProfile?.paymentTerms || "Paiement à réception de facture par virement bancaire."
    };
}

function subscriptionInvoicePdfFileName(invoice) {
    const number = String(invoice.invoiceNumber || "facture-abonnement").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "");
    return `facture-abonnement-${number || "document"}.pdf`;
}

function positiveId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function numberInRange(value, minimum, maximum) {
    const number = Number(value);
    return Number.isFinite(number) && number >= minimum && number <= maximum ? Math.round(number * 100) / 100 : null;
}

function integerInRange(value, minimum, maximum, fallback) {
    const number = Number(value);
    return Number.isInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

function cleanText(value, maximumLength) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximumLength);
}

function asyncHandler(handler) {
    return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}
