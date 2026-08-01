import { ROUTES } from "./config.js?v=118";
import { clearSearch, getContainer, setPage } from "./ui.js?v=44";
import { escapeHtml } from "./utils.js?v=44";
import { acquireReportLock, forceReleaseReportLock, heartbeatReportLock, releaseReportLock } from "./collaboration.js?v=2";

const MODULES = [
    ["general", "Informations générales", "Données récupérées automatiquement"],
    ["overview", "État des lieux", "Constats à l’arrivée"],
    ["visual", "Observations visuelles", "Désordres et anomalies visibles"],
    ["humidity", "Contrôle d’humidité", "Mesures et zones contrôlées"],
    ["pressure", "Manomètre de pression", "Contrôles de pression"],
    ["methods", "Recherche technique", "Méthodes de localisation utilisées"],
    ["waterTest", "Test d’étanchéité à l’eau claire / colorant", "Essais réalisés"],
    ["charging", "Mise en charge", "Mise sous pression ou en charge"],
    ["safety", "Mise en sécurité", "Mesures de prévention"],
    ["ventilation", "Contrôle ventilation", "Vérifications de ventilation"],
    ["conclusion", "Conclusion", "Diagnostic et synthèse"],
    ["recommendations", "Préconisations", "Travaux et conseils"],
];
const TECHNICAL_METHODS = ["Gaz traceur", "Contrôle acoustique", "Caméra endoscopique", "Caméra thermique", "Traçage réseau", "Fumigation", "Autre matériel"];
let reports = [];
let library = [];
let current = null;
let corrections = [];
let reportLock = null;
let previewMode = false;
let saveTimer = null;
let heartbeatTimer = null;
let periodicTimer = null;
let saving = false;
let eventsBound = false;

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
    if (reportId) await loadReport(reportId);
    else if (appointmentId) await openAppointmentReport(appointmentId);
    bindCollaborationEvents();
    const shell = root.querySelector(".report-editor-shell");
    if (!current) return renderDirectory(shell);
    renderEditor(shell);
}

function renderDirectory(shell) {
    shell.classList.add("report-directory");
    shell.innerHTML = `<header class="report-directory-heading"><div><p class="eyebrow">Rapports terrain</p><h2>Rapports de recherche de fuite</h2><p class="muted">Ouvrez une intervention pour créer ou reprendre son rapport.</p></div></header><section class="report-directory-list">${reports.length ? reports.map(report => `<article><div><strong>${escapeHtml(report.title)}</strong><p>${escapeHtml(statusLabel(report.status))} · Intervention n° ${escapeHtml(report.appointmentId || "—")} · ${escapeHtml(formatDate(report.reportDate))}</p></div><button class="secondary-button" data-open-report="${escapeHtml(report.id)}">${report.status === "validated" ? "Consulter" : "Ouvrir"}</button></article>`).join("") : '<p class="muted">Aucun rapport accessible. Créez-le depuis une intervention.</p>'}</section>`;
    shell.querySelectorAll("[data-open-report]").forEach(button => button.addEventListener("click", () => renderLeakReportWizard(button.dataset.openReport)));
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
    current.content.activeStep = moduleKeys().includes(current.content.activeStep) ? current.content.activeStep : "overview";
    MODULES.forEach(([key]) => {
        current.content[key] = current.content[key] && typeof current.content[key] === "object" ? current.content[key] : {};
        current.content[key].observations = Array.isArray(current.content[key].observations) ? current.content[key].observations : [];
    });
}

async function acquireLock() {
    if (!current || current.status === "validated" || (current.status === "submitted" && !canValidate())) return;
    const result = await acquireReportLock(current.id);
    reportLock = result.data?.lock || reportLock;
}

