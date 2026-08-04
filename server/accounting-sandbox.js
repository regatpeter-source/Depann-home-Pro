import crypto from "node:crypto";
import ExcelJS from "exceljs";
import { getPool } from "./database.js";
import { getAccountOwnerId, isCompanyAdministrator } from "./auth.js";

const ACTIONS = new Set(["new_invoice", "new_quote", "quote_to_invoice", "payment", "overdue", "partial_credit", "total_credit", "pdp_accepted", "pdp_rejected", "pdp_processing", "pdp_format_error", "pdp_recipient_not_found", "pdp_distributed"]);
const PDP_OUTCOMES = new Set(["received", "accepted", "processing", "rejected", "format_error", "recipient_not_found", "distributed"]);
const PAYMENT_METHODS = ["Virement", "Carte bancaire", "Espèces", "Chèque"];

export function isAccountingSandboxEnabled() {
    return process.env.ACCOUNTING_SANDBOX_ENABLED === "true" && process.env.NODE_ENV !== "production";
}

export async function initializeAccountingSandbox() {
    if (!isAccountingSandboxEnabled()) return;
    await getPool().query(`
        CREATE TABLE IF NOT EXISTS depannhome_accounting_sandbox_sessions (
            owner_id BIGINT PRIMARY KEY REFERENCES depannhome_users(id) ON DELETE CASCADE,
            payload JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
}

export function registerAccountingSandboxRoutes(app, requireAuthentication) {
    app.get("/api/accounting-sandbox", requireAuthentication, asyncHandler(async (request, response) => {
        if (!isCompanyAdministrator(request) || !isAccountingSandboxEnabled()) {
            return response.json({ available: false, enabled: false });
        }
        response.json({ available: true, enabled: Boolean(await loadSession(getAccountOwnerId(request))) });
    }));
    app.use("/api/accounting-sandbox", requireAuthentication, requireSandboxAdministration, requireSandboxEnabled);
    app.get("/api/accounting-sandbox/workspace", asyncHandler(async (request, response) => {
        const payload = await loadSession(getAccountOwnerId(request));
        if (!payload) return response.status(404).json({ message: "Le laboratoire comptable n’est pas activé." });
        response.json({ sandbox: publicSandbox(payload) });
    }));
    app.post("/api/accounting-sandbox/activate", asyncHandler(async (request, response) => {
        const ownerId = getAccountOwnerId(request);
        const existing = await loadSession(ownerId);
        const payload = existing || createSandboxPayload(request.user);
        await saveSession(ownerId, request.user.sub, payload);
        response.status(existing ? 200 : 201).json({ sandbox: publicSandbox(payload) });
    }));
    app.post("/api/accounting-sandbox/actions/:action", asyncHandler(async (request, response) => {
        const action = String(request.params.action || "");
        if (!ACTIONS.has(action)) return response.status(400).json({ message: "Scénario comptable inconnu." });
        const ownerId = getAccountOwnerId(request);
        const payload = await loadSession(ownerId);
        if (!payload) return response.status(404).json({ message: "Activez d’abord le laboratoire comptable." });
        applyAction(payload, action, request.user);
        await saveSession(ownerId, request.user.sub, payload);
        response.json({ sandbox: publicSandbox(payload) });
    }));
    app.post("/api/accounting-sandbox/e-invoices/:invoiceId/transmit", asyncHandler(async (request, response) => {
        const payload = await requiredPayload(request);
        const invoice = findInvoice(payload, request.params.invoiceId);
        if (!invoice) return response.status(404).json({ message: "Facture de démonstration introuvable." });
        transmit(payload, invoice, "received");
        await saveSession(getAccountOwnerId(request), request.user.sub, payload);
        response.json({ sandbox: publicSandbox(payload), message: "Facture reçue par la PDP simulée." });
    }));
    app.post("/api/accounting-sandbox/e-invoices/:invoiceId/outcome", asyncHandler(async (request, response) => {
        const payload = await requiredPayload(request);
        const invoice = findInvoice(payload, request.params.invoiceId);
        const outcome = String(request.body?.outcome || "");
        if (!invoice) return response.status(404).json({ message: "Facture de démonstration introuvable." });
        if (!PDP_OUTCOMES.has(outcome)) return response.status(400).json({ message: "Réponse PDP simulée inconnue." });
        transmit(payload, invoice, outcome);
        await saveSession(getAccountOwnerId(request), request.user.sub, payload);
        response.json({ sandbox: publicSandbox(payload) });
    }));
    app.get("/api/accounting-sandbox/export", asyncHandler(async (request, response) => {
        const payload = await requiredPayload(request);
        const format = ["csv", "xlsx", "fec"].includes(String(request.query.format)) ? String(request.query.format) : "csv";
        const scope = ["all", "invoices", "quotes", "credits", "payments", "journals"].includes(String(request.query.scope)) ? String(request.query.scope) : "all";
        const data = exportData(payload, scope);
        const filename = `sandbox-comptable-${scope}-${dateKey(new Date())}`;
        if (format === "fec") return textDownload(response, buildFec(payload), `${filename}.txt`, "text/plain; charset=utf-8");
        if (format === "csv") return textDownload(response, buildCsv(data), `${filename}.csv`, "text/csv; charset=utf-8");
        const workbook = await buildWorkbook(payload, scope);
        const buffer = await workbook.xlsx.writeBuffer();
        response.set({ "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename=\"${filename}.xlsx\"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
        response.send(Buffer.from(buffer));
    }));
    app.delete("/api/accounting-sandbox", asyncHandler(async (request, response) => {
        await getPool().query("DELETE FROM depannhome_accounting_sandbox_sessions WHERE owner_id=$1", [getAccountOwnerId(request)]);
        response.status(204).end();
    }));
}

function createSandboxPayload(user) {
    const now = new Date();
    const clients = [
        client("Jean Martin", "15 rue des Acacias, 75012 Paris"), client("Sophie Durand", "8 avenue des Fleurs, 69003 Lyon"),
        client("SCI Les Acacias", "12 rue du Parc, 33000 Bordeaux"), client("Ville de Démo", "1 place de la Mairie, 44000 Nantes"), client("Assurance Test", "24 boulevard des Assureurs, 59000 Lille")
    ];
    const interventions = [
        intervention(clients[0], "Recherche de fuite", "Technicien Démo", daysAgo(21)), intervention(clients[1], "Ouverture de porte", "Sophie Bernard", daysAgo(18)),
        intervention(clients[2], "Remplacement moteur portail", "Lucas Morel", daysAgo(15)), intervention(clients[3], "Dépannage volet roulant", "Technicien Démo", daysAgo(12)), intervention(clients[4], "Mise en sécurité après effraction", "Sophie Bernard", daysAgo(9))
    ];
    const quotes = [
        document("quote", "DEV-DEMO-2026-001", clients[0], "accepted", daysAgo(22), [line("Recherche de fuite et rapport", 1, 240, 20)]),
        document("quote", "DEV-DEMO-2026-002", clients[1], "rejected", daysAgo(19), [line("Ouverture de porte", 1, 185, 10)]),
        document("quote", "DEV-DEMO-2026-003", clients[2], "pending", daysAgo(16), [line("Moteur portail et pose", 1, 890, 20)]),
        document("quote", "DEV-DEMO-2026-004", clients[3], "pending", daysAgo(13), [line("Dépannage volet roulant", 1, 195, 10)])
    ];
    const invoices = [
        invoice("FAC-DEMO-2026-001", clients[0], "paid", daysAgo(20), [line("Recherche de fuite et rapport", 1, 240, 20)], "Virement"),
        invoice("FAC-DEMO-2026-002", clients[1], "validated", daysAgo(17), [line("Ouverture de porte", 1, 185, 10)], "Carte bancaire"),
        invoice("FAC-DEMO-2026-003", clients[2], "sent", daysAgo(14), [line("Moteur portail et pose", 1, 890, 20)], "Chèque"),
        invoice("FAC-DEMO-2026-004", clients[3], "overdue", daysAgo(40), [line("Dépannage volet roulant", 1, 195, 10)], "Espèces"),
        invoice("FAC-DEMO-2026-005", clients[4], "cancelled", daysAgo(10), [line("Sécurisation provisoire", 1, 320, 20)], "Virement"),
        invoice("FAC-DEMO-2026-006", clients[4], "draft", daysAgo(2), [line("Diagnostic complémentaire", 1, 120, 20)], "Virement")
    ];
    const payments = [
        payment(invoices[0], total(invoices[0]), "Virement", daysAgo(18), "VIR-DEMO-001"), payment(invoices[2], 400, "Chèque", daysAgo(10), "CHQ-DEMO-003"), payment(invoices[1], 50, "Carte bancaire", daysAgo(15), "CB-DEMO-002"), payment(invoices[4], 80, "Virement", daysAgo(10), "ACOMPTE-DEMO-005")
    ];
    const credits = [credit(invoices[2], 120, "Avoir partiel de démonstration", daysAgo(8)), credit(invoices[4], total(invoices[4]), "Annulation complète de facture", daysAgo(8))];
    const payload = { version: 1, company: { name: "Entreprise Démo", registration: "SIREN fictif 000 000 000", vat: "FR00DEMO00000" }, clients, interventions, quotes, invoices, payments, credits, transmissions: [], timeline: [], createdAt: now.toISOString(), createdFor: user?.fullName || user?.username || "Administrateur Sandbox", updatedAt: now.toISOString() };
    invoices.forEach((item, index) => { if (index < 3) transmit(payload, item, index === 0 ? "distributed" : index === 1 ? "processing" : "accepted", daysAgo(7 - index)); });
    log(payload, "sandbox_activated", "Jeu de données comptables de démonstration généré.", now);
    return payload;
}

function applyAction(payload, action) {
    const now = new Date();
    if (action === "new_invoice") {
        const customer = payload.clients[payload.invoices.length % payload.clients.length];
        const item = invoice(nextNumber(payload, "FAC"), customer, "draft", now, [line("Intervention de démonstration", 1, 260, 20)], "Virement");
        payload.invoices.unshift(item); log(payload, "invoice_created", `${item.number} générée pour ${customer.name}.`, now);
    } else if (action === "new_quote") {
        const customer = payload.clients[payload.quotes.length % payload.clients.length];
        const item = document("quote", nextNumber(payload, "DEV"), customer, "pending", now, [line("Devis de démonstration", 1, 340, 20)]);
        payload.quotes.unshift(item); log(payload, "quote_created", `${item.number} généré pour ${customer.name}.`, now);
    } else if (action === "quote_to_invoice") {
        const quote = payload.quotes.find(item => item.status === "accepted") || payload.quotes[0];
        quote.status = "accepted";
        const item = invoice(nextNumber(payload, "FAC"), quote.customer, "draft", now, quote.lines, "Virement");
        item.quoteNumber = quote.number; payload.invoices.unshift(item); log(payload, "quote_converted", `${quote.number} transformé en ${item.number}.`, now);
    } else if (action === "payment") {
        const item = payload.invoices.find(invoice => remaining(payload, invoice) > 0.01 && !["cancelled", "draft"].includes(invoice.status));
        if (!item) throw clientError(409, "Aucune facture Sandbox à régler.");
        const amount = Math.min(remaining(payload, item), Math.max(50, round(total(item) / 2)));
        payload.payments.unshift(payment(item, amount, PAYMENT_METHODS[payload.payments.length % PAYMENT_METHODS.length], now, `REG-DEMO-${String(payload.payments.length + 1).padStart(3, "0")}`));
        log(payload, "payment_received", `Règlement de ${amount.toFixed(2)} € enregistré sur ${item.number}.`, now);
    } else if (action === "overdue") {
        const item = payload.invoices.find(invoice => !["cancelled", "draft"].includes(invoice.status) && remaining(payload, invoice) > 0.01);
        if (!item) throw clientError(409, "Aucune facture Sandbox ne peut devenir impayée.");
        item.status = "overdue"; item.dueDate = dateKey(daysAgo(12)); log(payload, "invoice_overdue", `${item.number} marquée impayée.`, now);
    } else if (action === "partial_credit" || action === "total_credit") {
        const item = payload.invoices.find(invoice => !["cancelled", "draft"].includes(invoice.status) && availableCredit(payload, invoice) > 0.01);
        if (!item) throw clientError(409, "Aucune facture Sandbox ne peut recevoir d’avoir.");
        const amount = action === "total_credit" ? availableCredit(payload, item) : round(Math.min(availableCredit(payload, item), total(item) * .25));
        payload.credits.unshift(credit(item, amount, action === "total_credit" ? "Avoir total simulé" : "Avoir partiel simulé", now));
        if (action === "total_credit") item.status = "cancelled";
        log(payload, "credit_created", `Avoir de ${amount.toFixed(2)} € généré pour ${item.number}.`, now);
    } else {
        const item = payload.invoices.find(invoice => !["cancelled", "draft"].includes(invoice.status)) || payload.invoices[0];
        transmit(payload, item, action.replace(/^pdp_/, ""), now);
    }
    payload.updatedAt = now.toISOString();
}

function transmit(payload, invoice, outcome, when = new Date()) {
    const status = PDP_OUTCOMES.has(outcome) ? outcome : "received";
    const detail = { received: "Facture reçue par la plateforme simulée.", accepted: "Facture acceptée par la plateforme simulée.", processing: "Facture en cours de traitement.", rejected: "Facture rejetée par la plateforme simulée.", format_error: "Erreur de format simulée.", recipient_not_found: "Destinataire introuvable dans l’annuaire simulé.", distributed: "Facture distribuée au destinataire simulé." }[status];
    const transmission = { id: crypto.randomUUID(), invoiceId: invoice.id, invoiceNumber: invoice.number, status, provider: "PDP Démo locale", remoteId: `PDP-DEMO-${invoice.number}-${Date.now().toString().slice(-6)}`, message: detail, occurredAt: new Date(when).toISOString() };
    payload.transmissions.unshift(transmission); payload.transmissions = payload.transmissions.slice(0, 100);
    log(payload, `pdp_${status}`, `${invoice.number} · ${detail}`, when);
}

function publicSandbox(payload) {
    const enrichedInvoices = payload.invoices.map(item => ({ ...item, totals: totals(item), paidAmount: paid(payload, item), creditAmount: credited(payload, item), remainingAmount: remaining(payload, item), paymentStatus: paymentStatus(payload, item) }));
    return { ...payload, invoices: enrichedInvoices, dashboard: dashboard(payload, enrichedInvoices), journals: journals(payload, enrichedInvoices) };
}

function dashboard(payload, invoices) {
    const active = invoices.filter(item => item.status !== "cancelled");
    const month = new Date().getMonth();
    const payments = payload.payments.filter(item => new Date(item.date).getMonth() === month);
    return { turnover: round(active.reduce((sum, item) => sum + item.totals.ttc, 0)), invoicesIssued: invoices.length, paid: invoices.filter(item => paymentStatus(payload, item) === "paid").length, pending: invoices.filter(item => ["partial", "unpaid", "overdue"].includes(paymentStatus(payload, item))).length, vatCollected: round(active.reduce((sum, item) => sum + item.totals.vat, 0)), vatRemaining: round(active.filter(item => remaining(payload, item) > 0).reduce((sum, item) => sum + item.totals.vat, 0)), credits: round(payload.credits.reduce((sum, item) => sum + item.amount, 0)), monthReceipts: round(payments.reduce((sum, item) => sum + item.amount, 0)) };
}

function journals(payload, invoices) {
    const sales = invoices.filter(item => item.status !== "draft").flatMap(item => [{ date: item.issueDate, account: "411000", label: `Client ${item.customer.name}`, debit: item.totals.ttc, credit: 0, reference: item.number }, { date: item.issueDate, account: "706000", label: "Prestations", debit: 0, credit: item.totals.ht, reference: item.number }, { date: item.issueDate, account: "445710", label: "TVA collectée", debit: 0, credit: item.totals.vat, reference: item.number }]);
    const settlements = payload.payments.flatMap(item => [{ date: item.date, account: "512000", label: item.method, debit: item.amount, credit: 0, reference: item.reference }, { date: item.date, account: "411000", label: `Règlement ${item.invoiceNumber}`, debit: 0, credit: item.amount, reference: item.reference }]);
    const credits = payload.credits.flatMap(item => [{ date: item.date, account: "706000", label: `Avoir ${item.number}`, debit: item.amount / 1.2, credit: 0, reference: item.number }, { date: item.date, account: "445710", label: "TVA sur avoir", debit: item.amount - item.amount / 1.2, credit: 0, reference: item.number }, { date: item.date, account: "411000", label: `Client ${item.customerName}`, debit: 0, credit: item.amount, reference: item.number }]);
    return { sales, settlements, credits };
}

function exportData(payload, scope) {
    const sandbox = publicSandbox(payload);
    const documents = [
        ...sandbox.invoices.map(item => ({ Type: "Facture", Numéro: item.number, Date: item.issueDate, Client: item.customer.name, Statut: statusLabel(item.status), "Total HT": item.totals.ht, TVA: item.totals.vat, "Total TTC": item.totals.ttc, Réglé: item.paidAmount, Avoirs: item.creditAmount, Solde: item.remainingAmount })),
        ...payload.quotes.map(item => ({ Type: "Devis", Numéro: item.number, Date: item.issueDate, Client: item.customer.name, Statut: statusLabel(item.status), "Total HT": totals(item).ht, TVA: totals(item).vat, "Total TTC": totals(item).ttc, Réglé: "", Avoirs: "", Solde: "" })),
        ...payload.credits.map(item => ({ Type: "Avoir", Numéro: item.number, Date: item.date, Client: item.customerName, Statut: "Émis", "Total HT": round(item.amount / 1.2), TVA: round(item.amount - item.amount / 1.2), "Total TTC": -item.amount, Réglé: "", Avoirs: item.amount, Solde: 0 }))
    ];
    if (scope === "invoices") return documents.filter(item => item.Type === "Facture");
    if (scope === "quotes") return documents.filter(item => item.Type === "Devis");
    if (scope === "credits") return documents.filter(item => item.Type === "Avoir");
    if (scope === "payments") return payload.payments.map(item => ({ Date: item.date, Facture: item.invoiceNumber, Client: item.customerName, Montant: item.amount, Mode: item.method, Référence: item.reference }));
    if (scope === "journals") return Object.entries(sandbox.journals).flatMap(([journal, rows]) => rows.map(item => ({ Journal: journal === "sales" ? "Ventes" : journal === "settlements" ? "Règlements" : "Avoirs", Date: item.date, Compte: item.account, Libellé: item.label, Débit: item.debit, Crédit: item.credit, Référence: item.reference })));
    return documents;
}

function buildCsv(rows) { const headers = rows.length ? Object.keys(rows[0]) : ["Aucune donnée"]; const escape = value => `\"${String(value ?? "").replace(/\"/g, '\"\"')}\"`; return `\ufeff${headers.map(escape).join(";")}\n${rows.map(row => headers.map(header => escape(row[header])).join(";")).join("\n")}`; }
function buildFec(payload) { const columns = ["JournalCode", "JournalLib", "EcritureNum", "EcritureDate", "CompteNum", "CompteLib", "CompAuxNum", "CompAuxLib", "PieceRef", "PieceDate", "EcritureLib", "Debit", "Credit", "EcrDate", "DateLet", "ValidDate", "Montantdevise", "Idevise"]; const rows = []; Object.entries(journals(payload, publicSandbox(payload).invoices)).forEach(([journal, entries]) => entries.forEach((item, index) => rows.push([journal === "sales" ? "VTE" : journal === "settlements" ? "BQ" : "AVO", journal === "sales" ? "Ventes" : journal === "settlements" ? "Règlements" : "Avoirs", `${journal.slice(0, 3).toUpperCase()}${String(index + 1).padStart(6, "0")}`, item.date.replaceAll("-", ""), item.account, item.label, "", "", item.reference, item.date.replaceAll("-", ""), item.label, item.debit, item.credit, item.date.replaceAll("-", ""), "", item.date.replaceAll("-", ""), "", "EUR"].join("\t")))); return `${columns.join("\t")}\n${rows.join("\n")}`; }
async function buildWorkbook(payload, scope) { const workbook = new ExcelJS.Workbook(); workbook.creator = "Depann’Home Pro · Sandbox"; const add = (name, rows) => { const sheet = workbook.addWorksheet(name); const headers = rows.length ? Object.keys(rows[0]) : ["Aucune donnée"]; sheet.columns = headers.map(header => ({ header, key: header, width: Math.max(14, Math.min(32, header.length + 8)) })); rows.forEach(row => sheet.addRow(row)); sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } }; sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF5B21B6" } }; sheet.views = [{ state: "frozen", ySplit: 1 }]; }; if (scope === "all") { add("Documents", exportData(payload, "all")); add("Règlements", exportData(payload, "payments")); add("Journaux", exportData(payload, "journals")); } else add(scope === "journals" ? "Journaux" : "Export", exportData(payload, scope)); return workbook; }

function client(name, address) { return { id: crypto.randomUUID(), name, address, email: `${name.toLowerCase().replace(/[^a-z]+/g, ".").replace(/^\.|\.$/g, "")}@example.test` }; }
function intervention(customer, title, technician, when) { return { id: crypto.randomUUID(), customerId: customer.id, customerName: customer.name, title, technician, date: dateKey(when), reportStatus: "completed", status: "closed" }; }
function line(description, quantity, unitPrice, vatRate) { return { description, quantity, unitPrice, vatRate }; }
function document(type, number, customer, status, when, lines) { return { id: crypto.randomUUID(), type, number, customer, status, issueDate: dateKey(when), dueDate: dateKey(addDays(when, 30)), lines }; }
function invoice(number, customer, status, when, lines, paymentMethod) { return { ...document("invoice", number, customer, status, when, lines), paymentMethod }; }
function payment(invoice, amount, method, when, reference) { return { id: crypto.randomUUID(), invoiceId: invoice.id, invoiceNumber: invoice.number, customerName: invoice.customer.name, amount: round(amount), method, date: dateKey(when), reference }; }
function credit(invoice, amount, reason, when) { return { id: crypto.randomUUID(), number: `AVO-DEMO-${invoice.number.split("-").at(-1)}-${Math.abs(new Date(when).getTime()).toString().slice(-3)}`, invoiceId: invoice.id, invoiceNumber: invoice.number, customerName: invoice.customer.name, amount: round(amount), reason, date: dateKey(when) }; }
function totals(item) { const ht = round(item.lines.reduce((sum, value) => sum + value.quantity * value.unitPrice, 0)); const vat = round(item.lines.reduce((sum, value) => sum + value.quantity * value.unitPrice * value.vatRate / 100, 0)); return { ht, vat, ttc: round(ht + vat) }; }
function total(item) { return totals(item).ttc; }
function paid(payload, invoice) { return round(payload.payments.filter(item => item.invoiceId === invoice.id).reduce((sum, item) => sum + item.amount, 0)); }
function credited(payload, invoice) { return round(payload.credits.filter(item => item.invoiceId === invoice.id).reduce((sum, item) => sum + item.amount, 0)); }
function remaining(payload, invoice) { return Math.max(0, round(total(invoice) - paid(payload, invoice) - credited(payload, invoice))); }
function availableCredit(payload, invoice) { return Math.max(0, round(total(invoice) - credited(payload, invoice))); }
function paymentStatus(payload, invoice) { if (invoice.status === "cancelled") return "cancelled"; if (invoice.status === "draft") return "draft"; if (remaining(payload, invoice) <= .01) return "paid"; if (invoice.dueDate < dateKey(new Date())) return "overdue"; return paid(payload, invoice) ? "partial" : "unpaid"; }
function findInvoice(payload, id) { return payload.invoices.find(item => item.id === String(id)); }
function nextNumber(payload, prefix) { return `${prefix}-DEMO-${new Date().getFullYear()}-${String(payload.invoices.length + payload.quotes.length + 1).padStart(3, "0")}`; }
function log(payload, type, label, when = new Date()) { payload.timeline.unshift({ id: crypto.randomUUID(), type, label, occurredAt: new Date(when).toISOString() }); payload.timeline = payload.timeline.slice(0, 120); }
async function loadSession(ownerId) { const { rows } = await getPool().query("SELECT payload FROM depannhome_accounting_sandbox_sessions WHERE owner_id=$1", [ownerId]); return rows[0]?.payload || null; }
async function requiredPayload(request) { const payload = await loadSession(getAccountOwnerId(request)); if (!payload) throw clientError(404, "Le laboratoire comptable n’est pas activé."); return payload; }
async function saveSession(ownerId, userId, payload) { await getPool().query(`INSERT INTO depannhome_accounting_sandbox_sessions(owner_id,payload,created_by) VALUES($1,$2::jsonb,$3) ON CONFLICT(owner_id) DO UPDATE SET payload=EXCLUDED.payload, updated_at=NOW()`, [ownerId, JSON.stringify(payload), userId || null]); }
function requireSandboxAdministration(request, response, next) { if (isCompanyAdministrator(request)) return next(); return response.status(403).json({ message: "Le laboratoire comptable est réservé à un Administrateur (PC)." }); }
function requireSandboxEnabled(_request, response, next) { if (isAccountingSandboxEnabled()) return next(); return response.status(404).json({ message: "Laboratoire comptable indisponible." }); }
function textDownload(response, content, filename, contentType) { response.set({ "Content-Type": contentType, "Content-Disposition": `attachment; filename=\"${filename}\"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" }); response.send(content); }
function statusLabel(value) { return ({ draft: "Brouillon", validated: "Validée", sent: "Envoyée", paid: "Payée", partial: "Partiellement réglée", overdue: "Impayée", cancelled: "Annulée", accepted: "Accepté", rejected: "Refusé", pending: "En attente" })[value] || value; }
function dateKey(value) { return new Date(value).toISOString().slice(0, 10); }
function addDays(value, days) { const date = new Date(value); date.setDate(date.getDate() + days); return date; }
function daysAgo(days) { return addDays(new Date(), -days); }
function round(value) { return Math.round((Number(value) || 0) * 100) / 100; }
function clientError(status, message) { const error = new Error(message); error.status = status; return error; }
function asyncHandler(handler) { return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(error => error.status ? response.status(error.status).json({ message: error.message }) : next(error)); }
