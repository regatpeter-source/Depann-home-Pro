import { ROUTES } from "./config.js?v=82";
import { getSearchableClients } from "./clients.js?v=82";
import { addClientActivityByName } from "./client-sync.js?v=82";
import { resetSelection } from "./state.js?v=44";
import { escapeHtml, normalizeText } from "./utils.js?v=44";
import { clearSearch, createInfo, getContainer, setPage } from "./ui.js?v=44";

const CUSTOMER_TYPES = ["Particulier", "Professionnel", "Magasin", "Autre"];
const DOCUMENT_TYPES = { quote: "Devis", invoice: "Facture" };
let activeDocument = null;
let billingData = null;

export async function renderBilling(options = {}) {
    if (options.document) activeDocument = options.document;
    clearSearch();
    resetSelection("all");
    setPage("Devis & factures", ROUTES.billing, "detail");

    const container = getContainer();
    const overviewPanel = createPanel("billing-overview-panel");
    const profilePanel = createPanel("billing-profile-panel");
    const templatePanel = createPanel("billing-template-panel");
    const editorPanel = createPanel("billing-editor-panel");
    const listPanel = createPanel("billing-list-panel");
    container.append(overviewPanel, profilePanel, templatePanel, editorPanel, listPanel);
    overviewPanel.innerHTML = "<p class=\"muted\">Chargement de l’espace de facturation…</p>";
    [profilePanel, templatePanel, editorPanel, listPanel].forEach(panel => panel.hidden = true);

    const result = await apiRequest("/api/billing");
    if (!result.ok) {
        overviewPanel.innerHTML = `<p class="auth-message error">${escapeHtml(result.message || "Impossible de charger les devis et factures.")}</p>`;
        return;
    }

    billingData = result.data;
    if (options.newDocument) activeDocument = createNewDocument(options.newDocument.type, options.newDocument.client);
    renderOverview(overviewPanel);
    if (!isTechnician()) {
        renderProfile(profilePanel);
        renderTemplates(templatePanel);
    }
    renderDocumentEditor(editorPanel);
    renderDocumentList(listPanel);
}

export function createBillingDocumentForClient(type, client) {
    if (!DOCUMENT_TYPES[type] || !client) return;
    renderBilling({ newDocument: { type, client } });
}

function createPanel(className) {
    const panel = document.createElement("section");
    panel.className = `client-panel ${className}`;
    return panel;
}

function renderOverview(panel) {
    const { profile, documents = [] } = billingData;
    const quotes = documents.filter(document => document.documentType === "quote").length;
    const invoices = documents.filter(document => document.documentType === "invoice").length;
    panel.innerHTML = `
        <div class="billing-overview">
            <div class="billing-branding">
                ${profile.hasLogo ? '<img class="billing-logo-preview" src="/api/billing/logo" alt="Logo de votre structure">' : '<div class="billing-logo-placeholder">Votre logo</div>'}
                <div><p class="eyebrow">Espace privé de facturation</p><h2>${escapeHtml(profile.companyName || "Votre structure")}</h2><p class="muted">Vos paramètres, lignes et documents sont visibles uniquement depuis ce compte.</p></div>
            </div>
            <div class="billing-overview-actions">
                <button type="button" class="secondary-button" data-billing-action="new-quote">+ Nouveau devis</button>
                <button type="button" class="secondary-button" data-billing-action="new-invoice">+ Nouvelle facture</button>
            </div>
        </div>
        <div class="billing-metrics"><span><strong>${quotes}</strong> devis</span><span><strong>${invoices}</strong> factures</span><span><strong>${billingData.templates.length}</strong> ligne(s) modèle</span>${profile.defaultQuote ? `<span class="billing-base-template"><strong>✓</strong> modèle de devis actif ${isTechnician() ? "" : '<button type="button" data-billing-action="clear-default">Retirer</button>'}</span>` : ""}</div>
    `;
    panel.querySelector("[data-billing-action=new-quote]").addEventListener("click", () => openNewDocument("quote"));
    panel.querySelector("[data-billing-action=new-invoice]").addEventListener("click", () => openNewDocument("invoice"));
    panel.querySelector("[data-billing-action=clear-default]")?.addEventListener("click", async () => {
        if (!confirm("Retirer le modèle de devis de base ?")) return;
        const result = await apiRequest("/api/billing/default-quote", { method: "PUT", body: JSON.stringify(null) });
        if (!result.ok) { alert(result.message || "Impossible de retirer le modèle."); return; }
        renderBilling();
    });
}

