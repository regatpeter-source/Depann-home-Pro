import crypto from "node:crypto";
import multer from "multer";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { getPool } from "./database.js";
import { getAccountOwnerId } from "./auth.js";

const DOCUMENT_TYPES = new Set(["quote", "invoice", "quitus", "report"]);
const TEMPLATE_MIMES = new Set(["application/pdf", "image/png", "image/jpeg"]);
const MAX_TEMPLATE_BYTES = 10 * 1024 * 1024;
const MAX_RENDERED_PAGES = 200;
const PAGE = { width: 595.28, height: 841.89 };
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_TEMPLATE_BYTES, files: 1 }, fileFilter: (_request, file, callback) => callback(null, TEMPLATE_MIMES.has(file.mimetype)) });

export const DOCUMENT_TEMPLATE_FIELDS = Object.freeze({
    quote: ["QUOTE_NUMBER", "company.name", "company.address", "company.postalCode", "company.city", "company.phone", "company.email", "company.siret", "company.vat", "company.logo", "client.name", "client.firstName", "client.company", "client.address", "client.postalCode", "client.city", "client.phone", "client.email", "document.type", "document.number", "document.quoteNumber", "document.date", "document.validUntil", "document.subject", "document.lines", "document.discountLabel", "document.discount", "document.aids", "document.deposit", "document.subtotal", "document.vat", "document.total", "document.balance", "document.conditions", "document.signature"],
    invoice: ["INVOICE_NUMBER", "company.name", "company.address", "company.postalCode", "company.city", "company.phone", "company.email", "company.siret", "company.vat", "company.logo", "client.name", "client.firstName", "client.company", "client.address", "client.postalCode", "client.city", "client.phone", "client.email", "document.type", "document.number", "document.invoiceNumber", "document.date", "document.dueDate", "document.lines", "document.discountLabel", "document.discount", "document.aids", "document.deposit", "document.subtotal", "document.vat", "document.total", "document.balance", "document.status", "document.payment"],
    quitus: ["QUITUS_NUMBER", "company.name", "company.address", "company.phone", "company.email", "company.logo", "client.name", "client.address", "client.phone", "client.email", "document.type", "document.number", "document.quitusNumber", "document.intervention", "document.date", "document.services", "document.observations", "document.signature"],
    report: ["REPORT_NUMBER", "company.name", "company.address", "company.phone", "company.email", "company.logo", "client.name", "client.address", "client.phone", "client.email", "document.type", "document.number", "document.reportNumber", "document.interventionNumber", "document.insurance", "document.claimNumber", "document.technician", "document.date", "document.photos", "document.observations", "document.conclusion", "document.recommendations", "document.signature"]
});

