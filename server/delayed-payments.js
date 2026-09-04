import { getPool } from "./database.js";

export const DELAYED_PAYMENT_METHODS = new Set(["Chèque", "Virement"]);

export async function declareDelayedPayment({ ownerId, actorId, actorName, input, database = getPool() }) {
    const payment = sanitizeDeclaration(input);
    if (!payment.ok) throw httpError(400, payment.message);
    const connection = await database.connect();
    try {
        await connection.query("BEGIN");
        const { rows } = await connection.query(`SELECT id,document_number AS "documentNumber",lines,financial_data AS "financialData" FROM depannhome_billing_documents WHERE id=$1 AND owner_id=$2 AND document_type='invoice' AND issued_at IS NOT NULL FOR UPDATE`, [payment.documentId, ownerId]);
        const document = rows[0];
        if (!document) throw httpError(404, "Facture émise introuvable.");
        const amounts = await connection.query(`SELECT COALESCE((SELECT SUM(amount) FROM depannhome_accounting_settlements WHERE owner_id=$1 AND document_id=$2),0)::float AS confirmed,COALESCE((SELECT SUM(amount) FROM depannhome_delayed_payment_declarations WHERE owner_id=$1 AND document_id=$2 AND status='pending'),0)::float AS pending`, [ownerId, document.id]);
        const totalDue = invoiceNetPayable(document.lines, document.financialData);
        const available = roundMoney(totalDue - Number(amounts.rows[0].confirmed) - Number(amounts.rows[0].pending));
        if (available <= 0) throw httpError(409, "Le solde de cette facture est déjà réglé ou entièrement couvert par des déclarations en attente.");
        if (payment.amount > available + 0.01) throw httpError(400, "La déclaration dépasse le solde restant disponible de la facture.");
        const { rows: created } = await connection.query(`INSERT INTO depannhome_delayed_payment_declarations(owner_id,document_id,declared_payment_date,amount,method,reference,notes,declared_by,declared_by_name) VALUES($1,$2,$3::date,$4,$5,$6,$7,$8,$9) RETURNING id,status,TO_CHAR(declared_payment_date,'YYYY-MM-DD') AS date,amount::float AS amount,method,reference,created_at AS "createdAt"`, [ownerId, document.id, payment.date, payment.amount, payment.method, payment.reference, payment.notes, actorId, cleanText(actorName, 160)]);
        await connection.query(`INSERT INTO depannhome_accounting_audit(owner_id,actor_id,action,target_type,target_id,details) VALUES($1,$2,'delayed_payment_declared','delayed_payment',$3,$4::jsonb)`, [ownerId, actorId, String(created[0].id), JSON.stringify({ documentId: document.id, method: payment.method, amount: payment.amount })]);
        await connection.query("COMMIT");
        return { declaration: created[0], pending: true, message: "Règlement déclaré. Il sera comptabilisé après contrôle bancaire sur un poste administratif." };
    } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
    } finally { connection.release(); }
}

export async function reviewDelayedPayment({ ownerId, declarationId, actorId, actorName, decision, bankEvidenceConfirmed, reviewNote, database = getPool() }) {
    if (!["approved", "rejected"].includes(decision)) throw httpError(400, "Décision invalide.");
    if (decision === "approved" && bankEvidenceConfirmed !== true) throw httpError(400, "Confirmez la vérification de la preuve bancaire avant validation.");
    const note = cleanText(reviewNote, 1000);
    if (decision === "rejected" && !note) throw httpError(400, "Le motif du refus est obligatoire.");
    const connection = await database.connect();
    try {
        await connection.query("BEGIN");
        const { rows } = await connection.query(`SELECT declaration.id,declaration.document_id AS "documentId",TO_CHAR(declaration.declared_payment_date,'YYYY-MM-DD') AS date,declaration.amount::float AS amount,declaration.method,declaration.reference,declaration.notes,declaration.status,declaration.settlement_id AS "settlementId" FROM depannhome_delayed_payment_declarations declaration WHERE declaration.id=$1 AND declaration.owner_id=$2 FOR UPDATE`, [declarationId, ownerId]);
        const declaration = rows[0];
        if (!declaration) throw httpError(404, "Déclaration de règlement introuvable.");
        if (declaration.status !== "pending") {
            await connection.query("COMMIT");
            return { declarationId, status: declaration.status, settlementId: declaration.settlementId, alreadyReviewed: true };
        }
        if (decision === "rejected") {
            await connection.query(`UPDATE depannhome_delayed_payment_declarations SET status='rejected',reviewed_by=$3,reviewed_by_name=$4,reviewed_at=NOW(),review_note=$5,bank_evidence_confirmed=FALSE,updated_at=NOW() WHERE id=$1 AND owner_id=$2`, [declarationId, ownerId, actorId, cleanText(actorName, 160), note]);
            await audit(connection, ownerId, actorId, "delayed_payment_rejected", declarationId, { reviewNote: note });
            await connection.query("COMMIT");
            return { declarationId, status: "rejected", settlementId: null, alreadyReviewed: false };
        }
        const { recordConfirmedInvoiceSettlement } = await import("./accounting.js");
        const settlement = await recordConfirmedInvoiceSettlement({ ownerId, actorId, input: declaration, database: connection });
        await connection.query(`UPDATE depannhome_delayed_payment_declarations SET status='approved',reviewed_by=$3,reviewed_by_name=$4,reviewed_at=NOW(),review_note=$5,bank_evidence_confirmed=TRUE,settlement_id=$6,updated_at=NOW() WHERE id=$1 AND owner_id=$2`, [declarationId, ownerId, actorId, cleanText(actorName, 160), note, settlement.id]);
        await audit(connection, ownerId, actorId, "delayed_payment_approved", declarationId, { settlementId: settlement.id, bankEvidenceConfirmed: true });
        await connection.query("COMMIT");
        return { declarationId, status: "approved", settlementId: settlement.id, paymentStatus: settlement.paymentStatus, acquittanceAvailable: settlement.paymentStatus === "paid", alreadyReviewed: false };
    } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
    } finally { connection.release(); }
}

