import test from "node:test";
import assert from "node:assert/strict";
import {
    FEC_COLUMNS,
    buildFecFile,
    calculateDocumentAccountingTotals,
    createDocumentAccountingEntry,
    createSettlementAccountingEntry,
    fecFileName,
    validateAccountingEntry,
    validateLedger
} from "../server/accounting-ledger.js";

const invoice = (overrides = {}) => ({ id: 1, ownerId: 10, documentType: "invoice", documentNumber: "FAC-2026-001", clientId: "client-1", customerName: "Client Test", issueDate: "2026-01-15", lines: [{ quantity: 1, unitPrice: 1000, vatRate: 20 }], ...overrides });
const credit = (overrides = {}) => ({ id: 2, ownerId: 10, documentType: "credit", documentNumber: "AVO-2026-001", clientId: "client-1", customerName: "Client Test", issueDate: "2026-01-20", lines: [{ quantity: 1, unitPrice: -166.67, vatRate: 20 }], ...overrides });
const post = (document, entryNumber = "VE000001") => createDocumentAccountingEntry({ document, entryNumber, validDate: document.issueDate });
const settle = (overrides = {}, entryNumber = "BQ000001", source = invoice()) => createSettlementAccountingEntry({ settlement: { id: 10, ownerId: 10, amount: 1200, date: "2026-01-25", reference: "VIR-001", ...overrides }, document: source, entryNumber, validDate: overrides.date || "2026-01-25" });

// 1
test("facture 1 000 HT + 200 TVA : écriture équilibrée à 1 200", () => {
    const entry = post(invoice());
    assert.equal(entry.totalDebit, 1200);
    assert.equal(entry.totalCredit, 1200);
    assert.deepEqual(entry.lines.map(line => [line.accountNumber, line.debit, line.credit]), [["411000", 1200, 0], ["706000", 0, 1000], ["445710", 0, 200]]);
});

// 2
test("règlement 1 200 : débit banque et crédit client", () => {
    const entry = settle();
    assert.deepEqual(entry.lines.map(line => [line.accountNumber, line.debit, line.credit]), [["512000", 1200, 0], ["411000", 0, 1200]]);
});

test("règlement en espèces : débit caisse et crédit client", () => {
    const entry = settle({ method: "Espèces" });
    assert.equal(entry.journalCode, "CA");
    assert.equal(entry.journalLabel, "Caisse");
    assert.deepEqual(entry.lines.map(line => [line.accountNumber, line.debit, line.credit]), [["530000", 1200, 0], ["411000", 0, 1200]]);
});

// 3
test("avoir 200 TTC : correction équilibrée sans supprimer la facture", () => {
    const entry = post(credit());
    assert.equal(entry.totalDebit, 200);
    assert.equal(entry.totalCredit, 200);
    assert.deepEqual(entry.lines.map(line => [line.accountNumber, line.debit, line.credit]), [["411000", 0, 200], ["706000", 166.67, 0], ["445710", 33.33, 0]]);
    assert.equal(entry.sourceType, "credit");
});

// 4
test("règlement partiel : le solde client reste calculable", () => {
    const payment = settle({ amount: 400 });
    const invoiceEntry = post(invoice());
    const customerBalance = [...invoiceEntry.lines, ...payment.lines].filter(line => line.accountNumber === "411000").reduce((sum, line) => sum + line.debit - line.credit, 0);
    assert.equal(customerBalance, 800);
});

// 5
test("plusieurs règlements apurent une même facture", () => {
    const entries = [post(invoice()), settle({ id: 11, amount: 400 }, "BQ000001"), settle({ id: 12, amount: 800, date: "2026-01-28" }, "BQ000002")];
    const customerBalance = entries.flatMap(entry => entry.lines).filter(line => line.accountNumber === "411000").reduce((sum, line) => sum + line.debit - line.credit, 0);
    assert.equal(customerBalance, 0);
});

test("une franchise déduite est portée sur un compte tiers et le règlement apure le client", () => {
    const source = invoice({ financialData: { aids: [{ name: "Franchise assurance", amount: 200, calculationMode: "fixed" }] } });
    const entries = [post(source), settle({ amount: 1000 }, "BQ000001", source)];
    assert.deepEqual(entries[0].lines.map(line => [line.accountNumber, line.debit, line.credit]), [["411000", 1000, 0], ["467000", 200, 0], ["706000", 0, 1000], ["445710", 0, 200]]);
    const customerBalance = entries.flatMap(entry => entry.lines).filter(line => line.accountNumber === "411000").reduce((sum, line) => sum + line.debit - line.credit, 0);
    assert.equal(customerBalance, 0);
    assert.equal(validateLedger(entries).valid, true);
});

test("le compte des aides et franchises est configurable", () => {
    const source = invoice({ financialData: { aids: [{ name: "Prime CEE", amount: 10, calculationMode: "percentage" }] } });
    const entry = createDocumentAccountingEntry({ document: source, entryNumber: "VE000001", validDate: source.issueDate, chartConfig: { aidReceivableAccount: "467100" } });
    assert.equal(entry.lines.find(line => line.accountLabel === "Aides et franchises à recevoir")?.accountNumber, "467100");
    assert.equal(entry.lines.find(line => line.accountNumber === "467100")?.debit, 100);
});

// 6
test("plusieurs factures d’un client conservent des pièces et numéros distincts", () => {
    const entries = [post(invoice(), "VE000001"), post(invoice({ id: 3, documentNumber: "FAC-2026-002" }), "VE000002")];
    assert.equal(validateLedger(entries).valid, true);
    assert.equal(new Set(entries.map(entry => entry.pieceRef)).size, 2);
});