function renderProfile(panel) {
    panel.hidden = false;
    const profile = billingData.profile;
    panel.innerHTML = `
        <form id="billingProfileForm" class="client-form" enctype="multipart/form-data">
            <div class="form-heading"><div><p class="eyebrow">Paramètres de votre structure</p><h2>Identité, coordonnées et logo</h2></div></div>
            <div class="form-grid">
                <label>Nom de la structure<input name="companyName" maxlength="160" placeholder="Ex. Dépann’Home Services" value="${escapeHtml(profile.companyName)}"></label>
                <label>Forme juridique / activité<input name="legalForm" maxlength="100" placeholder="Ex. SASU – dépannage à domicile" value="${escapeHtml(profile.legalForm)}"></label>
                <label class="form-wide">Adresse<input name="address" maxlength="255" value="${escapeHtml(profile.address)}"></label>
                <label>Code postal<input name="postalCode" maxlength="20" value="${escapeHtml(profile.postalCode)}"></label>
                <label>Ville<input name="city" maxlength="100" value="${escapeHtml(profile.city)}"></label>
                <label>Téléphone<input name="phone" maxlength="50" value="${escapeHtml(profile.phone)}"></label>
                <label>E-mail<input name="email" type="email" maxlength="160" value="${escapeHtml(profile.email)}"></label>
                <label>Immatriculation / SIRET<input name="registrationNumber" maxlength="100" value="${escapeHtml(profile.registrationNumber)}"></label>
                <label>N° TVA intracommunautaire<input name="taxNumber" maxlength="100" value="${escapeHtml(profile.taxNumber)}"></label>
                <label class="form-wide">Conditions de règlement<input name="paymentTerms" maxlength="500" placeholder="Ex. Paiement à réception par virement ou chèque" value="${escapeHtml(profile.paymentTerms)}"></label>
                <label class="form-wide">Mention de bas de page<textarea name="footerNote" rows="2" maxlength="1000" placeholder="Mentions légales, pénalités de retard, assurance…">${escapeHtml(profile.footerNote)}</textarea></label>
                <label>Logo (PNG, JPEG ou WebP, 2 Mo maximum)<input name="logo" type="file" accept="image/png,image/jpeg,image/webp"></label>
                ${profile.hasLogo ? '<label class="billing-remove-logo"><input name="removeLogo" type="checkbox" value="true"> Supprimer le logo actuel</label>' : ""}
            </div>
            <p id="billingProfileMessage" class="auth-message" aria-live="polite"></p>
            <div class="form-actions"><button type="submit" class="secondary-button">Enregistrer les paramètres</button></div>
        </form>
    `;
    panel.querySelector("form").addEventListener("submit", async event => {
        event.preventDefault();
        const form = event.currentTarget;
        const message = panel.querySelector("#billingProfileMessage");
        const submit = form.querySelector("button[type=submit]");
        submit.disabled = true;
        message.textContent = "Enregistrement…";
        message.classList.remove("error");
        const result = await apiRequest("/api/billing/profile", { method: "PUT", body: new FormData(form) });
        if (!result.ok) {
            message.textContent = result.message || "Impossible d’enregistrer la structure.";
            message.classList.add("error");
            submit.disabled = false;
            return;
        }
        renderBilling();
    });
}

