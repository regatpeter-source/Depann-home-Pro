export const FEC_COLUMNS = Object.freeze([
    "JournalCode", "JournalLib", "EcritureNum", "EcritureDate", "CompteNum", "CompteLib",
    "CompAuxNum", "CompAuxLib", "PieceRef", "PieceDate", "EcritureLib", "Debit", "Credit",
    "EcritureLet", "DateLet", "ValidDate", "Montantdevise", "Idevise"
]);

export const DEFAULT_CHART_CONFIG = Object.freeze({
    salesAccount: "706000",
    customerAccount: "411000",
    bankAccount: "512000",
    vatCollectedAccount: "445710",
    purchaseAccount: "606000",
    supplierAccount: "401000"
});

export const DEFAULT_JOURNALS = Object.freeze({
    sales: { code: "VE", label: "Ventes", description: "Factures et avoirs clients", active: true },
    bank: { code: "BQ", label: "Banque", description: "Règlements clients", active: true },
    general: { code: "OD", label: "Opérations diverses", description: "Écritures correctives et d’inventaire", active: false }
});

export function normalizeAccountingConfig(chart = {}, journals = {}) {
    const accounts = Object.fromEntries(Object.entries(DEFAULT_CHART_CONFIG).map(([key, fallback]) => [key, cleanAccount(chart[key]) || fallback]));
    const normalizedJournals = Object.fromEntries(Object.entries(DEFAULT_JOURNALS).map(([type, fallback]) => {
        const value = journals[type] || {};
        return [type, {
            code: cleanCode(value.code) || fallback.code,
            label: cleanText(value.label, 100) || fallback.label,
            description: cleanText(value.description, 300) || fallback.description,
            active: value.active === undefined ? fallback.active : Boolean(value.active)
        }];
    }));
    return { accounts, journals: normalizedJournals };
}

export function calculateDocumentAccountingTotals(lines, financialData = {}) {
    const validLines = (Array.isArray(lines) ? lines : []).map(line => ({
        quantity: finite(line?.quantity),
        unitPrice: finite(line?.unitPrice ?? line?.unit_price),
        vatRate: finite(line?.vatRate ?? line?.vat_rate)
    })).filter(line => line.quantity > 0 && line.unitPrice >= 0 && line.vatRate >= 0 && line.vatRate <= 100);
    const grossHt = roundMoney(validLines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0));
    const requestedDiscount = financialData?.discountMode === "percentage"
        ? grossHt * finite(financialData?.discountAmount) / 100
        : finite(financialData?.discountAmount);
    const discount = roundMoney(Math.min(grossHt, Math.max(0, requestedDiscount)));
    const ht = roundMoney(grossHt - discount);
    const factor = grossHt ? ht / grossHt : 0;
    const vatByRate = new Map();
    validLines.forEach(line => {
        const rate = roundMoney(line.vatRate);
        const vat = line.quantity * line.unitPrice * factor * rate / 100;
        vatByRate.set(rate, (vatByRate.get(rate) || 0) + vat);
    });
    const vatBreakdown = [...vatByRate.entries()].sort(([a], [b]) => a - b).map(([rate, amount]) => ({ rate, amount: roundMoney(amount) }));
    const vat = roundMoney(vatBreakdown.reduce((sum, item) => sum + item.amount, 0));
    return { grossHt, discount, ht, vat, ttc: roundMoney(ht + vat), vatBreakdown };
}

