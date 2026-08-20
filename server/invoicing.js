import { getPool } from "./database.js";
import { createBillingPdf, normalizeVatRegime } from "./billing.js";
import { sendDocumentEmail } from "./email.js";
import { subscriptionTierConfig } from "./subscription-tiers.js";
import { calculateSubscriptionPriceCents } from "./subscription-tiers.js";
import { createHash } from "node:crypto";

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
            net_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (net_amount_cents >= 0),
            vat_rate NUMERIC(5,2) NOT NULL CHECK (vat_rate >= 0 AND vat_rate <= 100),
            lines JSONB NOT NULL DEFAULT '[]'::jsonb,
            financial_data JSONB NOT NULL DEFAULT '{}'::jsonb,
            subscription_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
            issue_date DATE NOT NULL,
            due_date DATE NOT NULL,
            issuer_profile JSONB NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
            sent_at TIMESTAMPTZ,
            last_error VARCHAR(1000) NOT NULL DEFAULT '',
            payment_status VARCHAR(20) NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'paid')),
            paid_date DATE,
            paid_at TIMESTAMPTZ,
            paid_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
            payment_reference VARCHAR(160) NOT NULL DEFAULT '',
            receipt_delivery_status VARCHAR(20) NOT NULL DEFAULT 'not_sent' CHECK (receipt_delivery_status IN ('not_sent', 'pending', 'sending', 'sent', 'failed')),
            receipt_sent_at TIMESTAMPTZ,
            receipt_last_error VARCHAR(1000) NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await database.query(`ALTER TABLE depannhome_subscription_invoices ADD COLUMN IF NOT EXISTS recipient_address VARCHAR(500) NOT NULL DEFAULT ''`);
    await database.query(`ALTER TABLE depannhome_subscription_invoices ADD COLUMN IF NOT EXISTS issue_date DATE NOT NULL DEFAULT CURRENT_DATE`);
    await database.query(`ALTER TABLE depannhome_subscription_invoices ADD COLUMN IF NOT EXISTS net_amount_cents INTEGER`);
    await database.query(`UPDATE depannhome_subscription_invoices SET net_amount_cents=amount_cents WHERE net_amount_cents IS NULL`);
    await database.query(`ALTER TABLE depannhome_subscription_invoices ALTER COLUMN net_amount_cents SET DEFAULT 0, ALTER COLUMN net_amount_cents SET NOT NULL`);
    await database.query(`ALTER TABLE depannhome_subscription_invoices ADD COLUMN IF NOT EXISTS lines JSONB NOT NULL DEFAULT '[]'::jsonb`);
    await database.query(`ALTER TABLE depannhome_subscription_invoices ADD COLUMN IF NOT EXISTS financial_data JSONB NOT NULL DEFAULT '{}'::jsonb`);
    await database.query(`ALTER TABLE depannhome_subscription_invoices ADD COLUMN IF NOT EXISTS subscription_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb`);
    await database.query(`ALTER TABLE depannhome_subscription_invoices DROP CONSTRAINT IF EXISTS depannhome_subscription_invoices_status_check`);
    await database.query(`ALTER TABLE depannhome_subscription_invoices ADD CONSTRAINT depannhome_subscription_invoices_status_check CHECK (status IN ('pending','sending','sent','failed','cancelled'))`);
    await database.query(`ALTER TABLE depannhome_subscription_invoices DROP CONSTRAINT IF EXISTS depannhome_subscription_invoices_owner_period_unique`);
    await database.query(`CREATE UNIQUE INDEX IF NOT EXISTS depannhome_subscription_invoices_active_owner_period_idx ON depannhome_subscription_invoices (account_owner_id,billing_period) WHERE status<>'cancelled'`);
    await database.query(`ALTER TABLE depannhome_subscription_invoices ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','paid')), ADD COLUMN IF NOT EXISTS paid_date DATE, ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS paid_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL, ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(160) NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS receipt_delivery_status VARCHAR(20) NOT NULL DEFAULT 'not_sent' CHECK (receipt_delivery_status IN ('not_sent','pending','sending','sent','failed')), ADD COLUMN IF NOT EXISTS receipt_sent_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS receipt_last_error VARCHAR(1000) NOT NULL DEFAULT ''`);
    await database.query(`ALTER TABLE depannhome_subscription_invoices ADD COLUMN IF NOT EXISTS paid_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (paid_amount_cents >= 0)`);
    await database.query(`UPDATE depannhome_subscription_invoices SET paid_amount_cents=net_amount_cents WHERE payment_status='paid' AND paid_amount_cents=0`);
    await database.query(`CREATE INDEX IF NOT EXISTS depannhome_subscription_invoices_status_idx ON depannhome_subscription_invoices (status, created_at)`);
    await database.query(`CREATE TABLE IF NOT EXISTS depannhome_subscription_invoice_sequences (series_year INTEGER PRIMARY KEY CHECK (series_year >= 2020), last_number BIGINT NOT NULL DEFAULT 0 CHECK (last_number >= 0), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await database.query(`INSERT INTO depannhome_subscription_invoice_sequences (series_year,last_number)
        SELECT parts[1]::integer,MAX(parts[2]::bigint) FROM depannhome_subscription_invoices
        CROSS JOIN LATERAL regexp_matches(invoice_number,'^DHP-([0-9]{4})-([0-9]{6})$') AS parsed(parts) GROUP BY parts[1]
        ON CONFLICT (series_year) DO UPDATE SET last_number=GREATEST(depannhome_subscription_invoice_sequences.last_number,EXCLUDED.last_number),updated_at=NOW()`);
    await database.query(`CREATE TABLE IF NOT EXISTS depannhome_subscription_invoice_audit (id BIGSERIAL PRIMARY KEY, invoice_id BIGINT NOT NULL REFERENCES depannhome_subscription_invoices(id) ON DELETE CASCADE, account_owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE, actor_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL, action VARCHAR(40) NOT NULL, details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await database.query(`CREATE INDEX IF NOT EXISTS depannhome_subscription_invoice_audit_invoice_idx ON depannhome_subscription_invoice_audit (invoice_id, created_at DESC)`);
    await database.query(`CREATE TABLE IF NOT EXISTS depannhome_subscription_credit_note_sequences (series_year INTEGER PRIMARY KEY CHECK (series_year >= 2020), last_number BIGINT NOT NULL DEFAULT 0 CHECK (last_number >= 0), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await database.query(`CREATE TABLE IF NOT EXISTS depannhome_subscription_credit_notes (
        id BIGSERIAL PRIMARY KEY, source_invoice_id BIGINT NOT NULL REFERENCES depannhome_subscription_invoices(id) ON DELETE RESTRICT,
        account_owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE RESTRICT, credit_number VARCHAR(80) NOT NULL UNIQUE,
        source_invoice_number VARCHAR(80) NOT NULL, source_invoice_date DATE NOT NULL, issue_date DATE NOT NULL, credit_kind VARCHAR(20) NOT NULL CHECK (credit_kind IN ('full','partial')),
        reason VARCHAR(1000) NOT NULL CHECK (CHAR_LENGTH(reason) >= 10), amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        tax_base_cents INTEGER NOT NULL CHECK (tax_base_cents >= 0), vat_amount_cents INTEGER NOT NULL CHECK (vat_amount_cents >= 0),
        vat_rate NUMERIC(5,2) NOT NULL CHECK (vat_rate >= 0 AND vat_rate <= 100), recipient_name VARCHAR(160) NOT NULL,
        recipient_email VARCHAR(160) NOT NULL, recipient_address VARCHAR(500) NOT NULL DEFAULT '', issuer_profile JSONB NOT NULL,
        lines JSONB NOT NULL DEFAULT '[]'::jsonb, financial_data JSONB NOT NULL DEFAULT '{}'::jsonb, pdf_data BYTEA NOT NULL,
        pdf_sha256 CHAR(64) NOT NULL, created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
        delivery_status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending','sending','sent','failed')),
        sent_at TIMESTAMPTZ, last_error VARCHAR(1000) NOT NULL DEFAULT '', refund_status VARCHAR(20) NOT NULL DEFAULT 'not_required' CHECK (refund_status IN ('not_required','pending','refunded')),
        refunded_date DATE, refunded_at TIMESTAMPTZ, refunded_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
        refund_reference VARCHAR(160) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await database.query(`ALTER TABLE depannhome_subscription_credit_notes ADD COLUMN IF NOT EXISTS source_invoice_date DATE`);
    await database.query(`UPDATE depannhome_subscription_credit_notes credit SET source_invoice_date=invoice.issue_date FROM depannhome_subscription_invoices invoice WHERE credit.source_invoice_id=invoice.id AND credit.source_invoice_date IS NULL`);
    await database.query(`ALTER TABLE depannhome_subscription_credit_notes ALTER COLUMN source_invoice_date SET NOT NULL`);
    await database.query(`CREATE INDEX IF NOT EXISTS depannhome_subscription_credit_notes_invoice_idx ON depannhome_subscription_credit_notes(source_invoice_id,issue_date,id)`);
    await database.query(`INSERT INTO depannhome_subscription_credit_note_sequences (series_year,last_number)
        SELECT parts[1]::integer,MAX(parts[2]::bigint) FROM depannhome_subscription_credit_notes
        CROSS JOIN LATERAL regexp_matches(credit_number,'^AVO-DHP-([0-9]{4})-([0-9]{6})$') AS parsed(parts) GROUP BY parts[1]
        ON CONFLICT (series_year) DO UPDATE SET last_number=GREATEST(depannhome_subscription_credit_note_sequences.last_number,EXCLUDED.last_number),updated_at=NOW()`);
    await database.query(`CREATE TABLE IF NOT EXISTS depannhome_subscription_credit_note_audit (id BIGSERIAL PRIMARY KEY, credit_note_id BIGINT NOT NULL REFERENCES depannhome_subscription_credit_notes(id) ON DELETE RESTRICT, account_owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE RESTRICT, actor_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL, action VARCHAR(50) NOT NULL, details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await database.query(`CREATE INDEX IF NOT EXISTS depannhome_subscription_credit_note_audit_credit_idx ON depannhome_subscription_credit_note_audit(credit_note_id,created_at DESC)`);
    await database.query(`CREATE OR REPLACE FUNCTION depannhome_protect_subscription_credit_note() RETURNS trigger AS $$ BEGIN
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Un avoir émis ne peut pas être supprimé.'; END IF;
          IF ROW(NEW.source_invoice_id,NEW.account_owner_id,NEW.credit_number,NEW.source_invoice_number,NEW.source_invoice_date,NEW.issue_date,NEW.credit_kind,NEW.reason,NEW.amount_cents,NEW.tax_base_cents,NEW.vat_amount_cents,NEW.vat_rate,NEW.recipient_name,NEW.recipient_email,NEW.recipient_address,NEW.issuer_profile,NEW.lines,NEW.financial_data,NEW.pdf_data,NEW.pdf_sha256,NEW.created_by,NEW.created_at)
              IS DISTINCT FROM ROW(OLD.source_invoice_id,OLD.account_owner_id,OLD.credit_number,OLD.source_invoice_number,OLD.source_invoice_date,OLD.issue_date,OLD.credit_kind,OLD.reason,OLD.amount_cents,OLD.tax_base_cents,OLD.vat_amount_cents,OLD.vat_rate,OLD.recipient_name,OLD.recipient_email,OLD.recipient_address,OLD.issuer_profile,OLD.lines,OLD.financial_data,OLD.pdf_data,OLD.pdf_sha256,OLD.created_by,OLD.created_at)
        THEN RAISE EXCEPTION 'Les données légales d’un avoir émis sont immuables.'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await database.query(`DROP TRIGGER IF EXISTS depannhome_subscription_credit_note_immutable ON depannhome_subscription_credit_notes`);
    await database.query(`CREATE TRIGGER depannhome_subscription_credit_note_immutable BEFORE UPDATE OR DELETE ON depannhome_subscription_credit_notes FOR EACH ROW EXECUTE FUNCTION depannhome_protect_subscription_credit_note()`);
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
        const database = getPool();
        const { rows } = await database.query(`
            SELECT invoice.id, invoice.invoice_number AS "invoiceNumber", invoice.recipient_name AS "recipientName", invoice.recipient_email AS "recipientEmail",
                invoice.subscription_label AS "subscriptionLabel", invoice.net_amount_cents AS "amountCents", invoice.amount_cents AS "baseAmountCents",
            invoice.financial_data AS "financialData", invoice.subscription_snapshot AS "subscriptionSnapshot", invoice.vat_rate::float AS "vatRate",
                TO_CHAR(invoice.issue_date, 'YYYY-MM-DD') AS "issueDate", TO_CHAR(invoice.due_date, 'YYYY-MM-DD') AS "dueDate",
                invoice.status, invoice.sent_at AS "sentAt", invoice.last_error AS "lastError", invoice.created_at AS "createdAt",
                invoice.payment_status AS "paymentStatus", invoice.paid_amount_cents AS "paidAmountCents", TO_CHAR(invoice.paid_date, 'YYYY-MM-DD') AS "paidDate", invoice.paid_at AS "paidAt",
                invoice.payment_reference AS "paymentReference", invoice.receipt_delivery_status AS "receiptDeliveryStatus",
                invoice.receipt_sent_at AS "receiptSentAt", invoice.receipt_last_error AS "receiptLastError",
                owner.company_name AS "companyName", owner.subscription_plan AS "subscriptionPlan", owner.subscription_tier AS "subscriptionTier",
                owner.subscription_label AS "currentSubscriptionLabel", owner.monthly_price_cents AS "monthlyPriceCents",
                owner.max_pc_users AS "maxPcUsers", owner.max_technicians AS "maxTechnicians",
                owner.subscription_discount_label AS "discountLabel", owner.subscription_discount_mode AS "discountMode",
                owner.subscription_discount_value::float AS "discountValue", COALESCE(organization.interface_type,'standard') AS "interfaceType"
            FROM depannhome_subscription_invoices invoice
            JOIN depannhome_users owner ON owner.id = invoice.account_owner_id
            LEFT JOIN depannhome_organizations organization ON organization.account_owner_id=owner.id
            ORDER BY invoice.issue_date DESC, invoice.id DESC
        `);
        const { rows: credits } = await database.query(`SELECT id,source_invoice_id AS "sourceInvoiceId",credit_number AS "creditNumber",source_invoice_number AS "sourceInvoiceNumber",TO_CHAR(issue_date,'YYYY-MM-DD') AS "issueDate",credit_kind AS "creditKind",reason,amount_cents AS "amountCents",tax_base_cents AS "taxBaseCents",vat_amount_cents AS "vatAmountCents",delivery_status AS "deliveryStatus",sent_at AS "sentAt",last_error AS "lastError",refund_status AS "refundStatus",TO_CHAR(refunded_date,'YYYY-MM-DD') AS "refundedDate",refund_reference AS "refundReference" FROM depannhome_subscription_credit_notes ORDER BY issue_date,id`);
        const creditsByInvoice = new Map();
        for (const credit of credits) creditsByInvoice.set(String(credit.sourceInvoiceId), [...(creditsByInvoice.get(String(credit.sourceInvoiceId)) || []), credit]);
        const invoices = rows.map(invoice => {
            const invoiceCredits = creditsByInvoice.get(String(invoice.id)) || [];
            const creditedAmountCents = invoiceCredits.reduce((sum, credit) => sum + Number(credit.amountCents || 0), 0);
            const balances = subscriptionInvoiceBalances(invoice.amountCents, creditedAmountCents, invoice.paidAmountCents);
            return {
            ...invoice,
            credits: invoiceCredits,
            creditedAmountCents,
            creditableAmountCents: Math.max(0, Number(invoice.amountCents) - creditedAmountCents),
            ...balances,
            matchesCurrentSubscription: subscriptionInvoiceMatchesCurrentSubscription(invoice, currentSubscriptionFromInvoiceRow(invoice)),
            currentSubscriptionAmountCents: buildSubscriptionInvoiceSnapshot(currentSubscriptionFromInvoiceRow(invoice), invoice.vatRate).netAmountCents
        }; });
        response.json({ invoices, summary: subscriptionInvoiceSummary(invoices), processing: await subscriptionInvoicingStatus() });
    }));

    app.post("/api/creator/subscription-invoices/process", requireCreator, asyncHandler(async (request, response) => {
        const result = await processDueSubscriptionInvoices();
        if (result.skippedReason === "incomplete_profile") {
            return response.status(409).json({ ...result, message: `Complétez le profil de facturation de la plateforme : ${result.missingProfileFields.join(", ")}.` });
        }
        if (result.skippedReason === "already_running") return response.status(409).json({ ...result, message: "Un traitement de facturation est déjà en cours. Réessayez dans quelques instants." });
        response.json({ ...result, message: processingMessage(result) });
    }));

    app.post("/api/creator/subscription-invoices/:invoiceId/payment", requireCreator, asyncHandler(async (request, response) => {
        const invoiceId = positiveId(request.params.invoiceId);
        const paidDate = validPaymentDate(request.body?.paidDate);
        const paymentReference = cleanText(request.body?.paymentReference, 160);
        if (!invoiceId || !paidDate) return response.status(400).json({ message: "Renseignez une date de règlement valide, non future." });
        const connection = await getPool().connect();
        try {
            await connection.query("BEGIN");
            const { rows } = await connection.query(`SELECT id,account_owner_id AS "accountOwnerId",status,payment_status AS "paymentStatus",net_amount_cents AS "netAmountCents",TO_CHAR(issue_date,'YYYY-MM-DD') AS "issueDate" FROM depannhome_subscription_invoices WHERE id=$1 FOR UPDATE`, [invoiceId]);
            const invoice = rows[0];
            if (!invoice) { await connection.query("ROLLBACK"); return response.status(404).json({ message: "Facture introuvable." }); }
            if (invoice.status !== "sent") { await connection.query("ROLLBACK"); return response.status(409).json({ message: "La facture initiale doit être envoyée avant de pouvoir accuser réception de son paiement." }); }
            if (invoice.paymentStatus === "paid") { await connection.query("ROLLBACK"); return response.status(409).json({ message: "Le paiement de cette facture a déjà été enregistré." }); }
            if (paidDate < invoice.issueDate) { await connection.query("ROLLBACK"); return response.status(400).json({ message: "La date de règlement ne peut pas précéder la date d’émission." }); }
            const creditResult = await connection.query(`SELECT COALESCE(SUM(amount_cents),0)::integer AS total FROM depannhome_subscription_credit_notes WHERE source_invoice_id=$1`, [invoiceId]);
            const paidAmountCents = Math.max(0, Number(invoice.netAmountCents) - Number(creditResult.rows[0].total));
            if (!paidAmountCents) { await connection.query("ROLLBACK"); return response.status(409).json({ message: "Cette facture est intégralement créditée et ne peut plus être marquée comme réglée." }); }
            await connection.query(`UPDATE depannhome_subscription_invoices SET payment_status='paid',paid_amount_cents=$2,paid_date=$3::date,paid_at=NOW(),paid_by=$4,payment_reference=$5,receipt_delivery_status='pending',receipt_sent_at=NULL,receipt_last_error='',updated_at=NOW() WHERE id=$1`, [invoiceId, paidAmountCents, paidDate, request.user.sub, paymentReference]);
            await connection.query(`INSERT INTO depannhome_subscription_invoice_audit (invoice_id,account_owner_id,actor_id,action,details) VALUES ($1,$2,$3,'payment_acknowledged',$4::jsonb)`, [invoiceId, invoice.accountOwnerId, request.user.sub, JSON.stringify({ paidDate, paymentReference, paidAmountCents })]);
            await connection.query("COMMIT");
        } catch (error) {
            await connection.query("ROLLBACK");
            throw error;
        } finally {
            connection.release();
        }
        const delivery = await sendPaidSubscriptionInvoice(invoiceId, request.user.sub);
        return response.status(delivery.sent ? 200 : 202).json({ paymentRecorded: true, receiptSent: delivery.sent, message: delivery.sent ? "Paiement enregistré et facture acquittée envoyée à l’entreprise." : `Paiement enregistré. L’envoi de la facture acquittée a échoué : ${delivery.message}` });
    }));

    app.post("/api/creator/subscription-invoices/:invoiceId/payment-receipt/send", requireCreator, asyncHandler(async (request, response) => {
        const invoiceId = positiveId(request.params.invoiceId);
        if (!invoiceId) return response.status(400).json({ message: "Facture invalide." });
        const delivery = await sendPaidSubscriptionInvoice(invoiceId, request.user.sub);
        if (delivery.alreadySent) return response.status(409).json({ message: "La facture acquittée a déjà été envoyée." });
        if (!delivery.sent) return response.status(502).json({ message: delivery.message || "L’envoi de la facture acquittée a échoué." });
        response.json({ receiptSent: true, message: "Facture acquittée renvoyée avec succès." });
    }));

    app.get("/api/creator/subscription-invoices/:invoiceId/pdf", requireCreator, asyncHandler(async (request, response) => {
        const invoiceId = positiveId(request.params.invoiceId);
        if (!invoiceId) return response.status(400).json({ message: "Facture invalide." });
        const { rows } = await getPool().query(`
            SELECT id, invoice_number AS "invoiceNumber", recipient_name AS "recipientName", recipient_address AS "recipientAddress",
                subscription_label AS "subscriptionLabel", amount_cents AS "amountCents", vat_rate::float AS "vatRate",
                TO_CHAR(issue_date, 'YYYY-MM-DD') AS "issueDate", TO_CHAR(due_date, 'YYYY-MM-DD') AS "dueDate", issuer_profile AS "issuerProfile",
                lines, financial_data AS "financialData", TO_CHAR(paid_date, 'YYYY-MM-DD') AS "paidDate"
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

    app.post("/api/creator/subscription-invoices/:invoiceId/credit-notes", requireCreator, asyncHandler(async (request, response) => {
        const invoiceId = positiveId(request.params.invoiceId);
        const reason = cleanText(request.body?.reason, 1000);
        const requestedKind = request.body?.creditKind === "partial" ? "partial" : "full";
        const requestedAmount = Number(request.body?.amountCents);
        if (!invoiceId || reason.length < 10) return response.status(400).json({ message: "Renseignez un motif précis d’au moins 10 caractères." });
        if (requestedKind === "partial" && (!Number.isSafeInteger(requestedAmount) || requestedAmount <= 0)) return response.status(400).json({ message: "Le montant partiel de l’avoir est invalide." });
        const connection = await getPool().connect();
        let creditNoteId;
        try {
            await connection.query("BEGIN");
            const { rows } = await connection.query(`SELECT id,account_owner_id AS "accountOwnerId",invoice_number AS "invoiceNumber",recipient_name AS "recipientName",recipient_email AS "recipientEmail",recipient_address AS "recipientAddress",net_amount_cents AS "netAmountCents",vat_rate::float AS "vatRate",TO_CHAR(issue_date,'YYYY-MM-DD') AS "issueDate",issuer_profile AS "issuerProfile",status,payment_status AS "paymentStatus",paid_amount_cents AS "paidAmountCents" FROM depannhome_subscription_invoices WHERE id=$1 FOR UPDATE`, [invoiceId]);
            const invoice = rows[0];
            if (!invoice) { await connection.query("ROLLBACK"); return response.status(404).json({ message: "Facture introuvable." }); }
            if (invoice.status !== "sent") { await connection.query("ROLLBACK"); return response.status(409).json({ message: "Seule une facture envoyée peut faire l’objet d’un avoir." }); }
            const existing = await connection.query(`SELECT COALESCE(SUM(amount_cents),0)::integer AS total FROM depannhome_subscription_credit_notes WHERE source_invoice_id=$1`, [invoiceId]);
            const creditableAmountCents = Math.max(0, Number(invoice.netAmountCents) - Number(existing.rows[0].total));
            if (!creditableAmountCents) { await connection.query("ROLLBACK"); return response.status(409).json({ message: "Cette facture est déjà intégralement créditée." }); }
            const amountCents = requestedKind === "full" ? creditableAmountCents : requestedAmount;
            if (amountCents > creditableAmountCents) { await connection.query("ROLLBACK"); return response.status(409).json({ message: `Le montant dépasse le solde créditable de ${(creditableAmountCents / 100).toFixed(2)} €.` }); }
            const creditKind = amountCents === creditableAmountCents ? "full" : "partial";
            const { rows: dates } = await connection.query(`SELECT TO_CHAR(CURRENT_DATE,'YYYY-MM-DD') AS "issueDate",EXTRACT(YEAR FROM CURRENT_DATE)::integer AS "seriesYear"`);
            if (dates[0].issueDate < invoice.issueDate) { await connection.query("ROLLBACK"); return response.status(409).json({ message: "La date de l’avoir ne peut pas précéder celle de la facture." }); }
            const sequence = await connection.query(`INSERT INTO depannhome_subscription_credit_note_sequences(series_year,last_number) VALUES($1,1) ON CONFLICT(series_year) DO UPDATE SET last_number=depannhome_subscription_credit_note_sequences.last_number+1,updated_at=NOW() RETURNING last_number AS "lastNumber"`, [dates[0].seriesYear]);
            const creditNumber = `AVO-DHP-${dates[0].seriesYear}-${String(sequence.rows[0].lastNumber).padStart(6, "0")}`;
            const totals = calculateSubscriptionCreditTotals(amountCents, invoice.vatRate);
            const lines = [{ description: `Avoir sur facture ${invoice.invoiceNumber}`, quantity: 1, unit: "avoir", unitPrice: totals.taxBaseCents / 100, vatRate: Number(invoice.vatRate) || 0 }];
            const document = subscriptionCreditNoteDocument({ creditNumber, sourceInvoiceNumber: invoice.invoiceNumber, sourceInvoiceDate: invoice.issueDate, issueDate: dates[0].issueDate, reason, recipientName: invoice.recipientName, recipientAddress: invoice.recipientAddress, issuerProfile: invoice.issuerProfile, lines, ...totals });
            const pdf = await createBillingPdf(document, invoice.issuerProfile || emptyProfile());
            const refundStatus = Number(invoice.paidAmountCents) > 0 ? "pending" : "not_required";
            const inserted = await connection.query(`INSERT INTO depannhome_subscription_credit_notes(source_invoice_id,account_owner_id,credit_number,source_invoice_number,source_invoice_date,issue_date,credit_kind,reason,amount_cents,tax_base_cents,vat_amount_cents,vat_rate,recipient_name,recipient_email,recipient_address,issuer_profile,lines,financial_data,pdf_data,pdf_sha256,created_by,refund_status) VALUES($1,$2,$3,$4,$5::date,$6::date,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,'{}'::jsonb,$18,$19,$20,$21) RETURNING id`, [invoice.id,invoice.accountOwnerId,creditNumber,invoice.invoiceNumber,invoice.issueDate,dates[0].issueDate,creditKind,reason,amountCents,totals.taxBaseCents,totals.vatAmountCents,invoice.vatRate,invoice.recipientName,invoice.recipientEmail,invoice.recipientAddress,JSON.stringify(invoice.issuerProfile),JSON.stringify(lines),pdf,createHash("sha256").update(pdf).digest("hex"),request.user.sub,refundStatus]);
            creditNoteId = inserted.rows[0].id;
            await connection.query(`INSERT INTO depannhome_subscription_credit_note_audit(credit_note_id,account_owner_id,actor_id,action,details) VALUES($1,$2,$3,'credit_note_issued',$4::jsonb)`, [creditNoteId,invoice.accountOwnerId,request.user.sub,JSON.stringify({ creditNumber, sourceInvoiceNumber: invoice.invoiceNumber, amountCents, reason, refundStatus })]);
            await connection.query(`INSERT INTO depannhome_subscription_invoice_audit(invoice_id,account_owner_id,actor_id,action,details) VALUES($1,$2,$3,'credit_note_issued',$4::jsonb)`, [invoice.id,invoice.accountOwnerId,request.user.sub,JSON.stringify({ creditNoteId, creditNumber, amountCents })]);
            await connection.query("COMMIT");
        } catch (error) { await connection.query("ROLLBACK"); throw error; } finally { connection.release(); }
        const delivery = await sendSubscriptionCreditNote(creditNoteId, request.user.sub);
        response.status(delivery.sent ? 201 : 202).json({ creditNoteId, sent: delivery.sent, message: delivery.sent ? "Avoir émis et envoyé à l’entreprise." : `Avoir émis et conservé. L’envoi a échoué : ${delivery.message}` });
    }));

    app.get("/api/creator/subscription-credit-notes/:creditNoteId/pdf", requireCreator, asyncHandler(async (request, response) => {
        const id = positiveId(request.params.creditNoteId);
        const { rows } = await getPool().query(`SELECT credit_number AS "creditNumber",pdf_data AS pdf FROM depannhome_subscription_credit_notes WHERE id=$1`, [id]);
        if (!rows[0]) return response.status(404).json({ message: "Avoir introuvable." });
        response.set({ "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="avoir-abonnement-${rows[0].creditNumber}.pdf"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
        response.send(rows[0].pdf);
    }));

    app.post("/api/creator/subscription-credit-notes/:creditNoteId/send", requireCreator, asyncHandler(async (request, response) => {
        const delivery = await sendSubscriptionCreditNote(positiveId(request.params.creditNoteId), request.user.sub);
        if (!delivery.sent) return response.status(delivery.alreadySent ? 409 : 502).json({ message: delivery.message });
        response.json({ message: "Avoir renvoyé avec succès." });
    }));

    app.post("/api/creator/subscription-credit-notes/:creditNoteId/refund", requireCreator, asyncHandler(async (request, response) => {
        const id = positiveId(request.params.creditNoteId);
        const refundedDate = validPaymentDate(request.body?.refundedDate);
        const refundReference = cleanText(request.body?.refundReference, 160);
        if (!id || !refundedDate || !refundReference) return response.status(400).json({ message: "Renseignez une date et une référence de remboursement valides." });
        const { rows } = await getPool().query(`UPDATE depannhome_subscription_credit_notes SET refund_status='refunded',refunded_date=$2::date,refunded_at=NOW(),refunded_by=$3,refund_reference=$4,updated_at=NOW() WHERE id=$1 AND refund_status='pending' AND issue_date<=$2::date RETURNING account_owner_id AS "accountOwnerId",credit_number AS "creditNumber",amount_cents AS "amountCents"`, [id,refundedDate,request.user.sub,refundReference]);
        if (!rows[0]) return response.status(409).json({ message: "Cet avoir n’attend aucun remboursement ou la date est antérieure à son émission." });
        await getPool().query(`INSERT INTO depannhome_subscription_credit_note_audit(credit_note_id,account_owner_id,actor_id,action,details) VALUES($1,$2,$3,'credit_note_refund_acknowledged',$4::jsonb)`, [id,rows[0].accountOwnerId,request.user.sub,JSON.stringify({ refundedDate, refundReference, amountCents: rows[0].amountCents })]);
        response.json({ message: `Remboursement de l’avoir ${rows[0].creditNumber} enregistré.` });
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
        await cancelSupersededSubscriptionInvoices();
        const { rows: subscriptions } = await database.query(`
            SELECT owner.id, owner.company_name AS "companyName", owner.full_name AS "fullName", owner.email, owner.subscription_label AS "subscriptionLabel",
                owner.subscription_plan AS "subscriptionPlan", owner.subscription_tier AS "subscriptionTier", owner.monthly_price_cents AS "monthlyPriceCents", owner.subscription_renewal_date AS "renewalDate", owner.billing_reference AS "billingReference",
                owner.max_pc_users AS "maxPcUsers", owner.max_technicians AS "maxTechnicians", owner.subscription_discount_label AS "discountLabel",
                owner.subscription_discount_mode AS "discountMode", owner.subscription_discount_value::float AS "discountValue", COALESCE(organization.interface_type,'standard') AS "interfaceType",
                COALESCE(NULLIF(profile.address, ''), '') || CASE WHEN COALESCE(profile.postal_code, '') <> '' OR COALESCE(profile.city, '') <> ''
                    THEN CASE WHEN COALESCE(profile.address, '') <> '' THEN E'\n' ELSE '' END || TRIM(CONCAT_WS(' ', profile.postal_code, profile.city)) ELSE '' END AS "recipientAddress"
            FROM depannhome_users owner
            LEFT JOIN depannhome_billing_profiles profile ON profile.owner_id = owner.id
            LEFT JOIN depannhome_organizations organization ON organization.account_owner_id = owner.id
            WHERE owner.account_owner_id = owner.id AND owner.is_active = TRUE AND owner.is_archived = FALSE AND owner.subscription_plan = 'paid'
                AND COALESCE(organization.interface_type, 'standard') <> 'partner'
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
    const recipientName = String(subscription.companyName || subscription.fullName || "Entreprise").trim();
    const vatRate = issuer.vatRegime === "franchise" ? 0 : issuer.vatRate;
    const snapshot = buildSubscriptionInvoiceSnapshot(subscription, vatRate);
    const connection = await database.connect();
    try {
        await connection.query("BEGIN");
        const existing = await connection.query(`SELECT id FROM depannhome_subscription_invoices WHERE account_owner_id=$1 AND billing_period=$2::date AND status<>'cancelled'`, [subscription.id, billingPeriod]);
        if (existing.rowCount) {
            await connection.query("COMMIT");
            return { created: false };
        }
        const { rows: dates } = await connection.query(`SELECT TO_CHAR(CURRENT_DATE,'YYYY-MM-DD') AS "issueDate",EXTRACT(YEAR FROM CURRENT_DATE)::integer AS "seriesYear"`);
        const { issueDate, seriesYear } = dates[0];
        const dueDate = addDays(issueDate, 30);
        const { rows: sequences } = await connection.query(`
            INSERT INTO depannhome_subscription_invoice_sequences (series_year,last_number) VALUES ($1,1)
            ON CONFLICT (series_year) DO UPDATE SET last_number=depannhome_subscription_invoice_sequences.last_number+1,updated_at=NOW()
            RETURNING last_number AS "lastNumber"
        `, [seriesYear]);
        const invoiceNumber = `DHP-${seriesYear}-${String(sequences[0].lastNumber).padStart(6, "0")}`;
        const { rows } = await connection.query(`
            INSERT INTO depannhome_subscription_invoices
                (account_owner_id, billing_period, invoice_number, recipient_name, recipient_email, recipient_address, subscription_label, amount_cents, net_amount_cents, vat_rate, issue_date, due_date, issuer_profile, lines, financial_data, subscription_snapshot)
            VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8,$9,$10,$11::date,$12::date,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb)
            ON CONFLICT (account_owner_id, billing_period) WHERE status<>'cancelled' DO NOTHING
            RETURNING id
        `, [subscription.id, billingPeriod, invoiceNumber, recipientName, subscription.email, String(subscription.recipientAddress || "").slice(0, 500), subscription.subscriptionLabel || "Abonnement Depann’Home Pro",
            subscription.monthlyPriceCents, snapshot.netAmountCents, vatRate, issueDate, dueDate, JSON.stringify(issuer), JSON.stringify(snapshot.lines), JSON.stringify(snapshot.financialData), JSON.stringify(subscriptionSnapshot(subscription, snapshot))]);
        if (!rows[0]) {
            await connection.query("ROLLBACK");
            return { created: false };
        }
        await connection.query("COMMIT");
        return { created: true, invoiceNumber };
    } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
    } finally {
        connection.release();
    }
}

async function deliverPendingInvoices() {
    const database = getPool();
    await database.query(`UPDATE depannhome_subscription_invoices SET status='failed',last_error='Traitement interrompu avant confirmation de l’envoi ; nouvelle tentative autorisée.',updated_at=NOW() WHERE status='sending' AND updated_at<NOW()-INTERVAL '15 minutes'`);
    await cancelSupersededSubscriptionInvoices();
    const { rows: invoices } = await database.query(`
        SELECT invoice.id, invoice.invoice_number AS "invoiceNumber", invoice.recipient_name AS "recipientName", invoice.recipient_email AS "recipientEmail",
            invoice.recipient_address AS "recipientAddress", invoice.subscription_label AS "subscriptionLabel", invoice.amount_cents AS "amountCents",
            invoice.vat_rate::float AS "vatRate", invoice.issue_date AS "issueDate", invoice.due_date AS "dueDate", invoice.issuer_profile AS "issuerProfile",
            invoice.lines, invoice.financial_data AS "financialData"
        FROM depannhome_subscription_invoices invoice
        JOIN depannhome_users owner ON owner.id = invoice.account_owner_id
        LEFT JOIN depannhome_organizations organization ON organization.account_owner_id = owner.id
        WHERE invoice.status IN ('pending', 'failed') AND owner.is_active = TRUE AND owner.is_archived = FALSE
            AND owner.subscription_plan = 'paid' AND owner.subscription_status = 'active'
            AND COALESCE(organization.interface_type, 'standard') <> 'partner'
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

async function sendPaidSubscriptionInvoice(invoiceId, actorId) {
    const database = getPool();
    await database.query(`UPDATE depannhome_subscription_invoices SET receipt_delivery_status='failed',receipt_last_error='Envoi interrompu avant confirmation ; une nouvelle tentative est autorisée.',updated_at=NOW() WHERE id=$1 AND receipt_delivery_status='sending' AND updated_at<NOW()-INTERVAL '15 minutes'`, [invoiceId]);
    const { rows } = await database.query(`
        UPDATE depannhome_subscription_invoices
        SET receipt_delivery_status='sending',receipt_last_error='',updated_at=NOW()
        WHERE id=$1 AND payment_status='paid' AND receipt_delivery_status IN ('pending','failed')
        RETURNING id,account_owner_id AS "accountOwnerId",invoice_number AS "invoiceNumber",recipient_name AS "recipientName",recipient_email AS "recipientEmail",
            recipient_address AS "recipientAddress",subscription_label AS "subscriptionLabel",amount_cents AS "amountCents",vat_rate::float AS "vatRate",
            TO_CHAR(issue_date,'YYYY-MM-DD') AS "issueDate",TO_CHAR(due_date,'YYYY-MM-DD') AS "dueDate",issuer_profile AS "issuerProfile",
            lines,financial_data AS "financialData",TO_CHAR(paid_date,'YYYY-MM-DD') AS "paidDate"
    `, [invoiceId]);
    const invoice = rows[0];
    if (!invoice) {
        const current = await database.query(`SELECT payment_status AS "paymentStatus",receipt_delivery_status AS "receiptDeliveryStatus" FROM depannhome_subscription_invoices WHERE id=$1`, [invoiceId]);
        if (!current.rows[0]) return { sent: false, message: "Facture introuvable." };
        if (current.rows[0].paymentStatus !== "paid") return { sent: false, message: "Le paiement doit d’abord être enregistré." };
        if (current.rows[0].receiptDeliveryStatus === "sent") return { sent: false, alreadySent: true, message: "La facture acquittée a déjà été envoyée." };
        return { sent: false, message: "Un envoi de la facture acquittée est déjà en cours." };
    }
    try {
        if (!EMAIL_PATTERN.test(String(invoice.recipientEmail || ""))) throw new Error("L’e-mail de facturation de l’entreprise est absent ou invalide.");
        const pdf = await createBillingPdf(subscriptionInvoiceDocument(invoice), invoice.issuerProfile || emptyProfile());
        await sendDocumentEmail({
            recipient: invoice.recipientEmail,
            recipientName: invoice.recipientName,
            documentLabel: `Facture d’abonnement acquittée ${invoice.invoiceNumber}`,
            attachment: { filename: subscriptionInvoicePdfFileName(invoice), content: pdf, contentType: "application/pdf" }
        });
        await database.query(`UPDATE depannhome_subscription_invoices SET receipt_delivery_status='sent',receipt_sent_at=NOW(),receipt_last_error='',updated_at=NOW() WHERE id=$1`, [invoiceId]);
        await database.query(`INSERT INTO depannhome_subscription_invoice_audit (invoice_id,account_owner_id,actor_id,action,details) VALUES ($1,$2,$3,'paid_receipt_sent',$4::jsonb)`, [invoiceId, invoice.accountOwnerId, actorId, JSON.stringify({ paidDate: invoice.paidDate, recipientEmail: invoice.recipientEmail })]);
        return { sent: true };
    } catch (error) {
        const message = String(error.message || "Échec d’envoi").slice(0, 1000);
        await database.query(`UPDATE depannhome_subscription_invoices SET receipt_delivery_status='failed',receipt_last_error=$2,updated_at=NOW() WHERE id=$1`, [invoiceId, message]);
        await database.query(`INSERT INTO depannhome_subscription_invoice_audit (invoice_id,account_owner_id,actor_id,action,details) VALUES ($1,$2,$3,'paid_receipt_failed',$4::jsonb)`, [invoiceId, invoice.accountOwnerId, actorId, JSON.stringify({ paidDate: invoice.paidDate, error: message })]);
        return { sent: false, message };
    }
}

async function sendSubscriptionCreditNote(creditNoteId, actorId) {
    if (!creditNoteId) return { sent: false, message: "Avoir invalide." };
    const database = getPool();
    await database.query(`UPDATE depannhome_subscription_credit_notes SET delivery_status='failed',last_error='Envoi interrompu avant confirmation ; une nouvelle tentative est autorisée.',updated_at=NOW() WHERE id=$1 AND delivery_status='sending' AND updated_at<NOW()-INTERVAL '15 minutes'`, [creditNoteId]);
    const { rows } = await database.query(`UPDATE depannhome_subscription_credit_notes SET delivery_status='sending',last_error='',updated_at=NOW() WHERE id=$1 AND delivery_status IN ('pending','failed') RETURNING id,account_owner_id AS "accountOwnerId",credit_number AS "creditNumber",recipient_name AS "recipientName",recipient_email AS "recipientEmail",pdf_data AS pdf`, [creditNoteId]);
    const credit = rows[0];
    if (!credit) {
        const current = await database.query(`SELECT delivery_status AS "deliveryStatus" FROM depannhome_subscription_credit_notes WHERE id=$1`, [creditNoteId]);
        if (!current.rows[0]) return { sent: false, message: "Avoir introuvable." };
        if (current.rows[0].deliveryStatus === "sent") return { sent: false, alreadySent: true, message: "L’avoir a déjà été envoyé." };
        return { sent: false, message: "Un envoi de l’avoir est déjà en cours." };
    }
    await database.query(`INSERT INTO depannhome_subscription_credit_note_audit(credit_note_id,account_owner_id,actor_id,action,details) VALUES($1,$2,$3,'credit_note_delivery_started',$4::jsonb)`, [credit.id,credit.accountOwnerId,actorId,JSON.stringify({ recipientEmail: credit.recipientEmail })]);
    try {
        if (!EMAIL_PATTERN.test(String(credit.recipientEmail || ""))) throw new Error("L’e-mail de facturation de l’entreprise est absent ou invalide.");
        const delivery = await sendDocumentEmail({ recipient: credit.recipientEmail, recipientName: credit.recipientName, documentLabel: `Avoir d’abonnement ${credit.creditNumber}`, attachment: { filename: `avoir-abonnement-${credit.creditNumber}.pdf`, content: credit.pdf, contentType: "application/pdf" } });
        await database.query(`UPDATE depannhome_subscription_credit_notes SET delivery_status='sent',sent_at=NOW(),last_error='',updated_at=NOW() WHERE id=$1`, [credit.id]);
        await database.query(`INSERT INTO depannhome_subscription_credit_note_audit(credit_note_id,account_owner_id,actor_id,action,details) VALUES($1,$2,$3,'credit_note_sent',$4::jsonb)`, [credit.id,credit.accountOwnerId,actorId,JSON.stringify({ recipientEmail: credit.recipientEmail, messageId: delivery?.messageId || "" })]);
        return { sent: true };
    } catch (error) {
        const message = String(error.message || "Échec d’envoi").slice(0, 1000);
        await database.query(`UPDATE depannhome_subscription_credit_notes SET delivery_status='failed',last_error=$2,updated_at=NOW() WHERE id=$1`, [credit.id,message]);
        await database.query(`INSERT INTO depannhome_subscription_credit_note_audit(credit_note_id,account_owner_id,actor_id,action,details) VALUES($1,$2,$3,'credit_note_delivery_failed',$4::jsonb)`, [credit.id,credit.accountOwnerId,actorId,JSON.stringify({ recipientEmail: credit.recipientEmail, error: message })]);
        return { sent: false, message };
    }
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
            COUNT(*) FILTER (WHERE owner.account_owner_id=owner.id AND owner.is_active AND NOT owner.is_archived AND owner.subscription_plan='paid' AND owner.subscription_status='active' AND owner.monthly_price_cents>0 AND owner.subscription_renewal_date IS NOT NULL AND owner.subscription_renewal_date<=CURRENT_DATE AND COALESCE(organization.interface_type,'standard')<>'partner')::int AS "dueAccounts",
            (SELECT COUNT(*)::int FROM depannhome_subscription_invoices invoice JOIN depannhome_users invoice_owner ON invoice_owner.id=invoice.account_owner_id LEFT JOIN depannhome_organizations invoice_organization ON invoice_organization.account_owner_id=invoice_owner.id WHERE invoice.status='pending' AND invoice_owner.subscription_plan='paid' AND COALESCE(invoice_organization.interface_type,'standard')<>'partner') AS pending,
            (SELECT COUNT(*)::int FROM depannhome_subscription_invoices invoice JOIN depannhome_users invoice_owner ON invoice_owner.id=invoice.account_owner_id LEFT JOIN depannhome_organizations invoice_organization ON invoice_organization.account_owner_id=invoice_owner.id WHERE invoice.status='failed' AND invoice_owner.subscription_plan='paid' AND COALESCE(invoice_organization.interface_type,'standard')<>'partner') AS failed,
            (SELECT COUNT(*)::int FROM depannhome_subscription_invoices invoice JOIN depannhome_users invoice_owner ON invoice_owner.id=invoice.account_owner_id LEFT JOIN depannhome_organizations invoice_organization ON invoice_organization.account_owner_id=invoice_owner.id WHERE invoice.status='sending' AND invoice_owner.subscription_plan='paid' AND COALESCE(invoice_organization.interface_type,'standard')<>'partner') AS sending
        FROM depannhome_users owner
        LEFT JOIN depannhome_organizations organization ON organization.account_owner_id=owner.id
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

function subscriptionSnapshot(subscription, snapshot = buildSubscriptionInvoiceSnapshot(subscription, 0)) {
    return {
        subscriptionPlan: subscription.subscriptionPlan || "paid",
        interfaceType: subscription.interfaceType || "standard",
        subscriptionTier: subscription.subscriptionTier || "",
        subscriptionLabel: subscription.subscriptionLabel || subscription.currentSubscriptionLabel || "",
        maxPcUsers: Number(subscription.maxPcUsers) || 0,
        maxTechnicians: Number(subscription.maxTechnicians) || 0,
        amountCents: Math.max(0, Number(subscription.monthlyPriceCents) || 0),
        netAmountCents: Math.max(0, Number(snapshot.netAmountCents) || 0),
        discountLabel: subscription.discountLabel || "",
        discountMode: subscription.discountMode === "percentage" ? "percentage" : "fixed",
        discountValue: Math.max(0, Number(subscription.discountValue) || 0)
    };
}

export function subscriptionInvoiceMatchesCurrentSubscription(invoice, subscription) {
    if (subscription.subscriptionPlan !== "paid" || subscription.interfaceType === "partner") return false;
    const expectedSnapshot = buildSubscriptionInvoiceSnapshot(subscription, Number(invoice.vatRate) || 0);
    const expected = subscriptionSnapshot(subscription, expectedSnapshot);
    const saved = invoice.subscriptionSnapshot && Object.keys(invoice.subscriptionSnapshot).length ? invoice.subscriptionSnapshot : null;
    if (saved) return Object.keys(expected).every(key => String(saved[key] ?? "") === String(expected[key] ?? ""));
    return Number(invoice.baseAmountCents ?? invoice.amountCents) === expected.amountCents
        && Number(invoice.amountCents ?? invoice.netAmountCents) === expected.netAmountCents
        && String(invoice.subscriptionLabel || "") === expected.subscriptionLabel;
}

function currentSubscriptionFromInvoiceRow(row) {
    return {
        subscriptionPlan: row.subscriptionPlan,
        interfaceType: row.interfaceType,
        subscriptionTier: row.subscriptionTier,
        subscriptionLabel: row.currentSubscriptionLabel,
        monthlyPriceCents: row.monthlyPriceCents,
        maxPcUsers: row.maxPcUsers,
        maxTechnicians: row.maxTechnicians,
        discountLabel: row.discountLabel,
        discountMode: row.discountMode,
        discountValue: row.discountValue
    };
}

async function cancelSupersededSubscriptionInvoices() {
    const database = getPool();
    const { rows } = await database.query(`
        SELECT invoice.id,invoice.account_owner_id AS "accountOwnerId",invoice.subscription_label AS "subscriptionLabel",
            invoice.amount_cents AS "baseAmountCents",invoice.net_amount_cents AS "amountCents",invoice.vat_rate::float AS "vatRate",
            invoice.subscription_snapshot AS "subscriptionSnapshot",owner.subscription_plan AS "subscriptionPlan",
            owner.subscription_tier AS "subscriptionTier",owner.subscription_label AS "currentSubscriptionLabel",
            owner.monthly_price_cents AS "monthlyPriceCents",owner.max_pc_users AS "maxPcUsers",owner.max_technicians AS "maxTechnicians",
            owner.subscription_discount_label AS "discountLabel",owner.subscription_discount_mode AS "discountMode",
            owner.subscription_discount_value::float AS "discountValue",COALESCE(organization.interface_type,'standard') AS "interfaceType"
        FROM depannhome_subscription_invoices invoice
        JOIN depannhome_users owner ON owner.id=invoice.account_owner_id
        LEFT JOIN depannhome_organizations organization ON organization.account_owner_id=owner.id
        WHERE invoice.status IN ('pending','failed')
    `);
    let cancelled = 0;
    for (const invoice of rows) {
        const current = currentSubscriptionFromInvoiceRow(invoice);
        if (subscriptionInvoiceMatchesCurrentSubscription(invoice, current)) continue;
        const result = await database.query(`UPDATE depannhome_subscription_invoices SET status='cancelled',last_error='Annulée automatiquement : l’abonnement a changé avant l’envoi.',updated_at=NOW() WHERE id=$1 AND status IN ('pending','failed') RETURNING id`, [invoice.id]);
        if (!result.rowCount) continue;
        await database.query(`INSERT INTO depannhome_subscription_invoice_audit (invoice_id,account_owner_id,action,details) VALUES ($1,$2,'superseded_before_sending',$3::jsonb)`, [invoice.id, invoice.accountOwnerId, JSON.stringify({ currentSubscription: subscriptionSnapshot(current) })]);
        cancelled += 1;
    }
    return cancelled;
}

export function buildSubscriptionInvoiceSnapshot(subscription, vatRate) {
    const amountCents = Math.max(0, Number(subscription.monthlyPriceCents) || 0);
    const discountMode = subscription.discountMode === "percentage" ? "percentage" : "fixed";
    const discountValue = Math.max(0, Number(subscription.discountValue) || 0);
    const discountCents = discountMode === "percentage"
        ? Math.min(amountCents, Math.round(amountCents * Math.min(100, discountValue) / 100))
        : Math.min(amountCents, Math.round(discountValue * 100));
    const tier = subscriptionTierConfig(subscription.subscriptionTier);
    const lines = [];
    const tierAmountCents = calculateSubscriptionPriceCents(subscription.subscriptionTier, subscription.maxPcUsers, subscription.maxTechnicians);
    if (subscription.subscriptionTier && amountCents === tierAmountCents) {
        if (Number(subscription.maxPcUsers) > 0) lines.push({ description: `${tier.label} — poste PC`, quantity: Number(subscription.maxPcUsers), unit: "poste/mois", unitPrice: amountExcludingVat(tier.pcRateCents, vatRate), vatRate });
        if (Number(subscription.maxTechnicians) > 0) lines.push({ description: `${tier.label} — poste mobile`, quantity: Number(subscription.maxTechnicians), unit: "poste/mois", unitPrice: amountExcludingVat(tier.mobileRateCents, vatRate), vatRate });
    } else {
        lines.push({ description: `${subscription.subscriptionLabel || "Abonnement Depann’Home Pro"} — abonnement mensuel`, quantity: 1, unit: "mois", unitPrice: amountExcludingVat(amountCents, vatRate), vatRate });
        if (Number(subscription.maxPcUsers) > 0) lines.push({ description: "Postes PC inclus", quantity: Number(subscription.maxPcUsers), unit: "poste", unitPrice: 0, vatRate });
        if (Number(subscription.maxTechnicians) > 0) lines.push({ description: "Postes mobiles inclus", quantity: Number(subscription.maxTechnicians), unit: "poste", unitPrice: 0, vatRate });
    }
    return {
        lines,
        financialData: {
            discountLabel: cleanText(subscription.discountLabel, 160) || "Remise commerciale",
            discountMode,
            discountAmount: discountMode === "percentage" ? Math.min(100, discountValue) : amountExcludingVat(discountCents, vatRate)
        },
        netAmountCents: amountCents - discountCents
    };
}

function subscriptionInvoiceDocument(invoice) {
    return {
        documentType: "invoice",
        documentNumber: invoice.invoiceNumber,
        customerName: invoice.recipientName,
        customerAddress: invoice.recipientAddress,
        issueDate: dateString(invoice.issueDate),
        dueDate: dateString(invoice.dueDate),
        paidDate: invoice.paidDate ? dateString(invoice.paidDate) : "",
        vatRegime: normalizeVatRegime(invoice.issuerProfile?.vatRegime),
        issuerTaxNumber: invoice.issuerProfile?.taxNumber || "",
        lines: Array.isArray(invoice.lines) && invoice.lines.length ? invoice.lines : [{
            description: `${invoice.subscriptionLabel} — abonnement mensuel`,
            quantity: 1,
            unit: "mois",
            unitPrice: amountExcludingVat(invoice.amountCents, invoice.vatRate),
            vatRate: invoice.vatRate
        }],
        financialData: invoice.financialData || {},
        notes: invoice.issuerProfile?.paymentTerms || "Paiement à réception de facture par virement bancaire."
    };
}

export function calculateSubscriptionCreditTotals(amountCents, vatRate) {
    const amount = Number(amountCents);
    const rate = Number(vatRate) || 0;
    if (!Number.isSafeInteger(amount) || amount <= 0 || rate < 0 || rate > 100) throw new TypeError("Montant ou taux de TVA invalide.");
    const taxBaseCents = Math.round(amount * 100 / (100 + rate));
    return { amountCents: amount, taxBaseCents, vatAmountCents: amount - taxBaseCents };
}

export function subscriptionInvoiceBalances(netAmountCents, creditedAmountCents = 0, paidAmountCents = 0) {
    const net = Math.max(0, Number(netAmountCents) || 0);
    const credits = Math.max(0, Number(creditedAmountCents) || 0);
    const paid = Math.max(0, Number(paidAmountCents) || 0);
    return { outstandingAmountCents: Math.max(net - credits - paid, 0), refundDueCents: Math.max(paid + credits - net, 0) };
}

function subscriptionInvoiceSummary(invoices) {
    return invoices.reduce((summary, invoice) => {
        if (invoice.status === "cancelled") return summary;
        summary.grossInvoicedCents += Number(invoice.amountCents) || 0;
        summary.creditedCents += Number(invoice.creditedAmountCents) || 0;
        summary.collectedCents += Number(invoice.paidAmountCents) || 0;
        summary.outstandingCents += Number(invoice.outstandingAmountCents) || 0;
        summary.refundsPendingCents += (invoice.credits || []).filter(credit => credit.refundStatus === "pending").reduce((sum, credit) => sum + Number(credit.amountCents || 0), 0);
        summary.netBilledCents = summary.grossInvoicedCents - summary.creditedCents;
        return summary;
    }, { grossInvoicedCents: 0, creditedCents: 0, netBilledCents: 0, collectedCents: 0, outstandingCents: 0, refundsPendingCents: 0 });
}

function subscriptionCreditNoteDocument(credit) {
    return {
        documentType: "credit", documentNumber: credit.creditNumber, sourceInvoiceNumber: credit.sourceInvoiceNumber, sourceInvoiceDate: credit.sourceInvoiceDate,
        customerName: credit.recipientName, customerAddress: credit.recipientAddress, issueDate: credit.issueDate,
        reason: credit.reason, notes: credit.reason, vatRegime: normalizeVatRegime(credit.issuerProfile?.vatRegime),
        issuerTaxNumber: credit.issuerProfile?.taxNumber || "", lines: credit.lines, financialData: {},
        exactTotals: { amountCents: credit.amountCents, taxBaseCents: credit.taxBaseCents, vatAmountCents: credit.vatAmountCents }
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

function validPaymentDate(value) {
    const date = String(value || "");
    const parsed = new Date(`${date}T12:00:00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || dateString(parsed) !== date) return "";
    return date <= new Date().toISOString().slice(0, 10) ? date : "";
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
