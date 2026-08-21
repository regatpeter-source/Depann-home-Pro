import { clearSearch, getContainer, setPage } from "./ui.js?v=44";
import { ROUTES } from "./config.js?v=127";
import { escapeHtml, normalizeText } from "./utils.js?v=44";
import { renderPurchases } from "./purchases.js?v=116";

const SECTIONS = [
    ["dashboard", "Tableau de bord"], ["salesJournal", "Journal des ventes"], ["settlements", "Règlements"], ["credits", "Avoirs"], ["vat", "TVA"], ["purchases", "Achats"], ["export", "Export comptable"], ["fec", "Export FEC"], ["control", "Contrôle comptable"], ["electronic", "Facturation électronique & PDP"], ["settings", "Paramètres"]
];
let accounting = null;
let activeSection = "dashboard";

export async function renderAccounting(section = activeSection) {
    activeSection = SECTIONS.some(([id]) => id === section) ? section : "dashboard";
    clearSearch();
    setPage("Comptabilité · Facturation électronique & PDP", ROUTES.accounting, "detail");
    const container = getContainer();
    container.innerHTML = '<section class="client-panel accounting-shell"><p class="muted">Chargement du module comptable…</p></section>';
    const result = await api("/api/accounting");
    if (!result.ok) { container.innerHTML = `<section class="client-panel"><p class="auth-message error">${escapeHtml(result.message || "Impossible de charger le module comptable.")}</p></section>`; return; }
    accounting = result.data;
    const shell = container.querySelector(".accounting-shell");
    shell.innerHTML = `<header class="accounting-heading"><div><p class="eyebrow">Données réelles de l’entreprise</p><h2>Comptabilité & facturation électronique</h2><p class="muted">Journal persistant isolé pour votre entreprise, contrôles et exports destinés à votre cabinet comptable.</p></div></header><aside class="accounting-pdp-notice">Depann’Home Pro prépare des écritures et fichiers à faire valider par un professionnel de la comptabilité. Ce module n’est pas un logiciel comptable certifié et ne garantit pas, à lui seul, la conformité d’un FEC.</aside><nav class="accounting-tabs" aria-label="Sections comptables">${SECTIONS.map(([id, label]) => `<button type="button" class="secondary-button${id === activeSection ? " active" : ""}" data-accounting-section="${id}">${label}</button>`).join("")}</nav><section id="accountingContent"></section>`;
    shell.querySelectorAll("[data-accounting-section]").forEach(button => button.addEventListener("click", () => renderAccounting(button.dataset.accountingSection)));
    const content = shell.querySelector("#accountingContent");
    ({ dashboard: renderDashboard, salesJournal: renderSalesJournal, settlements: renderSettlements, credits: () => renderDocuments(content, "credit"), vat: renderVat, purchases: () => renderPurchases({ container: content, embedded: true }), export: renderExports, fec: renderFecExport, control: renderAccountingControl, electronic: renderElectronic, settings: renderSettings })[activeSection](content);
}

function renderDashboard(node) {
    const data = accounting.dashboard;
    node.innerHTML = `<div class="accounting-cards"><article><span>Chiffre d’affaires</span><strong>${money(data.turnover)}</strong><small>${data.invoicesCount} facture(s)</small></article><article><span>Encaissements</span><strong>${money(data.collected)}</strong><small>Règlements saisis</small></article><article><span>À encaisser</span><strong>${money(data.outstanding)}</strong><small>${data.overdueCount} impayé(s)</small></article><article class="${data.overdueAmount ? "attention" : ""}"><span>Impayés</span><strong>${money(data.overdueAmount)}</strong><small>Échéances dépassées</small></article><article><span>Achats HT</span><strong>${money(data.purchasesHt)}</strong><small>Charges enregistrées</small></article></div><section class="accounting-panel"><div class="form-heading"><div><p class="eyebrow">Suivi des règlements</p><h3>Impayés et factures à encaisser</h3></div></div>${renderPaymentRows(accounting.documents.filter(item => item.documentType === "invoice" && item.paymentStatus !== "paid"))}</section>`;
}

