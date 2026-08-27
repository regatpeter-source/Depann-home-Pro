import multer from "multer";
import PDFDocument from "pdfkit";
import { getPool } from "./database.js";
import { getAccountOwnerId } from "./auth.js";
import { sendDocumentEmail } from "./email.js";
import { createQuitusDocumentOutput } from "./calendar.js";
import { createEmptyLeakContent } from "./leak-report-template.js";
import { postAccountingDocument } from "./accounting.js";
import { DOCX_MIME, PDF_MIME, renderCompanyTemplate, validateCompanyTemplate } from "./company-document-template.js";
import { createTechnicalReportOutput } from "./technical-reports.js";
import { buildBillingCustomModel, renderActiveCustomTemplate } from "./document-templates.js";
import { calculateDocumentAccountingTotals } from "./accounting-ledger.js";
import crypto from "node:crypto";
import { generateUblInvoice } from "./einvoice-ubl.js";
import { allocateBillingNumber } from "./billing-numbering.js";
import { hasBillingWorkspaceAccess } from "./workstation-permissions.js";

const MAX_LOGO_SIZE = 2 * 1024 * 1024;
const MAX_QUOTE_TEMPLATE_SIZE = 10 * 1024 * 1024;
const DOCUMENT_TYPES = new Set(["quote", "invoice"]);
const VAT_REGIMES = new Set(["standard", "franchise"]);
export const VAT_FRANCHISE_MENTION = "TVA non applicable, art. 293 B du CGI";
const CUSTOMER_TYPES = new Set(["Particulier", "Professionnel", "Magasin", "Autre"]);
const CLIENT_ID_PATTERN = /^client-[a-zA-Z0-9-]+$/;
const QUOTE_TEMPLATE_POLICIES = new Set(["integrated_only", "company_choice", "external_only"]);
const QUOTE_TEMPLATE_MODES = new Set(["integrated", "external"]);
const DOCUMENT_TEMPLATE_FONTS = new Set(["Helvetica", "Times-Roman", "Courier"]);
const OPERATION_CATEGORIES = new Set(["goods", "services", "mixed"]);
const DEFAULT_EARLY_PAYMENT_DISCOUNT_TERMS = "Aucun escompte pour paiement anticipé.";
const DEFAULT_LATE_PAYMENT_PENALTY_TERMS = "Pénalités de retard exigibles au taux de trois fois le taux d’intérêt légal à compter du jour suivant la date d’échéance.";
const DEFAULT_DOCUMENT_TEMPLATE = Object.freeze({ primaryColor: "#172033", secondaryColor: "#0a5c36", separatorColor: "#d7dde3", font: "Helvetica", headerText: "", footerText: "" });
const ADDITIONAL_TEMPLATE_TYPES = Object.freeze({
    quitus: { label: "quitus", policyColumn: "quitus_template_policy", modeColumn: "quitus_template_mode", filenameColumn: "quitus_template_filename", dataColumn: "quitus_template_data", mimeColumn: "quitus_template_mime_type" },
    report: { label: "rapport", policyColumn: "report_template_policy", modeColumn: "report_file_template_mode", filenameColumn: "report_file_template_filename", dataColumn: "report_file_template_data", mimeColumn: "report_file_template_mime_type" }
});
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_LOGO_SIZE, files: 1 },
    fileFilter: (request, file, callback) => {
        if (["image/png", "image/jpeg", "image/webp"].includes(file.mimetype)) return callback(null, true);
        return callback(new Error("Seules les images PNG, JPEG ou WebP sont acceptées."));
    }
});
const quoteTemplateUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_QUOTE_TEMPLATE_SIZE, files: 1 },
    fileFilter: (request, file, callback) => {
        if ([PDF_MIME, DOCX_MIME].includes(file.mimetype)) return callback(null, true);
        return callback(new Error("Seuls les gabarits PDF et DOCX sont acceptés. Convertissez les anciens fichiers DOC en DOCX."));
    }
});