// 7
test("un client archivé ne retire pas ses écritures", () => {
    const entry = post(invoice({ clientStatus: "archived" }));
    assert.equal(entry.clientId, "CLIENT-1");
    assert.equal(validateLedger([entry]).entries, 1);
});

// 8
test("l’isolation entreprise A/B détecte toute écriture étrangère", () => {
    const companyA = post(invoice({ ownerId: 10 }), "VE000001");
    const companyB = post(invoice({ id: 20, ownerId: 20, documentNumber: "FAC-B-001" }), "VE000002");
    assert.equal(validateLedger([companyA], { ownerId: 10 }).valid, true);
    assert.equal(validateLedger([companyA, companyB], { ownerId: 10 }).valid, false);
});

// 9
test("export d’exercice complet autorisé après confirmations explicites", () => {
    const control = validateLedger([post(invoice())], { ownerId: 10, requireFiscalCompleteness: true, siren: "123456789", openingEntriesConfirmed: true, inventoryEntriesConfirmed: true, completeLedgerConfirmed: true });
    assert.equal(control.valid, true);
});

// 10
test("FEC avec journaux ventes et banque", () => {
    const fec = buildFecFile([post(invoice()), settle()]);
    assert.match(fec, /\tVE000001\t/);
    assert.match(fec, /\tBQ000001\t/);
    assert.equal(validateLedger([post(invoice()), settle()]).journals, 2);
});

// 11
test("une écriture déséquilibrée bloque l’export", () => {
    const entry = structuredClone(post(invoice()));
    entry.lines[0].debit = 1199;
    assert.equal(validateAccountingEntry(entry).valid, false);
    assert.throws(() => buildFecFile([entry]), /déséquilibrée/i);
});

// 12
test("une date invalide bloque l’export", () => {
    const entry = structuredClone(post(invoice()));
    entry.entryDate = "2026-02-31";
    assert.equal(validateLedger([entry]).valid, false);
    assert.throws(() => buildFecFile([entry]), /date/i);
});

// 13
test("un compte invalide est signalé précisément", () => {
    const entry = structuredClone(post(invoice()));
    entry.lines[1].accountNumber = "VENTES";
    assert.match(validateLedger([entry]).anomalies.join(" "), /compte comptable invalide/i);
});

// 14
test("un numéro d’écriture dupliqué bloque l’export", () => {
    const entries = [post(invoice()), post(invoice({ id: 4, documentNumber: "FAC-2026-004" }))];
    assert.match(validateLedger(entries).anomalies.join(" "), /dupliqué/i);
    assert.throws(() => buildFecFile(entries), /dupliqué/i);
});

// 15
test("facture, avoir et règlement restent globalement cohérents", () => {
    const entries = [post(invoice()), post(credit(), "VE000002"), settle({ amount: 1000 }, "BQ000001")];
    const control = validateLedger(entries);
    const customerBalance = entries.flatMap(entry => entry.lines).filter(line => line.accountNumber === "411000").reduce((sum, line) => sum + line.debit - line.credit, 0);
    assert.equal(control.valid, true);
    assert.equal(customerBalance, 0);
});

test("plusieurs taux de TVA sont ventilés sans perdre un centime", () => {
    const totals = calculateDocumentAccountingTotals([{ quantity: 1, unitPrice: 100, vatRate: 20 }, { quantity: 1, unitPrice: 100, vatRate: 10 }]);
    assert.deepEqual(totals, { grossHt: 200, discount: 0, ht: 200, vat: 30, ttc: 230, vatBreakdown: [{ rate: 10, amount: 10 }, { rate: 20, amount: 20 }] });
    assert.equal(post(invoice({ lines: [{ quantity: 1, unitPrice: 100, vatRate: 20 }, { quantity: 1, unitPrice: 100, vatRate: 10 }] })).lines.length, 4);
});

test("le fichier FEC utilise exactement 18 champs, dates compactes et virgules décimales", () => {
    const fec = buildFecFile([post(invoice({ lines: [{ quantity: 1, unitPrice: 10.01, vatRate: 20 }] }))]);
    const [header, firstLine] = fec.replace(/^\ufeff/, "").split("\r\n");
    assert.deepEqual(header.split("\t"), FEC_COLUMNS);
    assert.equal(firstLine.split("\t").length, 18);
    assert.match(firstLine, /20260115/);
    assert.match(firstLine, /12,01/);
});

test("aucun lettrage n’est inventé pour un règlement", () => {
    const entry = settle({ lettering: "" });
    assert.equal(entry.lines.every(line => line.lettering === "" && line.letteringDate === ""), true);
});

test("le nom réglementaire du fichier combine SIREN et clôture", () => {
    assert.equal(fecFileName("123 456 789", "2026-12-31"), "123456789FEC20261231.txt");
});

test("les valeurs de comptes et journaux restent configurables", () => {
    const entry = createDocumentAccountingEntry({ document: invoice(), entryNumber: "JV000001", validDate: "2026-01-15", chartConfig: { salesAccount: "707100", customerAccount: "411100", vatCollectedAccount: "445711" }, journal: { code: "JV", label: "Journal des ventes" } });
    assert.equal(entry.journalCode, "JV");
    assert.deepEqual(entry.lines.map(line => line.accountNumber), ["411100", "707100", "445711"]);
});

test("un contrôle FEC refuse l’exercice non exhaustif", () => {
    const control = validateLedger([post(invoice())], { requireFiscalCompleteness: true, siren: "123456789" });
    assert.equal(control.valid, false);
    assert.match(control.anomalies.join(" "), /reprise des soldes/);
    assert.match(control.anomalies.join(" "), /inventaire/);
    assert.match(control.anomalies.join(" "), /exhaustivité/);
});