function renderTemplates(panel) {
    panel.hidden = false;
    panel.innerHTML = `
        <div class="form-heading"><div><p class="eyebrow">Lignes préenregistrées</p><h2>Vos prestations et fournitures</h2><p class="muted">Enregistrez les lignes que vous utilisez souvent, puis ajoutez-les en un clic dans un devis ou une facture.</p></div></div>
        <form id="billingTemplateForm" class="form-grid billing-template-form">
            <label>Libellé *<input name="label" maxlength="160" required placeholder="Ex. Déplacement et diagnostic"></label>
            <label>Prix unitaire HT *<input name="unitPrice" type="number" min="0" step="0.01" required placeholder="0,00"></label>
            <label>Description<textarea name="description" rows="2" maxlength="500" placeholder="Détail de la prestation"></textarea></label>
            <label>Unité<input name="unit" maxlength="40" value="unité" placeholder="heure, forfait, pièce…"></label>
            <label>TVA %<input name="vatRate" type="number" min="0" max="100" step="0.01" value="20"></label>
            <div class="form-actions"><button type="submit" class="secondary-button">Ajouter la ligne</button></div>
        </form>
        <p id="billingTemplateMessage" class="auth-message" aria-live="polite"></p>
        <div class="billing-template-list" id="billingTemplateList"></div>
    `;
    const list = panel.querySelector("#billingTemplateList");
    if (!billingData.templates.length) list.innerHTML = "<p class=\"muted\">Aucune ligne préenregistrée pour le moment.</p>";
    billingData.templates.forEach(template => {
        const item = document.createElement("article");
        item.className = "billing-template-item";
        item.innerHTML = `<div><strong>${escapeHtml(template.label)}</strong><p>${escapeHtml(template.description || template.unit)}</p><small>${formatMoney(template.unitPrice)} HT · TVA ${formatNumber(template.vatRate)} %</small></div><button type="button" class="danger-button" aria-label="Supprimer ${escapeHtml(template.label)}">Supprimer</button>`;
        item.querySelector("button").addEventListener("click", async () => {
            if (!confirm(`Supprimer la ligne « ${template.label} » ?`)) return;
            const result = await apiRequest(`/api/billing/templates/${encodeURIComponent(template.id)}`, { method: "DELETE" });
            if (!result.ok) alert(result.message || "Suppression impossible.");
            else renderBilling();
        });
        list.appendChild(item);
    });
    panel.querySelector("#billingTemplateForm").addEventListener("submit", async event => {
        event.preventDefault();
        const form = event.currentTarget;
        const message = panel.querySelector("#billingTemplateMessage");
        const result = await apiRequest("/api/billing/templates", { method: "POST", body: JSON.stringify(formDataToObject(new FormData(form))) });
        if (!result.ok) { message.textContent = result.message || "Impossible d’ajouter la ligne."; message.classList.add("error"); return; }
        renderBilling();
    });
}

