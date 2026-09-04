import crypto from "node:crypto";
import { getPool } from "./database.js";

export function buildB2cReportPayload({ documents = [], settlements = [], vatOnDebits = false, periodStart, periodEnd, generatedAt = new Date().toISOString() }) {
    const groups = new Map();
    const documentById = new Map(documents.map(document => [String(document.id), document]));
    for (const document of documents) {
        if (document.issueDate < periodStart || document.issueDate > periodEnd) continue;
        const lines = Array.isArray(document.lines) ? document.lines : [];
        const grossHt = lines.reduce((sum, line) => sum + lineAmount(line), 0);
        const discount = Math.min(grossHt, discountAmount(document.financialData, grossHt));
        const factor = grossHt > 0 ? (grossHt - discount) / grossHt : 1;
        for (const line of lines) {
            const rate = normalizedVatRate(line.vatRate ?? line.vat_rate);
            const ht = roundMoney(lineAmount(line) * factor);
            addGroup(groups, "transaction", document.issueDate, rate, ht, roundMoney(ht * rate / 100), 1, document.id);
        }
    }
    if (!vatOnDebits) {
        for (const settlement of settlements) {
            const document = documentById.get(String(settlement.documentId));
            if (!document || !["services", "mixed"].includes(document.operationCategory || "services")) continue;
            const shares = invoiceVatShares(document);
            for (const share of shares) {
                const ttc = roundMoney(Number(settlement.amount || 0) * share.ratio);
                const ht = roundMoney(ttc / (1 + share.vatRate / 100));
                addGroup(groups, "collection", settlement.date, share.vatRate, ht, roundMoney(ttc - ht), 1, settlement.id);
            }
        }
    }
    const rows = [...groups.values()].sort((first, second) => first.kind.localeCompare(second.kind) || first.date.localeCompare(second.date) || first.vatRate - second.vatRate).map(row => ({ ...row, operationCount: row.sourceIds.size, sourceCount: row.sourceIds.size, sourceIds: [...row.sourceIds].sort((a, b) => Number(a) - Number(b)) }));
    return {
        schemaVersion: 1,
        status: "prepared_local",
        transmissionStatus: "not_transmitted",
        notice: "Préparation locale à contrôler puis déposer auprès de la plateforme choisie par l’entreprise. Aucun envoi fiscal n’a été effectué.",
        periodStart,
        periodEnd,
        generatedAt,
        vatOnDebits: Boolean(vatOnDebits),
        transactions: rows.filter(row => row.kind === "transaction"),
        collections: rows.filter(row => row.kind === "collection")
    };
}

export async function prepareB2cReport({ ownerId, actorId, periodStart, periodEnd, database = getPool() }) {
    const [profileResult, documentsResult, settlementsResult] = await Promise.all([
        database.query("SELECT vat_on_debits AS \"vatOnDebits\" FROM depannhome_billing_profiles WHERE owner_id=$1", [ownerId]),
        database.query(`SELECT document.id,TO_CHAR(document.issue_date,'YYYY-MM-DD') AS "issueDate",document.lines,document.financial_data AS "financialData",COALESCE(document.legal_data->>'operationCategory','services') AS "operationCategory" FROM depannhome_billing_documents document WHERE document.owner_id=$1 AND document.customer_type='Particulier' AND document.document_type='invoice' AND document.issued_at IS NOT NULL AND document.status NOT IN ('cancelled','rejected') AND (document.issue_date BETWEEN $2::date AND $3::date OR EXISTS(SELECT 1 FROM depannhome_accounting_settlements settlement WHERE settlement.owner_id=document.owner_id AND settlement.document_id=document.id AND settlement.settlement_date BETWEEN $2::date AND $3::date)) ORDER BY document.issue_date,document.id`, [ownerId, periodStart, periodEnd]),
        database.query(`SELECT settlement.id,settlement.document_id AS "documentId",TO_CHAR(settlement.settlement_date,'YYYY-MM-DD') AS date,settlement.amount::float AS amount FROM depannhome_accounting_settlements settlement JOIN depannhome_billing_documents document ON document.id=settlement.document_id AND document.owner_id=settlement.owner_id WHERE settlement.owner_id=$1 AND document.customer_type='Particulier' AND settlement.settlement_date BETWEEN $2::date AND $3::date ORDER BY settlement.settlement_date,settlement.id`, [ownerId, periodStart, periodEnd])
    ]);
    const payload = buildB2cReportPayload({ documents: documentsResult.rows, settlements: settlementsResult.rows, vatOnDebits: Boolean(profileResult.rows[0]?.vatOnDebits), periodStart, periodEnd });
    const canonicalPayload = JSON.stringify(payload);
    const hash = crypto.createHash("sha256").update(canonicalPayload).digest("hex");
    const connection = await database.connect();
    try {
        await connection.query("BEGIN");
        const { rows } = await connection.query(`INSERT INTO depannhome_b2c_report_batches(owner_id,period_start,period_end,status,transaction_count,collection_count,payload,payload_sha256,created_by) VALUES($1,$2::date,$3::date,'prepared_local',$4,$5,$6::jsonb,$7,$8) RETURNING id,created_at AS "createdAt"`, [ownerId, periodStart, periodEnd, payload.transactions.length, payload.collections.length, canonicalPayload, hash, actorId]);
        await connection.query(`INSERT INTO depannhome_b2c_report_events(owner_id,batch_id,actor_id,event_type,details) VALUES($1,$2,$3,'prepared_local',$4::jsonb)`, [ownerId, rows[0].id, actorId, JSON.stringify({ payloadSha256: hash, transmissionStatus: "not_transmitted" })]);
        await connection.query("COMMIT");
        return { id: rows[0].id, status: "prepared_local", transmissionStatus: "not_transmitted", payloadSha256: hash, createdAt: rows[0].createdAt, payload };
    } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
    } finally { connection.release(); }
}

