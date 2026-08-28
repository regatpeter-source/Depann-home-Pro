import { ROUTES } from "./config.js?v=116";
import { getSearchableClients } from "./clients.js?v=153";
import { addClientActivityByName } from "./client-sync.js?v=125";
import { resetSelection } from "./state.js?v=44";
import { escapeHtml, normalizeText } from "./utils.js?v=44";
import { renderPlatformAnnouncement } from "./platform-announcement.js?v=1";
import { clearSearch, createInfo, getContainer, setPage } from "./ui.js?v=44";
import { openDocumentDeliveryChoice } from "./document-delivery.js?v=1";

const CUSTOMER_TYPES = ["Particulier", "Professionnel", "Magasin", "Autre"];
const PAYMENT_METHODS = ["Chèque", "Espèces", "Virement", "Carte bancaire"];
const DOCUMENT_TYPES = { quote: "Devis", invoice: "Facture", credit: "Avoir" };
const AID_TYPES = { cee: "CEE", maprimerenov: "MaPrimeRénov'", coup_de_pouce: "Prime Coup de Pouce", eco_ptz: "Éco-PTZ", regional: "Aide régionale", departmental: "Aide départementale", supplier: "Participation fournisseur", manufacturer: "Participation constructeur", custom: "Autre aide" };
const VAT_FRANCHISE_MENTION = "TVA non applicable, art. 293 B du CGI";
const BILLING_MONTHS = [
    { value: "01", label: "Janvier" }, { value: "02", label: "Février" }, { value: "03", label: "Mars" }, { value: "04", label: "Avril" },
    { value: "05", label: "Mai" }, { value: "06", label: "Juin" }, { value: "07", label: "Juillet" }, { value: "08", label: "Août" },
    { value: "09", label: "Septembre" }, { value: "10", label: "Octobre" }, { value: "11", label: "Novembre" }, { value: "12", label: "Décembre" }
];
let activeDocument = null;
let billingData = null;
let billingPreviewCleanup = () => {};