export function createDocumentAccountingEntry({ document, chartConfig, journal, entryNumber, validDate }) {
    const config = normalizeAccountingConfig(chartConfig, { sales: journal }).accounts;
    const journalConfig = normalizeJournal(journal, DEFAULT_JOURNALS.sales);
    const type = document?.documentType || document?.document_type;
    if (!['invoice', 'credit'].includes(type)) throw new Error("Seules les factures et les avoirs produisent une écriture de ventes.");
    const sourceLines = type === "credit" ? (document.lines || []).map(line => ({
        ...line,
        quantity: Math.abs(finite(line?.quantity)),
        unitPrice: Math.abs(finite(line?.unitPrice ?? line?.unit_price))
    })) : document.lines;
    const totals = calculateDocumentAccountingTotals(sourceLines, document.financialData || document.financial_data);
    if (totals.ttc <= 0) throw new Error("Le total TTC de la pièce doit être strictement positif.");
    const isCredit = type === "credit";
    const pieceRef = cleanText(document.documentNumber || document.document_number, 80);
    const pieceDate = cleanDate(document.issueDate || document.issue_date);
    const clientId = cleanAuxiliary(document.clientId || document.client_id);
    const customerName = cleanText(document.customerName || document.customer_name, 160);
    const description = `${isCredit ? "Avoir" : "Facture"} ${pieceRef}`;
    const base = entryBase({ ownerId: document.ownerId || document.owner_id, journal: journalConfig, entryNumber, entryDate: pieceDate, pieceRef, pieceDate, description, validDate, sourceType: type, sourceId: document.id, clientId, appointmentId: document.appointmentId || document.appointment_id || null });
    const lines = [];
    lines.push(accountingLine(config.customerAccount, "Clients", isCredit ? 0 : totals.ttc, isCredit ? totals.ttc : 0, clientId, customerName));
    lines.push(accountingLine(config.salesAccount, "Prestations de services", isCredit ? totals.ht : 0, isCredit ? 0 : totals.ht));
    totals.vatBreakdown.filter(item => item.amount).forEach(item => lines.push(accountingLine(config.vatCollectedAccount, `TVA collectée ${formatRate(item.rate)} %`, isCredit ? item.amount : 0, isCredit ? 0 : item.amount)));
    return finalizeEntry({ ...base, lines, totals });
}

export function createSettlementAccountingEntry({ settlement, document, chartConfig, journal, entryNumber, validDate }) {
    const config = normalizeAccountingConfig(chartConfig, { bank: journal }).accounts;
    const journalConfig = normalizeJournal(journal, DEFAULT_JOURNALS.bank);
    const amount = roundMoney(settlement?.amount);
    if (amount <= 0) throw new Error("Le montant du règlement doit être strictement positif.");
    const entryDate = cleanDate(settlement.date || settlement.settlementDate || settlement.settlement_date);
    const documentNumber = cleanText(document?.documentNumber || document?.document_number, 80);
    const pieceRef = cleanText(settlement.reference, 160) || `RGL-${settlement.id || documentNumber}`;
    const customerName = cleanText(document?.customerName || document?.customer_name, 160);
    const clientId = cleanAuxiliary(document?.clientId || document?.client_id);
    const lettering = cleanText(settlement.lettering, 40);
    const letteringDate = lettering ? cleanDate(settlement.letteringDate || settlement.lettering_date) : "";
    return finalizeEntry({
        ...entryBase({ ownerId: settlement.ownerId || settlement.owner_id || document?.ownerId || document?.owner_id, journal: journalConfig, entryNumber, entryDate, pieceRef, pieceDate: entryDate, description: `Règlement ${documentNumber}`, validDate, sourceType: "settlement", sourceId: settlement.id, clientId, appointmentId: document?.appointmentId || document?.appointment_id || null }),
        lines: [
            accountingLine(config.bankAccount, "Banque", amount, 0, "", "", lettering, letteringDate),
            accountingLine(config.customerAccount, "Clients", 0, amount, clientId, customerName, lettering, letteringDate)
        ],
        totals: { ht: 0, vat: 0, ttc: amount }
    });
}