function renderEditor(shell) {
    if (previewMode) return renderPreview(shell);
    ensureModularContent();
    const activeKey = current.content.activeStep;
    const activeModule = moduleDefinition(activeKey);
    const write = editable();
    const snapshot = current.content.snapshot || {};
    shell.className = "report-editor-shell report-editor-fullscreen";
    shell.innerHTML = `
        <header class="report-editor-header">
            <div class="report-editor-identity"><strong>${escapeHtml(snapshot.clientName || current.clientName || "Client non renseigné")}</strong><span>${escapeHtml(snapshot.clientAddress || current.clientAddress || current.appointmentLocation || "Adresse non renseignée")}</span></div>
            <div class="report-editor-meta"><span>Intervention n° ${escapeHtml(snapshot.interventionNumber || current.appointmentId || "—")}</span><span>${snapshot.claimNumber ? `Sinistre n° ${escapeHtml(snapshot.claimNumber)}` : "Sinistre non renseigné"}</span><span>${escapeHtml(snapshot.technicianName || current.technicianName || "Technicien")}</span></div>
            <span class="report-editor-status ${escapeHtml(current.status)}">${escapeHtml(statusLabel(current.status))}</span>
        </header>
        ${lockBanner()}
        ${corrections.length ? `<section class="report-editor-corrections"><strong>Commentaires de l’administration</strong>${corrections.map(item => `<p><b>${escapeHtml(moduleDefinition(item.section)?.[1] || "Module")}</b> · ${escapeHtml(item.comment)}</p>`).join("")}</section>` : ""}
        <nav class="report-module-nav" aria-label="Modules du rapport">${MODULES.map(([key, title, description], index) => `<button type="button" class="${key === activeKey ? "active" : ""}${moduleUsed(key) ? " used" : ""}" data-module="${key}"><span>${key === "general" ? "i" : index}</span><b>${escapeHtml(title)}</b><small>${escapeHtml(description)}</small></button>`).join("")}</nav>
        <main class="report-editor-main">
            <div class="report-editor-module-heading"><div><p class="eyebrow">Module ${activeKey === "general" ? "automatique" : moduleNumber(activeKey)}</p><h2>${escapeHtml(activeModule[1])}</h2><p class="muted">${escapeHtml(activeModule[2])}</p></div>${activeKey !== "general" && write ? `<button type="button" class="secondary-button" data-skip-module>${isSkipped(activeKey) ? "Réactiver" : "Ignorer ce module"}</button>` : ""}</div>
            ${activeKey === "general" ? generalModuleHtml(write) : observationsModuleHtml(activeKey, write)}
        </main>
        <footer class="report-editor-footer">
            <button type="button" class="secondary-button" data-previous-module ${moduleIndex(activeKey) <= 0 ? "disabled" : ""}>← Précédent</button>
            <button type="button" class="secondary-button" data-preview>Prévisualiser le rapport</button>
            ${write ? '<span class="report-autosave" data-save-state>Enregistré automatiquement</span>' : ""}
            ${write && current.status !== "submitted" ? '<button type="button" class="secondary-button report-primary-action" data-submit-report>Envoyer pour validation</button>' : ""}
            ${write && canValidate() && current.status === "submitted" ? '<button type="button" class="secondary-button report-primary-action" data-validate-report>Valider définitivement</button>' : ""}
            ${editable() && isAdministrator() && ["submitted", "in_correction"].includes(current.status) ? '<button type="button" class="secondary-button" data-request-correction>Demander une correction</button>' : ""}
            ${isAdministrator() && current.status === "validated" ? '<button type="button" class="secondary-button" data-reopen-report>Réouvrir le rapport</button>' : ""}
            <button type="button" class="secondary-button" data-next-module ${moduleIndex(activeKey) >= MODULES.length - 1 ? "disabled" : ""}>Suivant →</button>
        </footer>
    `;
    bindEditor(shell, activeKey);
    startTimers(shell);
}

function generalModuleHtml(write) {
    const snapshot = current.content.snapshot || {};
    const values = [["Entreprise", snapshot.companyName], ["Client", snapshot.clientName || current.clientName], ["Adresse", snapshot.clientAddress || current.clientAddress || current.appointmentLocation], ["Téléphone", snapshot.clientPhone], ["E-mail", snapshot.clientEmail], ["N° intervention", snapshot.interventionNumber || current.appointmentId], ["N° sinistre", snapshot.claimNumber], ["Donneur d’ordre", snapshot.manager], ["Assurance", snapshot.insurance], ["Date / heure", [snapshot.date || current.reportDate, snapshot.time].filter(Boolean).join(" · ")], ["Technicien", snapshot.technicianName || current.technicianName], ["Type d’intervention", snapshot.interventionType]].filter(([, value]) => value);
    return `<section class="report-auto-summary"><p>Ces informations sont générées automatiquement à partir du dossier client et de l’intervention.</p><dl>${values.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl></section>${photosHtml("general", "", write, "Ajouter la photo extérieure du logement", true)}`;
}

