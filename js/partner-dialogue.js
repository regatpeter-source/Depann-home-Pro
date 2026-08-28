import { escapeHtml } from "./utils.js?v=44";

const ISSUE_LABELS = { client_absent: "Client absent", access_impossible: "Accès impossible", information_missing: "Informations manquantes", material_unavailable: "Matériel indisponible", awaiting_authorization: "En attente d’autorisation", rescheduled: "Intervention reportée", information_requested: "Informations complémentaires demandées", other: "Autre difficulté" };
const ATTACHMENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const MAX_ATTACHMENT_FILES = 5;
const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024;

export async function openPartnerDialogue(missionId, options = {}) {
    const dialogueUrl = options.sourceDialogue ? `/api/partner-dialogue/sent-missions/${missionId}` : `/api/partner-dialogue/missions/${missionId}`;
    const dialog = document.createElement("div");
    dialog.className = "partner-mission-dialog partner-dialogue-modal";
    dialog.innerHTML = '<section><p class="muted">Chargement de la conversation…</p></section>';
    document.body.append(dialog);
    let refreshing = false;
    const close = () => { window.removeEventListener("depannhome:collaboration-event", refresh); dialog.remove(); };
    const refresh = async event => {
        const detail = event.detail || {};
        if (refreshing || detail.type !== "mission_journal_updated" || String(detail.missionId) !== String(missionId)) return;
        refreshing = true; const result = await api(dialogueUrl); refreshing = false;
        if (result.ok && dialog.isConnected) renderDialogue(dialog, result.data, close, dialogueUrl);
    };
    window.addEventListener("depannhome:collaboration-event", refresh);
    try {
        const result = await api(dialogueUrl);
        if (!result.ok) { dialog.querySelector("section").innerHTML = `<button class="text-button partner-dialog-close">Fermer</button><p class="auth-message error">${escapeHtml(result.message || "Conversation indisponible.")}</p>`; dialog.querySelector("button").addEventListener("click", close); return; }
        renderDialogue(dialog, result.data, close, dialogueUrl);
    } catch { close(); }
}

