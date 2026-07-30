import crypto from "node:crypto";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { getPool } from "./database.js";
import { getAccountOwnerId } from "./auth.js";

const AID_TYPES = new Set(["cee", "maprimerenov", "coup_de_pouce", "eco_ptz", "regional", "departmental", "supplier", "manufacturer", "custom"]);
const AID_MODES = new Set(["fixed", "percentage"]);
const PDP_STATUSES = new Set(["configured", "draft", "queued", "sent", "accepted", "rejected", "failed"]);
const EXPORT_SCOPES = new Set(["invoices", "quotes", "credits", "settlements", "clients", "overdue", "all", "fec"]);

// Les connecteurs PDP restent volontairement isolés : l'ajout d'un prestataire n'impacte ni la facturation ni les exports.
const pdpConnectors = new Map([
    ["sandbox", {
        label: "Bac à sable Depann’Home Pro",
        async transmit(document) {
            if (!document.customerName) throw new Error("Le destinataire de la facture est obligatoire.");
            return { remoteId: `sandbox-${document.id}-${Date.now()}`, status: "sent", message: "Facture placée dans le bac à sable PDP." };
        }
    }]
]);

export async function initializeAccounting() {
    const database = getPool();
    await database.query(`
        ALTER TABLE depannhome_billing_documents
        ADD COLUMN IF NOT EXISTS financial_data JSONB NOT NULL DEFAULT '{}'::jsonb
    `);
    await database.query("ALTER TABLE depannhome_billing_documents DROP CONSTRAINT IF EXISTS depannhome_billing_documents_document_type_check");
    await database.query(`
        ALTER TABLE depannhome_billing_documents
        ADD CONSTRAINT depannhome_billing_documents_document_type_check CHECK (document_type IN ('quote', 'invoice', 'credit'))
    `);
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_accounting_aids (
            id BIGSERIAL PRIMARY KEY,
            owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            name VARCHAR(160) NOT NULL,
            description VARCHAR(1000) NOT NULL DEFAULT '',
            aid_type VARCHAR(40) NOT NULL DEFAULT 'custom',
            calculation_mode VARCHAR(20) NOT NULL DEFAULT 'fixed',
            amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
            auto_apply BOOLEAN NOT NULL DEFAULT FALSE,
            rules JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_accounting_aids_owner_idx ON depannhome_accounting_aids (owner_id, auto_apply, LOWER(name))");
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_accounting_settlements (
            id BIGSERIAL PRIMARY KEY,
            owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            document_id BIGINT NOT NULL REFERENCES depannhome_billing_documents(id) ON DELETE CASCADE,
            settlement_date DATE NOT NULL,
            amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
            method VARCHAR(40) NOT NULL DEFAULT 'Virement',
            reference VARCHAR(160) NOT NULL DEFAULT '',
            notes VARCHAR(1000) NOT NULL DEFAULT '',
            created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_accounting_settlements_owner_document_idx ON depannhome_accounting_settlements (owner_id, document_id, settlement_date DESC)");
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_accounting_settings (
            owner_id BIGINT PRIMARY KEY REFERENCES depannhome_users(id) ON DELETE CASCADE,
            chart_config JSONB NOT NULL DEFAULT '{}'::jsonb,
            aid_engine_config JSONB NOT NULL DEFAULT '{}'::jsonb,
            pdp_provider VARCHAR(60) NOT NULL DEFAULT 'sandbox',
            pdp_identifier VARCHAR(160) NOT NULL DEFAULT '',
            pdp_api_secret TEXT NOT NULL DEFAULT '',
            pdp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_einvoice_transmissions (
            id BIGSERIAL PRIMARY KEY,
            owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            document_id BIGINT NOT NULL REFERENCES depannhome_billing_documents(id) ON DELETE CASCADE,
            provider VARCHAR(60) NOT NULL,
            remote_id VARCHAR(160) NOT NULL DEFAULT '',
            status VARCHAR(30) NOT NULL DEFAULT 'draft',
            message VARCHAR(1000) NOT NULL DEFAULT '',
            attempts INTEGER NOT NULL DEFAULT 0,
            last_attempt_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_einvoice_transmissions_owner_idx ON depannhome_einvoice_transmissions (owner_id, status, updated_at DESC)");
}

export function registerAccountingRoutes(app, requireAuthentication) {
    app.use("/api/accounting", requireAuthentication, requireAccountingAdministration);

    app.get("/api/accounting", asyncHandler(async (request, response) => {
        const ownerId = getAccountOwnerId(request);
        const [documents, settlements, purchases, aids, settings, transmissions] = await Promise.all([
            loadDocuments(ownerId), loadSettlements(ownerId), loadPurchases(ownerId), loadAids(ownerId), loadSettings(ownerId), loadTransmissions(ownerId)
        ]);
        response.json({
            dashboard: buildDashboard(documents, settlements, purchases),
            documents, settlements, purchases, aids,
            settings: publicSettings(settings),
            transmissions,
            connectors: [...pdpConnectors.entries()].map(([id, connector]) => ({ id, label: connector.label }))
        });
    }));

    app.get("/api/accounting/aids", asyncHandler(async (request, response) => response.json({ aids: await loadAids(getAccountOwnerId(request)) })));
    app.post("/api/accounting/aids", asyncHandler(async (request, response) => {
        const aid = sanitizeAid(request.body);
        if (!aid.ok) return response.status(400).json({ message: aid.message });
        const { rows } = await getPool().query(`
            INSERT INTO depannhome_accounting_aids (owner_id, name, description, aid_type, calculation_mode, amount, auto_apply, rules)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
            RETURNING id
        `, [getAccountOwnerId(request), aid.name, aid.description, aid.aidType, aid.calculationMode, aid.amount, aid.autoApply, JSON.stringify(aid.rules)]);
        response.status(201).json({ id: rows[0].id });
    }));
    app.put("/api/accounting/aids/:aidId", asyncHandler(async (request, response) => {
        const id = positiveId(request.params.aidId);
        const aid = sanitizeAid(request.body);
        if (!id || !aid.ok) return response.status(400).json({ message: aid.message || "Aide invalide." });
        const result = await getPool().query(`
            UPDATE depannhome_accounting_aids SET name=$3, description=$4, aid_type=$5, calculation_mode=$6, amount=$7, auto_apply=$8, rules=$9::jsonb, updated_at=NOW()
            WHERE id=$1 AND owner_id=$2
        `, [id, getAccountOwnerId(request), aid.name, aid.description, aid.aidType, aid.calculationMode, aid.amount, aid.autoApply, JSON.stringify(aid.rules)]);
        if (!result.rowCount) return response.status(404).json({ message: "Aide introuvable." });
        response.status(204).end();
    }));
    app.delete("/api/accounting/aids/:aidId", asyncHandler(async (request, response) => {
        const result = await getPool().query("DELETE FROM depannhome_accounting_aids WHERE id=$1 AND owner_id=$2", [positiveId(request.params.aidId), getAccountOwnerId(request)]);
        if (!result.rowCount) return response.status(404).json({ message: "Aide introuvable." });
        response.status(204).end();
    }));

    app.put("/api/accounting/documents/:documentId/financial-data", asyncHandler(async (request, response) => {
        const id = positiveId(request.params.documentId);
        const financialData = sanitizeFinancialData(request.body);
        if (!id || !financialData.ok) return response.status(400).json({ message: financialData.message || "Données financières invalides." });
        const result = await getPool().query(`
            UPDATE depannhome_billing_documents SET financial_data=$3::jsonb, updated_at=NOW() WHERE id=$1 AND owner_id=$2
        `, [id, getAccountOwnerId(request), JSON.stringify(financialData.value)]);
        if (!result.rowCount) return response.status(404).json({ message: "Document introuvable." });
        response.status(204).end();
    }));

    app.post("/api/accounting/documents/:documentId/credits", asyncHandler(async (request, response) => {
        const sourceId = positiveId(request.params.documentId);
        const ownerId = getAccountOwnerId(request);
        const { rows } = await getPool().query(`
            SELECT * FROM depannhome_billing_documents WHERE id=$1 AND owner_id=$2 AND document_type='invoice'
        `, [sourceId, ownerId]);
        const invoice = rows[0];
        if (!invoice) return response.status(404).json({ message: "Facture introuvable." });
        const amount = positiveMoney(request.body?.amount);
        const total = calculateDocumentTotals(invoice.lines, invoice.financial_data).netPayable;
        if (amount === null || amount > total) return response.status(400).json({ message: "Le montant de l’avoir doit être positif et ne pas dépasser le reste facturé." });
        const number = `AVO-${String(invoice.document_number).replace(/^FAC-?/i, "")}-${Date.now().toString().slice(-5)}`.slice(0, 80);
        const lines = [{ description: `Avoir sur facture ${invoice.document_number}`, quantity: 1, unit: "forfait", unitPrice: -amount / (1 + weightedVatRate(invoice.lines) / 100), vatRate: weightedVatRate(invoice.lines) }];
        const { rows: created } = await getPool().query(`
            INSERT INTO depannhome_billing_documents (owner_id, created_by, document_type, document_number, client_id, customer_type, customer_name, customer_address, issue_date, status, source_quote_id, quote_reference, lines, notes, financial_data)
            VALUES ($1,$2,'credit',$3,$4,$5,$6,$7,CURRENT_DATE,'issued',$8,$9,$10::jsonb,$11,$12::jsonb) RETURNING id
        `, [ownerId, request.user.sub, number, invoice.client_id, invoice.customer_type, invoice.customer_name, invoice.customer_address, invoice.source_quote_id, invoice.document_number, JSON.stringify(lines), cleanText(request.body?.notes, 2000), JSON.stringify({ sourceInvoiceId: invoice.id })]);
        response.status(201).json({ id: created[0].id });
    }));

    app.post("/api/accounting/settlements", asyncHandler(async (request, response) => {
        const settlement = sanitizeSettlement(request.body);
        if (!settlement.ok) return response.status(400).json({ message: settlement.message });
        const ownerId = getAccountOwnerId(request);
        const documents = await loadDocuments(ownerId);
        const document = documents.find(item => String(item.id) === String(settlement.documentId) && item.documentType === "invoice");
        if (!document) return response.status(404).json({ message: "Facture introuvable." });
        if (settlement.amount > document.remainingAmount + 0.01) return response.status(400).json({ message: "Le règlement dépasse le solde restant de la facture." });
        const { rows } = await getPool().query(`
            INSERT INTO depannhome_accounting_settlements (owner_id, document_id, settlement_date, amount, method, reference, notes, created_by)
            VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8) RETURNING id
        `, [ownerId, settlement.documentId, settlement.date, settlement.amount, settlement.method, settlement.reference, settlement.notes, request.user.sub]);
        response.status(201).json({ id: rows[0].id });
    }));

    app.get("/api/accounting/settings", asyncHandler(async (request, response) => response.json({ settings: publicSettings(await loadSettings(getAccountOwnerId(request))) })));
    app.put("/api/accounting/settings", asyncHandler(async (request, response) => {
        const settings = sanitizeSettings(request.body);
        if (!settings.ok) return response.status(400).json({ message: settings.message });
        const ownerId = getAccountOwnerId(request);
        const previous = await loadSettings(ownerId);
        const secret = settings.apiKey ? encryptSecret(settings.apiKey) : previous.pdpApiSecret || "";
        await getPool().query(`
            INSERT INTO depannhome_accounting_settings (owner_id, chart_config, aid_engine_config, pdp_provider, pdp_identifier, pdp_api_secret, pdp_enabled)
            VALUES ($1,$2::jsonb,$3::jsonb,$4,$5,$6,$7)
            ON CONFLICT (owner_id) DO UPDATE SET chart_config=EXCLUDED.chart_config, aid_engine_config=EXCLUDED.aid_engine_config,
                pdp_provider=EXCLUDED.pdp_provider, pdp_identifier=EXCLUDED.pdp_identifier, pdp_api_secret=EXCLUDED.pdp_api_secret,
                pdp_enabled=EXCLUDED.pdp_enabled, updated_at=NOW()
        `, [ownerId, JSON.stringify(settings.chartConfig), JSON.stringify(settings.aidEngineConfig), settings.provider, settings.identifier, secret, settings.enabled]);
        response.status(204).end();
    }));

    app.post("/api/accounting/e-invoices/:documentId/transmit", asyncHandler(async (request, response) => {
        const id = positiveId(request.params.documentId);
        const ownerId = getAccountOwnerId(request);
        const settings = await loadSettings(ownerId);
        const { rows } = await getPool().query("SELECT id, document_number AS \"documentNumber\", customer_name AS \"customerName\", document_type AS \"documentType\" FROM depannhome_billing_documents WHERE id=$1 AND owner_id=$2", [id, ownerId]);
        const document = rows[0];
        if (!document || document.documentType !== "invoice") return response.status(404).json({ message: "Facture introuvable." });
        const provider = settings.pdpProvider || "sandbox";
        const connector = pdpConnectors.get(provider);
        if (!connector) return response.status(400).json({ message: "Le connecteur PDP sélectionné n’est pas disponible." });
        const transmission = await createTransmission(ownerId, id, provider);
        try {
            if (settings.pdpEnabled && provider !== "sandbox" && !settings.pdpApiSecret) throw new Error("La clé API PDP n’est pas configurée.");
            const result = await connector.transmit(document, { apiKey: decryptSecret(settings.pdpApiSecret) });
            await updateTransmission(transmission.id, result.status, result.message, result.remoteId);
            response.json({ message: result.message, transmission: { id: transmission.id, status: result.status } });
        } catch (error) {
            await updateTransmission(transmission.id, "failed", String(error.message || "Transmission impossible"), "");
            response.status(502).json({ message: "Transmission PDP en échec. Elle est journalisée et peut être renvoyée." });
        }
    }));

    app.get("/api/accounting/export", asyncHandler(async (request, response) => {
        const options = sanitizeExportOptions(request.query);
        if (!options.ok) return response.status(400).json({ message: options.message });
        const data = await collectExportData(getAccountOwnerId(request), options);
        if (options.format === "csv") return sendTextDownload(response, buildCsv(data, options.scope), `${exportFileBase(options)}.csv`, "text/csv; charset=utf-8");
        if (options.format === "fec") return sendTextDownload(response, buildFec(data), `${exportFileBase(options)}.txt`, "text/plain; charset=utf-8");
        if (options.format === "pdf") {
            const pdf = await buildExportPdf(data, options);
            response.set({ "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename=\"${exportFileBase(options)}.pdf\"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
            return response.send(pdf);
        }
        const workbook = await buildWorkbook(data, options.scope);
        const buffer = await workbook.xlsx.writeBuffer();
        response.set({ "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename=\"${exportFileBase(options)}.xlsx\"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
        response.send(Buffer.from(buffer));
    }));
}

function requireAccountingAdministration(request, response, next) {
    if (request.user?.role !== "admin") return response.status(403).json({ message: "Le module Comptabilité & Facturation électronique est réservé à l’administrateur de l’entreprise." });
    return next();
}

async function loadDocuments(ownerId) {
    const { rows } = await getPool().query(`
        SELECT document.id, document_type AS "documentType", document_number AS "documentNumber", client_id AS "clientId", customer_name AS "customerName",
            customer_address AS "customerAddress", TO_CHAR(issue_date, 'YYYY-MM-DD') AS "issueDate", TO_CHAR(due_date, 'YYYY-MM-DD') AS "dueDate", status,
            lines, notes, financial_data AS "financialData", is_accounted AS "isAccounted", quote_reference AS "quoteReference",
            COALESCE((SELECT SUM(amount) FROM depannhome_accounting_settlements settlement WHERE settlement.owner_id=document.owner_id AND settlement.document_id=document.id), 0)::float AS "settledAmount"
        FROM depannhome_billing_documents document WHERE owner_id=$1 ORDER BY issue_date DESC, id DESC
    `, [ownerId]);
    return rows.map(document => {
        const totals = calculateDocumentTotals(document.lines, document.financialData);
        const settledAmount = Number(document.settledAmount || 0);
        return { ...document, financialData: normalizeFinancialData(document.financialData), totals, settledAmount, remainingAmount: Math.max(0, roundMoney(totals.netPayable - settledAmount)), paymentStatus: document.documentType === "invoice" ? paymentStatus(document, totals.netPayable, settledAmount) : "not_applicable" };
    });
}

async function loadSettlements(ownerId) {
    const { rows } = await getPool().query(`
        SELECT settlement.id, settlement.document_id AS "documentId", TO_CHAR(settlement.settlement_date, 'YYYY-MM-DD') AS date, settlement.amount::float AS amount,
            settlement.method, settlement.reference, settlement.notes, document.document_number AS "documentNumber", document.customer_name AS "customerName"
        FROM depannhome_accounting_settlements settlement JOIN depannhome_billing_documents document ON document.id=settlement.document_id
        WHERE settlement.owner_id=$1 ORDER BY settlement.settlement_date DESC, settlement.id DESC
    `, [ownerId]);
    return rows;
}

async function loadPurchases(ownerId) {
    const { rows } = await getPool().query(`SELECT id, TO_CHAR(purchase_date, 'YYYY-MM-DD') AS date, supplier, description, amount_ht::float AS "amountHt", vat_rate::float AS "vatRate", is_accounted AS "isAccounted" FROM depannhome_purchases WHERE owner_id=$1 ORDER BY purchase_date DESC`, [ownerId]);
    return rows;
}

async function loadAids(ownerId) {
    const { rows } = await getPool().query(`SELECT id, name, description, aid_type AS "aidType", calculation_mode AS "calculationMode", amount::float AS amount, auto_apply AS "autoApply", rules FROM depannhome_accounting_aids WHERE owner_id=$1 ORDER BY auto_apply DESC, LOWER(name)`, [ownerId]);
    return rows;
}

async function loadSettings(ownerId) {
    const { rows } = await getPool().query("SELECT chart_config AS \"chartConfig\", aid_engine_config AS \"aidEngineConfig\", pdp_provider AS \"pdpProvider\", pdp_identifier AS \"pdpIdentifier\", pdp_api_secret AS \"pdpApiSecret\", pdp_enabled AS \"pdpEnabled\" FROM depannhome_accounting_settings WHERE owner_id=$1", [ownerId]);
    return rows[0] || { chartConfig: {}, aidEngineConfig: {}, pdpProvider: "sandbox", pdpIdentifier: "", pdpApiSecret: "", pdpEnabled: false };
}

async function loadTransmissions(ownerId) {
    const { rows } = await getPool().query(`
        SELECT transmission.id, transmission.document_id AS "documentId", document.document_number AS "documentNumber", transmission.provider, transmission.remote_id AS "remoteId",
            transmission.status, transmission.message, transmission.attempts, transmission.last_attempt_at AS "lastAttemptAt", transmission.updated_at AS "updatedAt"
        FROM depannhome_einvoice_transmissions transmission JOIN depannhome_billing_documents document ON document.id=transmission.document_id
        WHERE transmission.owner_id=$1 ORDER BY transmission.updated_at DESC LIMIT 100
    `, [ownerId]);
    return rows;
}

function publicSettings(settings) {
    return { chartConfig: settings.chartConfig || {}, aidEngineConfig: settings.aidEngineConfig || {}, pdpProvider: settings.pdpProvider || "sandbox", pdpIdentifier: settings.pdpIdentifier || "", pdpEnabled: Boolean(settings.pdpEnabled), hasApiKey: Boolean(settings.pdpApiSecret) };
}

function buildDashboard(documents, settlements, purchases) {
    const invoices = documents.filter(item => item.documentType === "invoice");
    const credits = documents.filter(item => item.documentType === "credit");
    const turnover = invoices.reduce((sum, item) => sum + item.totals.netPayable, 0) + credits.reduce((sum, item) => sum + item.totals.netPayable, 0);
    const collected = settlements.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const purchasesHt = purchases.reduce((sum, item) => sum + Number(item.amountHt || 0), 0);
    const overdue = invoices.filter(item => item.paymentStatus === "overdue");
    return { turnover: roundMoney(turnover), collected: roundMoney(collected), outstanding: roundMoney(invoices.reduce((sum, item) => sum + item.remainingAmount, 0)), overdueAmount: roundMoney(overdue.reduce((sum, item) => sum + item.remainingAmount, 0)), overdueCount: overdue.length, purchasesHt: roundMoney(purchasesHt), invoicesCount: invoices.length };
}

function calculateDocumentTotals(lines, financialData) {
    const data = normalizeFinancialData(financialData);
    const getPrice = line => Number(line.unitPrice ?? line.unit_price ?? 0);
    const getVatRate = line => Number(line.vatRate ?? line.vat_rate ?? 0);
    const ht = (Array.isArray(lines) ? lines : []).reduce((sum, line) => sum + Number(line.quantity || 0) * getPrice(line), 0);
    const grossVat = (Array.isArray(lines) ? lines : []).reduce((sum, line) => sum + Number(line.quantity || 0) * getPrice(line) * getVatRate(line) / 100, 0);
    if (ht < 0) return { ht: roundMoney(ht), vat: roundMoney(grossVat), ttc: roundMoney(ht + grossVat), discount: 0, aids: 0, netPayable: roundMoney(ht + grossVat) };
    const discount = Math.min(ht, data.discountMode === "percentage" ? ht * data.discountAmount / 100 : data.discountAmount);
    const vat = ht ? grossVat * (ht - discount) / ht : 0;
    const aids = data.aids.reduce((sum, aid) => sum + (aid.calculationMode === "percentage" ? (ht - discount) * Number(aid.amount || 0) / 100 : Number(aid.amount || 0)), 0);
    const ttc = ht - discount + vat;
    return { ht: roundMoney(ht), vat: roundMoney(vat), ttc: roundMoney(ttc), discount: roundMoney(discount), aids: roundMoney(Math.min(ttc, aids)), netPayable: roundMoney(Math.max(0, ttc - aids)) };
}

function normalizeFinancialData(value) {
    const data = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return { discountMode: AID_MODES.has(data.discountMode) ? data.discountMode : "fixed", discountAmount: safeMoney(data.discountAmount), depositAmount: safeMoney(data.depositAmount), conditions: cleanText(data.conditions, 2000), comments: cleanText(data.comments, 2000), photos: Array.isArray(data.photos) ? data.photos.map(item => cleanText(item, 500)).filter(Boolean).slice(0, 10) : [], options: Array.isArray(data.options) ? data.options.map(item => cleanText(item, 500)).filter(Boolean).slice(0, 20) : [], subtotals: Array.isArray(data.subtotals) ? data.subtotals.map(item => cleanText(item, 160)).filter(Boolean).slice(0, 30) : [], aids: Array.isArray(data.aids) ? data.aids.map(sanitizeAidSnapshot).filter(Boolean).slice(0, 30) : [] };
}

function sanitizeFinancialData(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, message: "Données financières invalides." };
    return { ok: true, value: normalizeFinancialData(value) };
}

function sanitizeAidSnapshot(value) {
    const name = cleanText(value?.name, 160);
    const amount = safeMoney(value?.amount);
    const calculationMode = AID_MODES.has(value?.calculationMode) ? value.calculationMode : "fixed";
    return name ? { name, amount, calculationMode, aidType: AID_TYPES.has(value?.aidType) ? value.aidType : "custom", description: cleanText(value?.description, 1000) } : null;
}

function sanitizeAid(value) {
    const name = cleanText(value?.name, 160);
    const amount = safeMoney(value?.amount);
    if (!name || amount === null) return { ok: false, message: "Le nom et le montant de l’aide sont obligatoires." };
    const aidType = AID_TYPES.has(value?.aidType) ? value.aidType : "custom";
    const calculationMode = AID_MODES.has(value?.calculationMode) ? value.calculationMode : "fixed";
    return { ok: true, name, amount, aidType, calculationMode, description: cleanText(value?.description, 1000), autoApply: Boolean(value?.autoApply), rules: sanitizeRules(value?.rules) };
}

function sanitizeRules(value) {
    const rules = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return { workType: cleanText(rules.workType, 120), equipment: cleanText(rules.equipment, 120), customerCategory: cleanText(rules.customerCategory, 120), location: cleanText(rules.location, 120), validFrom: sanitizeDate(rules.validFrom), validTo: sanitizeDate(rules.validTo) };
}

function sanitizeSettlement(value) {
    const documentId = positiveId(value?.documentId);
    const amount = positiveMoney(value?.amount);
    const date = sanitizeDate(value?.date);
    if (!documentId || amount === null || !date) return { ok: false, message: "Facture, date et montant du règlement sont obligatoires." };
    return { ok: true, documentId, amount, date, method: cleanText(value?.method, 40) || "Virement", reference: cleanText(value?.reference, 160), notes: cleanText(value?.notes, 1000) };
}

function sanitizeSettings(value) {
    const provider = pdpConnectors.has(value?.provider) ? value.provider : "sandbox";
    return { ok: true, provider, identifier: cleanText(value?.identifier, 160), apiKey: String(value?.apiKey || "").trim().slice(0, 1000), enabled: Boolean(value?.enabled), chartConfig: { salesAccount: cleanText(value?.chartConfig?.salesAccount, 20) || "706000", customerAccount: cleanText(value?.chartConfig?.customerAccount, 20) || "411000", bankAccount: cleanText(value?.chartConfig?.bankAccount, 20) || "512000", vatCollectedAccount: cleanText(value?.chartConfig?.vatCollectedAccount, 20) || "445710", purchaseAccount: cleanText(value?.chartConfig?.purchaseAccount, 20) || "606000", supplierAccount: cleanText(value?.chartConfig?.supplierAccount, 20) || "401000" }, aidEngineConfig: { enabled: Boolean(value?.aidEngineConfig?.enabled), mode: cleanText(value?.aidEngineConfig?.mode, 40) || "manual", source: cleanText(value?.aidEngineConfig?.source, 160) } };
}

function sanitizeExportOptions(value) {
    const format = ["csv", "xlsx", "pdf", "fec"].includes(value?.format) ? value.format : "csv";
    const scope = EXPORT_SCOPES.has(value?.scope) ? value.scope : "all";
    const start = value?.start ? sanitizeDate(value.start) : "";
    const end = value?.end ? sanitizeDate(value.end) : "";
    if ((value?.start && !start) || (value?.end && !end) || (start && end && start > end)) return { ok: false, message: "Période d’export invalide." };
    if (format === "fec" && scope !== "fec") return { ok: false, message: "Sélectionnez l’export FEC pour le format FEC." };
    return { ok: true, format, scope, start, end };
}

async function collectExportData(ownerId, options) {
    const [documents, settlements, purchases] = await Promise.all([loadDocuments(ownerId), loadSettlements(ownerId), loadPurchases(ownerId)]);
    const inPeriod = (date) => (!options.start || date >= options.start) && (!options.end || date <= options.end);
    const filteredDocuments = documents.filter(item => inPeriod(item.issueDate));
    return { documents: filteredDocuments, settlements: settlements.filter(item => inPeriod(item.date)), purchases: purchases.filter(item => inPeriod(item.date)), options };
}

function exportRows(data, scope) {
    const all = scope === "all";
    if (scope === "settlements") return data.settlements.map(item => ({ Date: item.date, Facture: item.documentNumber, Client: item.customerName, Montant: item.amount, Mode: item.method, Référence: item.reference }));
    if (scope === "clients") return data.documents.map(item => ({ Client: item.customerName, Adresse: item.customerAddress })).filter((item, index, items) => items.findIndex(candidate => candidate.Client === item.Client) === index);
    if (scope === "overdue") return data.documents.filter(item => item.paymentStatus === "overdue").map(documentExportRow);
    const types = scope === "invoices" ? ["invoice"] : scope === "quotes" ? ["quote"] : scope === "credits" ? ["credit"] : all ? ["quote", "invoice", "credit"] : [];
    return data.documents.filter(item => types.includes(item.documentType)).map(documentExportRow);
}

function documentExportRow(item) {
    return { Type: item.documentType === "quote" ? "Devis" : item.documentType === "credit" ? "Avoir" : "Facture", Numéro: item.documentNumber, Date: item.issueDate, Échéance: item.dueDate, Client: item.customerName, Statut: item.status, "Total HT": item.totals.ht, TVA: item.totals.vat, "Total TTC": item.totals.ttc, Aides: item.totals.aids, "Reste à charge": item.totals.netPayable, Réglé: item.settledAmount, Solde: item.remainingAmount, Paiement: item.paymentStatus };
}

function buildCsv(data, scope) {
    const rows = exportRows(data, scope);
    const headers = rows.length ? Object.keys(rows[0]) : ["Aucune donnée"];
    const escape = value => `"${String(value ?? "").replace(/"/g, '""')}"`;
    return `\ufeff${headers.map(escape).join(";")}\n${rows.map(row => headers.map(header => escape(row[header])).join(";")).join("\n")}`;
}

function buildFec(data) {
    const columns = ["JournalCode", "JournalLib", "EcritureNum", "EcritureDate", "CompteNum", "CompteLib", "CompAuxNum", "CompAuxLib", "PieceRef", "PieceDate", "EcritureLib", "Debit", "Credit", "EcrDate", "DateLet", "ValidDate", "Montantdevise", "Idevise"];
    const rows = [];
    const push = values => rows.push(values.map(value => String(value ?? "").replace(/[\t\r\n]/g, " ")).join("\t"));
    data.documents.filter(item => ["invoice", "credit"].includes(item.documentType)).forEach(item => {
        const debit = item.documentType === "credit" ? 0 : item.totals.netPayable;
        const credit = item.documentType === "credit" ? Math.abs(item.totals.netPayable) : 0;
        const suffix = String(item.id).padStart(6, "0");
        push(["VTE", "Ventes", `VTE${suffix}A`, item.issueDate.replaceAll("-", ""), "411000", "Clients", "", item.customerName, item.documentNumber, item.issueDate.replaceAll("-", ""), item.documentNumber, debit, credit, item.issueDate.replaceAll("-", ""), "", item.issueDate.replaceAll("-", ""), "", "EUR"]);
        push(["VTE", "Ventes", `VTE${suffix}B`, item.issueDate.replaceAll("-", ""), "706000", "Prestations", "", "", item.documentNumber, item.issueDate.replaceAll("-", ""), item.documentNumber, credit ? 0 : item.totals.ht, credit ? Math.abs(item.totals.ht) : 0, item.issueDate.replaceAll("-", ""), "", item.issueDate.replaceAll("-", ""), "", "EUR"]);
        push(["VTE", "Ventes", `VTE${suffix}C`, item.issueDate.replaceAll("-", ""), "445710", "TVA collectée", "", "", item.documentNumber, item.issueDate.replaceAll("-", ""), item.documentNumber, credit ? 0 : item.totals.vat, credit ? Math.abs(item.totals.vat) : 0, item.issueDate.replaceAll("-", ""), "", item.issueDate.replaceAll("-", ""), "", "EUR"]);
    });
    data.settlements.forEach(item => {
        const suffix = String(item.id).padStart(6, "0");
        push(["BQ", "Banque", `BQ${suffix}A`, item.date.replaceAll("-", ""), "512000", "Banque", "", "", item.reference || item.documentNumber, item.date.replaceAll("-", ""), `Règlement ${item.documentNumber}`, item.amount, 0, item.date.replaceAll("-", ""), item.date.replaceAll("-", ""), item.date.replaceAll("-", ""), "", "EUR"]);
        push(["BQ", "Banque", `BQ${suffix}B`, item.date.replaceAll("-", ""), "411000", "Clients", "", item.customerName, item.reference || item.documentNumber, item.date.replaceAll("-", ""), `Règlement ${item.documentNumber}`, 0, item.amount, item.date.replaceAll("-", ""), item.date.replaceAll("-", ""), item.date.replaceAll("-", ""), "", "EUR"]);
    });
    return `${columns.join("\t")}\n${rows.join("\n")}`;
}

async function buildWorkbook(data, scope) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Depann’Home Pro";
    const addSheet = (name, rows) => {
        const sheet = workbook.addWorksheet(name);
        const headers = rows.length ? Object.keys(rows[0]) : ["Aucune donnée"];
        sheet.columns = headers.map(header => ({ header, key: header, width: Math.max(14, Math.min(34, header.length + 6)) }));
        rows.forEach(row => sheet.addRow(row));
        sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
        sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF003B73" } };
        sheet.views = [{ state: "frozen", ySplit: 1 }];
    };
    if (scope === "all") { addSheet("Documents", exportRows(data, "all")); addSheet("Règlements", exportRows(data, "settlements")); addSheet("Achats", data.purchases.map(item => ({ Date: item.date, Fournisseur: item.supplier, Libellé: item.description, "Montant HT": item.amountHt, TVA: item.vatRate, Comptabilisé: item.isAccounted ? "Oui" : "Non" }))); }
    else addSheet(scope === "fec" ? "FEC" : "Export", scope === "fec" ? [{ FEC: buildFec(data) }] : exportRows(data, scope));
    return workbook;
}

function buildExportPdf(data, options) {
    return new Promise((resolve, reject) => {
        const pdf = new PDFDocument({ size: "A4", margin: 44, info: { Title: "Export comptable", Author: "Depann’Home Pro" } });
        const chunks = [];
        pdf.on("data", chunk => chunks.push(chunk)); pdf.on("end", () => resolve(Buffer.concat(chunks))); pdf.on("error", reject);
        const rows = exportRows(data, options.scope);
        pdf.fillColor("#003b73").font("Helvetica-Bold").fontSize(20).text("EXPORT COMPTABLE");
        pdf.fillColor("#475569").font("Helvetica").fontSize(9).text(`Période : ${options.start || "début"} au ${options.end || "aujourd’hui"} · ${rows.length} ligne(s)`);
        pdf.moveDown();
        rows.slice(0, 120).forEach((row, index) => { if (pdf.y > 745) pdf.addPage(); pdf.fillColor(index % 2 ? "#172033" : "#334155").fontSize(8).text(Object.entries(row).map(([key, value]) => `${key}: ${value}`).join(" · "), { width: 505 }); });
        if (rows.length > 120) pdf.fillColor("#475569").text("Export tronqué dans cet aperçu PDF. Utilisez CSV ou Excel pour l’intégralité des lignes.");
        pdf.end();
    });
}

async function createTransmission(ownerId, documentId, provider) {
    const { rows } = await getPool().query(`INSERT INTO depannhome_einvoice_transmissions (owner_id, document_id, provider, status, attempts, last_attempt_at) VALUES ($1,$2,$3,'queued',1,NOW()) RETURNING id`, [ownerId, documentId, provider]);
    return rows[0];
}

async function updateTransmission(id, status, message, remoteId) {
    await getPool().query("UPDATE depannhome_einvoice_transmissions SET status=$2, message=$3, remote_id=$4, updated_at=NOW() WHERE id=$1", [id, status, cleanText(message, 1000), cleanText(remoteId, 160)]);
}

function paymentStatus(document, total, settled) {
    if (settled >= total - 0.01) return "paid";
    if (document.dueDate && document.dueDate < today()) return "overdue";
    return settled > 0 ? "partial" : "unpaid";
}
function weightedVatRate(lines) { const total = (lines || []).reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unit_price ?? line.unitPrice ?? 0), 0); return total ? roundMoney((lines || []).reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unit_price ?? line.unitPrice ?? 0) * Number(line.vat_rate ?? line.vatRate ?? 0), 0) / total) : 20; }
function today() { return new Date().toISOString().slice(0, 10); }
function exportFileBase(options) { return `export-comptable-${options.scope}-${options.start || "complet"}-${options.end || today()}`.replace(/[^a-z0-9_-]/gi, "-"); }
function sendTextDownload(response, content, filename, contentType) { response.set({ "Content-Type": contentType, "Content-Disposition": `attachment; filename=\"${filename}\"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" }); response.send(content); }
function roundMoney(value) { return Math.round((Number(value) || 0) * 100) / 100; }
function safeMoney(value) { const number = Number(value); return Number.isFinite(number) && number >= 0 && number <= 100000000 ? roundMoney(number) : null; }
function positiveMoney(value) { const number = safeMoney(value); return number !== null && number > 0 ? number : null; }
function positiveId(value) { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : 0; }
function cleanText(value, max) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, max); }
function sanitizeDate(value) { const date = String(value || ""); return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(new Date(`${date}T12:00:00`).getTime()) ? date : ""; }
function encryptionKey() { return crypto.createHash("sha256").update(String(process.env.SESSION_SECRET || "development-accounting-key")).digest(); }
function encryptSecret(value) { if (!value) return ""; const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv); const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`; }
function decryptSecret(value) { try { if (!value) return ""; const [iv, tag, encrypted] = String(value).split(".").map(item => Buffer.from(item, "base64url")); const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), iv); decipher.setAuthTag(tag); return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8"); } catch { return ""; } }
function asyncHandler(handler) { return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next); }
