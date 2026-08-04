import { ROUTES } from "./config.js?v=116";
import { getSearchableClients } from "./clients.js?v=137";
import { addClientActivityByName } from "./client-sync.js?v=116";
import { resetSelection } from "./state.js?v=44";
import { escapeHtml, normalizeText } from "./utils.js?v=44";
import { renderPlatformAnnouncement } from "./platform-announcement.js?v=1";
import { clearSearch, createInfo, getContainer, setPage } from "./ui.js?v=44";

const CUSTOMER_TYPES = ["Particulier", "Professionnel", "Magasin", "Autre"];
const DOCUMENT_TYPES = { quote: "Devis", invoice: "Facture", credit: "Avoir" };
const BILLING_MONTHS = [
    { value: "01", label: "Janvier" }, { value: "02", label: "Février" }, { value: "03", label: "Mars" }, { value: "04", label: "Avril" },
    { value: "05", label: "Mai" }, { value: "06", label: "Juin" }, { value: "07", label: "Juillet" }, { value: "08", label: "Août" },
    { value: "09", label: "Septembre" }, { value: "10", label: "Octobre" }, { value: "11", label: "Novembre" }, { value: "12", label: "Décembre" }
];
let activeDocument = null;
let billingData = null;

export async function renderBilling(options = {}) {
    if (options.document) activeDocument = options.document;
    clearSearch();
    resetSelection("all");
    setPage("Devis, factures & rapports de fuite", ROUTES.billing, "detail");

    const container = getContainer();
    const overviewPanel = createPanel("billing-overview-panel");
    const profilePanel = createPanel("billing-profile-panel");
    const editorPanel = createPanel("billing-editor-panel");
    const listPanel = createPanel("billing-list-panel");
    container.append(overviewPanel, profilePanel, editorPanel, listPanel);
    if (isAccountant()) renderPlatformAnnouncement(container);
    overviewPanel.innerHTML = "<p class=\"muted\">Chargement de l’espace devis, factures et rapports…</p>";
    [profilePanel, editorPanel, listPanel].forEach(panel => panel.hidden = true);

    if (options.data) {
        billingData = options.data;
    } else {
        const result = await apiRequest("/api/billing");
        if (!result.ok) {
            overviewPanel.innerHTML = `<p class="auth-message error">${escapeHtml(result.message || "Impossible de charger les devis et factures.")}</p>`;
            return;
        }
        billingData = result.data;
    }
    if (options.newDocument) {
        activeDocument = options.newDocument.type === "quote" && usesExternalQuoteTemplate()
            ? null
            : createNewDocument(options.newDocument.type, options.newDocument.client, options.newDocument.appointmentId);
    }
    if (options.documentId) {
        const document = (billingData.documents || []).find(item => String(item.id) === String(options.documentId));
        activeDocument = document ? normalizeDocument(document) : null;
    }
    if (isTechnician()) {
        overviewPanel.hidden = true;
        profilePanel.hidden = true;
        listPanel.hidden = true;
        if (!activeDocument) {
            editorPanel.hidden = false;
            editorPanel.innerHTML = "<p class=\"muted\">Les devis et factures sont accessibles depuis le rendez-vous ou la fiche du client concerné.</p>";
            return;
        }
        renderDocumentEditor(editorPanel);
        return;
    }
    renderOverview(overviewPanel, profilePanel);
    if (options.profile) renderProfile(profilePanel);
    renderDocumentEditor(editorPanel);
    renderDocumentList(listPanel);
}

export function createBillingDocumentForClient(type, client, appointmentId = "") {
    if (!DOCUMENT_TYPES[type] || !client) return;
    if (!isTechnicianBillingAllowed()) {
        alert("La création de devis et factures est désactivée par l’administrateur.");
        return;
    }
    if (isTechnician() && (type !== "quote" || !appointmentId)) {
        alert("Un technicien peut créer un devis uniquement depuis l’intervention qui lui est attribuée.");
        return;
    }
    renderBilling({ newDocument: { type, client, appointmentId } });
}

export function viewBillingDocument(documentId) {
    if (!documentId) return;
    renderBilling({ documentId });
}

export async function synchronizeBillingDocuments(options = {}) {
    const isBillingScreen = Boolean(document.querySelector(".billing-list-panel"));
    if (!isBillingScreen && !options.force) return { ok: true, skipped: true };
    const result = await apiRequest("/api/billing");
    if (!result.ok) return result;
    billingData = result.data;
    const canRefreshList = options.refreshView && isBillingScreen && !activeDocument && !document.querySelector("#billingProfileForm");
    if (canRefreshList) renderBilling({ data: billingData });
    return result;
}

function createPanel(className) {
    const panel = document.createElement("section");
    panel.className = `client-panel ${className}`;
    return panel;
}

