import { ROUTES } from "./config.js?v=118";
import { clearSearch, getContainer, setPage } from "./ui.js?v=44";
import { escapeHtml } from "./utils.js?v=44";
import { acquireReportLock, forceReleaseReportLock, heartbeatReportLock, releaseReportLock } from "./collaboration.js?v=4";
import { openDocumentDeliveryChoice } from "./document-delivery.js?v=1";
import { renderLivePdfPreview } from "./pdf-live-preview.js?v=1";

const MODULES = [
    ["general", "Informations générales", "Données récupérées automatiquement"],
    ["presentation", "Rapport de recherche de fuite", "Photo de présentation du logement"],
    ["overview", "État des lieux", "Constats à l’arrivée"],
    ["visual", "Observations visuelles", "Désordres et anomalies visibles"],
    ["humidity", "Contrôle d’humidité", "Mesures et zones contrôlées"],
    ["pressure", "Manomètre de pression", "Contrôles de pression"],
    ["methods", "Matériels techniques utilisés", "Sélectionnez les équipements employés"],
    ["waterTest", "Test d’étanchéité à l’eau claire / colorant", "Essais réalisés"],
    ["charging", "Mise en charge", "Mise sous pression ou en charge"],
    ["safety", "Mise en sécurité", "Mesures de prévention"],
    ["ventilation", "Contrôle ventilation", "Vérifications de ventilation"],
    ["conclusion", "Conclusion", "Diagnostic et synthèse"],
    ["recommendations", "Préconisations", "Travaux et conseils"],
];
let reports = [];
let library = [];
let materialCatalog = [];
let current = null;
let corrections = [];
let reportLock = null;
let previewMode = false;
let reportPreviewUrl = "";
let saveTimer = null;
let heartbeatTimer = null;
let periodicTimer = null;
let saving = false;
let heartbeatRunning = false;
let lockRecoveryPromise = null;
const mediaSavePromises = new Set();
let eventsBound = false;
let moduleNavScrollLeft = 0;

export async function renderLeakReportWizard(reportId = 0, appointmentId = 0) {
    if ((!reportId && !appointmentId) || (reportId && String(current?.id || "") !== String(reportId))) await leaveReport();
    clearSearch();
    setPage("Rapports de recherche de fuite", ROUTES.technicalReports, "detail");
    const root = getContainer();
    root.innerHTML = '<section class="report-editor-shell"><p class="muted">Ouverture de l’éditeur de rapport…</p></section>';
    const index = await api("/api/technical-reports");
    if (!index.ok) return showFailure(root, index.message);
    reports = index.data.reports || [];
    library = index.data.library || [];
    materialCatalog = index.data.materials || [];
    if (reportId) await loadReport(reportId);
    else if (appointmentId) await openAppointmentReport(appointmentId);
    bindCollaborationEvents();
    const shell = root.querySelector(".report-editor-shell");
    if (!current) return renderDirectory(shell);
    renderEditor(shell);
}

function renderDirectory(shell) {
    shell.classList.add("report-directory");
    const groups = [["À rédiger", ["draft", "in_correction"]], ["Terminés à corriger", ["submitted"]], ["À envoyer", ["ready_to_send"]], ["Envoyés", ["validated"]]];
    const reportCard = report => `<article><div><strong>${escapeHtml(report.title)}</strong><p class="report-directory-client"><b>${escapeHtml(report.clientName || "Client non renseigné")}</b>${report.claimNumber ? ` · Sinistre n° ${escapeHtml(report.claimNumber)}` : ""}${report.insurance ? ` · Assurance ${escapeHtml(report.insurance)}` : ""}</p><p>${escapeHtml(statusLabel(report.status))} · ${report.appointmentId ? `Intervention n° ${escapeHtml(report.appointmentId)}` : "Rapport historique"} · ${escapeHtml(formatDate(report.reportDate))}</p></div><button class="secondary-button" data-open-report="${escapeHtml(report.id)}">${report.status === "validated" ? "Consulter" : "Ouvrir"}</button></article>`;
    shell.innerHTML = `<header class="report-directory-heading"><div><p class="eyebrow">Rapports terrain</p><h2>Rapports de recherche de fuite</h2><p class="muted">Chaque rapport est créé depuis une intervention rattachée à un dossier client.</p></div><button type="button" class="secondary-button" data-create-report>Nouveau rapport de recherche de fuite</button></header><section class="report-directory-list">${reports.length ? groups.map(([title, statuses]) => { const items = reports.filter(report => statuses.includes(report.status)); return `<section class="report-directory-group"><h3>${title}</h3>${items.length ? items.map(reportCard).join("") : '<p class="muted">Aucun rapport dans cette section.</p>'}</section>`; }).join("") : '<p class="muted">Aucun rapport accessible. Créez votre premier rapport depuis une intervention.</p>'}</section>`;
    shell.querySelector("[data-create-report]").addEventListener("click", openLeakReportCreation);
    shell.querySelectorAll("[data-open-report]").forEach(button => button.addEventListener("click", () => renderLeakReportWizard(button.dataset.openReport)));
}

export function openLeakReportCreation() {
    const dialog = document.createElement("section");
    dialog.className = "report-creation-dialog";
    dialog.innerHTML = `<div><header><div><p class="eyebrow">Nouveau rapport</p><h2>Rapport de recherche de fuite</h2></div><button type="button" class="text-button" data-close-report-creation>Fermer</button></header><p class="muted">Un rapport est toujours rattaché à une intervention et au dossier client correspondant.</p><div class="report-creation-options"><button type="button" data-report-from-appointment><strong>Choisir une intervention</strong><span>Ouvrez une intervention existante pour créer ou reprendre son rapport.</span></button><button type="button" data-create-client-first><strong>Créer d’abord un client</strong><span>Créez le dossier client, planifiez son intervention, puis ouvrez le rapport depuis le planning.</span></button></div></div>`;
    document.body.append(dialog);
    dialog.querySelector("[data-close-report-creation]").addEventListener("click", () => dialog.remove());
    dialog.querySelector("[data-report-from-appointment]").addEventListener("click", async () => { dialog.remove(); const { renderCalendar } = await import("./calendar.js?v=183"); renderCalendar(); });
    dialog.querySelector("[data-create-client-first]").addEventListener("click", async () => { dialog.remove(); const { renderClients } = await import("./clients.js?v=154"); renderClients(); });
}

async function openAppointmentReport(appointmentId) {
    const existing = await api(`/api/technical-reports/appointments/${encodeURIComponent(appointmentId)}`);
    if (!existing.ok) return alert(existing.message || "Intervention indisponible.");
    if (existing.data.report) return loadReport(existing.data.report.id);
    const created = await api("/api/technical-reports", { method: "POST", body: JSON.stringify({ appointmentId }) });
    if (!created.ok) return alert(created.message || "Création du rapport impossible.");
    await loadReport(created.data.id);
}

async function loadReport(reportId) {
    const result = await api(`/api/technical-reports/${encodeURIComponent(reportId)}`);
    if (!result.ok) return alert(result.message || "Rapport introuvable.");
    current = result.data.report;
    corrections = result.data.corrections || [];
    reportLock = result.data.lock || null;
    previewMode = false;
    ensureModularContent();
    await acquireLock();
}

function ensureModularContent() {
    if (!current?.content) return;
    current.content.customSections = Array.isArray(current.content.customSections) ? current.content.customSections : [];
    current.content.sectionTitles = current.content.sectionTitles && typeof current.content.sectionTitles === "object" ? current.content.sectionTitles : {};
    delete current.content.sectionTitles.presentation;
    current.content.removedSections = Array.isArray(current.content.removedSections) ? current.content.removedSections : [];
    current.content.sectionOrder = Array.isArray(current.content.sectionOrder) ? current.content.sectionOrder : moduleKeys();
    MODULES.forEach(([key]) => {
        current.content[key] = current.content[key] && typeof current.content[key] === "object" ? current.content[key] : {};
        current.content[key].observations = Array.isArray(current.content[key].observations) ? current.content[key].observations : [];
    });
    current.content.customSections.forEach(section => { section.content = section.content && typeof section.content === "object" ? section.content : {}; section.content.observations = Array.isArray(section.content.observations) ? section.content.observations : []; });
    const ids = sectionEntries().map(section => section.id);
    current.content.sectionOrder = [...new Set(current.content.sectionOrder.filter(id => ids.includes(id)))];
    ids.forEach(id => { if (!current.content.sectionOrder.includes(id)) current.content.sectionOrder.push(id); });
    pinRequiredSections();
    current.content.activeStep = current.content.sectionOrder.includes(current.content.activeStep) && !current.content.removedSections.includes(current.content.activeStep) ? current.content.activeStep : visibleSections()[0]?.id || "general";
    current.content.methods.materials = Array.isArray(current.content.methods.materials) ? current.content.methods.materials : [];
    current.content.activeMaterialId = current.content.methods.materials.some(material => material.id === current.content.activeMaterialId) ? current.content.activeMaterialId : "";
}

async function acquireLock() {
    if (!current || current.status === "validated" || (current.status === "submitted" && !canProofreadReport()) || (current.status === "ready_to_send" && !canFinalizeReport())) return null;
    const reportId = current.id;
    const result = await acquireReportLock(reportId);
    if (!current || String(current.id) !== String(reportId)) return null;
    reportLock = result.data?.lock || reportLock;
    return result;
}