function observationsModuleHtml(moduleKey, write) {
    const observations = current.content[moduleKey].observations;
    if (isSkipped(moduleKey)) return `<section class="report-module-empty"><h3>Module ignoré</h3><p>Il ne figurera pas dans le PDF final tant qu’il n’est pas réactivé.</p></section>`;
    return `<section class="report-observations">${observations.map((observation, index) => observationHtml(moduleKey, observation, index, write)).join("") || '<section class="report-module-empty"><h3>Aucune observation</h3><p>Ajoutez uniquement les constats utiles à cette intervention.</p></section>'}${write ? '<button type="button" class="report-add-observation" data-add-observation>+ Ajouter une observation</button>' : ""}</section>`;
}

function observationHtml(moduleKey, observation, index, write) {
    const methodControl = moduleKey === "methods" ? `<label>Moyen utilisé<select data-observation-method="${escapeHtml(observation.id)}" ${write ? "" : "disabled"}><option value="">Choisir un moyen</option>${[...TECHNICAL_METHODS, ...library.filter(item => item.category === "materials").map(item => item.label)].filter((value, position, all) => all.indexOf(value) === position).map(method => `<option value="${escapeHtml(method)}" ${observation.method === method ? "selected" : ""}>${escapeHtml(method)}</option>`).join("")}</select></label>` : "";
    return `<article class="report-observation-card" data-observation-card="${escapeHtml(observation.id)}"><header><strong>Observation ${index + 1}</strong>${write ? `<div><button type="button" class="text-button" data-move-observation="up" data-observation-id="${escapeHtml(observation.id)}" ${index ? "" : "disabled"}>↑</button><button type="button" class="text-button" data-move-observation="down" data-observation-id="${escapeHtml(observation.id)}" ${index < current.content[moduleKey].observations.length - 1 ? "" : "disabled"}>↓</button><button type="button" class="text-button danger-text" data-delete-observation="${escapeHtml(observation.id)}">Supprimer</button></div>` : ""}</header>${methodControl}<label>Constat<textarea data-observation-text="${escapeHtml(observation.id)}" rows="6" placeholder="Décrivez uniquement ce qui a été observé…" ${write ? "" : "disabled"}>${escapeHtml(observation.text || "")}</textarea></label>${photosHtml(moduleKey, observation.id, write, "Ajouter des photos")}</article>`;
}

function photosHtml(moduleKey, observationId, write, addLabel, singlePhoto = false) {
    const photos = (current.media || []).filter(photo => photo.section === moduleKey && String(photo.observationId || "") === String(observationId));
    return `<section class="report-observation-photos"><div class="report-photo-grid">${photos.map(photo => `<article><img src="${escapeHtml(photo.dataUrl)}" alt="${escapeHtml(photo.caption || photo.name || "Photo du rapport")}">${write ? `<input value="${escapeHtml(photo.caption || "")}" maxlength="500" placeholder="Commentaire facultatif" data-photo-caption="${escapeHtml(photo.id)}"><button type="button" class="text-button danger-text" data-delete-photo="${escapeHtml(photo.id)}">Supprimer</button>` : photo.caption ? `<p>${escapeHtml(photo.caption)}</p>` : ""}</article>`).join("")}</div>${write && (!singlePhoto || !photos.length) ? `<label class="report-photo-add">${escapeHtml(addLabel)}<input type="file" accept="image/*" capture="environment" ${singlePhoto ? "" : "multiple"} data-photo-input data-module-key="${escapeHtml(moduleKey)}" data-observation-id="${escapeHtml(observationId)}"></label>` : ""}</section>`;
}