function renderDocumentEditor(panel) {
    if (!activeDocument) { panel.hidden = true; panel.innerHTML = ""; return; }
    panel.hidden = false;
    const document = activeDocument;
    const isEditing = Boolean(document.id);
    if (isEditing && isTechnician()) return renderReadOnlyDocument(panel, document);
    const clients = getSearchableClients().sort((a, b) => a.name.localeCompare(b.name, "fr"));
    panel.innerHTML = `
        <form id="billingDocumentForm" class="client-form">
            <div class="form-heading"><div><p class="eyebrow">${isEditing ? "Modification" : "Nouveau document"}</p><h2>${isEditing ? "Modifier le document" : `Créer un ${DOCUMENT_TYPES[document.documentType].toLowerCase()}`}</h2></div><button type="button" class="secondary-button" id="cancelBillingDocument">Annuler</button></div>
            <div class="form-grid">
                <label>Type *<select name="documentType">${Object.entries(DOCUMENT_TYPES).map(([id, label]) => `<option value="${id}" ${document.documentType === id ? "selected" : ""}>${label}</option>`).join("")}</select></label>
                <label>Numéro *<input name="documentNumber" maxlength="80" required placeholder="Ex. DEV-2026-001" value="${escapeHtml(document.documentNumber)}"></label>
                <label>Catégorie client<select name="customerType">${CUSTOMER_TYPES.map(type => `<option ${document.customerType === type ? "selected" : ""}>${type}</option>`).join("")}</select></label>
                <label>Client / destinataire *<input name="customerName" list="billingClients" maxlength="160" required value="${escapeHtml(document.customerName)}"><datalist id="billingClients">${clients.map(client => `<option value="${escapeHtml(client.name)}">${escapeHtml([client.address, client.city].filter(Boolean).join(", "))}</option>`).join("")}</datalist></label>
                <label class="form-wide">Adresse du destinataire<textarea name="customerAddress" rows="2" maxlength="500" placeholder="Adresse de facturation">${escapeHtml(document.customerAddress)}</textarea></label>
                <label>Date *<input name="issueDate" type="date" required value="${escapeHtml(document.issueDate)}"></label>
                <label>Échéance<input name="dueDate" type="date" value="${escapeHtml(document.dueDate || "")}"></label>
                <label>Statut<input name="status" maxlength="30" value="${escapeHtml(document.status || "draft")}" placeholder="Brouillon, envoyé, réglé…"></label>
            </div>
            <section class="billing-lines-section"><div class="form-heading"><div><p class="eyebrow">Prestations</p><h3>Lignes du document</h3></div><button type="button" class="secondary-button" id="addBillingLine">+ Ligne libre</button></div><div id="billingLines" class="billing-lines"></div><div class="billing-totals" id="billingTotals"></div></section>
            <label>Notes / conditions<textarea name="notes" rows="3" maxlength="2000" placeholder="Informations complémentaires, conditions, validité du devis…">${escapeHtml(document.notes)}</textarea></label>
            ${document.documentType === "quote" && !isTechnician() ? `<label class="billing-default-option"><input name="saveAsDefaultQuote" type="checkbox" ${!billingData.profile.defaultQuote ? "checked" : ""}> Utiliser les lignes, la TVA, les conditions et le statut de ce devis comme modèle de base pour mes futurs devis.</label>` : ""}
            <p id="billingDocumentMessage" class="auth-message" aria-live="polite"></p>
            <div class="calendar-form-actions"><button type="submit" class="secondary-button">${isEditing ? "Enregistrer les modifications" : "Enregistrer le document"}</button>${isEditing ? '<button type="button" class="danger-button" id="deleteBillingDocument">Supprimer</button>' : ""}</div>
        </form>
    `;
    const form = panel.querySelector("form");
    const linesNode = panel.querySelector("#billingLines");
    const renderLines = () => {
        linesNode.innerHTML = "";
        document.lines.forEach((line, index) => linesNode.appendChild(createLineEditor(line, index, document, renderLines)));
        renderTotals(panel.querySelector("#billingTotals"), document.lines);
    };
    renderLines();
    form.querySelector("#addBillingLine").addEventListener("click", () => { document.lines.push(emptyLine()); renderLines(); });
    form.querySelector("#cancelBillingDocument").addEventListener("click", () => { activeDocument = null; renderBilling(); });
    const customerInput = form.querySelector("[name=customerName]");
    customerInput.addEventListener("change", () => fillCustomerAddress(customerInput, form, clients));
    customerInput.addEventListener("input", () => fillCustomerAddress(customerInput, form, clients));
    form.addEventListener("submit", async event => {
        event.preventDefault();
        const payload = { ...formDataToObject(new FormData(form)), lines: document.lines };
        const shouldSaveAsDefault = payload.documentType === "quote" && payload.saveAsDefaultQuote === "on";
        delete payload.saveAsDefaultQuote;
        const message = panel.querySelector("#billingDocumentMessage");
        const result = await apiRequest(isEditing ? `/api/billing/documents/${encodeURIComponent(document.id)}` : "/api/billing/documents", { method: isEditing ? "PUT" : "POST", body: JSON.stringify(payload) });
        if (!result.ok) { message.textContent = result.message || "Impossible d’enregistrer le document."; message.classList.add("error"); return; }
        if (!isEditing) addClientActivityByName(payload.customerName, {
            type: payload.documentType,
            label: `${DOCUMENT_TYPES[payload.documentType]} créé`,
            detail: payload.documentNumber
        });
        if (shouldSaveAsDefault) {
            const templateResult = await apiRequest("/api/billing/default-quote", {
                method: "PUT",
                body: JSON.stringify({ customerType: payload.customerType, status: payload.status, notes: payload.notes, lines: payload.lines })
            });
            if (!templateResult.ok) {
                message.textContent = templateResult.message || "Document enregistré, mais le modèle de devis n’a pas pu être mis à jour.";
                message.classList.add("error");
                return;
            }
        }
        activeDocument = null;
        renderBilling();
    });
    form.querySelector("#deleteBillingDocument")?.addEventListener("click", async () => {
        if (!confirm("Supprimer ce document ?")) return;
        const result = await apiRequest(`/api/billing/documents/${encodeURIComponent(document.id)}`, { method: "DELETE" });
        if (!result.ok) { alert(result.message || "Suppression impossible."); return; }
        activeDocument = null;
        renderBilling();
    });
}