export async function renderBilling(options = {}) {
    billingPreviewCleanup();
    billingPreviewCleanup = () => {};
    if (options.document) activeDocument = options.document;
    clearSearch();
    resetSelection("all");
    const templateSection = ["quote", ...(canAccessQuitus() ? ["quitus"] : []), ...(canAccessTechnicalReports() ? ["report"] : [])].includes(options.templateSection) ? options.templateSection : "";
    const templateTitle = ({ quote: "Modèle de devis", quitus: "Modèle de quitus", report: "Modèle de rapport" })[templateSection];
    setPage(templateTitle ? `Paramètres · ${templateTitle}` : canAccessTechnicalReports() ? "Devis, factures & rapports de fuite" : "Devis, factures & facturation", templateTitle ? ROUTES.settings : ROUTES.billing, "detail");

    const container = getContainer();
    const overviewPanel = createPanel("billing-overview-panel");
    const profilePanel = createPanel("billing-profile-panel");
    const templatesPanel = createPanel("billing-templates-panel");
    const editorPanel = createPanel("billing-editor-panel");
    const listPanel = createPanel("billing-list-panel");
    container.append(overviewPanel, profilePanel, templatesPanel, editorPanel, listPanel);
    if (isAccountant()) renderPlatformAnnouncement(container);
    overviewPanel.innerHTML = "<p class=\"muted\">Chargement de l’espace devis, factures et rapports…</p>";
    [profilePanel, templatesPanel, editorPanel, listPanel].forEach(panel => panel.hidden = true);

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
    if (templateSection) {
        overviewPanel.hidden = true;
        editorPanel.hidden = true;
        listPanel.hidden = true;
        profilePanel.hidden = false;
        profilePanel.innerHTML = "";
        if (options.integratedOnly) renderProfile(profilePanel, { onlyType: templateSection, integratedOnly: true, onTemplateRendered: options.onTemplateRendered });
        else if (templateSection === "quote") renderQuoteTemplateSettings(profilePanel, billingData.profile, true, options.onTemplateRendered);
        else renderAdditionalDocumentTemplateSettings(profilePanel, billingData.profile, templateSection, true, options.onTemplateRendered);
        if (typeof options.onTemplateRendered === "function") await options.onTemplateRendered();
        return;
    }
    if (options.templates && isFullAdministrator()) {
        overviewPanel.hidden = true;
        profilePanel.hidden = true;
        editorPanel.hidden = true;
        listPanel.hidden = true;
        renderTemplates(templatesPanel);
        return;
    }
    if (options.newDocument) {
        activeDocument = createNewDocument(options.newDocument.type, options.newDocument.client, options.newDocument.appointmentId);
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
    if (isTechnician() && !appointmentId) {
        alert("Un technicien peut créer un devis ou une facture uniquement depuis l’intervention qui lui est attribuée.");
        return;
    }
    renderBilling({ newDocument: { type, client, appointmentId } });
}

export function viewBillingDocument(documentId) {
    if (!documentId) return;
    renderBilling({ documentId });
}

export async function synchronizeBillingDocuments(options = {}) {
    const isBillingScreen = Boolean(document.querySelector(".billing-list-panel:not([hidden])"));
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
    const usesExternalQuitusTemplate = canAccessQuitus() && usesExternalDocumentTemplate("quitus");
    const usesExternalReportTemplate = canAccessTechnicalReports() && usesExternalDocumentTemplate("report");
    panel.innerHTML = `
        <div class="billing-overview">
            <div class="billing-branding">
                ${profile.hasLogo ? '<img class="billing-logo-preview" src="/api/billing/logo" alt="Logo de votre structure">' : '<div class="billing-logo-placeholder">Votre logo</div>'}
                <div><p class="eyebrow">Espace commercial et technique</p><h2>${escapeHtml(profile.companyName || "Votre structure")}</h2></div>
            </div>
            <div class="billing-overview-actions">
                ${!isAccountant() ? '<button type="button" class="secondary-button" data-billing-action="new-quote">+ Nouveau devis</button>' : ""}
                ${usesExternalTemplate && !isAccountant() ? `<button type="button" class="secondary-button" data-billing-action="download-quote-template" ${profile.hasQuoteTemplate ? "" : "disabled"}>Télécharger le gabarit devis / facture</button>` : ""}
                ${usesExternalQuitusTemplate && !isAccountant() ? `<button type="button" class="secondary-button" data-billing-action="download-quitus-template" ${profile.hasQuitusTemplate ? "" : "disabled"}>Télécharger la base de quitus</button>` : ""}
                ${usesExternalReportTemplate && !isAccountant() ? `<button type="button" class="secondary-button" data-billing-action="download-report-template" ${profile.hasReportFileTemplate ? "" : "disabled"}>Télécharger la base de rapport</button>` : ""}
                <button type="button" class="secondary-button" data-billing-action="new-invoice">+ Nouvelle facture</button>
                ${isAccountant() || !canAccessTechnicalReports() ? "" : '<button type="button" class="secondary-button" data-billing-action="open-leak-reports">Rapports de fuite</button><button type="button" class="secondary-button" data-billing-action="new-leak-report">Nouveau rapport de recherche de fuite</button>'}
                ${isFullAdministrator() ? '<button type="button" class="secondary-button" data-billing-action="preview-blank-quote">Aperçu du devis vierge</button>' : ""}
                ${isFullAdministrator() ? '<button type="button" class="secondary-button" data-billing-action="manage-line-templates">Gérer les lignes et aides</button>' : ""}
                <button type="button" class="secondary-button" data-billing-action="open-purchases">Achats</button>
            </div>
        </div>
        <div class="billing-metrics"><span><strong>${quotes}</strong> devis</span><span><strong>${invoices}</strong> factures</span><span class="billing-base-template"><strong>✓</strong> ${usesExternalTemplate ? "gabarit PDF / DOCX externe" : "modèle Depann’Home intégré"}</span></div>
        ${renderBillingFinancialOverview(billingData.financialDashboard)}
        ${usesExternalTemplate && !profile.hasQuoteTemplate ? '<p class="auth-message error">Aucune base commune aux devis et factures n’est encore déposée. Un administrateur doit l’ajouter dans Paramètres → Modèles de documents.</p>' : ""}
        ${usesExternalQuitusTemplate && !profile.hasQuitusTemplate ? '<p class="auth-message error">Aucune base officielle de quitus n’est déposée.</p>' : ""}
        ${usesExternalReportTemplate && !profile.hasReportFileTemplate ? '<p class="auth-message error">Aucune base officielle de rapport n’est déposée.</p>' : ""}
    `;
    panel.querySelector("[data-billing-action=new-quote]")?.toggleAttribute("hidden", isAccountant());
    panel.querySelector("[data-billing-action=new-invoice]").hidden = isAccountant();
    panel.querySelector("[data-billing-action=new-quote]")?.addEventListener("click", () => { if (!isAccountant()) openNewDocument("quote"); });
    panel.querySelector("[data-billing-action=new-invoice]").addEventListener("click", () => { if (!isAccountant()) openNewDocument("invoice"); });
    panel.querySelector("[data-billing-action=open-leak-reports]")?.addEventListener("click", async () => {
        const { renderLeakReportWizard } = await import("./leak-report-wizard.js?v=34");
        renderLeakReportWizard();
    });
    panel.querySelector("[data-billing-action=new-leak-report]")?.addEventListener("click", async () => {
        const { openLeakReportCreation } = await import("./leak-report-wizard.js?v=34");
        openLeakReportCreation();
    });
    panel.querySelector("[data-billing-action=download-quote-template]")?.addEventListener("click", openQuoteTemplateDownload);
    panel.querySelector("[data-billing-action=download-quitus-template]")?.addEventListener("click", () => openDocumentTemplateDownload("quitus"));
    panel.querySelector("[data-billing-action=download-report-template]")?.addEventListener("click", () => openDocumentTemplateDownload("report"));
    panel.querySelector("[data-billing-action=preview-blank-quote]")?.addEventListener("click", openBlankQuotePreview);
    panel.querySelector("[data-billing-action=manage-line-templates]")?.addEventListener("click", () => renderBilling({ templates: true }));
    panel.querySelector("[data-billing-action=open-purchases]")?.addEventListener("click", async () => {
        const { renderPurchases } = await import("./purchases.js?v=118");
        renderPurchases();
    });
}

function renderBillingFinancialOverview(value = {}) {
    const data = { turnoverHt: 0, creditsHt: 0, purchasesHt: 0, grossProfitEstimateHt: 0, collected: 0, outstanding: 0, invoicesCount: 0, creditsCount: 0, ...value };
    const marginIsNegative = Number(data.grossProfitEstimateHt) < 0;
    const segments = [
        { label: "Chiffre d’affaires net HT", value: Math.max(0, Number(data.turnoverHt) || 0), color: "#003b73" },
        { label: "Avoirs HT", value: Math.max(0, Number(data.creditsHt) || 0), color: "#dc2626" },
        { label: "Achats HT", value: Math.max(0, Number(data.purchasesHt) || 0), color: "#f59e0b" },
        { label: marginIsNegative ? "Marge négative estimée" : "Marge brute estimée HT", value: Math.abs(Number(data.grossProfitEstimateHt) || 0), color: marginIsNegative ? "#7f1d1d" : "#16a34a" }
    ];
    const total = segments.reduce((sum, item) => sum + item.value, 0);
    let cursor = 0;
    const gradient = total > 0 ? `conic-gradient(${segments.filter(item => item.value > 0).map(item => { const start = cursor; cursor += item.value / total * 100; return `${item.color} ${start.toFixed(2)}% ${cursor.toFixed(2)}%`; }).join(",")})` : "conic-gradient(#e2e8f0 0 100%)";
    return `<section class="billing-financial-dashboard"><div class="billing-financial-heading"><div><p class="eyebrow">Pilotage financier</p><h3>Chiffre d’affaires, avoirs et marge</h3><p class="muted">Vue comparative des factures émises. La marge brute estimée correspond au chiffre d’affaires HT, diminué des avoirs et des achats HT enregistrés.</p></div></div><div class="billing-financial-layout"><figure class="billing-financial-chart"><div class="billing-donut" style="--billing-chart:${gradient}" role="img" aria-label="Répartition comparative du chiffre d’affaires, des avoirs, des achats et de la marge"><span><strong>${formatMoney(data.turnoverHt)}</strong><small>CA net HT</small></span></div><figcaption>${segments.map(item => `<span><i style="--segment-color:${item.color}"></i><span>${escapeHtml(item.label)}</span><strong>${formatMoney(item.value)}</strong></span>`).join("")}</figcaption></figure><div class="billing-financial-cards"><article><span>Chiffre d’affaires net HT</span><strong>${formatMoney(data.turnoverHt)}</strong><small>${Number(data.invoicesCount) || 0} facture(s) émise(s)</small></article><article class="credits"><span>Avoirs HT</span><strong>${formatMoney(data.creditsHt)}</strong><small>${Number(data.creditsCount) || 0} avoir(s)</small></article><article><span>Encaissements TTC</span><strong>${formatMoney(data.collected)}</strong><small>Règlements enregistrés</small></article><article class="${Number(data.outstanding) > 0 ? "attention" : ""}"><span>Reste à encaisser TTC</span><strong>${formatMoney(data.outstanding)}</strong><small>Factures non soldées</small></article><article><span>Achats enregistrés HT</span><strong>${formatMoney(data.purchasesHt)}</strong><small>Charges saisies dans Achats</small></article><article class="${marginIsNegative ? "negative" : "profit"}"><span>Marge brute estimée HT</span><strong>${formatMoney(data.grossProfitEstimateHt)}</strong><small>Estimation avant salaires, cotisations et autres charges</small></article></div></div></section>`;
}

function renderProfile(panel, options = {}) {
    panel.hidden = false;
    const profile = billingData.profile;
    panel.innerHTML = `
        ${options.onlyType ? `<section class="integrated-template-choice"><div><p class="eyebrow">Modèle Depann’Home Pro</p><h2>Informations et présentation intégrées</h2><p class="muted">Enregistrez vos informations et votre logo, puis activez ce modèle pour remplacer toute base personnalisée active.</p></div><div class="calendar-form-actions"><button type="button" class="secondary-button" data-activate-integrated>Utiliser ce modèle intégré</button><button type="button" class="secondary-button" data-open-custom-template>Importer / configurer ma propre base</button></div><p class="auth-message" data-integrated-message></p></section>` : ""}
        <form id="billingProfileForm" class="client-form" enctype="multipart/form-data">
            <div class="form-heading"><div><p class="eyebrow">Informations entreprise</p><h2>Coordonnées, mentions et logo</h2><p class="muted">Ces informations sont reprises sur vos devis et factures. Le modèle du document reste inchangé.</p></div><button type="button" class="secondary-button" id="closeBillingProfile">Fermer</button></div>
            <div class="form-grid">
                <label>Nom de la structure<input name="companyName" maxlength="160" placeholder="Ex. Dépann’Home Services" value="${escapeHtml(profile.companyName)}"></label>
                <label>Forme juridique / activité<input name="legalForm" maxlength="100" placeholder="Ex. SASU – dépannage à domicile" value="${escapeHtml(profile.legalForm)}"></label>
                <label class="form-wide">Adresse<input name="address" maxlength="255" value="${escapeHtml(profile.address)}"></label>
                <label>Code postal<input name="postalCode" maxlength="20" value="${escapeHtml(profile.postalCode)}"></label>
                <label>Ville<input name="city" maxlength="100" value="${escapeHtml(profile.city)}"></label>
                <label>Téléphone principal<input name="phone" maxlength="50" value="${escapeHtml(profile.phone)}"></label>
                <label>Téléphone secondaire<input name="secondaryPhone" maxlength="50" value="${escapeHtml(profile.secondaryPhone || "")}"></label>
                <label>E-mail<input name="email" type="email" maxlength="160" value="${escapeHtml(profile.email)}"></label>
                <label>Pays<input name="country" maxlength="100" value="${escapeHtml(profile.country || "France")}"></label>
                <label>Immatriculation / SIRET<input name="registrationNumber" maxlength="100" value="${escapeHtml(profile.registrationNumber)}"></label>
                <label>SIREN<input name="siren" maxlength="20" value="${escapeHtml(profile.siren || "")}"></label>
                <label>Régime de TVA<select name="vatRegime"><option value="standard" ${profile.vatRegime !== "franchise" ? "selected" : ""}>Assujetti à la TVA</option><option value="franchise" ${profile.vatRegime === "franchise" ? "selected" : ""}>Non assujetti / Franchise en base</option></select></label>
                <label>N° TVA intracommunautaire<input name="taxNumber" maxlength="100" value="${escapeHtml(profile.taxNumber)}" placeholder="Ex. FR12345678901"></label>
                <p class="muted form-wide" data-vat-regime-notice></p>
                <label>IBAN<input name="bankIban" maxlength="80" value="${escapeHtml(profile.bankIban || "")}"></label>
                <label>BIC<input name="bankBic" maxlength="40" value="${escapeHtml(profile.bankBic || "")}"></label>
                <label>Acompte / condition de devis<input name="depositTerms" maxlength="500" placeholder="Ex. Acompte de 30 % à la commande" value="${escapeHtml(profile.depositTerms || "")}"></label>
                <label class="form-wide">Conditions de règlement<input name="paymentTerms" maxlength="500" placeholder="Ex. Paiement à réception par virement ou chèque" value="${escapeHtml(profile.paymentTerms)}"></label>
                <label class="form-wide">Escompte pour paiement anticipé<input name="earlyPaymentDiscountTerms" maxlength="500" value="${escapeHtml(profile.earlyPaymentDiscountTerms || "Aucun escompte pour paiement anticipé.")}"></label>
                <label class="form-wide">Pénalités de retard<textarea name="latePaymentPenaltyTerms" rows="2" maxlength="1000">${escapeHtml(profile.latePaymentPenaltyTerms || "Pénalités de retard exigibles au taux de trois fois le taux d’intérêt légal à compter du jour suivant la date d’échéance.")}</textarea></label>
                <label>Indemnité de recouvrement (centimes)<input name="recoveryIndemnityCents" type="number" min="0" step="1" value="${escapeHtml(profile.recoveryIndemnityCents ?? 4000)}"><small>40 € = 4000 centimes</small></label>
                <label class="billing-accounting-option"><input name="vatOnDebits" type="checkbox" ${profile.vatOnDebits ? "checked" : ""}> TVA acquittée sur les débits</label>
                <label class="form-wide">Mention de bas de page<textarea name="footerNote" rows="2" maxlength="1000" placeholder="Mentions légales, pénalités de retard, assurance…">${escapeHtml(profile.footerNote)}</textarea></label>
                <label>Logo (PNG, JPEG ou WebP, 2 Mo maximum)<input name="logo" type="file" accept="image/png,image/jpeg,image/webp"></label>
                ${profile.hasLogo ? '<label class="billing-remove-logo"><input name="removeLogo" type="checkbox" value="true"> Supprimer le logo actuel</label>' : ""}
            </div>
            <p id="billingProfileMessage" class="auth-message" aria-live="polite"></p>
            <div class="form-actions"><button type="submit" class="secondary-button">Enregistrer les paramètres</button></div>
        </form>
    `;
    panel.querySelector("#closeBillingProfile").addEventListener("click", () => { panel.hidden = true; });
    panel.querySelector("[data-activate-integrated]")?.addEventListener("click", async event => {
        const button = event.currentTarget; const feedback = panel.querySelector("[data-integrated-message]"); button.disabled = true; feedback.textContent = "Activation…"; feedback.classList.remove("error");
        const result = await apiRequest(`/api/document-templates/${options.onlyType}/native`, { method: "POST", body: "{}" });
        feedback.textContent = result.ok ? "Le modèle Depann’Home Pro intégré est maintenant actif." : result.message || "Activation impossible."; feedback.classList.toggle("error", !result.ok); button.disabled = false;
    });
    panel.querySelector("[data-open-custom-template]")?.addEventListener("click", () => window.dispatchEvent(new CustomEvent("depannhome:open-document-template", { detail: { type: options.onlyType } })));
    bindVatRegimeForm(panel.querySelector("#billingProfileForm"));
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
        renderBilling(options.onlyType ? { profile: true, templateSection: options.onlyType, integratedOnly: true, onTemplateRendered: options.onTemplateRendered } : {});
    });
    if (options.onlyType === "quote") renderQuoteTemplateSettings(panel, profile, true, options.onTemplateRendered, true);
    else if (options.onlyType === "quitus" && canAccessQuitus()) renderAdditionalDocumentTemplateSettings(panel, profile, "quitus", true, options.onTemplateRendered, true);
    else if (!options.onlyType) {
        renderQuoteTemplateSettings(panel, profile);
        if (canAccessQuitus()) renderAdditionalDocumentTemplateSettings(panel, profile, "quitus");
        if (canAccessTechnicalReports()) renderAdditionalDocumentTemplateSettings(panel, profile, "report");
    }
}