function bindEditor(shell, moduleKey) {
    shell.querySelectorAll("[data-module]").forEach(button => button.addEventListener("click", () => openModule(shell, button.dataset.module)));
    shell.querySelector("[data-previous-module]")?.addEventListener("click", () => openModule(shell, MODULES[moduleIndex(moduleKey) - 1][0]));
    shell.querySelector("[data-next-module]")?.addEventListener("click", () => openModule(shell, MODULES[moduleIndex(moduleKey) + 1][0]));
    shell.querySelector("[data-skip-module]")?.addEventListener("click", () => { const skipped = new Set(current.content.skippedSteps || []); skipped.has(moduleKey) ? skipped.delete(moduleKey) : skipped.add(moduleKey); current.content.skippedSteps = [...skipped]; queueSave(shell); renderEditor(shell); });
    shell.querySelector("[data-add-observation]")?.addEventListener("click", () => { current.content[moduleKey].observations.push({ id: newObservationId(), text: "", method: "", createdAt: new Date().toISOString() }); current.content.skippedSteps = (current.content.skippedSteps || []).filter(key => key !== moduleKey); queueSave(shell); renderEditor(shell); });
    shell.querySelectorAll("[data-observation-text]").forEach(input => input.addEventListener("input", () => { const observation = findObservation(moduleKey, input.dataset.observationText); if (observation) observation.text = input.value; queueSave(shell); }));
    shell.querySelectorAll("[data-observation-method]").forEach(input => input.addEventListener("change", () => { const observation = findObservation(moduleKey, input.dataset.observationMethod); if (observation) observation.method = input.value; queueSave(shell); }));
    shell.querySelectorAll("[data-delete-observation]").forEach(button => button.addEventListener("click", async () => { if (!confirm("Supprimer cette observation et ses photos ?")) return; if (!await removeObservation(moduleKey, button.dataset.deleteObservation)) return; queueSave(shell); renderEditor(shell); }));
    shell.querySelectorAll("[data-move-observation]").forEach(button => button.addEventListener("click", () => { moveObservation(moduleKey, button.dataset.observationId, button.dataset.moveObservation); queueSave(shell); renderEditor(shell); }));
    shell.querySelectorAll("[data-photo-input]").forEach(input => input.addEventListener("change", () => uploadPhotos(input, shell)));
    shell.querySelectorAll("[data-photo-caption]").forEach(input => input.addEventListener("change", () => updatePhotoCaption(input)));
    shell.querySelectorAll("[data-delete-photo]").forEach(button => button.addEventListener("click", () => deletePhoto(button.dataset.deletePhoto, shell)));
    shell.querySelector("[data-preview]").addEventListener("click", async () => { await save(shell, true); previewMode = true; renderEditor(shell); });
    shell.querySelector("[data-submit-report]")?.addEventListener("click", () => submitReport(shell));
    shell.querySelector("[data-validate-report]")?.addEventListener("click", () => validateReport(shell));
    shell.querySelector("[data-request-correction]")?.addEventListener("click", () => requestCorrection(shell));
    shell.querySelector("[data-reopen-report]")?.addEventListener("click", () => reopenReport(shell));
    shell.querySelector("[data-force-lock]")?.addEventListener("click", forceTakeover);
}

function renderPreview(shell) {
    shell.className = "report-editor-shell report-preview-shell";
    shell.innerHTML = `<header class="report-preview-header"><div><p class="eyebrow">Prévisualisation temporaire</p><h2>${escapeHtml(current.title)}</h2><p class="muted">Le PDF reflète l’état enregistré du rapport.</p></div><button class="secondary-button" data-back-to-editor>Retour à l’édition</button></header><iframe title="Prévisualisation du rapport" src="/api/technical-reports/${encodeURIComponent(current.id)}/pdf?preview=${Date.now()}"></iframe>`;
    shell.querySelector("[data-back-to-editor]").addEventListener("click", () => { previewMode = false; renderEditor(shell); });
}

function lockBanner() {
    if (current.status === "validated") return '<p class="report-editor-lock validated">Rapport validé : il est désormais en consultation seule.</p>';
    if (editable()) return '<p class="report-editor-lock editable">● Sauvegarde automatique active</p>';
    if (reportLock) return `<p class="report-editor-lock readonly">Lecture seule : ${escapeHtml(reportLock.userName || "un utilisateur")} modifie ce rapport.${isAdministrator() ? ' <button class="secondary-button" data-force-lock>Reprendre la main</button>' : ""}</p>`;
    return '<p class="report-editor-lock readonly">Lecture seule : verrou indisponible.</p>';
}