export async function initializeBilling() {
    const database = getPool();
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_billing_profiles (
            owner_id BIGINT PRIMARY KEY REFERENCES depannhome_users(id) ON DELETE CASCADE,
            company_name VARCHAR(160) NOT NULL DEFAULT '',
            legal_form VARCHAR(100) NOT NULL DEFAULT '',
            address VARCHAR(255) NOT NULL DEFAULT '',
            postal_code VARCHAR(20) NOT NULL DEFAULT '',
            city VARCHAR(100) NOT NULL DEFAULT '',
            phone VARCHAR(50) NOT NULL DEFAULT '',
            secondary_phone VARCHAR(50) NOT NULL DEFAULT '',
            email VARCHAR(160) NOT NULL DEFAULT '',
            country VARCHAR(100) NOT NULL DEFAULT 'France',
            registration_number VARCHAR(100) NOT NULL DEFAULT '',
            siren VARCHAR(20) NOT NULL DEFAULT '',
            tax_number VARCHAR(100) NOT NULL DEFAULT '',
            vat_regime VARCHAR(20) NOT NULL DEFAULT 'standard' CHECK (vat_regime IN ('standard','franchise')),
            bank_iban VARCHAR(80) NOT NULL DEFAULT '',
            bank_bic VARCHAR(40) NOT NULL DEFAULT '',
            payment_terms VARCHAR(500) NOT NULL DEFAULT '',
            deposit_terms VARCHAR(500) NOT NULL DEFAULT '',
            early_payment_discount_terms VARCHAR(500) NOT NULL DEFAULT 'Aucun escompte pour paiement anticipé.',
            late_payment_penalty_terms VARCHAR(1000) NOT NULL DEFAULT 'Pénalités de retard exigibles au taux de trois fois le taux d’intérêt légal à compter du jour suivant la date d’échéance.',
            recovery_indemnity_cents INTEGER NOT NULL DEFAULT 4000 CHECK (recovery_indemnity_cents >= 0),
            vat_on_debits BOOLEAN NOT NULL DEFAULT FALSE,
            footer_note VARCHAR(1000) NOT NULL DEFAULT '',
            default_quote JSONB,
            quote_template_config JSONB NOT NULL DEFAULT '{}'::jsonb,
            quote_template_mode VARCHAR(20) NOT NULL DEFAULT 'integrated',
            quote_template_filename VARCHAR(255) NOT NULL DEFAULT '',
            quote_template_data BYTEA,
            quote_template_mime_type VARCHAR(150) NOT NULL DEFAULT '',
            quitus_template_mode VARCHAR(20) NOT NULL DEFAULT 'integrated',
            quitus_template JSONB NOT NULL DEFAULT '{}'::jsonb,
            quitus_template_filename VARCHAR(255) NOT NULL DEFAULT '',
            quitus_template_data BYTEA,
            quitus_template_mime_type VARCHAR(150) NOT NULL DEFAULT '',
            report_file_template_mode VARCHAR(20) NOT NULL DEFAULT 'integrated',
            report_file_template_filename VARCHAR(255) NOT NULL DEFAULT '',
            report_file_template_data BYTEA,
            report_file_template_mime_type VARCHAR(150) NOT NULL DEFAULT '',
            report_template JSONB NOT NULL DEFAULT '{}'::jsonb,
            report_secondary_logo_data BYTEA,
            report_secondary_logo_mime_type VARCHAR(50) NOT NULL DEFAULT '',
            logo_data BYTEA,
            logo_mime_type VARCHAR(50) NOT NULL DEFAULT '',
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await database.query(`
        ALTER TABLE depannhome_billing_profiles
        ADD COLUMN IF NOT EXISTS default_quote JSONB,
        ADD COLUMN IF NOT EXISTS quote_template_config JSONB NOT NULL DEFAULT '{}'::jsonb,
        ADD COLUMN IF NOT EXISTS secondary_phone VARCHAR(50) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS country VARCHAR(100) NOT NULL DEFAULT 'France',
        ADD COLUMN IF NOT EXISTS siren VARCHAR(20) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS vat_regime VARCHAR(20) NOT NULL DEFAULT 'standard',
        ADD COLUMN IF NOT EXISTS bank_iban VARCHAR(80) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS bank_bic VARCHAR(40) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS deposit_terms VARCHAR(500) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS early_payment_discount_terms VARCHAR(500) NOT NULL DEFAULT 'Aucun escompte pour paiement anticipé.',
        ADD COLUMN IF NOT EXISTS late_payment_penalty_terms VARCHAR(1000) NOT NULL DEFAULT 'Pénalités de retard exigibles au taux de trois fois le taux d’intérêt légal à compter du jour suivant la date d’échéance.',
        ADD COLUMN IF NOT EXISTS recovery_indemnity_cents INTEGER NOT NULL DEFAULT 4000,
        ADD COLUMN IF NOT EXISTS vat_on_debits BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS quote_template_mode VARCHAR(20) NOT NULL DEFAULT 'integrated',
        ADD COLUMN IF NOT EXISTS quote_template_filename VARCHAR(255) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS quote_template_data BYTEA,
        ADD COLUMN IF NOT EXISTS quote_template_mime_type VARCHAR(150) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS quitus_template_mode VARCHAR(20) NOT NULL DEFAULT 'integrated',
        ADD COLUMN IF NOT EXISTS quitus_template JSONB NOT NULL DEFAULT '{}'::jsonb,
        ADD COLUMN IF NOT EXISTS quitus_template_filename VARCHAR(255) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS quitus_template_data BYTEA,
        ADD COLUMN IF NOT EXISTS quitus_template_mime_type VARCHAR(150) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS report_file_template_mode VARCHAR(20) NOT NULL DEFAULT 'integrated',
        ADD COLUMN IF NOT EXISTS report_file_template_filename VARCHAR(255) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS report_file_template_data BYTEA,
        ADD COLUMN IF NOT EXISTS report_file_template_mime_type VARCHAR(150) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS report_template JSONB NOT NULL DEFAULT '{}'::jsonb,
        ADD COLUMN IF NOT EXISTS report_secondary_logo_data BYTEA,
        ADD COLUMN IF NOT EXISTS report_secondary_logo_mime_type VARCHAR(50) NOT NULL DEFAULT ''
    `);
    await database.query("ALTER TABLE depannhome_billing_profiles DROP CONSTRAINT IF EXISTS depannhome_billing_profiles_vat_regime_check");
    await database.query("ALTER TABLE depannhome_billing_profiles ADD CONSTRAINT depannhome_billing_profiles_vat_regime_check CHECK (vat_regime IN ('standard','franchise'))");
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_billing_templates (
            id BIGSERIAL PRIMARY KEY,
            owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            label VARCHAR(160) NOT NULL,
            description VARCHAR(500) NOT NULL DEFAULT '',
            unit VARCHAR(40) NOT NULL DEFAULT 'unité',
            unit_price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
            vat_rate NUMERIC(5,2) NOT NULL DEFAULT 20 CHECK (vat_rate >= 0 AND vat_rate <= 100),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await database.query(`
        CREATE INDEX IF NOT EXISTS depannhome_billing_templates_owner_idx
        ON depannhome_billing_templates (owner_id, LOWER(label))
    `);
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_billing_documents (
            id BIGSERIAL PRIMARY KEY,
            owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
            created_by_name VARCHAR(160) NOT NULL DEFAULT '',
            document_type VARCHAR(10) NOT NULL CHECK (document_type IN ('quote', 'invoice')),
            document_number VARCHAR(80) NOT NULL,
            client_id VARCHAR(100),
            customer_type VARCHAR(30) NOT NULL DEFAULT 'Particulier',
            customer_name VARCHAR(160) NOT NULL DEFAULT '',
            customer_address VARCHAR(500) NOT NULL DEFAULT '',
            issue_date DATE NOT NULL,
            due_date DATE,
            status VARCHAR(30) NOT NULL DEFAULT 'draft',
            is_email_sent BOOLEAN NOT NULL DEFAULT FALSE,
            sent_at TIMESTAMPTZ,
            is_accounted BOOLEAN NOT NULL DEFAULT FALSE,
            accounted_at DATE,
            appointment_id BIGINT,
            source_quote_id BIGINT,
            correction_source_id BIGINT,
            correction_kind VARCHAR(20) NOT NULL DEFAULT 'none' CHECK (correction_kind IN ('none', 'replacement', 'amendment')),
            quote_reference VARCHAR(80) NOT NULL DEFAULT '',
            vat_regime VARCHAR(20) NOT NULL DEFAULT 'standard' CHECK (vat_regime IN ('standard','franchise')),
            issuer_tax_number VARCHAR(100) NOT NULL DEFAULT '',
            legal_data JSONB NOT NULL DEFAULT '{}'::jsonb,
            issued_at TIMESTAMPTZ,
            finalized_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
            legal_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
            structured_data BYTEA,
            structured_mime_type VARCHAR(150) NOT NULL DEFAULT '',
            structured_sha256 CHAR(64),
            pdf_data BYTEA,
            pdf_sha256 VARCHAR(64),
            lines JSONB NOT NULL DEFAULT '[]'::jsonb,
            notes VARCHAR(2000) NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT depannhome_billing_documents_owner_number_unique UNIQUE (owner_id, document_number)
        )
    `);
    await database.query(`
        CREATE INDEX IF NOT EXISTS depannhome_billing_documents_owner_date_idx
        ON depannhome_billing_documents (owner_id, issue_date DESC, created_at DESC)
    `);
    await database.query(`
        ALTER TABLE depannhome_billing_documents
        ADD COLUMN IF NOT EXISTS is_accounted BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS accounted_at DATE,
        ADD COLUMN IF NOT EXISTS created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS created_by_name VARCHAR(160) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS client_id VARCHAR(100),
        ADD COLUMN IF NOT EXISTS appointment_id BIGINT,
        ADD COLUMN IF NOT EXISTS source_quote_id BIGINT,
        ADD COLUMN IF NOT EXISTS is_email_sent BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS correction_source_id BIGINT,
        ADD COLUMN IF NOT EXISTS correction_kind VARCHAR(20) NOT NULL DEFAULT 'none',
        ADD COLUMN IF NOT EXISTS quote_reference VARCHAR(80) NOT NULL DEFAULT ''
        ,ADD COLUMN IF NOT EXISTS vat_regime VARCHAR(20) NOT NULL DEFAULT 'standard'
        ,ADD COLUMN IF NOT EXISTS issuer_tax_number VARCHAR(100) NOT NULL DEFAULT ''
        ,ADD COLUMN IF NOT EXISTS legal_data JSONB NOT NULL DEFAULT '{}'::jsonb
        ,ADD COLUMN IF NOT EXISTS issued_at TIMESTAMPTZ
        ,ADD COLUMN IF NOT EXISTS finalized_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL
        ,ADD COLUMN IF NOT EXISTS legal_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb
        ,ADD COLUMN IF NOT EXISTS structured_data BYTEA
        ,ADD COLUMN IF NOT EXISTS structured_mime_type VARCHAR(150) NOT NULL DEFAULT ''
        ,ADD COLUMN IF NOT EXISTS structured_sha256 CHAR(64)
        ,ADD COLUMN IF NOT EXISTS pdf_data BYTEA
        ,ADD COLUMN IF NOT EXISTS pdf_sha256 VARCHAR(64)
    `);
    await database.query("ALTER TABLE depannhome_billing_documents DROP CONSTRAINT IF EXISTS depannhome_billing_documents_vat_regime_check");
    await database.query("ALTER TABLE depannhome_billing_documents ADD CONSTRAINT depannhome_billing_documents_vat_regime_check CHECK (vat_regime IN ('standard','franchise'))");
    await database.query("ALTER TABLE depannhome_billing_documents DROP CONSTRAINT IF EXISTS depannhome_billing_documents_correction_kind_check");
    await database.query("ALTER TABLE depannhome_billing_documents ADD CONSTRAINT depannhome_billing_documents_correction_kind_check CHECK (correction_kind IN ('none','replacement','amendment'))");
    await database.query(`
        UPDATE depannhome_billing_documents document
        SET created_by_name = COALESCE(NULLIF(creator.full_name, ''), creator.username, '')
        FROM depannhome_users creator
        WHERE document.created_by = creator.id AND document.created_by_name = ''
    `);
    await database.query(`
        CREATE INDEX IF NOT EXISTS depannhome_billing_documents_accounting_idx
        ON depannhome_billing_documents (owner_id, document_type, is_accounted, issue_date DESC)
    `);
    await database.query(`
        CREATE INDEX IF NOT EXISTS depannhome_billing_documents_appointment_idx
        ON depannhome_billing_documents (owner_id, appointment_id)
    `);
    await database.query(`
        CREATE INDEX IF NOT EXISTS depannhome_billing_documents_client_idx
        ON depannhome_billing_documents (owner_id, client_id)
    `);
    await database.query(`
        CREATE INDEX IF NOT EXISTS depannhome_billing_documents_correction_idx
        ON depannhome_billing_documents (owner_id, correction_source_id)
    `);
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_billing_sequences (
            owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            series_type VARCHAR(10) NOT NULL CHECK (series_type IN ('invoice','credit')),
            series_year INTEGER NOT NULL CHECK (series_year >= 2000),
            last_number BIGINT NOT NULL DEFAULT 0 CHECK (last_number >= 0),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (owner_id, series_type, series_year)
        )
    `);
    await database.query(`
        CREATE OR REPLACE FUNCTION depannhome_protect_issued_billing_document() RETURNS trigger AS $$
        BEGIN
            IF TG_OP='DELETE' AND OLD.issued_at IS NOT NULL THEN RAISE EXCEPTION 'Un document émis ne peut pas être supprimé.'; END IF;
            IF TG_OP='UPDATE' AND OLD.issued_at IS NOT NULL AND ROW(NEW.owner_id,NEW.created_by,NEW.created_by_name,NEW.document_type,NEW.document_number,NEW.client_id,NEW.customer_type,NEW.customer_name,NEW.customer_address,NEW.issue_date,NEW.due_date,NEW.appointment_id,NEW.source_quote_id,NEW.correction_source_id,NEW.correction_kind,NEW.quote_reference,NEW.vat_regime,NEW.issuer_tax_number,NEW.legal_data,NEW.issued_at,NEW.finalized_by,NEW.legal_snapshot,NEW.structured_data,NEW.structured_mime_type,NEW.structured_sha256,NEW.pdf_data,NEW.pdf_sha256,NEW.lines,NEW.notes,NEW.financial_data,NEW.created_at)
                IS DISTINCT FROM ROW(OLD.owner_id,OLD.created_by,OLD.created_by_name,OLD.document_type,OLD.document_number,OLD.client_id,OLD.customer_type,OLD.customer_name,OLD.customer_address,OLD.issue_date,OLD.due_date,OLD.appointment_id,OLD.source_quote_id,OLD.correction_source_id,OLD.correction_kind,OLD.quote_reference,OLD.vat_regime,OLD.issuer_tax_number,OLD.legal_data,OLD.issued_at,OLD.finalized_by,OLD.legal_snapshot,OLD.structured_data,OLD.structured_mime_type,OLD.structured_sha256,OLD.pdf_data,OLD.pdf_sha256,OLD.lines,OLD.notes,OLD.financial_data,OLD.created_at)
            THEN RAISE EXCEPTION 'Les données légales d’un document émis sont immuables.'; END IF;
            RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
        END; $$ LANGUAGE plpgsql
    `);
    await database.query("DROP TRIGGER IF EXISTS depannhome_billing_document_immutable ON depannhome_billing_documents");
    await database.query("CREATE TRIGGER depannhome_billing_document_immutable BEFORE UPDATE OR DELETE ON depannhome_billing_documents FOR EACH ROW EXECUTE FUNCTION depannhome_protect_issued_billing_document()");
}

export function registerBillingRoutes(app, requireAuthentication) {
    app.use("/api/billing", requireBillingWorkspaceAccess);
    app.get("/api/billing", requireAuthentication, asyncHandler(async (request, response) => {
        const database = getPool();
        const accountOwnerId = getAccountOwnerId(request);
        const [profileResult, templatesResult, documentsResult, aidsResult, settlementsResult, purchasesResult] = await Promise.all([
            database.query(`
                SELECT profile.company_name AS "companyName", profile.legal_form AS "legalForm", profile.address, profile.postal_code AS "postalCode", profile.city,
                    profile.phone, profile.secondary_phone AS "secondaryPhone", profile.email, profile.country, profile.registration_number AS "registrationNumber", profile.siren, profile.tax_number AS "taxNumber", profile.vat_regime AS "vatRegime", profile.bank_iban AS "bankIban", profile.bank_bic AS "bankBic",
                    profile.payment_terms AS "paymentTerms", profile.deposit_terms AS "depositTerms", profile.early_payment_discount_terms AS "earlyPaymentDiscountTerms", profile.late_payment_penalty_terms AS "latePaymentPenaltyTerms", profile.recovery_indemnity_cents AS "recoveryIndemnityCents", profile.vat_on_debits AS "vatOnDebits", profile.footer_note AS "footerNote", profile.default_quote AS "defaultQuote",
                    profile.quote_template_config AS "quoteTemplateConfig", profile.quitus_template AS "quitusTemplate",
                    profile.quote_template_mode AS "quoteTemplateMode", profile.quote_template_filename AS "quoteTemplateFilename",
                    (profile.quote_template_data IS NOT NULL) AS "hasQuoteTemplate", (profile.logo_data IS NOT NULL) AS "hasLogo",
                    profile.quitus_template_mode AS "quitusTemplateMode", profile.quitus_template_filename AS "quitusTemplateFilename", (profile.quitus_template_data IS NOT NULL) AS "hasQuitusTemplate",
                    profile.report_file_template_mode AS "reportFileTemplateMode", profile.report_file_template_filename AS "reportFileTemplateFilename", (profile.report_file_template_data IS NOT NULL) AS "hasReportFileTemplate",
                    owner.quote_template_policy AS "quoteTemplatePolicy", owner.quitus_template_policy AS "quitusTemplatePolicy", owner.report_template_policy AS "reportTemplatePolicy"
                FROM depannhome_users owner
                LEFT JOIN depannhome_billing_profiles profile ON profile.owner_id = owner.id
                WHERE owner.id = $1
            `, [accountOwnerId]),
            database.query(`
                SELECT id, label, description, unit, unit_price::float AS "unitPrice", vat_rate::float AS "vatRate"
                FROM depannhome_billing_templates WHERE owner_id = $1 ORDER BY LOWER(label)
            `, [accountOwnerId]),
            database.query(`
                SELECT depannhome_billing_documents.id, document_type AS "documentType", document_number AS "documentNumber", client_id AS "clientId", customer_type AS "customerType",
                    customer_name AS "customerName", customer_address AS "customerAddress", TO_CHAR(issue_date, 'YYYY-MM-DD') AS "issueDate",
                    TO_CHAR(due_date, 'YYYY-MM-DD') AS "dueDate", status, is_email_sent AS "isEmailSent", sent_at AS "sentAt", is_accounted AS "isAccounted",
                    TO_CHAR(accounted_at, 'YYYY-MM-DD') AS "accountedAt", appointment_id AS "appointmentId", source_quote_id AS "sourceQuoteId", correction_source_id AS "correctionSourceId", correction_kind AS "correctionKind", (SELECT source.document_number FROM depannhome_billing_documents source WHERE source.id=depannhome_billing_documents.correction_source_id) AS "correctionSourceNumber", quote_reference AS "quoteReference", vat_regime AS "vatRegime", issuer_tax_number AS "issuerTaxNumber", legal_data AS "legalData", issued_at AS "issuedAt", (structured_data IS NOT NULL) AS "hasStructuredData", lines, notes, financial_data AS "financialData",
                    depannhome_billing_documents.created_at AS "createdAt", depannhome_billing_documents.updated_at AS "updatedAt",
                    COALESCE(NULLIF(depannhome_billing_documents.created_by_name, ''), NULLIF(creator.full_name, ''), creator.username, '') AS "creatorName"
                FROM depannhome_billing_documents
                LEFT JOIN depannhome_users creator ON creator.id = depannhome_billing_documents.created_by
                                WHERE depannhome_billing_documents.owner_id = $1
                                    AND ($2 <> 'technician'
                                        OR depannhome_billing_documents.created_by = $3
                                        OR EXISTS (
                                                SELECT 1 FROM depannhome_calendar_events appointment
                                                WHERE appointment.id = depannhome_billing_documents.appointment_id
                                                    AND appointment.owner_id = $1
                                                    AND EXISTS (SELECT 1 FROM depannhome_calendar_assignments assignment WHERE assignment.event_id = appointment.id AND assignment.technician_id = $3)
                                                  )
                                                  OR EXISTS (
                                                    SELECT 1
                                                    FROM depannhome_billing_documents source_quote
                                                    LEFT JOIN depannhome_calendar_events quote_appointment ON quote_appointment.id = source_quote.appointment_id
                                                    WHERE source_quote.id = depannhome_billing_documents.source_quote_id
                                                      AND source_quote.owner_id = $1
                                                      AND (source_quote.created_by = $3 OR EXISTS (SELECT 1 FROM depannhome_calendar_assignments assignment WHERE assignment.event_id = quote_appointment.id AND assignment.technician_id = $3))
                                                  ))
                                ORDER BY issue_date DESC, depannhome_billing_documents.id DESC
                        `, [accountOwnerId, request.user?.role || "", request.user?.sub || 0]),
            database.query(`
                SELECT id, name, description, aid_type AS "aidType", calculation_mode AS "calculationMode", amount::float AS amount, auto_apply AS "autoApply"
                FROM depannhome_accounting_aids
                WHERE owner_id = $1
                ORDER BY auto_apply DESC, LOWER(name)
            `, [accountOwnerId]),
            database.query(`
                SELECT document_id AS "documentId", COALESCE(SUM(amount),0)::float AS amount,
                    (ARRAY_AGG(method ORDER BY settlement_date DESC,id DESC))[1] AS "latestPaymentMethod",
                    TO_CHAR((ARRAY_AGG(settlement_date ORDER BY settlement_date DESC,id DESC))[1], 'YYYY-MM-DD') AS "latestPaymentDate"
                FROM depannhome_accounting_settlements
                WHERE owner_id = $1
                GROUP BY document_id
            `, [accountOwnerId]),
            database.query(`
                SELECT COALESCE(SUM(amount_ht),0)::float AS "purchasesHt"
                FROM depannhome_purchases
                WHERE owner_id = $1
            `, [accountOwnerId])
        ]);
        const financialDashboard = buildBillingFinancialDashboard(documentsResult.rows, settlementsResult.rows, purchasesResult.rows[0]?.purchasesHt);
        const settlementsByDocument = new Map(settlementsResult.rows.map(item => [String(item.documentId), item]));
        const documents = documentsResult.rows.map(document => ({ ...document, settledAmount: Number(settlementsByDocument.get(String(document.id))?.amount) || 0, latestPaymentMethod: settlementsByDocument.get(String(document.id))?.latestPaymentMethod || "", latestPaymentDate: settlementsByDocument.get(String(document.id))?.latestPaymentDate || "" }));
        response.json({ profile: { ...emptyProfile(), ...(profileResult.rows[0] || {}) }, templates: templatesResult.rows, documents, aids: aidsResult.rows, financialDashboard });
    }));

    app.put("/api/billing/profile", requireAuthentication, requireBillingAdministration, upload.single("logo"), asyncHandler(async (request, response) => {
        const profile = sanitizeProfile(request.body);
        const removeLogo = String(request.body?.removeLogo || "") === "true";
        const logo = request.file;
        const database = getPool();
        await database.query(`
            INSERT INTO depannhome_billing_profiles
                (owner_id, company_name, legal_form, address, postal_code, city, phone, secondary_phone, email, country, registration_number, siren, tax_number, vat_regime, bank_iban, bank_bic, payment_terms, deposit_terms, early_payment_discount_terms, late_payment_penalty_terms, recovery_indemnity_cents, vat_on_debits, footer_note, logo_data, logo_mime_type)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
            ON CONFLICT (owner_id) DO UPDATE SET
                company_name = EXCLUDED.company_name, legal_form = EXCLUDED.legal_form, address = EXCLUDED.address,
                postal_code = EXCLUDED.postal_code, city = EXCLUDED.city, phone = EXCLUDED.phone, secondary_phone = EXCLUDED.secondary_phone, email = EXCLUDED.email, country = EXCLUDED.country,
                registration_number = EXCLUDED.registration_number, siren = EXCLUDED.siren, tax_number = EXCLUDED.tax_number, vat_regime = EXCLUDED.vat_regime, bank_iban = EXCLUDED.bank_iban, bank_bic = EXCLUDED.bank_bic,
                payment_terms = EXCLUDED.payment_terms, deposit_terms = EXCLUDED.deposit_terms, early_payment_discount_terms = EXCLUDED.early_payment_discount_terms,
                late_payment_penalty_terms = EXCLUDED.late_payment_penalty_terms, recovery_indemnity_cents = EXCLUDED.recovery_indemnity_cents, vat_on_debits = EXCLUDED.vat_on_debits, footer_note = EXCLUDED.footer_note,
                logo_data = CASE WHEN $26 THEN NULL WHEN $27 THEN EXCLUDED.logo_data ELSE depannhome_billing_profiles.logo_data END,
                logo_mime_type = CASE WHEN $26 THEN '' WHEN $27 THEN EXCLUDED.logo_mime_type ELSE depannhome_billing_profiles.logo_mime_type END,
                updated_at = NOW()
        `, [getAccountOwnerId(request), profile.companyName, profile.legalForm, profile.address, profile.postalCode, profile.city, profile.phone, profile.secondaryPhone,
            profile.email, profile.country, profile.registrationNumber, profile.siren, profile.taxNumber, profile.vatRegime, profile.bankIban, profile.bankBic, profile.paymentTerms, profile.depositTerms,
            profile.earlyPaymentDiscountTerms, profile.latePaymentPenaltyTerms, profile.recoveryIndemnityCents, profile.vatOnDebits, profile.footerNote,
            logo?.buffer || null, logo?.mimetype || "", removeLogo, Boolean(logo)]);
        response.status(204).end();
    }));

    app.get("/api/billing/logo", requireAuthentication, asyncHandler(async (request, response) => {
        const { rows } = await getPool().query(
            "SELECT logo_data, logo_mime_type FROM depannhome_billing_profiles WHERE owner_id = $1", [getAccountOwnerId(request)]
        );
        if (!rows[0]?.logo_data) return response.status(404).end();
        response.set({ "Content-Type": rows[0].logo_mime_type, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
        response.send(rows[0].logo_data);
    }));

    app.put("/api/billing/quote-template", requireAuthentication, requireBillingAdministration, quoteTemplateUpload.single("quoteTemplate"), asyncHandler(async (request, response) => {
        const accountOwnerId = getAccountOwnerId(request);
        const policy = await getQuoteTemplatePolicy(accountOwnerId);
        const requestedMode = QUOTE_TEMPLATE_MODES.has(request.body?.quoteTemplateMode) ? request.body.quoteTemplateMode : "integrated";
        const mode = policy === "integrated_only" ? "integrated" : policy === "external_only" ? "external" : requestedMode;
        const removeTemplate = String(request.body?.removeQuoteTemplate || "") === "true";
        const template = request.file;
        const templateConfig = sanitizeDocumentTemplate(request.body, { primaryColor: "#172033" });
        if (template) await validateCompanyTemplate(template.buffer, template.mimetype);
        if (policy === "integrated_only" && template) return response.status(403).json({ message: "Le Créateur n’autorise pas de base externe pour les devis et factures de cette entreprise." });
        const { rows } = await getPool().query(
            "SELECT quote_template_data IS NOT NULL AS \"hasQuoteTemplate\" FROM depannhome_billing_profiles WHERE owner_id = $1",
            [accountOwnerId]
        );
        const hasExistingTemplate = Boolean(rows[0]?.hasQuoteTemplate);
        if (mode === "external" && !template && (removeTemplate || !hasExistingTemplate)) {
            return response.status(400).json({ message: "Déposez un gabarit PDF ou DOCX commun aux devis et factures avant d’activer ce mode." });
        }
        await getPool().query(`
            INSERT INTO depannhome_billing_profiles (owner_id, quote_template_mode, quote_template_config, quote_template_filename, quote_template_data, quote_template_mime_type)
            VALUES ($1, $2, $3::jsonb, $4, $5, $6)
            ON CONFLICT (owner_id) DO UPDATE SET
                quote_template_mode = EXCLUDED.quote_template_mode,
                quote_template_config = EXCLUDED.quote_template_config,
                quote_template_filename = CASE WHEN $7 THEN '' WHEN $8 THEN EXCLUDED.quote_template_filename ELSE depannhome_billing_profiles.quote_template_filename END,
                quote_template_data = CASE WHEN $7 THEN NULL WHEN $8 THEN EXCLUDED.quote_template_data ELSE depannhome_billing_profiles.quote_template_data END,
                quote_template_mime_type = CASE WHEN $7 THEN '' WHEN $8 THEN EXCLUDED.quote_template_mime_type ELSE depannhome_billing_profiles.quote_template_mime_type END,
                updated_at = NOW()
        `, [accountOwnerId, mode, JSON.stringify(templateConfig), cleanFileName(template?.originalname), template?.buffer || null, template?.mimetype || "", removeTemplate, Boolean(template)]);
        response.status(204).end();
    }));

    app.get("/api/billing/quote-template/preview", requireAuthentication, requireBillingAdministration, asyncHandler(async (request, response) => {
        const ownerId = getAccountOwnerId(request);
        const profile = await loadBillingPdfProfile(ownerId);
        const documentType = request.query.type === "invoice" ? "invoice" : "quote";
        const document = { documentType, documentNumber: "APERÇU", creatorName: request.user.fullName || request.user.username || "Nom du collaborateur", customerName: "Nom du client", customerAddress: "Adresse du client", issueDate: new Date().toISOString().slice(0, 10), dueDate: documentType === "invoice" ? new Date().toISOString().slice(0, 10) : "", quoteReference: documentType === "invoice" ? "DEV-APERÇU" : "", lines: [{ description: "Exemple de prestation", quantity: 1, unit: "forfait", unitPrice: 120, vatRate: 20 }], notes: profile.paymentTerms || "Conditions de règlement" };
        const output = await createBillingDocumentOutput(document, profile);
        response.set({ "Content-Type": output.mimeType, "Content-Disposition": `${output.mimeType === PDF_MIME ? "inline" : "attachment"}; filename="${contentDispositionFileName(output.filename)}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
        response.send(output.buffer);
    }));

    app.get("/api/billing/quote-template/file", requireAuthentication, requireBillingAdministration, asyncHandler(async (request, response) => {
        if (await getQuoteTemplatePolicy(getAccountOwnerId(request)) === "integrated_only") return response.status(403).json({ message: "Le téléchargement de la base externe des devis et factures n’est pas autorisé pour cette entreprise." });
        const { rows } = await getPool().query(`
            SELECT quote_template_filename AS "filename", quote_template_data AS "data", quote_template_mime_type AS "mimeType"
            FROM depannhome_billing_profiles WHERE owner_id = $1
        `, [getAccountOwnerId(request)]);
        const template = rows[0];
        if (!template?.data) return response.status(404).json({ message: "Aucune base commune aux devis et factures n’est déposée." });
        response.set({
            "Content-Type": template.mimeType || "application/octet-stream",
            "Content-Disposition": `attachment; filename="${contentDispositionFileName(template.filename || "base-devis")}"`,
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff"
        });
        response.send(template.data);
    }));

    app.put("/api/billing/document-templates/:templateType", requireAuthentication, requireBillingAdministration, quoteTemplateUpload.single("documentTemplate"), asyncHandler(async (request, response) => {
        const definition = ADDITIONAL_TEMPLATE_TYPES[request.params.templateType];
        if (!definition) return response.status(404).json({ message: "Type de base documentaire inconnu." });
        const ownerId = getAccountOwnerId(request); const policy = await getTemplatePolicy(ownerId, definition); const requestedMode = QUOTE_TEMPLATE_MODES.has(request.body?.templateMode) ? request.body.templateMode : "integrated";
        const mode = policy === "integrated_only" ? "integrated" : policy === "external_only" ? "external" : requestedMode; const removeTemplate = String(request.body?.removeTemplate || "") === "true"; const template = request.file; const templateConfig = sanitizeDocumentTemplate(request.body, request.params.templateType === "quitus" ? { primaryColor: "#003b73" } : {});
        if (template) await validateCompanyTemplate(template.buffer, template.mimetype);
        if (policy === "integrated_only" && template) return response.status(403).json({ message: `Le Créateur n’autorise pas de base de ${definition.label} externe pour cette entreprise.` });
        const current = await getPool().query(`SELECT ${definition.dataColumn} IS NOT NULL AS "hasTemplate" FROM depannhome_billing_profiles WHERE owner_id=$1`, [ownerId]);
        if (mode === "external" && !template && (removeTemplate || !current.rows[0]?.hasTemplate)) return response.status(400).json({ message: `Déposez un gabarit de ${definition.label} PDF ou DOCX avant d’activer ce mode.` });
        const configColumn = request.params.templateType === "quitus" ? "quitus_template" : "report_template";
        await getPool().query(`INSERT INTO depannhome_billing_profiles (owner_id,${definition.modeColumn},${configColumn},${definition.filenameColumn},${definition.dataColumn},${definition.mimeColumn}) VALUES ($1,$2,$3::jsonb,$4,$5,$6) ON CONFLICT(owner_id) DO UPDATE SET ${definition.modeColumn}=EXCLUDED.${definition.modeColumn},${configColumn}=CASE WHEN $9 THEN EXCLUDED.${configColumn} ELSE depannhome_billing_profiles.${configColumn} END,${definition.filenameColumn}=CASE WHEN $7 THEN '' WHEN $8 THEN EXCLUDED.${definition.filenameColumn} ELSE depannhome_billing_profiles.${definition.filenameColumn} END,${definition.dataColumn}=CASE WHEN $7 THEN NULL WHEN $8 THEN EXCLUDED.${definition.dataColumn} ELSE depannhome_billing_profiles.${definition.dataColumn} END,${definition.mimeColumn}=CASE WHEN $7 THEN '' WHEN $8 THEN EXCLUDED.${definition.mimeColumn} ELSE depannhome_billing_profiles.${definition.mimeColumn} END,updated_at=NOW()`, [ownerId, mode, JSON.stringify(templateConfig), cleanFileName(template?.originalname || `base-${definition.label}`), template?.buffer || null, template?.mimetype || "", removeTemplate, Boolean(template), request.params.templateType === "quitus"]);
        response.status(204).end();
    }));

    app.get("/api/billing/document-templates/:templateType/file", requireAuthentication, requireBillingAdministration, asyncHandler(async (request, response) => {
        const definition = ADDITIONAL_TEMPLATE_TYPES[request.params.templateType];
        if (!definition) return response.status(404).json({ message: "Type de base documentaire inconnu." });
        if (await getTemplatePolicy(getAccountOwnerId(request), definition) === "integrated_only") return response.status(403).json({ message: `Le téléchargement d’une base de ${definition.label} externe n’est pas autorisé pour cette entreprise.` });
        const { rows } = await getPool().query(`SELECT ${definition.filenameColumn} AS filename,${definition.dataColumn} AS data,${definition.mimeColumn} AS "mimeType" FROM depannhome_billing_profiles WHERE owner_id=$1`, [getAccountOwnerId(request)]); const template = rows[0];
        if (!template?.data) return response.status(404).json({ message: `Aucune base de ${definition.label} déposée.` });
        response.set({ "Content-Type": template.mimeType || "application/octet-stream", "Content-Disposition": `attachment; filename="${contentDispositionFileName(template.filename || `base-${definition.label}`)}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" }); response.send(template.data);
    }));

    app.get("/api/billing/document-templates/:templateType/preview", requireAuthentication, requireBillingAdministration, asyncHandler(async (request, response) => {
        const definition = ADDITIONAL_TEMPLATE_TYPES[request.params.templateType];
        if (!definition) return response.status(404).json({ message: "Type de base documentaire inconnu." });
        const ownerId = getAccountOwnerId(request);
        const preview = request.params.templateType === "quitus"
            ? await createQuitusPreview(ownerId)
            : await createReportPreview(ownerId);
        response.set({
            "Content-Type": preview.mimeType,
            "Content-Disposition": `${preview.mimeType === PDF_MIME ? "inline" : "attachment"}; filename="${contentDispositionFileName(preview.filename)}"`,
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff"
        });
        response.send(preview.buffer);
    }));

    app.get("/api/billing/blank-quote/pdf", requireAuthentication, requireBillingAdministration, asyncHandler(async (request, response) => {
        const profile = await loadBillingPdfProfile(getAccountOwnerId(request));
        const document = {
            documentType: "quote",
            documentNumber: "APERÇU",
            creatorName: request.user.fullName || request.user.username || "Nom du collaborateur",
            customerName: "",
            customerAddress: "",
            issueDate: new Date().toISOString().slice(0, 10),
            dueDate: "",
            lines: [],
            notes: profile.paymentTerms || ""
        };
        const output = await createBillingDocumentOutput(document, profile);
        response.set({
            "Content-Type": output.mimeType,
            "Content-Disposition": `${output.mimeType === PDF_MIME ? "inline" : "attachment"}; filename="${contentDispositionFileName(output.filename)}"`,
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff"
        });
        response.send(output.buffer);
    }));

    app.get("/api/billing/documents/:documentId", requireAuthentication, asyncHandler(async (request, response) => {
        const id = positiveId(request.params.documentId);
        if (!id) return response.status(400).json({ message: "Document invalide." });
        const database = getPool();
        const [documentResult, profileResult] = await Promise.all([
            database.query(`
                SELECT id, document_type AS "documentType", document_number AS "documentNumber", client_id AS "clientId", customer_type AS "customerType",
                    customer_name AS "customerName", customer_address AS "customerAddress", created_by_name AS "creatorName", TO_CHAR(issue_date, 'YYYY-MM-DD') AS "issueDate",
                    TO_CHAR(due_date, 'YYYY-MM-DD') AS "dueDate", status, is_email_sent AS "isEmailSent", sent_at AS "sentAt", is_accounted AS "isAccounted",
                    TO_CHAR(accounted_at, 'YYYY-MM-DD') AS "accountedAt", appointment_id AS "appointmentId", source_quote_id AS "sourceQuoteId", correction_source_id AS "correctionSourceId", correction_kind AS "correctionKind", (SELECT source.document_number FROM depannhome_billing_documents source WHERE source.id=depannhome_billing_documents.correction_source_id) AS "correctionSourceNumber", quote_reference AS "quoteReference", vat_regime AS "vatRegime", issuer_tax_number AS "issuerTaxNumber", legal_data AS "legalData", issued_at AS "issuedAt", (structured_data IS NOT NULL) AS "hasStructuredData", lines, notes, financial_data AS "financialData"
                                FROM depannhome_billing_documents
                                WHERE id = $1 AND owner_id = $2
                                    AND ($3 <> 'technician'
                                        OR created_by = $4
                                        OR EXISTS (
                                                SELECT 1 FROM depannhome_calendar_events appointment
                                                WHERE appointment.id = depannhome_billing_documents.appointment_id
                                                    AND appointment.owner_id = $2
                                                    AND EXISTS (SELECT 1 FROM depannhome_calendar_assignments assignment WHERE assignment.event_id = appointment.id AND assignment.technician_id = $4)
                                                  )
                                                  OR EXISTS (
                                                    SELECT 1
                                                    FROM depannhome_billing_documents source_quote
                                                    LEFT JOIN depannhome_calendar_events quote_appointment ON quote_appointment.id = source_quote.appointment_id
                                                    WHERE source_quote.id = depannhome_billing_documents.source_quote_id
                                                      AND source_quote.owner_id = $2
                                                      AND (source_quote.created_by = $4 OR EXISTS (SELECT 1 FROM depannhome_calendar_assignments assignment WHERE assignment.event_id = quote_appointment.id AND assignment.technician_id = $4))
                                                  ))
                        `, [id, getAccountOwnerId(request), request.user?.role || "", request.user?.sub || 0]),
            database.query(`
                SELECT company_name AS "companyName", legal_form AS "legalForm", address, postal_code AS "postalCode", city, phone, email,
                    registration_number AS "registrationNumber", siren, tax_number AS "taxNumber", vat_regime AS "vatRegime", bank_iban AS "bankIban", bank_bic AS "bankBic", payment_terms AS "paymentTerms",
                    deposit_terms AS "depositTerms", early_payment_discount_terms AS "earlyPaymentDiscountTerms", late_payment_penalty_terms AS "latePaymentPenaltyTerms", recovery_indemnity_cents AS "recoveryIndemnityCents", vat_on_debits AS "vatOnDebits", footer_note AS "footerNote", (logo_data IS NOT NULL) AS "hasLogo"
                FROM depannhome_billing_profiles WHERE owner_id = $1
            `, [getAccountOwnerId(request)])
        ]);
        if (!documentResult.rows[0]) return response.status(404).json({ message: "Document introuvable." });
        response.json({ document: documentResult.rows[0], profile: profileResult.rows[0] || emptyProfile() });
    }));

    app.get("/api/billing/documents/:documentId/pdf", requireAuthentication, asyncHandler(async (request, response) => {
        const billingExport = await getBillingExport(request);
        if (!billingExport) return response.status(404).json({ message: "Document introuvable." });
        let output;
        if (billingExport.document.issuedAt) {
            const archived = await getPool().query("SELECT pdf_data AS data FROM depannhome_billing_documents WHERE id=$1 AND owner_id=$2", [billingExport.document.id, getAccountOwnerId(request)]);
            if (!archived.rows[0]?.data) return response.status(409).json({ message: "L’archive PDF de ce document émis est indisponible. Aucune régénération depuis des données mutables n’est autorisée." });
            output = { buffer: archived.rows[0].data, filename: billingPdfFileName(billingExport.document), mimeType: PDF_MIME };
        } else output = await createBillingDocumentOutput(billingExport.document, billingExport.profile);
        response.set({
            "Content-Type": output.mimeType,
            "Content-Disposition": `${output.mimeType === PDF_MIME ? "inline" : "attachment"}; filename="${contentDispositionFileName(output.filename)}"`,
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff"
        });
        response.send(output.buffer);
    }));

    app.get("/api/billing/documents/:documentId/ubl", requireAuthentication, asyncHandler(async (request, response) => {
        const billingExport = await getBillingExport(request);
        if (!billingExport) return response.status(404).json({ message: "Document introuvable." });
        const document = billingExport.document;
        if (!["invoice", "credit"].includes(document.documentType) || !document.issuedAt) {
            return response.status(409).json({ message: "L’export UBL est réservé aux factures et avoirs émis, hors brouillon." });
        }
        const archived = await getPool().query("SELECT structured_data AS data, structured_mime_type AS \"mimeType\" FROM depannhome_billing_documents WHERE id=$1 AND owner_id=$2", [document.id, getAccountOwnerId(request)]);
        const data = archived.rows[0]?.data;
        if (!data) return response.status(409).json({ message: "L’archive UBL de ce document émis est indisponible." });
        response.set({
            "Content-Type": archived.rows[0]?.mimeType || "application/xml; charset=utf-8",
            "Content-Disposition": `attachment; filename="${contentDispositionFileName(ublFileName(document))}"`,
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "X-Structured-Invoice-Source": "archived"
        });
        response.send(data);
    }));

    app.post("/api/billing/documents/preview", requireAuthentication, requireTechnicianBillingAccess, requireDesktopBillingPreview, asyncHandler(async (request, response) => {
        const document = sanitizeDocumentPreview(request.body);
        if (!document.ok) return response.status(400).json({ message: document.message });
        const profile = await loadBillingPdfProfile(getAccountOwnerId(request));
        document.vatRegime = normalizeVatRegime(request.body?.vatRegime || profile.vatRegime);
        document.issuerTaxNumber = cleanText(request.body?.issuerTaxNumber, 100) || profile.taxNumber || "";
        document.quoteReference = cleanText(request.body?.quoteReference, 80);
        document.creatorName = cleanText(request.user.fullName || request.user.username, 160);
        document.lines = applyVatRegime(document.lines, document.vatRegime);
        const output = await createBillingDocumentOutput(document, profile);
        response.set({ "Content-Type": PDF_MIME, "Content-Disposition": "inline", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "X-Billing-Preview-Mode": "final" });
        response.send(output.buffer);
    }));

    app.post("/api/billing/documents/:documentId/email", requireAuthentication, requireTechnicianBillingAccess, asyncHandler(async (request, response) => {
        const recipient = sanitizeEmailRecipient(request.body?.recipient);
        if (!recipient) return response.status(400).json({ message: "L’adresse e-mail du destinataire est invalide." });
        let billingExport = await getBillingExport(request);
        if (!billingExport) return response.status(404).json({ message: "Document introuvable." });
        if (billingExport.document.documentType === "invoice" && !billingExport.document.issuedAt) {
            if (request.user?.role !== "admin") return response.status(409).json({ message: "Cette facture est encore un brouillon. Un administrateur doit d’abord l’émettre définitivement." });
            await issueDocument({ ownerId: getAccountOwnerId(request), documentId: billingExport.document.id, actorId: request.user.sub });
            billingExport = await getBillingExport(request);
        }
        let output;
        if (billingExport.document.issuedAt) {
            const archived = await getPool().query("SELECT pdf_data AS data FROM depannhome_billing_documents WHERE id=$1 AND owner_id=$2", [billingExport.document.id, getAccountOwnerId(request)]);
            if (!archived.rows[0]?.data) return response.status(409).json({ message: "L’archive PDF de cette facture émise est indisponible." });
            output = { buffer: archived.rows[0].data, filename: billingPdfFileName(billingExport.document), mimeType: PDF_MIME };
        } else output = await createBillingDocumentOutput(billingExport.document, billingExport.profile);
        const type = billingExport.document.documentType === "invoice" ? "Facture" : "Devis";
        const database = await getPool().connect();
        try {
            await database.query("BEGIN");
            const locked = await database.query("SELECT document_type AS \"documentType\" FROM depannhome_billing_documents WHERE id=$1 AND owner_id=$2 FOR UPDATE", [billingExport.document.id, getAccountOwnerId(request)]);
            if (!locked.rows[0]) { await database.query("ROLLBACK"); return response.status(404).json({ message: "Document introuvable." }); }
            await sendDocumentEmail({ recipient, recipientName: billingExport.document.customerName, documentLabel: `${type} ${billingExport.document.documentNumber}`, attachment: { filename: output.filename, content: output.buffer, contentType: output.mimeType } });
            if (locked.rows[0].documentType === "invoice") await database.query("UPDATE depannhome_billing_documents SET is_email_sent=TRUE, sent_at=COALESCE(sent_at,NOW()), status='sent', updated_at=NOW() WHERE id=$1", [billingExport.document.id]);
        } catch (error) {
            await database.query("ROLLBACK");
            throw error;
        } finally {
            database.release();
        }
        response.json({ message: `${type} envoyé(e) par e-mail.`, isEmailSent: billingExport.document.documentType === "invoice" });
    }));

    app.post("/api/billing/documents/:documentId/issue", requireAuthentication, requireBillingIssuanceAccess, asyncHandler(async (request, response) => {
        const documentId = positiveId(request.params.documentId);
        if (!documentId) return response.status(400).json({ message: "Document invalide." });
        if (!await findAccessibleBillingDocument(getPool(), getAccountOwnerId(request), documentId, request)) return response.status(404).json({ message: "Facture introuvable ou intervention non attribuée à ce poste." });
        const result = await issueDocument({ ownerId: getAccountOwnerId(request), documentId, actorId: request.user.sub });
        response.status(result.alreadyIssued ? 200 : 201).json(result);
    }));

    app.post("/api/billing/documents/:documentId/settlements", requireAuthentication, requireBillingSettlementAccess, asyncHandler(async (request, response) => {
        const documentId = positiveId(request.params.documentId);
        if (!documentId) return response.status(400).json({ message: "Facture invalide." });
        if (!await findAccessibleBillingDocument(getPool(), getAccountOwnerId(request), documentId, request)) return response.status(404).json({ message: "Facture introuvable ou intervention non attribuée à ce poste." });
        const { recordInvoiceSettlement } = await import("./accounting.js");
        const result = await recordInvoiceSettlement({ ownerId: getAccountOwnerId(request), actorId: request.user.sub, input: { ...request.body, documentId } });
        response.status(201).json(result);
    }));

    app.put("/api/billing/default-quote", requireAuthentication, requireBillingAdministration, asyncHandler(async (request, response) => {
        const quote = sanitizeQuoteTemplate(request.body);
        if (!quote.ok) return response.status(400).json({ message: quote.message });
        const taxIdentity = await billingTaxIdentity(getAccountOwnerId(request));
        if (quote.template) quote.template.lines = applyVatRegime(quote.template.lines, taxIdentity.vatRegime);
        await getPool().query(`
            INSERT INTO depannhome_billing_profiles (owner_id, default_quote)
            VALUES ($1, $2::jsonb)
            ON CONFLICT (owner_id) DO UPDATE SET default_quote = EXCLUDED.default_quote, updated_at = NOW()
        `, [getAccountOwnerId(request), JSON.stringify(quote.template)]);
        response.status(204).end();
    }));

    app.post("/api/billing/templates", requireAuthentication, requireBillingTemplateCreation, asyncHandler(async (request, response) => {
        const template = sanitizeTemplate(request.body);
        if (!template.ok) return response.status(400).json({ message: template.message });
        const taxIdentity = await billingTaxIdentity(getAccountOwnerId(request));
        if (taxIdentity.vatRegime === "franchise") template.vatRate = 0;
        const { rows } = await getPool().query(`
            INSERT INTO depannhome_billing_templates (owner_id, label, description, unit, unit_price, vat_rate)
            VALUES ($1,$2,$3,$4,$5,$6)
            RETURNING id, label, description, unit, unit_price::float AS "unitPrice", vat_rate::float AS "vatRate"
        `, [getAccountOwnerId(request), template.label, template.description, template.unit, template.unitPrice, template.vatRate]);
        response.status(201).json({ template: rows[0] });
    }));

    app.delete("/api/billing/templates/:templateId", requireAuthentication, requireBillingAdministration, asyncHandler(async (request, response) => {
        const id = positiveId(request.params.templateId);
        if (!id) return response.status(400).json({ message: "Ligne modèle invalide." });
        const result = await getPool().query("DELETE FROM depannhome_billing_templates WHERE id = $1 AND owner_id = $2", [id, getAccountOwnerId(request)]);
        if (!result.rowCount) return response.status(404).json({ message: "Ligne modèle introuvable." });
        response.status(204).end();
    }));

    app.post("/api/billing/documents", requireAuthentication, requireTechnicianBillingAccess, asyncHandler(async (request, response) => {
        const document = sanitizeDocument(request.body);
        if (!document.ok) return response.status(400).json({ message: document.message });
        if (request.user?.role === "technician" && !document.appointmentId) {
            return response.status(403).json({ message: "Les techniciens peuvent créer un devis ou une facture uniquement depuis une intervention qui leur est attribuée." });
        }
        try {
            if (document.clientId && !await hasClient(getPool(), getAccountOwnerId(request), document.clientId, true)) {
                return response.status(400).json({ message: "Le dossier client associé est introuvable ou archivé." });
            }
            const appointment = await findAccessibleAppointment(getPool(), getAccountOwnerId(request), document.appointmentId, request);
            if (document.appointmentId && !appointment) return response.status(400).json({ message: "Le rendez-vous associé est introuvable ou n’est pas accessible." });
            const sourceQuote = await findSourceQuote(getPool(), getAccountOwnerId(request), document.sourceQuoteId, request);
            if (document.sourceQuoteId && !sourceQuote) return response.status(400).json({ message: "Le devis de référence est introuvable." });
            if (document.documentType === "invoice" && sourceQuote && await hasInvoiceForQuote(getPool(), getAccountOwnerId(request), sourceQuote.id)) {
                return response.status(409).json({ message: "Une facture existe déjà pour ce devis." });
            }
            const taxIdentity = sourceQuote?.vatRegime ? { vatRegime: normalizeVatRegime(sourceQuote.vatRegime), taxNumber: sourceQuote.issuerTaxNumber || "" } : await billingTaxIdentity(getAccountOwnerId(request));
            const documentNumber = document.documentType === "invoice" ? draftInvoiceReference() : document.documentNumber;
            const status = document.documentType === "invoice" ? "draft" : document.status;
            document.lines = applyVatRegime(document.lines, taxIdentity.vatRegime);
            const { rows } = await getPool().query(`
                INSERT INTO depannhome_billing_documents
                    (owner_id, created_by, document_type, document_number, client_id, customer_type, customer_name, customer_address, issue_date, due_date, status, is_accounted, accounted_at, appointment_id, source_quote_id, quote_reference, vat_regime, issuer_tax_number, lines, legal_data, issued_at, notes, financial_data, created_by_name)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10::date,$11,FALSE,NULL,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,NULL,$19,$20::jsonb,$21)
                RETURNING id, document_number AS "documentNumber"
            `, [getAccountOwnerId(request), request.user.sub, document.documentType, documentNumber, document.clientId || null, document.customerType, document.customerName,
                document.customerAddress, document.issueDate, document.dueDate || null, status, appointment?.id || null, sourceQuote?.id || null, sourceQuote?.documentNumber || "", taxIdentity.vatRegime, taxIdentity.taxNumber, JSON.stringify(document.lines), JSON.stringify(document.legalData), document.notes, JSON.stringify(document.financialData), cleanText(request.user.fullName || request.user.username, 160)]);
            await (await import("./partner-connections.js")).synchronizeConnectedBillingDocument(getAccountOwnerId(request), rows[0].id);
            const { registerMissionSourceItem } = await import("./partner-dialogue.js"); await registerMissionSourceItem({ ownerId: getAccountOwnerId(request), appointmentId: appointment?.id, sourceType: document.documentType, sourceId: rows[0].id, label: rows[0].documentNumber, details: { status, issueDate: document.issueDate } });
            const { recordMissionEventForSource } = await import("./partner-dialogue.js"); await recordMissionEventForSource({ ownerId: getAccountOwnerId(request), sourceType: "appointment", sourceId: appointment?.id, status: document.documentType === "invoice" ? "invoice_created" : "quote_created", action: "billing_document_created", details: { documentId: rows[0].id, documentType: document.documentType, status }, actorName: request.user.fullName || request.user.username });
            response.status(201).json({ id: rows[0].id, documentNumber: rows[0].documentNumber });
        } catch (error) {
            if (error.code === "23505") return response.status(409).json({ message: "Ce numéro de document existe déjà dans votre compte." });
            throw error;
        }
    }));

    app.put("/api/billing/documents/:documentId", requireAuthentication, requireBillingDocumentAdministration, asyncHandler(async (request, response) => {
        const id = positiveId(request.params.documentId);
        const document = sanitizeDocument(request.body);
        if (!id) return response.status(400).json({ message: "Document invalide." });
        if (!document.ok) return response.status(400).json({ message: document.message });
        if (request.user?.role === "technician" && !await findAccessibleBillingDocument(getPool(), getAccountOwnerId(request), id, request)) return response.status(404).json({ message: "Document introuvable ou intervention non attribuée à ce poste." });
        try {
            if (document.clientId && !await hasClient(getPool(), getAccountOwnerId(request), document.clientId)) {
                return response.status(400).json({ message: "Le dossier client associé est introuvable." });
            }
            const storedTaxIdentity = await documentTaxIdentity(getAccountOwnerId(request), id);
            if (!storedTaxIdentity) return response.status(404).json({ message: "Document introuvable." });
            const appointment = await findAccessibleAppointment(getPool(), getAccountOwnerId(request), document.appointmentId, request);
            if (document.appointmentId && !appointment) return response.status(400).json({ message: "Le rendez-vous associé est introuvable ou n’est pas accessible." });
            const sourceQuote = await findSourceQuote(getPool(), getAccountOwnerId(request), document.sourceQuoteId, request);
            if (document.sourceQuoteId && !sourceQuote) return response.status(400).json({ message: "Le devis de référence est introuvable." });
            if (document.documentType === "invoice" && !storedTaxIdentity.correctionSourceId && sourceQuote && await hasInvoiceForQuote(getPool(), getAccountOwnerId(request), sourceQuote.id, id)) {
                return response.status(409).json({ message: "Une facture existe déjà pour ce devis." });
            }
            document.lines = applyVatRegime(document.lines, storedTaxIdentity.vatRegime);
            const documentNumber = document.documentType === "invoice" ? (storedTaxIdentity.documentType === "invoice" ? storedTaxIdentity.documentNumber : draftInvoiceReference()) : document.documentNumber;
            const status = document.documentType === "invoice" ? "draft" : document.status;
            const result = await getPool().query(`
                UPDATE depannhome_billing_documents SET document_type=$3, document_number=$4, client_id=$5, customer_type=$6, customer_name=$7,
                    customer_address=$8, issue_date=$9::date, due_date=$10::date, status=$11, is_accounted=FALSE,
                    accounted_at=NULL, appointment_id=$12, source_quote_id=$13, quote_reference=$14, legal_data=$15::jsonb,
                    lines=$16::jsonb, notes=$17, financial_data=$18::jsonb, updated_at=NOW()
                WHERE id=$1 AND owner_id=$2 AND issued_at IS NULL AND is_accounted=FALSE
                    AND NOT EXISTS (SELECT 1 FROM depannhome_accounting_entries entry WHERE entry.owner_id=$2 AND entry.source_type IN ('invoice','credit') AND entry.source_id=id::text)
            `, [id, getAccountOwnerId(request), document.documentType, documentNumber, document.clientId || null, document.customerType, document.customerName,
                document.customerAddress, document.issueDate, document.dueDate || null, status, appointment?.id || null, sourceQuote?.id || null, sourceQuote?.documentNumber || "", JSON.stringify(document.legalData), JSON.stringify(document.lines), document.notes, JSON.stringify(document.financialData)]);
            if (!result.rowCount) return response.status(409).json({ message: "Un document émis ou comptabilisé est immuable. Créez une facture rectificative, un avenant ou un avoir." });
            await (await import("./partner-connections.js")).synchronizeConnectedBillingDocument(getAccountOwnerId(request), id);
            const { registerMissionSourceItem } = await import("./partner-dialogue.js"); await registerMissionSourceItem({ ownerId: getAccountOwnerId(request), appointmentId: appointment?.id, sourceType: document.documentType, sourceId: id, label: documentNumber, details: { status, issueDate: document.issueDate } });
            const { recordMissionEventForSource } = await import("./partner-dialogue.js"); await recordMissionEventForSource({ ownerId: getAccountOwnerId(request), sourceType: "appointment", sourceId: appointment?.id, status: document.documentType === "invoice" ? "invoice_created" : "quote_sent", action: "billing_document_updated", details: { documentId: id, documentType: document.documentType, status }, actorName: request.user.fullName || request.user.username });
            response.status(204).end();
        } catch (error) {
            if (error.code === "23505") return response.status(409).json({ message: "Ce numéro de document existe déjà dans votre compte." });
            throw error;
        }
    }));

    app.post("/api/billing/documents/:documentId/corrections", requireAuthentication, requireBillingDocumentAdministration, asyncHandler(async (request, response) => {
        const id = positiveId(request.params.documentId);
        const kind = request.body?.kind === "replacement" || request.body?.kind === "amendment" ? request.body.kind : "";
        if (!id || !kind) return response.status(400).json({ message: "Type de correction invalide." });
        const database = await getPool().connect();
        try {
            await database.query("BEGIN");
            const { rows } = await database.query(`
                SELECT document.*, EXISTS (SELECT 1 FROM depannhome_accounting_entries entry WHERE entry.owner_id=document.owner_id AND entry.source_type IN ('invoice','credit') AND entry.source_id=document.id::text) AS has_entry,
                    EXISTS (SELECT 1 FROM depannhome_accounting_settlements settlement WHERE settlement.owner_id=document.owner_id AND settlement.document_id=document.id) AS has_settlement
                FROM depannhome_billing_documents document WHERE document.id=$1 AND document.owner_id=$2 FOR UPDATE
            `, [id, getAccountOwnerId(request)]);
            const source = rows[0];
            if (!source) { await database.query("ROLLBACK"); return response.status(404).json({ message: "Facture introuvable." }); }
            if (source.document_type !== "invoice" || !source.issued_at) { await database.query("ROLLBACK"); return response.status(409).json({ message: "Seule une facture définitivement émise peut servir de base à cette correction." }); }
            if (source.is_accounted || source.has_entry || source.has_settlement) { await database.query("ROLLBACK"); return response.status(409).json({ message: "Cette facture est comptabilisée ou réglée. Créez obligatoirement un avoir comptable." }); }
            if (String(source.status).toLowerCase() === "cancelled") { await database.query("ROLLBACK"); return response.status(409).json({ message: "Cette facture a déjà été annulée et remplacée." }); }
            const documentNumber = draftInvoiceReference();
            const created = await database.query(`
                INSERT INTO depannhome_billing_documents
                    (owner_id,created_by,document_type,document_number,client_id,customer_type,customer_name,customer_address,issue_date,due_date,status,is_email_sent,sent_at,is_accounted,accounted_at,appointment_id,source_quote_id,correction_source_id,correction_kind,quote_reference,vat_regime,issuer_tax_number,lines,legal_data,notes,financial_data,created_by_name)
                VALUES ($1,$2,'invoice',$3,$4,$5,$6,$7,CURRENT_DATE,$8,'draft',FALSE,NULL,FALSE,NULL,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
                RETURNING id
            `, [source.owner_id, request.user.sub, documentNumber, source.client_id, source.customer_type, source.customer_name, source.customer_address, source.due_date, source.appointment_id, source.source_quote_id, source.id, kind, source.quote_reference, source.vat_regime, source.issuer_tax_number, source.lines, source.legal_data, source.notes, source.financial_data, cleanText(request.user.fullName || request.user.username, 160)]);
            await database.query("UPDATE depannhome_billing_documents SET status='cancelled', updated_at=NOW() WHERE id=$1", [source.id]);
            await database.query("COMMIT");
            response.status(201).json({ id: created.rows[0].id, documentNumber });
        } catch (error) {
            await database.query("ROLLBACK");
            if (error.code === "23505") return response.status(409).json({ message: "Le numéro de correction existe déjà. Rechargez le registre puis réessayez." });
            throw error;
        } finally {
            database.release();
        }
    }));

    app.patch("/api/billing/documents/:documentId/accounting", requireAuthentication, requireBillingAdministration, asyncHandler(async (request, response) => {
        const id = positiveId(request.params.documentId);
        if (!id || typeof request.body?.isAccounted !== "boolean") return response.status(400).json({ message: "Statut comptable invalide." });
        if (!request.body.isAccounted) return response.status(409).json({ message: "Une écriture validée ne peut pas être décomptabilisée. Utilisez un avoir ou une écriture corrective." });
        const result = await postAccountingDocument({ ownerId: getAccountOwnerId(request), documentId: id, actorId: request.user.sub });
        response.json(result);
    }));

    app.delete("/api/billing/documents/:documentId", requireAuthentication, requireBillingAdministration, asyncHandler(async (request, response) => {
        const id = positiveId(request.params.documentId);
        if (!id) return response.status(400).json({ message: "Document invalide." });
        response.status(409).json({ message: "Les devis, factures et avoirs sont conservés et ne peuvent pas être supprimés." });
    }));
}

export async function issueDocument({ ownerId, documentId, actorId, pool = getPool() }) {
    const database = await pool.connect();
    try {
        await database.query("BEGIN");
        const { rows } = await database.query(`
            SELECT document.id, document.owner_id AS "ownerId", document.document_type AS "documentType", document.document_number AS "documentNumber",
                document.client_id AS "clientId", document.customer_type AS "customerType", document.customer_name AS "customerName", document.customer_address AS "customerAddress",
                TO_CHAR(document.issue_date,'YYYY-MM-DD') AS "issueDate", TO_CHAR(document.due_date,'YYYY-MM-DD') AS "dueDate", document.status,
                document.appointment_id AS "appointmentId", document.source_quote_id AS "sourceQuoteId", document.correction_source_id AS "correctionSourceId",
                document.correction_kind AS "correctionKind", document.quote_reference AS "quoteReference", document.vat_regime AS "vatRegime",
                document.issuer_tax_number AS "issuerTaxNumber", document.legal_data AS "legalData", document.issued_at AS "issuedAt",
                document.created_by_name AS "creatorName",
                document.lines, document.notes, document.financial_data AS "financialData",
                (SELECT client.client_data FROM depannhome_clients client WHERE client.owner_id=document.owner_id AND client.client_id=document.client_id) AS "clientData"
            FROM depannhome_billing_documents document
            WHERE document.id=$1 AND document.owner_id=$2
            FOR UPDATE
        `, [documentId, ownerId]);
        const document = rows[0];
        if (!document) throw billingError(404, "Facture introuvable.");
        if (document.documentType !== "invoice") throw billingError(409, "Seule une facture brouillon peut être émise définitivement.");
        if (document.issuedAt) {
            await database.query("COMMIT");
            return { id: document.id, documentNumber: document.documentNumber, issuedAt: document.issuedAt, alreadyIssued: true };
        }
        if (String(document.status || "").toLowerCase() !== "draft") throw billingError(409, "La facture doit être enregistrée comme brouillon avant son émission définitive.");

        const profile = await loadBillingPdfProfile(ownerId, database);
        validateInvoiceForIssue(document, profile);
        const seriesYear = Number(String(document.issueDate).slice(0, 4));
        const documentNumber = await allocateBillingNumber(database, ownerId, "invoice", seriesYear);
        const finalDocument = { ...document, documentNumber, status: "issued" };
        const { structuredData, structuredSha256, pdfData, pdfSha256, legalSnapshot } = await buildBillingLegalArchive(finalDocument, { profile });
        const issued = await database.query(`
            UPDATE depannhome_billing_documents SET
                document_number=$3, status='issued', issued_at=NOW(), finalized_by=$4, legal_snapshot=$5::jsonb,
                structured_data=$6, structured_mime_type='application/xml; charset=utf-8', structured_sha256=$7,
                pdf_data=$8, pdf_sha256=$9, updated_at=NOW()
            WHERE id=$1 AND owner_id=$2 AND issued_at IS NULL
            RETURNING document_number AS "documentNumber", issued_at AS "issuedAt"
        `, [documentId, ownerId, documentNumber, actorId, JSON.stringify(legalSnapshot), structuredData, structuredSha256, pdfData, pdfSha256]);
        await database.query("COMMIT");
        return { id: documentId, documentNumber: issued.rows[0].documentNumber, issuedAt: issued.rows[0].issuedAt, alreadyIssued: false, hasStructuredData: true, hasPdfArchive: true };
    } catch (error) {
        await database.query("ROLLBACK");
        throw error;
    } finally {
        database.release();
    }
}

export async function buildBillingLegalArchive(document, { ownerId, database, profile } = {}) {
    const resolvedProfile = profile || await loadBillingPdfProfile(ownerId, database || getPool());
    const structuredData = generateUblInvoice(document, resolvedProfile);
    const pdfData = await createBillingPdf(document, resolvedProfile);
    return {
        legalSnapshot: buildLegalSnapshot(document, resolvedProfile),
        structuredData,
        structuredMimeType: "application/xml; charset=utf-8",
        structuredSha256: sha256(structuredData),
        pdfData,
        pdfSha256: sha256(pdfData)
    };
}

function validateInvoiceForIssue(document, profile) {
    const missing = [];
    const legal = document.legalData || {};
    if (!cleanText(profile.companyName, 160)) missing.push("nom de l’entreprise émettrice");
    if (!cleanText(profile.address, 255)) missing.push("adresse de l’entreprise émettrice");
    if (!cleanIdentifier(profile.registrationNumber, 20, true) && !cleanIdentifier(profile.siren, 20, true)) missing.push("SIRET ou SIREN de l’entreprise émettrice");
    if (!cleanText(document.customerName, 160)) missing.push("nom du client");
    if (!cleanText(legal.billingAddress || document.customerAddress, 500)) missing.push("adresse de facturation du client");
    if (!sanitizeDate(legal.serviceDate)) missing.push("date de livraison ou de prestation");
    if (!OPERATION_CATEGORIES.has(legal.operationCategory)) missing.push("catégorie d’opération");
    if (document.customerType === "Professionnel" && !cleanIdentifier(legal.customerSiren, 20, true)) missing.push("SIREN du client professionnel");
    if (missing.length) throw billingError(409, `Émission impossible : renseignez ${missing.join(", ")}.`);
}

function buildLegalSnapshot(document, profile) {
    return {
        document: {
            id: document.id, documentType: document.documentType, documentNumber: document.documentNumber, clientId: document.clientId,
            customerType: document.customerType, customerName: document.customerName, customerAddress: document.customerAddress,
            issueDate: document.issueDate, dueDate: document.dueDate, quoteReference: document.quoteReference, vatRegime: document.vatRegime,
            issuerTaxNumber: document.issuerTaxNumber, legalData: document.legalData, lines: document.lines, notes: document.notes,
            creatorName: document.creatorName,
            financialData: document.financialData, sourceInvoiceId: document.sourceInvoiceId, sourceInvoiceNumber: document.sourceInvoiceNumber,
            sourceInvoiceDate: document.sourceInvoiceDate, reason: document.reason
        },
        seller: {
            companyName: profile.companyName, legalForm: profile.legalForm, address: profile.address, postalCode: profile.postalCode, city: profile.city,
            country: profile.country, registrationNumber: profile.registrationNumber, siren: profile.siren, taxNumber: profile.taxNumber,
            vatRegime: profile.vatRegime, paymentTerms: profile.paymentTerms, earlyPaymentDiscountTerms: profile.earlyPaymentDiscountTerms,
            latePaymentPenaltyTerms: profile.latePaymentPenaltyTerms, recoveryIndemnityCents: profile.recoveryIndemnityCents, vatOnDebits: profile.vatOnDebits
        }
    };
}

function requireBillingAdministration(request, response, next) {
    if (request.user?.role === "admin") return next();
    return response.status(403).json({ message: request.user?.role === "accountant" ? "L’espace Facturation du comptable est en consultation uniquement." : "La modification des documents et paramètres de facturation n’est pas autorisée pour ce poste." });
}

export function canCreateBillingTemplates(user) {
    return user?.role !== "accountant" && (user?.deviceType === "desktop" || ["admin", "mobile_admin"].includes(user?.role));
}

function requireBillingTemplateCreation(request, response, next) {
    if (canCreateBillingTemplates(request.user)) return next();
    return response.status(403).json({ message: "Le préenregistrement des lignes est réservé aux postes PC et aux Administrateurs Mobile." });
}

async function requireBillingDocumentAdministration(request, response, next) {
    if (["admin", "mobile_admin"].includes(request.user?.role)) return next();
    if (request.user?.role === "technician") return requireTechnicianBillingAccess(request, response, next);
    return response.status(403).json({ message: request.user?.role === "accountant" ? "L’espace comptabilité est en consultation uniquement." : "Les techniciens peuvent créer des devis et factures, sans modifier les documents existants." });
}

async function requireBillingIssuanceAccess(request, response, next) {
    if (["admin", "mobile_admin"].includes(request.user?.role)) return next();
    if (request.user?.role !== "technician") return response.status(403).json({ message: "L’émission définitive d’une facture n’est pas autorisée pour ce poste." });
    return requireTechnicianBillingAccess(request, response, next);
}

async function requireBillingSettlementAccess(request, response, next) {
    if (["admin", "mobile_admin"].includes(request.user?.role) || request.user?.deviceType === "desktop") {
        if (request.user?.role === "accountant") return response.status(403).json({ message: "Le poste comptable en consultation ne peut pas enregistrer un règlement ici." });
        return next();
    }
    if (request.user?.role !== "technician") return response.status(403).json({ message: "L’enregistrement d’un règlement n’est pas autorisé pour ce poste." });
    return requireTechnicianBillingAccess(request, response, next);
}

export function requireBillingWorkspaceAccess(request, response, next) {
    if (hasBillingWorkspaceAccess(request.user)) return next();
    return response.status(403).json({ message: "L’accès à l’espace Facturation n’est pas autorisé pour ce poste PC ou n’est pas inclus dans l’offre active." });
}

async function requireTechnicianBillingAccess(request, response, next) {
    if (request.user?.role === "accountant") {
        return response.status(403).json({ message: "L’espace comptabilité est en consultation uniquement." });
    }
    if (request.user?.role !== "technician") return next();
    const { rows } = await getPool().query(
        "SELECT can_create_billing FROM depannhome_users WHERE id = $1",
        [request.user.sub]
    );
    if (rows[0]?.can_create_billing === false) {
        return response.status(403).json({ message: "Vous n’êtes pas autorisé à créer des devis et factures. Contactez votre administrateur." });
    }
    return next();
}

function requireDesktopBillingPreview(request, response, next) {
    if (request.user?.deviceType === "desktop") return next();
    return response.status(403).json({ message: "L’aperçu PDF en direct des devis et factures est réservé à un poste PC." });
}

export function billingUploadErrorHandler(error, request, response, next) {
    if (error instanceof multer.MulterError) return response.status(400).json({ message: ["quoteTemplate", "documentTemplate"].includes(error.field) ? "La base documentaire doit faire au maximum 10 Mo." : "Le logo doit faire au maximum 2 Mo." });
    if (error?.message === "Seules les images PNG, JPEG ou WebP sont acceptées.") return response.status(400).json({ message: error.message });
    if (error?.message === "Seuls les gabarits PDF et DOCX sont acceptés. Convertissez les anciens fichiers DOC en DOCX.") return response.status(400).json({ message: error.message });
    return next(error);
}

function emptyProfile() {
    return { companyName: "", legalForm: "", address: "", postalCode: "", city: "", phone: "", secondaryPhone: "", email: "", country: "France", registrationNumber: "", siren: "", taxNumber: "", vatRegime: "standard", bankIban: "", bankBic: "", paymentTerms: "", depositTerms: "", earlyPaymentDiscountTerms: DEFAULT_EARLY_PAYMENT_DISCOUNT_TERMS, latePaymentPenaltyTerms: DEFAULT_LATE_PAYMENT_PENALTY_TERMS, recoveryIndemnityCents: 4000, vatOnDebits: false, footerNote: "", defaultQuote: null, quoteTemplateConfig: { ...DEFAULT_DOCUMENT_TEMPLATE }, quoteTemplateMode: "integrated", quoteTemplateFilename: "", hasQuoteTemplate: false, quoteTemplatePolicy: "company_choice", quitusTemplate: { ...DEFAULT_DOCUMENT_TEMPLATE, primaryColor: "#003b73" }, quitusTemplateMode: "integrated", quitusTemplateFilename: "", hasQuitusTemplate: false, quitusTemplatePolicy: "company_choice", reportFileTemplateMode: "integrated", reportFileTemplateFilename: "", hasReportFileTemplate: false, reportTemplatePolicy: "company_choice", hasLogo: false };
}

async function getTemplatePolicy(ownerId, definition) { const { rows } = await getPool().query(`SELECT ${definition.policyColumn} AS policy FROM depannhome_users WHERE id=$1`, [ownerId]); return QUOTE_TEMPLATE_POLICIES.has(rows[0]?.policy) ? rows[0].policy : "company_choice"; }

async function getQuoteTemplatePolicy(accountOwnerId) {
    const { rows } = await getPool().query("SELECT quote_template_policy FROM depannhome_users WHERE id = $1", [accountOwnerId]);
    return QUOTE_TEMPLATE_POLICIES.has(rows[0]?.quote_template_policy) ? rows[0].quote_template_policy : "company_choice";
}

async function loadBillingPdfProfile(ownerId, database = getPool()) {
    const { rows } = await database.query(`SELECT owner.id AS "ownerId",profile.company_name AS "companyName",profile.legal_form AS "legalForm",profile.address,profile.postal_code AS "postalCode",profile.city,profile.phone,profile.email,profile.country,profile.registration_number AS "registrationNumber",profile.siren,profile.tax_number AS "taxNumber",profile.vat_regime AS "vatRegime",profile.bank_iban AS "bankIban",profile.bank_bic AS "bankBic",profile.payment_terms AS "paymentTerms",profile.deposit_terms AS "depositTerms",profile.early_payment_discount_terms AS "earlyPaymentDiscountTerms",profile.late_payment_penalty_terms AS "latePaymentPenaltyTerms",profile.recovery_indemnity_cents AS "recoveryIndemnityCents",profile.vat_on_debits AS "vatOnDebits",profile.footer_note AS "footerNote",profile.logo_data AS "logoData",profile.logo_mime_type AS "logoMimeType",profile.quote_template_config AS "quoteTemplateConfig",profile.quote_template_mode AS "quoteTemplateMode",profile.quote_template_filename AS "quoteTemplateFilename",profile.quote_template_data AS "quoteTemplateData",profile.quote_template_mime_type AS "quoteTemplateMimeType",owner.quote_template_policy AS "quoteTemplatePolicy" FROM depannhome_users owner LEFT JOIN depannhome_billing_profiles profile ON profile.owner_id=owner.id WHERE owner.id=$1`, [ownerId]);
    return { ...emptyProfile(), ...(rows[0] || {}) };
}

async function loadQuitusPdfProfile(ownerId) {
    const { rows } = await getPool().query(`SELECT owner.id AS "ownerId",profile.company_name AS "companyName",profile.address,profile.postal_code AS "postalCode",profile.city,profile.phone,profile.email,profile.registration_number AS "registrationNumber",profile.logo_data AS "logoData",profile.logo_mime_type AS "logoMimeType",profile.quitus_template AS "quitusTemplate",profile.quitus_template_mode AS "quitusTemplateMode",profile.quitus_template_filename AS "quitusTemplateFilename",profile.quitus_template_data AS "quitusTemplateData",profile.quitus_template_mime_type AS "quitusTemplateMimeType",owner.quitus_template_policy AS "quitusTemplatePolicy" FROM depannhome_users owner LEFT JOIN depannhome_billing_profiles profile ON profile.owner_id=owner.id WHERE owner.id=$1`, [ownerId]);
    return { ...emptyProfile(), ...(rows[0] || {}) };
}

function sanitizeDocumentTemplate(value, defaults = {}) {
    const template = { ...DEFAULT_DOCUMENT_TEMPLATE, ...defaults };
    for (const key of ["primaryColor", "secondaryColor", "separatorColor"]) if (/^#[0-9a-fA-F]{6}$/.test(String(value?.[key] || ""))) template[key] = String(value[key]).toLowerCase();
    template.font = DOCUMENT_TEMPLATE_FONTS.has(value?.font) ? value.font : template.font;
    template.headerText = cleanText(value?.headerText, 500);
    template.footerText = cleanText(value?.footerText, 500);
    return template;
}

async function createQuitusPreview(ownerId) {
    const profile = await loadQuitusPdfProfile(ownerId);
    const date = new Date().toISOString().slice(0, 10);
    return createQuitusDocumentOutput({
        id: "APERÇU",
        title: "Intervention de démonstration",
        clientName: "Nom du client",
        location: "Adresse de l’intervention",
        date,
        startTime: "09:00",
        endTime: "10:30",
        notes: "Compte rendu et observations de l’intervention."
    }, {
        signedBy: "Nom du client",
        performedByName: "Nom du technicien",
        signature: ""
    }, profile);
}

async function createReportPreview(ownerId) {
    const { rows } = await getPool().query(`
        SELECT owner.id AS "ownerId", profile.company_name AS "companyName", profile.address, profile.postal_code AS "postalCode", profile.city, profile.phone, profile.email,
            profile.registration_number AS "registrationNumber", profile.tax_number AS "taxNumber", profile.logo_data AS "logoData",
            profile.logo_mime_type AS "logoMimeType", profile.report_template AS "reportTemplate",
            profile.report_secondary_logo_data AS "secondaryLogoData", profile.report_secondary_logo_mime_type AS "secondaryLogoMimeType",
            profile.report_file_template_mode AS "reportFileTemplateMode", profile.report_file_template_filename AS "reportFileTemplateFilename",
            profile.report_file_template_data AS "reportFileTemplateData", profile.report_file_template_mime_type AS "reportFileTemplateMimeType",
            owner.report_template_policy AS "reportTemplatePolicy"
        FROM depannhome_users owner LEFT JOIN depannhome_billing_profiles profile ON profile.owner_id=owner.id WHERE owner.id = $1
    `, [ownerId]);
    const profile = rows[0] || emptyProfile();
    const date = new Date().toISOString().slice(0, 10);
    const snapshot = {
        interventionNumber: "APERÇU",
        interventionReference: "Intervention de démonstration",
        clientName: "Nom du client",
        clientAddress: "Adresse de l’intervention",
        date,
        time: "09:00",
        technicianName: "Nom du technicien"
    };
    return createTechnicalReportOutput({
        id: "APERÇU",
        title: "Rapport de recherche de fuite — Aperçu",
        reportDate: date,
        clientName: snapshot.clientName,
        appointmentLocation: snapshot.clientAddress,
        technicianName: snapshot.technicianName,
        content: createEmptyLeakContent(snapshot),
        media: []
    }, profile);
}

function cleanFileName(value) {
    return String(value || "base-devis").replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_").slice(0, 255) || "base-devis";
}

function contentDispositionFileName(value) {
    return cleanFileName(value).replace(/"/g, "_");
}

function sanitizeProfile(value) {
    return {
        companyName: cleanText(value?.companyName, 160), legalForm: cleanText(value?.legalForm, 100), address: cleanText(value?.address, 255),
        postalCode: cleanText(value?.postalCode, 20), city: cleanText(value?.city, 100), phone: cleanText(value?.phone, 50), secondaryPhone: cleanText(value?.secondaryPhone, 50),
        email: cleanText(value?.email, 160), country: cleanText(value?.country, 100) || "France", registrationNumber: cleanText(value?.registrationNumber, 100), siren: cleanText(value?.siren, 20), taxNumber: cleanText(value?.taxNumber, 100), vatRegime: normalizeVatRegime(value?.vatRegime), bankIban: cleanText(value?.bankIban, 80), bankBic: cleanText(value?.bankBic, 40),
        paymentTerms: cleanText(value?.paymentTerms, 500), depositTerms: cleanText(value?.depositTerms, 500),
        earlyPaymentDiscountTerms: cleanText(value?.earlyPaymentDiscountTerms, 500) || DEFAULT_EARLY_PAYMENT_DISCOUNT_TERMS,
        latePaymentPenaltyTerms: cleanText(value?.latePaymentPenaltyTerms, 1000) || DEFAULT_LATE_PAYMENT_PENALTY_TERMS,
        recoveryIndemnityCents: Math.round(nonNegativeNumber(value?.recoveryIndemnityCents) ?? 4000), vatOnDebits: value?.vatOnDebits === true || value?.vatOnDebits === "true" || value?.vatOnDebits === "on",
        footerNote: cleanText(value?.footerNote, 1000)
    };
}

function sanitizeTemplate(value) {
    const label = cleanText(value?.label, 160);
    const description = cleanText(value?.description, 500);
    const unit = cleanText(value?.unit, 40) || "unité";
    const unitPrice = nonNegativeNumber(value?.unitPrice);
    const vatRate = nonNegativeNumber(value?.vatRate);
    if (!label) return { ok: false, message: "Le libellé de la ligne est obligatoire." };
    if (unitPrice === null || vatRate === null || vatRate > 100) return { ok: false, message: "Le prix et la TVA sont invalides." };
    return { ok: true, label, description, unit, unitPrice, vatRate };
}

function sanitizeDocument(value) {
    const documentType = DOCUMENT_TYPES.has(value?.documentType) ? value.documentType : "";
    const documentNumber = cleanText(value?.documentNumber, 80);
    const clientId = CLIENT_ID_PATTERN.test(String(value?.clientId || "")) ? String(value.clientId) : "";
    const customerType = CUSTOMER_TYPES.has(value?.customerType) ? value.customerType : "Particulier";
    const customerName = cleanText(value?.customerName, 160);
    const customerAddress = cleanText(value?.customerAddress, 500);
    const issueDate = sanitizeDate(value?.issueDate);
    const dueDate = value?.dueDate ? sanitizeDate(value.dueDate) : "";
    const status = documentType === "invoice" ? "draft" : cleanText(value?.status, 30) || "draft";
    const isAccounted = false;
    const appointmentId = positiveId(value?.appointmentId);
    const sourceQuoteId = documentType === "invoice" ? positiveId(value?.sourceQuoteId) : 0;
    const notes = cleanText(value?.notes, 2000);
    const lines = sanitizeLines(value?.lines);
    const financialData = sanitizeFinancialData(value?.financialData);
    const legalData = sanitizeLegalData(value?.legalData, customerAddress);
    if (!documentType || (documentType === "quote" && !documentNumber) || !issueDate) return { ok: false, message: "Le type, le numéro du devis et la date sont obligatoires." };
    if (!customerName) return { ok: false, message: "Le nom du client est obligatoire." };
    if (!lines.length) return { ok: false, message: "Ajoutez au moins une ligne." };
    if (value?.dueDate && !dueDate) return { ok: false, message: "La date d'échéance est invalide." };
    return { ok: true, documentType, documentNumber, clientId, customerType, customerName, customerAddress, issueDate, dueDate, status, isAccounted, appointmentId, sourceQuoteId, lines, notes, financialData, legalData };
}

function sanitizeLegalData(value, customerAddress = "") {
    const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const serviceDate = input.serviceDate ? sanitizeDate(input.serviceDate) : "";
    return {
        customerSiren: cleanIdentifier(input.customerSiren, 20, true),
        customerVatNumber: cleanIdentifier(input.customerVatNumber, 40),
        billingAddress: cleanText(input.billingAddress, 500) || customerAddress,
        deliveryAddress: cleanText(input.deliveryAddress, 500),
        serviceDate,
        purchaseOrderReference: cleanText(input.purchaseOrderReference, 80),
        operationCategory: OPERATION_CATEGORIES.has(input.operationCategory) ? input.operationCategory : "services"
    };
}

function sanitizeDocumentPreview(value) {
    const documentType = DOCUMENT_TYPES.has(value?.documentType) ? value.documentType : "";
    if (!documentType) return { ok: false, message: "L’aperçu est disponible uniquement pour un devis ou une facture." };
    const sourceLines = Array.isArray(value?.lines) && value.lines.length ? value.lines : [{}];
    const lines = sourceLines.slice(0, 100).map((line, index) => ({ description: cleanText(line?.description, 500) || `Prestation ${index + 1} à renseigner`, quantity: positiveNumber(line?.quantity) ?? 1, unit: cleanText(line?.unit, 40) || "unité", unitPrice: nonNegativeNumber(line?.unitPrice) ?? 0, vatRate: Math.min(100, nonNegativeNumber(line?.vatRate) ?? 0) }));
    return sanitizeDocument({ ...value, documentType, documentNumber: cleanText(value?.documentNumber, 80) || "BROUILLON", customerName: cleanText(value?.customerName, 160) || "Client à renseigner", issueDate: sanitizeDate(value?.issueDate) || new Date().toISOString().slice(0, 10), dueDate: sanitizeDate(value?.dueDate), lines });
}

function sanitizeFinancialData(value) {
    const data = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const aids = Array.isArray(data.aids) ? data.aids.map(aid => {
        const name = cleanText(aid?.name, 160);
        const amount = nonNegativeNumber(aid?.amount);
        const calculationMode = aid?.calculationMode === "percentage" ? "percentage" : "fixed";
        return name && amount !== null
            ? { name, amount, calculationMode, aidType: cleanText(aid?.aidType, 40) || "custom", description: cleanText(aid?.description, 1000) }
            : null;
    }).filter(Boolean).slice(0, 30) : [];
    return {
        discountMode: data.discountMode === "percentage" ? "percentage" : "fixed",
        discountAmount: nonNegativeNumber(data.discountAmount) || 0,
        discountLabel: cleanText(data.discountLabel, 160),
        depositAmount: nonNegativeNumber(data.depositAmount) || 0,
        conditions: cleanText(data.conditions, 2000),
        comments: cleanText(data.comments, 2000),
        aids
    };
}

function sanitizeQuoteTemplate(value) {
    if (value === null) return { ok: true, template: null };
    const customerType = CUSTOMER_TYPES.has(value?.customerType) ? value.customerType : "Particulier";
    const status = cleanText(value?.status, 30) || "draft";
    const notes = cleanText(value?.notes, 2000);
    const lines = sanitizeLines(value?.lines);
    if (!lines.length) return { ok: false, message: "Le modèle de devis doit contenir au moins une ligne valide." };
    return { ok: true, template: { customerType, status, notes, lines } };
}

function sanitizeLines(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 100).map(line => {
        const description = cleanText(line?.description, 500);
        const quantity = positiveNumber(line?.quantity);
        const unit = cleanText(line?.unit, 40) || "unité";
        const unitPrice = nonNegativeNumber(line?.unitPrice);
        const vatRate = nonNegativeNumber(line?.vatRate);
        return description && quantity !== null && unitPrice !== null && vatRate !== null && vatRate <= 100
            ? { description, quantity, unit, unitPrice, vatRate } : null;
    }).filter(Boolean);
}

export function normalizeVatRegime(value) { return VAT_REGIMES.has(value) ? value : "standard"; }
export function applyVatRegime(lines, vatRegime) { return (Array.isArray(lines) ? lines : []).map(line => ({ ...line, vatRate: normalizeVatRegime(vatRegime) === "franchise" ? 0 : Number(line.vatRate) || 0 })); }
export function buildBillingFinancialDashboard(documents, settlements = [], purchasesHtValue = 0) {
    const excludedStatuses = new Set(["draft", "cancelled", "rejected"]);
    const settledByDocument = new Map((Array.isArray(settlements) ? settlements : []).map(item => [String(item.documentId), Number(item.amount) || 0]));
    let invoicesHt = 0; let invoicesTtc = 0; let creditsHt = 0; let creditsTtc = 0; let outstanding = 0; let invoicesCount = 0; let creditsCount = 0;
    for (const document of Array.isArray(documents) ? documents : []) {
        if (excludedStatuses.has(String(document.status || "").toLowerCase()) || !["invoice", "credit"].includes(document.documentType)) continue;
        const sourceLines = document.documentType === "credit" ? (document.lines || []).map(line => ({ ...line, quantity: Math.abs(Number(line.quantity) || 0), unitPrice: Math.abs(Number(line.unitPrice ?? line.unit_price) || 0) })) : document.lines;
        const totals = calculateDocumentAccountingTotals(sourceLines, document.financialData || {});
        if (document.documentType === "credit") { creditsHt += Math.abs(totals.ht); creditsTtc += Math.abs(totals.ttc); creditsCount += 1; continue; }
        invoicesHt += totals.ht; invoicesTtc += totals.ttc; invoicesCount += 1;
        const aids = Array.isArray(document.financialData?.aids) ? document.financialData.aids : [];
        const aidAmount = Math.min(totals.ttc, aids.reduce((sum, aid) => sum + (aid.calculationMode === "percentage" ? totals.ht * Number(aid.amount || 0) / 100 : Number(aid.amount || 0)), 0));
        outstanding += Math.max(0, totals.ttc - aidAmount - (settledByDocument.get(String(document.id)) || 0));
    }
    const purchasesHt = Math.max(0, Number(purchasesHtValue) || 0);
    const turnoverHt = Math.max(0, invoicesHt - creditsHt);
    const grossProfitEstimateHt = turnoverHt - purchasesHt;
    const collected = [...settledByDocument.values()].reduce((sum, amount) => sum + amount, 0);
    return { invoicesHt: roundFinancial(invoicesHt), invoicesTtc: roundFinancial(invoicesTtc), turnoverHt: roundFinancial(turnoverHt), creditsHt: roundFinancial(creditsHt), creditsTtc: roundFinancial(creditsTtc), purchasesHt: roundFinancial(purchasesHt), grossProfitEstimateHt: roundFinancial(grossProfitEstimateHt), collected: roundFinancial(collected), outstanding: roundFinancial(outstanding), invoicesCount, creditsCount };
}
function roundFinancial(value) { return Math.round((Number(value) || 0) * 100) / 100; }
async function billingTaxIdentity(ownerId) { const { rows } = await getPool().query("SELECT vat_regime AS \"vatRegime\",tax_number AS \"taxNumber\" FROM depannhome_billing_profiles WHERE owner_id=$1", [ownerId]); return { vatRegime: normalizeVatRegime(rows[0]?.vatRegime), taxNumber: cleanText(rows[0]?.taxNumber, 100) }; }
async function documentTaxIdentity(ownerId, documentId) { const { rows } = await getPool().query("SELECT document_type AS \"documentType\",document_number AS \"documentNumber\",vat_regime AS \"vatRegime\",issuer_tax_number AS \"taxNumber\",correction_source_id AS \"correctionSourceId\" FROM depannhome_billing_documents WHERE owner_id=$1 AND id=$2", [ownerId, documentId]); return rows[0] ? { documentType: rows[0].documentType, documentNumber: rows[0].documentNumber, vatRegime: normalizeVatRegime(rows[0].vatRegime), taxNumber: cleanText(rows[0].taxNumber, 100), correctionSourceId: rows[0].correctionSourceId || null } : null; }

function draftInvoiceReference() { return `BROUILLON-FAC-${crypto.randomUUID()}`; }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function billingError(status, message) { const error = new Error(message); error.status = status; return error; }

function sanitizeDate(value) {
    const date = String(value || "");
    return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(new Date(`${date}T12:00:00`).getTime()) ? date : "";
}

function positiveId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function positiveNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 && number <= 1000000 ? Math.round(number * 1000) / 1000 : null;
}

function nonNegativeNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 && number <= 100000000 ? Math.round(number * 100) / 100 : null;
}

function cleanText(value, maximumLength) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximumLength);
}