function renderOverview(panel, profilePanel) {
    const { profile, documents = [] } = billingData;
    const quotes = documents.filter(document => document.documentType === "quote").length;
    const invoices = documents.filter(document => document.documentType === "invoice").length;
    const usesExternalTemplate = usesExternalQuoteTemplate();
    panel.innerHTML = `
        <div class="billing-overview">
            <div class="billing-branding">
                ${profile.hasLogo ? '<img class="billing-logo-preview" src="/api/billing/logo" alt="Logo de votre structure">' : '<div class="billing-logo-placeholder">Votre logo</div>'}
                <div><p class="eyebrow">Espace commercial et technique</p><h2>${escapeHtml(profile.companyName || "Votre structure")}</h2></div>
            </div>
            <div class="billing-overview-actions">
                ${usesExternalTemplate && !isAccountant() ? `<button type="button" class="secondary-button" data-billing-action="download-quote-template" ${profile.hasQuoteTemplate ? "" : "disabled"}>Télécharger la base de devis</button>` : usesExternalTemplate ? "" : '<button type="button" class="secondary-button" data-billing-action="new-quote">+ Nouveau devis</button>'}
                <button type="button" class="secondary-button" data-billing-action="new-invoice">+ Nouvelle facture</button>
                ${isAccountant() ? "" : '<button type="button" class="secondary-button" data-billing-action="open-leak-reports">Rapports de fuite</button><button type="button" class="secondary-button" data-billing-action="new-leak-report">Nouveau rapport de recherche de fuite</button>'}
                ${isFullAdministrator() ? '<button type="button" class="secondary-button" data-billing-action="preview-blank-quote">Aperçu du devis vierge</button>' : ""}
            </div>
        </div>
        <div class="billing-metrics"><span><strong>${quotes}</strong> devis</span><span><strong>${invoices}</strong> factures</span><span class="billing-base-template"><strong>✓</strong> ${usesExternalTemplate ? "base PDF / Word externe" : "modèle Depann’Home intégré"}</span></div>
        ${usesExternalTemplate && !profile.hasQuoteTemplate ? '<p class="auth-message error">Aucune base de devis n’est encore déposée. Un administrateur doit l’ajouter dans Paramètres → Modèles de documents.</p>' : ""}
    `;
    panel.querySelector("[data-billing-action=new-quote]")?.toggleAttribute("hidden", isAccountant());
    panel.querySelector("[data-billing-action=new-invoice]").hidden = isAccountant();
    panel.querySelector("[data-billing-action=new-quote]")?.addEventListener("click", () => { if (!isAccountant()) openNewDocument("quote"); });
    panel.querySelector("[data-billing-action=new-invoice]").addEventListener("click", () => { if (!isAccountant()) openNewDocument("invoice"); });
    panel.querySelector("[data-billing-action=open-leak-reports]")?.addEventListener("click", async () => {
        const { renderLeakReportWizard } = await import("./leak-report-wizard.js?v=9");
        renderLeakReportWizard();
    });
    panel.querySelector("[data-billing-action=new-leak-report]")?.addEventListener("click", async () => {
        const { openLeakReportCreation } = await import("./leak-report-wizard.js?v=9");
        openLeakReportCreation();
    });
    panel.querySelector("[data-billing-action=download-quote-template]")?.addEventListener("click", openQuoteTemplateDownload);
    panel.querySelector("[data-billing-action=preview-blank-quote]")?.addEventListener("click", openBlankQuotePreview);
}