function renderEditor(shell) {
    if (previewMode) return renderPreview(shell);
    const existingNavigation = shell.querySelector(".report-module-nav");
    if (existingNavigation) moduleNavScrollLeft = existingNavigation.scrollLeft;
    document.body.classList.add("report-writing-active");
    ensureModularContent();
    const activeKey = current.content.activeStep;
    const activeModule = moduleDefinition(activeKey);
    const activeMaterial = activeKey === "methods" && !activeModule.custom ? selectedMaterial() : null;
    const write = editable();
    const snapshot = current.content.snapshot || {};
    const sourceLabel = current.appointmentId ? "Intervention" : "Dossier";
    shell.className = "report-editor-shell report-editor-fullscreen";
    shell.innerHTML = `
        <header class="report-editor-header">
            <div class="report-editor-identity"><strong>${escapeHtml(snapshot.clientName || current.clientName || "Client non renseigné")}</strong><span>${escapeHtml(snapshot.clientAddress || current.clientAddress || current.appointmentLocation || "Adresse non renseignée")}</span></div>
            <div class="report-editor-meta"><span>${sourceLabel} n° ${escapeHtml(snapshot.interventionNumber || current.appointmentId || "—")}</span><span>${snapshot.insuranceDossier ? `Réf. dossier assureur ${escapeHtml(snapshot.insuranceDossier)}` : "Réf. dossier assureur non renseignée"}</span><span>${snapshot.claimNumber ? `Sinistre n° ${escapeHtml(snapshot.claimNumber)}` : "Sinistre non renseigné"}</span><span>${escapeHtml(snapshot.technicianName || current.technicianName || "Technicien")}</span></div>
            <span class="report-editor-status ${escapeHtml(current.status)}">${escapeHtml(statusLabel(current.status))}</span>
            <button type="button" class="secondary-button report-editor-home-button" data-report-home>Accueil</button>
        </header>
        ${lockBanner()}
        ${corrections.length ? `<section class="report-editor-corrections"><strong>Commentaires de l’administration</strong>${corrections.map(item => `<p><b>${escapeHtml(moduleDefinition(item.section)?.[1] || "Page")}</b> · ${escapeHtml(item.comment)}</p>`).join("")}</section>` : ""}
        <nav class="report-module-nav" aria-label="Pages du rapport">${visibleSections().map((section, index) => `<button type="button" draggable="${write && !["general", "presentation"].includes(section.id) ? "true" : "false"}" class="${section.id === activeKey ? "active" : ""}${moduleUsed(section.id) ? " used" : ""}" data-module="${escapeHtml(section.id)}"><span>${index + 1}</span><b>${escapeHtml(section.title)}</b></button>`).join("")}</nav>
        <main class="report-editor-main">
            <div class="report-editor-module-heading"><div><p class="eyebrow">${activeMaterial ? "Matériel sélectionné" : `Page ${moduleNumber(activeKey)} sur ${visibleSections().length}`}</p>${write && !activeMaterial && activeKey !== "presentation" ? `<label class="report-section-title"><input aria-label="Titre de la page" value="${escapeHtml(activeModule[1])}" maxlength="160" data-section-title="${escapeHtml(activeKey)}"></label>` : `<h2>${escapeHtml(activeMaterial?.name || activeModule[1])}</h2>`}<p class="muted">${escapeHtml(activeMaterial ? "Observations et photos associées à cet équipement" : activeModule[2])}</p></div>${activeMaterial ? '<button type="button" class="secondary-button" data-back-to-materials>Retour aux matériels</button>' : write && activeKey !== "presentation" ? `<div class="report-section-actions"><button type="button" class="secondary-button" data-duplicate-section>Dupliquer cette page</button>${activeKey !== "general" ? '<button type="button" class="text-button danger-text" data-delete-section>Supprimer la page</button>' : ""}</div>` : ""}</div>
            ${activeKey === "general" && !activeModule.custom ? generalModuleHtml(write) : activeKey === "presentation" && !activeModule.custom ? presentationModuleHtml(write) : activeKey === "methods" && !activeModule.custom ? materialsModuleHtml(write, activeMaterial) : observationsModuleHtml(activeKey, write)}
        </main>
        <footer class="report-editor-footer">
            <button type="button" class="secondary-button" data-previous-module ${moduleIndex(activeKey) <= 0 ? "disabled" : ""}>Précédente</button>
            <button type="button" class="secondary-button" data-preview>Aperçu</button>
            ${write ? '<span class="report-autosave" data-save-state>Enregistré automatiquement</span>' : ""}
            ${write && ["draft", "in_correction"].includes(current.status) ? '<button type="button" class="secondary-button report-primary-action" data-submit-report>Terminer</button>' : ""}
            ${write && current.status === "submitted" && canProofreadReport() ? '<button type="button" class="secondary-button report-primary-action" data-proofread-report>Corriger</button>' : ""}
            ${ownsLock() && current.status === "ready_to_send" && canFinalizeReport() ? '<button type="button" class="secondary-button report-primary-action" data-validate-report>Valider définitivement et envoyer</button>' : ""}
            ${editable() && isAdministrator() && ["submitted", "in_correction"].includes(current.status) ? '<button type="button" class="secondary-button" data-request-correction>Demander une correction</button>' : ""}
            ${isAdministrator() && current.status === "validated" ? '<button type="button" class="secondary-button" data-reopen-report>Réouvrir le rapport</button>' : ""}
            ${ownsLock() && current.status === "draft" && canCancelReport() ? '<button type="button" class="danger-button" data-cancel-report>Annuler la création du rapport</button>' : ""}
            <button type="button" class="secondary-button" data-next-module ${moduleIndex(activeKey) >= visibleSections().length - 1 ? "disabled" : ""}>Suivante</button>
        </footer>
    `;
    bindEditor(shell, activeKey);
    restoreModuleNavigation(shell, activeKey);
    startTimers(shell);
}

function generalModuleHtml(write) {
    const snapshot = current.content.snapshot || {};
    const values = [["Entreprise", snapshot.companyName], ["Client", snapshot.clientName || current.clientName], ["Adresse", snapshot.clientAddress || current.clientAddress || current.appointmentLocation], ["Téléphone", snapshot.clientPhone], ["E-mail", snapshot.clientEmail], ["N° intervention", snapshot.interventionNumber || current.appointmentId], ["Réf. dossier assureur", snapshot.insuranceDossier], ["N° mandat", snapshot.mandateNumber], ["N° sinistre", snapshot.claimNumber], ["N° sociétaire / assuré", snapshot.insuredNumber], ["Mandant / donneur d’ordre", snapshot.principal], ["Gestionnaire", snapshot.manager], ["Expert", snapshot.expert], ["Assurance", snapshot.insurance], ["Date / heure", [snapshot.date || current.reportDate, snapshot.time].filter(Boolean).join(" · ")], ["Technicien", snapshot.technicianName || current.technicianName], ["Type d’intervention", snapshot.interventionType]].filter(([, value]) => value);
    return `<section class="report-auto-summary"><p>Ces informations sont générées automatiquement à partir du dossier client et de l’intervention.</p><dl>${values.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl></section>${photosHtml("general", "", write, "Ajouter la photo extérieure du logement", true)}`;
}

function presentationModuleHtml(write) {
    const photo = orderedPhotos((current.media || []).filter(item => item.section === "presentation"))[0];
    return `<section class="report-presentation-page">${write ? '<div class="report-photo-source-actions"><label>Prendre une photo<input type="file" accept="image/*" capture="environment" data-presentation-camera></label><label>Choisir une photo dans la galerie<input type="file" accept="image/*" data-presentation-gallery></label></div>' : ""}${photo ? `<button type="button" class="report-photo-preview" data-open-photo="${escapeHtml(photo.id)}"><img src="${escapeHtml(photo.dataUrl)}" alt="Photo du logement"></button>` : '<p class="muted">Ajoutez la photo du logement qui servira de présentation au rapport PDF.</p>'}</section>`;
}

function observationsModuleHtml(moduleKey, write, material = null) {
    const observations = material ? material.observations : sectionContent(moduleKey).observations;
    if (isSkipped(moduleKey)) return `<section class="report-module-empty"><h3>Module ignoré</h3><p>Il ne figurera pas dans le PDF final tant qu’il n’est pas réactivé.</p></section>`;
    return `<section class="report-observations">${observations.map((observation, index) => observationHtml(moduleKey, observation, index, write, material?.id || "")).join("") || '<section class="report-module-empty"><h3>Aucune observation</h3><p>Ajoutez uniquement les constats utiles à cette intervention.</p></section>'}${write ? `<button type="button" class="report-add-observation" data-add-observation data-material-id="${escapeHtml(material?.id || "")}">+ Ajouter une observation</button>` : ""}</section>`;
}

function materialsModuleHtml(write, material) {
    if (material) return observationsModuleHtml("methods", write, material);
    const selected = current.content.methods.materials;
    const choices = materialCatalog;
    return `<section class="report-material-selector"><p>Sélectionnez tous les matériels réellement utilisés. Chaque sélection crée sa propre page dans le PDF final.</p><div class="report-material-options">${choices.map(name => { const material = selected.find(item => item.name === name); return `<label class="${material ? "selected" : ""}"><input type="checkbox" data-material-choice="${escapeHtml(name)}" ${material ? "checked" : ""} ${write ? "" : "disabled"}><span>${escapeHtml(name)}</span></label>`; }).join("")}</div>${selected.some(item => item.name === "Autre matériel") ? `<label class="report-other-material">Nom de l’autre matériel<input data-other-material-name value="${escapeHtml(selected.find(item => item.name === "Autre matériel")?.customName || "")}" placeholder="Ex. pompe d’épreuve" ${write ? "" : "disabled"}></label>` : ""}<section class="report-selected-materials"><h3>Pages créées</h3>${selected.length ? selected.map((item, index) => `<article><button type="button" data-open-material="${escapeHtml(item.id)}"><strong>${escapeHtml(materialLabel(item))}</strong><span>${item.observations.length} observation${item.observations.length > 1 ? "s" : ""}</span></button>${write ? `<button type="button" class="text-button danger-text" data-remove-material="${escapeHtml(item.id)}">Supprimer</button>` : ""}</article>`).join("") : '<p class="muted">Aucun matériel sélectionné.</p>'}</section></section>`;
}