function openModule(shell, key) {
    if (!moduleKeys().includes(key)) return;
    current.content.activeStep = key;
    queueSave(shell);
    renderEditor(shell);
}

function findObservation(moduleKey, id) { return current.content[moduleKey].observations.find(observation => observation.id === id); }
async function removeObservation(moduleKey, id) { const photos = (current.media || []).filter(photo => String(photo.observationId || "") === String(id)); const deleted = await Promise.all(photos.map(photo => api(`/api/technical-reports/${encodeURIComponent(current.id)}/media/${encodeURIComponent(photo.id)}`, { method: "DELETE" }))); if (deleted.some(result => !result.ok)) { alert("Une ou plusieurs photos n’ont pas pu être supprimées."); return false; } current.content[moduleKey].observations = current.content[moduleKey].observations.filter(observation => observation.id !== id); current.media = (current.media || []).filter(photo => String(photo.observationId || "") !== String(id)); return true; }
function moveObservation(moduleKey, id, direction) { const items = current.content[moduleKey].observations; const index = items.findIndex(observation => observation.id === id); const next = direction === "up" ? index - 1 : index + 1; if (index < 0 || next < 0 || next >= items.length) return; [items[index], items[next]] = [items[next], items[index]]; }

async function uploadPhotos(input, shell) {
    const files = [...input.files || []];
    if (!files.length) return;
    const data = new FormData();
    files.forEach(file => data.append("files", file));
    data.append("section", input.dataset.moduleKey);
    data.append("observationId", input.dataset.observationId || "");
    const result = await upload(`/api/technical-reports/${encodeURIComponent(current.id)}/media`, data);
    if (!result.ok) return alert(result.message || "Ajout des photos impossible.");
    current.media.push(...(result.data.media || []));
    renderEditor(shell);
}

async function updatePhotoCaption(input) {
    const photo = (current.media || []).find(item => item.id === input.dataset.photoCaption);
    if (!photo) return;
    photo.caption = input.value;
    const result = await api(`/api/technical-reports/${encodeURIComponent(current.id)}/media/${encodeURIComponent(photo.id)}`, { method: "PATCH", body: JSON.stringify({ caption: photo.caption, annotation: photo.annotation || "", observationId: photo.observationId || "" }) });
    if (!result.ok) alert(result.message || "Mise à jour de la photo impossible.");
}