function renderDialogue(dialog, data, close, dialogueUrl) {
    const { mission, messages, linkedDocuments, readOnly } = data;
    const section = dialog.querySelector("section");
    section.className = "partner-dialogue";
    const lastUpdate = messages.length ? messages[messages.length - 1].updatedAt || messages[messages.length - 1].createdAt : null;
    section.innerHTML = `<button class="text-button partner-dialog-close">Fermer</button><header class="partner-dialogue-heading"><div><p class="eyebrow">Centre de mission · ${escapeHtml(mission.partnerName || "Partenaire")}</p><h2>Journal — ${escapeHtml(mission.externalMissionId)}</h2><p class="muted">Chronologie sécurisée et synchronisée de la mission.</p></div><span class="partner-mission-status ${escapeHtml(mission.status)}">${escapeHtml(statusLabel(mission.status))}</span></header><section class="partner-dialogue-summary"><article><span>Client</span><strong>${escapeHtml(mission.clientName || "Non renseigné")}</strong></article><article><span>Adresse</span><strong>${escapeHtml(mission.address || "Non renseignée")}</strong></article><article><span>N° mission</span><strong>${escapeHtml(mission.externalMissionId)}</strong></article><article><span>N° intervention</span><strong>${mission.interventionId ? `#${mission.interventionId}` : "À planifier"}</strong></article><article><span>Technicien</span><strong>${escapeHtml(mission.technicianName)}</strong></article><article><span>Rendez-vous</span><strong>${escapeHtml(formatSchedule(mission))}</strong></article><article><span>Dernière mise à jour</span><strong>${escapeHtml(formatDate(lastUpdate)) || "—"}</strong></article></section><nav class="partner-journal-filters" aria-label="Filtres du journal">${filterButtons(data.filters)}</nav>${linkedDocuments.length ? `<section class="partner-dialogue-links"><strong>Documents liés au dossier</strong>${linkedDocuments.map(document => `<span>${escapeHtml(document.documentType === "quote" ? "Devis" : "Facture")} ${escapeHtml(document.documentNumber)} · ${escapeHtml(document.status)}</span>`).join("")}</section>` : ""}<section class="partner-dialogue-thread partner-journal-thread" id="partnerDialogueThread">${messages.map(messageCard).join("") || '<p class="muted">Le journal est prêt. Ajoutez la première information utile.</p>'}</section>${readOnly ? '<p class="partner-dialogue-readonly">Mission clôturée : l’historique reste consultable, mais le journal est en lecture seule.</p>' : composer(mission)}`;
    section.querySelector(".partner-dialogue-heading h2").textContent = `Journal — ${mission.missionNumber}`;
    const summaryValues = section.querySelectorAll(".partner-dialogue-summary article strong");
    if (summaryValues[2]) summaryValues[2].textContent = mission.missionNumber;
    if (summaryValues[3]) summaryValues[3].textContent = mission.interventionNumber;
    section.querySelector(".partner-dialog-close").addEventListener("click", close);
    section.querySelectorAll("[data-journal-filter]").forEach(button => button.addEventListener("click", () => applyFilter(section, button.dataset.journalFilter)));
    applyFilter(section, "messages");
    let links = section.querySelector(".partner-dialogue-links");
    if (!links) {
        links = document.createElement("section");
        links.className = "partner-dialogue-links";
        section.insertBefore(links, section.querySelector(".partner-dialogue-thread"));
    }
    if (links) links.innerHTML = `<strong>Documents liés au dossier</strong>${linkedDocuments.map(document => `<div class="partner-dialogue-document"><a href="${escapeHtml(document.url || internalDocumentUrl(mission.id, document))}" target="_blank" rel="noopener">${escapeHtml(documentLabel(document.sourceType))} · ${escapeHtml(document.label)}</a><span class="partner-visibility ${document.partnerVisible ? "shared" : "private"}">${document.partnerVisible ? "Visible au partenaire" : "Interne uniquement"}</span><label class="partner-visibility-toggle"><input type="checkbox" data-item-visibility="${document.id}" data-current-visible="${document.partnerVisible ? "true" : "false"}" ${document.partnerVisible ? "checked" : ""}> Visible au partenaire</label></div>`).join("")}`;
    if (!linkedDocuments.length) links.insertAdjacentHTML("beforeend", '<p class="partner-dialogue-document-empty">Aucun document lié à cette mission pour le moment.</p>');
    configureVisibilityControls(section, data);
    section.querySelectorAll("[data-partner-visibility]").forEach(control => control.addEventListener("change", () => updateVisibility(mission.id, control)));
    section.querySelectorAll("[data-source-visibility]").forEach(control => control.addEventListener("change", () => updateSourceVisibility(mission.id, control)));
    section.querySelectorAll("[data-item-visibility]").forEach(control => control.addEventListener("change", () => updateItemVisibility(mission.id, control)));
    section.querySelectorAll("[data-attachment-visibility]").forEach(control => control.addEventListener("change", () => updateAttachmentVisibility(mission.id, control)));
    section.querySelectorAll("[data-source-attachment-visibility]").forEach(control => control.addEventListener("change", () => updateSourceAttachmentVisibility(mission.id, control)));
    const form = section.querySelector("form");
    const attachmentFiles = form ? setupAttachmentPicker(form) : () => [];
    form?.addEventListener("submit", async event => {
        event.preventDefault();
        const formData = new FormData(form); formData.delete("files"); attachmentFiles().forEach(file => formData.append("files", file, file.name)); const submit = form.querySelector("button[type=submit]"); submit.disabled = true;
        const result = await fetch(`${dialogueUrl}/messages`, { method: "POST", credentials: "same-origin", body: formData });
        const payload = await result.json().catch(() => null); submit.disabled = false;
        if (!result.ok) return alert(payload?.message || "Message impossible à envoyer.");
        const latest = await api(dialogueUrl); if (latest.ok) renderDialogue(dialog, latest.data, close, dialogueUrl);
    });
}