function observationHtml(moduleKey, observation, index, write, materialId = "") {
    const observations = materialId ? materialById(materialId)?.observations || [] : sectionContent(moduleKey).observations;
    const desktopLayout = write && canAdjustPdfLayout();
    return `<article class="report-observation-card" data-observation-card="${escapeHtml(observation.id)}"><header><strong>Observation ${index + 1}</strong>${write ? `<div><button type="button" class="text-button" data-move-observation="up" data-observation-id="${escapeHtml(observation.id)}" data-material-id="${escapeHtml(materialId)}" ${index ? "" : "disabled"}>↑</button><button type="button" class="text-button" data-move-observation="down" data-observation-id="${escapeHtml(observation.id)}" data-material-id="${escapeHtml(materialId)}" ${index < observations.length - 1 ? "" : "disabled"}>↓</button><button type="button" class="text-button danger-text" data-delete-observation="${escapeHtml(observation.id)}" data-material-id="${escapeHtml(materialId)}">Supprimer</button></div>` : ""}</header><label>Constat<textarea data-observation-text="${escapeHtml(observation.id)}" data-material-id="${escapeHtml(materialId)}" rows="6" placeholder="Décrivez uniquement ce qui a été observé…" ${write ? "" : "disabled"}>${escapeHtml(observation.text || "")}</textarea></label>${desktopLayout ? `<fieldset class="report-pdf-layout-controls"><legend>Mise en page du PDF</legend><label><input type="checkbox" data-observation-keep-together="${escapeHtml(observation.id)}" data-material-id="${escapeHtml(materialId)}" ${observation.keepTogether !== false ? "checked" : ""}> Garder cette observation et ses photos ensemble si elles tiennent sur une page</label>${index ? `<label><input type="checkbox" data-observation-page-break="${escapeHtml(observation.id)}" data-material-id="${escapeHtml(materialId)}" ${observation.pageBreakBefore ? "checked" : ""}> Commencer cette observation sur une nouvelle page</label>` : ""}<small>Utilisez les flèches ci-dessus pour changer l’ordre des observations.</small></fieldset>` : ""}${photosHtml(moduleKey, observation.id, write, "Ajouter des photos", false, materialId)}</article>`;
}

function photosHtml(moduleKey, observationId, write, addLabel, singlePhoto = false, materialId = "", showAdd = true, forceDesktopLayout = false) {
    const photos = orderedPhotos((current.media || []).filter(photo => photo.section === moduleKey && String(photo.observationId || "") === String(observationId) && String(photo.materialId || "") === String(materialId)));
    const source = `data-photo-source data-module-key="${escapeHtml(moduleKey)}" data-observation-id="${escapeHtml(observationId)}" data-material-id="${escapeHtml(materialId)}" ${singlePhoto ? 'data-single-photo="true"' : ""}`;
    const desktopLayout = write && (Boolean(observationId) || forceDesktopLayout) && canAdjustPdfLayout();
    return `<section class="report-observation-photos"><div class="report-photo-grid">${photos.map((photo, index) => `<article><button type="button" class="report-photo-preview" data-open-photo="${escapeHtml(photo.id)}"><img src="${escapeHtml(photo.dataUrl)}" alt="Agrandir la photo"></button>${write ? `<input value="${escapeHtml(photo.caption || "")}" maxlength="500" placeholder="Commentaire facultatif" data-photo-caption="${escapeHtml(photo.id)}">${desktopLayout ? `<label class="report-photo-pdf-size">Taille dans le PDF<select data-photo-pdf-size="${escapeHtml(photo.id)}"><option value="compact" ${photo.pdfSize === "compact" ? "selected" : ""}>Compacte — plusieurs photos par page</option><option value="medium" ${photo.pdfSize === "medium" ? "selected" : ""}>Moyenne</option><option value="large" ${!["compact", "medium"].includes(photo.pdfSize) ? "selected" : ""}>Grande — largeur de page</option></select></label>` : ""}<div class="report-photo-actions"><button type="button" class="text-button" data-replace-photo="${escapeHtml(photo.id)}" ${source}>Remplacer</button><button type="button" class="text-button" data-move-photo="up" data-photo-id="${escapeHtml(photo.id)}" ${index ? "" : "disabled"}>↑</button><button type="button" class="text-button" data-move-photo="down" data-photo-id="${escapeHtml(photo.id)}" ${index < photos.length - 1 ? "" : "disabled"}>↓</button><button type="button" class="text-button danger-text" data-delete-photo="${escapeHtml(photo.id)}">Supprimer</button></div>` : ""}</article>`).join("")}</div>${showAdd && write && (!singlePhoto || !photos.length) ? `<button type="button" class="report-photo-add" ${source}>${escapeHtml(addLabel)}</button>` : ""}</section>`;
}

function bindEditor(shell, moduleKey) {
    shell.querySelectorAll("[data-module]").forEach(button => button.addEventListener("click", () => openModule(shell, button.dataset.module)));
    bindSectionReordering(shell);
    bindPageSwipe(shell, moduleKey);
    shell.querySelector("[data-previous-module]")?.addEventListener("click", () => openModule(shell, visibleSections()[moduleIndex(moduleKey) - 1]?.id));
    shell.querySelector("[data-next-module]")?.addEventListener("click", () => openModule(shell, visibleSections()[moduleIndex(moduleKey) + 1]?.id));
    shell.querySelector("[data-section-title]")?.addEventListener("input", input => { renameSection(input.dataset.sectionTitle, input.value); queueSave(shell); });
    ["[data-presentation-camera]", "[data-presentation-gallery]"].forEach(selector => shell.querySelector(selector)?.addEventListener("change", async event => replacePresentationPhoto([...event.target.files || []][0], shell)));
    shell.querySelector("[data-report-summary]")?.addEventListener("click", () => openReportSummary(shell));
    shell.querySelector("[data-duplicate-section]")?.addEventListener("click", () => duplicateSection(moduleKey, shell));
    shell.querySelectorAll("[data-move-section]").forEach(button => button.addEventListener("click", () => { moveSection(moduleKey, button.dataset.moveSection); queueSave(shell); renderEditor(shell); }));
    shell.querySelector("[data-delete-section]")?.addEventListener("click", () => deleteSection(moduleKey, shell));
    shell.querySelector("[data-skip-module]")?.addEventListener("click", () => { const skipped = new Set(current.content.skippedSteps || []); skipped.has(moduleKey) ? skipped.delete(moduleKey) : skipped.add(moduleKey); current.content.skippedSteps = [...skipped]; queueSave(shell); renderEditor(shell); });
    shell.querySelector("[data-back-to-materials]")?.addEventListener("click", () => { current.content.activeMaterialId = ""; queueSave(shell, false); renderEditor(shell); });
    shell.querySelectorAll("[data-material-choice]").forEach(input => input.addEventListener("change", () => toggleMaterial(input.dataset.materialChoice, input.checked, shell)));
    shell.querySelector("[data-other-material-name]")?.addEventListener("input", input => { const material = current.content.methods.materials.find(item => item.name === "Autre matériel"); if (material) material.customName = input.target.value; queueSave(shell); });
    shell.querySelectorAll("[data-open-material]").forEach(button => button.addEventListener("click", () => { current.content.activeMaterialId = button.dataset.openMaterial; queueSave(shell, false); renderEditor(shell); }));
    shell.querySelectorAll("[data-remove-material]").forEach(button => button.addEventListener("click", async () => { if (!confirm("Supprimer ce matériel, toutes ses observations et ses photos ?")) return; if (!await removeMaterial(button.dataset.removeMaterial)) return; queueSave(shell); renderEditor(shell); }));
    shell.querySelector("[data-add-observation]")?.addEventListener("click", button => { const material = materialById(button.target.dataset.materialId); const observations = material ? material.observations : sectionContent(moduleKey).observations; observations.push({ id: newObservationId(), text: "", createdAt: new Date().toISOString(), keepTogether: true, pageBreakBefore: false }); current.content.skippedSteps = (current.content.skippedSteps || []).filter(key => key !== moduleKey); queueSave(shell); renderEditor(shell); });
    shell.querySelectorAll("[data-observation-text]").forEach(input => input.addEventListener("input", () => { const observation = findObservation(moduleKey, input.dataset.observationText, input.dataset.materialId); if (observation) observation.text = input.value; queueSave(shell); }));
    shell.querySelectorAll("[data-observation-keep-together]").forEach(input => input.addEventListener("change", () => { const observation = findObservation(moduleKey, input.dataset.observationKeepTogether, input.dataset.materialId); if (observation) observation.keepTogether = input.checked; queueSave(shell); }));
    shell.querySelectorAll("[data-observation-page-break]").forEach(input => input.addEventListener("change", () => { const observation = findObservation(moduleKey, input.dataset.observationPageBreak, input.dataset.materialId); if (observation) observation.pageBreakBefore = input.checked; queueSave(shell); }));
    shell.querySelectorAll("[data-delete-observation]").forEach(button => button.addEventListener("click", async () => { if (!confirm("Supprimer cette observation et ses photos ?")) return; if (!await removeObservation(moduleKey, button.dataset.deleteObservation, button.dataset.materialId)) return; queueSave(shell); renderEditor(shell); }));
    shell.querySelectorAll("[data-move-observation]").forEach(button => button.addEventListener("click", () => { moveObservation(moduleKey, button.dataset.observationId, button.dataset.moveObservation, button.dataset.materialId); queueSave(shell); renderEditor(shell); }));
    shell.querySelectorAll("[data-photo-source]").forEach(button => button.addEventListener("click", () => openPhotoSource(shell, { moduleKey: button.dataset.moduleKey, observationId: button.dataset.observationId, materialId: button.dataset.materialId, singlePhoto: button.dataset.singlePhoto === "true", replacePhotoId: button.dataset.replacePhoto || "" })));
    shell.querySelectorAll("[data-open-photo]").forEach(button => button.addEventListener("click", () => openPhotoPreview(button.dataset.openPhoto)));
    shell.querySelectorAll("[data-photo-caption]").forEach(input => input.addEventListener("change", () => trackMediaSave(updatePhotoCaption(input, shell))));
    shell.querySelectorAll("[data-photo-pdf-size]").forEach(input => input.addEventListener("change", () => trackMediaSave(updatePhotoPdfSize(input, shell))));
    shell.querySelectorAll("[data-delete-photo]").forEach(button => button.addEventListener("click", () => trackMediaSave(deletePhoto(button.dataset.deletePhoto, shell))));
    shell.querySelectorAll("[data-move-photo]").forEach(button => button.addEventListener("click", () => trackMediaSave(movePhoto(button.dataset.photoId, button.dataset.movePhoto, shell))));
    shell.querySelector("[data-preview]").addEventListener("click", async () => {
        if (editable() && !await save(shell, true)) {
            alert("L’aperçu n’a pas été ouvert car le rapport n’a pas pu être enregistré. Vérifiez qu’un autre utilisateur ne le modifie pas.");
            return;
        }
        previewMode = true;
        renderEditor(shell);
    });
    shell.querySelector("[data-proofread-report]")?.addEventListener("click", () => openReportProofreading(shell));
    shell.querySelector("[data-submit-report]")?.addEventListener("click", () => submitReport(shell));
    shell.querySelector("[data-validate-report]")?.addEventListener("click", () => validateReport(shell));
    shell.querySelector("[data-request-correction]")?.addEventListener("click", () => requestCorrection(shell));
    shell.querySelector("[data-reopen-report]")?.addEventListener("click", () => reopenReport(shell));
    shell.querySelector("[data-cancel-report]")?.addEventListener("click", () => cancelReport(shell));
    shell.querySelector("[data-force-lock]")?.addEventListener("click", forceTakeover);
    shell.querySelector("[data-report-home]")?.addEventListener("click", () => exitReportToHome(shell));
}