export function validateAccountingEntry(entry) {
    const anomalies = [];
    if (!cleanCode(entry?.journalCode)) anomalies.push("Code journal manquant ou invalide.");
    if (!cleanText(entry?.journalLabel, 100)) anomalies.push("Libellé du journal manquant.");
    if (!cleanText(entry?.entryNumber, 80)) anomalies.push("Numéro d’écriture manquant.");
    if (!cleanDate(entry?.entryDate)) anomalies.push("Date d’écriture invalide.");
    if (!cleanDate(entry?.pieceDate)) anomalies.push("Date de pièce invalide.");
    if (!cleanDate(entry?.validDate)) anomalies.push("Date de validation invalide.");
    if (!cleanText(entry?.pieceRef, 160)) anomalies.push("Référence de pièce manquante.");
    if (!Array.isArray(entry?.lines) || entry.lines.length < 2) anomalies.push("Une écriture doit contenir au moins deux lignes.");
    (entry?.lines || []).forEach((line, index) => {
        if (!/^\d{3,20}$/.test(String(line?.accountNumber || ""))) anomalies.push(`Ligne ${index + 1} : compte comptable invalide.`);
        const debit = moneyCents(line?.debit); const credit = moneyCents(line?.credit);
        if (debit < 0 || credit < 0 || (debit === 0 && credit === 0) || (debit > 0 && credit > 0)) anomalies.push(`Ligne ${index + 1} : débit/crédit invalide.`);
        if (line?.letteringDate && !line?.lettering) anomalies.push(`Ligne ${index + 1} : date de lettrage sans lettrage.`);
        if (line?.letteringDate && !cleanDate(line.letteringDate)) anomalies.push(`Ligne ${index + 1} : date de lettrage invalide.`);
    });
    const debitCents = (entry?.lines || []).reduce((sum, line) => sum + moneyCents(line.debit), 0);
    const creditCents = (entry?.lines || []).reduce((sum, line) => sum + moneyCents(line.credit), 0);
    if (debitCents !== creditCents) anomalies.push(`Écriture déséquilibrée : écart ${formatMoneyFromCents(debitCents - creditCents)} €.`);
    return { valid: anomalies.length === 0, anomalies, totalDebit: debitCents / 100, totalCredit: creditCents / 100, difference: (debitCents - creditCents) / 100 };
}

export function validateLedger(entries, options = {}) {
    const anomalies = [];
    const entryNumbers = new Set();
    const journalCodes = new Set();
    const pieces = new Set();
    let debitCents = 0; let creditCents = 0; let lineCount = 0;
    const ordered = [...(Array.isArray(entries) ? entries : [])].sort((a, b) => String(a.validDate).localeCompare(String(b.validDate)) || String(a.entryNumber).localeCompare(String(b.entryNumber)));
    ordered.forEach((entry, index) => {
        if (options.ownerId !== undefined && String(entry.ownerId) !== String(options.ownerId)) anomalies.push(`${entry.entryNumber || `Écriture ${index + 1}`} : propriétaire comptable incohérent.`);
        const validation = validateAccountingEntry(entry);
        validation.anomalies.forEach(message => anomalies.push(`${entry.entryNumber || `Écriture ${index + 1}`} : ${message}`));
        if (entryNumbers.has(entry.entryNumber)) anomalies.push(`Numéro d’écriture dupliqué : ${entry.entryNumber}.`);
        entryNumbers.add(entry.entryNumber);
        journalCodes.add(entry.journalCode);
        pieces.add(entry.pieceRef);
        debitCents += moneyCents(validation.totalDebit); creditCents += moneyCents(validation.totalCredit); lineCount += entry.lines?.length || 0;
    });
    if (!ordered.length) anomalies.push("Aucune écriture validée sur la période.");
    if (options.requireFiscalCompleteness) {
        if (!options.siren || !/^\d{9}$/.test(String(options.siren))) anomalies.push("SIREN à 9 chiffres requis pour nommer le fichier FEC.");
        if (!options.openingEntriesConfirmed) anomalies.push("Les écritures de reprise des soldes ne sont pas confirmées.");
        if (!options.inventoryEntriesConfirmed) anomalies.push("Les opérations d’inventaire ne sont pas confirmées.");
        if (!options.completeLedgerConfirmed) anomalies.push("L’exhaustivité de tous les journaux de l’exercice n’est pas confirmée.");
    }
    if (debitCents !== creditCents) anomalies.push(`Export déséquilibré : écart ${formatMoneyFromCents(debitCents - creditCents)} €.`);
    return { valid: anomalies.length === 0, anomalies, entries: ordered.length, lines: lineCount, pieces: pieces.size, journals: journalCodes.size, totalDebit: debitCents / 100, totalCredit: creditCents / 100, difference: (debitCents - creditCents) / 100 };
}

