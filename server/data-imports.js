import crypto from "node:crypto";
import path from "node:path";
import ExcelJS from "exceljs";
import multer from "multer";
import { getPool } from "./database.js";
import { getAccountOwnerId } from "./auth.js";
import { getOrganization } from "./organizations.js";

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_ROWS = 10000;
const SESSION_TTL_MINUTES = 60;
const TYPES = new Set(["clients", "quotes", "invoices", "reports"]);
const STRATEGIES = new Set(["skip", "update", "newOnly"]);
const TYPE_FIELDS = {
    clients: [{ key: "name", label: "Nom client / société", required: true }, { key: "type", label: "Type" }, { key: "phone", label: "Téléphone" }, { key: "email", label: "E-mail" }, { key: "address", label: "Adresse" }, { key: "city", label: "Ville" }, { key: "equipment", label: "Équipements" }, { key: "notes", label: "Notes" }],
    quotes: billingFields("Devis"),
    invoices: billingFields("Facture"),
    reports: [{ key: "title", label: "Titre du rapport", required: true }, { key: "reportDate", label: "Date du rapport", required: true }, { key: "clientName", label: "Nom client" }, { key: "description", label: "Description / conclusion" }, { key: "status", label: "Statut" }]
};
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_SIZE, files: 1 }, fileFilter: (request, file, callback) => callback(null, [".csv", ".xlsx"].includes(path.extname(file.originalname || "").toLowerCase())) });