function renderReadOnlyDocument(panel, document) {
    panel.innerHTML = `
        <div class="billing-read-only-document">
            <div class="form-heading"><div><p class="eyebrow">Consultation uniquement</p><h2>${escapeHtml(DOCUMENT_TYPES[document.documentType])} ${escapeHtml(document.documentNumber)}</h2><p class="muted">Seul l’administrateur peut modifier ou supprimer un document existant.</p></div><button type="button" class="secondary-button" id="closeBillingDocument">Fermer</button></div>
            <div class="procedure-meta"><span>${escapeHtml(document.customerName)}</span><span>${escapeHtml(formatDate(document.issueDate))}</span><span>${escapeHtml(document.status || "brouillon")}</span></div>
            <div class="billing-read-only-lines">${document.lines.map(line => `<div><span>${escapeHtml(line.description)}</span><strong>${escapeHtml(String(line.quantity))} × ${escapeHtml(formatMoney(line.unitPrice))}</strong><b>${escapeHtml(formatMoney(lineTotal(line)))}</b></div>`).join("")}</div>
            <div class="billing-totals" id="billingReadOnlyTotals"></div>
            ${document.notes ? `<section class="procedure-section"><h3>Notes / conditions</h3><p>${escapeHtml(document.notes)}</p></section>` : ""}
        </div>`;
    renderTotals(panel.querySelector("#billingReadOnlyTotals"), document.lines);
    panel.querySelector("#closeBillingDocument").addEventListener("click", () => { activeDocument = null; renderBilling(); });
}

function createLineEditor(line, index, document, rerender) {
    const item = document.createElement("article");
    item.className = "billing-line";
    item.innerHTML = `
        <select aria-label="Ligne préenregistrée"><option value="">Ligne libre</option>${billingData.templates.map(template => `<option value="${template.id}">${escapeHtml(template.label)}</option>`).join("")}</select>
        <input data-field="description" aria-label="Description" maxlength="500" placeholder="Description" value="${escapeHtml(line.description)}">
        <input data-field="quantity" aria-label="Quantité" type="number" min="0.001" step="0.001" value="${escapeHtml(line.quantity)}">
        <input data-field="unit" aria-label="Unité" maxlength="40" value="${escapeHtml(line.unit)}">
        <input data-field="unitPrice" aria-label="Prix unitaire HT" type="number" min="0" step="0.01" value="${escapeHtml(line.unitPrice)}">
        <input data-field="vatRate" aria-label="TVA" type="number" min="0" max="100" step="0.01" value="${escapeHtml(line.vatRate)}">
        <strong class="billing-line-total">${formatMoney(lineTotal(line))}</strong>
        <button type="button" class="danger-button" aria-label="Supprimer la ligne">×</button>
    `;
    const inputs = item.querySelectorAll("[data-field]");
    inputs.forEach(input => input.addEventListener("input", () => {
        const field = input.dataset.field;
        line[field] = ["quantity", "unitPrice", "vatRate"].includes(field) ? Number(input.value) || 0 : input.value;
        item.querySelector(".billing-line-total").textContent = formatMoney(lineTotal(line));
        renderTotals(item.closest("form").querySelector("#billingTotals"), document.lines);
    }));
    item.querySelector("select").addEventListener("change", event => {
        const template = billingData.templates.find(value => String(value.id) === event.target.value);
        if (!template) return;
        Object.assign(line, { description: template.description ? `${template.label} — ${template.description}` : template.label, unit: template.unit, unitPrice: Number(template.unitPrice), vatRate: Number(template.vatRate) });
        rerender();
    });
    item.querySelector("button").addEventListener("click", () => { document.lines.splice(index, 1); if (!document.lines.length) document.lines.push(emptyLine()); rerender(); });
    return item;
}

function renderTotals(panel, lines) {
    const totalHt = lines.reduce((total, line) => total + lineTotal(line), 0);
    const totalVat = lines.reduce((total, line) => total + lineTotal(line) * (Number(line.vatRate) || 0) / 100, 0);
    panel.innerHTML = `<span>Total HT <strong>${formatMoney(totalHt)}</strong></span><span>TVA <strong>${formatMoney(totalVat)}</strong></span><span>Total TTC <strong>${formatMoney(totalHt + totalVat)}</strong></span>`;
}