function renderQuoteTemplateSettings(panel, profile, focused = false, onTemplateRendered = null, integratedOnly = false) {
    const policy = profile.quoteTemplatePolicy || "company_choice";
    const mode = policy === "integrated_only" ? "integrated" : policy === "external_only" ? "external" : profile.quoteTemplateMode || "integrated";
    const canChooseMode = policy === "company_choice";
    const canUseExternalTemplate = policy !== "integrated_only";
    const canPreview = mode === "integrated" || profile.hasQuoteTemplate;
    const policyMessage = policy === "integrated_only"
        ? "Le Créateur a imposé le modèle Depann’Home intégré aux devis et factures de cette entreprise."
        : policy === "external_only"
            ? "Le Créateur a imposé une base externe commune aux devis et factures. Déposez un fichier avant de créer ces documents."
            : "Votre entreprise peut utiliser le modèle intégré ou sa propre base commune aux devis et factures.";
    panel.insertAdjacentHTML("beforeend", `
        <section class="billing-quote-template-settings">
            <div class="form-heading"><div><p class="eyebrow">Base des devis et factures</p><h2>${integratedOnly ? "Personnaliser le modèle Depann’Home Pro intégré" : "Modèle commun intégré ou fichier entreprise"}</h2><p class="muted">${integratedOnly ? "Votre logo, vos informations, vos couleurs et vos textes sont appliqués au devis ; la facture reprend automatiquement cette présentation." : `${escapeHtml(policyMessage)} Toute facture reprend automatiquement cette présentation et cette base.`}</p></div><div class="calendar-form-actions"><button type="button" class="secondary-button" id="previewQuoteTemplate">Aperçu du devis</button><button type="button" class="secondary-button" id="previewInvoiceTemplate">Aperçu de la facture</button>${!integratedOnly && profile.hasQuoteTemplate && canUseExternalTemplate ? '<button type="button" class="secondary-button" id="downloadQuoteTemplate">Télécharger la base actuelle</button>' : ""}</div></div>
            <form id="quoteTemplateForm" class="client-form" enctype="multipart/form-data">
                <div class="form-grid">
                    ${integratedOnly ? '<input name="quoteTemplateMode" type="hidden" value="integrated">' : `<label>Base utilisée<select name="quoteTemplateMode" ${canChooseMode ? "" : "disabled"}><option value="integrated" ${mode === "integrated" ? "selected" : ""}>Modèle Depann’Home intégré</option><option value="external" ${mode === "external" ? "selected" : ""}>Gabarit PDF / DOCX de l’entreprise</option></select></label><label>Déposer ou remplacer le gabarit (PDF ou DOCX · 10 Mo max)<input name="quoteTemplate" type="file" accept="application/pdf,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx" ${canUseExternalTemplate ? "" : "disabled"}></label>${profile.hasQuoteTemplate && canUseExternalTemplate ? '<label class="billing-remove-logo"><input name="removeQuoteTemplate" type="checkbox" value="true"> Supprimer la base déposée</label>' : ""}${externalTemplateFieldsHelp("quote")}`}
                    ${integratedTemplateFields(profile.quoteTemplateConfig, "devis et facture")}
                </div>
                ${!integratedOnly && profile.hasQuoteTemplate ? `<p class="muted">Fichier actuel : ${escapeHtml(profile.quoteTemplateFilename || "base-devis")}</p>` : ""}
                <p id="quoteTemplateMessage" class="auth-message" aria-live="polite"></p>
                <div class="form-actions"><button type="submit" class="secondary-button">Enregistrer le modèle intégré</button></div>
            </form>
        </section>
    `);
    panel.querySelector("#downloadQuoteTemplate")?.addEventListener("click", openQuoteTemplateDownload);
    panel.querySelector("#previewQuoteTemplate")?.addEventListener("click", () => openQuoteTemplatePreview("quote"));
    panel.querySelector("#previewInvoiceTemplate")?.addEventListener("click", () => openQuoteTemplatePreview("invoice"));
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
            message.textContent = result.message || "Impossible d’enregistrer la base commune aux devis et factures.";
            message.classList.add("error");
            submit.disabled = false;
            return;
        }
        renderBilling(focused ? { profile: true, templateSection: "quote", integratedOnly, onTemplateRendered } : {});
    });
}

function renderAdditionalDocumentTemplateSettings(panel, profile, type, focused = false, onTemplateRendered = null, integratedOnly = false) {
    const definition = type === "quitus"
            ? { label: "quitus", title: "Base officielle de quitus", policy: profile.quitusTemplatePolicy, mode: profile.quitusTemplateMode, hasTemplate: profile.hasQuitusTemplate, filename: profile.quitusTemplateFilename }
            : { label: "rapport", title: "Base officielle de rapport", policy: profile.reportTemplatePolicy, mode: profile.reportFileTemplateMode, hasTemplate: profile.hasReportFileTemplate, filename: profile.reportFileTemplateFilename };
    if (integratedOnly) {
        panel.insertAdjacentHTML("beforeend", `<section class="billing-quote-template-settings" id="${type}TemplateSettings"><div class="form-heading"><div><p class="eyebrow">Modèle intégré</p><h2>Personnaliser le ${definition.label} Depann’Home Pro</h2><p class="muted">Votre logo et vos coordonnées ci-dessus, ainsi que les couleurs et textes ci-dessous, sont appliqués au document intégré.</p></div><button type="button" class="secondary-button" data-preview-template="${type}">Aperçu du document</button></div><form class="client-form" data-document-template-form="${type}"><input name="templateMode" type="hidden" value="integrated"><div class="form-grid">${type === "quitus" ? integratedTemplateFields(profile.quitusTemplate, "quitus") : ""}</div><p class="auth-message" aria-live="polite"></p><div class="form-actions"><button type="submit" class="secondary-button">Enregistrer le modèle intégré</button></div></form></section>`);
        panel.querySelector(`[data-preview-template="${type}"]`)?.addEventListener("click", () => openDocumentTemplatePreview(type));
        panel.querySelector(`[data-document-template-form="${type}"]`).addEventListener("submit", async event => {
            event.preventDefault(); const form = event.currentTarget; const feedback = form.querySelector(".auth-message"); const submit = form.querySelector('button[type="submit"]');
            submit.disabled = true; feedback.textContent = "Enregistrement…"; feedback.classList.remove("error");
            const result = await apiRequest(`/api/billing/document-templates/${type}`, { method: "PUT", body: new FormData(form) });
            if (!result.ok) { feedback.textContent = result.message || `Impossible d’enregistrer le modèle intégré de ${definition.label}.`; feedback.classList.add("error"); submit.disabled = false; return; }
            renderBilling({ profile: true, templateSection: type, integratedOnly: true, onTemplateRendered });
        });
        return;
    }
        const policy = definition.policy || "company_choice";
        const mode = policy === "integrated_only" ? "integrated" : policy === "external_only" ? "external" : definition.mode || "integrated";
        const canChoose = policy === "company_choice";
        const canUseExternal = policy !== "integrated_only";
        const message = policy === "integrated_only" ? "Le Créateur autorise uniquement le modèle intégré." : policy === "external_only" ? `Le Créateur impose une base externe de ${definition.label}.` : `Votre entreprise choisit entre le modèle intégré et sa propre base de ${definition.label}.`;
        const canPreview = mode === "integrated" || definition.hasTemplate;
        panel.insertAdjacentHTML("beforeend", `<section class="billing-quote-template-settings" id="${type}TemplateSettings"><div class="form-heading"><div><p class="eyebrow">Documents officiels</p><h2>${definition.title}</h2><p class="muted">${escapeHtml(message)} Le gabarit externe sélectionné est fusionné avec les données puis utilisé pour l’aperçu, l’archive, le téléchargement et le partage.</p></div><div class="calendar-form-actions"><button type="button" class="secondary-button" data-preview-template="${type}" ${canPreview ? "" : "disabled"}>Aperçu du document</button>${definition.hasTemplate && canUseExternal ? `<button type="button" class="secondary-button" data-download-template="${type}">Télécharger le gabarit d’origine</button>` : ""}</div></div><form class="client-form" data-document-template-form="${type}" enctype="multipart/form-data"><div class="form-grid"><label>Base utilisée<select name="templateMode" ${canChoose ? "" : "disabled"}><option value="integrated" ${mode === "integrated" ? "selected" : ""}>Modèle Depann’Home intégré</option><option value="external" ${mode === "external" ? "selected" : ""}>Gabarit PDF / DOCX officiel de l’entreprise</option></select></label><label>Déposer ou remplacer le gabarit (PDF ou DOCX · 10 Mo max)<input name="documentTemplate" type="file" accept="application/pdf,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx" ${canUseExternal ? "" : "disabled"}></label>${definition.hasTemplate && canUseExternal ? '<label class="billing-remove-logo"><input name="removeTemplate" type="checkbox" value="true"> Supprimer la base déposée</label>' : ""}${externalTemplateFieldsHelp(type)}${type === "quitus" ? integratedTemplateFields(profile.quitusTemplate, "quitus") : ""}</div>${definition.hasTemplate ? `<p class="muted">Gabarit officiel actuel : ${escapeHtml(definition.filename || `base-${definition.label}`)}</p>` : ""}<p class="auth-message" aria-live="polite"></p><div class="form-actions"><button type="submit" class="secondary-button">Enregistrer le modèle de ${definition.label}</button></div></form></section>`);
    panel.querySelector(`[data-preview-template="${type}"]`)?.addEventListener("click", () => openDocumentTemplatePreview(type));
    panel.querySelector(`[data-download-template="${type}"]`)?.addEventListener("click", () => openDocumentTemplateDownload(type));
    panel.querySelector(`[data-document-template-form="${type}"]`).addEventListener("submit", async event => { event.preventDefault(); const form = event.currentTarget; const feedback = form.querySelector(".auth-message"); const submit = form.querySelector('button[type="submit"]'); submit.disabled = true; feedback.textContent = "Enregistrement…"; feedback.classList.remove("error"); const result = await apiRequest(`/api/billing/document-templates/${type}`, { method: "PUT", body: new FormData(form) }); if (!result.ok) { feedback.textContent = result.message || `Impossible d’enregistrer la base de ${definition.label}.`; feedback.classList.add("error"); submit.disabled = false; return; } renderBilling(focused ? { profile: true, templateSection: type, onTemplateRendered } : { profile: true }); });
}

function integratedTemplateFields(value, label) {
    const defaults = { primaryColor: label === "quitus" ? "#003b73" : "#172033", secondaryColor: "#0a5c36", separatorColor: "#d7dde3", font: "Helvetica", headerText: "", footerText: "" };
    const template = { ...defaults, ...(value || {}) };
    return `<fieldset class="form-wide document-template-design"><legend>Présentation du modèle intégré de ${escapeHtml(label)}</legend><p class="muted form-wide">Ces réglages sont visibles dans chaque aperçu PDF concerné.</p><label>Couleur principale<input name="primaryColor" type="color" value="${escapeHtml(template.primaryColor)}"></label><label>Couleur secondaire<input name="secondaryColor" type="color" value="${escapeHtml(template.secondaryColor)}"></label><label>Couleur des séparateurs<input name="separatorColor" type="color" value="${escapeHtml(template.separatorColor)}"></label><label>Police<select name="font"><option value="Helvetica" ${template.font === "Helvetica" ? "selected" : ""}>Helvetica</option><option value="Times-Roman" ${template.font === "Times-Roman" ? "selected" : ""}>Times</option><option value="Courier" ${template.font === "Courier" ? "selected" : ""}>Courier</option></select></label><label class="form-wide">Texte d’en-tête<textarea name="headerText" rows="2" maxlength="500" placeholder="Texte facultatif propre au ${escapeHtml(label)}">${escapeHtml(template.headerText)}</textarea></label><label class="form-wide">Texte de pied de page<textarea name="footerText" rows="2" maxlength="500" placeholder="Texte facultatif propre au ${escapeHtml(label)}">${escapeHtml(template.footerText)}</textarea></label></fieldset>`;
}