export function buildFecFile(entries) {
    const control = validateLedger(entries);
    if (!control.valid) throw new Error(`Export FEC impossible : ${control.anomalies.join(" ")}`);
    const rows = [FEC_COLUMNS.join("\t")];
    [...entries].sort((a, b) => String(a.validDate).localeCompare(String(b.validDate)) || String(a.entryNumber).localeCompare(String(b.entryNumber))).forEach(entry => {
        entry.lines.forEach(line => rows.push([
            entry.journalCode, entry.journalLabel, entry.entryNumber, fecDate(entry.entryDate), line.accountNumber,
            line.accountLabel, line.auxiliaryNumber, line.auxiliaryLabel, entry.pieceRef, fecDate(entry.pieceDate),
            entry.description, fecMoney(line.debit), fecMoney(line.credit), line.lettering, fecDate(line.letteringDate),
            fecDate(entry.validDate), "", ""
        ].map(fecCell).join("\t")));
    });
    return `\ufeff${rows.join("\r\n")}`;
}

export function fecFileName(siren, fiscalYearEnd) {
    const normalizedSiren = String(siren || "").replace(/\D/g, "");
    const date = fecDate(fiscalYearEnd);
    if (!/^\d{9}$/.test(normalizedSiren) || !date) throw new Error("SIREN ou date de clôture invalide.");
    return `${normalizedSiren}FEC${date}.txt`;
}

function entryBase({ ownerId, journal, entryNumber, entryDate, pieceRef, pieceDate, description, validDate, sourceType, sourceId, clientId, appointmentId }) {
    return { ownerId, journalCode: journal.code, journalLabel: journal.label, entryNumber: cleanText(entryNumber, 80), entryDate, pieceRef, pieceDate, description: cleanText(description, 300), validDate: cleanDate(validDate) || new Date().toISOString().slice(0, 10), sourceType, sourceId, clientId: clientId || "", appointmentId: appointmentId || null };
}
function accountingLine(accountNumber, accountLabel, debit, credit, auxiliaryNumber = "", auxiliaryLabel = "", lettering = "", letteringDate = "") { return { accountNumber: cleanAccount(accountNumber), accountLabel: cleanText(accountLabel, 160), auxiliaryNumber: cleanAuxiliary(auxiliaryNumber), auxiliaryLabel: cleanText(auxiliaryLabel, 160), debit: roundMoney(debit), credit: roundMoney(credit), lettering: cleanText(lettering, 40), letteringDate: cleanDate(letteringDate) }; }
function finalizeEntry(entry) { const validation = validateAccountingEntry(entry); if (!validation.valid) throw new Error(validation.anomalies.join(" ")); return { ...entry, totalDebit: validation.totalDebit, totalCredit: validation.totalCredit }; }
function normalizeJournal(value, fallback) { return { code: cleanCode(value?.code) || fallback.code, label: cleanText(value?.label, 100) || fallback.label }; }
function cleanAccount(value) { const account = String(value || "").replace(/\s+/g, "").slice(0, 20); return /^\d{3,20}$/.test(account) ? account : ""; }
function cleanCode(value) { const code = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10); return code.length >= 1 ? code : ""; }
function cleanAuxiliary(value) { return String(value || "").toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 40); }
function cleanText(value, max) { return String(value || "").replace(/[\t\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max); }
function cleanDate(value) { const date = String(value || ""); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return ""; const parsed = new Date(`${date}T00:00:00Z`); return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : ""; }
function fecDate(value) { return cleanDate(value).replaceAll("-", ""); }
function fecMoney(value) { return roundMoney(value).toFixed(2).replace(".", ","); }
function fecCell(value) { return String(value ?? "").replace(/[\t\r\n|]/g, " "); }
function finite(value) { const number = Number(value); return Number.isFinite(number) ? number : 0; }
function roundMoney(value) { return Math.round((finite(value) + Number.EPSILON) * 100) / 100; }
function moneyCents(value) { return Math.round(finite(value) * 100); }
function formatMoneyFromCents(value) { return (value / 100).toFixed(2).replace(".", ","); }
function formatRate(value) { return Number(value).toLocaleString("fr-FR", { maximumFractionDigits: 2 }); }