function renderDocuments(node, type) {
    const label = type === "quote" ? "Devis" : type === "credit" ? "Avoirs" : "Factures";
    const documents = accounting.documents.filter(item => item.documentType === type);
    node.innerHTML = `<section class="accounting-panel"><div class="form-heading"><div><p class="eyebrow">${label}</p><h3>${type === "quote" ? "Devis, aides et reste à charge" : "Factures, règlements et impayés"}</h3></div><button type="button" class="secondary-button" id="accountingRefresh">Actualiser</button></div><input class="accounting-search" id="accountingDocumentSearch" type="search" placeholder="Rechercher un numéro ou un client"><div class="accounting-document-list" id="accountingDocumentList"></div></section>`;
    const list = node.querySelector("#accountingDocumentList");
    const render = () => {
        const query = normalizeText(node.querySelector("#accountingDocumentSearch").value);
        const shown = documents.filter(item => !query || normalizeText(`${item.documentNumber} ${item.customerName}`).includes(query));
        list.innerHTML = shown.length ? shown.map(item => `<article class="accounting-document"><div><p class="eyebrow">${escapeHtml(item.documentNumber)} · ${escapeHtml(documentStatusLabel(item.status))}</p><h4>${escapeHtml(item.customerName)}</h4><small>${escapeHtml(date(item.issueDate))}${item.dueDate ? ` · Échéance ${escapeHtml(date(item.dueDate))}` : ""}</small></div><div class="accounting-document-totals"><strong>${money(Math.abs(item.totals.netPayable))}</strong><small>${item.isAccounted ? "Écriture validée" : type === "quote" ? `Aides ${money(item.totals.aids)} · TTC ${money(item.totals.ttc)}` : paymentLabel(item)}</small></div><div class="accounting-document-actions">${type === "quote" ? `<button type="button" class="secondary-button" data-financial="${item.id}">Aides / remises</button>` : type === "invoice" ? `<button type="button" class="secondary-button" data-post="${item.id}" ${item.isAccounted ? "disabled" : ""}>${item.isAccounted ? "Comptabilisée" : "Comptabiliser"}</button><button type="button" class="secondary-button" data-settlement="${item.id}" ${item.remainingAmount <= 0 ? "disabled" : ""}>Règlement</button><button type="button" class="secondary-button" data-credit="${item.id}">Créer un avoir</button>` : ""}</div></article>`).join("") : '<p class="muted">Aucun document trouvé.</p>';
        list.querySelectorAll("[data-financial]").forEach(button => button.addEventListener("click", () => renderFinancialEditor(node, documents.find(item => String(item.id) === button.dataset.financial))));
        list.querySelectorAll("[data-settlement]").forEach(button => button.addEventListener("click", () => renderSettlementForm(node, documents.find(item => String(item.id) === button.dataset.settlement))));
        list.querySelectorAll("[data-credit]").forEach(button => button.addEventListener("click", () => createCredit(button.dataset.credit)));
        list.querySelectorAll("[data-post]").forEach(button => button.addEventListener("click", async () => { button.disabled = true; const result = await api(`/api/accounting/documents/${button.dataset.post}/post`, { method: "POST" }); if (!result.ok) alert(result.message || "Comptabilisation impossible."); renderAccounting("salesJournal"); }));
    };
    node.querySelector("#accountingDocumentSearch").addEventListener("input", render);
    node.querySelector("#accountingRefresh").addEventListener("click", () => renderAccounting(activeSection));
    render();
}

function renderFinancialEditor(node, document) {
    const data = document.financialData || {};
    node.insertAdjacentHTML("beforeend", `<section class="accounting-panel accounting-inline-form"><div class="form-heading"><div><p class="eyebrow">${escapeHtml(document.documentNumber)}</p><h3>Aides, remises et conditions</h3></div></div><form id="financialForm"><div class="form-grid"><label>Remise<select name="discountMode"><option value="fixed" ${data.discountMode === "fixed" ? "selected" : ""}>Montant fixe (€ HT)</option><option value="percentage" ${data.discountMode === "percentage" ? "selected" : ""}>Pourcentage (%)</option></select></label><label>Montant de la remise<input name="discountAmount" type="number" min="0" step="0.01" value="${escapeHtml(data.discountAmount || 0)}"></label><label>Acompte attendu<input name="depositAmount" type="number" min="0" step="0.01" value="${escapeHtml(data.depositAmount || 0)}"></label><label class="form-wide">Conditions particulières<textarea name="conditions" rows="2">${escapeHtml(data.conditions || "")}</textarea></label><label class="form-wide">Commentaires<textarea name="comments" rows="2">${escapeHtml(data.comments || "")}</textarea></label></div><fieldset class="accounting-aid-fieldset"><legend>Aides financières</legend><p class="muted">Sélectionnez les aides applicables uniquement à ce devis.</p>${accounting.aids.map(aid => `<label><input type="checkbox" name="aid" value="${aid.id}" ${(data.aids || []).some(item => item.name === aid.name) ? "checked" : ""}> ${escapeHtml(aid.name)} · ${aid.calculationMode === "percentage" ? `${aid.amount} %` : money(aid.amount)}</label>`).join("") || '<p class="muted">Créez d’abord vos aides dans l’onglet « Aides financières ».</p>'}</fieldset><p class="auth-message" id="financialMessage"></p><div class="calendar-form-actions"><button type="submit" class="secondary-button">Enregistrer les données financières</button><button type="button" class="secondary-button" id="closeFinancial">Fermer</button></div></form></section>`);
    const panel = node.lastElementChild;
    panel.querySelector("#closeFinancial").addEventListener("click", () => panel.remove());
    panel.querySelector("form").addEventListener("submit", async event => {
        event.preventDefault(); const form = new FormData(event.currentTarget);
        const aids = form.getAll("aid").map(id => accounting.aids.find(aid => String(aid.id) === String(id))).filter(Boolean).map(aid => ({ name: aid.name, amount: aid.amount, calculationMode: aid.calculationMode, aidType: aid.aidType, description: aid.description }));
        const result = await api(`/api/accounting/documents/${document.id}/financial-data`, { method: "PUT", body: JSON.stringify({ discountMode: form.get("discountMode"), discountAmount: form.get("discountAmount"), depositAmount: form.get("depositAmount"), conditions: form.get("conditions"), comments: form.get("comments"), aids }) });
        if (!result.ok) { panel.querySelector("#financialMessage").textContent = result.message || "Enregistrement impossible."; panel.querySelector("#financialMessage").classList.add("error"); return; }
        renderAccounting("quotes");
    });
}