function renderDocumentList(panel) {
    panel.hidden = false;
    const documents = billingData.documents || [];
    panel.innerHTML = `<div class="form-heading"><div><p class="eyebrow">Documents enregistrés</p><h2>${documents.length} document(s)</h2></div></div><div class="billing-document-list" id="billingDocumentList"></div>`;
    const list = panel.querySelector("#billingDocumentList");
    if (!documents.length) { list.innerHTML = "<p class=\"muted\">Créez votre premier devis ou votre première facture.</p>"; return; }
    documents.forEach(document => {
        const item = document.createElement("article");
        item.className = "billing-document-item";
        const totals = calculateTotals(document.lines || []);
        item.innerHTML = `<div><p class="eyebrow">${DOCUMENT_TYPES[document.documentType]} · ${escapeHtml(document.customerType)}</p><h3>${escapeHtml(document.documentNumber)}</h3><p>${escapeHtml(document.customerName)}</p><small>${escapeHtml(formatDate(document.issueDate))} · ${escapeHtml(document.status || "brouillon")}</small></div><div class="billing-document-amount"><strong>${formatMoney(totals.ttc)}</strong><small>TTC</small></div><button type="button" class="secondary-button">${isTechnician() ? "Consulter" : "Ouvrir"}</button>`;
        item.querySelector("button").addEventListener("click", () => { activeDocument = normalizeDocument(document); renderBilling(); });
        list.appendChild(item);
    });
}

function openNewDocument(type) {
    activeDocument = createNewDocument(type);
    renderBilling();
}

function createNewDocument(type, client = null) {
    const baseQuote = type === "quote" ? normalizeQuoteTemplate(billingData.profile.defaultQuote) : null;
    return {
        id: null,
        documentType: type,
        documentNumber: suggestNumber(type),
        customerType: client ? getBillingCustomerType(client.type) : baseQuote?.customerType || "Particulier",
        customerName: client?.name || "",
        customerAddress: client ? [client.address, client.city].filter(Boolean).join(", ") : "",
        issueDate: today(),
        dueDate: "",
        status: baseQuote?.status || "draft",
        lines: baseQuote?.lines || [emptyLine()],
        notes: baseQuote?.notes || billingData.profile.paymentTerms || ""
    };
}

function getBillingCustomerType(type) { return CUSTOMER_TYPES.includes(type) ? type : "Autre"; }
function fillCustomerAddress(input, form, clients) {
    const client = clients.find(item => normalizeText(item.name) === normalizeText(input.value));
    if (client) form.querySelector("[name=customerAddress]").value = [client.address, client.city].filter(Boolean).join(", ");
}

function emptyLine() { return { description: "", quantity: 1, unit: "unité", unitPrice: 0, vatRate: 20 }; }
function normalizeDocument(document) { return { ...document, lines: Array.isArray(document.lines) && document.lines.length ? document.lines.map(line => ({ ...emptyLine(), ...line })) : [emptyLine()] }; }
function normalizeQuoteTemplate(template) {
    if (!template || !Array.isArray(template.lines) || !template.lines.length) return null;
    return { ...template, lines: template.lines.map(line => ({ ...emptyLine(), ...line })) };
}
function suggestNumber(type) { return `${type === "quote" ? "DEV" : "FAC"}-${new Date().getFullYear()}-${String((billingData.documents || []).filter(document => document.documentType === type).length + 1).padStart(3, "0")}`; }
function lineTotal(line) { return (Number(line.quantity) || 0) * (Number(line.unitPrice) || 0); }
function calculateTotals(lines) { const ht = lines.reduce((sum, line) => sum + lineTotal(line), 0); const vat = lines.reduce((sum, line) => sum + lineTotal(line) * (Number(line.vatRate) || 0) / 100, 0); return { ht, vat, ttc: ht + vat }; }
function formatMoney(value) { return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(Number(value) || 0); }
function formatNumber(value) { return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(Number(value) || 0); }
function formatDate(value) { return value ? new Intl.DateTimeFormat("fr-FR").format(new Date(`${value}T12:00:00`)) : "Date non renseignée"; }
function today() { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function formDataToObject(data) { return Object.fromEntries(data.entries()); }

function isTechnician() { return document.body.dataset.role === "technician"; }

async function apiRequest(url, options = {}) {
    try {
        const headers = options.body instanceof FormData ? {} : { "Content-Type": "application/json", ...(options.headers || {}) };
        const response = await fetch(url, { credentials: "same-origin", ...options, headers });
        const data = response.status === 204 ? null : await response.json().catch(() => null);
        return { ok: response.ok, data, message: data?.message };
    } catch { return { ok: false, data: null, message: "Serveur indisponible." }; }
}