function cleanIdentifier(value, maximumLength, digitsOnly = false) {
    const pattern = digitsOnly ? /[^0-9]/g : /[^A-Za-z0-9]/g;
    return String(value || "").replace(pattern, "").toUpperCase().slice(0, maximumLength);
}

function normalizeAddress(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function sanitizeEmailRecipient(value) {
    const recipient = String(value || "").trim().slice(0, 254);
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient) ? recipient : "";
}

async function getBillingExport(request) {
    const id = positiveId(request.params.documentId);
    if (!id) return null;
    const database = getPool();
    const [documentResult, profileResult] = await Promise.all([
        database.query(`
            SELECT id, document_type AS "documentType", document_number AS "documentNumber", client_id AS "clientId", customer_type AS "customerType",
                customer_name AS "customerName", customer_address AS "customerAddress", created_by_name AS "creatorName", TO_CHAR(issue_date, 'YYYY-MM-DD') AS "issueDate",
                TO_CHAR(due_date, 'YYYY-MM-DD') AS "dueDate", status, is_email_sent AS "isEmailSent", sent_at AS "sentAt", issued_at AS "issuedAt", correction_source_id AS "correctionSourceId", correction_kind AS "correctionKind", (SELECT source.document_number FROM depannhome_billing_documents source WHERE source.id=depannhome_billing_documents.correction_source_id) AS "correctionSourceNumber", quote_reference AS "quoteReference", vat_regime AS "vatRegime", issuer_tax_number AS "issuerTaxNumber", legal_data AS "legalData", lines, notes, financial_data AS "financialData",
                (SELECT client.client_data FROM depannhome_clients client WHERE client.owner_id=depannhome_billing_documents.owner_id AND client.client_id=depannhome_billing_documents.client_id) AS "clientData"
                        FROM depannhome_billing_documents
                        WHERE id = $1 AND owner_id = $2
                            AND ($3 <> 'technician'
                                OR created_by = $4
                                OR EXISTS (
                                        SELECT 1 FROM depannhome_calendar_events appointment
                                        WHERE appointment.id = depannhome_billing_documents.appointment_id
                                            AND appointment.owner_id = $2
                                            AND EXISTS (SELECT 1 FROM depannhome_calendar_assignments assignment WHERE assignment.event_id = appointment.id AND assignment.technician_id = $4)
                                            )
                                            OR EXISTS (
                                              SELECT 1
                                              FROM depannhome_billing_documents source_quote
                                              LEFT JOIN depannhome_calendar_events quote_appointment ON quote_appointment.id = source_quote.appointment_id
                                              WHERE source_quote.id = depannhome_billing_documents.source_quote_id
                                                AND source_quote.owner_id = $2
                                                AND (source_quote.created_by = $4 OR EXISTS (SELECT 1 FROM depannhome_calendar_assignments assignment WHERE assignment.event_id = quote_appointment.id AND assignment.technician_id = $4))
                                            ))
                `, [id, getAccountOwnerId(request), request.user?.role || "", request.user?.sub || 0]),
        database.query(`
            SELECT owner.id AS "ownerId", profile.company_name AS "companyName", profile.legal_form AS "legalForm", profile.address, profile.postal_code AS "postalCode", profile.city, profile.phone, profile.email,
                profile.registration_number AS "registrationNumber", profile.siren, profile.tax_number AS "taxNumber", profile.vat_regime AS "vatRegime", profile.bank_iban AS "bankIban", profile.bank_bic AS "bankBic", profile.payment_terms AS "paymentTerms", profile.deposit_terms AS "depositTerms", profile.early_payment_discount_terms AS "earlyPaymentDiscountTerms", profile.late_payment_penalty_terms AS "latePaymentPenaltyTerms", profile.recovery_indemnity_cents AS "recoveryIndemnityCents", profile.vat_on_debits AS "vatOnDebits",
                profile.footer_note AS "footerNote", profile.logo_data AS "logoData", profile.logo_mime_type AS "logoMimeType", profile.quote_template_config AS "quoteTemplateConfig",
                profile.quote_template_mode AS "quoteTemplateMode", profile.quote_template_filename AS "quoteTemplateFilename", profile.quote_template_data AS "quoteTemplateData", profile.quote_template_mime_type AS "quoteTemplateMimeType", owner.quote_template_policy AS "quoteTemplatePolicy"
            FROM depannhome_users owner LEFT JOIN depannhome_billing_profiles profile ON profile.owner_id=owner.id WHERE owner.id = $1
        `, [getAccountOwnerId(request)])
    ]);
    if (!documentResult.rows[0]) return null;
    return { document: documentResult.rows[0], profile: profileResult.rows[0] || emptyProfile() };
}

