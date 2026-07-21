import multer from "multer";
import { getPool } from "./database.js";

const MAX_LOGO_SIZE = 2 * 1024 * 1024;
const DOCUMENT_TYPES = new Set(["quote", "invoice"]);
const CUSTOMER_TYPES = new Set(["Particulier", "Professionnel", "Magasin", "Autre"]);
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_LOGO_SIZE, files: 1 },
    fileFilter: (request, file, callback) => {
        if (["image/png", "image/jpeg", "image/webp"].includes(file.mimetype)) return callback(null, true);
        return callback(new Error("Seules les images PNG, JPEG ou WebP sont acceptées."));
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
            tax_number VARCHAR(100) NOT NULL DEFAULT '',
            payment_terms VARCHAR(500) NOT NULL DEFAULT '',
            footer_note VARCHAR(1000) NOT NULL DEFAULT '',
            default_quote JSONB,
            logo_data BYTEA,
            logo_mime_type VARCHAR(50) NOT NULL DEFAULT '',
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await database.query(`
        ALTER TABLE depannhome_billing_profiles
        ADD COLUMN IF NOT EXISTS default_quote JSONB
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
            document_type VARCHAR(10) NOT NULL CHECK (document_type IN ('quote', 'invoice')),
            document_number VARCHAR(80) NOT NULL,
            customer_type VARCHAR(30) NOT NULL DEFAULT 'Particulier',
            customer_name VARCHAR(160) NOT NULL DEFAULT '',
            customer_address VARCHAR(500) NOT NULL DEFAULT '',
            issue_date DATE NOT NULL,
            due_date DATE,
            status VARCHAR(30) NOT NULL DEFAULT 'draft',
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
}

export function registerBillingRoutes(app, requireAuthentication) {
    app.get("/api/billing", requireAuthentication, asyncHandler(async (request, response) => {
        const database = getPool();
        const [profileResult, templatesResult, documentsResult] = await Promise.all([
            database.query(`
                SELECT company_name AS "companyName", legal_form AS "legalForm", address, postal_code AS "postalCode", city,
                    phone, email, registration_number AS "registrationNumber", tax_number AS "taxNumber",
                    payment_terms AS "paymentTerms", footer_note AS "footerNote", default_quote AS "defaultQuote",
                    (logo_data IS NOT NULL) AS "hasLogo"
                FROM depannhome_billing_profiles WHERE owner_id = $1
            `, [request.user.sub]),
            database.query(`
                SELECT id, label, description, unit, unit_price::float AS "unitPrice", vat_rate::float AS "vatRate"
                FROM depannhome_billing_templates WHERE owner_id = $1 ORDER BY LOWER(label)
            `, [request.user.sub]),
            database.query(`
                SELECT id, document_type AS "documentType", document_number AS "documentNumber", customer_type AS "customerType",
                    customer_name AS "customerName", customer_address AS "customerAddress", TO_CHAR(issue_date, 'YYYY-MM-DD') AS "issueDate",
                    TO_CHAR(due_date, 'YYYY-MM-DD') AS "dueDate", status, lines, notes, updated_at AS "updatedAt"
                FROM depannhome_billing_documents WHERE owner_id = $1 ORDER BY issue_date DESC, id DESC
            `, [request.user.sub])
        ]);
        response.json({ profile: profileResult.rows[0] || emptyProfile(), templates: templatesResult.rows, documents: documentsResult.rows });
    }));

    app.put("/api/billing/profile", requireAuthentication, upload.single("logo"), asyncHandler(async (request, response) => {
        const profile = sanitizeProfile(request.body);
        const removeLogo = String(request.body?.removeLogo || "") === "true";
        const logo = request.file;
        const database = getPool();
        await database.query(`
            INSERT INTO depannhome_billing_profiles
                (owner_id, company_name, legal_form, address, postal_code, city, phone, email, registration_number, tax_number, payment_terms, footer_note, logo_data, logo_mime_type)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
            ON CONFLICT (owner_id) DO UPDATE SET
                company_name = EXCLUDED.company_name, legal_form = EXCLUDED.legal_form, address = EXCLUDED.address,
                postal_code = EXCLUDED.postal_code, city = EXCLUDED.city, phone = EXCLUDED.phone, email = EXCLUDED.email,
                registration_number = EXCLUDED.registration_number, tax_number = EXCLUDED.tax_number,
                payment_terms = EXCLUDED.payment_terms, footer_note = EXCLUDED.footer_note,
                logo_data = CASE WHEN $15 THEN NULL WHEN $16 THEN EXCLUDED.logo_data ELSE depannhome_billing_profiles.logo_data END,
                logo_mime_type = CASE WHEN $15 THEN '' WHEN $16 THEN EXCLUDED.logo_mime_type ELSE depannhome_billing_profiles.logo_mime_type END,
                updated_at = NOW()
        `, [request.user.sub, profile.companyName, profile.legalForm, profile.address, profile.postalCode, profile.city, profile.phone,
            profile.email, profile.registrationNumber, profile.taxNumber, profile.paymentTerms, profile.footerNote,
            logo?.buffer || null, logo?.mimetype || "", removeLogo, Boolean(logo)]);
        response.status(204).end();
    }));

    app.get("/api/billing/logo", requireAuthentication, asyncHandler(async (request, response) => {
        const { rows } = await getPool().query(
            "SELECT logo_data, logo_mime_type FROM depannhome_billing_profiles WHERE owner_id = $1", [request.user.sub]
        );
        if (!rows[0]?.logo_data) return response.status(404).end();
        response.set({ "Content-Type": rows[0].logo_mime_type, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
        response.send(rows[0].logo_data);
    }));

    app.get("/api/billing/documents/:documentId", requireAuthentication, asyncHandler(async (request, response) => {
        const id = positiveId(request.params.documentId);
        if (!id) return response.status(400).json({ message: "Document invalide." });
        const database = getPool();
        const [documentResult, profileResult] = await Promise.all([
            database.query(`
                SELECT id, document_type AS "documentType", document_number AS "documentNumber", customer_type AS "customerType",
                    customer_name AS "customerName", customer_address AS "customerAddress", TO_CHAR(issue_date, 'YYYY-MM-DD') AS "issueDate",
                    TO_CHAR(due_date, 'YYYY-MM-DD') AS "dueDate", status, lines, notes
                FROM depannhome_billing_documents WHERE id = $1 AND owner_id = $2
            `, [id, request.user.sub]),
            database.query(`
                SELECT company_name AS "companyName", legal_form AS "legalForm", address, postal_code AS "postalCode", city, phone, email,
                    registration_number AS "registrationNumber", tax_number AS "taxNumber", payment_terms AS "paymentTerms",
                    footer_note AS "footerNote", (logo_data IS NOT NULL) AS "hasLogo"
                FROM depannhome_billing_profiles WHERE owner_id = $1
            `, [request.user.sub])
        ]);
        if (!documentResult.rows[0]) return response.status(404).json({ message: "Document introuvable." });
        response.json({ document: documentResult.rows[0], profile: profileResult.rows[0] || emptyProfile() });
    }));

    app.put("/api/billing/default-quote", requireAuthentication, asyncHandler(async (request, response) => {
        const quote = sanitizeQuoteTemplate(request.body);
        if (!quote.ok) return response.status(400).json({ message: quote.message });
        await getPool().query(`
            INSERT INTO depannhome_billing_profiles (owner_id, default_quote)
            VALUES ($1, $2::jsonb)
            ON CONFLICT (owner_id) DO UPDATE SET default_quote = EXCLUDED.default_quote, updated_at = NOW()
        `, [request.user.sub, JSON.stringify(quote.template)]);
        response.status(204).end();
    }));

    app.post("/api/billing/templates", requireAuthentication, asyncHandler(async (request, response) => {
        const template = sanitizeTemplate(request.body);
        if (!template.ok) return response.status(400).json({ message: template.message });
        const { rows } = await getPool().query(`
            INSERT INTO depannhome_billing_templates (owner_id, label, description, unit, unit_price, vat_rate)
            VALUES ($1,$2,$3,$4,$5,$6)
            RETURNING id, label, description, unit, unit_price::float AS "unitPrice", vat_rate::float AS "vatRate"
        `, [request.user.sub, template.label, template.description, template.unit, template.unitPrice, template.vatRate]);
        response.status(201).json({ template: rows[0] });
    }));

    app.delete("/api/billing/templates/:templateId", requireAuthentication, asyncHandler(async (request, response) => {
        const id = positiveId(request.params.templateId);
        if (!id) return response.status(400).json({ message: "Ligne modèle invalide." });
        const result = await getPool().query("DELETE FROM depannhome_billing_templates WHERE id = $1 AND owner_id = $2", [id, request.user.sub]);
        if (!result.rowCount) return response.status(404).json({ message: "Ligne modèle introuvable." });
        response.status(204).end();
    }));

    app.post("/api/billing/documents", requireAuthentication, asyncHandler(async (request, response) => {
        const document = sanitizeDocument(request.body);
        if (!document.ok) return response.status(400).json({ message: document.message });
        try {
            const { rows } = await getPool().query(`
                INSERT INTO depannhome_billing_documents
                    (owner_id, document_type, document_number, customer_type, customer_name, customer_address, issue_date, due_date, status, lines, notes)
                VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::date,$9,$10::jsonb,$11)
                RETURNING id
            `, [request.user.sub, document.documentType, document.documentNumber, document.customerType, document.customerName,
                document.customerAddress, document.issueDate, document.dueDate || null, document.status, JSON.stringify(document.lines), document.notes]);
            response.status(201).json({ id: rows[0].id });
        } catch (error) {
            if (error.code === "23505") return response.status(409).json({ message: "Ce numéro de document existe déjà dans votre compte." });
            throw error;
        }
    }));

    app.put("/api/billing/documents/:documentId", requireAuthentication, asyncHandler(async (request, response) => {
        const id = positiveId(request.params.documentId);
        const document = sanitizeDocument(request.body);
        if (!id) return response.status(400).json({ message: "Document invalide." });
        if (!document.ok) return response.status(400).json({ message: document.message });
        try {
            const result = await getPool().query(`
                UPDATE depannhome_billing_documents SET document_type=$3, document_number=$4, customer_type=$5, customer_name=$6,
                    customer_address=$7, issue_date=$8::date, due_date=$9::date, status=$10, lines=$11::jsonb, notes=$12, updated_at=NOW()
                WHERE id=$1 AND owner_id=$2
            `, [id, request.user.sub, document.documentType, document.documentNumber, document.customerType, document.customerName,
                document.customerAddress, document.issueDate, document.dueDate || null, document.status, JSON.stringify(document.lines), document.notes]);
            if (!result.rowCount) return response.status(404).json({ message: "Document introuvable." });
            response.status(204).end();
        } catch (error) {
            if (error.code === "23505") return response.status(409).json({ message: "Ce numéro de document existe déjà dans votre compte." });
            throw error;
        }
    }));

    app.delete("/api/billing/documents/:documentId", requireAuthentication, asyncHandler(async (request, response) => {
        const id = positiveId(request.params.documentId);
        if (!id) return response.status(400).json({ message: "Document invalide." });
        const result = await getPool().query("DELETE FROM depannhome_billing_documents WHERE id = $1 AND owner_id = $2", [id, request.user.sub]);
        if (!result.rowCount) return response.status(404).json({ message: "Document introuvable." });
        response.status(204).end();
    }));
}

export function billingUploadErrorHandler(error, request, response, next) {
    if (error instanceof multer.MulterError) return response.status(400).json({ message: "Le logo doit faire au maximum 2 Mo." });
    if (error?.message === "Seules les images PNG, JPEG ou WebP sont acceptées.") return response.status(400).json({ message: error.message });
    return next(error);
}

function emptyProfile() {
    return { companyName: "", legalForm: "", address: "", postalCode: "", city: "", phone: "", email: "", registrationNumber: "", taxNumber: "", paymentTerms: "", footerNote: "", defaultQuote: null, hasLogo: false };
}

function sanitizeProfile(value) {
    return {
        companyName: cleanText(value?.companyName, 160), legalForm: cleanText(value?.legalForm, 100), address: cleanText(value?.address, 255),
        postalCode: cleanText(value?.postalCode, 20), city: cleanText(value?.city, 100), phone: cleanText(value?.phone, 50),
        email: cleanText(value?.email, 160), registrationNumber: cleanText(value?.registrationNumber, 100), taxNumber: cleanText(value?.taxNumber, 100),
        paymentTerms: cleanText(value?.paymentTerms, 500), footerNote: cleanText(value?.footerNote, 1000)
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
    const customerType = CUSTOMER_TYPES.has(value?.customerType) ? value.customerType : "Particulier";
    const customerName = cleanText(value?.customerName, 160);
    const customerAddress = cleanText(value?.customerAddress, 500);
    const issueDate = sanitizeDate(value?.issueDate);
    const dueDate = value?.dueDate ? sanitizeDate(value.dueDate) : "";
    const status = cleanText(value?.status, 30) || "draft";
    const notes = cleanText(value?.notes, 2000);
    const lines = sanitizeLines(value?.lines);
    if (!documentType || !documentNumber || !issueDate) return { ok: false, message: "Le type, le numéro et la date sont obligatoires." };
    if (!customerName) return { ok: false, message: "Le nom du client est obligatoire." };
    if (!lines.length) return { ok: false, message: "Ajoutez au moins une ligne." };
    if (value?.dueDate && !dueDate) return { ok: false, message: "La date d'échéance est invalide." };
    return { ok: true, documentType, documentNumber, customerType, customerName, customerAddress, issueDate, dueDate, status, lines, notes };
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

function asyncHandler(handler) {
    return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}
