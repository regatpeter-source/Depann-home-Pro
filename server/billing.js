import multer from "multer";
import PDFDocument from "pdfkit";
import { getPool } from "./database.js";
import { getAccountOwnerId } from "./auth.js";
import { sendDocumentEmail } from "./email.js";

const MAX_LOGO_SIZE = 2 * 1024 * 1024;
const MAX_QUOTE_TEMPLATE_SIZE = 10 * 1024 * 1024;
const DOCUMENT_TYPES = new Set(["quote", "invoice"]);
const CUSTOMER_TYPES = new Set(["Particulier", "Professionnel", "Magasin", "Autre"]);
const CLIENT_ID_PATTERN = /^client-[a-zA-Z0-9-]+$/;
const QUOTE_TEMPLATE_POLICIES = new Set(["integrated_only", "company_choice", "external_only"]);
const QUOTE_TEMPLATE_MODES = new Set(["integrated", "external"]);
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
        if (["application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"].includes(file.mimetype)) return callback(null, true);
        return callback(new Error("Seuls les fichiers PDF, DOC et DOCX sont acceptés."));
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
            email VARCHAR(160) NOT NULL DEFAULT '',
            registration_number VARCHAR(100) NOT NULL DEFAULT '',
            siren VARCHAR(20) NOT NULL DEFAULT '',
            tax_number VARCHAR(100) NOT NULL DEFAULT '',
            bank_iban VARCHAR(80) NOT NULL DEFAULT '',
            bank_bic VARCHAR(40) NOT NULL DEFAULT '',
            payment_terms VARCHAR(500) NOT NULL DEFAULT '',
            deposit_terms VARCHAR(500) NOT NULL DEFAULT '',
            footer_note VARCHAR(1000) NOT NULL DEFAULT '',
            default_quote JSONB,
            quote_template_mode VARCHAR(20) NOT NULL DEFAULT 'integrated',
            quote_template_filename VARCHAR(255) NOT NULL DEFAULT '',
            quote_template_data BYTEA,
            quote_template_mime_type VARCHAR(150) NOT NULL DEFAULT '',
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
        ADD COLUMN IF NOT EXISTS siren VARCHAR(20) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS bank_iban VARCHAR(80) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS bank_bic VARCHAR(40) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS deposit_terms VARCHAR(500) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS quote_template_mode VARCHAR(20) NOT NULL DEFAULT 'integrated',
        ADD COLUMN IF NOT EXISTS quote_template_filename VARCHAR(255) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS quote_template_data BYTEA,
        ADD COLUMN IF NOT EXISTS quote_template_mime_type VARCHAR(150) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS report_template JSONB NOT NULL DEFAULT '{}'::jsonb,
        ADD COLUMN IF NOT EXISTS report_secondary_logo_data BYTEA,
        ADD COLUMN IF NOT EXISTS report_secondary_logo_mime_type VARCHAR(50) NOT NULL DEFAULT ''
    `);
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
            document_type VARCHAR(10) NOT NULL CHECK (document_type IN ('quote', 'invoice')),
            document_number VARCHAR(80) NOT NULL,
            client_id VARCHAR(100),
            customer_type VARCHAR(30) NOT NULL DEFAULT 'Particulier',
            customer_name VARCHAR(160) NOT NULL DEFAULT '',
            customer_address VARCHAR(500) NOT NULL DEFAULT '',
            issue_date DATE NOT NULL,
            due_date DATE,
            status VARCHAR(30) NOT NULL DEFAULT 'draft',
            is_accounted BOOLEAN NOT NULL DEFAULT FALSE,
            accounted_at DATE,
            appointment_id BIGINT,
            source_quote_id BIGINT,
            quote_reference VARCHAR(80) NOT NULL DEFAULT '',
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
        ADD COLUMN IF NOT EXISTS client_id VARCHAR(100),
        ADD COLUMN IF NOT EXISTS appointment_id BIGINT,
        ADD COLUMN IF NOT EXISTS source_quote_id BIGINT,
        ADD COLUMN IF NOT EXISTS quote_reference VARCHAR(80) NOT NULL DEFAULT ''
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
}

export function registerBillingRoutes(app, requireAuthentication) {
    app.get("/api/billing", requireAuthentication, asyncHandler(async (request, response) => {
        const database = getPool();
        const accountOwnerId = getAccountOwnerId(request);
        const [profileResult, templatesResult, documentsResult, aidsResult] = await Promise.all([
            database.query(`
                SELECT profile.company_name AS "companyName", profile.legal_form AS "legalForm", profile.address, profile.postal_code AS "postalCode", profile.city,
                    profile.phone, profile.email, profile.registration_number AS "registrationNumber", profile.siren, profile.tax_number AS "taxNumber", profile.bank_iban AS "bankIban", profile.bank_bic AS "bankBic",
                    profile.payment_terms AS "paymentTerms", profile.deposit_terms AS "depositTerms", profile.footer_note AS "footerNote", profile.default_quote AS "defaultQuote",
                    profile.quote_template_mode AS "quoteTemplateMode", profile.quote_template_filename AS "quoteTemplateFilename",
                    (profile.quote_template_data IS NOT NULL) AS "hasQuoteTemplate", (profile.logo_data IS NOT NULL) AS "hasLogo",
                    owner.quote_template_policy AS "quoteTemplatePolicy"
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
                    TO_CHAR(due_date, 'YYYY-MM-DD') AS "dueDate", status, is_accounted AS "isAccounted",
                    TO_CHAR(accounted_at, 'YYYY-MM-DD') AS "accountedAt", appointment_id AS "appointmentId", source_quote_id AS "sourceQuoteId", quote_reference AS "quoteReference", lines, notes, financial_data AS "financialData",
                    depannhome_billing_documents.created_at AS "createdAt", depannhome_billing_documents.updated_at AS "updatedAt",
                    COALESCE(NULLIF(creator.full_name, ''), creator.username, '') AS "creatorName"
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
            `, [accountOwnerId])
        ]);
        response.json({ profile: { ...emptyProfile(), ...(profileResult.rows[0] || {}) }, templates: templatesResult.rows, documents: documentsResult.rows, aids: aidsResult.rows });
    }));

    app.put("/api/billing/profile", requireAuthentication, requireBillingAdministration, upload.single("logo"), asyncHandler(async (request, response) => {
        const profile = sanitizeProfile(request.body);
        const removeLogo = String(request.body?.removeLogo || "") === "true";
        const logo = request.file;
        const database = getPool();
        await database.query(`
            INSERT INTO depannhome_billing_profiles
                (owner_id, company_name, legal_form, address, postal_code, city, phone, email, registration_number, siren, tax_number, bank_iban, bank_bic, payment_terms, deposit_terms, footer_note, logo_data, logo_mime_type)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
            ON CONFLICT (owner_id) DO UPDATE SET
                company_name = EXCLUDED.company_name, legal_form = EXCLUDED.legal_form, address = EXCLUDED.address,
                postal_code = EXCLUDED.postal_code, city = EXCLUDED.city, phone = EXCLUDED.phone, email = EXCLUDED.email,
                registration_number = EXCLUDED.registration_number, siren = EXCLUDED.siren, tax_number = EXCLUDED.tax_number, bank_iban = EXCLUDED.bank_iban, bank_bic = EXCLUDED.bank_bic,
                payment_terms = EXCLUDED.payment_terms, deposit_terms = EXCLUDED.deposit_terms, footer_note = EXCLUDED.footer_note,
                logo_data = CASE WHEN $19 THEN NULL WHEN $20 THEN EXCLUDED.logo_data ELSE depannhome_billing_profiles.logo_data END,
                logo_mime_type = CASE WHEN $19 THEN '' WHEN $20 THEN EXCLUDED.logo_mime_type ELSE depannhome_billing_profiles.logo_mime_type END,
                updated_at = NOW()
        `, [getAccountOwnerId(request), profile.companyName, profile.legalForm, profile.address, profile.postalCode, profile.city, profile.phone,
            profile.email, profile.registrationNumber, profile.siren, profile.taxNumber, profile.bankIban, profile.bankBic, profile.paymentTerms, profile.depositTerms, profile.footerNote,
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
        const { rows } = await getPool().query(
            "SELECT quote_template_data IS NOT NULL AS \"hasQuoteTemplate\" FROM depannhome_billing_profiles WHERE owner_id = $1",
            [accountOwnerId]
        );
        const hasExistingTemplate = Boolean(rows[0]?.hasQuoteTemplate);
        if (mode === "external" && !template && (removeTemplate || !hasExistingTemplate)) {
            return response.status(400).json({ message: "Déposez une base de devis PDF, DOC ou DOCX avant d’activer ce mode." });
        }
        await getPool().query(`
            INSERT INTO depannhome_billing_profiles (owner_id, quote_template_mode, quote_template_filename, quote_template_data, quote_template_mime_type)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (owner_id) DO UPDATE SET
                quote_template_mode = EXCLUDED.quote_template_mode,
                quote_template_filename = CASE WHEN $6 THEN '' WHEN $7 THEN EXCLUDED.quote_template_filename ELSE depannhome_billing_profiles.quote_template_filename END,
                quote_template_data = CASE WHEN $6 THEN NULL WHEN $7 THEN EXCLUDED.quote_template_data ELSE depannhome_billing_profiles.quote_template_data END,
                quote_template_mime_type = CASE WHEN $6 THEN '' WHEN $7 THEN EXCLUDED.quote_template_mime_type ELSE depannhome_billing_profiles.quote_template_mime_type END,
                updated_at = NOW()
        `, [accountOwnerId, mode, cleanFileName(template?.originalname), template?.buffer || null, template?.mimetype || "", removeTemplate, Boolean(template)]);
        response.status(204).end();
    }));

    app.get("/api/billing/quote-template/file", requireAuthentication, requireBillingAdministration, asyncHandler(async (request, response) => {
        const { rows } = await getPool().query(`
            SELECT quote_template_filename AS "filename", quote_template_data AS "data", quote_template_mime_type AS "mimeType"
            FROM depannhome_billing_profiles WHERE owner_id = $1
        `, [getAccountOwnerId(request)]);
        const template = rows[0];
        if (!template?.data) return response.status(404).json({ message: "Aucune base de devis déposée." });
        response.set({
            "Content-Type": template.mimeType || "application/octet-stream",
            "Content-Disposition": `attachment; filename="${contentDispositionFileName(template.filename || "base-devis")}"`,
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff"
        });
        response.send(template.data);
    }));

    app.get("/api/billing/blank-quote/pdf", requireAuthentication, requireBillingAdministration, asyncHandler(async (request, response) => {
        if (await usesExternalQuoteTemplate(getAccountOwnerId(request))) {
            return response.status(403).json({ message: "Cette entreprise utilise une base de devis PDF ou Word déposée dans son espace." });
        }
        const { rows } = await getPool().query(`
            SELECT company_name AS "companyName", legal_form AS "legalForm", address, postal_code AS "postalCode", city, phone, email,
                registration_number AS "registrationNumber", siren, tax_number AS "taxNumber", bank_iban AS "bankIban", bank_bic AS "bankBic", payment_terms AS "paymentTerms", deposit_terms AS "depositTerms",
                footer_note AS "footerNote", logo_data AS "logoData", logo_mime_type AS "logoMimeType"
            FROM depannhome_billing_profiles WHERE owner_id = $1
        `, [getAccountOwnerId(request)]);
        const profile = rows[0] || emptyProfile();
        const document = {
            documentType: "quote",
            documentNumber: "APERÇU",
            customerName: "",
            customerAddress: "",
            issueDate: new Date().toISOString().slice(0, 10),
            dueDate: "",
            lines: [],
            notes: profile.paymentTerms || ""
        };
        const pdf = await createBillingPdf(document, profile);
        response.set({
            "Content-Type": "application/pdf",
            "Content-Disposition": 'inline; filename="apercu-devis-vierge.pdf"',
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff"
        });
        response.send(pdf);
    }));

    app.get("/api/billing/documents/:documentId", requireAuthentication, asyncHandler(async (request, response) => {
        const id = positiveId(request.params.documentId);
        if (!id) return response.status(400).json({ message: "Document invalide." });
        const database = getPool();
        const [documentResult, profileResult] = await Promise.all([
            database.query(`
                SELECT id, document_type AS "documentType", document_number AS "documentNumber", client_id AS "clientId", customer_type AS "customerType",
                    customer_name AS "customerName", customer_address AS "customerAddress", TO_CHAR(issue_date, 'YYYY-MM-DD') AS "issueDate",
                    TO_CHAR(due_date, 'YYYY-MM-DD') AS "dueDate", status, is_accounted AS "isAccounted",
                    TO_CHAR(accounted_at, 'YYYY-MM-DD') AS "accountedAt", appointment_id AS "appointmentId", source_quote_id AS "sourceQuoteId", quote_reference AS "quoteReference", lines, notes, financial_data AS "financialData"
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
                    registration_number AS "registrationNumber", siren, tax_number AS "taxNumber", bank_iban AS "bankIban", bank_bic AS "bankBic", payment_terms AS "paymentTerms",
                    deposit_terms AS "depositTerms", footer_note AS "footerNote", (logo_data IS NOT NULL) AS "hasLogo"
                FROM depannhome_billing_profiles WHERE owner_id = $1
            `, [getAccountOwnerId(request)])
        ]);
        if (!documentResult.rows[0]) return response.status(404).json({ message: "Document introuvable." });
        response.json({ document: documentResult.rows[0], profile: profileResult.rows[0] || emptyProfile() });
    }));

    app.get("/api/billing/documents/:documentId/pdf", requireAuthentication, asyncHandler(async (request, response) => {
        const billingExport = await getBillingExport(request);
        if (!billingExport) return response.status(404).json({ message: "Document introuvable." });
        const pdf = await createBillingPdf(billingExport.document, billingExport.profile);
        const fileName = billingPdfFileName(billingExport.document);
        response.set({
            "Content-Type": "application/pdf",
            "Content-Disposition": `inline; filename="${fileName}"`,
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff"
        });
        response.send(pdf);
    }));

    app.post("/api/billing/documents/:documentId/email", requireAuthentication, requireTechnicianBillingAccess, asyncHandler(async (request, response) => {
        const recipient = sanitizeEmailRecipient(request.body?.recipient);
        if (!recipient) return response.status(400).json({ message: "L’adresse e-mail du destinataire est invalide." });
        const billingExport = await getBillingExport(request);
        if (!billingExport) return response.status(404).json({ message: "Document introuvable." });

        const pdf = await createBillingPdf(billingExport.document, billingExport.profile);
        const type = billingExport.document.documentType === "invoice" ? "Facture" : "Devis";
        await sendDocumentEmail({
            recipient,
            recipientName: billingExport.document.customerName,
            documentLabel: `${type} ${billingExport.document.documentNumber}`,
            attachment: { filename: billingPdfFileName(billingExport.document), content: pdf, contentType: "application/pdf" }
        });
        response.json({ message: `${type} envoyé(e) par e-mail.` });
    }));

    app.put("/api/billing/default-quote", requireAuthentication, requireBillingAdministration, asyncHandler(async (request, response) => {
        const quote = sanitizeQuoteTemplate(request.body);
        if (!quote.ok) return response.status(400).json({ message: quote.message });
        await getPool().query(`
            INSERT INTO depannhome_billing_profiles (owner_id, default_quote)
            VALUES ($1, $2::jsonb)
            ON CONFLICT (owner_id) DO UPDATE SET default_quote = EXCLUDED.default_quote, updated_at = NOW()
        `, [getAccountOwnerId(request), JSON.stringify(quote.template)]);
        response.status(204).end();
    }));

    app.post("/api/billing/templates", requireAuthentication, requireBillingAdministration, asyncHandler(async (request, response) => {
        const template = sanitizeTemplate(request.body);
        if (!template.ok) return response.status(400).json({ message: template.message });
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
        if (request.body?.documentType === "quote" && await usesExternalQuoteTemplate(getAccountOwnerId(request))) {
            return response.status(403).json({ message: "Cette entreprise utilise une base de devis PDF ou Word déposée dans son espace." });
        }
        const document = sanitizeDocument(request.body);
        if (!document.ok) return response.status(400).json({ message: document.message });
        if (request.user?.role === "technician" && (document.documentType !== "quote" || !document.appointmentId)) {
            return response.status(403).json({ message: "Les techniciens peuvent créer un devis uniquement depuis une intervention qui leur est attribuée." });
        }
        try {
            if (document.clientId && !await hasClient(getPool(), getAccountOwnerId(request), document.clientId)) {
                return response.status(400).json({ message: "Le dossier client associé est introuvable." });
            }
            const appointment = await findAccessibleAppointment(getPool(), getAccountOwnerId(request), document.appointmentId, request);
            if (document.appointmentId && !appointment) return response.status(400).json({ message: "Le rendez-vous associé est introuvable ou n’est pas accessible." });
            const sourceQuote = await findSourceQuote(getPool(), getAccountOwnerId(request), document.sourceQuoteId, request);
            if (document.sourceQuoteId && !sourceQuote) return response.status(400).json({ message: "Le devis de référence est introuvable." });
            if (document.documentType === "invoice" && sourceQuote && await hasInvoiceForQuote(getPool(), getAccountOwnerId(request), sourceQuote.id)) {
                return response.status(409).json({ message: "Une facture existe déjà pour ce devis." });
            }
            const { rows } = await getPool().query(`
                INSERT INTO depannhome_billing_documents
                    (owner_id, created_by, document_type, document_number, client_id, customer_type, customer_name, customer_address, issue_date, due_date, status, is_accounted, accounted_at, appointment_id, source_quote_id, quote_reference, lines, notes, financial_data)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10::date,$11,$12,CASE WHEN $12 THEN CURRENT_DATE ELSE NULL END,$13,$14,$15,$16::jsonb,$17,$18::jsonb)
                RETURNING id
            `, [getAccountOwnerId(request), request.user.sub, document.documentType, document.documentNumber, document.clientId || null, document.customerType, document.customerName,
                document.customerAddress, document.issueDate, document.dueDate || null, document.status, document.isAccounted, appointment?.id || null, sourceQuote?.id || null, sourceQuote?.documentNumber || "", JSON.stringify(document.lines), document.notes, JSON.stringify(document.financialData)]);
            await (await import("./partner-connections.js")).synchronizeConnectedBillingDocument(getAccountOwnerId(request), rows[0].id);
            const { recordMissionEventForSource } = await import("./partner-dialogue.js"); await recordMissionEventForSource({ ownerId: getAccountOwnerId(request), sourceType: "appointment", sourceId: appointment?.id, status: document.documentType === "invoice" ? "invoice_created" : "quote_created", action: "billing_document_created", details: { documentId: rows[0].id, documentType: document.documentType, status: document.status }, actorName: request.user.fullName || request.user.username });
            response.status(201).json({ id: rows[0].id });
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
        if (document.documentType === "quote" && await usesExternalQuoteTemplate(getAccountOwnerId(request))) {
            return response.status(403).json({ message: "Cette entreprise utilise une base de devis PDF ou Word déposée dans son espace." });
        }
        try {
            if (document.clientId && !await hasClient(getPool(), getAccountOwnerId(request), document.clientId)) {
                return response.status(400).json({ message: "Le dossier client associé est introuvable." });
            }
            const appointment = await findAccessibleAppointment(getPool(), getAccountOwnerId(request), document.appointmentId, request);
            if (document.appointmentId && !appointment) return response.status(400).json({ message: "Le rendez-vous associé est introuvable ou n’est pas accessible." });
            const sourceQuote = await findSourceQuote(getPool(), getAccountOwnerId(request), document.sourceQuoteId, request);
            if (document.sourceQuoteId && !sourceQuote) return response.status(400).json({ message: "Le devis de référence est introuvable." });
            if (document.documentType === "invoice" && sourceQuote && await hasInvoiceForQuote(getPool(), getAccountOwnerId(request), sourceQuote.id, id)) {
                return response.status(409).json({ message: "Une facture existe déjà pour ce devis." });
            }
            const result = await getPool().query(`
                UPDATE depannhome_billing_documents SET document_type=$3, document_number=$4, client_id=$5, customer_type=$6, customer_name=$7,
                    customer_address=$8, issue_date=$9::date, due_date=$10::date, status=$11, is_accounted=$12,
                    accounted_at=CASE WHEN $12 THEN COALESCE(accounted_at, CURRENT_DATE) ELSE NULL END, appointment_id=$13,
                    source_quote_id=$14, quote_reference=$15, lines=$16::jsonb, notes=$17, financial_data=$18::jsonb, updated_at=NOW()
                WHERE id=$1 AND owner_id=$2
            `, [id, getAccountOwnerId(request), document.documentType, document.documentNumber, document.clientId || null, document.customerType, document.customerName,
                document.customerAddress, document.issueDate, document.dueDate || null, document.status, document.isAccounted, appointment?.id || null, sourceQuote?.id || null, sourceQuote?.documentNumber || "", JSON.stringify(document.lines), document.notes, JSON.stringify(document.financialData)]);
            if (!result.rowCount) return response.status(404).json({ message: "Document introuvable." });
            await (await import("./partner-connections.js")).synchronizeConnectedBillingDocument(getAccountOwnerId(request), id);
            const { recordMissionEventForSource } = await import("./partner-dialogue.js"); await recordMissionEventForSource({ ownerId: getAccountOwnerId(request), sourceType: "appointment", sourceId: appointment?.id, status: document.documentType === "invoice" ? "invoice_sent" : "quote_sent", action: "billing_document_updated", details: { documentId: id, documentType: document.documentType, status: document.status }, actorName: request.user.fullName || request.user.username });
            response.status(204).end();
        } catch (error) {
            if (error.code === "23505") return response.status(409).json({ message: "Ce numéro de document existe déjà dans votre compte." });
            throw error;
        }
    }));

    app.patch("/api/billing/documents/:documentId/accounting", requireAuthentication, requireBillingAdministration, asyncHandler(async (request, response) => {
        const id = positiveId(request.params.documentId);
        if (!id || typeof request.body?.isAccounted !== "boolean") return response.status(400).json({ message: "Statut comptable invalide." });
        const result = await getPool().query(`
            UPDATE depannhome_billing_documents
            SET is_accounted = $3,
                accounted_at = CASE WHEN $3 THEN COALESCE(accounted_at, CURRENT_DATE) ELSE NULL END,
                updated_at = NOW()
            WHERE id = $1 AND owner_id = $2 AND document_type = 'invoice'
        `, [id, getAccountOwnerId(request), request.body.isAccounted]);
        if (!result.rowCount) return response.status(404).json({ message: "Facture introuvable." });
        response.status(204).end();
    }));

    app.delete("/api/billing/documents/:documentId", requireAuthentication, requireBillingAdministration, asyncHandler(async (request, response) => {
        const id = positiveId(request.params.documentId);
        if (!id) return response.status(400).json({ message: "Document invalide." });
        const result = await getPool().query("DELETE FROM depannhome_billing_documents WHERE id = $1 AND owner_id = $2", [id, getAccountOwnerId(request)]);
        if (!result.rowCount) return response.status(404).json({ message: "Document introuvable." });
        response.status(204).end();
    }));
}

function requireBillingAdministration(request, response, next) {
    if (request.user?.role !== "admin") {
        return response.status(403).json({ message: request.user?.role === "accountant" ? "L’espace comptabilité est en consultation uniquement." : "Les techniciens peuvent créer des devis et factures, sans modifier les documents ou paramètres existants." });
    }
    return next();
}

function requireBillingDocumentAdministration(request, response, next) {
    if (["admin", "mobile_admin"].includes(request.user?.role)) return next();
    return response.status(403).json({ message: request.user?.role === "accountant" ? "L’espace comptabilité est en consultation uniquement." : "Les techniciens peuvent créer des devis et factures, sans modifier les documents existants." });
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

export function billingUploadErrorHandler(error, request, response, next) {
    if (error instanceof multer.MulterError) return response.status(400).json({ message: error.field === "quoteTemplate" ? "La base de devis doit faire au maximum 10 Mo." : "Le logo doit faire au maximum 2 Mo." });
    if (error?.message === "Seules les images PNG, JPEG ou WebP sont acceptées.") return response.status(400).json({ message: error.message });
    if (error?.message === "Seuls les fichiers PDF, DOC et DOCX sont acceptés.") return response.status(400).json({ message: error.message });
    return next(error);
}

function emptyProfile() {
    return { companyName: "", legalForm: "", address: "", postalCode: "", city: "", phone: "", email: "", registrationNumber: "", siren: "", taxNumber: "", bankIban: "", bankBic: "", paymentTerms: "", depositTerms: "", footerNote: "", defaultQuote: null, quoteTemplateMode: "integrated", quoteTemplateFilename: "", hasQuoteTemplate: false, quoteTemplatePolicy: "company_choice", hasLogo: false };
}

async function getQuoteTemplatePolicy(accountOwnerId) {
    const { rows } = await getPool().query("SELECT quote_template_policy FROM depannhome_users WHERE id = $1", [accountOwnerId]);
    return QUOTE_TEMPLATE_POLICIES.has(rows[0]?.quote_template_policy) ? rows[0].quote_template_policy : "company_choice";
}

async function usesExternalQuoteTemplate(accountOwnerId) {
    const [policy, profile] = await Promise.all([
        getQuoteTemplatePolicy(accountOwnerId),
        getPool().query("SELECT quote_template_mode FROM depannhome_billing_profiles WHERE owner_id = $1", [accountOwnerId])
    ]);
    return policy === "external_only" || (policy !== "integrated_only" && profile.rows[0]?.quote_template_mode === "external");
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
        postalCode: cleanText(value?.postalCode, 20), city: cleanText(value?.city, 100), phone: cleanText(value?.phone, 50),
        email: cleanText(value?.email, 160), registrationNumber: cleanText(value?.registrationNumber, 100), siren: cleanText(value?.siren, 20), taxNumber: cleanText(value?.taxNumber, 100), bankIban: cleanText(value?.bankIban, 80), bankBic: cleanText(value?.bankBic, 40),
        paymentTerms: cleanText(value?.paymentTerms, 500), depositTerms: cleanText(value?.depositTerms, 500), footerNote: cleanText(value?.footerNote, 1000)
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
    const status = cleanText(value?.status, 30) || "draft";
    const isAccounted = documentType === "invoice" && value?.isAccounted === "on";
    const appointmentId = positiveId(value?.appointmentId);
    const sourceQuoteId = documentType === "invoice" ? positiveId(value?.sourceQuoteId) : 0;
    const notes = cleanText(value?.notes, 2000);
    const lines = sanitizeLines(value?.lines);
    const financialData = sanitizeFinancialData(value?.financialData);
    if (!documentType || !documentNumber || !issueDate) return { ok: false, message: "Le type, le numéro et la date sont obligatoires." };
    if (!customerName) return { ok: false, message: "Le nom du client est obligatoire." };
    if (!lines.length) return { ok: false, message: "Ajoutez au moins une ligne." };
    if (value?.dueDate && !dueDate) return { ok: false, message: "La date d'échéance est invalide." };
    return { ok: true, documentType, documentNumber, clientId, customerType, customerName, customerAddress, issueDate, dueDate, status, isAccounted, appointmentId, sourceQuoteId, lines, notes, financialData };
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
            SELECT id, document_type AS "documentType", document_number AS "documentNumber", customer_type AS "customerType",
                customer_name AS "customerName", customer_address AS "customerAddress", TO_CHAR(issue_date, 'YYYY-MM-DD') AS "issueDate",
                TO_CHAR(due_date, 'YYYY-MM-DD') AS "dueDate", quote_reference AS "quoteReference", lines, notes, financial_data AS "financialData"
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
                registration_number AS "registrationNumber", siren, tax_number AS "taxNumber", bank_iban AS "bankIban", bank_bic AS "bankBic", payment_terms AS "paymentTerms", deposit_terms AS "depositTerms",
                footer_note AS "footerNote", logo_data AS "logoData", logo_mime_type AS "logoMimeType"
            FROM depannhome_billing_profiles WHERE owner_id = $1
        `, [getAccountOwnerId(request)])
    ]);
    if (!documentResult.rows[0]) return null;
    return { document: documentResult.rows[0], profile: profileResult.rows[0] || emptyProfile() };
}