function renderSettlementForm(node, document) {
    node.insertAdjacentHTML("beforeend", `<section class="accounting-panel accounting-inline-form"><div class="form-heading"><div><p class="eyebrow">${escapeHtml(document.documentNumber)}</p><h3>Enregistrer un règlement</h3><p class="muted">Solde restant : ${money(document.remainingAmount)}</p></div></div><form id="settlementForm"><div class="form-grid"><label>Date<input name="date" type="date" required value="${today()}"></label><label>Montant<input name="amount" type="number" min="0.01" max="${document.remainingAmount}" step="0.01" required value="${document.remainingAmount}"></label><label>Mode<select name="method"><option>Virement</option><option>Carte bancaire</option><option>Chèque</option><option>Espèces</option><option>Prélèvement</option><option>Autre</option></select></label><label>Référence<input name="reference" maxlength="160"></label><label class="form-wide">Note<textarea name="notes" rows="2"></textarea></label></div><p class="auth-message"></p><div class="calendar-form-actions"><button class="secondary-button">Enregistrer le règlement</button><button type="button" class="secondary-button" data-close>Fermer</button></div></form></section>`);
    const panel = node.lastElementChild; panel.querySelector("[data-close]").addEventListener("click", () => panel.remove());
    panel.querySelector("form").addEventListener("submit", async event => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); const result = await api("/api/accounting/settlements", { method: "POST", body: JSON.stringify({ ...values, documentId: document.id }) }); if (!result.ok) { const message = panel.querySelector(".auth-message"); message.textContent = result.message || "Règlement impossible."; message.classList.add("error"); return; } renderAccounting("salesJournal"); });
}

async function createCredit(documentId) {
    const amount = window.prompt("Montant TTC de l’avoir :"); if (amount === null) return;
    const notes = window.prompt("Motif de l’avoir (facultatif) :", "") ?? "";
    const result = await api(`/api/accounting/documents/${encodeURIComponent(documentId)}/credits`, { method: "POST", body: JSON.stringify({ amount, notes }) });
    if (!result.ok) return alert(result.message || "Création de l’avoir impossible.");
    renderAccounting("credits");
}

function renderSalesJournal(node) {
    const entries = (accounting.ledger?.entries || []).filter(entry => entry.journalCode === (accounting.settings.journalConfig?.sales?.code || "VE"));
    node.innerHTML = `<section class="accounting-panel"><div class="form-heading"><div><p class="eyebrow">Grand livre persistant</p><h3>Journal des ventes</h3><p class="muted">Une seule écriture numérotée par facture ou avoir, avec le détail Débit / Crédit.</p></div><button type="button" class="secondary-button" id="showInvoices">Factures à comptabiliser</button></div>${renderLedgerEntries(entries)}</section>`;
    node.querySelector("#showInvoices").addEventListener("click", () => { activeSection = "invoices"; const content = node; renderDocuments(content, "invoice"); });
}

function renderSettlements(node) {
    node.innerHTML = `<section class="accounting-panel"><div class="form-heading"><div><p class="eyebrow">Journal de banque</p><h3>Règlements clients</h3><p class="muted">Les règlements restent distincts des factures et peuvent être partiels ou multiples.</p></div></div><div class="accounting-document-list">${accounting.settlements.length ? accounting.settlements.map(item => `<article class="accounting-document"><div><strong>${escapeHtml(item.documentNumber)}</strong><p>${escapeHtml(item.customerName)}</p><small>${escapeHtml(date(item.date))} · ${escapeHtml(item.method)}${item.reference ? ` · ${escapeHtml(item.reference)}` : ""}</small></div><div class="accounting-document-totals"><strong>${money(item.amount)}</strong><small>Écriture bancaire validée</small></div></article>`).join("") : '<p class="muted">Aucun règlement enregistré.</p>'}</div></section>`;
}

function renderVat(node) {
    const vatLines = (accounting.ledger?.entries || []).flatMap(entry => entry.lines.map(line => ({ ...line, entry }))).filter(line => String(line.accountNumber).startsWith("445"));
    const collected = vatLines.reduce((sum, line) => sum + Number(line.credit || 0) - Number(line.debit || 0), 0);
    node.innerHTML = `<section class="accounting-panel"><div class="form-heading"><div><p class="eyebrow">TVA collectée</p><h3>Ventilation de TVA</h3><p class="muted">Synthèse issue exclusivement des écritures validées. À rapprocher de vos déclarations par votre cabinet comptable.</p></div></div><div class="accounting-cards"><article><span>TVA collectée nette</span><strong>${money(collected)}</strong><small>${vatLines.length} ligne(s)</small></article></div>${renderLedgerEntries(vatLines.map(item => ({ ...item.entry, lines: [item] })))}</section>`;
}