function renderPreview(shell) {
    clearReportPreviewUrl();
    shell.className = "report-editor-shell report-preview-shell";
    shell.innerHTML = `<header class="report-preview-header"><div><p class="eyebrow">Prévisualisation PDF intégrée</p><h2>${escapeHtml(current.title)}</h2><p class="muted">Cet aperçu reprend fidèlement le PDF qui sera archivé, sans téléchargement.</p><p class="auth-message" data-report-preview-state>Génération de l’aperçu…</p></div><div class="report-preview-actions"><button class="secondary-button" data-modify-report>Modifier le rapport</button>${ownsLock() && current.status === "ready_to_send" && canFinalizeReport() ? '<button class="secondary-button report-primary-action" data-preview-validate>Valider définitivement et envoyer</button>' : ""}<button class="secondary-button" data-close-preview>Fermer la prévisualisation</button><button class="secondary-button" data-report-home>Accueil</button></div></header><iframe title="Prévisualisation intégrée du rapport PDF" hidden></iframe>`;
    const returnToEditor = () => { clearReportPreviewUrl(); previewMode = false; renderEditor(shell); };
    shell.querySelector("[data-modify-report]").addEventListener("click", returnToEditor);
    shell.querySelector("[data-close-preview]").addEventListener("click", returnToEditor);
    shell.querySelector("[data-preview-validate]")?.addEventListener("click", () => finalizePreview(shell));
    shell.querySelector("[data-report-home]")?.addEventListener("click", () => exitReportToHome(shell));
    void loadReportPreview(shell);
}

async function loadReportPreview(shell) {
    const frame = shell.querySelector("iframe");
    const state = shell.querySelector("[data-report-preview-state]");
    try {
        const response = await fetch(`/api/technical-reports/${encodeURIComponent(current.id)}/pdf?preview=${Date.now()}`, { credentials: "same-origin", headers: { Accept: "application/pdf" } });
        if (!response.ok) {
            const error = await response.json().catch(() => null);
            throw new Error(error?.message || `Aperçu indisponible (erreur ${response.status}).`);
        }
        const contentType = String(response.headers.get("Content-Type") || "").toLowerCase();
        if (!contentType.startsWith("application/pdf")) throw new Error("Le serveur n’a pas retourné un document PDF. Reconnectez-vous puis réessayez.");
        const blob = await response.blob();
        if (!previewMode || !frame?.isConnected) return;
        clearReportPreviewUrl();
        reportPreviewUrl = URL.createObjectURL(blob);
        frame.src = reportPreviewUrl;
        frame.hidden = false;
        state.textContent = "Aperçu PDF chargé.";
        state.classList.remove("error");
    } catch (error) {
        if (!state?.isConnected) return;
        state.textContent = error.message || "Aperçu PDF indisponible.";
        state.classList.add("error");
        frame.hidden = true;
    }
}

function clearReportPreviewUrl() {
    if (reportPreviewUrl) URL.revokeObjectURL(reportPreviewUrl);
    reportPreviewUrl = "";
}

function lockBanner() {
    if (current.status === "validated") return '<p class="report-editor-lock validated">Rapport validé : il est désormais en consultation seule.</p>';
    if (current.status === "ready_to_send" && ownsLock()) return '<p class="report-editor-lock editable">Correction terminée : le rapport est prêt à être envoyé.</p>';
    if (editable()) return '<p class="report-editor-lock editable">Sauvegarde automatique active</p>';
    if (reportLock) return `<p class="report-editor-lock readonly">Lecture seule : ${escapeHtml(reportLock.userName || "un utilisateur")} modifie ce rapport.${isAdministrator() ? ' <button class="secondary-button" data-force-lock>Reprendre la main</button>' : ""}</p>`;
    return '<p class="report-editor-lock readonly">Lecture seule : verrou indisponible.</p>';
}

function bindSectionReordering(shell) {
    if (!editable()) return;
    let draggedId = "";
    let touchTargetId = "";
    let touchStart = null;
    let touchTimer = null;
    let touchDragging = false;
    const navigation = shell.querySelector(".report-module-nav");
    const clearDragState = () => { draggedId = ""; touchTargetId = ""; touchStart = null; touchDragging = false; clearTimeout(touchTimer); shell.querySelectorAll("[data-module]").forEach(item => item.classList.remove("dragging", "drop-target")); };
    const reorder = (sourceId, targetId) => {
        if (!sourceId || !targetId || sourceId === targetId || ["general", "presentation"].includes(sourceId) || ["general", "presentation"].includes(targetId)) return;
        const order = current.content.sectionOrder.filter(id => id !== sourceId);
        const targetIndex = order.indexOf(targetId);
        if (targetIndex < 0) return;
        order.splice(targetIndex, 0, sourceId);
        current.content.sectionOrder = order;
        pinRequiredSections();
        queueSave(shell);
        renderEditor(shell);
    };
    shell.querySelectorAll("[data-module]").forEach(button => {
        button.addEventListener("dragstart", event => { draggedId = button.dataset.module; if (["general", "presentation"].includes(draggedId)) { event.preventDefault(); draggedId = ""; return; } event.dataTransfer.effectAllowed = "move"; button.classList.add("dragging"); });
        button.addEventListener("dragend", clearDragState);
        button.addEventListener("dragover", event => { if (!draggedId || draggedId === button.dataset.module) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; button.classList.add("drop-target"); });
        button.addEventListener("dragleave", () => button.classList.remove("drop-target"));
        button.addEventListener("drop", event => { event.preventDefault(); const sourceId = draggedId; clearDragState(); reorder(sourceId, button.dataset.module); });
    });
    navigation?.addEventListener("pointerdown", event => {
        const button = event.target.closest("[data-module]");
        if (!button || event.pointerType === "mouse" || ["general", "presentation"].includes(button.dataset.module)) return;
        touchTargetId = button.dataset.module;
        touchStart = { x: event.clientX, y: event.clientY };
        navigation.setPointerCapture?.(event.pointerId);
        touchTimer = setTimeout(() => { touchDragging = true; button.classList.add("dragging"); }, 350);
    });
    navigation?.addEventListener("pointermove", event => {
        if (!touchTargetId || !touchStart) return;
        if (!touchDragging && Math.hypot(event.clientX - touchStart.x, event.clientY - touchStart.y) > 10) { clearTimeout(touchTimer); touchTargetId = ""; return; }
        if (!touchDragging) return;
        event.preventDefault();
        const target = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-module]");
        if (!target || target.dataset.module === touchTargetId || ["general", "presentation"].includes(target.dataset.module)) return;
        shell.querySelectorAll("[data-module]").forEach(item => item.classList.toggle("drop-target", item === target));
    });
    navigation?.addEventListener("pointerup", event => {
        if (!touchDragging) return clearDragState();
        const sourceId = touchTargetId;
        const targetId = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-module]")?.dataset.module || "";
        navigation.releasePointerCapture?.(event.pointerId);
        clearDragState();
        reorder(sourceId, targetId);
    });
    navigation?.addEventListener("pointercancel", clearDragState);
}

function restoreModuleNavigation(shell, activeKey) {
    const navigation = shell.querySelector(".report-module-nav");
    if (!navigation) return;
    navigation.scrollLeft = moduleNavScrollLeft;
    navigation.addEventListener("scroll", () => { moduleNavScrollLeft = navigation.scrollLeft; }, { passive: true });
    requestAnimationFrame(() => {
        const active = navigation.querySelector(`[data-module="${CSS.escape(activeKey)}"]`);
        if (!active) return;
        const left = active.offsetLeft;
        const right = left + active.offsetWidth;
        if (left < navigation.scrollLeft) navigation.scrollLeft = left;
        else if (right > navigation.scrollLeft + navigation.clientWidth) navigation.scrollLeft = right - navigation.clientWidth;
        moduleNavScrollLeft = navigation.scrollLeft;
    });
}

function bindPageSwipe(shell, moduleKey) {
    const page = shell.querySelector(".report-editor-main");
    if (!page) return;
    let startX = 0, startY = 0;
    page.addEventListener("touchstart", event => { if (event.target.closest("textarea,input,button,label")) return; const touch = event.touches[0]; startX = touch.clientX; startY = touch.clientY; }, { passive: true });
    page.addEventListener("touchend", event => { if (!startX) return; const touch = event.changedTouches[0], deltaX = touch.clientX - startX, deltaY = touch.clientY - startY; startX = 0; if (Math.abs(deltaX) < 70 || Math.abs(deltaX) < Math.abs(deltaY)) return; const index = moduleIndex(moduleKey); openModule(shell, visibleSections()[deltaX < 0 ? index + 1 : index - 1]?.id); }, { passive: true });
}

