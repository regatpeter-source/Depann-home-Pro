import { escapeHtml } from "./utils.js?v=44";

const ISSUE_LABELS = { client_absent: "Client absent", access_impossible: "Accès impossible", information_missing: "Informations manquantes", material_unavailable: "Matériel indisponible", awaiting_authorization: "En attente d’autorisation", rescheduled: "Intervention reportée", information_requested: "Informations complémentaires demandées", other: "Autre difficulté" };

export async function openPartnerDialogue(missionId) {
    const dialog = document.createElement("div");
    dialog.className = "partner-mission-dialog partner-dialogue-modal";
    dialog.innerHTML = '<section><p class="muted">Chargement de la conversation…</p></section>';
    document.body.append(dialog);
    const close = () => dialog.remove();
    try {
        const result = await api(`/api/partner-dialogue/missions/${missionId}`);
        if (!result.ok) { dialog.querySelector("section").innerHTML = `<button class="text-button partner-dialog-close">Fermer</button><p class="auth-message error">${escapeHtml(result.message || "Conversation indisponible.")}</p>`; dialog.querySelector("button").addEventListener("click", close); return; }
        renderDialogue(dialog, result.data, close);
    } catch { close(); }
}

function renderDialogue(dialog, data, close) {
    const { mission, messages, linkedDocuments, readOnly } = data;
    const section = dialog.querySelector("section");
    section.className = "partner-dialogue";
    section.innerHTML = `<button class="text-button partner-dialog-close">Fermer</button><header class="partner-dialogue-heading"><div><p class="eyebrow">Dossier partenaire · ${escapeHtml(mission.partnerName || "Partenaire")}</p><h2>Discussion — ${escapeHtml(mission.externalMissionId)}</h2><p class="muted">Fil privé associé à cette intervention.</p></div><span class="partner-mission-status ${escapeHtml(mission.status)}">${escapeHtml(statusLabel(mission.status))}</span></header><section class="partner-dialogue-summary"><article><span>Intervention</span><strong>${mission.interventionId ? `#${mission.interventionId}` : "À planifier"}</strong></article><article><span>Client</span><strong>${escapeHtml(mission.clientName || "Non renseigné")}</strong></article><article><span>Adresse</span><strong>${escapeHtml(mission.address || "Non renseignée")}</strong></article><article><span>Type</span><strong>${escapeHtml(mission.interventionType)}</strong></article><article><span>Technicien</span><strong>${escapeHtml(mission.technicianName)}</strong></article><article><span>Rendez-vous</span><strong>${escapeHtml(formatSchedule(mission))}</strong></article></section>${linkedDocuments.length ? `<section class="partner-dialogue-links"><strong>Documents liés</strong>${linkedDocuments.map(document => `<span>${escapeHtml(document.documentType === "quote" ? "Devis" : "Facture")} ${escapeHtml(document.documentNumber)} · ${escapeHtml(document.status)}</span>`).join("")}</section>` : ""}<section class="partner-dialogue-thread" id="partnerDialogueThread">${messages.map(messageCard).join("") || '<p class="muted">Le fil est prêt. Écrivez le premier message utile au dossier.</p>'}</section>${readOnly ? '<p class="partner-dialogue-readonly">Mission clôturée : l’historique reste consultable, mais le fil est en lecture seule.</p>' : composer()}`;
    section.querySelector(".partner-dialog-close").addEventListener("click", close);
    const form = section.querySelector("form");
    form?.addEventListener("submit", async event => {
        event.preventDefault();
        const formData = new FormData(form); const submit = form.querySelector("button[type=submit]"); submit.disabled = true;
        const result = await fetch(`/api/partner-dialogue/missions/${mission.id}/messages`, { method: "POST", credentials: "same-origin", body: formData });
        const payload = await result.json().catch(() => null); submit.disabled = false;
        if (!result.ok) return alert(payload?.message || "Message impossible à envoyer.");
        const latest = await api(`/api/partner-dialogue/missions/${mission.id}`); if (latest.ok) renderDialogue(dialog, latest.data, close);
    });
}

function messageCard(message) { const system = message.kind === "system"; const issue = message.kind === "issue"; const attachments = Array.isArray(message.attachments) ? message.attachments : []; return `<article class="partner-dialogue-message ${system ? "system" : ""} ${issue ? "issue" : ""}"><header><strong>${escapeHtml(system ? "Information système" : message.senderName || "Participant")}</strong><span>${escapeHtml(system ? "Depann’Home Pro" : message.organizationName || "")}${issue ? ` · ${escapeHtml(ISSUE_LABELS[message.issueType] || "Difficulté")}` : ""}</span><time>${escapeHtml(formatDate(message.createdAt))}</time></header>${message.body ? `<p>${escapeHtml(message.body)}</p>` : ""}${attachments.length ? `<div class="partner-dialogue-attachments">${attachments.map(attachment => `<a href="${escapeHtml(attachment.url)}" target="_blank" rel="noopener">${attachment.mimeType.startsWith("image/") ? "Photo" : "Document"} · ${escapeHtml(attachment.filename)} <small>${formatSize(attachment.fileSize)}</small></a>`).join("")}</div>` : ""}</article>`; }
function composer() { return `<form class="partner-dialogue-composer"><div class="form-grid"><label class="form-wide">Message<textarea name="body" rows="4" maxlength="4000" placeholder="Partager une information utile concernant cette intervention…"></textarea></label><label>Type<select name="kind" id="partnerDialogueKind"><option value="message">Message</option><option value="issue">Signaler une difficulté</option></select></label><label>Difficulté<select name="issueType"><option value="other">Autre</option>${Object.entries(ISSUE_LABELS).filter(([key]) => key !== "other").map(([key, label]) => `<option value="${key}">${escapeHtml(label)}</option>`).join("")}</select></label><label class="form-wide">Pièces jointes (photos ou PDF, 5 Mo par fichier)<input name="files" type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf"></label><label>Nature des fichiers<select name="attachmentType"><option value="document">Document</option><option value="photo">Photo</option><option value="quote">Devis</option><option value="report">Rapport</option><option value="invoice">Facture</option></select></label></div><div class="form-actions"><button class="secondary-button" type="submit">Envoyer dans le dossier</button></div></form>`; }
function statusLabel(value) { return ({ pending_validation: "À valider", accepted: "Acceptée", rejected: "Refusée", assigned: "Affectée", scheduled: "Planifiée", en_route: "En route", on_site: "Sur site", report_in_progress: "Rapport en cours", report_completed: "Rapport terminé", report_validated: "Rapport validé", quote_sent: "Devis envoyé", quote_accepted: "Devis accepté", work_completed: "Travaux terminés", invoice_sent: "Facture envoyée", closed: "Clôturée", cancelled: "Annulée" })[value] || value; }
function formatSchedule(mission) { return mission.scheduledDate ? `${new Intl.DateTimeFormat("fr-FR").format(new Date(`${mission.scheduledDate}T12:00:00`))}${mission.scheduledStartTime ? ` · ${mission.scheduledStartTime}` : ""}` : "Non défini"; }
function formatDate(value) { return value ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : ""; }
function formatSize(value) { const bytes = Number(value) || 0; return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} Mo` : `${Math.ceil(bytes / 1024)} Ko`; }
async function api(url) { try { const response = await fetch(url, { credentials: "same-origin" }); const data = await response.json().catch(() => null); return { ok: response.ok, data, message: data?.message }; } catch { return { ok: false, message: "Serveur indisponible." }; } }