function billingPdfFileName(document) {
    const type = document.documentType === "invoice" ? "facture" : "devis";
    const number = String(document.documentNumber || "document").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "");
    return `${type}-${number || "document"}.pdf`;
}

export function createBillingPdf(document, profile) {
    return new Promise((resolve, reject) => {
        const pdf = new PDFDocument({ size: "A4", margin: 44, bufferPages: true, info: { Title: `${document.documentType === "invoice" ? "Facture" : "Devis"} ${document.documentNumber}`, Author: profile.companyName || "Depann'Home Pro" } });
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
        const line = (y, color = "#d7dde3") => pdf.moveTo(margin, y).lineTo(margin + contentWidth, y).lineWidth(1).strokeColor(color).stroke();
        const text = (value, x, y, width, options = {}) => pdf.fillColor(options.color || "#172033").font(options.bold ? "Helvetica-Bold" : "Helvetica").fontSize(options.size || 9).text(String(value || ""), x, y, { width, ...options });
        const formatMoney = value => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(Number(value) || 0);
        const formatDate = value => value ? new Intl.DateTimeFormat("fr-FR").format(new Date(`${value}T12:00:00`)) : "Non renseignée";
        const financialData = document.financialData && typeof document.financialData === "object" ? document.financialData : {};
        const totalHt = (document.lines || []).reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0);
        const grossVat = (document.lines || []).reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0) * Number(item.vatRate || 0) / 100, 0);
        const discountAmount = Math.min(totalHt, financialData.discountMode === "percentage" ? totalHt * Number(financialData.discountAmount || 0) / 100 : Number(financialData.discountAmount || 0));
        const totalVat = totalHt ? grossVat * (totalHt - discountAmount) / totalHt : 0;
        const totalTtc = totalHt - discountAmount + totalVat;
        const aidAmount = Math.min(totalTtc, (Array.isArray(financialData.aids) ? financialData.aids : []).reduce((sum, aid) => sum + (aid.calculationMode === "percentage" ? (totalHt - discountAmount) * Number(aid.amount || 0) / 100 : Number(aid.amount || 0)), 0));
        const remainingAmount = Math.max(0, totalTtc - aidAmount);
        const title = document.documentType === "invoice" ? "FACTURE" : "DEVIS";

        if (profile.logoData && ["image/png", "image/jpeg"].includes(profile.logoMimeType)) {
            try { pdf.image(profile.logoData, margin, margin, { fit: [56, 56] }); } catch { /* Le PDF reste disponible même si le logo est illisible. */ }
        }
        const companyX = profile.logoData ? margin + 68 : margin;
        const companyDetails = [profile.companyName || "Votre structure", profile.legalForm, profile.address, [profile.postalCode, profile.city].filter(Boolean).join(" "), profile.phone ? `Tél. ${profile.phone}` : "", profile.email].filter(Boolean).join("\n");
        text(companyDetails, companyX, margin, 250, { size: 9, lineGap: 2, bold: false });
        text(title, margin + contentWidth - 145, margin, 145, { size: 25, bold: true, align: "right", color: "#172033" });
        text(`N° ${document.documentNumber}${document.quoteReference ? `\nRéf. devis : ${document.quoteReference}` : ""}\nÉmis le ${formatDate(document.issueDate)}${document.dueDate ? `\nÉchéance : ${formatDate(document.dueDate)}` : ""}`, margin + contentWidth - 170, margin + 34, 170, { size: 9, align: "right", lineGap: 2 });
        pdf.y = Math.max(margin + 74, pdf.y) + 15;
        line(pdf.y, "#172033");
        pdf.y += 20;

        const partyY = pdf.y;
        pdf.rect(margin, partyY, 225, 82).fill("#f0f2f4");
        pdf.rect(margin + contentWidth - 225, partyY, 225, 82).fill("#f0f2f4");
        text("ÉMETTEUR", margin + 12, partyY + 10, 200, { size: 8, bold: true });
        text([profile.companyName || "Votre structure", profile.registrationNumber ? `SIRET ${profile.registrationNumber}` : "", profile.taxNumber ? `TVA ${profile.taxNumber}` : ""].filter(Boolean).join("\n"), margin + 12, partyY + 24, 200, { size: 9, lineGap: 2 });
        text("CLIENT", margin + contentWidth - 213, partyY + 10, 200, { size: 8, bold: true });
        text([document.customerName, document.customerAddress].filter(Boolean).join("\n"), margin + contentWidth - 213, partyY + 24, 200, { size: 9, lineGap: 2 });
        pdf.y = partyY + 100;
        text("OBJET / PRESTATION", margin, pdf.y, contentWidth, { size: 8, bold: true });
        text(document.documentType === "invoice" ? "Prestation facturée" : "Proposition de prestation", margin, pdf.y + 12, contentWidth, { size: 9 });
        pdf.y += 32;

        const columns = [margin, margin + 205, margin + 255, margin + 300, margin + 390, margin + 440];
        const drawTableHeader = () => {
            ensureSpace(28);
            pdf.rect(margin, pdf.y, contentWidth, 22).fill("#172033");
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
            pdf.rect(margin, y, contentWidth, rowHeight).lineWidth(.5).strokeColor("#d7dde3").stroke();
            text(item.description, columns[0] + 5, y + 6, 190, { size: 8, lineGap: 2 });
            text(item.quantity, columns[1] + 3, y + 6, 40, { size: 8, align: "right" });
            text(item.unit, columns[2] + 4, y + 6, 34, { size: 8 });
            text(formatMoney(item.unitPrice), columns[3] + 3, y + 6, 76, { size: 8, align: "right" });
            text(`${item.vatRate || 0} %`, columns[4] + 3, y + 6, 38, { size: 8, align: "right" });
            text(formatMoney(Number(item.quantity || 0) * Number(item.unitPrice || 0)), columns[5] + 3, y + 6, 60, { size: 8, align: "right" });
            pdf.y += rowHeight;
        });

        ensureSpace(150);
        pdf.y += 18;
        const summaryY = pdf.y;
        text("CONDITIONS DE RÈGLEMENT", margin, summaryY, 260, { size: 9, bold: true });
        const conditions = [
            financialData.conditions || financialData.comments || document.notes || profile.paymentTerms || "Conditions de règlement non renseignées.",
            document.documentType === "quote" && profile.depositTerms ? `Acompte : ${profile.depositTerms}` : "",
            document.documentType === "invoice" && profile.bankIban ? `Règlement par virement · IBAN : ${profile.bankIban}${profile.bankBic ? ` · BIC : ${profile.bankBic}` : ""}` : ""
        ].filter(Boolean).join("\n");
        text(conditions, margin, summaryY + 14, 260, { size: 8, lineGap: 2 });
        const totalX = margin + contentWidth - 180;
        [["Total HT", totalHt, "#172033"], ["Total TVA", totalVat, "#172033"], ["Total TTC", totalTtc, "#172033"], [document.documentType === "quote" ? "Reste à charge" : "Net à payer", remainingAmount, "#0a5c36"]].forEach(([label, value, color], index) => {
            const y = summaryY + index * 26;
            pdf.rect(totalX, y, 180, 24).fill(color);
            text(label, totalX + 9, y + 7, 92, { size: index === 2 ? 10 : 8, bold: true, color: "#ffffff" });
            text(formatMoney(value), totalX + 100, y + 6, 72, { size: index === 2 ? 10 : 8, bold: true, color: "#ffffff", align: "right" });
        });
        pdf.y = Math.max(pdf.y, summaryY + 114);
        if (discountAmount || aidAmount) {
            ensureSpace(44);
            const aidLines = (Array.isArray(financialData.aids) ? financialData.aids : []).map(aid => `${aid.name || "Aide"} : ${aid.calculationMode === "percentage" ? `${aid.amount || 0} %` : formatMoney(aid.amount)}`).join(" · ");
            text([discountAmount ? `Remise : ${formatMoney(discountAmount)}` : "", aidLines, aidAmount ? `Total des aides : ${formatMoney(aidAmount)}` : ""].filter(Boolean).join("\n"), margin, pdf.y, contentWidth, { size: 8, color: "#475569", lineGap: 2 });
            pdf.y += 38;
        }
        if (document.documentType === "quote") {
            ensureSpace(82);
            pdf.rect(margin + contentWidth - 245, pdf.y, 245, 70).lineWidth(1).strokeColor("#d7dde3").stroke();
            text("BON POUR ACCORD", margin + contentWidth - 233, pdf.y + 10, 220, { size: 9, bold: true });
            text("Devis accepté avant le début de la prestation.\nDate et signature du client :", margin + contentWidth - 233, pdf.y + 25, 220, { size: 8, lineGap: 3 });
            pdf.y += 78;
        }
        if (profile.footerNote) {
            ensureSpace(42);
            line(pdf.y, "#d7dde3");
            text(profile.footerNote, margin, pdf.y + 8, contentWidth, { size: 7, color: "#4b5563", align: "center" });
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
        SELECT id, document_number AS "documentNumber"
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

async function hasClient(database, ownerId, clientId) {
    const { rowCount } = await database.query(
        "SELECT 1 FROM depannhome_clients WHERE owner_id = $1 AND client_id = $2",
        [ownerId, clientId]
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

function asyncHandler(handler) {
    return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}