function externalTemplateFieldsHelp(type) {
    const fields = type === "quote"
        ? ["type_document", "numero", "date", "echeance", "client_nom", "client_adresse", "client_siren", "client_tva", "adresse_livraison", "date_prestation", "reference_commande", "categorie_operation", "entreprise_nom", "lignes", "total_ht", "total_tva", "total_ttc", "conditions"]
        : type === "quitus"
            ? ["numero_intervention", "intervention", "date", "client_nom", "adresse_intervention", "observations", "signataire", "validation", "texte_entete", "texte_pied_page", "entreprise_nom"]
            : ["numero_rapport", "titre", "date", "client_nom", "client_adresse", "technicien", "entreprise_nom", "contenu"];
    return `<details class="form-wide document-template-fields"><summary>Champs automatiques du gabarit entreprise</summary><p class="muted">Dans un DOCX, insérez les repères avec deux accolades, par exemple <code>{{client_nom}}</code>. Dans un PDF remplissable, donnez ces noms aux champs. Un PDF visuel sans champs reste intact et précède les pages métier utilisant vos couleurs, afin d’éviter tout chevauchement.</p><div>${fields.map(field => `<code>{{${field}}}</code>`).join(" ")}</div></details>`;
}

function renderTemplates(panel) {
    panel.hidden = false;
    panel.innerHTML = `
        <div class="form-heading"><div><p class="eyebrow">Configuration commerciale</p><h2>Éléments réutilisables des devis et factures</h2><p class="muted">Gérez au même endroit vos prestations, fournitures, primes et aides financières.</p></div><button type="button" class="secondary-button" id="closeBillingTemplates">Fermer</button></div>
        <div class="form-heading"><div><p class="eyebrow">Lignes préenregistrées</p><h3>Vos prestations et fournitures</h3></div></div>
        <form id="billingTemplateForm" class="form-grid billing-template-form">
            <label>Libellé *<input name="label" maxlength="160" required placeholder="Ex. Déplacement et diagnostic"></label>
            <label>Prix unitaire HT *<input name="unitPrice" type="number" min="0" step="0.01" required placeholder="0,00"></label>
            <label>Description<textarea name="description" rows="2" maxlength="500" placeholder="Détail de la prestation"></textarea></label>
            <label>Unité<input name="unit" maxlength="40" value="unité" placeholder="heure, forfait, pièce…"></label>
            <label>TVA %<input name="vatRate" type="number" min="0" max="100" step="0.01" value="${isVatFranchise() ? 0 : 20}" ${isVatFranchise() ? "readonly" : ""}></label>
            ${isVatFranchise() ? `<p class="muted form-wide">${VAT_FRANCHISE_MENTION}</p>` : ""}
            <div class="form-actions"><button type="submit" class="secondary-button">Ajouter la ligne</button></div>
        </form>
        <p id="billingTemplateMessage" class="auth-message" aria-live="polite"></p>
        <div class="billing-template-list" id="billingTemplateList"></div>
        <section class="billing-aids-management" id="billingAidsManagement"></section>
    `;
    const list = panel.querySelector("#billingTemplateList");
    panel.querySelector("#closeBillingTemplates").addEventListener("click", () => renderBilling());
    if (!billingData.templates.length) list.innerHTML = "<p class=\"muted\">Aucune ligne préenregistrée pour le moment.</p>";
    billingData.templates.forEach(template => {
        const item = document.createElement("article");
        item.className = "billing-template-item";
        item.innerHTML = `<div><strong>${escapeHtml(template.label)}</strong><p>${escapeHtml(template.description || template.unit)}</p><small>${formatMoney(template.unitPrice)} HT · TVA ${formatNumber(isVatFranchise() ? 0 : template.vatRate)} %</small></div><button type="button" class="danger-button" aria-label="Supprimer ${escapeHtml(template.label)}">Supprimer</button>`;
        item.querySelector("button").addEventListener("click", async () => {
            if (!confirm(`Supprimer la ligne « ${template.label} » ?`)) return;
            const result = await apiRequest(`/api/billing/templates/${encodeURIComponent(template.id)}`, { method: "DELETE" });
            if (!result.ok) alert(result.message || "Suppression impossible.");
            else renderBilling({ templates: true });
        });
        list.appendChild(item);
    });
    panel.querySelector("#billingTemplateForm").addEventListener("submit", async event => {
        event.preventDefault();
        const form = event.currentTarget;
        const message = panel.querySelector("#billingTemplateMessage");
        const result = await apiRequest("/api/billing/templates", { method: "POST", body: JSON.stringify(formDataToObject(new FormData(form))) });
        if (!result.ok) { message.textContent = result.message || "Impossible d’ajouter la ligne."; message.classList.add("error"); return; }
        renderBilling({ templates: true });
    });
    renderBillingAidsManagement(panel.querySelector("#billingAidsManagement"));
}

function renderBillingAidsManagement(node) {
    const aids = billingData.aids || [];
    node.innerHTML = `<div class="form-heading"><div><p class="eyebrow">Primes et aides</p><h3>Aides financières</h3><p class="muted">Ces aides sont proposées dans chaque devis et ne sont jamais appliquées automatiquement.</p></div></div><form id="billingAidForm" class="form-grid"><label>Nom *<input name="name" required maxlength="160" placeholder="Ex. Certificats d’Économies d’Énergie"></label><label>Type<select name="aidType">${Object.entries(AID_TYPES).map(([id, label]) => `<option value="${id}">${escapeHtml(label)}</option>`).join("")}</select></label><label>Calcul<select name="calculationMode"><option value="fixed">Montant fixe (€)</option><option value="percentage">Pourcentage (%)</option></select></label><label>Montant *<input name="amount" type="number" min="0" step="0.01" required></label><label class="form-wide">Description<textarea name="description" rows="2" maxlength="1000"></textarea></label><fieldset class="accounting-rules form-wide"><legend>Critères indicatifs</legend><label>Type de travaux<input name="workType" maxlength="120"></label><label>Matériel installé<input name="equipment" maxlength="120"></label><label>Catégorie client<input name="customerCategory" maxlength="120"></label><label>Localisation<input name="location" maxlength="120"></label></fieldset><div class="form-actions"><button class="secondary-button">Ajouter l’aide</button></div></form><div class="accounting-aid-list">${aids.map(aid => `<article><div><strong>${escapeHtml(aid.name)}</strong><p>${escapeHtml(AID_TYPES[aid.aidType] || "Autre aide")} · ${aid.calculationMode === "percentage" ? `${formatNumber(aid.amount)} %` : formatMoney(aid.amount)}</p><small>${escapeHtml(aid.description || "Sans description")}</small></div><button type="button" class="danger-button" data-delete-billing-aid="${aid.id}">Supprimer</button></article>`).join("") || '<p class="muted">Aucune aide configurée.</p>'}</div>`;
    node.querySelector("#billingAidForm").addEventListener("submit", async event => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const payload = { ...Object.fromEntries(form), rules: { workType: form.get("workType"), equipment: form.get("equipment"), customerCategory: form.get("customerCategory"), location: form.get("location") } };
        const result = await apiRequest("/api/accounting/aids", { method: "POST", body: JSON.stringify(payload) });
        if (!result.ok) return alert(result.message || "Ajout impossible.");
        renderBilling({ templates: true });
    });
    node.querySelectorAll("[data-delete-billing-aid]").forEach(button => button.addEventListener("click", async () => {
        if (!confirm("Supprimer cette aide ?")) return;
        const result = await apiRequest(`/api/accounting/aids/${button.dataset.deleteBillingAid}`, { method: "DELETE" });
        if (!result.ok) return alert(result.message || "Suppression impossible.");
        renderBilling({ templates: true });
    }));
}

