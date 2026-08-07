import { ROUTES } from "./config.js?v=118";
import { clearSearch, getContainer, setPage } from "./ui.js?v=44";
import { escapeHtml } from "./utils.js?v=44";

let sandbox = null;

export async function renderPartnerSandbox() {
    clearSearch();
    setPage("Sandbox partenaires", ROUTES.partnerSandbox, "detail");
    const container = getContainer();
    container.innerHTML = '<section class="partner-sandbox-shell"><p class="muted">Chargement de l’environnement de recette…</p></section>';
    const result = await api("/api/partner-sandbox/workspace");
    if (result.ok) {
        sandbox = result.data.sandbox;
        renderWorkspace(container.querySelector(".partner-sandbox-shell"));
        return;
    }
    if (result.status === 404) return renderActivation(container.querySelector(".partner-sandbox-shell"));
    container.innerHTML = `<section class="client-panel"><p class="auth-message error">${escapeHtml(result.message || "Impossible de charger la Sandbox.")}</p></section>`;
}

function renderActivation(shell) {
    shell.innerHTML = `
        <section class="client-panel partner-sandbox-activation">
            <p class="eyebrow">Développement · démonstration · recette</p>
            <h2>Laboratoire des missions partenaires</h2>
            <p>Activez un environnement autonome contenant AssurTest Démo, un dossier complet, les échanges, la chronologie, les documents et le connecteur API simulé.</p>
            <p class="sandbox-warning">Aucune donnée client, mission, intervention, devis, facture ou rapport de votre entreprise n’est lue, créée ou modifiée.</p>
            <button class="secondary-button" id="activatePartnerSandbox">Activer l’environnement Sandbox</button>
        </section>`;
    shell.querySelector("#activatePartnerSandbox").addEventListener("click", async event => {
        event.currentTarget.disabled = true;
        event.currentTarget.textContent = "Préparation de la Sandbox…";
        const result = await api("/api/partner-sandbox/activate", { method: "POST" });
        if (!result.ok) return alert(result.message || "Activation impossible.");
        sandbox = result.data.sandbox;
        renderWorkspace(shell);
    });
}

