import { clearSearch, getContainer, setPage } from "./ui.js?v=44";
import { ROUTES } from "./config.js?v=128";
import { escapeHtml, normalizeText } from "./utils.js?v=44";
import { renderPurchases } from "./purchases.js?v=116";

const SECTIONS = [
    ["dashboard", "Tableau de bord"], ["salesJournal", "Journal des ventes"], ["settlements", "Règlements"], ["credits", "Avoirs"], ["vat", "TVA"], ["purchases", "Achats"], ["export", "Export comptable"], ["fec", "Export FEC"], ["control", "Contrôle comptable"], ["electronic", "Facturation électronique & PDP"], ["settings", "Paramètres"]
];
let accounting = null;
let activeSection = "dashboard";
let electronicOAuthMessageHandler = null;

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

export async function renderElectronicInvoicingConfiguration(node) {
    const panel = document.createElement("section");
    panel.className = "accounting-panel";
    panel.innerHTML = '<p class="muted">Chargement de la configuration…</p>';
    node.appendChild(panel);
    const result = await api("/api/accounting/e-invoicing");
    if (!result.ok) { panel.innerHTML = `<p class="auth-message error">${escapeHtml(result.message || "Configuration indisponible.")}</p>`; return; }
    const connection = result.data?.activeConnection;
    const configured = connection?.active && connection?.platformCode === "manual_configuration";
    const authLabels = { api_key: "Clé API", oauth_client: "OAuth — Client ID et Client Secret", access_token: "Token d’accès", identifier_secret: "Identifiant et secret", custom_secret: "Informations prévues par la plateforme" };
    const renderForm = () => {
        panel.innerHTML = `<div class="form-heading"><div><p class="eyebrow">Facturation électronique</p><h2>Plateforme de l’entreprise</h2><p class="muted">Enregistrez uniquement les informations fournies par la plateforme choisie par votre entreprise. Aucun test ni appel externe n’est effectué.</p></div></div>
            <aside class="accounting-pdp-notice">Cette configuration est indépendante de la codification et de la numérotation des documents Depann’Home Pro.</aside>
            <form id="electronicInvoicingConfigurationForm" class="form-grid">
                <label class="form-wide">Plateforme de facturation électronique<select name="platformChoice" required><option value="">Choisir une plateforme</option><option value="company_platform" selected>Plateforme choisie par mon entreprise</option></select></label>
                <label class="form-wide">Nom de la plateforme<input name="platformName" maxlength="160" required value="${escapeHtml(configured ? connection.platformLabel : "")}" placeholder="Nom contractuel de la plateforme"></label>
                <label>Compte / identifiant non sensible<input name="accountIdentifier" maxlength="200" required value="${escapeHtml(configured ? connection.externalAccountId : "")}"></label>
                <label>Mode d’authentification<select name="authenticationType" required><option value="">Choisir selon la documentation de la plateforme</option>${Object.entries(authLabels).map(([value, label]) => `<option value="${value}" ${configured && connection.authenticationType === value ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select></label>
                <div class="form-wide form-grid" data-authentication-fields></div>
                <p class="muted form-wide">Les champs sensibles sont chiffrés côté serveur et ne sont jamais réaffichés. En modification, laissez-les vides pour conserver les secrets existants si le mode d’authentification ne change pas.</p>
                <p class="auth-message form-wide" data-configuration-message></p>
                <div class="form-actions"><button type="submit" class="secondary-button">Enregistrer les identifiants</button>${configured ? '<button type="button" class="secondary-button" data-cancel-configuration>Annuler</button>' : ""}</div>
            </form>`;
        const form = panel.querySelector("form");
        const authentication = form.elements.authenticationType;
        const fields = form.querySelector("[data-authentication-fields]");
        const updateFields = () => {
            const optional = configured && connection.authenticationType === authentication.value ? "" : "required";
            fields.innerHTML = authentication.value === "api_key" ? `<label class="form-wide">Clé API<input name="apiKey" type="password" autocomplete="new-password" ${optional}></label>`
                : authentication.value === "oauth_client" ? `<label>Client ID<input name="clientId" autocomplete="off" ${optional}></label><label>Client Secret<input name="clientSecret" type="password" autocomplete="new-password" ${optional}></label>`
                    : authentication.value === "access_token" ? `<label class="form-wide">Token d’accès<input name="accessToken" type="password" autocomplete="new-password" ${optional}></label>`
                        : authentication.value === "identifier_secret" ? `<label>Identifiant d’authentification<input name="identifier" autocomplete="off" ${optional}></label><label>Secret<input name="secret" type="password" autocomplete="new-password" ${optional}></label>`
                            : authentication.value === "custom_secret" ? `<label>Nom de l’information fourni par la plateforme<input name="credentialName" maxlength="160" ${optional}></label><label>Valeur sensible<input name="credentialValue" type="password" autocomplete="new-password" ${optional}></label>` : "";
        };
        authentication.addEventListener("change", updateFields); updateFields();
        form.querySelector("[data-cancel-configuration]")?.addEventListener("click", () => renderSummary());
        form.addEventListener("submit", async event => {
            event.preventDefault();
            const submit = form.querySelector('button[type="submit"]'); const message = form.querySelector("[data-configuration-message]");
            if (submit) submit.disabled = true;
            const payload = Object.fromEntries(new FormData(form)); delete payload.platformChoice;
            const answer = await api("/api/accounting/e-invoicing/configuration", { method: "PUT", body: JSON.stringify(payload) });
            if (!answer.ok) { message.textContent = answer.message || "Enregistrement impossible."; message.classList.add("error"); if (submit) submit.disabled = false; return; }
            panel.remove();
            renderElectronicInvoicingConfiguration(node);
        });
    };
    const renderSummary = () => {
        panel.innerHTML = `<div class="form-heading"><div><p class="eyebrow">Facturation électronique</p><h2>Identifiants de plateforme enregistrés</h2></div><span class="auth-message">● Plateforme non intégrée</span></div><aside class="accounting-pdp-notice">Les identifiants sont conservés de manière chiffrée, mais aucun échange automatique n’est possible tant qu’un adaptateur fondé sur l’API officielle de cette plateforme n’est pas intégré.</aside><div class="accounting-transmission-list"><article><div><strong>${escapeHtml(connection.platformLabel)}</strong><p>Compte / identifiant : ${escapeHtml(connection.externalAccountId || "Non renseigné")}</p><small>Authentification : ${escapeHtml(authLabels[connection.authenticationType] || "Configuration propre à la plateforme")}</small></div></article></div><div class="form-actions"><button type="button" class="secondary-button" data-edit-configuration>Modifier</button><button type="button" class="danger-button" data-disconnect-configuration>Supprimer la configuration</button></div>`;
        panel.querySelector("[data-edit-configuration]").addEventListener("click", renderForm);
        panel.querySelector("[data-disconnect-configuration]").addEventListener("click", async () => { if (!window.confirm("Supprimer cette configuration et ses identifiants enregistrés ?")) return; const answer = await api(`/api/accounting/e-invoicing/connections/${connection.id}`, { method: "DELETE" }); if (!answer.ok) return alert(answer.message || "Suppression impossible."); panel.remove(); renderElectronicInvoicingConfiguration(node); });
    };
    if (configured) renderSummary(); else renderForm();
}

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

async function renderElectronic(node) {
    node.innerHTML = '<section class="accounting-panel"><p class="muted">Chargement des connexions de facturation électronique…</p></section>';
    const result = await api("/api/accounting/e-invoicing");
    if (!result.ok) { node.innerHTML = `<section class="accounting-panel"><p class="auth-message error">${escapeHtml(result.message || "Connexions indisponibles.")}</p></section>`; return; }
    const electronic = result.data || { providers: [], connections: [], activeConnection: null };
    const active = electronic.activeConnection;
    const ready = active?.status === "connected" && active?.integrated;
    const transmissions = electronic.transmissions || [];
    const inboundInvoices = electronic.inboundInvoices || [];
    const connectionRows = electronic.connections.map(connection => `<article><div><strong>${escapeHtml(connection.platformLabel)}</strong><p>${escapeHtml(connectionStatusLabel(connection.status))} · ${connection.environment === "production" ? "Production" : "Bac à sable fournisseur"}</p><small>${connection.externalAccountLabel ? `Compte ${escapeHtml(connection.externalAccountLabel)} · ` : ""}${connection.lastCheckedAt ? `Vérifiée le ${escapeHtml(dateTime(connection.lastCheckedAt))}` : "Aucun test effectué"}${connection.integrated ? "" : connection.platformCode === "manual_configuration" ? " · Plateforme non intégrée : aucun échange automatique" : " · Reconnexion requise"}</small></div>${connection.active ? `<div class="form-actions">${connection.integrated ? `<button type="button" class="secondary-button" data-test-connection="${connection.id}">Vérifier</button>` : ""}<button type="button" class="secondary-button" data-disconnect="${connection.id}">${connection.platformCode === "manual_configuration" ? "Supprimer la configuration" : "Déconnecter"}</button></div>` : ""}</article>`).join("");
    node.innerHTML = `<section class="accounting-panel">
        <div class="form-heading"><div><p class="eyebrow">Plateforme de facturation électronique</p><h3>Choisissez la plateforme utilisée par votre entreprise.</h3></div></div>
        <aside class="accounting-pdp-notice">Depann’Home Pro n'est pas une plateforme agréée de facturation électronique. Vous choisissez et connectez la plateforme utilisée par votre entreprise.</aside>
        <h4>Configuration de l’entreprise</h4><div class="accounting-transmission-list">${connectionRows || '<p class="muted">Aucune plateforme configurée.</p>'}</div>
        <h4>Plateformes intégrées</h4><div class="accounting-transmission-list">${electronic.providers.map(provider => `<article><div><strong>${escapeHtml(provider.label)}</strong><p>${provider.authorizationRequired ? "Autorisation OAuth sécurisée" : "Adaptateur dédié disponible"}</p>${provider.code === "super_pdp" ? "<p>Vous serez redirigé vers SUPER PDP pour vous connecter et autoriser Depann’Home Pro. Aucun identifiant technique n’est à saisir ici.</p>" : ""}<small>${provider.supports.webhooks ? "Notifications fournisseur" : "Suivi asynchrone par interrogation sécurisée"}</small></div><button type="button" class="secondary-button" data-connect="${escapeHtml(provider.code)}">${active?.platformCode === provider.code ? "Reconnecter" : "Connecter"}</button></article>`).join("") || '<p class="auth-message">Cette plateforme n\'est pas encore intégrée à Depan’Home Pro. Aucun connecteur ne sera présenté comme opérationnel sans API fournisseur documentée.</p>'}</div>
        <h4>Parcours des factures et avoirs transmis</h4><div class="accounting-transmission-list">${transmissions.length ? transmissions.map(item => `<article><div><strong>${escapeHtml(item.documentNumber)}</strong><p>${escapeHtml(item.provider)} · ${escapeHtml(lifecycleStatusLabel(item.lifecycleStatus))} · ${escapeHtml(paymentStatusLabel(item.paymentStatus))}</p><small>${escapeHtml(item.remoteId || "Sans référence externe")} · ${escapeHtml(item.message || "Aucun message")}</small>${renderTransmissionTimeline(item.events)}</div>${item.remoteId ? `<button type="button" class="secondary-button" data-refresh-transmission="${item.id}">Actualiser le statut</button>` : ""}</article>`).join("") : '<p class="muted">Aucune transmission enregistrée.</p>'}</div>
        <h4>Factures et avoirs émis</h4><div class="accounting-transmission-list">${accounting.documents.filter(item => ["invoice", "credit"].includes(item.documentType)).map(item => `<article><div><strong>${escapeHtml(item.documentNumber)}</strong><p>${item.documentType === "credit" ? "Avoir" : "Facture"} · ${escapeHtml(item.customerName)} · ${money(Math.abs(item.totals.netPayable))}</p></div><button type="button" class="secondary-button" data-transmit="${item.id}" ${ready ? "" : "disabled"}>Transmettre</button></article>`).join("") || '<p class="muted">Aucun document disponible.</p>'}</div>
        <hr><div class="form-heading"><div><p class="eyebrow">Réception fournisseur</p><h3>Factures électroniques reçues</h3><p class="muted">SUPER PDP ne fournit pas encore de récupération entrante documentée dans cet adaptateur. Importez les références reçues pour les contrôler, décider et les rapprocher d’un achat.</p></div></div>
        <form id="inboundInvoiceForm" class="form-grid"><label>Numéro *<input name="invoiceNumber" required maxlength="160"></label><label>Fournisseur *<input name="supplierName" required maxlength="160"></label><label>Identifiant fournisseur<input name="supplierIdentifier" maxlength="80"></label><label>Plateforme<input name="provider" maxlength="160" value="${escapeHtml(active?.platformLabel || "Import manuel")}"></label><label>Référence plateforme<input name="externalId" maxlength="160"></label><label>Date d’émission *<input name="issueDate" type="date" required value="${today()}"></label><label>Échéance<input name="dueDate" type="date"></label><label>Montant HT *<input name="amountHt" type="number" min="0" step="0.01" required></label><label>TVA *<input name="vatAmount" type="number" min="0" step="0.01" required></label><label>Montant TTC *<input name="amountTtc" type="number" min="0" step="0.01" required></label><label>Devise<input name="currencyCode" maxlength="3" value="EUR"></label><label class="form-wide">Note d’import<textarea name="importNote" rows="2" maxlength="1000"></textarea></label><p class="auth-message form-wide" data-inbound-message></p><div class="form-actions"><button class="secondary-button">Importer la facture reçue</button></div></form>
        <div class="accounting-transmission-list">${inboundInvoices.length ? inboundInvoices.map(renderInboundInvoice).join("") : '<p class="muted">Aucune facture fournisseur reçue.</p>'}</div>
    </section>`;
    node.querySelectorAll("[data-connect]").forEach(button => button.addEventListener("click", async () => {
        const popup = window.open("", "depannhome-einvoice-oauth", "width=760,height=820");
        if (!popup) return alert("Autorisez l’ouverture de la fenêtre SUPER PDP dans votre navigateur.");
        popup.document.write("<p>Préparation de l’autorisation sécurisée…</p>");
        const answer = await api(`/api/accounting/e-invoicing/connections/${encodeURIComponent(button.dataset.connect)}/authorize`, { method: "POST", body: "{}" });
        if (!answer.ok || !answer.data?.authorizationUrl) { popup.close(); return alert(answer.message || "Autorisation impossible."); }
        popup.location.replace(answer.data.authorizationUrl);
    }));
    if (electronicOAuthMessageHandler) window.removeEventListener("message", electronicOAuthMessageHandler);
    electronicOAuthMessageHandler = event => {
        if (event.origin !== window.location.origin || event.data?.type !== "depannhome:einvoice-oauth") return;
        window.removeEventListener("message", electronicOAuthMessageHandler);
        electronicOAuthMessageHandler = null;
        if (!event.data.success) alert(event.data.message || "Connexion SUPER PDP impossible.");
        renderAccounting("electronic");
    };
    window.addEventListener("message", electronicOAuthMessageHandler);
    node.querySelectorAll("[data-test-connection]").forEach(button => button.addEventListener("click", async () => { button.disabled = true; const answer = await api(`/api/accounting/e-invoicing/connections/${button.dataset.testConnection}/test`, { method: "POST", body: "{}" }); if (!answer.ok) alert(answer.message || "Vérification impossible."); renderAccounting("electronic"); }));
    node.querySelectorAll("[data-disconnect]").forEach(button => button.addEventListener("click", async () => { if (!window.confirm("Supprimer cette configuration ? L’historique des transmissions sera conservé.")) return; const answer = await api(`/api/accounting/e-invoicing/connections/${button.dataset.disconnect}`, { method: "DELETE" }); if (!answer.ok) alert(answer.message || "Suppression impossible."); renderAccounting("electronic"); }));
    node.querySelectorAll("[data-refresh-transmission]").forEach(button => button.addEventListener("click", async () => { button.disabled = true; const answer = await api(`/api/accounting/e-invoicing/transmissions/${button.dataset.refreshTransmission}/status`, { method: "POST", body: "{}" }); if (!answer.ok) alert(answer.message || "Actualisation impossible."); renderAccounting("electronic"); }));
    node.querySelectorAll("[data-transmit]:not([disabled])").forEach(button => button.addEventListener("click", async () => { if (!window.confirm(`Transmettre ce document à ${active.platformLabel} ?`)) return; button.disabled = true; const answer = await api(`/api/accounting/e-invoicing/documents/${button.dataset.transmit}/transmit`, { method: "POST" }); if (!answer.ok) alert(answer.message || "Transmission impossible."); renderAccounting("electronic"); }));
    node.querySelector("#inboundInvoiceForm").addEventListener("submit", async event => { event.preventDefault(); const form = event.currentTarget; const answer = await api("/api/accounting/e-invoicing/inbound", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) }); if (!answer.ok) { const message = form.querySelector("[data-inbound-message]"); message.textContent = answer.message || "Import impossible."; message.classList.add("error"); return; } renderAccounting("electronic"); });
    node.querySelectorAll("[data-inbound-validate]").forEach(button => button.addEventListener("click", () => inboundAction(button, "validate")));
    node.querySelectorAll("[data-inbound-accept]").forEach(button => button.addEventListener("click", () => inboundDecision(button, "accepted")));
    node.querySelectorAll("[data-inbound-reject]").forEach(button => button.addEventListener("click", () => inboundDecision(button, "rejected")));
    node.querySelectorAll("[data-inbound-purchase]").forEach(button => button.addEventListener("click", () => inboundAction(button, "purchase")));
    node.querySelectorAll("[data-inbound-payment]").forEach(button => button.addEventListener("click", async () => { const invoice = inboundInvoices.find(item => String(item.id) === button.dataset.inboundPayment); const paidAmount = window.prompt("Montant réglé :", String(invoice.amountTtc)); if (paidAmount === null) return; const reference = window.prompt("Référence du règlement :", invoice.paymentReference || "") ?? ""; const answer = await api(`/api/accounting/e-invoicing/inbound/${invoice.id}/payment`, { method: "POST", body: JSON.stringify({ paidAmount, paidAt: today(), reference }) }); if (!answer.ok) alert(answer.message || "Rapprochement impossible."); renderAccounting("electronic"); }));
}

function renderTransmissionTimeline(events = []) { return events.length ? `<details><summary>Voir la chronologie (${events.length})</summary><ol>${events.map(event => `<li><strong>${escapeHtml(transmissionEventLabel(event.eventType))}</strong> · ${escapeHtml(dateTime(event.createdAt))}<br><small>${escapeHtml(event.message || event.status || "Étape enregistrée")}</small></li>`).join("")}</ol></details>` : ""; }
function renderInboundInvoice(item) { const actions = item.status === "received" ? `<button class="secondary-button" data-inbound-validate="${item.id}">Contrôler</button><button class="danger-button" data-inbound-reject="${item.id}">Refuser</button>` : item.status === "validated" ? `<button class="secondary-button" data-inbound-accept="${item.id}">Accepter</button><button class="danger-button" data-inbound-reject="${item.id}">Refuser</button>` : item.status === "accepted" ? `${item.purchaseId ? `<span class="auth-message success">Achat #${item.purchaseId}</span>` : `<button class="secondary-button" data-inbound-purchase="${item.id}">Créer l’achat</button>`}<button class="secondary-button" data-inbound-payment="${item.id}">Rapprocher le règlement</button>` : ""; return `<article><div><strong>${escapeHtml(item.invoiceNumber)} · ${escapeHtml(item.supplierName)}</strong><p>${escapeHtml(inboundStatusLabel(item.status))} · ${escapeHtml(validationStatusLabel(item.validationStatus))} · ${escapeHtml(paymentStatusLabel(item.paymentStatus))}</p><small>${escapeHtml(date(item.issueDate))} · ${money(item.amountTtc)} · ${escapeHtml(item.provider)}${item.rejectionReason ? ` · ${escapeHtml(item.rejectionReason)}` : ""}</small>${(item.validationMessages || []).length ? `<ul class="auth-message error">${item.validationMessages.map(message => `<li>${escapeHtml(message)}</li>`).join("")}</ul>` : ""}${renderTransmissionTimeline(item.events)}</div><div class="form-actions">${actions}</div></article>`; }
async function inboundAction(button, action) { button.disabled = true; const id = button.dataset.inboundValidate || button.dataset.inboundPurchase; const answer = await api(`/api/accounting/e-invoicing/inbound/${id}/${action}`, { method: "POST", body: "{}" }); if (!answer.ok && answer.data?.messages?.length) alert(answer.data.messages.join("\n")); else if (!answer.ok) alert(answer.message || "Action impossible."); renderAccounting("electronic"); }
async function inboundDecision(button, decision) { const id = button.dataset.inboundAccept || button.dataset.inboundReject; const reason = decision === "rejected" ? window.prompt("Motif du refus :", "") : ""; if (decision === "rejected" && !reason) return; const answer = await api(`/api/accounting/e-invoicing/inbound/${id}/decision`, { method: "POST", body: JSON.stringify({ decision, reason }) }); if (!answer.ok) alert(answer.message || "Décision impossible."); renderAccounting("electronic"); }

function renderSettings(node) {
    const settings = accounting.settings;
    const accounts = settings.chartConfig || {};
    const journals = settings.journalConfig || {};
    node.innerHTML = `<section class="accounting-panel">
        <div class="form-heading"><div><p class="eyebrow">Configuration propre à l’entreprise</p><h3>Paramètres comptables</h3><p class="muted">La connexion à une plateforme est gérée séparément dans « Facturation électronique ».</p></div></div>
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
            <p class="auth-message" id="accountingSettingsMessage"></p>
            <div class="form-actions"><button class="secondary-button">Enregistrer les paramètres</button></div>
        </form>
    </section>`;
    node.querySelector("form").addEventListener("submit", async event => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const payload = {
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
function lifecycleStatusLabel(value) { return ({ prepared: "Préparée", deposited: "Déposée sur la plateforme", delivered: "Mise à disposition", accepted: "Acceptée", rejected: "Refusée", paid: "Paiement signalé par la plateforme" })[String(value || "").toLowerCase()] || "Étape inconnue"; }
function paymentStatusLabel(value) { return ({ unpaid: "Non réglée", partial: "Partiellement réglée", paid: "Réglée" })[String(value || "").toLowerCase()] || "Règlement inconnu"; }
function inboundStatusLabel(value) { return ({ received: "Reçue", validated: "Contrôlée", accepted: "Acceptée", rejected: "Refusée", archived: "Archivée" })[String(value || "").toLowerCase()] || "État inconnu"; }
function validationStatusLabel(value) { return ({ pending: "À contrôler", valid: "Contrôles réussis", invalid: "Anomalies détectées" })[String(value || "").toLowerCase()] || "Contrôle inconnu"; }
function transmissionEventLabel(value) { return ({ transmission_queued: "Préparation", document_transmitted: "Dépôt", status_checked: "Actualisation plateforme", status_received: "Notification plateforme", transmission_failed: "Échec", received: "Réception", validated: "Contrôle", accepted: "Acceptation", rejected: "Refus", purchase_linked: "Rapprochement avec un achat", payment_reconciled: "Rapprochement du règlement" })[String(value || "")] || "Événement"; }
function connectionStatusLabel(value) { return ({ pending: "Configuration enregistrée", connected: "Connectée", invalid: "Connexion invalide", expired: "Authentification expirée", disconnected: "Déconnectée", action_required: "Reconnexion requise" })[String(value || "").toLowerCase()] || "État inconnu"; }
function money(value) { return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(Number(value) || 0); }
function date(value) { return value ? new Intl.DateTimeFormat("fr-FR").format(new Date(`${value}T12:00:00`)) : "Non renseignée"; }
function dateTime(value) { return value ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "Non renseignée"; }
function today() { return new Date().toISOString().slice(0, 10); }
async function api(url, options = {}) { try { const response = await fetch(url, { credentials: "same-origin", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options }); const data = response.status === 204 ? null : await response.json().catch(() => null); return { ok: response.ok, data, message: data?.message }; } catch { return { ok: false, message: "Serveur indisponible." }; } }
async function downloadAccountingFile(url, options = {}) { try { const response = await fetch(url, { credentials: "same-origin", headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) }, ...options }); if (!response.ok) { const data = await response.json().catch(() => null); return { ok: false, message: data?.message || "Téléchargement impossible." }; } const blob = await response.blob(); const disposition = response.headers.get("Content-Disposition") || ""; const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] || "export-comptable"; const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = filename; document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(link.href); return { ok: true }; } catch { return { ok: false, message: "Serveur indisponible." }; } }