function renderDocumentEditor(panel) {
    if (!activeDocument) { panel.hidden = true; panel.innerHTML = ""; return; }
    panel.hidden = false;
    const document = activeDocument;
    const isEditing = Boolean(document.id);
    const linkedInvoice = document.documentType === "quote" ? getInvoiceForQuote(document) : null;
    if (isEditing && (isAccountant() || document.documentType === "credit" || (document.documentType === "invoice" && document.issuedAt) || (isTechnician() && document.documentType !== "invoice"))) return renderReadOnlyDocument(panel, document);
    const clients = getSearchableClients().sort((a, b) => a.name.localeCompare(b.name, "fr"));
    const livePreview = globalThis.document.body.classList.contains("desktop-device") && ["quote", "invoice"].includes(document.documentType);
    panel.classList.toggle("billing-editor-live-active", livePreview);
    panel.innerHTML = `
        <div class="${livePreview ? "billing-document-workspace" : ""}"><section class="${livePreview ? "billing-document-writing" : ""}">
        <form id="billingDocumentForm" class="client-form">
            <div class="form-heading"><div><p class="eyebrow">${isEditing ? "Modification" : "Nouveau document"}</p><h2>${isEditing ? "Modifier le document" : `Créer un ${DOCUMENT_TYPES[document.documentType].toLowerCase()}`}</h2></div><div class="calendar-form-actions">${isEditing && document.documentType === "invoice" && !document.issuedAt && canIssueBillingInvoice(document) ? '<button type="button" class="secondary-button" id="issueBillingDocument">Émettre définitivement</button>' : ""}${isEditing && document.documentType === "quote" ? linkedInvoice ? `<button type="button" class="secondary-button" data-view-linked-invoice="${escapeHtml(linkedInvoice.id)}">Voir la facture</button>` : '<button type="button" class="secondary-button" id="createInvoiceFromQuote">Créer la facture</button>' : ""}<button type="button" class="secondary-button" id="cancelBillingDocument">Annuler</button></div></div>
            <div class="form-grid">
                ${isTechnician() ? `<input name="documentType" type="hidden" value="${escapeHtml(document.documentType)}"><p class="billing-quote-reference">Type : <strong>${escapeHtml(DOCUMENT_TYPES[document.documentType])}</strong></p>` : `<label>Type *<select name="documentType">${Object.entries(DOCUMENT_TYPES).filter(([id]) => id !== "credit").map(([id, label]) => `<option value="${id}" ${document.documentType === id ? "selected" : ""}>${label}</option>`).join("")}</select></label>`}
                ${document.documentType === "invoice" ? '<label>Numéro de facture<input name="documentNumber" readonly value="" placeholder="Attribué automatiquement à l’émission"><small>Le numéro fiscal définitif sera attribué par le serveur.</small></label>' : `<label>Numéro *<input name="documentNumber" maxlength="80" required placeholder="Ex. DEV-2026-001" value="${escapeHtml(document.documentNumber)}"></label>`}
                <input name="clientId" type="hidden" value="${escapeHtml(document.clientId || "")}">
                <input name="appointmentId" type="hidden" value="${escapeHtml(document.appointmentId || "")}">
                ${document.documentType === "invoice" ? `<input name="sourceQuoteId" type="hidden" value="${escapeHtml(document.sourceQuoteId || "")}"><p class="billing-quote-reference">${document.quoteReference ? `Référence devis : <strong>${escapeHtml(document.quoteReference)}</strong>` : "Facture sans devis associé"}</p>` : ""}
                <label>Catégorie client<select name="customerType">${CUSTOMER_TYPES.map(type => `<option ${document.customerType === type ? "selected" : ""}>${type}</option>`).join("")}</select></label>
                <label>Client / destinataire *<input name="customerName" list="billingClients" maxlength="160" required value="${escapeHtml(document.customerName)}"><datalist id="billingClients">${clients.map(client => `<option value="${escapeHtml(client.name)}">${escapeHtml([client.address, client.city].filter(Boolean).join(", "))}</option>`).join("")}</datalist></label>
                <label class="form-wide">Adresse de facturation<textarea name="customerAddress" rows="2" maxlength="500" placeholder="Adresse de facturation">${escapeHtml(document.customerAddress)}</textarea></label>
                <label>SIREN du client<input name="customerSiren" inputmode="numeric" maxlength="20" value="${escapeHtml(document.legalData.customerSiren)}"></label>
                <label>N° TVA du client<input name="customerVatNumber" maxlength="40" value="${escapeHtml(document.legalData.customerVatNumber)}"></label>
                <label class="form-wide">Adresse de livraison<textarea name="deliveryAddress" rows="2" maxlength="500" placeholder="Uniquement si différente de l’adresse de facturation">${escapeHtml(document.legalData.deliveryAddress)}</textarea></label>
                <label>Date de livraison / prestation<input name="serviceDate" type="date" value="${escapeHtml(document.legalData.serviceDate)}"></label>
                <label>Référence du bon de commande<input name="purchaseOrderReference" maxlength="80" value="${escapeHtml(document.legalData.purchaseOrderReference)}"></label>
                <label>Réf. intervention partenaire<input name="interventionReference" maxlength="160" value="${escapeHtml(document.legalData.interventionReference)}"></label>
                <label>Réf. dossier assureur<input name="insuranceDossier" maxlength="160" value="${escapeHtml(document.legalData.insuranceDossier)}"></label>
                <label>N° mandat<input name="mandateNumber" maxlength="160" value="${escapeHtml(document.legalData.mandateNumber)}"></label>
                <label>N° sinistre<input name="claimNumber" maxlength="160" value="${escapeHtml(document.legalData.claimNumber)}"></label>
                <label>N° sociétaire / assuré<input name="insuredNumber" maxlength="160" value="${escapeHtml(document.legalData.insuredNumber)}"></label>
                <label>Mandant / donneur d’ordre<input name="principal" maxlength="160" value="${escapeHtml(document.legalData.principal)}"></label>
                <label>Gestionnaire<input name="manager" maxlength="160" value="${escapeHtml(document.legalData.manager)}"></label>
                <label>Expert<input name="expert" maxlength="160" value="${escapeHtml(document.legalData.expert)}"></label>
                <label>Catégorie d’opération<select name="operationCategory"><option value="goods" ${document.legalData.operationCategory === "goods" ? "selected" : ""}>Livraison de biens</option><option value="services" ${document.legalData.operationCategory === "services" ? "selected" : ""}>Prestation de services</option><option value="mixed" ${document.legalData.operationCategory === "mixed" ? "selected" : ""}>Biens et services</option></select></label>
                <label>Date *<input name="issueDate" type="date" required value="${escapeHtml(document.issueDate)}"></label>
                <label>Échéance<input name="dueDate" type="date" value="${escapeHtml(document.dueDate || "")}"></label>
                ${document.documentType === "invoice" ? '<input name="status" type="hidden" value="draft"><p class="billing-quote-reference">Statut : <strong>Brouillon</strong></p>' : `<label>Statut<input name="status" maxlength="30" value="${escapeHtml(document.status || "draft")}" placeholder="Brouillon, envoyé, réglé…"></label>`}
            </div>
            <section class="billing-lines-section"><div class="form-heading"><div><p class="eyebrow">Prestations</p><h3>Lignes du document</h3>${document.vatRegime === "franchise" ? `<p class="muted"><strong>${VAT_FRANCHISE_MENTION}</strong> — TVA automatiquement fixée à 0 %.</p>` : ""}</div><button type="button" class="secondary-button" id="addBillingLine">+ Ligne libre</button></div><div id="billingLines" class="billing-lines"></div><div class="billing-totals" id="billingTotals"></div></section>
            ${!isAccountant() ? '<section class="billing-aids-section" id="billingAids"></section>' : ""}
            <label>Notes / conditions<textarea name="notes" rows="3" maxlength="2000" placeholder="Informations complémentaires, conditions, validité du devis…">${escapeHtml(document.notes)}</textarea></label>
            <p id="billingDocumentMessage" class="auth-message" aria-live="polite"></p>
            <div class="calendar-form-actions"><button type="submit" class="secondary-button">${isEditing ? "Enregistrer les modifications" : "Enregistrer le document"}</button></div>
        </form>
        </section>${livePreview ? '<section class="billing-document-live-preview" aria-label="Aperçu PDF en direct"><div class="billing-document-preview-heading"><strong>Aperçu PDF final en direct</strong><span data-billing-preview-state>Génération…</span></div><iframe title="Aperçu PDF en direct du devis ou de la facture"></iframe></section>' : ""}</div>
    `;
    const form = panel.querySelector("form");
    const linesNode = panel.querySelector("#billingLines");
    let queuePreview = () => {};
    const renderLines = () => {
        linesNode.innerHTML = "";
        document.lines.forEach((line, index) => linesNode.appendChild(createLineEditor(line, index, document, renderLines)));
        renderTotals(panel.querySelector("#billingTotals"), document.lines, document.financialData);
        queuePreview();
    };
    renderLines();
    renderDocumentAids(panel.querySelector("#billingAids"), document, renderLines);
    form.querySelector("#addBillingLine").addEventListener("click", () => { document.lines.push(emptyLine()); renderLines(); });
    form.querySelector("#cancelBillingDocument").addEventListener("click", () => { activeDocument = null; renderBilling(); });
    form.querySelector("#createInvoiceFromQuote")?.addEventListener("click", () => createInvoiceFromQuote(document));
    form.querySelector("#issueBillingDocument")?.addEventListener("click", () => issueBillingInvoice(document, clients, form));
    form.querySelector("[data-view-linked-invoice]")?.addEventListener("click", event => viewBillingDocument(event.currentTarget.dataset.viewLinkedInvoice));
    const customerInput = form.querySelector("[name=customerName]");
    customerInput.addEventListener("change", () => fillCustomerAddress(customerInput, form, clients));
    customerInput.addEventListener("input", () => fillCustomerAddress(customerInput, form, clients));
    const live = bindBillingDocumentPreview(panel, form, document);
    queuePreview = live.queue;
    billingPreviewCleanup = live.dispose;
    form.addEventListener("input", () => queuePreview());
    form.addEventListener("change", () => queuePreview());
    queuePreview(0);
    form.addEventListener("submit", async event => {
        event.preventDefault();
        const payload = billingDocumentPayload(form, document);
        const message = panel.querySelector("#billingDocumentMessage");
        const result = await apiRequest(isEditing ? `/api/billing/documents/${encodeURIComponent(document.id)}` : "/api/billing/documents", { method: isEditing ? "PUT" : "POST", body: JSON.stringify(payload) });
        if (!result.ok) { message.textContent = result.message || "Impossible d’enregistrer le document."; message.classList.add("error"); return; }
        const savedDocumentNumber = result.data?.documentNumber || document.documentNumber || payload.documentNumber;
        if (!isEditing) addClientActivityByName(payload.customerName, {
            type: payload.documentType,
            label: `${DOCUMENT_TYPES[payload.documentType]} créé`,
            detail: savedDocumentNumber,
            documentId: result.data?.id
        });
        billingPreviewCleanup();
        const savedDocumentId = result.data?.id || document.id;
        const associatedClient = clients.find(client => String(client.id) === String(payload.clientId || document.clientId || "")) || clients.find(client => normalizeText(client.name) === normalizeText(payload.customerName));
        activeDocument = null;
        if (payload.appointmentId) window.dispatchEvent(new CustomEvent("depannhome:billing-document-saved", { detail: { appointmentId: payload.appointmentId, suppressNavigation: true } }));
        if (payload.documentType === "invoice") {
            await renderBilling({ documentId: savedDocumentId });
            return;
        }
        if (associatedClient?.id) window.dispatchEvent(new CustomEvent("depannhome:open-client", { detail: { clientId: associatedClient.id } }));
        else renderBilling();
        openDocumentDeliveryChoice({
            label: `${DOCUMENT_TYPES[payload.documentType]} ${savedDocumentNumber}`,
            recipient: associatedClient?.email || "",
            printUrl: `/api/billing/documents/${encodeURIComponent(savedDocumentId)}/pdf`,
            sendEmail: async email => {
                const response = await fetch(`/api/billing/documents/${encodeURIComponent(savedDocumentId)}/email`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ recipient: email }) });
                const data = await response.json().catch(() => null);
                if (!response.ok) throw new Error(data?.message || "Envoi du document impossible.");
            }
        });
    });
}

function bindBillingDocumentPreview(panel, form, billingDocument) {
    const iframe = panel.querySelector(".billing-document-live-preview iframe");
    const state = panel.querySelector("[data-billing-preview-state]");
    if (!iframe || !state) return { queue: () => {}, dispose: () => {} };
    let timer = null;
    let request = null;
    let previewUrl = "";
    let sequence = 0;
    let disposed = false;
    const dispose = () => { if (disposed) return; disposed = true; clearTimeout(timer); request?.abort(); observer.disconnect(); if (previewUrl) URL.revokeObjectURL(previewUrl); };
    const refresh = async currentSequence => {
        if (disposed || !iframe.isConnected || currentSequence !== sequence) return;
        state.textContent = "Mise à jour…";
        request?.abort();
        request = new AbortController();
        const payload = { ...billingDocumentPayload(form, billingDocument), vatRegime: billingDocument.vatRegime, issuerTaxNumber: billingDocument.issuerTaxNumber, quoteReference: billingDocument.quoteReference || "" };
        try {
            const response = await fetch("/api/billing/documents/preview", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: request.signal });
            if (!response.ok) { const error = await response.json().catch(() => null); throw new Error(error?.message || "Aperçu PDF indisponible."); }
            const blob = await response.blob();
            if (disposed || currentSequence !== sequence) return;
            const nextUrl = URL.createObjectURL(blob);
            const previousUrl = previewUrl;
            previewUrl = nextUrl;
            iframe.src = nextUrl;
            if (previousUrl) iframe.addEventListener("load", () => URL.revokeObjectURL(previousUrl), { once: true });
            state.textContent = response.headers.get("X-Billing-Preview-Mode") === "business-pages" ? "Gabarit DOCX : aperçu des pages métier" : `Actualisé à ${new Intl.DateTimeFormat("fr-FR", { timeStyle: "short" }).format(new Date())}`;
        } catch (error) {
            if (error.name !== "AbortError" && !disposed && currentSequence === sequence) state.textContent = error.message || "Aperçu PDF indisponible.";
        }
    };
    const queue = (delay = 650) => { clearTimeout(timer); const currentSequence = ++sequence; timer = window.setTimeout(() => refresh(currentSequence), delay); };
    const observer = new MutationObserver(() => { if (!panel.isConnected) dispose(); });
    observer.observe(document.body, { childList: true, subtree: true });
    return { queue, dispose };
}