export async function loadDelayedPayments(ownerId, database = getPool()) {
    const { rows } = await database.query(`SELECT declaration.id,declaration.document_id AS "documentId",document.document_number AS "documentNumber",document.customer_name AS "customerName",TO_CHAR(declaration.declared_payment_date,'YYYY-MM-DD') AS date,declaration.amount::float AS amount,declaration.method,declaration.reference,declaration.notes,declaration.status,declaration.declared_by_name AS "declaredByName",declaration.reviewed_by_name AS "reviewedByName",declaration.reviewed_at AS "reviewedAt",declaration.review_note AS "reviewNote",declaration.bank_evidence_confirmed AS "bankEvidenceConfirmed",declaration.settlement_id AS "settlementId",declaration.created_at AS "createdAt" FROM depannhome_delayed_payment_declarations declaration JOIN depannhome_billing_documents document ON document.id=declaration.document_id AND document.owner_id=declaration.owner_id WHERE declaration.owner_id=$1 ORDER BY CASE declaration.status WHEN 'pending' THEN 0 ELSE 1 END,declaration.created_at DESC LIMIT 200`, [ownerId]);
    return rows;
}

async function audit(database, ownerId, actorId, action, declarationId, details) {
    await database.query(`INSERT INTO depannhome_accounting_audit(owner_id,actor_id,action,target_type,target_id,details) VALUES($1,$2,$3,'delayed_payment',$4,$5::jsonb)`, [ownerId, actorId, action, String(declarationId), JSON.stringify(details)]);
}

function sanitizeDeclaration(value) {
    const documentId = positiveId(value?.documentId);
    const amount = positiveMoney(value?.amount);
    const date = validDate(value?.date);
    const method = cleanText(value?.method, 40);
    const reference = cleanText(value?.reference, 160);
    if (!documentId || amount === null || !date) return { ok: false, message: "Facture, date et montant du règlement sont obligatoires." };
    if (!DELAYED_PAYMENT_METHODS.has(method)) return { ok: false, message: "Seuls les chèques et virements suivent le contrôle différé." };
    if (!reference) return { ok: false, message: "La référence du chèque ou du virement est obligatoire pour le contrôle." };
    return { ok: true, documentId, amount, date, method, reference, notes: cleanText(value?.notes, 1000) };
}

function invoiceNetPayable(lines, financialData = {}) {
    const source = Array.isArray(lines) ? lines : [];
    const ht = source.reduce((sum, line) => sum + (Number(line.quantity) || 0) * (Number(line.unitPrice ?? line.unit_price) || 0), 0);
    const grossVat = source.reduce((sum, line) => sum + (Number(line.quantity) || 0) * (Number(line.unitPrice ?? line.unit_price) || 0) * (Number(line.vatRate ?? line.vat_rate) || 0) / 100, 0);
    const discount = Math.min(ht, financialData?.discountMode === "percentage" ? ht * (Number(financialData.discountAmount) || 0) / 100 : Number(financialData?.discountAmount) || 0);
    const vat = ht ? grossVat * (ht - discount) / ht : 0;
    const ttc = ht - discount + vat;
    const aids = (Array.isArray(financialData?.aids) ? financialData.aids : []).reduce((sum, aid) => sum + (aid.calculationMode === "percentage" ? (ht - discount) * (Number(aid.amount) || 0) / 100 : Number(aid.amount) || 0), 0);
    return roundMoney(Math.max(0, ttc - Math.min(ttc, aids)));
}
function validDate(value) { const date = String(value || ""); return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(new Date(`${date}T12:00:00`).getTime()) ? date : ""; }
function positiveId(value) { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : 0; }
function positiveMoney(value) { const amount = Number(value); return Number.isFinite(amount) && amount > 0 && amount <= 100000000 ? roundMoney(amount) : null; }
function cleanText(value, maximumLength) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximumLength); }
function roundMoney(value) { return Math.round((Number(value) || 0) * 100) / 100; }
function httpError(status, message) { const error = new Error(message); error.status = status; return error; }