function billingPdfFileName(document) {
    const type = document.documentType === "credit" ? "avoir" : document.documentType === "invoice" ? "facture" : "devis";
    const number = String(document.documentNumber || "document").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "");
    return `${type}-${number || "document"}.pdf`;
}

function ublFileName(document) {
    const type = document.documentType === "credit" ? "avoir" : "facture";
    const number = String(document.documentNumber || "document").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "");
    return `${type}-${number || "document"}-ubl.xml`;
}

export async function createBillingDocumentOutput(document, profile) {
    const custom = await renderActiveCustomTemplate(profile.ownerId, document.documentType, buildBillingCustomModel(document, profile));
    if (custom) return custom;
    return { buffer: await createBillingPdf(document, profile), filename: billingPdfFileName(document), mimeType: PDF_MIME };
}

function billingTemplateValues(document, profile) {
    const totalHt = (document.lines || []).reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unitPrice || 0), 0);
    const totalTva = (document.lines || []).reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unitPrice || 0) * Number(line.vatRate || 0) / 100, 0);
    const money = value => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value || 0);
    const legal = document.legalData && typeof document.legalData === "object" ? document.legalData : {};
    return { type_document: document.documentType === "invoice" ? "Facture" : "Devis", numero: document.documentNumber, date: document.issueDate, echeance: document.dueDate || "", etabli_par: document.creatorName || "", client_nom: document.customerName, client_adresse: legal.billingAddress || document.customerAddress, client_siren: legal.customerSiren || "", client_tva: legal.customerVatNumber || "", adresse_livraison: legal.deliveryAddress || "", date_prestation: legal.serviceDate || "", reference_commande: legal.purchaseOrderReference || "", categorie_operation: ({ goods: "Livraison de biens", services: "Prestation de services", mixed: "Livraison de biens et prestation de services" })[legal.operationCategory] || "Prestation de services", entreprise_nom: profile.companyName, entreprise_adresse: [profile.address, profile.postalCode, profile.city].filter(Boolean).join(" "), entreprise_telephone: profile.phone, entreprise_email: profile.email, siret: profile.registrationNumber, siren: profile.siren, numero_tva: document.issuerTaxNumber || profile.taxNumber, conditions: document.notes || profile.paymentTerms, lignes: (document.lines || []).map(line => `${line.description} | ${line.quantity} ${line.unit} | ${money(Number(line.unitPrice))} HT | TVA ${line.vatRate || 0} %`).join("\n"), total_ht: money(totalHt), total_tva: money(totalTva), total_ttc: money(totalHt + totalTva) };
}