async function deletePhoto(id, shell) {
    if (!confirm("Supprimer cette photo ?")) return;
    const result = await api(`/api/technical-reports/${encodeURIComponent(current.id)}/media/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!result.ok) return alert(result.message || "Suppression impossible.");
    current.media = current.media.filter(photo => photo.id !== id);
    renderEditor(shell);
}

function queueSave(shell) {
    if (!editable()) return;
    clearTimeout(saveTimer);
    const state = shell.querySelector("[data-save-state]");
    if (state) state.textContent = "Enregistrement…";
    saveTimer = setTimeout(() => save(shell, true), 650);
}

async function save(shell, silent = false) {
    if (!editable() || saving) return false;
    saving = true;
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
    if (!confirm("Envoyer ce rapport pour validation ?")) return;
    const result = await api(`/api/technical-reports/${encodeURIComponent(current.id)}/submit`, { method: "POST" });
    if (!result.ok) return alert(result.message || "Envoi impossible.");
    await loadReport(current.id);
    renderEditor(shell);
}

async function validateReport(shell) {
    if (!await save(shell) || !confirm("Valider définitivement le rapport et générer son PDF officiel ?")) return;
    const result = await api(`/api/technical-reports/${encodeURIComponent(current.id)}/validate`, { method: "POST" });
    if (!result.ok) return alert(result.message || "Validation impossible.");
    const appointmentId = current.appointmentId;
    await leaveReport();
    window.dispatchEvent(new CustomEvent("depannhome:technical-report-validated", { detail: { appointmentId } }));
    const { renderCalendar } = await import("./calendar.js?v=144");
    renderCalendar();
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

function startTimers(shell) {
    stopTimers();
    if (!ownsLock()) return;
    heartbeatTimer = window.setInterval(async () => { const result = await heartbeatReportLock(current.id); if (!result.ok) { reportLock = result.data?.lock || null; stopTimers(); renderEditor(shell); } }, 30000);
    if (editable()) periodicTimer = window.setInterval(() => save(shell, true), 5000);
}

function stopTimers() { clearTimeout(saveTimer); clearInterval(heartbeatTimer); clearInterval(periodicTimer); saveTimer = heartbeatTimer = periodicTimer = null; }
async function leaveReport() { stopTimers(); if (current && ownsLock()) await releaseReportLock(current.id); current = null; reportLock = null; previewMode = false; }
async function forceTakeover() { if (!isAdministrator() || !confirm("Reprendre la main sur ce rapport ?")) return; const result = await forceReleaseReportLock(current.id, "Reprise de l’édition du rapport"); if (!result.ok) return alert(result.message || "Reprise impossible."); await acquireLock(); const shell = document.querySelector(".report-editor-shell"); if (shell) renderEditor(shell); }

function bindCollaborationEvents() {
    if (eventsBound) return;
    eventsBound = true;
    const saveOnExit = () => { const shell = document.querySelector(".report-editor-shell"); if (shell && editable()) save(shell, true); };
    window.addEventListener("pagehide", saveOnExit);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveOnExit(); });
    window.addEventListener("depannhome:collaboration-event", async event => {
        const detail = event.detail || {};
        if (!current || detail.entityType !== "technical_report" || String(detail.entityId) !== String(current.id) || ownsLock()) return;
        if (!["report_saved", "report_media_added", "report_media_updated", "report_media_deleted", "report_submitted", "report_correction_requested", "report_validated", "report_reopened", "lock_force_released"].includes(detail.type)) return;
        const result = await api(`/api/technical-reports/${encodeURIComponent(current.id)}`);
        if (!result.ok) return;
        current = result.data.report; corrections = result.data.corrections || []; reportLock = result.data.lock || null; ensureModularContent();
        const shell = document.querySelector(".report-editor-shell");
        if (shell) renderEditor(shell);
    });
}

function moduleDefinition(key) { return MODULES.find(([id]) => id === key) || MODULES[1]; }
function moduleKeys() { return MODULES.map(([key]) => key); }
function moduleIndex(key) { return MODULES.findIndex(([id]) => id === key); }
function moduleNumber(key) { return Math.max(1, moduleIndex(key)); }
function isSkipped(key) { return (current.content.skippedSteps || []).includes(key); }
function moduleUsed(key) { return key === "general" || (current.media || []).some(photo => photo.section === key) || !isSkipped(key) && current.content[key].observations.length > 0; }
function newObservationId() { return `observation-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function ownsLock() { return String(reportLock?.lockedBy || "") === String(document.body.dataset.userId || ""); }
function editable() { return current?.status !== "validated" && ownsLock(); }
function isAdministrator() { return document.body.dataset.role === "admin"; }
function canValidate() { return ["admin", "mobile_admin"].includes(document.body.dataset.role); }
function statusLabel(value) { return ({ draft: "Brouillon", submitted: "En cours de validation", in_correction: "En cours", validated: "Validé" })[value] || "En cours"; }
function formatDate(value) { return value ? new Intl.DateTimeFormat("fr-FR").format(new Date(`${value}T12:00:00`)) : ""; }
function showFailure(root, message) { root.innerHTML = `<section class="client-panel"><p class="auth-message error">${escapeHtml(message || "Impossible de charger les rapports.")}</p></section>`; }
async function api(url, options = {}) { try { const response = await fetch(url, { credentials: "same-origin", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options }); const data = response.status === 204 ? null : await response.json().catch(() => null); return { ok: response.ok, data, message: data?.message }; } catch { return { ok: false, message: "Serveur indisponible." }; } }
async function upload(url, body) { try { const response = await fetch(url, { method: "POST", credentials: "same-origin", body }); const data = await response.json().catch(() => null); return { ok: response.ok, data, message: data?.message }; } catch { return { ok: false, message: "Serveur indisponible." }; } }