function renderAccountingControl(node) {
    const control = accounting.ledger?.control || { anomalies: [] };
    node.innerHTML = `<section class="accounting-panel"><div class="form-heading"><div><p class="eyebrow">Contrôle préalable</p><h3>${control.valid ? "Journal comptable équilibré" : "Anomalies comptables détectées"}</h3><p class="muted">${control.entries || 0} écriture(s) · ${control.lines || 0} ligne(s) · ${control.pieces || 0} pièce(s) · ${control.journals || 0} journal(aux)</p></div></div><div class="accounting-cards"><article><span>Total débit</span><strong>${money(control.totalDebit)}</strong></article><article><span>Total crédit</span><strong>${money(control.totalCredit)}</strong></article><article class="${control.difference ? "attention" : ""}"><span>Écart</span><strong>${money(control.difference)}</strong></article></div>${renderAnomalies(control.anomalies)}</section>`;
}

function renderExports(node) {
    node.innerHTML = `<section class="accounting-panel"><div class="form-heading"><div><p class="eyebrow">Préparer mon export comptable</p><h3>Export classique pour le cabinet</h3><p class="muted">Téléchargez le journal validé en CSV ou Excel. Les exports FEC sont contrôlés séparément.</p></div></div><form id="exportForm" class="form-grid"><label>Date de début<input name="start" type="date"></label><label>Date de fin<input name="end" type="date"></label><label>Format<select name="format"><option value="csv">CSV</option><option value="xlsx">Excel (.xlsx)</option></select></label><div class="form-actions"><button class="secondary-button">Contrôler et télécharger</button></div></form><p class="auth-message" id="exportMessage"></p></section>`;
    const form = node.querySelector("form"); form.addEventListener("submit", async event => { event.preventDefault(); const values = Object.fromEntries(new FormData(form)); const url = `/api/accounting/export/ledger?${new URLSearchParams(values)}`; const result = await downloadAccountingFile(url); if (!result.ok) { node.querySelector("#exportMessage").textContent = result.message || "Export bloqué."; node.querySelector("#exportMessage").classList.add("error"); } });
}

function renderFecExport(node) {
    const config = accounting.settings.fecConfig || {};
    node.innerHTML = `<section class="accounting-panel"><div class="form-heading"><div><p class="eyebrow">Assistant en 3 étapes</p><h3>Préparer un fichier d’écritures comptables</h3><p class="muted">1. Exercice · 2. Contrôle · 3. Génération. Le fichier doit être vérifié par votre cabinet comptable.</p></div></div><aside class="accounting-pdp-notice">Ce générateur n’est pas présenté comme un FEC certifié. La génération reste bloquée sans écritures de reprise, opérations d’inventaire, exhaustivité de tous les journaux et SIREN valide.</aside><form id="fecForm" class="form-grid"><label>Début de l’exercice *<input name="start" type="date" required value="${escapeHtml(config.fiscalYearStart || "")}"></label><label>Clôture de l’exercice *<input name="end" type="date" required value="${escapeHtml(config.fiscalYearEnd || "")}"></label><fieldset class="accounting-rules form-wide"><legend>Confirmations de l’entreprise</legend><label><input type="checkbox" name="openingEntriesConfirmed"> Les reprises de soldes de l’exercice précédent sont présentes.</label><label><input type="checkbox" name="inventoryEntriesConfirmed"> Les opérations d’inventaire sont présentes.</label><label><input type="checkbox" name="completeLedgerConfirmed"> Tous les journaux informatisés de l’exercice sont inclus.</label></fieldset><div class="form-actions"><button class="secondary-button" name="action" value="control">2. Lancer le contrôle</button><button class="secondary-button" type="button" id="generateFec" disabled>3. Générer le fichier</button></div></form><div id="fecControl"></div></section>`;
    const form = node.querySelector("form"); const output = node.querySelector("#fecControl"); const generate = node.querySelector("#generateFec"); let validatedPayload = null;
    form.addEventListener("submit", async event => { event.preventDefault(); const payload = fecPayload(form); const result = await api("/api/accounting/export/control", { method: "POST", body: JSON.stringify({ ...payload, fec: true }) }); const control = result.data?.control; validatedPayload = result.ok && control?.valid ? payload : null; generate.disabled = !validatedPayload; output.innerHTML = result.ok ? `<h4>${control.valid ? "Contrôle réussi" : "Export bloqué"}</h4><p class="muted">${control.entries} écriture(s), ${control.lines} ligne(s), débit ${money(control.totalDebit)}, crédit ${money(control.totalCredit)}.</p>${renderAnomalies(control.anomalies)}` : `<p class="auth-message error">${escapeHtml(result.message || "Contrôle impossible.")}</p>`; });
    generate.addEventListener("click", async () => { if (!validatedPayload) return; generate.disabled = true; const result = await downloadAccountingFile("/api/accounting/export/fec", { method: "POST", body: JSON.stringify(validatedPayload) }); if (!result.ok) output.insertAdjacentHTML("beforeend", `<p class="auth-message error">${escapeHtml(result.message || "Génération bloquée.")}</p>`); generate.disabled = false; });
}