export async function initializeDataImports() {
    const db = getPool();
    await db.query(`CREATE TABLE IF NOT EXISTS depannhome_data_import_sessions (
        id UUID PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
        user_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE, data_type VARCHAR(20) NOT NULL,
        filename VARCHAR(255) NOT NULL, columns JSONB NOT NULL DEFAULT '[]'::jsonb, rows JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS depannhome_data_import_logs (
        id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
        user_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL, data_type VARCHAR(20) NOT NULL,
        filename VARCHAR(255) NOT NULL, source_rows INTEGER NOT NULL DEFAULT 0, imported_count INTEGER NOT NULL DEFAULT 0,
        duplicate_count INTEGER NOT NULL DEFAULT 0, error_count INTEGER NOT NULL DEFAULT 0,
        duplicate_strategy VARCHAR(20) NOT NULL DEFAULT 'skip', details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.query("CREATE INDEX IF NOT EXISTS depannhome_data_import_logs_owner_created_idx ON depannhome_data_import_logs(owner_id,created_at DESC)");
    await db.query("DELETE FROM depannhome_data_import_sessions WHERE expires_at < NOW()");
}

export function registerDataImportRoutes(app, requireAuthentication) {
    app.use("/api/data-imports", requireAuthentication, requireDesktopAdministrator);
    app.get("/api/data-imports/template", asyncHandler(async (request, response) => {
        const dataType = TYPES.has(request.query?.dataType) ? request.query.dataType : "clients";
        await assertDataImportTypeAccess(request, dataType);
        const workbook = createImportTemplate(dataType);
        const filename = `modele-import-${dataType}.xlsx`;
        response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        response.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        await workbook.xlsx.write(response);
        response.end();
    }));
    app.post("/api/data-imports/analyze", upload.single("file"), asyncHandler(async (request, response) => {
        const dataType = TYPES.has(request.body?.dataType) ? request.body.dataType : "";
        if (!dataType || !request.file) return response.status(400).json({ message: "Choisissez un type de données et un fichier Excel (.xlsx) ou CSV (.csv)." });
        await assertDataImportTypeAccess(request, dataType);
        const parsed = await parseFile(request.file);
        if (!parsed.rows.length) return response.status(400).json({ message: "Le fichier ne contient aucune ligne de données exploitable." });
        const id = crypto.randomUUID(); const ownerId = getAccountOwnerId(request);
        await getPool().query("INSERT INTO depannhome_data_import_sessions(id,owner_id,user_id,data_type,filename,columns,rows,expires_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,NOW()+($8::text || ' minutes')::interval)", [id, ownerId, request.user.sub, dataType, safeFilename(request.file.originalname), JSON.stringify(parsed.columns), JSON.stringify(parsed.rows), SESSION_TTL_MINUTES]);
        response.status(201).json({ sessionId: id, dataType, filename: safeFilename(request.file.originalname), rowCount: parsed.rows.length, columns: parsed.columns, suggestedMapping: suggestMapping(parsed.columns, dataType), readErrors: parsed.errors, fields: TYPE_FIELDS[dataType] });
    }));
    app.post("/api/data-imports/preview", asyncHandler(async (request, response) => {
        const session = await loadSession(request, request.body?.sessionId); await assertDataImportTypeAccess(request, session.data_type); const mapping = sanitizeMapping(request.body?.mapping, session.data_type, session.columns); const duplicateStrategy = strategy(request.body?.duplicateStrategy);
        if (!mapping.ok) return response.status(400).json({ message: mapping.message });
        const analysis = await analyzeImport(getAccountOwnerId(request), session, mapping.value, duplicateStrategy);
        const { records, ...preview } = analysis;
        response.json(preview);
    }));
    app.post("/api/data-imports/confirm", asyncHandler(async (request, response) => {
        const session = await loadSession(request, request.body?.sessionId); await assertDataImportTypeAccess(request, session.data_type); const mapping = sanitizeMapping(request.body?.mapping, session.data_type, session.columns); const duplicateStrategy = strategy(request.body?.duplicateStrategy);
        if (!mapping.ok) return response.status(400).json({ message: mapping.message });
        const analysis = await analyzeImport(getAccountOwnerId(request), session, mapping.value, duplicateStrategy);
        const result = await performImport(request, session, analysis.records, duplicateStrategy, analysis.errors);
        await getPool().query("DELETE FROM depannhome_data_import_sessions WHERE id=$1 AND owner_id=$2", [session.id, getAccountOwnerId(request)]);
        response.json(result);
    }));
    app.get("/api/data-imports/history", asyncHandler(async (request, response) => {
        const { rows } = await getPool().query(`SELECT log.id,log.data_type AS "dataType",log.filename,log.source_rows AS "sourceRows",log.imported_count AS "importedCount",log.duplicate_count AS "duplicateCount",log.error_count AS "errorCount",log.duplicate_strategy AS "duplicateStrategy",log.details,log.created_at AS "createdAt",COALESCE(user_account.full_name,user_account.username,'Compte supprimé') AS "startedBy" FROM depannhome_data_import_logs log LEFT JOIN depannhome_users user_account ON user_account.id=log.user_id WHERE log.owner_id=$1 ORDER BY log.created_at DESC LIMIT 100`, [getAccountOwnerId(request)]);
        response.json({ imports: rows });
    }));
}

export function dataImportUploadErrorHandler(error, request, response, next) {
    if (error instanceof multer.MulterError) return response.status(400).json({ message: error.code === "LIMIT_FILE_SIZE" ? "Le fichier d’import est limité à 10 Mo." : "Envoi du fichier impossible." });
    return next(error);
}

async function parseFile(file) {
    const extension = path.extname(file.originalname || "").toLowerCase();
    return extension === ".csv" ? parseCsv(file.buffer) : parseWorkbook(file.buffer);
}
async function parseWorkbook(buffer) {
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(buffer);
    const sheet = workbook.worksheets[0]; if (!sheet) return { columns: [], rows: [], errors: ["Aucune feuille Excel trouvée."] };
    const raw = []; sheet.eachRow({ includeEmpty: false }, row => raw.push(row.values.slice(1).map(cell => cell instanceof Date ? cell.toISOString().slice(0, 10) : String(cell ?? "").trim())));
    return rowsFromMatrix(raw);
}
function parseCsv(buffer) { return rowsFromMatrix(parseCsvMatrix(buffer.toString("utf8").replace(/^\uFEFF/, ""))); }
function rowsFromMatrix(matrix) {
    const errors = []; const header = matrix.shift() || []; const columns = uniqueColumns(header);
    if (!columns.length) return { columns: [], rows: [], errors: ["Aucune colonne détectée."] };
    const rows = matrix.slice(0, MAX_ROWS).map((line, index) => ({ rowNumber: index + 2, values: Object.fromEntries(columns.map((column, columnIndex) => [column, String(line[columnIndex] ?? "").trim()])) })).filter(row => Object.values(row.values).some(Boolean));
    if (matrix.length > MAX_ROWS) errors.push(`Seules les ${MAX_ROWS.toLocaleString("fr-FR")} premières lignes ont été analysées.`);
    return { columns, rows, errors };
}
function parseCsvMatrix(text) { const delimiter = [";", ",", "\t"].sort((first, second) => text.split(second).length - text.split(first).length)[0]; const rows = []; let row = [], value = "", quoted = false; for (let index = 0; index < text.length; index += 1) { const char = text[index]; if (char === '"') { if (quoted && text[index + 1] === '"') { value += '"'; index += 1; } else quoted = !quoted; } else if (char === delimiter && !quoted) { row.push(value); value = ""; } else if ((char === "\n" || char === "\r") && !quoted) { if (char === "\r" && text[index + 1] === "\n") index += 1; row.push(value); rows.push(row); row = []; value = ""; } else value += char; } if (value || row.length) { row.push(value); rows.push(row); } return rows; }
function createImportTemplate(dataType) {
    const workbook = new ExcelJS.Workbook(); workbook.creator = "Depann'Home Pro"; workbook.created = new Date();
    const worksheet = workbook.addWorksheet("Données à importer", { views: [{ state: "frozen", ySplit: 1 }] });
    const fields = TYPE_FIELDS[dataType]; const headers = fields.map(field => field.label);
    worksheet.addRow(headers); worksheet.getRow(1).height = 28;
    worksheet.getRow(1).eachCell(cell => { cell.font = { bold: true, color: { argb: "FFFFFFFF" } }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF14532D" } }; cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true }; cell.border = { bottom: { style: "medium", color: { argb: "FF0F3D20" } } }; });
    fields.forEach((field, index) => { worksheet.getColumn(index + 1).width = Math.max(16, Math.min(35, field.label.length + 10)); });
    worksheet.autoFilter = { from: "A1", to: worksheet.getCell(1, headers.length).address };
    const required = fields.filter(field => field.required).map(field => field.label).join(", ") || "aucun";
    const instructions = workbook.addWorksheet("Instructions"); instructions.columns = [{ width: 28 }, { width: 96 }];
    instructions.addRows([
        ["Modèle d’import", `Type de données : ${importTypeLabel(dataType)}.`],
        ["Utilisation", "Saisissez ou collez vos données dans l’onglet « Données à importer », à partir de la ligne 2. Ne modifiez pas les en-têtes de la ligne 1."],
        ["Champs obligatoires", required],
        ["Conseil", "Conservez le fichier au format .xlsx ou exportez-le en .csv UTF-8 avant de le sélectionner dans Depann’Home Pro."],
        ["Doublons", "L’assistant vérifiera les doublons avant l’import. Vous pourrez choisir de les ignorer ou de mettre à jour les données existantes."],
        ["Important", "Pour les clients, renseignez le nom ou la société. Un Client_ID technique seul ne permet pas de créer une fiche client." ]
    ]);
    instructions.getRow(1).eachCell(cell => { cell.font = { bold: true, color: { argb: "FFFFFFFF" } }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF14532D" } }; });
    instructions.eachRow((row, rowNumber) => { row.alignment = { vertical: "top", wrapText: true }; if (rowNumber > 1) row.height = 42; row.getCell(1).font = { bold: true, color: { argb: "FF14532D" } }; });
    return workbook;
}
function importTypeLabel(value) { return ({ clients: "Clients", quotes: "Devis", invoices: "Factures", reports: "Rapports d’intervention" })[value] || "Données"; }
function uniqueColumns(values) { const used = new Set(); return values.map((value, index) => clean(value, 80) || `Colonne ${index + 1}`).map(value => { let candidate = value, suffix = 2; while (used.has(candidate)) candidate = `${value} ${suffix++}`; used.add(candidate); return candidate; }); }
function suggestMapping(columns, dataType) { const aliases = { name: ["nom", "client", "société", "societe", "entreprise"], type: ["type", "catégorie", "categorie"], phone: ["téléphone", "telephone", "mobile", "fixe", "tel"], email: ["mail", "email", "e-mail"], address: ["adresse"], city: ["ville", "commune"], equipment: ["équipement", "equipement", "marque", "brand"], notes: ["note", "commentaire", "observation"], documentNumber: ["numéro", "numero", "référence", "reference", "devis", "facture"], customerName: ["client", "nom", "société", "societe"], issueDate: ["date", "émission", "emission"], description: ["description", "objet", "commentaire", "conclusion"], title: ["titre", "rapport"], reportDate: ["date", "rapport"], quantity: ["quantité", "quantite", "qté", "qte"], unitPrice: ["prix", "montant", "pu"], vatRate: ["tva"] }; const mapping = {}; TYPE_FIELDS[dataType].forEach(field => { const found = columns.find(column => aliases[field.key]?.some(alias => normalize(column).includes(normalize(alias))) && !(field.key === "name" && isClientIdentifierColumn(column))); if (found) mapping[field.key] = found; }); return mapping; }
async function loadSession(request, id) { const { rows } = await getPool().query("SELECT * FROM depannhome_data_import_sessions WHERE id=$1 AND owner_id=$2 AND user_id=$3 AND expires_at>NOW()", [String(id || ""), getAccountOwnerId(request), request.user.sub]); if (!rows[0]) throw clientError(404, "La session d’analyse a expiré. Analysez de nouveau le fichier."); return rows[0]; }
async function analyzeImport(ownerId, session, mapping, duplicateStrategy) { const records = buildRecords(session.data_type, session.rows, mapping); const duplicateKeys = await existingKeys(ownerId, session.data_type, records); const errors = records.filter(record => record.errors.length).map(record => ({ row: record.rows[0], message: record.errors.join(" ") })); const valid = records.filter(record => !record.errors.length); const duplicates = valid.filter(record => duplicateKeys.has(record.key)); const candidates = valid.filter(record => !duplicateKeys.has(record.key) || duplicateStrategy === "update"); return { summary: { sourceRows: session.rows.length, detectedRecords: records.length, duplicateCount: duplicates.length, errorCount: errors.length, newCount: candidates.length - duplicates.filter(record => duplicateStrategy === "update").length, updateCount: duplicateStrategy === "update" ? duplicates.length : 0, importableCount: candidates.length }, preview: records.slice(0, 20).map(record => ({ rows: record.rows, data: record.data, duplicate: duplicateKeys.has(record.key), errors: record.errors })), errors: errors.slice(0, 100), records: records.map(record => ({ ...record, duplicate: duplicateKeys.has(record.key) })) }; }
function buildRecords(type, rows, mapping) { if (["quotes", "invoices"].includes(type)) return groupBillingRecords(type, rows, mapping); return rows.map(row => buildRecord(type, [row], mapping)); }
function buildRecord(type, sourceRows, mapping) { const source = sourceRows[0]; const value = key => clean(source.values[mapping[key]], 2000); const data = type === "clients" ? { name: value("name"), type: value("type") || "Particulier", phone: value("phone"), email: value("email").toLowerCase(), address: value("address"), city: value("city"), equipment: value("equipment"), notes: value("notes") } : { title: value("title") || "Rapport importé", reportDate: validDate(value("reportDate")) || new Date().toISOString().slice(0, 10), clientName: value("clientName"), description: value("description"), status: "draft" }; const errors = []; if (type === "clients" && !data.name) errors.push("Nom client obligatoire."); if (type === "reports" && !value("title")) errors.push("Titre du rapport obligatoire."); return { rows: sourceRows.map(item => item.rowNumber), data, key: type === "clients" ? clientKey(data) : reportKey(data), errors }; }
function groupBillingRecords(type, rows, mapping) { const groups = new Map(); rows.forEach(row => { const number = clean(row.values[mapping.documentNumber], 80); const key = normalize(number); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); }); return [...groups.values()].map(sourceRows => { const first = sourceRows[0]; const value = key => clean(first.values[mapping[key]], 2000); const errors = []; const number = value("documentNumber"); const issueDate = validDate(value("issueDate")); if (!number) errors.push("Numéro de document obligatoire."); if (!issueDate) errors.push("Date d’émission invalide ou absente."); const lines = sourceRows.map(row => ({ description: clean(row.values[mapping.description], 500), quantity: positive(row.values[mapping.quantity], 1), unit: clean(row.values[mapping.unit], 40) || "unité", unitPrice: money(row.values[mapping.unitPrice]), vatRate: money(row.values[mapping.vatRate]) ?? 20 })).filter(line => line.description && line.unitPrice !== null); if (!lines.length) errors.push("Ajoutez au moins une ligne avec une désignation et un prix unitaire."); const data = { documentNumber: number, customerName: value("customerName") || "Client importé", customerAddress: value("customerAddress"), issueDate, dueDate: validDate(value("dueDate")), status: value("status") || "draft", notes: value("notes"), lines }; return { rows: sourceRows.map(row => row.rowNumber), data, key: normalize(number), errors }; }); }
async function existingKeys(ownerId, type, records) { const keys = new Set(); if (type === "clients") { const { rows } = await getPool().query("SELECT client_data AS client FROM depannhome_clients WHERE owner_id=$1", [ownerId]); rows.forEach(row => keys.add(clientKey(row.client || {}))); } else if (["quotes", "invoices"].includes(type)) { const { rows } = await getPool().query("SELECT document_number FROM depannhome_billing_documents WHERE owner_id=$1", [ownerId]); rows.forEach(row => keys.add(normalize(row.document_number))); } else { const { rows } = await getPool().query("SELECT report.title,report.report_date,client.client_data->>'name' AS \"clientName\" FROM depannhome_technical_reports report LEFT JOIN depannhome_clients client ON client.owner_id=report.owner_id AND client.client_id=report.client_id WHERE report.owner_id=$1 AND report.report_type='imported'", [ownerId]); rows.forEach(row => keys.add(reportKey({ title: row.title, reportDate: String(row.report_date).slice(0, 10), clientName: row.clientName }))); } return keys; }
async function performImport(request, session, records, duplicateStrategy, validationErrors) { const ownerId = getAccountOwnerId(request); const client = await getPool().connect(); const result = { importedCount: 0, duplicateCount: 0, errorCount: validationErrors.length, errors: [...validationErrors] }; try { await client.query("BEGIN"); for (const record of records) { if (record.errors.length) continue; if (record.duplicate && duplicateStrategy !== "update") { result.duplicateCount += 1; continue; } await client.query("SAVEPOINT import_item"); try { await importRecord(client, ownerId, request.user.sub, session.data_type, record, duplicateStrategy); result.importedCount += 1; await client.query("RELEASE SAVEPOINT import_item"); } catch (error) { await client.query("ROLLBACK TO SAVEPOINT import_item"); result.errorCount += 1; result.errors.push({ row: record.rows[0], message: clean(error.message, 500) || "Erreur d’import." }); } } await client.query("INSERT INTO depannhome_data_import_logs(owner_id,user_id,data_type,filename,source_rows,imported_count,duplicate_count,error_count,duplicate_strategy,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)", [ownerId, request.user.sub, session.data_type, session.filename, session.rows.length, result.importedCount, result.duplicateCount, result.errorCount, duplicateStrategy, JSON.stringify({ errors: result.errors.slice(0, 100) })]); await client.query("COMMIT"); } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); } return { ...result, errors: result.errors.slice(0, 100), message: `Import terminé : ${result.importedCount} élément(s) importé(s), ${result.duplicateCount} doublon(s), ${result.errorCount} erreur(s).` }; }
async function importRecord(client, ownerId, userId, type, record) {
    if (type === "clients") {
        const existing = await client.query("SELECT client_id,client_data AS client FROM depannhome_clients WHERE owner_id=$1", [ownerId]);
        const match = existing.rows.find(row => clientKey(row.client || {}) === record.key);
        const clientId = match?.client_id || `client-${crypto.randomUUID()}`;
        const now = new Date().toISOString();
        const data = { ...(match?.client || {}), ...record.data, id: clientId, attachments: match?.client?.attachments || [], activityHistory: match?.client?.activityHistory || [], createdAt: match?.client?.createdAt || now, updatedAt: now };
        await client.query("INSERT INTO depannhome_clients(owner_id,client_id,client_data,updated_at) VALUES($1,$2,$3::jsonb,NOW()) ON CONFLICT(owner_id,client_id) DO UPDATE SET client_data=EXCLUDED.client_data,updated_at=NOW()", [ownerId, clientId, JSON.stringify(data)]);
        return;
    }
    if (["quotes", "invoices"].includes(type)) {
        const documentType = type === "quotes" ? "quote" : "invoice";
        const existing = await client.query("SELECT document_type FROM depannhome_billing_documents WHERE owner_id=$1 AND document_number=$2", [ownerId, record.data.documentNumber]);
        if (existing.rows[0] && existing.rows[0].document_type !== documentType) throw new Error(`Le numéro ${record.data.documentNumber} appartient déjà à un ${existing.rows[0].document_type === "quote" ? "devis" : "facture"}.`);
        await client.query(`INSERT INTO depannhome_billing_documents(owner_id,created_by,document_type,document_number,customer_name,customer_address,issue_date,due_date,status,lines,notes) VALUES($1,$2,$3,$4,$5,$6,$7::date,$8::date,$9,$10::jsonb,$11) ON CONFLICT(owner_id,document_number) DO UPDATE SET customer_name=EXCLUDED.customer_name,customer_address=EXCLUDED.customer_address,issue_date=EXCLUDED.issue_date,due_date=EXCLUDED.due_date,status=EXCLUDED.status,lines=EXCLUDED.lines,notes=EXCLUDED.notes,updated_at=NOW()`, [ownerId, userId, documentType, record.data.documentNumber, record.data.customerName, record.data.customerAddress, record.data.issueDate, record.data.dueDate || null, record.data.status, JSON.stringify(record.data.lines), record.data.notes]);
        return;
    }
    const clientId = await importedClientId(client, ownerId, record.data.clientName);
    await client.query("INSERT INTO depannhome_technical_reports(owner_id,created_by,client_id,report_type,title,report_date,content,status) VALUES($1,$2,$3,'imported',$4,$5::date,$6::jsonb,'draft')", [ownerId, userId, clientId, record.data.title, record.data.reportDate, JSON.stringify({ imported: true, description: record.data.description })]);
}
async function importedClientId(client, ownerId, name) { if (!name) return ""; const { rows } = await client.query("SELECT client_id FROM depannhome_clients WHERE owner_id=$1 AND LOWER(BTRIM(client_data->>'name'))=LOWER(BTRIM($2)) LIMIT 1", [ownerId, name]); return rows[0]?.client_id || ""; }
function sanitizeMapping(value, type, availableColumns = []) { const mapping = value && typeof value === "object" && !Array.isArray(value) ? value : {}; const cleanMapping = Object.fromEntries(TYPE_FIELDS[type].map(field => [field.key, clean(mapping[field.key], 80)])); const columns = Object.values(cleanMapping).filter(Boolean); const required = TYPE_FIELDS[type].filter(field => field.required).map(field => field.key); if (required.some(field => !cleanMapping[field])) return { ok: false, message: "Associez toutes les colonnes obligatoires avant de poursuivre." }; if (columns.some(column => !availableColumns.includes(column))) return { ok: false, message: "Une colonne sélectionnée n’existe pas dans le fichier analysé." }; if (new Set(columns).size !== columns.length) return { ok: false, message: "Une même colonne ne peut être associée qu’à un seul champ." }; if (type === "clients" && isClientIdentifierColumn(cleanMapping.name)) return { ok: false, message: "La colonne « Client_ID » est un identifiant technique, pas un nom client. Associez une colonne contenant le nom ou la société." }; return { ok: true, value: cleanMapping }; }
function billingFields(label) { return [{ key: "documentNumber", label: `N° ${label}`, required: true }, { key: "customerName", label: "Nom client" }, { key: "customerAddress", label: "Adresse client" }, { key: "issueDate", label: "Date d’émission", required: true }, { key: "dueDate", label: "Date d’échéance" }, { key: "status", label: "Statut" }, { key: "description", label: "Désignation ligne" }, { key: "quantity", label: "Quantité" }, { key: "unit", label: "Unité" }, { key: "unitPrice", label: "Prix unitaire HT" }, { key: "vatRate", label: "TVA (%)" }, { key: "notes", label: "Notes" }]; }
function clientKey(data) { return `${normalize(data?.name)}|${normalize(data?.phone || data?.email || "")}`; }
function reportKey(data) { return `${normalize(data?.title)}|${normalize(data?.reportDate)}|${normalize(data?.clientName)}`; }
function strategy(value) { return STRATEGIES.has(value) ? value : "skip"; }
function positive(value, fallback) { const number = Number(String(value || "").replace(",", ".")); return Number.isFinite(number) && number > 0 ? Math.round(number * 1000) / 1000 : fallback; }
function money(value) { const number = Number(String(value || "").replace(/\s/g, "").replace(",", ".")); return Number.isFinite(number) && number >= 0 ? Math.round(number * 100) / 100 : null; }
function validDate(value) { const text = String(value || "").trim(); if (/^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(new Date(`${text}T12:00:00`).getTime())) return text; const match = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/.exec(text); if (!match) return ""; const date = `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`; return Number.isNaN(new Date(`${date}T12:00:00`).getTime()) ? "" : date; }
function clean(value, maximum) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximum); }
function normalize(value) { return clean(value, 300).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); }
function isClientIdentifierColumn(value) { return /^(client[ _-]?)?id(entifiant)?$/.test(normalize(value)); }
function safeFilename(value) { return path.basename(String(value || "import")).replace(/[\r\n]/g, " ").slice(0, 255) || "import"; }
export function isDataImportTypeAllowed(interfaceType, dataType) { return TYPES.has(dataType) && (interfaceType !== "partner" || dataType === "clients"); }
async function assertDataImportTypeAccess(request, dataType) { const organization = await getOrganization(getAccountOwnerId(request)); if (!isDataImportTypeAllowed(organization.interfaceType, dataType)) throw clientError(403, "La licence Partenaire autorise uniquement l’import de données clients."); }
function requireDesktopAdministrator(request, response, next) { if (request.user?.role === "admin" && request.user?.deviceType === "desktop") return next(); return response.status(403).json({ message: "L’importation de données est réservée aux administrateurs sur poste PC." }); }
function clientError(status, message) { const error = new Error(message); error.status = status; return error; }
function asyncHandler(handler) { return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(error => error.status ? response.status(error.status).json({ message: error.message }) : next(error)); }