function renderReadOnlyDocument(panel, document) {
    const linkedInvoice = document.documentType === "quote" ? getInvoiceForQuote(document) : null;
    const canCorrect = document.documentType === "invoice" && document.issuedAt && document.status !== "cancelled" && !isAccountant() && !isTechnician();
    const payable = document.documentType === "invoice" ? calculateNetPayable(document.lines, document.financialData) : 0;
    const settled = Math.min(payable, Number(document.settledAmount) || 0);
    const remaining = Math.max(0, payable - settled);
    const paymentBlock = document.documentType === "invoice" && document.issuedAt ? `<section class="procedure-section billing-settlement-section"><h3>Règlement</h3><p><strong>${remaining <= 0.009 ? "Facture réglée" : settled > 0 ? "Facture partiellement réglée" : "Facture à encaisser"}</strong> · Réglé ${escapeHtml(formatMoney(settled))} · Solde ${escapeHtml(formatMoney(remaining))}${document.latestPaymentMethod ? ` · Dernier règlement : ${escapeHtml(document.latestPaymentMethod)} le ${escapeHtml(formatDate(document.latestPaymentDate))}` : ""}</p>${remaining > 0.009 && canRecordInvoiceSettlement(document) ? `<form class="form-grid" data-invoice-settlement><label>Montant reçu *<input name="amount" type="number" min="0.01" max="${remaining.toFixed(2)}" step="0.01" required value="${remaining.toFixed(2)}"></label><label>Mode de règlement *<select name="method" required>${PAYMENT_METHODS.map(method => `<option>${escapeHtml(method)}</option>`).join("")}</select></label><label>Date *<input name="date" type="date" required value="${today()}"></label><label>Référence<input name="reference" maxlength="160" placeholder="N° de chèque ou transaction"></label><label class="form-wide">Note<input name="notes" maxlength="1000" placeholder="Ex. Règlement reçu sur place"></label><div class="form-actions"><button class="primary-button">Enregistrer le règlement</button></div><p class="auth-message form-wide" data-settlement-message></p></form>` : ""}</section>` : "";
    panel.innerHTML = `
        <div class="billing-read-only-document">
            <div class="form-heading"><div><p class="eyebrow">Consultation uniquement</p><h2>${escapeHtml(DOCUMENT_TYPES[document.documentType])} ${escapeHtml(document.documentNumber)}</h2></div><div class="calendar-form-actions">${canCorrect ? '<button type="button" class="secondary-button" data-create-correction="replacement">Créer une facture rectificative</button><button type="button" class="secondary-button" data-create-correction="amendment">Créer un avenant</button>' : ""}${document.documentType === "quote" && (linkedInvoice || !isAccountant()) ? linkedInvoice ? `<button type="button" class="secondary-button" data-view-linked-invoice="${escapeHtml(linkedInvoice.id)}">Voir la facture</button>` : '<button type="button" class="secondary-button" id="createInvoiceFromQuote">Créer la facture</button>' : ""}<button type="button" class="secondary-button" id="closeBillingDocument">Fermer</button></div></div>
            ${document.issuedAt ? '<p class="auth-message">Cette facture a été émise définitivement et constitue désormais un enregistrement immuable. Toute modification doit passer par une facture rectificative, un avenant ou un avoir comptable.</p>' : ""}
            <div class="procedure-meta"><span>${escapeHtml(document.customerName)}</span><span>${escapeHtml(formatDate(document.issueDate))}</span><span>${escapeHtml(documentStatusLabel(document.status))}</span>${document.documentType === "invoice" ? `<span>${document.quoteReference ? `Réf. devis ${escapeHtml(document.quoteReference)}` : "Sans devis associé"}</span><span>${document.isAccounted ? `Comptabilisée le ${escapeHtml(formatDate(document.accountedAt))}` : "Non comptabilisée"}</span>${document.sentAt ? `<span>Envoyée le ${escapeHtml(formatDate(document.sentAt))}</span>` : ""}${document.correctionSourceNumber ? `<span>${escapeHtml(correctionKindLabel(document.correctionKind))} de ${escapeHtml(document.correctionSourceNumber)}</span>` : ""}` : ""}</div>
            <div class="billing-read-only-lines">${document.lines.map(line => `<div><span>${escapeHtml(line.description)}</span><strong>${escapeHtml(String(line.quantity))} × ${escapeHtml(formatMoney(line.unitPrice))}</strong><b>${escapeHtml(formatMoney(lineTotal(line)))}</b></div>`).join("")}</div>
            <div class="billing-totals" id="billingReadOnlyTotals"></div>
            ${paymentBlock}
            ${document.notes ? `<section class="procedure-section"><h3>Notes / conditions</h3><p>${escapeHtml(document.notes)}</p></section>` : ""}
        </div>`;
    renderTotals(panel.querySelector("#billingReadOnlyTotals"), document.lines, document.financialData);
    panel.querySelector("#closeBillingDocument").addEventListener("click", () => { activeDocument = null; renderBilling(); });
    panel.querySelector("#createInvoiceFromQuote")?.addEventListener("click", () => createInvoiceFromQuote(document));
    panel.querySelector("[data-view-linked-invoice]")?.addEventListener("click", event => viewBillingDocument(event.currentTarget.dataset.viewLinkedInvoice));
    panel.querySelectorAll("[data-create-correction]").forEach(button => button.addEventListener("click", () => createInvoiceCorrection(document, button.dataset.createCorrection)));
    panel.querySelector("[data-invoice-settlement]")?.addEventListener("submit", event => submitInvoiceSettlement(event, document));
}

async function submitInvoiceSettlement(event, document) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button");
    const feedback = form.querySelector("[data-settlement-message]");
    button.disabled = true;
    const result = await apiRequest(`/api/billing/documents/${encodeURIComponent(document.id)}/settlements`, { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    if (!result.ok) { button.disabled = false; feedback.textContent = result.message || "Règlement impossible."; feedback.classList.add("error"); return; }
    await renderBilling({ documentId: document.id });
}

async function createInvoiceCorrection(document, kind) {
    const label = kind === "amendment" ? "un avenant" : "une facture rectificative";
    if (!confirm(`Créer ${label} à partir de ${document.documentNumber} ? La facture d’origine sera conservée et considérée comme annulée.`)) return;
    const result = await apiRequest(`/api/billing/documents/${encodeURIComponent(document.id)}/corrections`, { method: "POST", body: JSON.stringify({ kind }) });
    if (!result.ok) { alert(result.message || "Impossible de créer la correction."); return; }
    await viewBillingDocument(result.data.id);
}

async function issueBillingInvoice(document, clients = [], form = null) {
    if (!document?.id || document.documentType !== "invoice") return;
    if (!confirm("Émettre définitivement cette facture ? Un numéro légal sera attribué et les données, le PDF et l’UBL deviendront immuables. Cette action est irréversible.")) return;
    if (form) {
        const saved = await apiRequest(`/api/billing/documents/${encodeURIComponent(document.id)}`, { method: "PUT", body: JSON.stringify(billingDocumentPayload(form, document)) });
        if (!saved.ok) return alert(saved.message || "Enregistrez un brouillon valide avant son émission définitive.");
    }
    const result = await apiRequest(`/api/billing/documents/${encodeURIComponent(document.id)}/issue`, { method: "POST", body: "{}" });
    if (!result.ok) return alert(result.message || "Émission définitive impossible.");
    const documentNumber = result.data?.documentNumber || document.documentNumber;
    const client = clients.find(item => String(item.id) === String(document.clientId || "")) || clients.find(item => normalizeText(item.name) === normalizeText(document.customerName));
    addClientActivityByName(document.customerName, { type: "invoice", label: "Facture émise", detail: documentNumber, documentId: document.id });
    await renderBilling({ documentId: document.id });
    openDocumentDeliveryChoice({
        label: `Facture ${documentNumber}`,
        recipient: client?.email || "",
        printUrl: `/api/billing/documents/${encodeURIComponent(document.id)}/pdf`,
        sendEmail: async email => {
            const response = await fetch(`/api/billing/documents/${encodeURIComponent(document.id)}/email`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ recipient: email }) });
            const data = await response.json().catch(() => null);
            if (!response.ok) throw new Error(data?.message || "Envoi de la facture impossible.");
        }
    });
}

function correctionKindLabel(kind) { return kind === "amendment" ? "Avenant" : kind === "replacement" ? "Facture rectificative" : "Correction"; }