function openReportProofreading(shell) {
    if (!editable() || !canProofreadReport()) return;
    document.querySelector(".report-proofreading-dialog")?.remove();
    const entries = collectReportObservations();
    if (!entries.length) return alert("Ajoutez au moins une observation avant de lancer la correction orthographique.");
    const dialog = document.createElement("section");
    dialog.className = "report-proofreading-dialog";
    const originalTexts = entries.map(entry => entry.observation.text || "");
    dialog.innerHTML = `<form><header><div><p class="eyebrow">Correction sur poste administratif</p><h2>Correction du rapport et aperçu PDF en direct</h2></div><button type="button" class="text-button" data-close-proofreading>Fermer</button></header><p class="report-proofreading-help">À gauche, corrigez les textes, ajoutez des lignes avec la touche Entrée et ajustez les photos. À droite, le PDF se remet à jour automatiquement après vos modifications sans perdre la page consultée.</p><div class="report-proofreading-workspace"><section class="report-proofreading-editor" aria-label="Contenu du rapport à corriger"><div class="report-proofreading-panel-heading"><strong>Rapport à corriger</strong><span>Orthographe, textes et photos</span></div><div class="report-proofreading-list"></div></section><section class="report-proofreading-live-preview" aria-label="Aperçu PDF en direct"><div class="report-proofreading-panel-heading"><strong>Aperçu PDF en direct</strong><span data-proofreading-preview-state>Génération de l’aperçu…</span></div><div class="report-proofreading-pdf-pages" role="document" aria-label="Pages du rapport PDF"></div></section></div><p class="auth-message" aria-live="polite"></p><div class="report-proofreading-actions"><button type="button" class="secondary-button" data-close-proofreading>Annuler</button><button type="submit" class="secondary-button report-primary-action">Enregistrer la correction et préparer l’envoi</button></div></form>`;
    document.body.append(dialog);
    let previewTimer = null;
    let previewRequest = null;
    let previewSequence = 0;
    const close = () => { clearTimeout(previewTimer); previewRequest?.abort(); dialog.remove(); };
    const cancel = async () => { entries.forEach((entry, index) => { entry.observation.text = originalTexts[index]; }); clearTimeout(saveTimer); close(); await save(shell, true); };
    const syncTexts = () => entries.forEach((entry, index) => { const input = dialog.querySelector(`[data-proofreading-entry="${index}"]`); if (input) entry.observation.text = input.value; });
    const refreshPdfPreview = async () => {
        if (!dialog.isConnected) return;
        syncTexts();
        const state = dialog.querySelector("[data-proofreading-preview-state]");
        const preview = dialog.querySelector(".report-proofreading-pdf-pages");
        const sequence = ++previewSequence;
        state.textContent = "Mise à jour…";
        previewRequest?.abort();
        previewRequest = new AbortController();
        try {
            await Promise.all([...mediaSavePromises]);
            const response = await fetch(`/api/technical-reports/${encodeURIComponent(current.id)}/pdf-preview`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ appointmentId: current.appointmentId, clientId: current.clientId, title: current.title, reportDate: current.reportDate, content: current.content }), signal: previewRequest.signal });
            if (!response.ok) { const error = await response.json().catch(() => null); throw new Error(error?.message || "Aperçu PDF indisponible."); }
            const blob = await response.blob();
            if (!dialog.isConnected || sequence !== previewSequence) return;
            await renderLivePdfPreview(blob, preview, previewRequest.signal);
            if (!dialog.isConnected || sequence !== previewSequence) return;
            state.textContent = `Actualisé à ${new Intl.DateTimeFormat("fr-FR", { timeStyle: "short" }).format(new Date())}`;
        } catch (error) {
            if (error.name !== "AbortError" && dialog.isConnected && sequence === previewSequence) state.textContent = error.message || "Aperçu PDF indisponible.";
        }
    };
    const queuePdfPreview = (delay = 500) => { clearTimeout(previewTimer); const sequence = ++previewSequence; previewTimer = window.setTimeout(() => { if (sequence === previewSequence) refreshPdfPreview(); }, delay); };
    const renderList = () => {
        const list = dialog.querySelector(".report-proofreading-list");
        const additionalGroups = proofreadingAdditionalPhotoGroups(entries);
        list.innerHTML = `${entries.map((entry, index) => `<article class="report-proofreading-entry"><label><span>${escapeHtml(entry.sectionTitle)}</span><strong>${escapeHtml(entry.observationLabel)}</strong><textarea rows="5" lang="fr" spellcheck="true" autocapitalize="sentences" data-proofreading-entry="${index}">${escapeHtml(entry.observation.text || "")}</textarea></label>${photosHtml(entry.sectionId, entry.observation.id, true, "", false, entry.materialId, false, true)}</article>`).join("")}${additionalGroups.map(group => `<article class="report-proofreading-entry report-proofreading-photo-group"><span>${escapeHtml(group.sectionTitle)}</span><strong>${escapeHtml(group.label)}</strong>${photosHtml(group.sectionId, group.observationId, true, "", false, group.materialId, false, true)}</article>`).join("")}`;
        list.querySelectorAll("[data-proofreading-entry]").forEach(input => input.addEventListener("input", () => { syncTexts(); markReportModified(shell); queuePdfPreview(); }));
        list.querySelectorAll("[data-open-photo]").forEach(button => button.addEventListener("click", () => openPhotoPreview(button.dataset.openPhoto)));
        list.querySelectorAll("[data-photo-caption]").forEach(input => input.addEventListener("change", async () => { const operation = updatePhotoCaption(input, shell); trackMediaSave(operation); await operation; queuePdfPreview(0); }));
        list.querySelectorAll("[data-photo-pdf-size]").forEach(input => input.addEventListener("change", async () => { const operation = updatePhotoPdfSize(input, shell); trackMediaSave(operation); await operation; queuePdfPreview(0); }));
        const refreshMedia = () => { renderList(); queuePdfPreview(0); };
        list.querySelectorAll("[data-photo-source]").forEach(button => button.addEventListener("click", () => { syncTexts(); openPhotoSource(shell, { moduleKey: button.dataset.moduleKey, observationId: button.dataset.observationId, materialId: button.dataset.materialId, replacePhotoId: button.dataset.replacePhoto || "" }, refreshMedia); }));
        list.querySelectorAll("[data-delete-photo]").forEach(button => button.addEventListener("click", () => { syncTexts(); trackMediaSave(deletePhoto(button.dataset.deletePhoto, shell, refreshMedia)); }));
        list.querySelectorAll("[data-move-photo]").forEach(button => button.addEventListener("click", () => { syncTexts(); trackMediaSave(movePhoto(button.dataset.photoId, button.dataset.movePhoto, shell, refreshMedia)); }));
    };
    renderList();
    queuePdfPreview(0);
    dialog.querySelectorAll("[data-close-proofreading]").forEach(button => button.addEventListener("click", () => cancel()));
    dialog.addEventListener("click", event => { if (event.target === dialog) cancel(); });
    dialog.querySelector("textarea")?.focus();
    dialog.querySelector("form").addEventListener("submit", async event => {
        event.preventDefault();
        const submit = dialog.querySelector('button[type="submit"]');
        const feedback = dialog.querySelector(".auth-message");
        if (!editable()) {
            feedback.textContent = "Le verrou du rapport a expiré. Reprenez la main avant d’enregistrer.";
            feedback.classList.add("error");
            return;
        }
        submit.disabled = true;
        feedback.classList.remove("error");
        feedback.textContent = "Enregistrement de la correction…";
        syncTexts();
        clearTimeout(saveTimer);
        while (saving) await new Promise(resolve => window.setTimeout(resolve, 50));
        await Promise.all([...mediaSavePromises]);
        const result = await api(`/api/technical-reports/${encodeURIComponent(current.id)}/proofread`, { method: "POST", body: JSON.stringify({ appointmentId: current.appointmentId, clientId: current.clientId, title: current.title, reportDate: current.reportDate, content: current.content }) });
        if (!result.ok) {
            entries.forEach((entry, index) => { entry.observation.text = originalTexts[index]; });
            if (result.data?.lock) reportLock = result.data.lock;
            feedback.textContent = result.message || "Impossible de confirmer les corrections. Vérifiez votre connexion et réessayez.";
            feedback.classList.add("error");
            submit.disabled = false;
            return;
        }
        current.proofreadCurrent = true;
        current.proofreadAt = result.data?.proofreadAt || new Date().toISOString();
        current.status = "ready_to_send";
        close();
        renderEditor(shell);
    });
}

function collectReportObservations() {
    const entries = [];
    for (const section of visibleSections()) {
        if (isSkipped(section.id) || ["general", "presentation"].includes(section.id)) continue;
        if (section.id === "methods" && !section.custom) {
            for (const material of current.content.methods.materials || []) {
                (material.observations || []).forEach((observation, index) => entries.push({ sectionId: section.id, materialId: material.id, sectionTitle: `${section.title} — ${materialLabel(material)}`, observationLabel: `Observation ${index + 1}`, observation }));
            }
            continue;
        }
        (sectionContent(section.id)?.observations || []).forEach((observation, index) => entries.push({ sectionId: section.id, materialId: "", sectionTitle: section.title, observationLabel: `Observation ${index + 1}`, observation }));
    }
    return entries;
}

function proofreadingAdditionalPhotoGroups(entries) {
    const covered = new Set(entries.map(entry => `${entry.sectionId}|${entry.observation.id}|${entry.materialId}`));
    const groups = new Map();
    for (const photo of current.media || []) {
        const key = `${photo.section || ""}|${photo.observationId || ""}|${photo.materialId || ""}`;
        if (covered.has(key)) continue;
        if (!groups.has(key)) groups.set(key, { sectionId: photo.section || "general", observationId: photo.observationId || "", materialId: photo.materialId || "", sectionTitle: moduleDefinition(photo.section)?.[1] || "Photos du rapport", label: photo.section === "presentation" ? "Photo de présentation" : "Photos de la page" });
    }
    return [...groups.values()];
}

function openModule(shell, key) {
    if (!visibleSections().some(section => section.id === key)) return;
    current.content.activeStep = key;
    queueSave(shell, false);
    renderEditor(shell);
}