export async function initializeDocumentTemplates() {
    const database = getPool();
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_document_templates (
            id BIGSERIAL PRIMARY KEY,
            owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            document_type VARCHAR(20) NOT NULL CHECK (document_type IN ('quote','invoice','quitus','report')),
            version INTEGER NOT NULL CHECK (version > 0),
            status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
            name VARCHAR(160) NOT NULL DEFAULT '',
            source_filename VARCHAR(255) NOT NULL DEFAULT '',
            source_mime_type VARCHAR(100) NOT NULL DEFAULT '',
            source_data BYTEA NOT NULL,
            source_hash VARCHAR(64) NOT NULL,
            definition JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
            activated_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(owner_id, document_type, version)
        )
    `);
    await database.query("CREATE UNIQUE INDEX IF NOT EXISTS depannhome_document_templates_active_idx ON depannhome_document_templates(owner_id, document_type) WHERE status='active'");
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_document_templates_owner_idx ON depannhome_document_templates(owner_id, document_type, version DESC)");
    await migrateLegacyTemplates(database);
}

async function migrateLegacyTemplates(database) {
    const legacy = [
        ["quote", "quote_template_filename", "quote_template_mime_type", "quote_template_data"],
        ["invoice", "quote_template_filename", "quote_template_mime_type", "quote_template_data"],
        ["quitus", "quitus_template_filename", "quitus_template_mime_type", "quitus_template_data"],
        ["report", "report_file_template_filename", "report_file_template_mime_type", "report_file_template_data"]
    ];
    for (const [type, filename, mime, data] of legacy) {
        const { rows } = await database.query(`SELECT owner_id,${filename} AS filename,${mime} AS mime,${data} AS data FROM depannhome_billing_profiles WHERE ${data} IS NOT NULL AND ${mime} IN ('application/pdf','image/png','image/jpeg')`);
        for (const row of rows) {
            if (!Buffer.isBuffer(row.data) || !row.data.length) continue;
            try { await inspectSource(row.data, row.mime); } catch { console.warn(`Ancien modèle ${type} ignoré pour l’entreprise ${row.owner_id} : fichier illisible.`); continue; }
            await database.query("INSERT INTO depannhome_document_templates(owner_id,document_type,version,status,name,source_filename,source_mime_type,source_data,source_hash,definition) VALUES($1::bigint,$2::varchar,1,'draft',$3::varchar,$4::varchar,$5::varchar,$6::bytea,$7::varchar,'{}'::jsonb) ON CONFLICT(owner_id,document_type,version) DO NOTHING", [row.owner_id, type, `Ancien modèle ${label(type)} à configurer`, row.filename, row.mime, row.data, crypto.createHash("sha256").update(row.data).digest("hex")]);
        }
    }
}

export function registerDocumentTemplateRoutes(app, requireAuthentication) {
    app.use("/api/document-templates", requireAuthentication, requireTemplateAdministration);
    app.get("/api/document-templates/:documentType", asyncHandler(async (request, response) => {
        const type = documentType(request.params.documentType);
        if (!type) return response.status(404).json({ message: "Type de document inconnu." });
        const ownerId = getAccountOwnerId(request);
        const { rows } = await getPool().query(`SELECT id,document_type AS "documentType",version,status,name,source_filename AS "sourceFilename",source_mime_type AS "sourceMimeType",source_data AS "sourceData",definition,created_at AS "createdAt",updated_at AS "updatedAt",activated_at AS "activatedAt" FROM depannhome_document_templates WHERE owner_id=$1 AND document_type=$2 ORDER BY version DESC`, [ownerId, type]);
        const templates = [];
        for (const row of rows) {
            const parsed = sanitizeDefinition(row.definition, type);
            const definition = parsed.ok ? parsed.value : defaultDefinition(type, await inspectSource(row.sourceData, row.sourceMimeType));
            const { sourceData, ...publicRow } = row;
            templates.push({ ...publicRow, definition });
        }
        let inheritedFromQuote = null;
        if (type === "invoice" && !templates.some(template => template.status === "active")) {
            const inherited = await getPool().query("SELECT id,version,name FROM depannhome_document_templates WHERE owner_id=$1 AND document_type='quote' AND status='active' LIMIT 1", [ownerId]);
            inheritedFromQuote = inherited.rows[0] || null;
        }
        response.json({ documentType: type, fields: DOCUMENT_TEMPLATE_FIELDS[type], templates, inheritedFromQuote });
    }));
    for (const action of ["preview", "test"]) app.post(`/api/document-templates/invoice/inherited/${action}`, asyncHandler(async (request, response) => {
        const ownerId = getAccountOwnerId(request);
        const { rows } = await getPool().query("SELECT * FROM depannhome_document_templates WHERE owner_id=$1 AND document_type='quote' AND status='active' LIMIT 1", [ownerId]);
        if (!rows[0]) return response.status(404).json({ message: "Activez d’abord un modèle de devis à utiliser comme référence." });
        const output = await renderCustomDocumentTemplate(inheritQuoteTemplateForInvoice(rows[0]), sampleModel("invoice", action === "test"));
        response.set({ "Content-Type": "application/pdf", "Content-Disposition": "inline", "Cache-Control": "private, no-store", "X-Template-Warnings": encodeURIComponent(JSON.stringify(output.warnings.slice(0, 20))) });
        response.send(output.buffer);
    }));
    app.post("/api/document-templates/:documentType", upload.single("template"), asyncHandler(async (request, response) => {
        const type = documentType(request.params.documentType);
        if (!type) return response.status(404).json({ message: "Type de document inconnu." });
        if (await templatePolicy(getAccountOwnerId(request), type) === "integrated_only") return response.status(403).json({ message: "Le Créateur impose le modèle Depann’Home Pro pour ce type de document." });
        if (!request.file || !TEMPLATE_MIMES.has(request.file.mimetype)) return response.status(400).json({ message: "Importez un PDF, PNG ou JPEG valide (10 Mo maximum)." });
        const source = await inspectSource(request.file.buffer, request.file.mimetype);
        const ownerId = getAccountOwnerId(request);
        const next = await getPool().query("SELECT COALESCE(MAX(version),0)+1 AS version FROM depannhome_document_templates WHERE owner_id=$1 AND document_type=$2", [ownerId, type]);
        const definition = defaultDefinition(type, source);
        const { rows } = await getPool().query(`INSERT INTO depannhome_document_templates(owner_id,document_type,version,name,source_filename,source_mime_type,source_data,source_hash,definition,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING id,version,status,definition`, [ownerId, type, next.rows[0].version, clean(request.body?.name, 160) || `Modèle ${label(type)} v${next.rows[0].version}`, safeFilename(request.file.originalname), request.file.mimetype, request.file.buffer, crypto.createHash("sha256").update(request.file.buffer).digest("hex"), JSON.stringify(definition), request.user.sub]);
        response.status(201).json({ template: rows[0] });
    }));
    app.get("/api/document-templates/:documentType/:templateId/source", asyncHandler(async (request, response) => {
        const template = await ownedTemplate(request);
        if (!template) return response.status(404).json({ message: "Modèle introuvable." });
        response.set({ "Content-Type": template.source_mime_type, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
        response.send(template.source_data);
    }));
    app.put("/api/document-templates/:documentType/:templateId", asyncHandler(async (request, response) => {
        const type = documentType(request.params.documentType); const id = positiveId(request.params.templateId);
        if (!type || !id) return response.status(400).json({ message: "Modèle invalide." });
        const definition = sanitizeDefinition(request.body?.definition, type);
        if (!definition.ok) return response.status(400).json({ message: definition.message });
        const result = await getPool().query("UPDATE depannhome_document_templates SET name=$4,definition=$5::jsonb,updated_at=NOW() WHERE id=$1 AND owner_id=$2 AND document_type=$3 AND status<>'archived'", [id, getAccountOwnerId(request), type, clean(request.body?.name, 160) || `Modèle ${label(type)}`, JSON.stringify(definition.value)]);
        if (!result.rowCount) return response.status(404).json({ message: "Modèle introuvable." });
        response.status(204).end();
    }));
    app.post("/api/document-templates/:documentType/:templateId/activate", asyncHandler(async (request, response) => {
        const type = documentType(request.params.documentType); const id = positiveId(request.params.templateId); const ownerId = getAccountOwnerId(request);
        if (!type || !id) return response.status(400).json({ message: "Modèle invalide." });
        if (await templatePolicy(ownerId, type) === "integrated_only") return response.status(403).json({ message: "Le Créateur impose le modèle Depann’Home Pro pour ce type de document." });
        const connection = await getPool().connect();
        try {
            await connection.query("BEGIN");
            const target = await connection.query("SELECT definition FROM depannhome_document_templates WHERE id=$1 AND owner_id=$2 AND document_type=$3 AND status<>'archived' FOR UPDATE", [id, ownerId, type]);
            if (!target.rows[0]) { await connection.query("ROLLBACK"); return response.status(404).json({ message: "Modèle introuvable." }); }
            const validation = validateActivation(target.rows[0].definition, type);
            if (validation.length) { await connection.query("ROLLBACK"); return response.status(409).json({ message: validation.join(" "), warnings: validation }); }
            await connection.query("UPDATE depannhome_document_templates SET status='draft',activated_at=NULL,updated_at=NOW() WHERE owner_id=$1 AND document_type=$2 AND status='active'", [ownerId, type]);
            await connection.query("UPDATE depannhome_document_templates SET status='active',activated_at=NOW(),updated_at=NOW() WHERE id=$1", [id]);
            await connection.query("COMMIT");
            response.status(204).end();
        } catch (error) { await connection.query("ROLLBACK"); throw error; } finally { connection.release(); }
    }));
    app.post("/api/document-templates/:documentType/native", asyncHandler(async (request, response) => {
        const type = documentType(request.params.documentType); if (!type) return response.status(404).json({ message: "Type de document inconnu." });
        if (await templatePolicy(getAccountOwnerId(request), type) === "external_only") return response.status(403).json({ message: "Le Créateur impose un modèle personnalisé actif pour ce type de document." });
        await getPool().query("UPDATE depannhome_document_templates SET status='draft',activated_at=NULL,updated_at=NOW() WHERE owner_id=$1 AND document_type=$2 AND status='active'", [getAccountOwnerId(request), type]);
        response.status(204).end();
    }));
    for (const action of ["preview", "test"]) app.post(`/api/document-templates/:documentType/:templateId/${action}`, asyncHandler(async (request, response) => {
        const template = await ownedTemplate(request); if (!template) return response.status(404).json({ message: "Modèle introuvable." });
        const definition = sanitizeDefinition(request.body?.definition || template.definition, template.document_type);
        if (!definition.ok) return response.status(400).json({ message: definition.message });
        const sample = sampleModel(template.document_type, action === "test");
        const output = await renderCustomDocumentTemplate({ ...template, definition: definition.value }, sample);
        response.set({ "Content-Type": "application/pdf", "Content-Disposition": "inline", "Cache-Control": "private, no-store", "X-Template-Warnings": encodeURIComponent(JSON.stringify(output.warnings.slice(0, 20))) });
        response.send(output.buffer);
    }));
}

export function documentTemplateUploadErrorHandler(error, _request, response, next) {
    if (error instanceof multer.MulterError) return response.status(400).json({ message: "Le modèle doit faire au maximum 10 Mo." });
    return next(error);
}

export async function renderActiveCustomTemplate(ownerId, documentTypeValue, model) {
    if (!ownerId || !DOCUMENT_TYPES.has(documentTypeValue)) return null;
    const policyColumn = documentTypeValue === "quitus" ? "quitus_template_policy" : documentTypeValue === "report" ? "report_template_policy" : "quote_template_policy";
    const inheritedType = documentTypeValue === "invoice" ? "quote" : documentTypeValue;
    const { rows } = await getPool().query(`SELECT template.* FROM depannhome_document_templates template JOIN depannhome_users owner ON owner.id=template.owner_id WHERE template.owner_id=$1 AND template.document_type IN ($2::varchar,$3::varchar) AND template.status='active' AND owner.${policyColumn}<>'integrated_only' ORDER BY CASE WHEN template.document_type=$2::varchar THEN 0 ELSE 1 END LIMIT 1`, [ownerId, documentTypeValue, inheritedType]);
    if (!rows[0]) return null;
    const selected = documentTypeValue === "invoice" && rows[0].document_type === "quote" ? inheritQuoteTemplateForInvoice(rows[0]) : rows[0];
    const output = await renderCustomDocumentTemplate(selected, model);
    return { buffer: output.buffer, filename: `${documentTypeValue}-${safeFilename(model?.document?.number || model?.document?.id || "document")}.pdf`, mimeType: "application/pdf" };
}

export function inheritQuoteTemplateForInvoice(template) {
    const replacements = new Map([
        ["QUOTE_NUMBER", "INVOICE_NUMBER"],
        ["document.quoteNumber", "document.invoiceNumber"],
        ["document.validUntil", "document.dueDate"],
        ["document.conditions", "document.payment"]
    ]);
    const definition = structuredClone(template.definition || {});
    definition.zones = (definition.zones || []).map(zone => ({ ...zone, field: replacements.get(zone.field) || zone.field }));
    return { ...template, document_type: "invoice", definition };
}

export function buildBillingCustomModel(document, profile = {}) {
    const lines = Array.isArray(document.lines) ? document.lines : [];
    const grossHt = lines.reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unitPrice || 0), 0);
    const financial = document.financialData && typeof document.financialData === "object" ? document.financialData : {};
    const discount = Math.min(grossHt, financial.discountMode === "percentage" ? grossHt * Number(financial.discountAmount || 0) / 100 : Number(financial.discountAmount || 0));
    const netHt = Math.max(0, grossHt - discount);
    const grossVat = lines.reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unitPrice || 0) * Number(line.vatRate || 0) / 100, 0);
    const vat = grossHt ? grossVat * netHt / grossHt : 0;
    const aids = Array.isArray(financial.aids) ? financial.aids : [];
    const aidTotal = aids.reduce((sum, aid) => sum + (aid.calculationMode === "percentage" ? netHt * Number(aid.amount || 0) / 100 : Number(aid.amount || 0)), 0);
    const deposit = Number(financial.depositAmount || 0);
    const currentClient = document.clientData && typeof document.clientData === "object" ? document.clientData : {};
    const clientName = currentClient.name || [currentClient.firstName, currentClient.lastName].filter(Boolean).join(" ") || document.customerName || "";
    const clientAddress = [currentClient.address, currentClient.postalCode, currentClient.city].filter(Boolean).join(", ") || document.customerAddress || "";
    const documentNumber = document.documentNumber || "";
    const isInvoice = document.documentType === "invoice";
    return {
        QUOTE_NUMBER: !isInvoice ? documentNumber : "",
        INVOICE_NUMBER: isInvoice ? documentNumber : "",
        company: companyModel(profile),
        client: { name: clientName, firstName: currentClient.firstName || "", company: currentClient.company || currentClient.companyName || (document.customerType === "Professionnel" ? clientName : ""), address: clientAddress, postalCode: currentClient.postalCode || "", city: currentClient.city || "", phone: currentClient.phone || "", email: currentClient.email || "" },
        document: { id: document.id, type: isInvoice ? "FACTURE" : "DEVIS", number: documentNumber, quoteNumber: documentNumber, invoiceNumber: documentNumber, date: document.issueDate || "", validUntil: !isInvoice ? document.dueDate || "" : "", dueDate: isInvoice ? document.dueDate || "" : "", subject: isInvoice ? "Prestation facturée" : "Proposition de prestation", lines, discountLabel: financial.discountLabel || "Remise", discount: money(discount), aids: aids.map(aid => `${aid.name || "Aide"} : ${aid.calculationMode === "percentage" ? `${aid.amount || 0} %` : money(aid.amount)}`).join("\n"), deposit: money(deposit), subtotal: money(netHt), vat: money(vat), total: money(netHt + vat), balance: money(Math.max(0, netHt + vat - aidTotal - deposit)), conditions: financial.conditions || document.notes || profile.paymentTerms || "", signature: "", status: document.status || "", payment: [profile.bankIban ? `IBAN : ${profile.bankIban}` : "", profile.bankBic ? `BIC : ${profile.bankBic}` : "", profile.paymentTerms || ""].filter(Boolean).join("\n") }
    };
}

export function buildQuitusCustomModel(event, quitus, profile = {}) {
    const client = event.clientData && typeof event.clientData === "object" ? event.clientData : {};
    const number = String(event.id || "");
    return { QUITUS_NUMBER: number, company: companyModel(profile), client: { name: client.name || event.clientName || "", address: [client.address, client.postalCode, client.city].filter(Boolean).join(", ") || event.location || "", phone: client.phone || "", email: client.email || "" }, document: { id: event.id, type: "QUITUS", number, quitusNumber: number, date: event.date || "", intervention: event.title || "", services: event.title || "", observations: event.notes || "", signature: quitus.signature || "" } };
}

export function buildReportCustomModel(report, profile = {}) {
    const snapshot = report.content?.snapshot || {};
    const observations = collectReportObservations(report.content);
    const recommendations = report.content?.recommendations || {};
    const conclusion = report.content?.conclusion || {};
    const reportNumber = String(report.id || "");
    const interventionNumber = String(snapshot.interventionNumber || report.appointmentId || "");
    return { REPORT_NUMBER: reportNumber, company: companyModel(profile), client: { name: report.clientName || snapshot.clientName || "", address: report.clientAddress || report.appointmentLocation || snapshot.clientAddress || "", phone: report.clientPhone || snapshot.clientPhone || "", email: report.clientEmail || snapshot.clientEmail || "" }, document: { id: report.id, type: "RAPPORT", number: reportNumber, reportNumber, interventionNumber, date: report.reportDate || snapshot.date || "", insurance: snapshot.insurance || "", claimNumber: snapshot.claimNumber || "", technician: report.technicianName || snapshot.technicianName || "", photos: Array.isArray(report.media) ? report.media : [], observations, conclusion: [conclusion.diagnosis, conclusion.probableOrigin, conclusion.summary, conclusion.finalObservations].filter(Boolean).join("\n"), recommendations: [recommendations.work, recommendations.repairs, recommendations.urgency, recommendations.customerAdvice].filter(Boolean).join("\n"), signature: recommendations.clientSignature || recommendations.technicianSignature || "" } };
}

function companyModel(profile) { return { name: profile.companyName || "", address: profile.address || "", postalCode: profile.postalCode || "", city: profile.city || "", phone: profile.phone || "", email: profile.email || "", siret: profile.registrationNumber || "", vat: profile.taxNumber || "", logo: profile.logoData && profile.logoMimeType ? `data:${profile.logoMimeType};base64,${Buffer.from(profile.logoData).toString("base64")}` : "" }; }
function collectReportObservations(content) {
    const entries = []; const ignored = new Set(["id", "createdAt", "activeStep", "schemaVersion", "keepTogether", "pageBreakBefore", "technicianSignature", "clientSignature"]);
    const visit = (value, path = []) => {
        if (Array.isArray(value)) { value.forEach(item => visit(item, path)); return; }
        if (!value || typeof value !== "object") return;
        if (typeof value.text === "string" && value.text.trim()) { entries.push({ text: value.text.trim() }); return; }
        for (const [key, entry] of Object.entries(value)) {
            if (ignored.has(key) || ["snapshot", "conclusion", "recommendations"].includes(key)) continue;
            if (entry && typeof entry === "object") visit(entry, [...path, key]);
            else if ((typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") && String(entry).trim()) entries.push({ text: `${humanLabel(key)} : ${String(entry).trim()}` });
        }
    };
    visit(content || {});
    return entries;
}
function humanLabel(value) { return String(value || "Information").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/^./, letter => letter.toUpperCase()); }

export async function renderCustomDocumentTemplate(template, model) {
    const definition = sanitizeDefinition(template.definition, template.document_type || template.documentType);
    if (!definition.ok) throw templateError(409, definition.message);
    const source = await sourceDocument(template.source_data || template.sourceData, template.source_mime_type || template.sourceMimeType);
    const output = await PDFDocument.create();
    const font = await output.embedFont(StandardFonts.Helvetica);
    const bold = await output.embedFont(StandardFonts.HelveticaBold);
    const zones = definition.value.zones;
    const table = zones.find(zone => zone.type === "table");
    const repeatList = zones.find(zone => zone.type === "repeatText");
    const photos = zones.find(zone => zone.type === "photos");
    const rows = table ? arrayValue(model, table.field) : [];
    const texts = repeatList ? arrayValue(model, repeatList.field) : [];
    const images = photos ? arrayValue(model, photos.field) : [];
    const tableCapacity = table ? Math.max(1, Math.floor((table.height - 22) / Math.max(12, table.style.rowHeight || 18))) : Infinity;
    const textCapacity = repeatList ? Math.max(1, Math.floor(repeatList.height / Math.max(14, repeatList.style.fontSize + 7))) : Infinity;
    const photoCapacity = photos ? Math.max(1, Number(photos.style.columns || 2) * Number(photos.style.rows || 2)) : Infinity;
    const contentPages = Math.max(source.pageCount, Math.ceil(rows.length / tableCapacity) || 1, Math.ceil(texts.length / textCapacity) || 1, Math.ceil(images.length / photoCapacity) || 1);
    const pageCount = (template.document_type || template.documentType) === "report" ? contentPages + 1 : contentPages;
    if (pageCount > MAX_RENDERED_PAGES) throw templateError(413, `Le modèle produirait plus de ${MAX_RENDERED_PAGES} pages. Réduisez les données ou agrandissez les zones extensibles.`);
    const warnings = validateLayout(definition.value, model, { tableCapacity, textCapacity, photoCapacity });
    for (let index = 0; index < pageCount; index += 1) {
        const page = await addBasePage(output, source, Math.min(index, source.pageCount - 1));
        const pageSize = page.getSize();
        for (const zone of zones) {
            if (!zoneApplies(zone, index, pageCount)) continue;
            const effectiveZone = zone.style.followFlow && table && index === pageCount - 1
                ? { ...zone, y: Math.min(zone.y, table.y + 22 + rows.slice(index * tableCapacity, (index + 1) * tableCapacity).length * table.style.rowHeight + zone.style.flowOffset) }
                : zone;
            if (effectiveZone.y !== zone.y && zone.style.eraseSource) drawEraseBox(page, zone, pageSize);
            drawBox(page, effectiveZone, pageSize);
            if (zone.type === "table") { const entries = rows.slice(index * tableCapacity, (index + 1) * tableCapacity); if (entries.length) drawTable(page, entries, effectiveZone, pageSize, font, bold); }
            else if (zone.type === "repeatText") { const entries = texts.slice(index * textCapacity, (index + 1) * textCapacity); if (entries.length) drawRepeatedText(page, entries, zone, pageSize, font, bold); }
            else if (zone.type === "photos") { const entries = images.slice(index * photoCapacity, (index + 1) * photoCapacity); if (entries.length) await drawPhotos(output, page, entries, zone, pageSize, warnings); }
            else if (zone.type === "image" || zone.type === "signature") await drawImageValue(output, page, valueAt(model, zone.field), zone, pageSize);
            else drawTextZone(page, zone.type === "fixed" ? zone.text : valueAt(model, zone.field), effectiveZone, pageSize, font, bold, index, pageCount);
        }
    }
    return { buffer: Buffer.from(await output.save()), warnings };
}

function defaultDefinition(type, source) {
    const zones = [
        zone("document-type", "text", "document.type", 370, 20, 180, 28, { fontSize: 16, bold: true, align: "right" }),
        zone("document-number", "text", "document.number", 370, 38, 180, 28, { fontSize: 15, bold: true, align: "right" }),
        zone("client", "text", "client.name", 330, 110, 220, 55, { fontSize: 10 }),
        zone("client-address", "text", "client.address", 330, 150, 220, 55, { fontSize: 9 }),
        zone("date", "text", "document.date", 40, 110, 180, 24, { fontSize: 9 }),
        zone("footer", "fixed", "", 40, 800, 515, 18, { fontSize: 7, color: "#64748b", align: "center" }, "all")
    ];
    if (["quote", "invoice"].includes(type)) zones.push(zone("lines", "table", "document.lines", 40, 190, 515, 390, { fontSize: 8, rowHeight: 22, headerColor: "#003b73", columns: [0.48, 0.12, 0.18, 0.22] }, "all"), zone("total", "text", "document.total", 380, 610, 175, 32, { fontSize: 13, bold: true, align: "right", followFlow: true, flowOffset: 18 }, "final"), zone("conditions", "text", type === "quote" ? "document.conditions" : "document.payment", 40, 660, 300, 80, { fontSize: 8, followFlow: true, flowOffset: 65 }, "final"));
    if (type === "quitus") zones.push(zone("intervention", "text", "document.intervention", 40, 190, 515, 80, { fontSize: 11 }), zone("observations", "text", "document.observations", 40, 300, 515, 160, { fontSize: 9 }), zone("signature", "signature", "document.signature", 300, 520, 240, 130, {}, "final"));
    if (type === "report") zones.push(zone("observations", "repeatText", "document.observations", 40, 180, 515, 260, { fontSize: 9 }, "all"), zone("photos", "photos", "document.photos", 40, 470, 515, 260, { columns: 2, rows: 2, gap: 8 }, "all"), zone("conclusion", "text", "document.conclusion", 40, 180, 515, 180, { fontSize: 10 }, "final"), zone("recommendations", "text", "document.recommendations", 40, 390, 515, 160, { fontSize: 9 }, "final"), zone("signature", "signature", "document.signature", 330, 590, 210, 110, {}, "final"));
    return { schemaVersion: 1, page: { width: source.width, height: source.height, margins: { top: 30, right: 30, bottom: 30, left: 30 } }, colors: { primary: "#003b73", secondary: "#0a5c36" }, zones };
}

function zone(id, type, field, x, y, width, height, style = {}, page = "first") { return { id, type, field, text: type === "fixed" ? field : "", page, x, y, width, height, style }; }
function sanitizeDefinition(value, type) {
    const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const page = input.page || {}; const margins = page.margins || {};
    const sourceZones = Array.isArray(input.zones) ? input.zones.filter(item => !(item?.id === "company" && item?.field === "company.name" && item?.style?.eraseSource === undefined)).map(item => structuredClone(item)) : [];
    const generatedIds = new Set(sourceZones.map(item => item.id));
    const isLegacyGeneratedDefinition = generatedIds.has("document-number") && generatedIds.has("client") && generatedIds.has("date");
    if (isLegacyGeneratedDefinition && !sourceZones.some(item => item.field === "document.type")) sourceZones.push(zone("document-type", "text", "document.type", 370, 20, 180, 28, { fontSize: 16, bold: true, align: "right", eraseSource: true, backgroundColor: "#ffffff" }));
    if (isLegacyGeneratedDefinition && !sourceZones.some(item => item.field === "client.address")) sourceZones.push(zone("client-address", "text", "client.address", 330, 150, 220, 55, { fontSize: 9, eraseSource: true, backgroundColor: "#ffffff" }));
    const zones = sourceZones.slice(0, 80).map((item, index) => sanitizeZone(item, index, type)).filter(Boolean);
    if (!zones.length) return { ok: false, message: "Ajoutez au moins une zone dynamique au modèle." };
    return { ok: true, value: { schemaVersion: 1, page: { width: bounded(page.width, 300, 1200, PAGE.width), height: bounded(page.height, 400, 1700, PAGE.height), margins: { top: bounded(margins.top, 0, 200, 30), right: bounded(margins.right, 0, 200, 30), bottom: bounded(margins.bottom, 0, 200, 30), left: bounded(margins.left, 0, 200, 30) } }, colors: { primary: color(input.colors?.primary, "#003b73"), secondary: color(input.colors?.secondary, "#0a5c36") }, zones } };
}
function sanitizeZone(item, index, type) {
    const permitted = new Set(["text", "fixed", "table", "image", "signature", "photos", "repeatText"]); const zoneType = permitted.has(item?.type) ? item.type : "text";
    const field = clean(item?.field, 100); if (zoneType !== "fixed" && !DOCUMENT_TEMPLATE_FIELDS[type]?.includes(field)) return null;
    return { id: clean(item?.id, 100) || `zone-${index + 1}`, type: zoneType, field, text: cleanMultiline(item?.text, 2000), page: ["first", "all", "final"].includes(item?.page) ? item.page : "first", x: bounded(item?.x, 0, 1200, 40), y: bounded(item?.y, 0, 1700, 40), width: bounded(item?.width, 20, 1200, 200), height: bounded(item?.height, 12, 1700, 40), style: { fontSize: bounded(item?.style?.fontSize, 5, 36, 10), bold: Boolean(item?.style?.bold), align: ["left", "center", "right"].includes(item?.style?.align) ? item.style.align : "left", color: color(item?.style?.color, "#172033"), eraseSource: zoneType === "fixed" ? Boolean(item?.style?.eraseSource) : item?.style?.eraseSource !== false, erasePadding: bounded(item?.style?.erasePadding, 0, 20, 3), backgroundColor: color(item?.style?.backgroundColor, "#ffffff"), borderColor: color(item?.style?.borderColor, ""), borderWidth: bounded(item?.style?.borderWidth, 0, 8, 0), rowHeight: bounded(item?.style?.rowHeight, 12, 60, 20), headerColor: color(item?.style?.headerColor, "#003b73"), columns: Array.isArray(item?.style?.columns) ? item.style.columns.slice(0, 6).map(Number) : undefined, rows: bounded(item?.style?.rows, 1, 6, 2), gap: bounded(item?.style?.gap, 0, 30, 8), followFlow: Boolean(item?.style?.followFlow), flowOffset: bounded(item?.style?.flowOffset, 0, 300, 18) } };
}
function validateActivation(definition, type) { const parsed = sanitizeDefinition(definition, type); if (!parsed.ok) return [parsed.message]; const fields = new Set(parsed.value.zones.map(zone => zone.field)); const required = type === "quote" || type === "invoice" ? ["document.type", "document.number", "client.name", "document.lines", "document.total"] : type === "quitus" ? ["document.number", "client.name", "document.intervention", "document.signature"] : ["document.number", "client.name", "document.observations", "document.photos", "document.conclusion"]; return required.filter(field => !fields.has(field)).map(field => `Zone obligatoire absente : ${field}.`); }
function validateLayout(definition, model, capacity) { const warnings = []; for (const zone of definition.zones) if (zone.x + zone.width > definition.page.width || zone.y + zone.height > definition.page.height) warnings.push(`La zone « ${zone.id} » dépasse la page.`); for (let first = 0; first < definition.zones.length; first += 1) for (let second = first + 1; second < definition.zones.length; second += 1) { const a = definition.zones[first]; const b = definition.zones[second]; const samePage = a.page === "all" || b.page === "all" || a.page === b.page; if (samePage && !a.style.followFlow && !b.style.followFlow && rectanglesOverlap(a, b)) warnings.push(`Les zones « ${a.id} » et « ${b.id} » se chevauchent.`); } if (arrayValue(model, "document.lines").length > capacity.tableCapacity) warnings.push("Le tableau est automatiquement réparti sur plusieurs pages."); if (arrayValue(model, "document.photos").length > capacity.photoCapacity) warnings.push("Les photos sont automatiquement réparties sur plusieurs pages."); return [...new Set(warnings)]; }
function rectanglesOverlap(a, b) { return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y; }

async function inspectSource(buffer, mimeType) { if (mimeType === "application/pdf") { const pdf = await PDFDocument.load(buffer); if (!pdf.getPageCount()) throw templateError(400, "Le PDF ne contient aucune page."); const size = pdf.getPage(0).getSize(); return { pageCount: pdf.getPageCount(), width: size.width, height: size.height }; } const probe = await PDFDocument.create(); const image = mimeType === "image/png" ? await probe.embedPng(buffer) : await probe.embedJpg(buffer); const scale = Math.min(PAGE.width / image.width, PAGE.height / image.height); return { pageCount: 1, width: image.width * scale, height: image.height * scale }; }
async function sourceDocument(buffer, mimeType) { if (!Buffer.isBuffer(buffer) || !buffer.length) throw templateError(409, "Le fichier source du modèle est introuvable."); if (mimeType === "application/pdf") { const pdf = await PDFDocument.load(buffer); return { kind: "pdf", pdf, pageCount: pdf.getPageCount() }; } return { kind: "image", buffer, mimeType, pageCount: 1 }; }
async function addBasePage(output, source, index) { if (source.kind === "pdf") { const [page] = await output.copyPages(source.pdf, [index]); output.addPage(page); return page; } const image = source.mimeType === "image/png" ? await output.embedPng(source.buffer) : await output.embedJpg(source.buffer); const scale = Math.min(PAGE.width / image.width, PAGE.height / image.height); const page = output.addPage([image.width * scale, image.height * scale]); page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() }); return page; }
function drawTextZone(page, raw, zone, size, font, bold, pageIndex, pageCount) { const value = String(raw ?? "").replaceAll("{{page}}", String(pageIndex + 1)).replaceAll("{{pages}}", String(pageCount)); drawWrapped(page, value, zone, size, zone.style.bold ? bold : font); }
function drawRepeatedText(page, entries, zone, size, font, bold) { const text = entries.map((entry, index) => `${index + 1}. ${typeof entry === "string" ? entry : entry.text || JSON.stringify(entry)}`).join("\n\n"); drawWrapped(page, text, zone, size, zone.style.bold ? bold : font); }
function drawTable(page, rows, zone, size, font, bold) { const x = zone.x; let y = size.height - zone.y; const rowHeight = zone.style.rowHeight; const widths = normalizedColumns(zone.style.columns || [0.48, 0.12, 0.18, 0.22], zone.width); const headers = ["Désignation", "Qté", "PU HT", "Total HT"]; page.drawRectangle({ x, y: y - rowHeight, width: zone.width, height: rowHeight, color: pdfColor(zone.style.headerColor, "#003b73") }); let cursor = x; headers.forEach((header, index) => { page.drawText(header, { x: cursor + 4, y: y - rowHeight + 6, size: Math.min(zone.style.fontSize, 9), font: bold, color: rgb(1, 1, 1), maxWidth: widths[index] - 8 }); cursor += widths[index]; }); y -= rowHeight; for (const row of rows) { cursor = x; const values = [row.description || row.label || "", row.quantity ?? "", money(row.unitPrice), money(Number(row.quantity || 0) * Number(row.unitPrice || 0))]; values.forEach((value, index) => { page.drawText(String(value), { x: cursor + 4, y: y - rowHeight + 6, size: zone.style.fontSize, font, color: pdfColor(zone.style.color), maxWidth: widths[index] - 8 }); cursor += widths[index]; }); page.drawLine({ start: { x, y: y - rowHeight }, end: { x: x + zone.width, y: y - rowHeight }, thickness: .5, color: rgb(.82, .85, .88) }); y -= rowHeight; } }
async function drawPhotos(output, page, images, zone, size, warnings) { const columns = zone.style.columns && !Array.isArray(zone.style.columns) ? Number(zone.style.columns) : Number(zone.style.columnsCount || 2); const cols = Number.isFinite(columns) ? Math.max(1, columns) : 2; const rows = zone.style.rows; const gap = zone.style.gap; const width = (zone.width - gap * (cols - 1)) / cols; const height = (zone.height - gap * (rows - 1)) / rows; for (const [index, entry] of images.entries()) { const data = dataImage(entry?.dataUrl || entry); if (!data) { warnings.push(`Photo ${index + 1} ignorée : format invalide.`); continue; } try { const image = data.mime === "image/png" ? await output.embedPng(data.buffer) : await output.embedJpg(data.buffer); const fit = Math.min(width / image.width, height / image.height); const col = index % cols; const row = Math.floor(index / cols); page.drawImage(image, { x: zone.x + col * (width + gap), y: size.height - zone.y - (row + 1) * height - row * gap, width: image.width * fit, height: image.height * fit }); } catch { warnings.push(`Photo ${index + 1} ignorée : image illisible.`); } } }
async function drawImageValue(output, page, value, zone, size) { const data = dataImage(value); if (!data) return; try { const image = data.mime === "image/png" ? await output.embedPng(data.buffer) : await output.embedJpg(data.buffer); const fit = Math.min(zone.width / image.width, zone.height / image.height); page.drawImage(image, { x: zone.x, y: size.height - zone.y - image.height * fit, width: image.width * fit, height: image.height * fit }); } catch { /* Image facultative. */ } }
function drawEraseBox(page, zone, size) { const padding = zone.style.erasePadding || 0; page.drawRectangle({ x: Math.max(0, zone.x - padding), y: Math.max(0, size.height - zone.y - zone.height - padding), width: Math.min(size.width - Math.max(0, zone.x - padding), zone.width + padding * 2), height: Math.min(size.height, zone.height + padding * 2), color: pdfColor(zone.style.backgroundColor, "#ffffff") }); }
function drawBox(page, zone, size) { if (zone.style.eraseSource) drawEraseBox(page, zone, size); if (zone.style.borderColor && zone.style.borderWidth) page.drawRectangle({ x: zone.x, y: size.height - zone.y - zone.height, width: zone.width, height: zone.height, borderColor: pdfColor(zone.style.borderColor), borderWidth: zone.style.borderWidth }); }
function drawWrapped(page, value, zone, size, font) { const fontSize = zone.style.fontSize; const lines = wrapText(String(value || ""), font, fontSize, zone.width - 6); const max = Math.max(1, Math.floor((zone.height - 4) / (fontSize + 3))); lines.slice(0, max).forEach((line, index) => { const lineWidth = font.widthOfTextAtSize(line, fontSize); const x = zone.style.align === "right" ? zone.x + zone.width - lineWidth - 3 : zone.style.align === "center" ? zone.x + Math.max(3, (zone.width - lineWidth) / 2) : zone.x + 3; page.drawText(line, { x, y: size.height - zone.y - fontSize - 2 - index * (fontSize + 3), size: fontSize, font, color: pdfColor(zone.style.color), maxWidth: zone.width - 6 }); }); }
function wrapText(value, font, size, width) { const result = []; for (const paragraph of value.split(/\r?\n/)) { let line = ""; for (const word of paragraph.split(/\s+/)) { const next = line ? `${line} ${word}` : word; if (line && font.widthOfTextAtSize(next, size) > width) { result.push(line); line = word; } else line = next; } result.push(line); } return result; }
function normalizedColumns(columns, width) { const total = columns.reduce((sum, value) => sum + (Number(value) || 0), 0) || 1; return columns.map(value => width * (Number(value) || 0) / total); }
function zoneApplies(zone, index, count) { return zone.page === "all" || (zone.page === "first" && index === 0) || (zone.page === "final" && index === count - 1); }
function valueAt(object, path) { return String(path || "").split(".").reduce((value, key) => value?.[key], object); }
function arrayValue(object, path) { const value = valueAt(object, path); return Array.isArray(value) ? value : []; }
function sampleModel(type, stress) { const lines = Array.from({ length: stress ? 32 : 6 }, (_, index) => ({ description: `Prestation fictive ${index + 1} — description détaillée de contrôle et intervention`, quantity: index % 3 + 1, unit: "forfait", unitPrice: 125.5 + index * 17, vatRate: 20 })); const observations = Array.from({ length: stress ? 24 : 5 }, (_, index) => ({ text: `Observation ${index + 1} : contrôle détaillé avec un texte volontairement long pour vérifier les retours à la ligne, les limites et la pagination automatique.` })); const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="; const total = lines.reduce((sum, line) => sum + line.quantity * line.unitPrice * 1.2, 0); return { company: { name: "Entreprise de démonstration", address: "12 avenue des Artisans", postalCode: "44000", city: "Nantes", phone: "02 00 00 00 00", email: "contact@exemple.fr", siret: "123 456 789 00012", vat: "FR00123456789", logo: pixel }, client: { name: "Camille Martin — Société Exemple", address: "25 rue du Client, 44000 Nantes" }, document: { id: "TEST", number: `${type.toUpperCase()}-TEST-2026`, date: "17/08/2026", dueDate: "17/09/2026", subject: "Intervention de démonstration", lines, discount: "150,00 €", subtotal: money(total / 1.2), vat: money(total / 6), total: money(total), conditions: "Conditions fictives détaillées. Paiement à réception.", payment: "Virement bancaire — IBAN fictif", status: "Brouillon", intervention: "Recherche de fuite et contrôle des réseaux", services: lines.map(line => line.description).join("\n"), observations, photos: Array.from({ length: stress ? 10 : 4 }, (_, index) => ({ dataUrl: pixel, caption: `Photo fictive ${index + 1}` })), conclusion: "Conclusion fictive longue : origine probable identifiée après contrôles croisés.", recommendations: "Préconisations fictives : réparation localisée, remise en état puis contrôle complémentaire.", signature: pixel, insurance: "Assurance Exemple", claimNumber: "SIN-2026-0001", technician: "Alex Technicien" } }; }
function documentType(value) { return DOCUMENT_TYPES.has(value) ? value : ""; }
async function templatePolicy(ownerId, type) { const column = type === "quitus" ? "quitus_template_policy" : type === "report" ? "report_template_policy" : "quote_template_policy"; const { rows } = await getPool().query(`SELECT ${column} AS policy FROM depannhome_users WHERE id=$1`, [ownerId]); return ["integrated_only", "company_choice", "external_only"].includes(rows[0]?.policy) ? rows[0].policy : "company_choice"; }
async function ownedTemplate(request) { const type = documentType(request.params.documentType); const id = positiveId(request.params.templateId); if (!type || !id) return null; const { rows } = await getPool().query("SELECT * FROM depannhome_document_templates WHERE id=$1 AND owner_id=$2 AND document_type=$3", [id, getAccountOwnerId(request), type]); return rows[0] || null; }
function dataImage(value) { const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(String(value || "")); return match ? { mime: match[1], buffer: Buffer.from(match[2], "base64") } : null; }
function pdfColor(value, fallback = "#172033") { const hex = color(value, fallback).replace("#", ""); return rgb(parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255); }
function color(value, fallback) { return /^#[0-9a-fA-F]{6}$/.test(String(value || "")) ? String(value).toLowerCase() : fallback; }
function bounded(value, min, max, fallback) { const number = Number(value); return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback; }
function positiveId(value) { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : 0; }
function clean(value, max) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, max); }
function cleanMultiline(value, max) { return String(value || "").replace(/\r/g, "").trim().slice(0, max); }
function safeFilename(value) { return String(value || "document").replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_").slice(0, 220) || "document"; }
function money(value) { return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(Number(value) || 0); }
function label(type) { return ({ quote: "de devis", invoice: "de facture", quitus: "de quitus", report: "de rapport" })[type] || "de document"; }
function requireTemplateAdministration(request, response, next) { if (request.user?.role !== "admin" || request.user?.deviceType !== "desktop") return response.status(403).json({ message: "L’éditeur de modèles est réservé à l’administrateur sur poste PC." }); return next(); }
function templateError(status, message) { const error = new Error(message); error.status = status; return error; }
function asyncHandler(handler) { return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next); }