function createLineEditor(line, index, billingDocument, rerender) {
    const item = document.createElement("article");
    item.className = "billing-line";
    item.innerHTML = `
        <select aria-label="Ligne préenregistrée"><option value="">Ligne libre</option>${billingData.templates.map(template => `<option value="${template.id}">${escapeHtml(template.label)}</option>`).join("")}</select>
        <input data-field="description" aria-label="Description" maxlength="500" placeholder="Description" value="${escapeHtml(line.description)}">
        <input data-field="quantity" aria-label="Quantité" type="number" min="0.001" step="0.001" value="${escapeHtml(line.quantity)}">
        <input data-field="unit" aria-label="Unité" maxlength="40" value="${escapeHtml(line.unit)}">
        <input data-field="unitPrice" aria-label="Prix unitaire HT" type="number" min="0" step="0.01" value="${escapeHtml(line.unitPrice)}">
        <input data-field="vatRate" aria-label="TVA" type="number" min="0" max="100" step="0.01" value="${escapeHtml(billingDocument.vatRegime === "franchise" ? 0 : line.vatRate)}" ${billingDocument.vatRegime === "franchise" ? "readonly title=\"TVA neutralisée par le régime Franchise en base\"" : ""}>
        <strong class="billing-line-total">${formatMoney(lineTotal(line))}</strong>
        ${canCreateSavedBillingLine() ? '<button type="button" class="secondary-button billing-line-save" data-save-billing-template>Préenregistrer</button>' : ""}
        <button type="button" class="danger-button" data-remove-billing-line aria-label="Supprimer la ligne">×</button>
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
        Object.assign(line, { description: template.description ? `${template.label} — ${template.description}` : template.label, unit: template.unit, unitPrice: Number(template.unitPrice), vatRate: billingDocument.vatRegime === "franchise" ? 0 : Number(template.vatRate) });
        rerender();
    });
    item.querySelector("[data-save-billing-template]")?.addEventListener("click", async event => {
        const description = String(line.description || "").trim();
        if (!description) return alert("Renseignez la description de la ligne avant de la préenregistrer.");
        const label = window.prompt("Nom de la ligne préenregistrée :", description.slice(0, 160));
        if (label === null) return;
        const normalizedLabel = label.trim();
        if (!normalizedLabel) return alert("Le nom de la ligne préenregistrée est obligatoire.");
        const button = event.currentTarget;
        button.disabled = true;
        const result = await apiRequest("/api/billing/templates", { method: "POST", body: JSON.stringify({
            label: normalizedLabel,
            description: normalizedLabel === description ? "" : description,
            unit: line.unit,
            unitPrice: line.unitPrice,
            vatRate: billingDocument.vatRegime === "franchise" ? 0 : line.vatRate
        }) });
        if (!result.ok) { button.disabled = false; return alert(result.message || "Impossible de préenregistrer cette ligne."); }
        if (result.data?.template) billingData.templates = [...billingData.templates, result.data.template].sort((first, second) => first.label.localeCompare(second.label, "fr"));
        alert(`La ligne « ${normalizedLabel} » est maintenant disponible dans les lignes préenregistrées.`);
        rerender();
    });
    item.querySelector("[data-remove-billing-line]").addEventListener("click", () => {
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
    const selectedAids = billingDocument.financialData.aids;
    const deductible = billingDocument.documentType === "invoice" ? (billingData.insuranceDeductibles || []).find(item => String(item.appointmentId) === String(billingDocument.appointmentId || "")) : null;
    const deductibleSelected = selectedAids.some(item => item.aidType === "insurance_deductible" && String(item.sourceAppointmentId) === String(billingDocument.appointmentId));
    const deductibleBlock = deductible ? `<fieldset class="accounting-aid-fieldset"><legend>Franchise assurance validée</legend><label><input type="checkbox" data-insurance-deductible ${deductibleSelected ? "checked" : ""} ${deductible.deductedDocumentId && !deductibleSelected ? "disabled" : ""}> Franchise client encaissée · − ${formatMoney(Number(deductible.amountCents) / 100)}</label><p class="muted">${escapeHtml([deductible.insurance, deductible.claimNumber ? `Sinistre ${deductible.claimNumber}` : "", `Intervention n°${deductible.appointmentId}`].filter(Boolean).join(" · "))}<br>Déduction réservée à la facture adressée exactement au donneur d’ordre <strong>${escapeHtml(deductible.principal)}</strong>.${deductible.deductedDocumentId && !deductibleSelected ? " Cette franchise figure déjà sur une facture émise." : ""}</p></fieldset>` : "";
    panel.innerHTML = `<div class="form-heading"><div><p class="eyebrow">Primes, aides et franchise</p><h3>Lignes déduites du net à payer</h3><p class="muted">Aucune déduction n’est ajoutée automatiquement. Chaque montant sélectionné reste visible sur le PDF.</p></div></div>${deductibleBlock}${aids.length ? `<fieldset class="accounting-aid-fieldset">${aids.map(aid => `<label><input type="checkbox" value="${escapeHtml(aid.id)}" ${selectedAids.some(item => item.aidType !== "insurance_deductible" && item.name === aid.name) ? "checked" : ""}> ${escapeHtml(aid.name)} · ${aid.calculationMode === "percentage" ? `${formatNumber(aid.amount)} %` : formatMoney(aid.amount)}</label>`).join("")}</fieldset>` : '<p class="muted">Aucune prime configurée. Ajoutez-les depuis « Gérer les lignes et aides ».</p>'}`;
    panel.querySelectorAll("input[type=checkbox]").forEach(input => input.addEventListener("change", () => {
        const configured = [...panel.querySelectorAll("input[value]:checked")].map(field => aids.find(aid => String(aid.id) === field.value)).filter(Boolean).map(toAidSnapshot);
        const insurance = deductible && panel.querySelector("[data-insurance-deductible]")?.checked ? [{ name: "Franchise client encaissée", amount: Number(deductible.amountCents) / 100, calculationMode: "fixed", aidType: "insurance_deductible", description: [deductible.insurance, deductible.claimNumber ? `Sinistre ${deductible.claimNumber}` : "", `Intervention n°${deductible.appointmentId}`].filter(Boolean).join(" · "), sourceAppointmentId: Number(deductible.appointmentId), sourceValidatedAt: deductible.validatedAt || "", principal: deductible.principal }] : [];
        billingDocument.financialData.aids = [...configured, ...insurance];
        rerender();
    }));
}

function toAidSnapshot(aid) { return { name: aid.name, amount: Number(aid.amount) || 0, calculationMode: aid.calculationMode === "percentage" ? "percentage" : "fixed", aidType: aid.aidType || "custom", description: aid.description || "", ...(aid.aidType === "insurance_deductible" ? { sourceAppointmentId: Number(aid.sourceAppointmentId) || 0, sourceValidatedAt: aid.sourceValidatedAt || "", principal: aid.principal || "" } : {}) }; }

function renderTotals(panel, lines, financialData = {}) {
    const totalHt = lines.reduce((total, line) => total + lineTotal(line), 0);
    const totalVat = lines.reduce((total, line) => total + lineTotal(line) * (Number(line.vatRate) || 0) / 100, 0);
    const totalTtc = totalHt + totalVat;
    const aidAmount = Math.min(totalTtc, (financialData.aids || []).reduce((total, aid) => total + (aid.calculationMode === "percentage" ? totalHt * Number(aid.amount || 0) / 100 : Number(aid.amount || 0)), 0));
    panel.innerHTML = `<span>Total HT <strong>${formatMoney(totalHt)}</strong></span><span>TVA <strong>${formatMoney(totalVat)}</strong></span><span>Total TTC <strong>${formatMoney(totalTtc)}</strong></span>${aidAmount ? `<span>Primes / aides / franchise <strong>− ${formatMoney(aidAmount)}</strong></span><span>Net à payer <strong>${formatMoney(Math.max(0, totalTtc - aidAmount))}</strong></span>` : ""}`;
}

function renderDocumentList(panel) {
    panel.hidden = false;
    const documents = billingData.documents || [];
    const quotes = documents.filter(document => document.documentType === "quote");
    const invoices = documents.filter(document => document.documentType === "invoice");
    const years = [...new Set(documents.map(document => String(document.issueDate || "").slice(0, 4)).filter(Boolean))].sort((first, second) => second.localeCompare(first));
    const invoicedTotal = invoices.filter(document => document.issuedAt).reduce((total, document) => total + calculateTotals(document.lines || []).ttc, 0);
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
            const accountingLabel = billingDocument.documentType === "invoice" ? (billingDocument.isAccounted ? `Comptabilisée le ${formatDate(billingDocument.accountedAt)}` : billingDocument.issuedAt ? "À comptabiliser" : "Brouillon non comptabilisable") : "Non concerné";
            const client = getSearchableClients().find(item => normalizeText(item.name) === normalizeText(billingDocument.customerName));
            const recipient = client?.email || "";
            item.innerHTML = `<div><p class="eyebrow">${billingDocument.correctionKind && billingDocument.correctionKind !== "none" ? escapeHtml(correctionKindLabel(billingDocument.correctionKind)) : DOCUMENT_TYPES[billingDocument.documentType]} · ${escapeHtml(billingDocument.customerType)}</p><h3>${escapeHtml(billingDocument.documentNumber)}</h3><p>${escapeHtml(billingDocument.customerName)}</p><small>${escapeHtml(formatDate(billingDocument.issueDate))} · ${escapeHtml(documentStatusLabel(billingDocument.status))}${billingDocument.isEmailSent ? " · Envoyée / immuable" : ""}${billingDocument.correctionSourceNumber ? ` · Corrige ${escapeHtml(billingDocument.correctionSourceNumber)}` : ""}${billingDocument.quoteReference ? ` · Réf. devis ${escapeHtml(billingDocument.quoteReference)}` : ""} · <span class="billing-accounting-status ${billingDocument.isAccounted ? "is-accounted" : ""}">${escapeHtml(accountingLabel)}</span></small></div><div class="billing-document-amount"><strong>${formatMoney(totals.ttc)}</strong><small>TTC</small></div><div class="billing-document-actions">${billingDocument.documentType === "invoice" && !isTechnician() && !isAccountant() ? `<button type="button" class="secondary-button" data-accounting="${billingDocument.isAccounted ? "false" : "true"}">${billingDocument.isAccounted ? "Décomptabiliser" : "Comptabiliser"}</button>` : ""}${billingDocument.documentType === "quote" && !isAccountant() ? linkedInvoice ? `<button type="button" class="secondary-button" data-view-linked-invoice="${escapeHtml(linkedInvoice.id)}">Voir la facture</button>` : '<button type="button" class="secondary-button" data-create-invoice>Créer la facture</button>' : ""}<button type="button" class="secondary-button" data-open-document>${isTechnician() || isAccountant() || billingDocument.isEmailSent ? "Consulter" : "Ouvrir"}</button><button type="button" class="secondary-button" data-pdf>PDF / Imprimer</button>${isAccountant() ? "" : `<button type="button" class="secondary-button" data-email ${recipient ? "" : "disabled title=\"Ajoutez l’e-mail du client dans sa fiche pour envoyer le document.\""}>Envoyer par e-mail</button>`}</div>`;
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
        documentNumber: "",
        clientId: quote.clientId || "",
        appointmentId: quote.appointmentId || "",
        sourceQuoteId: quote.id,
        quoteReference: quote.documentNumber,
        vatRegime: quote.vatRegime || billingData.profile.vatRegime || "standard",
        issuerTaxNumber: quote.issuerTaxNumber || billingData.profile.taxNumber || "",
        customerType: quote.customerType || "Particulier",
        customerName: quote.customerName || "",
        customerAddress: quote.customerAddress || "",
        legalData: normalizeLegalData(quote.legalData, quote.customerAddress || ""),
        issueDate: today(),
        dueDate: "",
        status: "draft",
        isAccounted: false,
        lines: (quote.lines || []).map(line => ({ ...emptyLine(), ...line, vatRate: (quote.vatRegime || billingData.profile.vatRegime) === "franchise" ? 0 : Number(line.vatRate) || 0 })),
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
        documentNumber: type === "invoice" ? "" : suggestNumber(type),
        clientId: client?.id || "",
        appointmentId,
        vatRegime: billingData.profile.vatRegime || "standard",
        issuerTaxNumber: billingData.profile.taxNumber || "",
        customerType: client ? getBillingCustomerType(client.type) : baseQuote?.customerType || "Particulier",
        customerName: client?.name || "",
        customerAddress: client ? [client.address, client.city].filter(Boolean).join(", ") : "",
        legalData: legalDataFromClient(client),
        issueDate: today(),
        dueDate: "",
        status: baseQuote?.status || "draft",
        isAccounted: false,
        lines: (baseQuote?.lines || [emptyLine()]).map(line => ({ ...line, vatRate: billingData.profile.vatRegime === "franchise" ? 0 : Number(line.vatRate) || 0 })),
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
    form.querySelector("[name=clientId]").value = client?.id || "";
    if (!client) return;
    const values = legalDataFromClient(client);
    if (values.billingAddress) form.querySelector("[name=customerAddress]").value = values.billingAddress;
    for (const field of ["customerSiren", "customerVatNumber", "deliveryAddress", "serviceDate", "purchaseOrderReference", "interventionReference", "insuranceDossier", "mandateNumber", "claimNumber", "insuredNumber", "principal", "manager", "expert", "operationCategory"]) {
        if (field === "operationCategory" && !client.operationCategory) continue;
        if (values[field] && form.elements[field]) form.elements[field].value = values[field];
    }
}

function emptyLine() { return { description: "", quantity: 1, unit: "unité", unitPrice: 0, vatRate: isVatFranchise() ? 0 : 20 }; }
function normalizeDocument(document) { const vatRegime = document.vatRegime || billingData?.profile?.vatRegime || "standard"; return { ...document, vatRegime, issuerTaxNumber: document.issuerTaxNumber || billingData?.profile?.taxNumber || "", clientId: document.clientId || "", appointmentId: document.appointmentId || "", sourceQuoteId: document.sourceQuoteId || "", correctionSourceId: document.correctionSourceId || "", correctionKind: document.correctionKind || "none", correctionSourceNumber: document.correctionSourceNumber || "", quoteReference: document.quoteReference || "", isEmailSent: Boolean(document.isEmailSent), isAccounted: Boolean(document.isAccounted), legalData: normalizeLegalData(document.legalData, document.customerAddress || ""), financialData: normalizeFinancialData(document.financialData), lines: Array.isArray(document.lines) && document.lines.length ? document.lines.map(line => ({ ...emptyLine(), ...line, vatRate: vatRegime === "franchise" ? 0 : Number(line.vatRate) || 0 })) : [emptyLine()] }; }
function normalizeLegalData(value, billingAddress = "") { return { customerSiren: value?.customerSiren || "", customerVatNumber: value?.customerVatNumber || "", billingAddress: value?.billingAddress || billingAddress, deliveryAddress: value?.deliveryAddress || "", serviceDate: value?.serviceDate || "", purchaseOrderReference: value?.purchaseOrderReference || "", interventionReference: value?.interventionReference || "", insuranceDossier: value?.insuranceDossier || "", mandateNumber: value?.mandateNumber || "", claimNumber: value?.claimNumber || "", insuredNumber: value?.insuredNumber || "", principal: value?.principal || "", manager: value?.manager || "", expert: value?.expert || "", operationCategory: ["goods", "services", "mixed"].includes(value?.operationCategory) ? value.operationCategory : "services" }; }
function legalDataFromClient(client) { if (!client) return normalizeLegalData(); const billingAddress = [client.billingAddress || client.address, client.postalCode, client.city].filter(Boolean).join(", "); return normalizeLegalData({ customerSiren: client.siren || client.companySiren || "", customerVatNumber: client.vatNumber || client.taxNumber || client.companyVatNumber || "", billingAddress, deliveryAddress: client.deliveryAddress || "", serviceDate: client.serviceDate || "", purchaseOrderReference: client.purchaseOrderReference || "", interventionReference: client.interventionReference || "", insuranceDossier: client.insuranceDossier || "", mandateNumber: client.mandateNumber || client.mandate || "", claimNumber: client.claimNumber || client.claim || "", insuredNumber: client.insuredNumber || "", principal: client.principal || "", manager: client.manager || client.caseManager || "", expert: client.expert || "", operationCategory: client.operationCategory || "services" }, billingAddress); }
function billingDocumentPayload(form, billingDocument) { const values = formDataToObject(new FormData(form)); const referenceFields = ["interventionReference", "insuranceDossier", "mandateNumber", "claimNumber", "insuredNumber", "principal", "manager", "expert"]; const legalData = normalizeLegalData({ customerSiren: values.customerSiren, customerVatNumber: values.customerVatNumber, billingAddress: values.customerAddress, deliveryAddress: values.deliveryAddress, serviceDate: values.serviceDate, purchaseOrderReference: values.purchaseOrderReference, ...Object.fromEntries(referenceFields.map(field => [field, values[field]])), operationCategory: values.operationCategory }, values.customerAddress); for (const key of ["customerSiren", "customerVatNumber", "deliveryAddress", "serviceDate", "purchaseOrderReference", ...referenceFields, "operationCategory"]) delete values[key]; return { ...values, legalData, lines: billingDocument.lines, financialData: billingDocument.financialData }; }
function emptyFinancialData() { return { discountMode: "fixed", discountAmount: 0, depositAmount: 0, conditions: "", comments: "", aids: [] }; }
function normalizeFinancialData(value) { return { ...emptyFinancialData(), discountMode: value?.discountMode === "percentage" ? "percentage" : "fixed", discountAmount: Number(value?.discountAmount) || 0, depositAmount: Number(value?.depositAmount) || 0, conditions: value?.conditions || "", comments: value?.comments || "", aids: Array.isArray(value?.aids) ? value.aids.filter(aid => aid?.name).map(toAidSnapshot) : [] }; }
function normalizeQuoteTemplate(template) {
    if (!template || !Array.isArray(template.lines) || !template.lines.length) return null;
    return { ...template, lines: template.lines.map(line => ({ ...emptyLine(), ...line })) };
}
function suggestNumber(type) { return `${type === "quote" ? "DEV" : "FAC"}-${new Date().getFullYear()}-${String((billingData.documents || []).filter(document => document.documentType === type).length + 1).padStart(3, "0")}`; }
function lineTotal(line) { return (Number(line.quantity) || 0) * (Number(line.unitPrice) || 0); }
function calculateTotals(lines) { const ht = lines.reduce((sum, line) => sum + lineTotal(line), 0); const vat = lines.reduce((sum, line) => sum + lineTotal(line) * (Number(line.vatRate) || 0) / 100, 0); return { ht, vat, ttc: ht + vat }; }
function calculateNetPayable(lines, financialData = {}) { const totals = calculateTotals(lines || []); const discount = Math.min(totals.ht, financialData.discountMode === "percentage" ? totals.ht * Number(financialData.discountAmount || 0) / 100 : Number(financialData.discountAmount || 0)); const vat = totals.ht ? totals.vat * (totals.ht - discount) / totals.ht : 0; const ttc = totals.ht - discount + vat; const aids = (financialData.aids || []).reduce((sum, aid) => sum + (aid.calculationMode === "percentage" ? (totals.ht - discount) * Number(aid.amount || 0) / 100 : Number(aid.amount || 0)), 0); return Math.max(0, ttc - Math.min(ttc, aids)); }
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
function isVatFranchise() { return billingData?.profile?.vatRegime === "franchise"; }
function bindVatRegimeForm(form) {
    const regime = form?.elements.vatRegime, taxNumber = form?.elements.taxNumber, notice = form?.querySelector("[data-vat-regime-notice]");
    if (!regime || !taxNumber || !notice) return;
    const update = () => { const franchise = regime.value === "franchise"; taxNumber.disabled = franchise; notice.innerHTML = franchise ? `<strong>${VAT_FRANCHISE_MENTION}</strong><br>Les nouvelles lignes de devis et factures seront automatiquement enregistrées avec une TVA à 0 %.` : "Renseignez le numéro de TVA intracommunautaire s’il a été attribué à l’entreprise."; };
    regime.addEventListener("change", update); update();
}

function isTechnician() { return document.body.dataset.role === "technician"; }
function isAccountant() { return document.body.dataset.role === "accountant"; }
function isFullAdministrator() { return document.body.dataset.role === "admin"; }
function isTechnicianBillingAllowed() { return !isTechnician() || document.body.dataset.technicianBillingEnabled !== "false"; }
function canIssueBillingInvoice(document) { const role = globalThis.document.body.dataset.role; return ["admin", "mobile_admin"].includes(role) || (role === "technician" && isTechnicianBillingAllowed() && Boolean(document.appointmentId)); }
function canRecordInvoiceSettlement(document) { return !isAccountant() && (!isTechnician() || (isTechnicianBillingAllowed() && Boolean(document.appointmentId))); }
function canCreateSavedBillingLine() { const role = document.body.dataset.role; return role !== "accountant" && (document.body.dataset.deviceType === "desktop" || ["admin", "mobile_admin"].includes(role)); }
function canAccessTechnicalReports() {
    try { return JSON.parse(document.body.dataset.organizationFeatures || "{}").technicalReports !== false; }
    catch { return false; }
}
function canAccessQuitus() {
    try { return JSON.parse(document.body.dataset.organizationFeatures || "{}").quitus === true; }
    catch { return false; }
}
function usesExternalQuoteTemplate() {
    const policy = billingData?.profile?.quoteTemplatePolicy;
    return policy === "external_only" || (policy !== "integrated_only" && billingData?.profile?.quoteTemplateMode === "external");
}

function usesExternalDocumentTemplate(type) {
    if (type === "quitus") return billingData?.profile?.quitusTemplatePolicy === "external_only" || (billingData?.profile?.quitusTemplatePolicy !== "integrated_only" && billingData?.profile?.quitusTemplateMode === "external");
    return billingData?.profile?.reportTemplatePolicy === "external_only" || (billingData?.profile?.reportTemplatePolicy !== "integrated_only" && billingData?.profile?.reportFileTemplateMode === "external");
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

function openQuoteTemplatePreview(type = "quote") {
    const popup = window.open("", "_blank");
    if (!popup) { alert(`Autorisez les fenêtres pop-up pour afficher l’aperçu ${type === "invoice" ? "de la facture" : "du devis"}.`); return; }
    popup.location.href = `/api/billing/quote-template/preview?type=${encodeURIComponent(type)}`;
}

function openQuoteTemplateDownload() {
    const popup = window.open("", "_blank");
    if (!popup) { alert("Autorisez les fenêtres pop-up pour télécharger la base de devis."); return; }
    popup.location.href = "/api/billing/quote-template/file";
}

function openDocumentTemplateDownload(type) {
    const popup = window.open("", "_blank");
    if (!popup) { alert("Autorisez les fenêtres pop-up pour télécharger cette base officielle."); return; }
    popup.location.href = `/api/billing/document-templates/${encodeURIComponent(type)}/file`;
}

function openDocumentTemplatePreview(type) {
    const popup = window.open("", "_blank");
    if (!popup) { alert("Autorisez les fenêtres pop-up pour afficher l’aperçu de cette base officielle."); return; }
    popup.location.href = `/api/billing/document-templates/${encodeURIComponent(type)}/preview`;
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
    if (result.ok) renderBilling();
}

async function apiRequest(url, options = {}) {
    try {
        const headers = options.body instanceof FormData ? {} : { "Content-Type": "application/json", ...(options.headers || {}) };
        const response = await fetch(url, { credentials: "same-origin", ...options, headers });
        const data = response.status === 204 ? null : await response.json().catch(() => null);
        return { ok: response.ok, data, message: data?.message };
    } catch { return { ok: false, data: null, message: "Serveur indisponible." }; }
}