function renderProfile(panel) {
    panel.hidden = false;
    const profile = billingData.profile;
    panel.innerHTML = `
        <form id="billingProfileForm" class="client-form" enctype="multipart/form-data">
            <div class="form-heading"><div><p class="eyebrow">Informations entreprise</p><h2>Coordonnées, mentions et logo</h2><p class="muted">Ces informations sont reprises sur vos devis et factures. Le modèle du document reste inchangé.</p></div><button type="button" class="secondary-button" id="closeBillingProfile">Fermer</button></div>
            <div class="form-grid">
                <label>Nom de la structure<input name="companyName" maxlength="160" placeholder="Ex. Dépann’Home Services" value="${escapeHtml(profile.companyName)}"></label>
                <label>Forme juridique / activité<input name="legalForm" maxlength="100" placeholder="Ex. SASU – dépannage à domicile" value="${escapeHtml(profile.legalForm)}"></label>
                <label class="form-wide">Adresse<input name="address" maxlength="255" value="${escapeHtml(profile.address)}"></label>
                <label>Code postal<input name="postalCode" maxlength="20" value="${escapeHtml(profile.postalCode)}"></label>
                <label>Ville<input name="city" maxlength="100" value="${escapeHtml(profile.city)}"></label>
                <label>Téléphone<input name="phone" maxlength="50" value="${escapeHtml(profile.phone)}"></label>
                <label>E-mail<input name="email" type="email" maxlength="160" value="${escapeHtml(profile.email)}"></label>
                <label>Immatriculation / SIRET<input name="registrationNumber" maxlength="100" value="${escapeHtml(profile.registrationNumber)}"></label>
                <label>SIREN<input name="siren" maxlength="20" value="${escapeHtml(profile.siren || "")}"></label>
                <label>N° TVA intracommunautaire<input name="taxNumber" maxlength="100" value="${escapeHtml(profile.taxNumber)}"></label>
                <label>IBAN<input name="bankIban" maxlength="80" value="${escapeHtml(profile.bankIban || "")}"></label>
                <label>BIC<input name="bankBic" maxlength="40" value="${escapeHtml(profile.bankBic || "")}"></label>
                <label>Acompte / condition de devis<input name="depositTerms" maxlength="500" placeholder="Ex. Acompte de 30 % à la commande" value="${escapeHtml(profile.depositTerms || "")}"></label>
                <label class="form-wide">Conditions de règlement<input name="paymentTerms" maxlength="500" placeholder="Ex. Paiement à réception par virement ou chèque" value="${escapeHtml(profile.paymentTerms)}"></label>
                <label class="form-wide">Mention de bas de page<textarea name="footerNote" rows="2" maxlength="1000" placeholder="Mentions légales, pénalités de retard, assurance…">${escapeHtml(profile.footerNote)}</textarea></label>
                <label>Logo (PNG, JPEG ou WebP, 2 Mo maximum)<input name="logo" type="file" accept="image/png,image/jpeg,image/webp"></label>
                ${profile.hasLogo ? '<label class="billing-remove-logo"><input name="removeLogo" type="checkbox" value="true"> Supprimer le logo actuel</label>' : ""}
            </div>
            <p id="billingProfileMessage" class="auth-message" aria-live="polite"></p>
            <div class="form-actions"><button type="submit" class="secondary-button">Enregistrer les paramètres</button></div>
        </form>
    `;
    panel.querySelector("#closeBillingProfile").addEventListener("click", () => { panel.hidden = true; });
    panel.querySelector("form").addEventListener("submit", async event => {
        event.preventDefault();
        const form = event.currentTarget;
        const message = panel.querySelector("#billingProfileMessage");
        const submit = form.querySelector("button[type=submit]");
        if (form.elements.removeLogo?.checked && !confirm("Supprimer définitivement le logo actuel de votre structure ?")) return;
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
    renderQuoteTemplateSettings(panel, profile);
}

function renderQuoteTemplateSettings(panel, profile) {
    const policy = profile.quoteTemplatePolicy || "company_choice";
    const mode = policy === "integrated_only" ? "integrated" : policy === "external_only" ? "external" : profile.quoteTemplateMode || "integrated";
    const canChooseMode = policy === "company_choice";
    const canUseExternalTemplate = policy !== "integrated_only";
    const policyMessage = policy === "integrated_only"
        ? "Le Créateur a imposé le modèle Depann’Home intégré pour cette entreprise."
        : policy === "external_only"
            ? "Le Créateur a imposé une base de devis externe. Déposez un fichier avant de créer vos devis."
            : "Votre entreprise peut utiliser le modèle intégré ou sa propre base de devis.";
    panel.insertAdjacentHTML("beforeend", `
        <section class="billing-quote-template-settings">
            <div class="form-heading"><div><p class="eyebrow">Base de devis</p><h2>Modèle intégré ou fichier entreprise</h2><p class="muted">${escapeHtml(policyMessage)}</p></div>${profile.hasQuoteTemplate ? '<button type="button" class="secondary-button" id="downloadQuoteTemplate">Télécharger la base actuelle</button>' : ""}</div>
            <form id="quoteTemplateForm" class="client-form" enctype="multipart/form-data">
                <div class="form-grid">
                    <label>Base utilisée<select name="quoteTemplateMode" ${canChooseMode ? "" : "disabled"}><option value="integrated" ${mode === "integrated" ? "selected" : ""}>Modèle Depann’Home intégré</option><option value="external" ${mode === "external" ? "selected" : ""}>Base PDF / Word de l’entreprise</option></select></label>
                    <label>Déposer ou remplacer la base (PDF, DOC ou DOCX · 10 Mo max)<input name="quoteTemplate" type="file" accept="application/pdf,.pdf,application/msword,.doc,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx" ${canUseExternalTemplate ? "" : "disabled"}></label>
                    ${profile.hasQuoteTemplate && canUseExternalTemplate ? '<label class="billing-remove-logo"><input name="removeQuoteTemplate" type="checkbox" value="true"> Supprimer la base déposée</label>' : ""}
                </div>
                ${profile.hasQuoteTemplate ? `<p class="muted">Fichier actuel : ${escapeHtml(profile.quoteTemplateFilename || "base-devis")}</p>` : ""}
                <p id="quoteTemplateMessage" class="auth-message" aria-live="polite"></p>
                <div class="form-actions"><button type="submit" class="secondary-button" ${canUseExternalTemplate ? "" : "disabled"}>Enregistrer la base de devis</button></div>
            </form>
        </section>
    `);
    panel.querySelector("#downloadQuoteTemplate")?.addEventListener("click", openQuoteTemplateDownload);
    panel.querySelector("#quoteTemplateForm").addEventListener("submit", async event => {
        event.preventDefault();
        const form = event.currentTarget;
        const message = panel.querySelector("#quoteTemplateMessage");
        const submit = form.querySelector("button[type=submit]");
        submit.disabled = true;
        message.textContent = "Enregistrement…";
        message.classList.remove("error");
        const result = await apiRequest("/api/billing/quote-template", { method: "PUT", body: new FormData(form) });
        if (!result.ok) {
            message.textContent = result.message || "Impossible d’enregistrer la base de devis.";
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
        <div class="form-heading"><div><p class="eyebrow">Lignes préenregistrées</p><h2>Vos prestations et fournitures</h2></div></div>
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
    const linkedInvoice = document.documentType === "quote" ? getInvoiceForQuote(document) : null;
    if (isEditing && (isTechnician() || isAccountant() || document.documentType === "credit")) return renderReadOnlyDocument(panel, document);
    const clients = getSearchableClients().sort((a, b) => a.name.localeCompare(b.name, "fr"));
    panel.innerHTML = `
        <form id="billingDocumentForm" class="client-form">
            <div class="form-heading"><div><p class="eyebrow">${isEditing ? "Modification" : "Nouveau document"}</p><h2>${isEditing ? "Modifier le document" : `Créer un ${DOCUMENT_TYPES[document.documentType].toLowerCase()}`}</h2></div><div class="calendar-form-actions">${isEditing && document.documentType === "quote" ? linkedInvoice ? `<button type="button" class="secondary-button" data-view-linked-invoice="${escapeHtml(linkedInvoice.id)}">Voir la facture</button>` : '<button type="button" class="secondary-button" id="createInvoiceFromQuote">Créer la facture</button>' : ""}<button type="button" class="secondary-button" id="cancelBillingDocument">Annuler</button></div></div>
            <div class="form-grid">
                ${isTechnician() ? '<input name="documentType" type="hidden" value="quote"><p class="billing-quote-reference">Type : <strong>Devis</strong></p>' : `<label>Type *<select name="documentType">${Object.entries(DOCUMENT_TYPES).filter(([id]) => id !== "credit").map(([id, label]) => `<option value="${id}" ${document.documentType === id ? "selected" : ""}>${label}</option>`).join("")}</select></label>`}
                <label>Numéro *<input name="documentNumber" maxlength="80" required placeholder="Ex. DEV-2026-001" value="${escapeHtml(document.documentNumber)}"></label>
                <input name="clientId" type="hidden" value="${escapeHtml(document.clientId || "")}">
                <input name="appointmentId" type="hidden" value="${escapeHtml(document.appointmentId || "")}">
                ${document.documentType === "invoice" ? `<input name="sourceQuoteId" type="hidden" value="${escapeHtml(document.sourceQuoteId || "")}"><p class="billing-quote-reference">${document.quoteReference ? `Référence devis : <strong>${escapeHtml(document.quoteReference)}</strong>` : "Facture sans devis associé"}</p>` : ""}
                <label>Catégorie client<select name="customerType">${CUSTOMER_TYPES.map(type => `<option ${document.customerType === type ? "selected" : ""}>${type}</option>`).join("")}</select></label>
                <label>Client / destinataire *<input name="customerName" list="billingClients" maxlength="160" required value="${escapeHtml(document.customerName)}"><datalist id="billingClients">${clients.map(client => `<option value="${escapeHtml(client.name)}">${escapeHtml([client.address, client.city].filter(Boolean).join(", "))}</option>`).join("")}</datalist></label>
                <label class="form-wide">Adresse du destinataire<textarea name="customerAddress" rows="2" maxlength="500" placeholder="Adresse de facturation">${escapeHtml(document.customerAddress)}</textarea></label>
                <label>Date *<input name="issueDate" type="date" required value="${escapeHtml(document.issueDate)}"></label>
                <label>Échéance<input name="dueDate" type="date" value="${escapeHtml(document.dueDate || "")}"></label>
                <label>Statut<input name="status" maxlength="30" value="${escapeHtml(document.status || "draft")}" placeholder="Brouillon, envoyé, réglé…"></label>
                ${document.documentType === "invoice" ? `<label class="billing-accounting-option"><input name="isAccounted" type="checkbox" ${document.isAccounted ? "checked" : ""}> Facture comptabilisée</label>` : ""}
            </div>
            <section class="billing-lines-section"><div class="form-heading"><div><p class="eyebrow">Prestations</p><h3>Lignes du document</h3></div><button type="button" class="secondary-button" id="addBillingLine">+ Ligne libre</button></div><div id="billingLines" class="billing-lines"></div><div class="billing-totals" id="billingTotals"></div></section>
            ${!isAccountant() ? '<section class="billing-aids-section" id="billingAids"></section>' : ""}
            <label>Notes / conditions<textarea name="notes" rows="3" maxlength="2000" placeholder="Informations complémentaires, conditions, validité du devis…">${escapeHtml(document.notes)}</textarea></label>
            <p id="billingDocumentMessage" class="auth-message" aria-live="polite"></p>
            <div class="calendar-form-actions"><button type="submit" class="secondary-button">${isEditing ? "Enregistrer les modifications" : "Enregistrer le document"}</button>${isEditing ? '<button type="button" class="danger-button" id="deleteBillingDocument">Supprimer</button>' : ""}</div>
        </form>
    `;
    const form = panel.querySelector("form");
    const linesNode = panel.querySelector("#billingLines");
    const renderLines = () => {
        linesNode.innerHTML = "";
        document.lines.forEach((line, index) => linesNode.appendChild(createLineEditor(line, index, document, renderLines)));
        renderTotals(panel.querySelector("#billingTotals"), document.lines, document.financialData);
    };
    renderLines();
    renderDocumentAids(panel.querySelector("#billingAids"), document, renderLines);
    form.querySelector("#addBillingLine").addEventListener("click", () => { document.lines.push(emptyLine()); renderLines(); });
    form.querySelector("#cancelBillingDocument").addEventListener("click", () => { activeDocument = null; renderBilling(); });
    form.querySelector("#createInvoiceFromQuote")?.addEventListener("click", () => createInvoiceFromQuote(document));
    form.querySelector("[data-view-linked-invoice]")?.addEventListener("click", event => viewBillingDocument(event.currentTarget.dataset.viewLinkedInvoice));
    const customerInput = form.querySelector("[name=customerName]");
    customerInput.addEventListener("change", () => fillCustomerAddress(customerInput, form, clients));
    customerInput.addEventListener("input", () => fillCustomerAddress(customerInput, form, clients));
    form.addEventListener("submit", async event => {
        event.preventDefault();
        const payload = { ...formDataToObject(new FormData(form)), lines: document.lines, financialData: document.financialData };
        const message = panel.querySelector("#billingDocumentMessage");
        const result = await apiRequest(isEditing ? `/api/billing/documents/${encodeURIComponent(document.id)}` : "/api/billing/documents", { method: isEditing ? "PUT" : "POST", body: JSON.stringify(payload) });
        if (!result.ok) { message.textContent = result.message || "Impossible d’enregistrer le document."; message.classList.add("error"); return; }
        if (!isEditing) addClientActivityByName(payload.customerName, {
            type: payload.documentType,
            label: `${DOCUMENT_TYPES[payload.documentType]} créé`,
            detail: payload.documentNumber,
            documentId: result.data?.id
        });
        activeDocument = null;
        if (!isEditing && payload.appointmentId) {
            window.dispatchEvent(new CustomEvent("depannhome:billing-document-saved", { detail: { appointmentId: payload.appointmentId } }));
            return;
        }
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
    const linkedInvoice = document.documentType === "quote" ? getInvoiceForQuote(document) : null;
    panel.innerHTML = `
        <div class="billing-read-only-document">
            <div class="form-heading"><div><p class="eyebrow">Consultation uniquement</p><h2>${escapeHtml(DOCUMENT_TYPES[document.documentType])} ${escapeHtml(document.documentNumber)}</h2></div><div class="calendar-form-actions">${document.documentType === "quote" && (linkedInvoice || !isAccountant()) ? linkedInvoice ? `<button type="button" class="secondary-button" data-view-linked-invoice="${escapeHtml(linkedInvoice.id)}">Voir la facture</button>` : '<button type="button" class="secondary-button" id="createInvoiceFromQuote">Créer la facture</button>' : ""}<button type="button" class="secondary-button" id="closeBillingDocument">Fermer</button></div></div>
            <div class="procedure-meta"><span>${escapeHtml(document.customerName)}</span><span>${escapeHtml(formatDate(document.issueDate))}</span><span>${escapeHtml(documentStatusLabel(document.status))}</span>${document.documentType === "invoice" ? `<span>${document.quoteReference ? `Réf. devis ${escapeHtml(document.quoteReference)}` : "Sans devis associé"}</span><span>${document.isAccounted ? `Comptabilisée le ${escapeHtml(formatDate(document.accountedAt))}` : "Non comptabilisée"}</span>` : ""}</div>
            <div class="billing-read-only-lines">${document.lines.map(line => `<div><span>${escapeHtml(line.description)}</span><strong>${escapeHtml(String(line.quantity))} × ${escapeHtml(formatMoney(line.unitPrice))}</strong><b>${escapeHtml(formatMoney(lineTotal(line)))}</b></div>`).join("")}</div>
            <div class="billing-totals" id="billingReadOnlyTotals"></div>
            ${document.notes ? `<section class="procedure-section"><h3>Notes / conditions</h3><p>${escapeHtml(document.notes)}</p></section>` : ""}
        </div>`;
    renderTotals(panel.querySelector("#billingReadOnlyTotals"), document.lines, document.financialData);
    panel.querySelector("#closeBillingDocument").addEventListener("click", () => { activeDocument = null; renderBilling(); });
    panel.querySelector("#createInvoiceFromQuote")?.addEventListener("click", () => createInvoiceFromQuote(document));
    panel.querySelector("[data-view-linked-invoice]")?.addEventListener("click", event => viewBillingDocument(event.currentTarget.dataset.viewLinkedInvoice));
}

function createLineEditor(line, index, billingDocument, rerender) {
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
        renderTotals(item.closest("form").querySelector("#billingTotals"), billingDocument.lines, billingDocument.financialData);
    }));
    item.querySelector("select").addEventListener("change", event => {
        const template = billingData.templates.find(value => String(value.id) === event.target.value);
        if (!template) return;
        Object.assign(line, { description: template.description ? `${template.label} — ${template.description}` : template.label, unit: template.unit, unitPrice: Number(template.unitPrice), vatRate: Number(template.vatRate) });
        rerender();
    });
    item.querySelector("button").addEventListener("click", () => {
        if (!confirm("Supprimer cette ligne du document en cours ?")) return;
        billingDocument.lines.splice(index, 1);
        if (!billingDocument.lines.length) billingDocument.lines.push(emptyLine());
        rerender();
    });
    return item;
}

function renderDocumentAids(panel, billingDocument, rerender) {
    if (!panel) return;
    const aids = billingData.aids || [];
    if (!billingDocument.financialData.aids.length) {
        billingDocument.financialData.aids = aids.filter(aid => aid.autoApply).map(toAidSnapshot);
    }
    const selectedAids = billingDocument.financialData.aids;
    panel.innerHTML = `<div class="form-heading"><div><p class="eyebrow">Primes et aides</p><h3>Déduites du reste à charge</h3><p class="muted">Sélectionnez les primes applicables à ce document. Elles restent affichées sur le PDF.</p></div></div>${aids.length ? `<fieldset class="accounting-aid-fieldset">${aids.map(aid => `<label><input type="checkbox" value="${escapeHtml(aid.id)}" ${selectedAids.some(item => item.name === aid.name) ? "checked" : ""}> ${escapeHtml(aid.name)} · ${aid.calculationMode === "percentage" ? `${formatNumber(aid.amount)} %` : formatMoney(aid.amount)}</label>`).join("")}</fieldset>` : '<p class="muted">Aucune prime configurée. Ajoutez-les dans Comptabilité → Aides financières.</p>'}`;
    panel.querySelectorAll("input[type=checkbox]").forEach(input => input.addEventListener("change", () => {
        billingDocument.financialData.aids = [...panel.querySelectorAll("input:checked")].map(field => aids.find(aid => String(aid.id) === field.value)).filter(Boolean).map(toAidSnapshot);
        rerender();
    }));
}

function toAidSnapshot(aid) { return { name: aid.name, amount: Number(aid.amount) || 0, calculationMode: aid.calculationMode === "percentage" ? "percentage" : "fixed", aidType: aid.aidType || "custom", description: aid.description || "" }; }

function renderTotals(panel, lines, financialData = {}) {
    const totalHt = lines.reduce((total, line) => total + lineTotal(line), 0);
    const totalVat = lines.reduce((total, line) => total + lineTotal(line) * (Number(line.vatRate) || 0) / 100, 0);
    const totalTtc = totalHt + totalVat;
    const aidAmount = Math.min(totalTtc, (financialData.aids || []).reduce((total, aid) => total + (aid.calculationMode === "percentage" ? totalHt * Number(aid.amount || 0) / 100 : Number(aid.amount || 0)), 0));
    panel.innerHTML = `<span>Total HT <strong>${formatMoney(totalHt)}</strong></span><span>TVA <strong>${formatMoney(totalVat)}</strong></span><span>Total TTC <strong>${formatMoney(totalTtc)}</strong></span>${aidAmount ? `<span>Primes / aides <strong>− ${formatMoney(aidAmount)}</strong></span><span>Reste à charge <strong>${formatMoney(Math.max(0, totalTtc - aidAmount))}</strong></span>` : ""}`;
}

function renderDocumentList(panel) {
    panel.hidden = false;
    const documents = billingData.documents || [];
    const quotes = documents.filter(document => document.documentType === "quote");
    const invoices = documents.filter(document => document.documentType === "invoice");
    const years = [...new Set(documents.map(document => String(document.issueDate || "").slice(0, 4)).filter(Boolean))].sort((first, second) => second.localeCompare(first));
    const invoicedTotal = invoices.reduce((total, document) => total + calculateTotals(document.lines || []).ttc, 0);
    const accountedTotal = invoices.filter(document => document.isAccounted).reduce((total, document) => total + calculateTotals(document.lines || []).ttc, 0);
    panel.innerHTML = `
        <div class="form-heading"><div><p class="eyebrow">Base de données commerciale</p><h2>Registre des devis & factures</h2></div></div>
        <div class="billing-metrics billing-register-metrics"><span><strong>${quotes.length}</strong> devis générés</span><span><strong>${invoices.length}</strong> factures générées</span><span><strong>${formatMoney(invoicedTotal)}</strong> facturé TTC</span><span class="billing-accounted-metric"><strong>${formatMoney(accountedTotal)}</strong> comptabilisé TTC</span></div>
        <div class="billing-register-filters"><input id="billingDocumentSearch" type="search" placeholder="Rechercher un numéro ou un client" aria-label="Rechercher un document"><select id="billingDocumentTypeFilter" aria-label="Filtrer par type"><option value="all">Tous les documents</option><option value="quote">Devis</option><option value="invoice">Factures</option></select><select id="billingDocumentYearFilter" aria-label="Filtrer par année"><option value="all">Toutes les années</option>${years.map(year => `<option value="${escapeHtml(year)}">${escapeHtml(year)}</option>`).join("")}</select><select id="billingDocumentMonthFilter" aria-label="Filtrer par mois"><option value="all">Tous les mois</option>${BILLING_MONTHS.map(({ value, label }) => `<option value="${value}">${label}</option>`).join("")}</select><select id="billingAccountingFilter" aria-label="Filtrer par comptabilisation"><option value="all">Tous les statuts comptables</option><option value="accounted">Comptabilisées</option><option value="unaccounted">À comptabiliser</option></select></div>
        <div class="billing-document-list" id="billingDocumentList"></div>
    `;
    const list = panel.querySelector("#billingDocumentList");
    const search = panel.querySelector("#billingDocumentSearch");
    const typeFilter = panel.querySelector("#billingDocumentTypeFilter");
    const yearFilter = panel.querySelector("#billingDocumentYearFilter");
    const monthFilter = panel.querySelector("#billingDocumentMonthFilter");
    const accountingFilter = panel.querySelector("#billingAccountingFilter");
    const renderFilteredDocuments = () => {
        const query = normalizeText(search.value);
        const visibleDocuments = documents.filter(document => {
            const matchesQuery = !query || normalizeText(`${document.documentNumber} ${document.quoteReference || ""} ${document.customerName}`).includes(query);
            const matchesType = typeFilter.value === "all" || document.documentType === typeFilter.value;
            const matchesYear = yearFilter.value === "all" || String(document.issueDate || "").slice(0, 4) === yearFilter.value;
            const matchesMonth = monthFilter.value === "all" || String(document.issueDate || "").slice(5, 7) === monthFilter.value;
            const matchesAccounting = accountingFilter.value === "all" || (document.documentType === "invoice" && (accountingFilter.value === "accounted" ? document.isAccounted : !document.isAccounted));
            return matchesQuery && matchesType && matchesYear && matchesMonth && matchesAccounting;
        });
        list.innerHTML = "";
        if (!visibleDocuments.length) { list.innerHTML = `<p class="muted">${documents.length ? "Aucun document ne correspond aux filtres." : "Créez votre premier devis ou votre première facture."}</p>`; return; }
        let currentPeriod = "";
        visibleDocuments.forEach(billingDocument => {
            const period = formatBillingPeriod(billingDocument.issueDate);
            if (period !== currentPeriod) {
                const heading = document.createElement("h3");
                heading.className = "billing-document-period";
                heading.textContent = period;
                list.appendChild(heading);
                currentPeriod = period;
            }
            const item = document.createElement("article");
            item.className = "billing-document-item";
            const linkedInvoice = billingDocument.documentType === "quote" ? getInvoiceForQuote(billingDocument) : null;
            const totals = calculateTotals(billingDocument.lines || []);
            const accountingLabel = billingDocument.documentType === "invoice" ? (billingDocument.isAccounted ? `Comptabilisée le ${formatDate(billingDocument.accountedAt)}` : "À comptabiliser") : "Non concerné";
            const client = getSearchableClients().find(item => normalizeText(item.name) === normalizeText(billingDocument.customerName));
            const recipient = client?.email || "";
            item.innerHTML = `<div><p class="eyebrow">${DOCUMENT_TYPES[billingDocument.documentType]} · ${escapeHtml(billingDocument.customerType)}</p><h3>${escapeHtml(billingDocument.documentNumber)}</h3><p>${escapeHtml(billingDocument.customerName)}</p><small>${escapeHtml(formatDate(billingDocument.issueDate))} · ${escapeHtml(documentStatusLabel(billingDocument.status))}${billingDocument.quoteReference ? ` · Réf. devis ${escapeHtml(billingDocument.quoteReference)}` : ""} · <span class="billing-accounting-status ${billingDocument.isAccounted ? "is-accounted" : ""}">${escapeHtml(accountingLabel)}</span></small></div><div class="billing-document-amount"><strong>${formatMoney(totals.ttc)}</strong><small>TTC</small></div><div class="billing-document-actions">${billingDocument.documentType === "invoice" && !isTechnician() && !isAccountant() ? `<button type="button" class="secondary-button" data-accounting="${billingDocument.isAccounted ? "false" : "true"}">${billingDocument.isAccounted ? "Décomptabiliser" : "Comptabiliser"}</button>` : ""}${billingDocument.documentType === "quote" && !isAccountant() ? linkedInvoice ? `<button type="button" class="secondary-button" data-view-linked-invoice="${escapeHtml(linkedInvoice.id)}">Voir la facture</button>` : '<button type="button" class="secondary-button" data-create-invoice>Créer la facture</button>' : ""}<button type="button" class="secondary-button" data-open-document>${isTechnician() || isAccountant() ? "Consulter" : "Ouvrir"}</button><button type="button" class="secondary-button" data-pdf>PDF / Imprimer</button>${isAccountant() ? "" : `<button type="button" class="secondary-button" data-email ${recipient ? "" : "disabled title=\"Ajoutez l’e-mail du client dans sa fiche pour envoyer le document.\""}>Envoyer par e-mail</button>`}</div>`;
            item.querySelector("[data-open-document]").addEventListener("click", () => { activeDocument = normalizeDocument(billingDocument); renderBilling(); });
            item.querySelector("[data-create-invoice]")?.addEventListener("click", () => createInvoiceFromQuote(billingDocument));
            item.querySelector("[data-view-linked-invoice]")?.addEventListener("click", event => viewBillingDocument(event.currentTarget.dataset.viewLinkedInvoice));
            item.querySelector("[data-pdf]").addEventListener("click", () => openBillingPdf(billingDocument.id));
            item.querySelector("[data-email]")?.addEventListener("click", () => emailBillingPdf(billingDocument, recipient));
            item.querySelector("[data-accounting]")?.addEventListener("click", async event => {
                const result = await apiRequest(`/api/billing/documents/${encodeURIComponent(billingDocument.id)}/accounting`, { method: "PATCH", body: JSON.stringify({ isAccounted: event.currentTarget.dataset.accounting === "true" }) });
                if (!result.ok) { alert(result.message || "Impossible de mettre à jour la comptabilité."); return; }
                renderBilling();
            });
            list.appendChild(item);
        });
    };
    [search, typeFilter, yearFilter, monthFilter, accountingFilter].forEach(input => input.addEventListener(input === search ? "input" : "change", renderFilteredDocuments));
    renderFilteredDocuments();
}

function openNewDocument(type) {
    activeDocument = createNewDocument(type);
    renderBilling();
}

function createInvoiceFromQuote(quote) {
    if (!quote || quote.documentType !== "quote") return;
    const linkedInvoice = getInvoiceForQuote(quote);
    if (linkedInvoice) { viewBillingDocument(linkedInvoice.id); return; }
    activeDocument = {
        id: null,
        documentType: "invoice",
        documentNumber: suggestNumber("invoice"),
        clientId: quote.clientId || "",
        appointmentId: quote.appointmentId || "",
        sourceQuoteId: quote.id,
        quoteReference: quote.documentNumber,
        customerType: quote.customerType || "Particulier",
        customerName: quote.customerName || "",
        customerAddress: quote.customerAddress || "",
        issueDate: today(),
        dueDate: "",
        status: "draft",
        isAccounted: false,
        lines: (quote.lines || []).map(line => ({ ...emptyLine(), ...line })),
        financialData: normalizeFinancialData(quote.financialData),
        notes: quote.notes || ""
    };
    renderBilling();
}

function createNewDocument(type, client = null, appointmentId = "") {
    const baseQuote = type === "quote" ? normalizeQuoteTemplate(billingData.profile.defaultQuote) : null;
    return {
        id: null,
        documentType: type,
        documentNumber: suggestNumber(type),
        clientId: client?.id || "",
        appointmentId,
        customerType: client ? getBillingCustomerType(client.type) : baseQuote?.customerType || "Particulier",
        customerName: client?.name || "",
        customerAddress: client ? [client.address, client.city].filter(Boolean).join(", ") : "",
        issueDate: today(),
        dueDate: "",
        status: baseQuote?.status || "draft",
        isAccounted: false,
        lines: baseQuote?.lines || [emptyLine()],
        financialData: emptyFinancialData(),
        notes: baseQuote?.notes || billingData.profile.paymentTerms || ""
    };
}

function getBillingCustomerType(type) { return CUSTOMER_TYPES.includes(type) ? type : "Autre"; }
function getInvoiceForQuote(quote) {
    return (billingData?.documents || []).find(document => document.documentType === "invoice" && String(document.sourceQuoteId || "") === String(quote?.id || "")) || null;
}
function fillCustomerAddress(input, form, clients) {
    const client = clients.find(item => normalizeText(item.name) === normalizeText(input.value));
    if (client) form.querySelector("[name=customerAddress]").value = [client.address, client.city].filter(Boolean).join(", ");
}

function emptyLine() { return { description: "", quantity: 1, unit: "unité", unitPrice: 0, vatRate: 20 }; }
function normalizeDocument(document) { return { ...document, clientId: document.clientId || "", appointmentId: document.appointmentId || "", sourceQuoteId: document.sourceQuoteId || "", quoteReference: document.quoteReference || "", isAccounted: Boolean(document.isAccounted), financialData: normalizeFinancialData(document.financialData), lines: Array.isArray(document.lines) && document.lines.length ? document.lines.map(line => ({ ...emptyLine(), ...line })) : [emptyLine()] }; }
function emptyFinancialData() { return { discountMode: "fixed", discountAmount: 0, depositAmount: 0, conditions: "", comments: "", aids: [] }; }
function normalizeFinancialData(value) { return { ...emptyFinancialData(), discountMode: value?.discountMode === "percentage" ? "percentage" : "fixed", discountAmount: Number(value?.discountAmount) || 0, depositAmount: Number(value?.depositAmount) || 0, conditions: value?.conditions || "", comments: value?.comments || "", aids: Array.isArray(value?.aids) ? value.aids.filter(aid => aid?.name).map(toAidSnapshot) : [] }; }
function normalizeQuoteTemplate(template) {
    if (!template || !Array.isArray(template.lines) || !template.lines.length) return null;
    return { ...template, lines: template.lines.map(line => ({ ...emptyLine(), ...line })) };
}
function suggestNumber(type) { return `${type === "quote" ? "DEV" : "FAC"}-${new Date().getFullYear()}-${String((billingData.documents || []).filter(document => document.documentType === type).length + 1).padStart(3, "0")}`; }
function lineTotal(line) { return (Number(line.quantity) || 0) * (Number(line.unitPrice) || 0); }
function calculateTotals(lines) { const ht = lines.reduce((sum, line) => sum + lineTotal(line), 0); const vat = lines.reduce((sum, line) => sum + lineTotal(line) * (Number(line.vatRate) || 0) / 100, 0); return { ht, vat, ttc: ht + vat }; }
function formatMoney(value) { return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(Number(value) || 0); }
function formatNumber(value) { return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(Number(value) || 0); }
function documentStatusLabel(value) { return ({ draft: "Brouillon", sent: "Envoyé", validated: "Validé", paid: "Réglé", issued: "Émis", cancelled: "Annulé", accepted: "Accepté", rejected: "Refusé", pending: "En attente" })[String(value || "").toLowerCase()] || "Non renseigné"; }
function formatDate(value) { return value ? new Intl.DateTimeFormat("fr-FR").format(new Date(`${value}T12:00:00`)) : "Date non renseignée"; }
function formatBillingPeriod(value) {
    const [year, month] = String(value || "").split("-");
    return `${BILLING_MONTHS.find(item => item.value === month)?.label || "Date non renseignée"}${year ? ` ${year}` : ""}`;
}
function today() { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function formDataToObject(data) { return Object.fromEntries(data.entries()); }

function isTechnician() { return document.body.dataset.role === "technician"; }
function isAccountant() { return document.body.dataset.role === "accountant"; }
function isFullAdministrator() { return document.body.dataset.role === "admin"; }
function isTechnicianBillingAllowed() { return !isTechnician() || document.body.dataset.technicianBillingEnabled !== "false"; }
function usesExternalQuoteTemplate() {
    const policy = billingData?.profile?.quoteTemplatePolicy;
    return policy === "external_only" || (policy !== "integrated_only" && billingData?.profile?.quoteTemplateMode === "external");
}

function openBillingPdf(documentId) {
    const popup = window.open("", "_blank");
    if (!popup) { alert("Autorisez les fenêtres pop-up pour afficher le PDF."); return; }
    popup.location.href = `/api/billing/documents/${encodeURIComponent(documentId)}/pdf`;
}

function openBlankQuotePreview() {
    const popup = window.open("", "_blank");
    if (!popup) { alert("Autorisez les fenêtres pop-up pour afficher l’aperçu du devis."); return; }
    popup.location.href = "/api/billing/blank-quote/pdf";
}

function openQuoteTemplateDownload() {
    const popup = window.open("", "_blank");
    if (!popup) { alert("Autorisez les fenêtres pop-up pour télécharger la base de devis."); return; }
    popup.location.href = "/api/billing/quote-template/file";
}

async function emailBillingPdf(document, recipient) {
    if (!recipient) { alert("Ajoutez l’e-mail du client dans sa fiche avant d’envoyer le document."); return; }
    const destination = window.prompt("Adresse e-mail du destinataire :", recipient);
    if (destination === null) return;
    if (!destination.trim()) { alert("Saisissez une adresse e-mail valide."); return; }
    const type = document.documentType === "invoice" ? "facture" : "devis";
    if (!confirm(`Envoyer la ${type} ${document.documentNumber} en PDF à ${destination.trim()} ?`)) return;
    const result = await apiRequest(`/api/billing/documents/${encodeURIComponent(document.id)}/email`, { method: "POST", body: JSON.stringify({ recipient: destination.trim() }) });
    alert(result.ok ? result.message || "Document envoyé par e-mail." : result.message || "Impossible d’envoyer le document par e-mail.");
}

async function apiRequest(url, options = {}) {
    try {
        const headers = options.body instanceof FormData ? {} : { "Content-Type": "application/json", ...(options.headers || {}) };
        const response = await fetch(url, { credentials: "same-origin", ...options, headers });
        const data = response.status === 204 ? null : await response.json().catch(() => null);
        return { ok: response.ok, data, message: data?.message };
    } catch { return { ok: false, data: null, message: "Serveur indisponible." }; }
}