function renderLedgerEntries(entries) {
    return entries.length ? `<div class="accounting-document-list">${entries.map(entry => `<article class="accounting-document"><div><p class="eyebrow">${escapeHtml(entry.journalCode)} · ${escapeHtml(entry.entryNumber)}</p><h4>${escapeHtml(entry.description)}</h4><small>Pièce ${escapeHtml(entry.pieceRef)} · ${escapeHtml(date(entry.entryDate))}</small></div><div class="accounting-document-totals">${entry.lines.map(line => `<small>${escapeHtml(line.accountNumber)} · D ${money(line.debit)} / C ${money(line.credit)}</small>`).join("")}</div></article>`).join("")}</div>` : '<p class="muted">Aucune écriture validée.</p>';
}
function renderAnomalies(anomalies = []) { return anomalies.length ? `<ul class="auth-message error">${anomalies.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : '<p class="auth-message success">Aucune anomalie détectée sur les écritures sélectionnées.</p>'; }
function fecPayload(form) { const data = new FormData(form); return { start: data.get("start"), end: data.get("end"), openingEntriesConfirmed: data.get("openingEntriesConfirmed") === "on", inventoryEntriesConfirmed: data.get("inventoryEntriesConfirmed") === "on", completeLedgerConfirmed: data.get("completeLedgerConfirmed") === "on" }; }

function renderLegacyElectronic(node) {
    node.innerHTML = `<section class="accounting-panel"><div class="form-heading"><div><p class="eyebrow">Préparation et transmission</p><h3>Facturation électronique & PDP</h3><p class="muted">Préparez vos factures électroniques, suivez les échanges et renvoyez-les via le connecteur de la PDP choisie par votre entreprise.</p></div></div><aside class="accounting-pdp-notice">Depann'Home Pro est un logiciel métier compatible avec la facturation électronique. Il prépare les factures électroniques et permet leur transmission via une Plateforme de Dématérialisation Partenaire (PDP) choisie par votre entreprise. Depann'Home Pro n'est pas une PDP agréée par l'État.</aside><div class="accounting-transmission-list">${accounting.transmissions.length ? accounting.transmissions.map(item => `<article><div><strong>${escapeHtml(item.documentNumber)}</strong><p>${escapeHtml(item.provider)} · ${escapeHtml(transmissionStatusLabel(item.status))}</p><small>${escapeHtml(item.message || "Aucun message")}</small></div><button type="button" class="secondary-button" data-transmit="${item.documentId}">Renvoyer</button></article>`).join("") : '<p class="muted">Aucune transmission pour le moment.</p>'}</div><h4>Factures prêtes à transmettre</h4><div class="accounting-transmission-list">${accounting.documents.filter(item => item.documentType === "invoice").map(item => `<article><div><strong>${escapeHtml(item.documentNumber)}</strong><p>${escapeHtml(item.customerName)} · ${money(item.totals.netPayable)}</p></div><button type="button" class="secondary-button" data-transmit="${item.id}">Transmettre</button></article>`).join("") || '<p class="muted">Aucune facture disponible.</p>'}</div></section>`;
    node.querySelectorAll("[data-transmit]").forEach(button => button.addEventListener("click", async () => { button.disabled = true; const result = await api(`/api/accounting/e-invoices/${button.dataset.transmit}/transmit`, { method: "POST" }); if (!result.ok) alert(result.message || "Transmission impossible."); renderAccounting("electronic"); }));
}

function renderLegacySettings(node) {
    const settings = accounting.settings;
    node.innerHTML = `<section class="accounting-panel"><div class="form-heading"><div><p class="eyebrow">Paramètres entreprise et PDP</p><h3>Paramètres comptables</h3><p class="muted">Les coordonnées société, SIREN/SIRET, TVA, IBAN, logo et mentions légales restent configurés dans « Devis & factures ».</p></div></div><form id="accountingSettingsForm" class="form-grid"><fieldset class="accounting-rules form-wide"><legend>Plan comptable</legend><label>Compte ventes<input name="salesAccount" value="${escapeHtml(settings.chartConfig.salesAccount || "706000")}"></label><label>Compte clients<input name="customerAccount" value="${escapeHtml(settings.chartConfig.customerAccount || "411000")}"></label><label>Compte banque<input name="bankAccount" value="${escapeHtml(settings.chartConfig.bankAccount || "512000")}"></label><label>TVA collectée<input name="vatCollectedAccount" value="${escapeHtml(settings.chartConfig.vatCollectedAccount || "445710")}"></label><label>Compte achats<input name="purchaseAccount" value="${escapeHtml(settings.chartConfig.purchaseAccount || "606000")}"></label><label>Compte fournisseurs<input name="supplierAccount" value="${escapeHtml(settings.chartConfig.supplierAccount || "401000")}"></label></fieldset><fieldset class="accounting-rules form-wide"><legend>Plateforme de dématérialisation partenaire</legend><label>Connecteur<select name="provider">${accounting.connectors.map(connector => `<option value="${connector.id}" ${settings.pdpProvider === connector.id ? "selected" : ""}>${escapeHtml(connector.label)}</option>`).join("")}</select></label><label>Identifiant PDP<input name="identifier" value="${escapeHtml(settings.pdpIdentifier || "")}" maxlength="160"></label><label>Clé API${settings.hasApiKey ? " (laisser vide pour conserver)" : ""}<input name="apiKey" type="password" autocomplete="new-password"></label><label class="accounting-switch"><input name="enabled" type="checkbox" ${settings.pdpEnabled ? "checked" : ""}> Activer le connecteur PDP</label></fieldset><fieldset class="accounting-rules form-wide"><legend>Moteur d’aides</legend><label class="accounting-switch"><input name="aidEngineEnabled" type="checkbox" ${settings.aidEngineConfig.enabled ? "checked" : ""}> Préparer la suggestion automatique</label><label>Source de règles future<input name="aidEngineSource" value="${escapeHtml(settings.aidEngineConfig.source || "")}" maxlength="160" placeholder="API nationale, référentiel régional…"></label></fieldset><p class="auth-message"></p><div class="form-actions"><button class="secondary-button">Enregistrer les paramètres comptables</button></div></form></section>`;
    const planFieldset = node.querySelectorAll(".accounting-rules")[0];
    const journals = settings.journalConfig || {};
    if (planFieldset) planFieldset.insertAdjacentHTML("afterend", `<fieldset class="accounting-rules form-wide"><legend>Journaux et exercice</legend><label>Code journal des ventes<input name="salesJournalCode" maxlength="10" value="${escapeHtml(journals.sales?.code || "VE")}"></label><label>Libellé ventes<input name="salesJournalLabel" maxlength="100" value="${escapeHtml(journals.sales?.label || "Ventes")}"></label><label>Code journal de banque<input name="bankJournalCode" maxlength="10" value="${escapeHtml(journals.bank?.code || "BQ")}"></label><label>Libellé banque<input name="bankJournalLabel" maxlength="100" value="${escapeHtml(journals.bank?.label || "Banque")}"></label><label>Code opérations diverses<input name="generalJournalCode" maxlength="10" value="${escapeHtml(journals.general?.code || "OD")}"></label><label>Libellé opérations diverses<input name="generalJournalLabel" maxlength="100" value="${escapeHtml(journals.general?.label || "Opérations diverses")}"></label><label>Début d’exercice<input name="fiscalYearStart" type="date" value="${escapeHtml(settings.fecConfig?.fiscalYearStart || "")}"></label><label>Clôture d’exercice<input name="fiscalYearEnd" type="date" value="${escapeHtml(settings.fecConfig?.fiscalYearEnd || "")}"></label><p class="muted form-wide">Les comptes proposés sont des valeurs initiales configurables, pas des règles universelles. Faites-les valider par votre cabinet comptable.</p></fieldset>`);
    const pdpFieldset = node.querySelectorAll(".accounting-rules")[2];
    if (pdpFieldset) {
        pdpFieldset.querySelector("legend").textContent = "Connexion à une PDP choisie par l’entreprise";
        pdpFieldset.querySelector("label").firstChild.textContent = "Connecteur PDP";
        pdpFieldset.querySelector("legend").insertAdjacentHTML("afterend", '<p class="muted form-wide">Sélectionnez la PDP choisie par votre entreprise parmi les connecteurs disponibles. Depann\'Home Pro prépare les factures et les transmet via ce connecteur lorsqu’il est disponible.</p>');
    }
    node.querySelector("form").addEventListener("submit", async event => { event.preventDefault(); const form = new FormData(event.currentTarget); const payload = { provider: form.get("provider"), identifier: form.get("identifier"), apiKey: form.get("apiKey"), enabled: form.get("enabled") === "on", chartConfig: Object.fromEntries(["salesAccount", "customerAccount", "bankAccount", "vatCollectedAccount", "purchaseAccount", "supplierAccount"].map(key => [key, form.get(key)])), journalConfig: { sales: { code: form.get("salesJournalCode"), label: form.get("salesJournalLabel"), active: true }, bank: { code: form.get("bankJournalCode"), label: form.get("bankJournalLabel"), active: true }, general: { code: form.get("generalJournalCode"), label: form.get("generalJournalLabel"), active: true } }, fecConfig: { fiscalYearStart: form.get("fiscalYearStart"), fiscalYearEnd: form.get("fiscalYearEnd") }, aidEngineConfig: { enabled: form.get("aidEngineEnabled") === "on", source: form.get("aidEngineSource") } }; const result = await api("/api/accounting/settings", { method: "PUT", body: JSON.stringify(payload) }); if (!result.ok) return alert(result.message || "Enregistrement impossible."); renderAccounting("settings"); });
}

function renderElectronic(node) {
    const settings = accounting.settings;
    const ready = settings.pdpEnabled && settings.pdpPlatformName && settings.pdpApiUrl && settings.pdpIdentifier && settings.hasApiKey;
    node.innerHTML = `<section class="accounting-panel">
        <div class="form-heading"><div><p class="eyebrow">Échanges réels</p><h3>Facturation électronique</h3><p class="muted">Chaque entreprise utilise la plateforme agréée qu’elle a choisie et configurée dans ses paramètres.</p></div></div>
        <aside class="accounting-pdp-notice">${ready ? `Connexion active vers <strong>${escapeHtml(settings.pdpPlatformName)}</strong>. Les envois ci-dessous transmettent réellement l’archive UBL à ${escapeHtml(settings.pdpApiUrl)}.` : "Aucune plateforme réelle n’est active. Configurez votre plateforme avant toute transmission."}</aside>
        <div class="accounting-transmission-list">${accounting.transmissions.length ? accounting.transmissions.map(item => `<article><div><strong>${escapeHtml(item.documentNumber)}</strong><p>${escapeHtml(item.provider)} · ${escapeHtml(transmissionStatusLabel(item.status))}</p><small>${escapeHtml(item.message || "Aucun message")}</small></div><button type="button" class="secondary-button" data-transmit="${item.documentId}" ${ready ? "" : "disabled"}>Renvoyer</button></article>`).join("") : '<p class="muted">Aucune transmission réelle enregistrée.</p>'}</div>
        <h4>Factures et avoirs émis prêts à transmettre</h4>
        <div class="accounting-transmission-list">${accounting.documents.filter(item => ["invoice", "credit"].includes(item.documentType)).map(item => `<article><div><strong>${escapeHtml(item.documentNumber)}</strong><p>${item.documentType === "credit" ? "Avoir" : "Facture"} · ${escapeHtml(item.customerName)} · ${money(Math.abs(item.totals.netPayable))}</p></div><button type="button" class="secondary-button" data-transmit="${item.id}" ${ready ? "" : "disabled"}>Transmettre réellement</button></article>`).join("") || '<p class="muted">Aucune facture ni aucun avoir disponible.</p>'}</div>
    </section>`;
    node.querySelectorAll("[data-transmit]:not([disabled])").forEach(button => button.addEventListener("click", async () => {
        if (!window.confirm(`Transmettre réellement cette facture à ${settings.pdpPlatformName} ?`)) return;
        button.disabled = true;
        const result = await api(`/api/accounting/e-invoices/${button.dataset.transmit}/transmit`, { method: "POST" });
        if (!result.ok) alert(result.message || "Transmission impossible.");
        renderAccounting("electronic");
    }));
}

function renderSettings(node) {
    const settings = accounting.settings;
    const accounts = settings.chartConfig || {};
    const journals = settings.journalConfig || {};
    node.innerHTML = `<section class="accounting-panel">
        <div class="form-heading"><div><p class="eyebrow">Configuration propre à l’entreprise</p><h3>Comptabilité et plateforme de facturation électronique</h3><p class="muted">Chaque entreprise choisit librement sa plateforme et utilise ses propres identifiants contractuels.</p></div></div>
        <form id="accountingSettingsForm" class="form-grid">
            <fieldset class="accounting-rules form-wide"><legend>Plan comptable</legend>
                <label>Compte ventes<input name="salesAccount" value="${escapeHtml(accounts.salesAccount || "706000")}"></label>
                <label>Compte clients<input name="customerAccount" value="${escapeHtml(accounts.customerAccount || "411000")}"></label>
                <label>Compte banque<input name="bankAccount" value="${escapeHtml(accounts.bankAccount || "512000")}"></label>
                <label>TVA collectée<input name="vatCollectedAccount" value="${escapeHtml(accounts.vatCollectedAccount || "445710")}"></label>
                <label>Compte achats<input name="purchaseAccount" value="${escapeHtml(accounts.purchaseAccount || "606000")}"></label>
                <label>Compte fournisseurs<input name="supplierAccount" value="${escapeHtml(accounts.supplierAccount || "401000")}"></label>
            </fieldset>
            <fieldset class="accounting-rules form-wide"><legend>Journaux et exercice</legend>
                <label>Code journal des ventes<input name="salesJournalCode" maxlength="10" value="${escapeHtml(journals.sales?.code || "VE")}"></label>
                <label>Libellé ventes<input name="salesJournalLabel" maxlength="100" value="${escapeHtml(journals.sales?.label || "Ventes")}"></label>
                <label>Code journal de banque<input name="bankJournalCode" maxlength="10" value="${escapeHtml(journals.bank?.code || "BQ")}"></label>
                <label>Libellé banque<input name="bankJournalLabel" maxlength="100" value="${escapeHtml(journals.bank?.label || "Banque")}"></label>
                <label>Code opérations diverses<input name="generalJournalCode" maxlength="10" value="${escapeHtml(journals.general?.code || "OD")}"></label>
                <label>Libellé opérations diverses<input name="generalJournalLabel" maxlength="100" value="${escapeHtml(journals.general?.label || "Opérations diverses")}"></label>
                <label>Début d’exercice<input name="fiscalYearStart" type="date" value="${escapeHtml(settings.fecConfig?.fiscalYearStart || "")}"></label>
                <label>Clôture d’exercice<input name="fiscalYearEnd" type="date" value="${escapeHtml(settings.fecConfig?.fiscalYearEnd || "")}"></label>
            </fieldset>
            <fieldset class="accounting-rules form-wide"><legend>Plateforme choisie par cette entreprise</legend>
                <p class="muted form-wide">Renseignez l’endpoint de dépôt fourni par votre plateforme agréée. Il doit accepter une facture UBL XML par requête HTTPS avec authentification Bearer.</p>
                <label>Nom de la plateforme<input name="platformName" maxlength="160" value="${escapeHtml(settings.pdpPlatformName || "")}" placeholder="Nom de votre plateforme agréée"></label>
                <label class="form-wide">URL API réelle de dépôt UBL<input name="apiUrl" type="url" maxlength="1000" value="${escapeHtml(settings.pdpApiUrl || "")}" placeholder="https://api.plateforme.fr/v1/invoices"></label>
                <label>Identifiant entreprise sur la plateforme<input name="identifier" maxlength="160" value="${escapeHtml(settings.pdpIdentifier || "")}"></label>
                <label>Clé API${settings.hasApiKey ? " (laisser vide pour conserver)" : ""}<input name="apiKey" type="password" autocomplete="new-password"></label>
                <label class="accounting-switch"><input name="enabled" type="checkbox" ${settings.pdpEnabled ? "checked" : ""}> Activer les transmissions réelles</label>
            </fieldset>
            <p class="auth-message" id="accountingSettingsMessage"></p>
            <div class="form-actions"><button class="secondary-button">Enregistrer les paramètres</button></div>
        </form>
    </section>`;
    node.querySelector("form").addEventListener("submit", async event => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const payload = {
            platformName: form.get("platformName"), apiUrl: form.get("apiUrl"), identifier: form.get("identifier"), apiKey: form.get("apiKey"), enabled: form.get("enabled") === "on",
            chartConfig: Object.fromEntries(["salesAccount", "customerAccount", "bankAccount", "vatCollectedAccount", "purchaseAccount", "supplierAccount"].map(key => [key, form.get(key)])),
            journalConfig: { sales: { code: form.get("salesJournalCode"), label: form.get("salesJournalLabel"), active: true }, bank: { code: form.get("bankJournalCode"), label: form.get("bankJournalLabel"), active: true }, general: { code: form.get("generalJournalCode"), label: form.get("generalJournalLabel"), active: true } },
            fecConfig: { fiscalYearStart: form.get("fiscalYearStart"), fiscalYearEnd: form.get("fiscalYearEnd") }, aidEngineConfig: settings.aidEngineConfig || {}
        };
        const result = await api("/api/accounting/settings", { method: "PUT", body: JSON.stringify(payload) });
        if (!result.ok) return alert(result.message || "Enregistrement impossible.");
        renderAccounting("settings");
    });
}

function renderPaymentRows(documents) { return documents.length ? `<div class="accounting-document-list">${documents.map(item => `<article class="accounting-document"><div><strong>${escapeHtml(item.documentNumber)}</strong><p>${escapeHtml(item.customerName)}</p></div><div class="accounting-document-totals"><strong>${money(item.remainingAmount)}</strong><small>${escapeHtml(paymentLabel(item))}</small></div></article>`).join("")}</div>` : '<p class="muted">Aucun impayé ni règlement en attente.</p>'; }
function paymentLabel(item) { return ({ paid: "Réglée", partial: "Partiellement réglée", overdue: "Impayée / échue", unpaid: "À encaisser" })[item.paymentStatus] || "Non concerné"; }
function documentStatusLabel(value) { return ({ draft: "Brouillon", sent: "Envoyé", validated: "Validé", paid: "Réglé", issued: "Émis", cancelled: "Annulé", accepted: "Accepté", rejected: "Refusé", pending: "En attente" })[String(value || "").toLowerCase()] || "Non renseigné"; }
function transmissionStatusLabel(value) { return ({ configured: "Configurée", draft: "Brouillon", queued: "En attente d’envoi", sent: "Envoyée", accepted: "Acceptée", rejected: "Refusée", failed: "Échec d’envoi" })[String(value || "").toLowerCase()] || "Non renseigné"; }
function money(value) { return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(Number(value) || 0); }
function date(value) { return value ? new Intl.DateTimeFormat("fr-FR").format(new Date(`${value}T12:00:00`)) : "Non renseignée"; }
function today() { return new Date().toISOString().slice(0, 10); }
async function api(url, options = {}) { try { const response = await fetch(url, { credentials: "same-origin", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options }); const data = response.status === 204 ? null : await response.json().catch(() => null); return { ok: response.ok, data, message: data?.message }; } catch { return { ok: false, message: "Serveur indisponible." }; } }
async function downloadAccountingFile(url, options = {}) { try { const response = await fetch(url, { credentials: "same-origin", headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) }, ...options }); if (!response.ok) { const data = await response.json().catch(() => null); return { ok: false, message: data?.message || "Téléchargement impossible." }; } const blob = await response.blob(); const disposition = response.headers.get("Content-Disposition") || ""; const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] || "export-comptable"; const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = filename; document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(link.href); return { ok: true }; } catch { return { ok: false, message: "Serveur indisponible." }; } }