function toggleMaterial(name, selected, shell) { const materials = current.content.methods.materials; const index = materials.findIndex(item => item.name === name); if (selected && index < 0) materials.push({ id: newMaterialId(), name, customName: "", observations: [] }); if (!selected && index >= 0) { const material = materials[index]; if ((material.observations.length || (current.media || []).some(photo => photo.materialId === material.id)) && !confirm("Supprimer ce matériel, toutes ses observations et ses photos ?")) { renderEditor(shell); return; } removeMaterial(material.id).then(removed => { if (!removed) return; queueSave(shell); renderEditor(shell); }); return; } queueSave(shell); renderEditor(shell); }
function materialById(id) { return (current.content.methods.materials || []).find(material => material.id === id); }
function selectedMaterial() { return materialById(current.content.activeMaterialId); }
function materialLabel(material) { return material?.name === "Autre matériel" ? material.customName?.trim() || "Autre matériel" : material?.name || "Matériel technique"; }
function findObservation(moduleKey, id, materialId = "") { const items = materialId ? materialById(materialId)?.observations || [] : sectionContent(moduleKey).observations; return items.find(observation => observation.id === id); }
async function removeObservation(moduleKey, id, materialId = "") { const photos = (current.media || []).filter(photo => photo.section === moduleKey && String(photo.observationId || "") === String(id) && String(photo.materialId || "") === String(materialId || "")); const deleted = await Promise.all(photos.map(photo => api(`/api/technical-reports/${encodeURIComponent(current.id)}/media/${encodeURIComponent(photo.id)}`, { method: "DELETE" }))); if (deleted.some(result => !result.ok)) { alert("Une ou plusieurs photos n’ont pas pu être supprimées."); return false; } const material = materialById(materialId); const items = material ? material.observations : sectionContent(moduleKey).observations; if (material) material.observations = items.filter(observation => observation.id !== id); else sectionContent(moduleKey).observations = items.filter(observation => observation.id !== id); current.media = (current.media || []).filter(photo => !(photo.section === moduleKey && String(photo.observationId || "") === String(id) && String(photo.materialId || "") === String(materialId || ""))); return true; }
async function removeMaterial(id) { const material = materialById(id); if (!material) return true; const photos = (current.media || []).filter(photo => String(photo.materialId || "") === String(id)); const deleted = await Promise.all(photos.map(photo => api(`/api/technical-reports/${encodeURIComponent(current.id)}/media/${encodeURIComponent(photo.id)}`, { method: "DELETE" }))); if (deleted.some(result => !result.ok)) { alert("Une ou plusieurs photos n’ont pas pu être supprimées."); return false; } current.content.methods.materials = current.content.methods.materials.filter(item => item.id !== id); current.media = (current.media || []).filter(photo => String(photo.materialId || "") !== String(id)); if (current.content.activeMaterialId === id) current.content.activeMaterialId = ""; return true; }
function moveObservation(moduleKey, id, direction, materialId = "") { const material = materialById(materialId); const items = material ? material.observations : sectionContent(moduleKey).observations; const index = items.findIndex(observation => observation.id === id); const next = direction === "up" ? index - 1 : index + 1; if (index < 0 || next < 0 || next >= items.length) return; [items[index], items[next]] = [items[next], items[index]]; }

function openPhotoSource(shell, context, refresh = () => renderEditor(shell)) {
    const existing = document.querySelector(".report-photo-source-dialog"); if (existing) existing.remove();
    const dialog = document.createElement("section"); dialog.className = "report-photo-source-dialog";
    dialog.innerHTML = `<div><header><h3>${context.replacePhotoId ? "Remplacer la photo" : "Ajouter une photo"}</h3><button type="button" class="text-button" data-close-photo-source>Fermer</button></header><p>Choisissez la source de l’image.</p><div class="report-photo-source-actions"><label>Prendre une photo<input type="file" accept="image/*" capture="environment" data-camera-source></label><label>Choisir dans la galerie<input type="file" accept="image/*" ${context.singlePhoto || context.replacePhotoId ? "" : "multiple"} data-gallery-source></label></div></div>`;
    document.body.append(dialog); dialog.querySelector("[data-close-photo-source]").addEventListener("click", () => dialog.remove());
    ["[data-camera-source]", "[data-gallery-source]"].forEach(selector => dialog.querySelector(selector).addEventListener("change", async event => { const files = [...event.target.files || []]; if (!files.length) return; dialog.remove(); const operation = context.replacePhotoId ? replacePhoto(context.replacePhotoId, files[0], shell, refresh) : uploadPhotos(files, context, shell, refresh); trackMediaSave(operation); await operation; }));
}

function openPhotoPreview(photoId) { const photo = (current.media || []).find(item => item.id === photoId); if (!photo) return; const dialog = document.createElement("section"); dialog.className = "report-photo-preview-dialog"; dialog.innerHTML = `<div><button type="button" class="text-button" data-close-photo-preview>Fermer</button><img src="${escapeHtml(photo.dataUrl)}" alt="Photo du rapport agrandie"></div>`; document.body.append(dialog); dialog.addEventListener("click", event => { if (event.target === dialog || event.target.matches("[data-close-photo-preview]")) dialog.remove(); }); }

async function uploadPhotos(files, context, shell, refresh = () => renderEditor(shell)) {
    if (!files.length) return;
    const optimized = await optimizeImages(files);
    if (!optimized.length) return;
    const data = new FormData();
    optimized.forEach(file => data.append("files", file));
    data.append("section", context.moduleKey);
    data.append("observationId", context.observationId || "");
    data.append("materialId", context.materialId || "");
    const result = await upload(`/api/technical-reports/${encodeURIComponent(current.id)}/media`, data);
    if (!result.ok) return alert(result.message || "Ajout des photos impossible.");
    current.media.push(...(result.data.media || []));
    markReportModified(shell);
    refresh();
}

async function replacePresentationPhoto(file, shell) {
    if (!file) return;
    const photo = orderedPhotos((current.media || []).filter(item => item.section === "presentation"))[0];
    if (photo) return replacePhoto(photo.id, file, shell);
    await uploadPhotos([file], { moduleKey: "presentation", observationId: "", materialId: "" }, shell);
}

async function updatePhotoCaption(input, shell) {
    const photo = (current.media || []).find(item => item.id === input.dataset.photoCaption);
    if (!photo) return;
    photo.caption = input.value;
    const result = await api(`/api/technical-reports/${encodeURIComponent(current.id)}/media/${encodeURIComponent(photo.id)}`, { method: "PATCH", body: JSON.stringify({ caption: photo.caption, annotation: photo.annotation || "", observationId: photo.observationId || "", materialId: photo.materialId || "" }) });
    if (!result.ok) alert(result.message || "Mise à jour de la photo impossible.");
    else markReportModified(shell);
}

async function updatePhotoPdfSize(input, shell) {
    const photo = (current.media || []).find(item => item.id === input.dataset.photoPdfSize);
    if (!photo || !["compact", "medium", "large"].includes(input.value)) return;
    photo.pdfSize = input.value;
    const result = await api(`/api/technical-reports/${encodeURIComponent(current.id)}/media/${encodeURIComponent(photo.id)}`, { method: "PATCH", body: JSON.stringify({ caption: photo.caption || "", annotation: photo.annotation || "", observationId: photo.observationId || "", materialId: photo.materialId || "", sortOrder: photo.sortOrder, pdfSize: photo.pdfSize }) });
    if (!result.ok) alert(result.message || "Mise à jour de la taille de la photo impossible.");
    else markReportModified(shell);
}

function trackMediaSave(promise) {
    mediaSavePromises.add(promise);
    promise.finally(() => mediaSavePromises.delete(promise));
}

async function replacePhoto(id, file, shell, refresh = () => renderEditor(shell)) { const photo = (current.media || []).find(item => item.id === id); if (!photo) return false; const [optimized] = await optimizeImages([file]); if (!optimized) return false; const dataUrl = await fileDataUrl(optimized); const result = await api(`/api/technical-reports/${encodeURIComponent(current.id)}/media/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ caption: photo.caption || "", annotation: photo.annotation || "", observationId: photo.observationId || "", materialId: photo.materialId || "", dataUrl, name: optimized.name, mime: optimized.type, size: optimized.size }) }); if (!result.ok) { alert(result.message || "Remplacement impossible."); return false; } photo.dataUrl = dataUrl; photo.name = optimized.name; photo.mime = optimized.type; photo.size = optimized.size; markReportModified(shell); refresh(); return true; }

async function movePhoto(id, direction, shell, refresh = () => renderEditor(shell)) { const photo = (current.media || []).find(item => item.id === id); if (!photo) return false; const siblings = orderedPhotos((current.media || []).filter(item => item.section === photo.section && String(item.observationId || "") === String(photo.observationId || "") && String(item.materialId || "") === String(photo.materialId || ""))); const index = siblings.findIndex(item => item.id === id); const other = siblings[direction === "up" ? index - 1 : index + 1]; if (!other) return false; const photoOrder = Number(photo.sortOrder || index); photo.sortOrder = Number(other.sortOrder || (direction === "up" ? index - 1 : index + 1)); other.sortOrder = photoOrder; const results = await Promise.all([photo, other].map(item => api(`/api/technical-reports/${encodeURIComponent(current.id)}/media/${encodeURIComponent(item.id)}`, { method: "PATCH", body: JSON.stringify({ caption: item.caption || "", annotation: item.annotation || "", observationId: item.observationId || "", materialId: item.materialId || "", sortOrder: item.sortOrder }) }))); if (results.some(result => !result.ok)) { alert("Réorganisation impossible."); return false; } markReportModified(shell); refresh(); return true; }

async function optimizeImages(files) { const optimized = []; for (const file of files) { try { if (!file.type.startsWith("image/") || !window.createImageBitmap) { optimized.push(file); continue; } const bitmap = await createImageBitmap(file); const scale = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height)); const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale)); canvas.getContext("2d", { alpha: false }).drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close?.(); const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .84)); optimized.push(blob ? new File([blob], `${file.name.replace(/\.[^.]+$/, "") || "photo"}.jpg`, { type: "image/jpeg" }) : file); } catch { optimized.push(file); } } return optimized; }
function fileDataUrl(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result || "")); reader.onerror = reject; reader.readAsDataURL(file); }); }
function orderedPhotos(photos) { return [...photos].sort((left, right) => Number(left.sortOrder || 0) - Number(right.sortOrder || 0) || String(left.createdAt || "").localeCompare(String(right.createdAt || ""))); }

async function deletePhoto(id, shell, refresh = () => renderEditor(shell)) {
    if (!confirm("Supprimer cette photo ?")) return false;
    const result = await api(`/api/technical-reports/${encodeURIComponent(current.id)}/media/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!result.ok) { alert(result.message || "Suppression impossible."); return false; }
    current.media = current.media.filter(photo => photo.id !== id);
    markReportModified(shell);
    refresh();
    return true;
}