export function createBillingPdf(document, profile) {
    return new Promise((resolve, reject) => {
        const isCredit = document.documentType === "credit";
        const template = ["quote", "invoice"].includes(document.documentType) ? sanitizeDocumentTemplate(profile.quoteTemplateConfig || {}) : { ...DEFAULT_DOCUMENT_TEMPLATE };
        const boldFont = template.font === "Times-Roman" ? "Times-Bold" : template.font === "Courier" ? "Courier-Bold" : "Helvetica-Bold";
        const documentLabel = isCredit ? "Avoir" : document.documentType === "invoice" ? "Facture" : "Devis";
        const pdf = new PDFDocument({ size: "A4", margin: 44, bufferPages: true, info: { Title: `${documentLabel} ${document.documentNumber}`, Author: profile.companyName || "Depann'Home Pro" } });
        const chunks = [];
        pdf.on("data", chunk => chunks.push(chunk));
        pdf.on("end", () => resolve(Buffer.concat(chunks)));
        pdf.on("error", reject);

        const margin = 44;
        const contentWidth = pdf.page.width - margin * 2;
        const bottom = () => pdf.page.height - 58;
        const ensureSpace = height => {
            if (pdf.y + height <= bottom()) return;
            pdf.addPage();
            pdf.y = margin;
        };
        const line = (y, color = template.separatorColor) => pdf.moveTo(margin, y).lineTo(margin + contentWidth, y).lineWidth(1).strokeColor(color).stroke();
        const text = (value, x, y, width, options = {}) => pdf.fillColor(options.color || template.primaryColor).font(options.bold ? boldFont : template.font).fontSize(options.size || 9).text(String(value || ""), x, y, { width, ...options });
        const formatMoney = value => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(Number(value) || 0);
        const formatDate = value => value ? new Intl.DateTimeFormat("fr-FR").format(new Date(`${value}T12:00:00`)) : "Non renseignée";
        const financialData = document.financialData && typeof document.financialData === "object" ? document.financialData : {};
        const vatRegime = normalizeVatRegime(document.vatRegime || profile.vatRegime);
        const isVatFranchise = vatRegime === "franchise";
        const issuerTaxNumber = document.issuerTaxNumber || profile.taxNumber || "";
        const legalData = document.legalData && typeof document.legalData === "object" ? document.legalData : {};
        const exactTotals = document.exactTotals && typeof document.exactTotals === "object" ? document.exactTotals : null;
        const lineAmount = item => Number(item.quantity || 0) * Number(item.unitPrice || 0);
        const totalHt = exactTotals ? Number(exactTotals.taxBaseCents || 0) / 100 : (document.lines || []).reduce((sum, item) => sum + (isCredit ? Math.abs(lineAmount(item)) : lineAmount(item)), 0);
        let grossVat = isVatFranchise ? 0 : (document.lines || []).reduce((sum, item) => sum + (isCredit ? Math.abs(lineAmount(item)) : lineAmount(item)) * Number(item.vatRate || 0) / 100, 0);
        if (exactTotals) grossVat = Number(exactTotals.vatAmountCents || 0) / 100;
        const discountAmount = Math.min(totalHt, financialData.discountMode === "percentage" ? totalHt * Number(financialData.discountAmount || 0) / 100 : Number(financialData.discountAmount || 0));
        const totalVat = totalHt ? grossVat * (totalHt - discountAmount) / totalHt : 0;
        const totalTtc = exactTotals ? Number(exactTotals.amountCents || 0) / 100 : totalHt - discountAmount + totalVat;
        const aidAmount = Math.min(totalTtc, (Array.isArray(financialData.aids) ? financialData.aids : []).reduce((sum, aid) => sum + (aid.calculationMode === "percentage" ? (totalHt - discountAmount) * Number(aid.amount || 0) / 100 : Number(aid.amount || 0)), 0));
        const remainingAmount = Math.max(0, totalTtc - aidAmount);
        const title = isCredit ? "AVOIR" : document.correctionKind === "replacement" ? "FACTURE RECTIFICATIVE" : document.correctionKind === "amendment" ? "AVENANT À FACTURE" : document.documentType === "invoice" ? "FACTURE" : "DEVIS";

        if (profile.logoData && ["image/png", "image/jpeg"].includes(profile.logoMimeType)) {
            try { pdf.image(profile.logoData, margin, margin, { fit: [56, 56] }); } catch { /* Le PDF reste disponible même si le logo est illisible. */ }
        }
        const companyX = profile.logoData ? margin + 68 : margin;
        const companyDetails = [profile.companyName || "Votre structure", profile.legalForm, profile.address, [profile.postalCode, profile.city].filter(Boolean).join(" "), profile.phone ? `Tél. ${profile.phone}` : "", profile.email].filter(Boolean).join("\n");
        text(companyDetails, companyX, margin, 250, { size: 9, lineGap: 2, bold: false });
        text(title, margin + contentWidth - 145, margin, 145, { size: 25, bold: true, align: "right", color: template.primaryColor });
        text(`N° ${document.documentNumber}${document.sourceInvoiceNumber ? `\nFacture liée : ${document.sourceInvoiceNumber}` : document.correctionSourceNumber ? `\nCorrige : ${document.correctionSourceNumber}` : ""}${document.quoteReference ? `\nRéf. devis : ${document.quoteReference}` : ""}\nÉmis le ${formatDate(document.issueDate)}${document.dueDate ? `\nÉchéance : ${formatDate(document.dueDate)}` : ""}`, margin + contentWidth - 170, margin + 34, 170, { size: 9, align: "right", lineGap: 2 });
        if (template.headerText) text(template.headerText, companyX, margin + 60, 300, { size: 7.5, color: template.secondaryColor });
        pdf.y = Math.max(margin + 74, pdf.y) + 15;
        line(pdf.y, template.primaryColor);
        pdf.y += 20;

        if (document.documentType === "invoice" && document.paidDate) {
            const stampWidth = 210;
            const stampX = margin + contentWidth - stampWidth;
            pdf.roundedRect(stampX, pdf.y, stampWidth, 30, 6).fill(template.secondaryColor);
            text(`RÉGLÉE LE ${formatDate(document.paidDate).toUpperCase()}`, stampX + 10, pdf.y + 9, stampWidth - 20, { size: 10, bold: true, color: "#ffffff", align: "center" });
            pdf.y += 42;
        }

        const partyY = pdf.y;
        const partyHeight = 112;
        pdf.rect(margin, partyY, 225, partyHeight).fill("#f0f2f4");
        pdf.rect(margin + contentWidth - 225, partyY, 225, partyHeight).fill("#f0f2f4");
        text("ÉMETTEUR", margin + 12, partyY + 10, 200, { size: 8, bold: true });
        text([profile.companyName || "Votre structure", document.creatorName ? `Établi par : ${document.creatorName}` : "", profile.registrationNumber ? `SIRET ${profile.registrationNumber}` : "", !isVatFranchise && issuerTaxNumber ? `TVA intracom. ${issuerTaxNumber}` : "", isVatFranchise ? VAT_FRANCHISE_MENTION : ""].filter(Boolean).join("\n"), margin + 12, partyY + 24, 200, { size: 9, lineGap: 2 });
        text("CLIENT", margin + contentWidth - 213, partyY + 10, 200, { size: 8, bold: true });
        text([document.customerName, legalData.billingAddress || document.customerAddress, legalData.customerSiren ? `SIREN ${legalData.customerSiren}` : "", legalData.customerVatNumber ? `TVA intracom. ${legalData.customerVatNumber}` : ""].filter(Boolean).join("\n"), margin + contentWidth - 213, partyY + 24, 200, { size: 9, lineGap: 2 });
        pdf.y = partyY + partyHeight + 18;
        text("OBJET / PRESTATION", margin, pdf.y, contentWidth, { size: 8, bold: true });
        const operationLabel = ({ goods: "Livraison de biens", services: "Prestation de services", mixed: "Livraison de biens et prestation de services" })[legalData.operationCategory] || "Prestation de services";
        const objectDetails = [isCredit ? `Avoir relatif à la facture ${document.sourceInvoiceNumber || "d’origine"}${document.sourceInvoiceDate ? ` du ${formatDate(document.sourceInvoiceDate)}` : ""}${document.reason ? ` · ${document.reason}` : ""}` : operationLabel, legalData.serviceDate ? `Date de livraison / prestation : ${formatDate(legalData.serviceDate)}` : "", legalData.purchaseOrderReference ? `Bon de commande : ${legalData.purchaseOrderReference}` : "", legalData.deliveryAddress && normalizeAddress(legalData.deliveryAddress) !== normalizeAddress(legalData.billingAddress || document.customerAddress) ? `Adresse de livraison : ${legalData.deliveryAddress}` : ""].filter(Boolean).join("\n");
        text(objectDetails, margin, pdf.y + 12, contentWidth, { size: 9, lineGap: 2 });
        pdf.y += Math.max(32, pdf.heightOfString(objectDetails, { width: contentWidth, fontSize: 9, lineGap: 2 }) + 22);

        const columns = [margin, margin + 205, margin + 255, margin + 300, margin + 390, margin + 440];
        const drawTableHeader = () => {
            ensureSpace(28);
            pdf.rect(margin, pdf.y, contentWidth, 22).fill(template.primaryColor);
            const headerY = pdf.y + 7;
            [["Désignation", columns[0], 195], ["Qté", columns[1], 42], ["Unité", columns[2], 38], ["PU HT", columns[3], 80], ["TVA", columns[4], 42], ["Total HT", columns[5], 65]].forEach(([label, x, width]) => text(label, x + 5, headerY, width - 8, { size: 8, bold: true, color: "#ffffff", align: x === columns[0] || x === columns[2] ? "left" : "right" }));
            pdf.y += 22;
        };
        drawTableHeader();
        (document.lines || []).forEach(item => {
            const rowHeight = Math.max(26, pdf.heightOfString(String(item.description || ""), { width: 190, fontSize: 8, lineGap: 2 }) + 12);
            if (pdf.y + rowHeight > bottom()) { pdf.addPage(); pdf.y = margin; drawTableHeader(); }
            const y = pdf.y;
            pdf.rect(margin, y, contentWidth, rowHeight).fill("#ffffff");
            pdf.rect(margin, y, contentWidth, rowHeight).lineWidth(.5).strokeColor(template.separatorColor).stroke();
            text(item.description, columns[0] + 5, y + 6, 190, { size: 8, lineGap: 2 });
            text(item.quantity, columns[1] + 3, y + 6, 40, { size: 8, align: "right" });
            text(item.unit, columns[2] + 4, y + 6, 34, { size: 8 });
            text(formatMoney(isCredit ? Math.abs(Number(item.unitPrice || 0)) : item.unitPrice), columns[3] + 3, y + 6, 76, { size: 8, align: "right" });
            text(`${isVatFranchise ? 0 : item.vatRate || 0} %`, columns[4] + 3, y + 6, 38, { size: 8, align: "right" });
            text(formatMoney(isCredit ? Math.abs(lineAmount(item)) : lineAmount(item)), columns[5] + 3, y + 6, 60, { size: 8, align: "right" });
            pdf.y += rowHeight;
        });

        ensureSpace(150);
        pdf.y += 18;
        const summaryY = pdf.y;
        text("CONDITIONS DE RÈGLEMENT", margin, summaryY, 260, { size: 9, bold: true });
        const conditions = [
            isCredit ? `Motif : ${document.reason || document.notes || "Correction de facturation"}` : financialData.conditions || financialData.comments || document.notes || profile.paymentTerms || "Conditions de règlement non renseignées.",
            document.documentType === "quote" && profile.depositTerms ? `Acompte : ${profile.depositTerms}` : "",
            document.documentType === "invoice" && profile.bankIban ? `Règlement par virement · IBAN : ${profile.bankIban}${profile.bankBic ? ` · BIC : ${profile.bankBic}` : ""}` : "",
            ["invoice", "credit"].includes(document.documentType) ? profile.earlyPaymentDiscountTerms || DEFAULT_EARLY_PAYMENT_DISCOUNT_TERMS : "",
            ["invoice", "credit"].includes(document.documentType) ? profile.latePaymentPenaltyTerms || DEFAULT_LATE_PAYMENT_PENALTY_TERMS : "",
            ["invoice", "credit"].includes(document.documentType) ? `Indemnité forfaitaire pour frais de recouvrement : ${formatMoney(Number(profile.recoveryIndemnityCents ?? 4000) / 100)}.` : "",
            ["invoice", "credit"].includes(document.documentType) && profile.vatOnDebits && !isVatFranchise ? "TVA acquittée sur les débits." : ""
        ].filter(Boolean).join("\n");
        text(conditions, margin, summaryY + 14, 260, { size: 8, lineGap: 2 });
        const totalX = margin + contentWidth - 180;
        [[isCredit ? "Avoir HT" : "Total HT", totalHt, template.primaryColor], ["Total TVA", totalVat, template.primaryColor], [isCredit ? "Avoir TTC" : "Total TTC", totalTtc, template.primaryColor], [isCredit ? "À déduire / rembourser" : document.documentType === "quote" ? "Reste à charge" : "Net à payer", isCredit ? totalTtc : remainingAmount, template.secondaryColor]].forEach(([label, value, color], index) => {
            const y = summaryY + index * 26;
            pdf.rect(totalX, y, 180, 24).fill(color);
            text(label, totalX + 9, y + 7, 92, { size: index === 2 ? 10 : 8, bold: true, color: "#ffffff" });
            text(formatMoney(value), totalX + 100, y + 6, 72, { size: index === 2 ? 10 : 8, bold: true, color: "#ffffff", align: "right" });
        });
        pdf.y = Math.max(pdf.y, summaryY + 114);
        if (isVatFranchise) {
            ensureSpace(30);
            text(VAT_FRANCHISE_MENTION, margin, pdf.y, contentWidth, { size: 9, bold: true, color: template.secondaryColor, align: "center" });
            pdf.y += 24;
        }
        if (discountAmount || aidAmount) {
            ensureSpace(44);
            const aidLines = (Array.isArray(financialData.aids) ? financialData.aids : []).map(aid => `${aid.name || "Aide"} : ${aid.calculationMode === "percentage" ? `${aid.amount || 0} %` : formatMoney(aid.amount)}`).join(" · ");
            const discountRate = financialData.discountMode === "percentage" ? ` (${Number(financialData.discountAmount || 0)} %)` : "";
            text([discountAmount ? `${financialData.discountLabel || "Remise"}${discountRate} : −${formatMoney(discountAmount)} HT` : "", aidLines, aidAmount ? `Total des aides : ${formatMoney(aidAmount)}` : ""].filter(Boolean).join("\n"), margin, pdf.y, contentWidth, { size: 8, color: "#475569", lineGap: 2 });
            pdf.y += 38;
        }
        if (document.documentType === "quote") {
            ensureSpace(82);
            pdf.rect(margin + contentWidth - 245, pdf.y, 245, 70).lineWidth(1).strokeColor(template.separatorColor).stroke();
            text("BON POUR ACCORD", margin + contentWidth - 233, pdf.y + 10, 220, { size: 9, bold: true });
            text("Devis accepté avant le début de la prestation.\nDate et signature du client :", margin + contentWidth - 233, pdf.y + 25, 220, { size: 8, lineGap: 3 });
            pdf.y += 78;
        }
        if (profile.footerNote) {
            ensureSpace(42);
            line(pdf.y, "#d7dde3");
            text(profile.footerNote, margin, pdf.y + 8, contentWidth, { size: 7, color: "#4b5563", align: "center" });
        }
        if (template.footerText) {
            ensureSpace(34);
            text(template.footerText, margin, pdf.y + 6, contentWidth, { size: 7, color: template.secondaryColor, align: "center" });
        }
        const pages = pdf.bufferedPageRange();
        for (let index = 0; index < pages.count; index += 1) {
            pdf.switchToPage(index);
            text(`${profile.companyName || "Votre structure"} · ${document.documentNumber} · Page ${index + 1}/${pages.count}`, margin, pdf.page.height - 32, contentWidth, { size: 7, color: "#6b7280", align: "center" });
        }
        pdf.end();
    });
}

