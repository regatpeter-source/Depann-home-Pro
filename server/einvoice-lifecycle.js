import { getPool } from "./database.js";
import { getAccountOwnerId } from "./auth.js";

const INBOUND_STATUSES = new Set(["received", "validated", "accepted", "rejected", "archived"]);
const PAYMENT_STATUSES = new Set(["unpaid", "partial", "paid"]);

export async function initializeElectronicInvoiceLifecycle(database = getPool()) {
    await database.query(`
        ALTER TABLE depannhome_einvoice_transmissions
        ADD COLUMN IF NOT EXISTS lifecycle_status VARCHAR(30) NOT NULL DEFAULT 'prepared',
        ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) NOT NULL DEFAULT 'unpaid'
    `);
    await database.query(`UPDATE depannhome_einvoice_transmissions SET lifecycle_status=CASE WHEN status IN ('rejected','failed','cancelled') THEN 'rejected' WHEN status='accepted' THEN 'accepted' WHEN status='sent' THEN 'deposited' ELSE 'prepared' END WHERE lifecycle_status='prepared' AND status<>'queued'`);
    await database.query(`UPDATE depannhome_einvoice_transmissions transmission SET payment_status=CASE WHEN document.status='paid' THEN 'paid' WHEN EXISTS(SELECT 1 FROM depannhome_accounting_settlements settlement WHERE settlement.owner_id=transmission.owner_id AND settlement.document_id=transmission.document_id) THEN 'partial' ELSE transmission.payment_status END FROM depannhome_billing_documents document WHERE document.id=transmission.document_id AND document.owner_id=transmission.owner_id AND transmission.payment_status='unpaid'`);
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_einvoice_inbound_invoices (
            id BIGSERIAL PRIMARY KEY,
            owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            provider VARCHAR(160) NOT NULL DEFAULT 'Import manuel',
            external_id VARCHAR(160) NOT NULL DEFAULT '',
            invoice_number VARCHAR(160) NOT NULL,
            supplier_name VARCHAR(160) NOT NULL,
            supplier_identifier VARCHAR(80) NOT NULL DEFAULT '',
            issue_date DATE NOT NULL,
            due_date DATE,
            amount_ht NUMERIC(12,2) NOT NULL CHECK(amount_ht>=0),
            vat_amount NUMERIC(12,2) NOT NULL CHECK(vat_amount>=0),
            amount_ttc NUMERIC(12,2) NOT NULL CHECK(amount_ttc>=0),
            currency_code VARCHAR(3) NOT NULL DEFAULT 'EUR',
            status VARCHAR(20) NOT NULL DEFAULT 'received' CHECK(status IN ('received','validated','accepted','rejected','archived')),
            validation_status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK(validation_status IN ('pending','valid','invalid')),
            validation_messages JSONB NOT NULL DEFAULT '[]'::jsonb,
            payment_status VARCHAR(20) NOT NULL DEFAULT 'unpaid' CHECK(payment_status IN ('unpaid','partial','paid')),
            paid_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK(paid_amount>=0),
            payment_reference VARCHAR(160) NOT NULL DEFAULT '',
            paid_at DATE,
            purchase_id BIGINT,
            source VARCHAR(20) NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','provider')),
            rejection_reason VARCHAR(1000) NOT NULL DEFAULT '',
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            validated_at TIMESTAMPTZ,
            decided_at TIMESTAMPTZ,
            created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_einvoice_inbound_owner_idx ON depannhome_einvoice_inbound_invoices(owner_id,status,received_at DESC)");
    await database.query("CREATE UNIQUE INDEX IF NOT EXISTS depannhome_einvoice_inbound_external_unique ON depannhome_einvoice_inbound_invoices(owner_id,provider,external_id) WHERE external_id<>''");
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_einvoice_inbound_events (
            id BIGSERIAL PRIMARY KEY,
            owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            invoice_id BIGINT NOT NULL REFERENCES depannhome_einvoice_inbound_invoices(id) ON DELETE CASCADE,
            actor_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
            event_type VARCHAR(60) NOT NULL,
            status VARCHAR(30) NOT NULL DEFAULT '',
            message VARCHAR(1000) NOT NULL DEFAULT '',
            details JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_einvoice_inbound_events_owner_idx ON depannhome_einvoice_inbound_events(owner_id,invoice_id,created_at)");
}

export function registerElectronicInvoiceLifecycleRoutes(app) {
    app.post("/api/accounting/e-invoicing/inbound", asyncHandler(async (request, response) => {
        const invoice = sanitizeInboundInvoice(request.body);
        if (!invoice.ok) return response.status(400).json({ message: invoice.message });
        const ownerId = getAccountOwnerId(request);
        try {
            const { rows } = await getPool().query(`INSERT INTO depannhome_einvoice_inbound_invoices(owner_id,provider,external_id,invoice_number,supplier_name,supplier_identifier,issue_date,due_date,amount_ht,vat_amount,amount_ttc,currency_code,source,metadata,created_by) VALUES($1,$2,$3,$4,$5,$6,$7::date,$8::date,$9,$10,$11,$12,'manual',$13::jsonb,$14) RETURNING id`, [ownerId, invoice.provider, invoice.externalId, invoice.invoiceNumber, invoice.supplierName, invoice.supplierIdentifier, invoice.issueDate, invoice.dueDate || null, invoice.amountHt, invoice.vatAmount, invoice.amountTtc, invoice.currencyCode, JSON.stringify({ importNote: invoice.importNote }), request.user.sub]);
            await recordInboundEvent(ownerId, rows[0].id, request.user.sub, "received", "received", "Facture fournisseur reçue et enregistrée.");
            response.status(201).json({ id: rows[0].id });
        } catch (error) {
            if (error.code === "23505") return response.status(409).json({ message: "Cette facture fournisseur a déjà été importée." });
            throw error;
        }
    }));

    app.post("/api/accounting/e-invoicing/inbound/:invoiceId/validate", asyncHandler(async (request, response) => {
        const invoice = await requireInboundInvoice(getAccountOwnerId(request), request.params.invoiceId);
        const messages = validateInboundInvoice(invoice);
        const valid = messages.length === 0;
        await getPool().query("UPDATE depannhome_einvoice_inbound_invoices SET validation_status=$3,validation_messages=$4::jsonb,status=CASE WHEN $3='valid' AND status='received' THEN 'validated' ELSE status END,validated_at=NOW(),updated_at=NOW() WHERE id=$1 AND owner_id=$2", [invoice.id, invoice.owner_id, valid ? "valid" : "invalid", JSON.stringify(messages)]);
        await recordInboundEvent(invoice.owner_id, invoice.id, request.user.sub, "validated", valid ? "validated" : "invalid", valid ? "Contrôles de cohérence réussis." : "Anomalies détectées pendant la validation.", { messages });
        response.status(valid ? 200 : 422).json({ valid, messages });
    }));

    app.post("/api/accounting/e-invoicing/inbound/:invoiceId/decision", asyncHandler(async (request, response) => {
        const ownerId = getAccountOwnerId(request);
        const invoice = await requireInboundInvoice(ownerId, request.params.invoiceId);
        const decision = request.body?.decision;
        if (!["accepted", "rejected"].includes(decision)) return response.status(400).json({ message: "Décision invalide." });
        if (decision === "accepted" && invoice.validation_status !== "valid") return response.status(409).json({ message: "Validez la facture avant de l’accepter." });
        const reason = clean(request.body?.reason, 1000);
        if (decision === "rejected" && !reason) return response.status(400).json({ message: "Indiquez le motif du refus." });
        await getPool().query("UPDATE depannhome_einvoice_inbound_invoices SET status=$3,rejection_reason=$4,decided_at=NOW(),updated_at=NOW() WHERE id=$1 AND owner_id=$2", [invoice.id, ownerId, decision, reason]);
        await recordInboundEvent(ownerId, invoice.id, request.user.sub, decision, decision, decision === "accepted" ? "Facture fournisseur acceptée." : `Facture fournisseur refusée : ${reason}`);
        response.json({ status: decision });
    }));

    app.post("/api/accounting/e-invoicing/inbound/:invoiceId/purchase", asyncHandler(async (request, response) => {
        const ownerId = getAccountOwnerId(request);
        const invoice = await requireInboundInvoice(ownerId, request.params.invoiceId);
        if (invoice.status !== "accepted") return response.status(409).json({ message: "Acceptez la facture avant de créer l’achat." });
        if (invoice.purchase_id) return response.status(409).json({ message: "Cette facture est déjà liée à un achat." });
        const vatRate = invoice.amount_ht > 0 ? Math.round((invoice.vat_amount / invoice.amount_ht) * 10000) / 100 : 0;
        const client = await getPool().connect();
        try {
            await client.query("BEGIN");
            const { rows } = await client.query(`INSERT INTO depannhome_purchases(owner_id,created_by,purchase_date,category,supplier,description,reference,amount_ht,vat_rate,notes) VALUES($1,$2,$3,'Autre',$4,$5,$6,$7,$8,$9) RETURNING id`, [ownerId, request.user.sub, invoice.issue_date, invoice.supplier_name, `Facture électronique fournisseur ${invoice.invoice_number}`, invoice.invoice_number, invoice.amount_ht, Math.min(100, vatRate), "Créé depuis la boîte de réception de facturation électronique."]);
            await client.query("UPDATE depannhome_einvoice_inbound_invoices SET purchase_id=$3,updated_at=NOW() WHERE id=$1 AND owner_id=$2", [invoice.id, ownerId, rows[0].id]);
            await recordInboundEvent(ownerId, invoice.id, request.user.sub, "purchase_linked", invoice.status, `Achat #${rows[0].id} créé et rapproché.`, { purchaseId: rows[0].id }, client);
            await client.query("COMMIT");
            response.status(201).json({ purchaseId: rows[0].id });
        } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }));

    app.post("/api/accounting/e-invoicing/inbound/:invoiceId/payment", asyncHandler(async (request, response) => {
        const ownerId = getAccountOwnerId(request);
        const invoice = await requireInboundInvoice(ownerId, request.params.invoiceId);
        const paidAmount = money(request.body?.paidAmount);
        const paidAt = date(request.body?.paidAt);
        if (paidAmount === null || paidAmount > Number(invoice.amount_ttc) + 0.01 || !paidAt) return response.status(400).json({ message: "Montant ou date de règlement invalide." });
        const paymentStatus = paidAmount >= Number(invoice.amount_ttc) - 0.01 ? "paid" : paidAmount > 0 ? "partial" : "unpaid";
        await getPool().query("UPDATE depannhome_einvoice_inbound_invoices SET paid_amount=$3,payment_status=$4,payment_reference=$5,paid_at=$6::date,updated_at=NOW() WHERE id=$1 AND owner_id=$2", [invoice.id, ownerId, paidAmount, paymentStatus, clean(request.body?.reference, 160), paidAt]);
        await recordInboundEvent(ownerId, invoice.id, request.user.sub, "payment_reconciled", paymentStatus, paymentStatus === "paid" ? "Facture fournisseur réglée." : paymentStatus === "partial" ? "Règlement partiel rapproché." : "Rapprochement de règlement retiré.", { paidAmount, paidAt });
        response.json({ paymentStatus });
    }));

    app.get("/api/accounting/e-invoicing/inbound/:invoiceId/events", asyncHandler(async (request, response) => {
        const invoice = await requireInboundInvoice(getAccountOwnerId(request), request.params.invoiceId);
        const { rows } = await getPool().query(`SELECT event_type AS "eventType",status,message,details,created_at AS "createdAt" FROM depannhome_einvoice_inbound_events WHERE owner_id=$1 AND invoice_id=$2 ORDER BY created_at,id`, [invoice.owner_id, invoice.id]);
        response.json({ events: rows });
    }));
}

export async function loadElectronicInvoiceLifecycle(ownerId, database = getPool()) {
    const [transmissions, inbound, inboundStatuses] = await Promise.all([
        database.query(`SELECT transmission.id,transmission.document_id AS "documentId",document.document_number AS "documentNumber",transmission.document_type AS "documentType",transmission.provider,transmission.platform_code AS "platformCode",transmission.remote_id AS "remoteId",transmission.status,transmission.lifecycle_status AS "lifecycleStatus",transmission.external_status AS "externalStatus",transmission.message,transmission.transmitted_at AS "transmittedAt",transmission.status_checked_at AS "statusCheckedAt",transmission.updated_at AS "updatedAt",transmission.payment_status AS "paymentStatus",COALESCE(settled.amount,0)::float AS "paidAmount",COALESCE(events.items,'[]'::json) AS events FROM depannhome_einvoice_transmissions transmission JOIN depannhome_billing_documents document ON document.id=transmission.document_id AND document.owner_id=transmission.owner_id LEFT JOIN LATERAL (SELECT SUM(amount) AS amount FROM depannhome_accounting_settlements WHERE owner_id=transmission.owner_id AND document_id=transmission.document_id) settled ON TRUE LEFT JOIN LATERAL (SELECT json_agg(json_build_object('eventType',event_type,'status',status,'message',message,'details',details,'createdAt',created_at) ORDER BY created_at,id) AS items FROM depannhome_einvoice_events WHERE owner_id=transmission.owner_id AND transmission_id=transmission.id) events ON TRUE WHERE transmission.owner_id=$1 ORDER BY transmission.updated_at DESC LIMIT 100`, [ownerId]),
        database.query(`SELECT invoice.id,invoice.provider,invoice.external_id AS "externalId",invoice.invoice_number AS "invoiceNumber",invoice.supplier_name AS "supplierName",invoice.supplier_identifier AS "supplierIdentifier",TO_CHAR(invoice.issue_date,'YYYY-MM-DD') AS "issueDate",TO_CHAR(invoice.due_date,'YYYY-MM-DD') AS "dueDate",invoice.amount_ht::float AS "amountHt",invoice.vat_amount::float AS "vatAmount",invoice.amount_ttc::float AS "amountTtc",invoice.currency_code AS "currencyCode",invoice.status,invoice.validation_status AS "validationStatus",invoice.validation_messages AS "validationMessages",invoice.payment_status AS "paymentStatus",invoice.paid_amount::float AS "paidAmount",invoice.payment_reference AS "paymentReference",TO_CHAR(invoice.paid_at,'YYYY-MM-DD') AS "paidAt",invoice.purchase_id AS "purchaseId",invoice.source,invoice.rejection_reason AS "rejectionReason",invoice.received_at AS "receivedAt",invoice.validated_at AS "validatedAt",invoice.decided_at AS "decidedAt",invoice.updated_at AS "updatedAt",COALESCE(events.items,'[]'::json) AS events FROM depannhome_einvoice_inbound_invoices invoice LEFT JOIN LATERAL (SELECT json_agg(json_build_object('eventType',event_type,'status',status,'message',message,'details',details,'createdAt',created_at) ORDER BY created_at,id) AS items FROM depannhome_einvoice_inbound_events WHERE owner_id=invoice.owner_id AND invoice_id=invoice.id) events ON TRUE WHERE invoice.owner_id=$1 ORDER BY invoice.received_at DESC,invoice.id DESC LIMIT 100`, [ownerId]),
        database.query("SELECT status,COUNT(*)::integer AS count FROM depannhome_einvoice_inbound_invoices WHERE owner_id=$1 GROUP BY status ORDER BY status", [ownerId])
    ]);
    return { transmissions: transmissions.rows, inboundInvoices: inbound.rows, inboundStatuses: inboundStatuses.rows };
}

export function sanitizeInboundInvoice(value) {
    const invoiceNumber = clean(value?.invoiceNumber, 160);
    const supplierName = clean(value?.supplierName, 160);
    const issueDate = date(value?.issueDate);
    const dueDate = value?.dueDate ? date(value.dueDate) : "";
    const amountHt = money(value?.amountHt); const vatAmount = money(value?.vatAmount); const amountTtc = money(value?.amountTtc);
    if (!invoiceNumber || !supplierName || !issueDate) return { ok: false, message: "Le numéro, le fournisseur et la date d’émission sont obligatoires." };
    if (value?.dueDate && !dueDate) return { ok: false, message: "La date d’échéance est invalide." };
    if ([amountHt, vatAmount, amountTtc].includes(null)) return { ok: false, message: "Les montants de la facture sont invalides." };
    return { ok: true, invoiceNumber, supplierName, issueDate, dueDate, amountHt, vatAmount, amountTtc, provider: clean(value?.provider, 160) || "Import manuel", externalId: clean(value?.externalId, 160), supplierIdentifier: clean(value?.supplierIdentifier, 80), currencyCode: /^[A-Z]{3}$/.test(String(value?.currencyCode || "EUR")) ? String(value?.currencyCode || "EUR") : "EUR", importNote: clean(value?.importNote, 1000) };
}

function validateInboundInvoice(invoice) {
    const messages = [];
    if (!invoice.invoice_number) messages.push("Numéro de facture manquant.");
    if (!invoice.supplier_name) messages.push("Identité du fournisseur manquante.");
    if (invoice.due_date && new Date(invoice.due_date) < new Date(invoice.issue_date)) messages.push("L’échéance précède la date d’émission.");
    if (Math.abs(Number(invoice.amount_ht) + Number(invoice.vat_amount) - Number(invoice.amount_ttc)) > 0.02) messages.push("Le total TTC ne correspond pas au HT augmenté de la TVA.");
    return messages;
}
async function requireInboundInvoice(ownerId, value) { const id = positiveId(value); const { rows } = await getPool().query("SELECT * FROM depannhome_einvoice_inbound_invoices WHERE id=$1 AND owner_id=$2", [id, ownerId]); if (!rows[0]) throw httpError(404, "Facture fournisseur introuvable."); return rows[0]; }
async function recordInboundEvent(ownerId, invoiceId, actorId, eventType, status, message, details = {}, database = getPool()) { await database.query("INSERT INTO depannhome_einvoice_inbound_events(owner_id,invoice_id,actor_id,event_type,status,message,details) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)", [ownerId, invoiceId, actorId || null, eventType, INBOUND_STATUSES.has(status) || PAYMENT_STATUSES.has(status) || status === "invalid" ? status : "", clean(message, 1000), JSON.stringify(details)]); }
function clean(value, max) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, max); }
function date(value) { const result = String(value || ""); return /^\d{4}-\d{2}-\d{2}$/.test(result) && !Number.isNaN(new Date(`${result}T12:00:00`).getTime()) ? result : ""; }
function money(value) { const result = Number(value); return Number.isFinite(result) && result >= 0 && result <= 100000000 ? Math.round(result * 100) / 100 : null; }
function positiveId(value) { const result = Number(value); return Number.isSafeInteger(result) && result > 0 ? result : 0; }
function httpError(status, message) { const error = new Error(message); error.status = status; return error; }
function asyncHandler(handler) { return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next); }