function queueSave(shell, affectsReport = true) {
    if (!editable()) return;
    if (affectsReport) markReportModified(shell);
    clearTimeout(saveTimer);
    const state = shell.querySelector("[data-save-state]");
    if (state) state.textContent = "Enregistrement…";
    saveTimer = setTimeout(() => save(shell, true), 650);
}

function markReportModified(shell) {
    if (!current) return;
    current.proofreadCurrent = false;
}

async function save(shell, silent = false) {
    if (!editable() || saving) return false;
    saving = true;
    await Promise.all([...mediaSavePromises]);
    const result = await api(`/api/technical-reports/${encodeURIComponent(current.id)}`, { method: "PUT", body: JSON.stringify({ appointmentId: current.appointmentId, clientId: current.clientId, title: current.title, reportDate: current.reportDate, content: current.content }) });
    saving = false;
    if (!result.ok) {
        if (result.data?.lock) reportLock = result.data.lock;
        if (!silent) alert(result.message || "Enregistrement impossible.");
        return false;
    }
    const state = shell.querySelector("[data-save-state]");
    if (state) state.textContent = `Enregistré à ${new Intl.DateTimeFormat("fr-FR", { timeStyle: "short" }).format(new Date())}`;
    return true;
}

async function submitReport(shell) {
    if (!await save(shell)) return;
    if (!confirm("Terminer ce rapport et le transmettre au poste administratif pour correction ?")) return;
    const result = await api(`/api/technical-reports/${encodeURIComponent(current.id)}/submit`, { method: "POST" });
    if (!result.ok) return alert(result.message || "Envoi impossible.");
    await loadReport(current.id);
    renderEditor(shell);
}

async function validateReport(shell) {
    if (current.status !== "ready_to_send" || !canFinalizeReport()) return alert("Ce rapport doit d’abord être corrigé sur un poste administratif.");
    if (!confirm("Valider définitivement le rapport, générer son PDF officiel et l’envoyer ?")) return;
    const result = await api(`/api/technical-reports/${encodeURIComponent(current.id)}/validate`, { method: "POST" });
    if (!result.ok) return alert(result.message || "Validation impossible.");
    await completeValidatedReport(result.data || {});
}

async function finalizePreview(shell) {
    if (current.status !== "ready_to_send" || !canFinalizeReport()) return alert("Ce rapport doit d’abord être corrigé sur un poste administratif.");
    if (!confirm("Valider définitivement ce rapport et archiver son PDF dans le dossier client ?")) return;
    const result = await api(`/api/technical-reports/${encodeURIComponent(current.id)}/validate`, { method: "POST" });
    if (!result.ok) return alert(result.message || "Validation impossible.");
    await completeValidatedReport(result.data || {});
}

async function completeValidatedReport(validation) {
    const reportId = validation.reportId || current.id;
    const clientId = validation.clientId || current.clientId || "";
    const attachmentId = validation.attachmentId || "";
    const recipient = current.content?.snapshot?.clientEmail || "";
    await leaveReport();
    const { synchronizeClients } = await import("./client-sync.js?v=125");
    await synchronizeClients();
    window.dispatchEvent(new CustomEvent("depannhome:technical-report-validated", { detail: { reportId, clientId, suppressNavigation: true } }));
    if (clientId) window.dispatchEvent(new CustomEvent("depannhome:open-client", { detail: { clientId } }));
    openDocumentDeliveryChoice({
        label: `Rapport de recherche de fuite n° ${reportId}`,
        recipient,
        printUrl: `/api/technical-reports/${encodeURIComponent(reportId)}/pdf`,
        sendEmail: async email => {
            if (!clientId || !attachmentId) throw new Error("Le rapport n’est pas disponible dans la fiche client pour l’envoi.");
            const response = await fetch(`/api/clients/${encodeURIComponent(clientId)}/attachments/${encodeURIComponent(attachmentId)}/email`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ recipient: email }) });
            const data = await response.json().catch(() => null);
            if (!response.ok) throw new Error(data?.message || "Envoi du rapport impossible.");
        }
    });
}

async function requestCorrection(shell) {
    const section = prompt(`Module à corriger (${moduleKeys().join(", ")}) :`, current.content.activeStep);
    if (!section || !moduleKeys().includes(section)) return alert("Choisissez un module valide.");
    const comment = prompt("Commentaire à transmettre au technicien :");
    if (!comment?.trim()) return;
    const result = await api(`/api/technical-reports/${encodeURIComponent(current.id)}/corrections`, { method: "POST", body: JSON.stringify({ section, comment }) });
    if (!result.ok) return alert(result.message || "Demande de correction impossible.");
    await loadReport(current.id);
    renderEditor(shell);
}

async function reopenReport(shell) {
    if (!confirm("Réouvrir ce rapport supprimera son PDF officiel afin de permettre une nouvelle édition.")) return;
    const lock = await acquireReportLock(current.id);
    if (!lock.ok) return alert(lock.message || "Réouverture impossible : le rapport est utilisé par un autre membre.");
    reportLock = lock.data?.lock || reportLock;
    const result = await api(`/api/technical-reports/${encodeURIComponent(current.id)}/reopen`, { method: "POST" });
    if (!result.ok) return alert(result.message || "Réouverture impossible.");
    await loadReport(current.id);
    renderEditor(shell);
}

async function cancelReport(shell) {
    if (!canCancelReport() || current.status !== "draft") return;
    if (!confirm("Annuler définitivement ce rapport créé par erreur ? Les photos et le contenu du brouillon seront supprimés. L’intervention et la fiche client seront conservées.")) return;
    const result = await api(`/api/technical-reports/${encodeURIComponent(current.id)}`, { method: "DELETE" });
    if (!result.ok) return alert(result.message || "Annulation du rapport impossible.");
    await leaveReport();
    await renderLeakReportWizard();
}

async function exitReportToHome(shell) {
    stopTimers();
    while (saving) await new Promise(resolve => window.setTimeout(resolve, 50));
    if (editable() && !await save(shell)) {
        startTimers(shell);
        alert("Impossible d’enregistrer le rapport. Restez sur cette page et réessayez.");
        return;
    }
    await leaveReport();
    window.dispatchEvent(new CustomEvent("depannhome:open-home"));
}

function startTimers(shell) {
    stopTimers();
    if (!ownsLock()) return;
    const heartbeatDelay = document.body.classList.contains("mobile-device") ? 20000 : 30000;
    heartbeatTimer = window.setInterval(async () => {
        if (heartbeatRunning || !current) return;
        heartbeatRunning = true;
        const reportId = current.id;
        try {
            const result = await heartbeatReportLock(reportId);
            if (!current || String(current.id) !== String(reportId)) return;
            if (result.ok) {
                reportLock = result.data?.lock || reportLock;
                return;
            }
            const recovery = await acquireLock();
            if (recovery?.ok && recovery.data?.acquired) {
                startTimers(shell);
                return;
            }
            if (recovery?.data?.lock) {
                stopTimers();
                renderEditor(shell);
            }
        } finally {
            heartbeatRunning = false;
        }
    }, heartbeatDelay);
    if (editable()) periodicTimer = window.setInterval(() => save(shell, true), 5000);
}

function stopTimers() { clearTimeout(saveTimer); clearInterval(heartbeatTimer); clearInterval(periodicTimer); saveTimer = heartbeatTimer = periodicTimer = null; }
async function leaveReport() { stopTimers(); clearReportPreviewUrl(); if (current && ownsLock()) await releaseReportLock(current.id); current = null; reportLock = null; previewMode = false; document.body.classList.remove("report-writing-active"); }
async function forceTakeover() { if (!isAdministrator() || !confirm("Reprendre la main sur ce rapport ?")) return; const result = await forceReleaseReportLock(current.id, "Reprise de l’édition du rapport"); if (!result.ok) return alert(result.message || "Reprise impossible."); await acquireLock(); const shell = document.querySelector(".report-editor-shell"); if (shell) renderEditor(shell); }

async function recoverReportLock() {
    if (lockRecoveryPromise || document.visibilityState === "hidden" || !current) return lockRecoveryPromise;
    const shell = document.querySelector(".report-editor-shell");
    if (!shell) return null;
    const reportId = current.id;
    lockRecoveryPromise = (async () => {
        while (saving) await new Promise(resolve => window.setTimeout(resolve, 50));
        const result = await acquireLock();
        if (!current || String(current.id) !== String(reportId)) return;
        if (result?.ok && result.data?.acquired) {
            startTimers(shell);
            await save(shell, true);
            renderEditor(shell);
        } else if (result?.data?.lock) {
            stopTimers();
            renderEditor(shell);
        }
    })().finally(() => { lockRecoveryPromise = null; });
    return lockRecoveryPromise;
}