async function findSourceQuote(database, ownerId, sourceQuoteId, request) {
    if (!sourceQuoteId) return null;
    const { rows } = await database.query(`
        SELECT id, document_number AS "documentNumber", vat_regime AS "vatRegime", issuer_tax_number AS "issuerTaxNumber"
        FROM depannhome_billing_documents
                WHERE id = $1 AND owner_id = $2 AND document_type = 'quote'
                    AND ($3 <> 'technician'
                        OR created_by = $4
                        OR EXISTS (
                                SELECT 1 FROM depannhome_calendar_events appointment
                                WHERE appointment.id = depannhome_billing_documents.appointment_id
                                    AND appointment.owner_id = $2
                                    AND EXISTS (SELECT 1 FROM depannhome_calendar_assignments assignment WHERE assignment.event_id = appointment.id AND assignment.technician_id = $4)
                        ))
        `, [sourceQuoteId, ownerId, request?.user?.role || "", request?.user?.sub || 0]);
    return rows[0] || null;
}

async function hasInvoiceForQuote(database, ownerId, sourceQuoteId, excludedDocumentId = 0) {
    const { rowCount } = await database.query(`
        SELECT 1
        FROM depannhome_billing_documents
        WHERE owner_id = $1 AND document_type = 'invoice' AND source_quote_id = $2
          AND ($3::bigint = 0 OR id <> $3::bigint)
        LIMIT 1
    `, [ownerId, sourceQuoteId, excludedDocumentId]);
    return Boolean(rowCount);
}