export async function loadB2cReports(ownerId, database = getPool()) {
    const { rows } = await database.query(`SELECT id,TO_CHAR(period_start,'YYYY-MM-DD') AS "periodStart",TO_CHAR(period_end,'YYYY-MM-DD') AS "periodEnd",status,transaction_count AS "transactionCount",collection_count AS "collectionCount",payload_sha256 AS "payloadSha256",created_at AS "createdAt" FROM depannhome_b2c_report_batches WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100`, [ownerId]);
    return rows.map(row => ({ ...row, transmissionStatus: "not_transmitted" }));
}

export async function loadB2cReport(ownerId, batchId, database = getPool()) {
    const { rows } = await database.query(`SELECT id,TO_CHAR(period_start,'YYYY-MM-DD') AS "periodStart",TO_CHAR(period_end,'YYYY-MM-DD') AS "periodEnd",status,transaction_count AS "transactionCount",collection_count AS "collectionCount",payload,payload_sha256 AS "payloadSha256",created_at AS "createdAt" FROM depannhome_b2c_report_batches WHERE id=$1 AND owner_id=$2`, [batchId, ownerId]);
    return rows[0] ? { ...rows[0], transmissionStatus: "not_transmitted" } : null;
}

export function buildB2cReportCsv(report) {
    const rows = [...(report.payload?.transactions || []), ...(report.payload?.collections || [])];
    const header = ["type", "date", "taux_tva", "base_ht", "tva", "total_ttc", "nombre_sources", "statut_transmission"];
    const lines = rows.map(row => [row.kind === "transaction" ? "transaction_b2c" : "encaissement_service", row.date, row.vatRate.toFixed(2), row.amountHt.toFixed(2), row.vatAmount.toFixed(2), row.amountTtc.toFixed(2), row.sourceCount, "non_transmis"].join(";"));
    return `\uFEFF${[header.join(";"), ...lines].join("\r\n")}\r\n`;
}

function invoiceVatShares(document) {
    const lines = Array.isArray(document.lines) ? document.lines : [];
    const grossHt = lines.reduce((sum, line) => sum + lineAmount(line), 0);
    const discount = Math.min(grossHt, discountAmount(document.financialData, grossHt));
    const factor = grossHt > 0 ? (grossHt - discount) / grossHt : 1;
    const byRate = new Map();
    for (const line of lines) {
        const vatRate = normalizedVatRate(line.vatRate ?? line.vat_rate);
        const ht = roundMoney(lineAmount(line) * factor);
        byRate.set(vatRate, roundMoney((byRate.get(vatRate) || 0) + ht * (1 + vatRate / 100)));
    }
    const total = [...byRate.values()].reduce((sum, value) => sum + value, 0);
    return [...byRate.entries()].map(([vatRate, ttc]) => ({ vatRate, ratio: total > 0 ? ttc / total : 0 }));
}

function addGroup(groups, kind, date, vatRate, amountHt, vatAmount, sourceIncrement, sourceId) {
    const key = `${kind}|${date}|${vatRate.toFixed(2)}`;
    const row = groups.get(key) || { kind, date, vatRate, amountHt: 0, vatAmount: 0, amountTtc: 0, operationCount: 0, sourceIds: new Set() };
    row.amountHt = roundMoney(row.amountHt + amountHt);
    row.vatAmount = roundMoney(row.vatAmount + vatAmount);
    row.amountTtc = roundMoney(row.amountHt + row.vatAmount);
    row.operationCount += sourceIncrement;
    row.sourceIds.add(sourceId);
    groups.set(key, row);
}

function discountAmount(financialData, grossHt) {
    const data = financialData && typeof financialData === "object" ? financialData : {};
    return data.discountMode === "percentage" ? grossHt * (Number(data.discountAmount) || 0) / 100 : Number(data.discountAmount) || 0;
}
function lineAmount(line) { return (Number(line.quantity) || 0) * (Number(line.unitPrice ?? line.unit_price) || 0); }
function normalizedVatRate(value) { return Math.max(0, Math.min(100, Math.round((Number(value) || 0) * 100) / 100)); }
function roundMoney(value) { return Math.round((Number(value) || 0) * 100) / 100; }