function bindCollaborationEvents() {
    if (eventsBound) return;
    eventsBound = true;
    const saveOnExit = () => { const shell = document.querySelector(".report-editor-shell"); if (shell && editable()) save(shell, true); };
    window.addEventListener("pagehide", saveOnExit);
    window.addEventListener("pageshow", () => recoverReportLock());
    window.addEventListener("online", () => recoverReportLock());
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveOnExit(); else recoverReportLock(); });
    window.addEventListener("depannhome:collaboration-event", async event => {
        const detail = event.detail || {};
        if (!current || detail.entityType !== "technical_report" || String(detail.entityId) !== String(current.id) || ownsLock()) return;
        if (!["report_saved", "report_media_added", "report_media_updated", "report_media_deleted", "report_proofread", "report_submitted", "report_correction_requested", "report_validated", "report_reopened", "lock_force_released"].includes(detail.type)) return;
        const result = await api(`/api/technical-reports/${encodeURIComponent(current.id)}`);
        if (!result.ok) return;
        current = result.data.report; corrections = result.data.corrections || []; reportLock = result.data.lock || null; ensureModularContent();
        const shell = document.querySelector(".report-editor-shell");
        if (shell) renderEditor(shell);
    });
}

function pinRequiredSections() { if (!current?.content) return; const order = current.content.sectionOrder || []; ["presentation", "general"].forEach(id => { const index = order.indexOf(id); if (index >= 0) order.splice(index, 1); }); current.content.sectionOrder = ["general", "presentation", ...order]; current.content.removedSections = (current.content.removedSections || []).filter(id => !["general", "presentation"].includes(id)); }
function sectionEntries() { const custom = new Map((current?.content?.customSections || []).map(section => [section.id, section])); const defaults = new Map(MODULES.map(section => [section[0], section])); return (current?.content?.sectionOrder || moduleKeys()).map(id => { const duplicate = custom.get(id); const base = defaults.get(id); const source = defaults.get(duplicate?.sourceKey || id) || MODULES[1]; return duplicate ? { id, title: duplicate.title, description: `Copie de « ${source[1]} »`, custom: true } : { id, title: current.content.sectionTitles?.[id] || base?.[1] || "Section", description: base?.[2] || "Section du rapport", custom: false }; }).filter(section => section.id); }
function visibleSections() { return sectionEntries().filter(section => !(current.content.removedSections || []).includes(section.id)); }
function sectionContent(key) { const duplicate = (current.content.customSections || []).find(section => section.id === key); return duplicate ? duplicate.content : current.content[key]; }
function moduleDefinition(key) { const section = sectionEntries().find(item => item.id === key); return section ? [section.id, section.title, section.description, section.custom] : MODULES[1]; }
function moduleKeys() { return [...MODULES.map(([key]) => key), ...(current?.content?.customSections || []).map(section => section.id)]; }
function moduleIndex(key) { return visibleSections().findIndex(section => section.id === key); }
function moduleNumber(key) { return Math.max(1, moduleIndex(key) + 1); }
function isSkipped(key) { return (current.content.skippedSteps || []).includes(key); }
function moduleUsed(key) { const content = sectionContent(key) || { observations: [] }; return key === "general" || key === "methods" && current.content.methods.materials.length > 0 || (current.media || []).some(photo => photo.section === key) || !isSkipped(key) && (content.observations || []).length > 0; }
function renameSection(id, title) { const value = String(title || "").trim().slice(0, 160); const duplicate = (current.content.customSections || []).find(section => section.id === id); if (duplicate) duplicate.title = value || "Section"; else if (value) current.content.sectionTitles[id] = value; }
function moveSection(id, direction) { if (["general", "presentation"].includes(id)) return; const order = current.content.sectionOrder; const index = order.indexOf(id); const target = direction === "up" ? index - 1 : index + 1; if (index < 0 || target < 2 || target >= order.length) return; [order[index], order[target]] = [order[target], order[index]]; }
function nextSectionId() { return `section-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
async function duplicateSection(id, shell) { const source = sectionContent(id); if (!source) return; const sourceDefinition = moduleDefinition(id); const duplicateNumber = (current.content.customSections || []).filter(section => section.sourceKey === (sourceDefinition[3] ? (current.content.customSections.find(item => item.id === id)?.sourceKey || "overview") : id)).length + 2; const targetId = nextSectionId(); const sourceKey = sourceDefinition[3] ? current.content.customSections.find(item => item.id === id)?.sourceKey || "overview" : id; current.content.customSections.push({ id: targetId, sourceKey, title: `${sourceDefinition[1]} (${duplicateNumber})`, content: { observations: JSON.parse(JSON.stringify(source.observations || [])) } }); const index = current.content.sectionOrder.indexOf(id); current.content.sectionOrder.splice(index + 1, 0, targetId); current.content.activeStep = targetId; if (!await save(shell, true)) return; const result = await api(`/api/technical-reports/${encodeURIComponent(current.id)}/sections/${encodeURIComponent(id)}/duplicate-media`, { method: "POST", body: JSON.stringify({ targetSection: targetId }) }); if (result.ok) current.media.push(...(result.data.media || [])); else alert(result.message || "La section a été copiée, mais ses photos n’ont pas pu être dupliquées."); renderEditor(shell); }
async function deleteSection(id, shell) { if (["general", "presentation"].includes(id)) return; const section = moduleDefinition(id); const previousIndex = moduleIndex(id); if (!confirm(`Supprimer la section « ${section[1]} » ? Elle ne figurera plus dans le rapport ni dans le PDF.`)) return; const photos = (current.media || []).filter(photo => photo.section === id); const deleted = await Promise.all(photos.map(photo => api(`/api/technical-reports/${encodeURIComponent(current.id)}/media/${encodeURIComponent(photo.id)}`, { method: "DELETE" }))); if (deleted.some(result => !result.ok)) return alert("Les photos de cette section n’ont pas toutes pu être supprimées."); current.media = current.media.filter(photo => photo.section !== id); const customIndex = (current.content.customSections || []).findIndex(section => section.id === id); if (customIndex >= 0) { current.content.customSections.splice(customIndex, 1); current.content.sectionOrder = current.content.sectionOrder.filter(sectionId => sectionId !== id); } else current.content.removedSections = [...new Set([...(current.content.removedSections || []), id])]; current.content.activeStep = visibleSections()[Math.max(0, previousIndex - 1)]?.id || visibleSections()[0]?.id || "general"; queueSave(shell); renderEditor(shell); }
function openReportSummary(shell) { const dialog = document.createElement("section"); dialog.className = "report-summary-dialog"; const render = () => { dialog.innerHTML = `<div><header><div><p class="eyebrow">Navigation du rapport</p><h2>Sommaire du rapport</h2></div><button type="button" class="text-button" data-close-summary>Fermer</button></header><p class="muted">Organisez vos sections sans quitter la rédaction.</p><div class="report-summary-sections">${visibleSections().map((section, index) => `<article><button type="button" data-summary-open="${escapeHtml(section.id)}"><strong>${index + 1}. ${escapeHtml(section.title)}</strong><span>${moduleUsed(section.id) ? "Contenu ajouté" : "Vide"}</span></button>${editable() ? `<div><button type="button" class="text-button" data-summary-move="up" data-section-id="${escapeHtml(section.id)}" ${index ? "" : "disabled"}>↑</button><button type="button" class="text-button" data-summary-move="down" data-section-id="${escapeHtml(section.id)}" ${index < visibleSections().length - 1 ? "" : "disabled"}>↓</button>${section.id !== "general" ? `<button type="button" class="text-button danger-text" data-summary-delete="${escapeHtml(section.id)}">Supprimer</button>` : ""}</div>` : ""}</article>`).join("")}</div>${editable() ? '<button type="button" class="secondary-button" data-summary-new>+ Créer une section</button>' : ""}</div>`; dialog.querySelector("[data-close-summary]").addEventListener("click", () => dialog.remove()); dialog.querySelectorAll("[data-summary-open]").forEach(button => button.addEventListener("click", () => { dialog.remove(); openModule(shell, button.dataset.summaryOpen); })); dialog.querySelectorAll("[data-summary-move]").forEach(button => button.addEventListener("click", () => { moveSection(button.dataset.sectionId, button.dataset.summaryMove); queueSave(shell); render(); renderEditor(shell); })); dialog.querySelectorAll("[data-summary-delete]").forEach(button => button.addEventListener("click", async () => { await deleteSection(button.dataset.summaryDelete, shell); dialog.remove(); })); dialog.querySelector("[data-summary-new]")?.addEventListener("click", () => { const id = nextSectionId(); current.content.customSections.push({ id, sourceKey: "overview", title: "Nouvelle section", content: { observations: [] } }); current.content.sectionOrder.push(id); current.content.activeStep = id; queueSave(shell); dialog.remove(); renderEditor(shell); }); }; document.body.append(dialog); render(); }
function newObservationId() { return `observation-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function newMaterialId() { return `material-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function ownsLock() { return String(reportLock?.lockedBy || "") === String(document.body.dataset.userId || ""); }
function editable() { return Boolean(current && ownsLock() && (["draft", "in_correction"].includes(current.status) || current.status === "submitted" && canProofreadReport())); }
function isAdministrator() { return document.body.dataset.role === "admin"; }
function canAdjustPdfLayout() { return document.body.classList.contains("desktop-device"); }
function canProofreadReport() { return canAdjustPdfLayout() && ["admin", "pc_standard"].includes(document.body.dataset.role); }
function canFinalizeReport() { return canProofreadReport(); }
function canCancelReport() { return canProofreadReport(); }
function statusLabel(value) { return ({ draft: "Brouillon", submitted: "Rapport terminé à corriger", in_correction: "Correction demandée", ready_to_send: "À envoyer", validated: "Envoyé" })[value] || "En cours"; }
function formatDate(value) { return value ? new Intl.DateTimeFormat("fr-FR").format(new Date(`${value}T12:00:00`)) : ""; }
function showFailure(root, message) { root.innerHTML = `<section class="client-panel"><p class="auth-message error">${escapeHtml(message || "Impossible de charger les rapports.")}</p></section>`; }
async function api(url, options = {}) { try { const response = await fetch(url, { credentials: "same-origin", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options }); const data = response.status === 204 ? null : await response.json().catch(() => null); return { ok: response.ok, data, message: data?.message }; } catch { return { ok: false, message: "Serveur indisponible." }; } }
async function upload(url, body) { try { const response = await fetch(url, { method: "POST", credentials: "same-origin", body }); const data = await response.json().catch(() => null); return { ok: response.ok, data, message: data?.message }; } catch { return { ok: false, message: "Serveur indisponible." }; } }