async function hasClient(database, ownerId, clientId, activeOnly = false) {
    const { rowCount } = await database.query(
        "SELECT 1 FROM depannhome_clients WHERE owner_id = $1 AND client_id = $2 AND ($3::boolean = FALSE OR client_status = 'active')",
        [ownerId, clientId, activeOnly]
    );
    return Boolean(rowCount);
}

async function findAccessibleAppointment(database, ownerId, appointmentId, request) {
    if (!appointmentId) return null;
    const { rows } = await database.query(`
        SELECT id
        FROM depannhome_calendar_events
        WHERE id = $1 AND owner_id = $2 AND event_type = 'appointment'
          AND ($3 <> 'technician' OR EXISTS (SELECT 1 FROM depannhome_calendar_assignments assignment WHERE assignment.event_id = depannhome_calendar_events.id AND assignment.technician_id = $4::bigint))
    `, [appointmentId, ownerId, request.user?.role || "", request.user?.sub || 0]);
    return rows[0] || null;
}

async function findAccessibleBillingDocument(database, ownerId, documentId, request) {
    const { rows } = await database.query(`
        SELECT document.id
        FROM depannhome_billing_documents document
        LEFT JOIN depannhome_calendar_events appointment ON appointment.id=document.appointment_id AND appointment.owner_id=document.owner_id
        WHERE document.id=$1 AND document.owner_id=$2
          AND ($3 <> 'technician' OR EXISTS (
              SELECT 1 FROM depannhome_calendar_assignments assignment
              WHERE assignment.event_id=appointment.id AND assignment.technician_id=$4::bigint
          ))
    `, [documentId, ownerId, request.user?.role || "", request.user?.sub || 0]);
    return rows[0] || null;
}

function asyncHandler(handler) {
    return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}