function messageCard(message) { const system = message.kind === "system"; const issue = message.kind === "issue"; const attachments = Array.isArray(message.attachments) ? message.attachments : []; return `<article class="partner-dialogue-message journal-entry ${system ? "system" : ""} ${issue ? "issue" : ""}" data-journal-category="messages"><header><strong>${escapeHtml(system ? "Événement système" : message.organizationName || "Entreprise partenaire")}</strong><span>${escapeHtml(system ? "Depann’Home Pro" : message.senderName || "Participant")}${issue ? ` · ${escapeHtml(ISSUE_LABELS[message.issueType] || "Difficulté")}` : ""}</span><time>${escapeHtml(formatDate(message.createdAt))}</time></header>${message.body ? `<p>${escapeHtml(message.body)}</p>` : ""}${attachments.length ? `<div class="partner-dialogue-attachments">${attachments.map(attachment => `<div class="partner-dialogue-attachment-row">${attachment.mimeType.startsWith("image/") ? `<a class="partner-journal-photo" href="${escapeHtml(attachment.url)}" target="_blank" rel="noopener"><span>Photo</span><strong>${escapeHtml(attachment.filename)}</strong></a>` : `<a href="${escapeHtml(attachment.url)}" target="_blank" rel="noopener">${escapeHtml(documentLabel(attachment.attachmentType))} · ${escapeHtml(attachment.filename)} <small>${formatSize(attachment.fileSize)}</small></a>`}<label class="partner-visibility-toggle"><input type="checkbox" data-attachment-visibility="${attachment.id}" data-current-visible="${attachment.partnerVisible ? "true" : "false"}" ${attachment.partnerVisible ? "checked" : ""}> Visible au partenaire</label></div>`).join("")}</div>` : ""}<div class="partner-message-visibility"><span class="partner-visibility ${message.partnerVisible ? "shared" : "private"}">${message.partnerVisible ? "Visible au partenaire" : "Interne uniquement"}</span><label class="partner-visibility-toggle"><input type="checkbox" data-partner-visibility="${message.id}" data-current-visible="${message.partnerVisible ? "true" : "false"}" ${message.partnerVisible ? "checked" : ""}> Visible au partenaire</label></div></article>`; }
function composer(mission) { const shareLabel = mission?.sourceType === "professional_email" ? "Envoyer aussi par e-mail au partenaire" : "Partager avec le partenaire"; return `<form class="partner-dialogue-composer"><div class="form-grid"><label class="form-wide partner-composer-message">Message<textarea name="body" rows="3" maxlength="4000" placeholder="Écrire un message concernant cette intervention…"></textarea></label><label>Type<select name="kind"><option value="message">Message</option><option value="issue">Signaler une difficulté</option></select></label><label>Difficulté<select name="issueType"><option value="other">Autre</option>${Object.entries(ISSUE_LABELS).filter(([key]) => key !== "other").map(([key, label]) => `<option value="${key}">${escapeHtml(label)}</option>`).join("")}</select></label><label>Nature des fichiers<select name="attachmentType"><option value="document">Document</option><option value="photo">Photo</option><option value="quote">Devis</option><option value="report">Rapport</option><option value="invoice">Facture</option></select></label></div><div class="partner-composer-actions"><label class="partner-composer-files"><strong>Joindre des documents ou photos</strong><span>Glissez-déposez vos fichiers ici</span><input name="files" type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf" aria-label="Parcourir le PC pour joindre des documents ou photos"><output class="partner-file-selection" aria-live="polite">Aucun fichier sélectionné.</output></label><label class="journal-share-control"><input type="checkbox" name="partnerVisible" value="true" checked> ${shareLabel}</label><div class="form-actions"><button class="secondary-button" type="submit">Envoyer le message</button></div></div></form>`; }
function filterButtons(filters) { return (filters || ["messages"]).map(filter => `<button type="button" class="text-button active" data-journal-filter="${escapeHtml(filter)}">Messages</button>`).join(""); }
function applyFilter(section) { section.querySelectorAll("[data-journal-filter]").forEach(button => button.classList.add("active")); section.querySelectorAll("[data-journal-category]").forEach(entry => { entry.hidden = false; }); const linkedDocuments = section.querySelector(".partner-dialogue-links"); if (linkedDocuments) linkedDocuments.hidden = false; }
function setupAttachmentPicker(form) {
    const zone = form.querySelector(".partner-composer-files");
    const input = zone?.querySelector('input[type="file"]');
    const output = zone?.querySelector(".partner-file-selection");
    if (!zone || !input || !output) return () => [];
    let selectedFiles = [];
    const showSelection = () => { output.textContent = selectedFiles.length ? `${selectedFiles.length} fichier${selectedFiles.length > 1 ? "s" : ""} sélectionné${selectedFiles.length > 1 ? "s" : ""} : ${selectedFiles.map(file => file.name).join(", ")}` : "Aucun fichier sélectionné."; };
    const validate = files => {
        if (files.length > MAX_ATTACHMENT_FILES) return `Sélectionnez au maximum ${MAX_ATTACHMENT_FILES} fichiers.`;
        if (files.some(file => !ATTACHMENT_TYPES.has(file.type))) return "Sélectionnez des fichiers PDF, JPEG, PNG ou WebP. Les dossiers complets ne sont pas importés.";
        if (files.some(file => file.size > MAX_ATTACHMENT_SIZE)) return "Chaque fichier doit être inférieur ou égal à 5 Mo.";
        return "";
    };
    input.addEventListener("change", () => { const files = [...input.files]; const error = validate(files); selectedFiles = error ? [] : files; if (error) { input.value = ""; alert(error); } showSelection(); });
    ["dragenter", "dragover"].forEach(type => zone.addEventListener(type, event => { event.preventDefault(); zone.classList.add("drag-active"); }));
    ["dragleave", "dragend"].forEach(type => zone.addEventListener(type, () => zone.classList.remove("drag-active")));
    zone.addEventListener("drop", event => {
        event.preventDefault(); zone.classList.remove("drag-active");
        const files = [...(event.dataTransfer?.files || [])]; const error = validate(files);
        if (!files.length || error) return alert(error || "Aucun fichier exploitable n’a été déposé. Ouvrez le dossier puis sélectionnez les fichiers utiles.");
        selectedFiles = files; input.value = ""; showSelection();
    });
    return () => selectedFiles;
}
function configureVisibilityControls(section, data) {
    const sourceDialogue = Boolean(data.sourceDialogue);
    const entries = [...section.querySelectorAll(".journal-entry")];
    entries.forEach((entry, index) => {
        const message = data.messages[index];
        if (!message) return;
        const ownsMessage = sourceDialogue ? message.senderType === "partner" : message.senderType !== "partner";
        const status = entry.querySelector(".partner-message-visibility .partner-visibility");
        const messageControl = entry.querySelector("[data-partner-visibility]");
        const attachmentControls = [...entry.querySelectorAll("[data-attachment-visibility]")];
        if (!ownsMessage) {
            messageControl?.closest(".partner-visibility-toggle")?.remove();
            attachmentControls.forEach(control => control.closest(".partner-visibility-toggle")?.remove());
            if (status) { status.className = "partner-visibility shared"; status.textContent = "Reçu de l’entreprise partenaire"; }
            return;
        }
        if (!sourceDialogue) return;
        const visible = Boolean(message.receiverVisible);
        if (status) { status.className = `partner-visibility ${visible ? "shared" : "private"}`; status.textContent = visible ? "Visible par l’entreprise destinataire" : "Interne à votre entreprise"; }
        if (messageControl) {
            delete messageControl.dataset.partnerVisibility;
            messageControl.dataset.sourceVisibility = message.id;
            messageControl.dataset.currentVisible = String(visible);
            messageControl.checked = visible;
            messageControl.closest("label").lastChild.textContent = " Visible par l’entreprise destinataire";
        }
        attachmentControls.forEach((control, attachmentIndex) => {
            const attachment = message.attachments?.[attachmentIndex];
            if (!attachment) return control.closest(".partner-visibility-toggle")?.remove();
            const attachmentVisible = Boolean(attachment.receiverVisible);
            delete control.dataset.attachmentVisibility;
            control.dataset.sourceAttachmentVisibility = attachment.id;
            control.dataset.currentVisible = String(attachmentVisible);
            control.checked = attachmentVisible;
            control.closest("label").lastChild.textContent = " Visible par l’entreprise destinataire";
        });
    });
    if (sourceDialogue) section.querySelectorAll("[data-item-visibility]").forEach(control => control.closest(".partner-visibility-toggle")?.remove());
}
async function updateVisibility(missionId, control) { const previous = control.dataset.currentVisible === "true"; const partnerVisible = control.checked; control.disabled = true; const result = await fetch(`/api/partner-dialogue/missions/${missionId}/entries/${control.dataset.partnerVisibility}/visibility`, { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ partnerVisible }) }); control.disabled = false; if (!result.ok) { control.checked = previous; const payload = await result.json().catch(() => null); alert(payload?.message || "Visibilité impossible à modifier."); return; } const status = control.closest(".journal-entry").querySelector(".partner-visibility"); status.className = `partner-visibility ${partnerVisible ? "shared" : "private"}`; status.textContent = partnerVisible ? "Visible au partenaire" : "Interne uniquement"; control.dataset.currentVisible = String(partnerVisible); }
async function updateSourceVisibility(missionId, control) { const previous = control.dataset.currentVisible === "true"; const partnerVisible = control.checked; control.disabled = true; const result = await fetch(`/api/partner-dialogue/sent-missions/${missionId}/entries/${control.dataset.sourceVisibility}/visibility`, { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ partnerVisible }) }); control.disabled = false; if (!result.ok) { control.checked = previous; const payload = await result.json().catch(() => null); alert(payload?.message || "Visibilité impossible à modifier."); return; } const status = control.closest(".journal-entry").querySelector(".partner-visibility"); status.className = `partner-visibility ${partnerVisible ? "shared" : "private"}`; status.textContent = partnerVisible ? "Visible par l’entreprise destinataire" : "Interne à votre entreprise"; control.dataset.currentVisible = String(partnerVisible); }
async function updateItemVisibility(missionId, control) { const previous = control.dataset.currentVisible === "true"; const partnerVisible = control.checked; control.disabled = true; const response = await fetch(`/api/partner-dialogue/missions/${missionId}/items/${control.dataset.itemVisibility}/visibility`, { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ partnerVisible }) }); const payload = await response.json().catch(() => null); control.disabled = false; if (!response.ok) { control.checked = previous; return alert(payload?.message || "Visibilité impossible à modifier."); } const status = control.closest(".partner-dialogue-document").querySelector(".partner-visibility"); status.className = `partner-visibility ${partnerVisible ? "shared" : "private"}`; status.textContent = partnerVisible ? "Visible au partenaire" : "Interne uniquement"; control.dataset.currentVisible = String(partnerVisible); }
async function updateAttachmentVisibility(missionId, control) { const previous = control.dataset.currentVisible === "true"; const partnerVisible = control.checked; control.disabled = true; const response = await fetch(`/api/partner-dialogue/missions/${missionId}/attachments/${control.dataset.attachmentVisibility}/visibility`, { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ partnerVisible }) }); const payload = await response.json().catch(() => null); control.disabled = false; if (!response.ok) { control.checked = previous; return alert(payload?.message || "Visibilité impossible à modifier."); } control.dataset.currentVisible = String(partnerVisible); }
async function updateSourceAttachmentVisibility(missionId, control) { const previous = control.dataset.currentVisible === "true"; const partnerVisible = control.checked; control.disabled = true; const response = await fetch(`/api/partner-dialogue/sent-missions/${missionId}/attachments/${control.dataset.sourceAttachmentVisibility}/visibility`, { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ partnerVisible }) }); const payload = await response.json().catch(() => null); control.disabled = false; if (!response.ok) { control.checked = previous; return alert(payload?.message || "Visibilité impossible à modifier."); } control.dataset.currentVisible = String(partnerVisible); }
function internalDocumentUrl(missionId, document) { return `/api/partner-dialogue/missions/${encodeURIComponent(missionId)}/items/${encodeURIComponent(document.id)}/download`; }
function documentLabel(value) { return ({ quote: "Devis", report: "Rapport", invoice: "Facture", photo: "Photo" })[value] || "Document"; }
function statusLabel(value) { return ({ received: "Reçue", pending_validation: "À valider", accepted: "Acceptée", rejected: "Refusée", assigned: "Affectée", scheduled: "Planifiée", en_route: "En route", on_site: "Sur site", report_in_progress: "Rapport en cours", report_completed: "Rapport terminé", report_validated: "Rapport validé", quote_sent: "Devis envoyé", quote_accepted: "Devis accepté", work_completed: "Travaux terminés", invoice_sent: "Facture envoyée", closed: "Clôturée", cancelled: "Annulée" })[value] || "Statut non renseigné"; }
function formatSchedule(mission) { return mission.scheduledDate ? `${new Intl.DateTimeFormat("fr-FR").format(new Date(`${mission.scheduledDate}T12:00:00`))}${mission.scheduledStartTime ? ` · ${mission.scheduledStartTime}` : ""}` : "Non défini"; }
function formatDate(value) { return value ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : ""; }
function formatSize(value) { const bytes = Number(value) || 0; return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} Mo` : `${Math.ceil(bytes / 1024)} Ko`; }
async function api(url) { try { const response = await fetch(url, { credentials: "same-origin" }); const data = await response.json().catch(() => null); return { ok: response.ok, data, message: data?.message }; } catch { return { ok: false, message: "Serveur indisponible." }; } }