function renderWorkspace(shell) {
    const mission = activeMission();
    if (!mission) return renderActivation(shell);
    shell.innerHTML = `
        <header class="partner-sandbox-heading">
            <div><p class="eyebrow">Environnement de démonstration</p><h2>Sandbox · Missions partenaires</h2><p class="muted">Connecteur local simulé — aucun appel réseau vers un partenaire externe.</p></div>
            <div class="partner-sandbox-header-actions"><button class="secondary-button" id="newSandboxMission">Générer une nouvelle mission</button><button class="secondary-button danger-button" id="resetPartnerSandbox">Supprimer la Sandbox</button></div>
        </header>
        <section class="sandbox-warning-banner"><strong>${escapeHtml(sandbox.partner.name)}</strong> · ${escapeHtml(sandbox.partner.organizationType)} · ${escapeHtml(sandbox.partner.status)} · Connecteur ${escapeHtml(sandbox.partner.connector)} / API ${escapeHtml(sandbox.partner.api)}<br>${escapeHtml(sandbox.partner.banner)}</section>
        <section class="partner-sandbox-mission-picker"><label>Mission simulée <select id="sandboxMissionSelect">${sandbox.missions.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === sandbox.activeMissionId ? "selected" : ""}>${escapeHtml(item.externalMissionId)} · ${escapeHtml(item.client.name)} · ${escapeHtml(statusLabel(item.status))}</option>`).join("")}</select></label><span class="partner-mission-status ${escapeHtml(mission.status)}">${escapeHtml(statusLabel(mission.status))}</span></section>
        <section class="partner-sandbox-summary">
            <article><span>Client</span><strong>${escapeHtml(mission.client.name)}</strong><small>${escapeHtml(mission.client.address)} · ${escapeHtml(mission.client.phone)}</small></article>
            <article><span>Mission</span><strong>${escapeHtml(mission.intervention)}</strong><small>${escapeHtml(mission.partnerReference)} · Priorité ${escapeHtml(priorityLabel(mission.priority))}</small></article>
            <article><span>Rendez-vous</span><strong>${escapeHtml(formatDateTime(mission.appointmentAt))}</strong><small>${escapeHtml(mission.technician)}</small></article>
        </section>
        <section class="partner-sandbox-layout">
            <aside class="partner-sandbox-actions"><h3>Simulations</h3>${simulationButtons(mission)}</aside>
            <main class="partner-sandbox-content">
                <section class="client-panel"><div class="form-heading"><div><p class="eyebrow">Chronologie simulée</p><h3>Cycle de vie du dossier</h3></div></div><ol class="partner-sandbox-timeline">${mission.timeline.map(timelineItem).join("")}</ol></section>
                <section class="client-panel"><div class="form-heading"><div><p class="eyebrow">Messages</p><h3>Dialogue partenaire et équipe</h3></div><span>${mission.messages.filter(item => item.partnerVisible).length} visible(s) partenaire</span></div><div class="partner-sandbox-messages">${mission.messages.map(messageItem).join("")}</div></section>
                <section class="client-panel"><div class="form-heading"><div><p class="eyebrow">Documents de démonstration</p><h3>Devis, rapport, photos et facture</h3></div></div><div class="partner-sandbox-documents">${mission.documents.map(documentItem).join("")}</div></section>
                <section class="client-panel"><div class="form-heading"><div><p class="eyebrow">Connecteur simulé</p><h3>Échanges API locaux</h3></div></div><div class="partner-sandbox-api-log">${sandbox.apiLog.length ? sandbox.apiLog.map(apiItem).join("") : '<p class="muted">Aucun échange simulé.</p>'}</div></section>
            </main>
        </section>`;
    bindWorkspace(shell, mission);
}

function simulationButtons(mission) {
    const buttons = [
        ["accept", "Accepter la mission"], ["reject", "Refuser la mission"], ["reschedule", "Modifier le rendez-vous"], ["reassign", "Affecter un autre technicien"],
        ["partner_message", "Ajouter un message partenaire"], ["internal_message", "Ajouter un message interne"], ["request_information", "Demander des informations"],
        ["create_quote", "Créer automatiquement un devis"], ["accept_quote", "Accepter le devis"], ["reject_quote", "Refuser le devis"],
        ["complete_report", "Générer un rapport terminé"], ["add_photos", "Ajouter des photos"], ["create_invoice", "Générer une facture"],
        ["close", "Clôturer la mission"], ["cancel", "Annuler la mission"]
    ];
    return buttons.map(([action, label]) => `<button type="button" class="secondary-button" data-sandbox-action="${action}">${label}</button>`).join("");
}

function bindWorkspace(shell, mission) {
    shell.querySelector("#sandboxMissionSelect").addEventListener("change", event => { sandbox.activeMissionId = event.currentTarget.value; renderWorkspace(shell); });
    shell.querySelector("#newSandboxMission").addEventListener("click", () => runAction("new_mission"));
    shell.querySelector("#resetPartnerSandbox").addEventListener("click", async () => {
        if (!confirm("Supprimer toutes les données de démonstration de cette Sandbox ?")) return;
        const result = await api("/api/partner-sandbox", { method: "DELETE" });
        if (!result.ok) return alert(result.message || "Suppression impossible.");
        sandbox = null;
        renderActivation(shell);
    });
    shell.querySelectorAll("[data-sandbox-action]").forEach(button => button.addEventListener("click", () => requestAction(button.dataset.sandboxAction, mission)));
    shell.querySelectorAll("[data-toggle-sandbox-message]").forEach(button => button.addEventListener("click", () => runAction("toggle_visibility", { messageId: button.dataset.toggleSandboxMessage })));
}

function requestAction(action, mission) {
    if (action === "reschedule") return promptReschedule(mission);
    if (action === "reassign") return pickTechnician();
    if (["partner_message", "internal_message"].includes(action)) {
        const body = prompt(action === "partner_message" ? "Message envoyé par AssurTest Démo :" : "Message interne :");
        if (body === null) return;
        return runAction(action, { body });
    }
    runAction(action);
}

function promptReschedule(mission) {
    const value = prompt("Nouveau rendez-vous (AAAA-MM-JJTHH:MM)", String(mission.appointmentAt || "").slice(0, 16));
    if (value === null) return;
    runAction("reschedule", { appointmentAt: value });
}

function pickTechnician() {
    const options = sandbox.technicians.map((item, index) => `${index + 1}. ${item}`).join("\n");
    const choice = Number(prompt(`Choisissez le technicien :\n${options}`, "2"));
    const technician = sandbox.technicians[choice - 1];
    if (technician) runAction("reassign", { technician });
}

async function runAction(action, body = {}) {
    const result = await api(`/api/partner-sandbox/actions/${encodeURIComponent(action)}`, { method: "POST", body: JSON.stringify(body) });
    if (!result.ok) return alert(result.message || "Simulation impossible.");
    sandbox = result.data.sandbox;
    const shell = document.querySelector(".partner-sandbox-shell");
    if (shell) renderWorkspace(shell);
}

function timelineItem(item) { return `<li class="source-${escapeHtml(item.source)}"><time>${escapeHtml(formatTime(item.occurredAt))}</time><div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.actorName || "Depann’Home Pro")}</small></div></li>`; }
function messageItem(item) { return `<article class="partner-sandbox-message ${escapeHtml(item.senderType)}"><header><strong>${escapeHtml(item.senderName)}</strong><span>${item.senderType === "internal" ? `Interne · ${item.partnerVisible ? "Visible partenaire" : "Masqué partenaire"}` : "Partenaire"}</span></header><p>${escapeHtml(item.body)}</p><footer><time>${escapeHtml(formatDateTime(item.createdAt))}</time>${item.senderType === "internal" ? `<button type="button" class="text-button" data-toggle-sandbox-message="${escapeHtml(item.id)}" title="Basculer la visibilité partenaire">${item.partnerVisible ? "◉ Masquer au partenaire" : "◉ Rendre visible au partenaire"}</button>` : ""}</footer></article>`; }
function documentItem(item) { return `<article class="partner-sandbox-document ${escapeHtml(item.type)}">${item.preview ? `<img src="${escapeHtml(item.preview)}" alt="${escapeHtml(item.title)}">` : `<div class="partner-sandbox-document-icon">${documentIcon(item.type)}</div>`}<div><span>${escapeHtml(documentLabel(item.type))}</span><h4>${escapeHtml(item.title)}</h4><p>${escapeHtml(item.reference)} · ${escapeHtml(documentStatus(item.status))}</p><small>${escapeHtml(formatDateTime(item.createdAt))}</small></div></article>`; }
function apiItem(item) { return `<article><code>${escapeHtml(item.method)} ${escapeHtml(item.endpoint)}</code><span>${escapeHtml(item.status)}</span><p>${escapeHtml(item.detail)}</p><small>${escapeHtml(formatDateTime(item.createdAt))}</small></article>`; }
function activeMission() { return sandbox?.missions?.find(item => item.id === sandbox.activeMissionId) || sandbox?.missions?.[0] || null; }
function statusLabel(value) { return ({ received: "Reçue", pending_validation: "À valider", accepted: "Acceptée", rejected: "Refusée", assigned: "Affectée", scheduled: "Planifiée", en_route: "En route", on_site: "Sur site", report_in_progress: "Rapport en cours", report_completed: "Rapport terminé", report_validated: "Rapport validé", quote_sent: "Devis envoyé", quote_accepted: "Devis accepté", work_completed: "Travaux terminés", invoice_sent: "Facture envoyée", closed: "Clôturée", cancelled: "Annulée" })[value] || "Statut non renseigné"; }
function priorityLabel(value) { return ({ low: "Faible", normal: "Normale", high: "Haute", urgent: "Urgente" })[value] || "Normale"; }
function documentLabel(value) { return ({ quote: "Devis", report: "Rapport", photo: "Photo", invoice: "Facture" })[value] || "Document"; }
function documentStatus(value) { return ({ pending: "En attente", completed: "Terminé", available: "Disponible", draft: "Brouillon", issued: "Émise", accepted: "Accepté", rejected: "Refusé" })[value] || "Statut non renseigné"; }
function documentIcon(value) { return ({ quote: "DEV", report: "RAP", invoice: "FAC" })[value] || "DOC"; }
function formatDateTime(value) { return value ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—"; }
function formatTime(value) { return value ? new Intl.DateTimeFormat("fr-FR", { timeStyle: "short" }).format(new Date(value)) : "—"; }
async function api(url, options = {}) { try { const response = await fetch(url, { credentials: "same-origin", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options }); const data = response.status === 204 ? null : await response.json().catch(() => null); return { ok: response.ok, status: response.status, data, message: data?.message }; } catch { return { ok: false, message: "Serveur indisponible." }; } }
