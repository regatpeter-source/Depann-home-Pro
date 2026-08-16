import { ROUTES } from "./config.js?v=118";
import { clearSearch, getContainer, setPage } from "./ui.js?v=44";
import { escapeHtml } from "./utils.js?v=44";
import { openPartnerDialogue } from "./partner-dialogue.js?v=16";
import { getSearchableClients } from "./clients.js?v=144";
import { synchronizeClients } from "./client-sync.js?v=124";
import { loadPartnerNotifications, markPartnerNotificationsRead } from "./collaboration.js?v=4";

let dashboard = null;
let activeMissionTab = "received";
let activeMissionSpace = "network";
let preferredConnectionId = "";

window.addEventListener("depannhome:new-partner-mission", event => { preferredConnectionId = String(event.detail?.connectionId || ""); activeMissionSpace = "network"; activeMissionTab = "new"; });
window.addEventListener("depannhome:open-partner-missions", event => { activeMissionSpace = "network"; activeMissionTab = event.detail?.tab === "messages" ? "messages" : "received"; });

export async function renderPartnerMissions(options = {}) {
    clearSearch();
    setPage("Missions partenaires", ROUTES.partnerMissions, "detail");
    const container = getContainer();
    container.innerHTML = '<section class="partner-mission-shell"><p class="muted">Chargement des missions partenaires…</p></section>';
    const [result, sentResult, connectionsResult, sandboxResult, alerts] = await Promise.all([api("/api/partner-missions"), api("/api/partner-connections/missions-sent"), canManagePartnerMissions() ? api("/api/partner-connections") : Promise.resolve({ ok: true, data: { connections: [] } }), canManagePartnerMissions() ? api("/api/partner-api-sandbox/company") : Promise.resolve({ ok: true, data: { available: false } }), loadPartnerNotifications()]);
    if (!result.ok) { container.innerHTML = `<section class="client-panel"><p class="auth-message error">${escapeHtml(result.message || "Impossible de charger les missions.")}</p></section>`; return; }
    dashboard = { ...result.data, sentMissions: sentResult.ok ? sentResult.data?.missions || [] : [], connections: connectionsResult.ok ? connectionsResult.data?.connections || [] : [], apiSandbox: sandboxResult.ok ? sandboxResult.data : { available: false } };
    const shell = container.querySelector(".partner-mission-shell");
    const networkMissions = dashboard.missions.filter(mission => mission.sourceType === "depannhome_network");
    const externalMissions = dashboard.missions.filter(mission => mission.sourceType !== "depannhome_network");
    const pending = (activeMissionSpace === "network" ? networkMissions : externalMissions).filter(mission => ["received", "pending_validation"].includes(mission.status)).length;
    const networkTabs = `<button type="button" class="secondary-button" data-mission-tab="received">Missions reçues${pending ? ` (${pending})` : ""}</button><button type="button" class="secondary-button" data-mission-tab="sent">Missions envoyées</button>${canManagePartnerMissions() ? '<button type="button" class="secondary-button" data-mission-tab="new">Nouvelle mission</button>' : ""}<button type="button" class="secondary-button" data-mission-tab="messages">Messagerie</button>`;
    const externalTabs = '<button type="button" class="secondary-button" data-mission-tab="received">Missions reçues</button><button type="button" class="secondary-button" data-mission-tab="messages">Messagerie</button>';
    shell.innerHTML = `<header class="partner-mission-heading"><div><p class="eyebrow">Suivi opérationnel</p><h2>${activeMissionSpace === "network" ? "Réseau Depann’Home Pro" : "Connecteurs externes"}</h2><p class="muted">${activeMissionSpace === "network" ? "Missions, messagerie et documents entre entreprises utilisant Depann’Home Pro." : "Missions transmises directement par vos assurances, donneurs d’ordre, plateformes ou logiciels métiers via API."}</p></div><div class="partner-mission-actions"><button class="secondary-button" id="refreshPartnerMissions">Actualiser</button>${activeMissionSpace === "external" && canManagePartnerMissions() ? '<button class="secondary-button" id="retryPartnerOutbox">Relancer les retours API</button>' : ""}</div></header>${alerts.length ? `<section class="partner-mission-alerts"><h3>Notifications partenaires</h3>${alerts.slice(0, 10).map(alert => `<article class="${alert.readAt ? "read" : "unread"}"><strong>${escapeHtml(alert.title)}</strong><p>${escapeHtml(alert.body)}</p><small>${escapeHtml(formatMissionDate(alert.createdAt))}</small></article>`).join("")}</section>` : ""}<nav class="partner-network-tabs partner-mission-tabs" aria-label="Origine des missions"><button type="button" class="secondary-button${activeMissionSpace === "network" ? " active" : ""}" data-mission-space="network">Réseau Depann’Home Pro</button><button type="button" class="secondary-button${activeMissionSpace === "external" ? " active" : ""}" data-mission-space="external">Connecteurs externes</button></nav><nav class="partner-network-tabs partner-mission-tabs" aria-label="Sections des missions">${activeMissionSpace === "network" ? networkTabs : externalTabs}</nav><section class="partner-mission-counters"><article class="attention"><span>À valider</span><strong>${pending}</strong></article><article><span>${activeMissionSpace === "network" ? "Envoyées" : "Connexions API"}</span><strong>${activeMissionSpace === "network" ? dashboard.sentMissions.length : dashboard.intakes.length}</strong></article><article><span>${activeMissionSpace === "network" ? "Retours en échec" : "Missions reçues"}</span><strong>${activeMissionSpace === "network" ? dashboard.failedDeliveries : externalMissions.length}</strong></article></section><div id="partnerMissionContent"></div>`;
    if (dashboard.apiSandbox?.available) {
        const button = document.createElement("button");
        button.type = "button"; button.className = "secondary-button sandbox-receiver-button";
        button.textContent = `🧪 API Sandbox${dashboard.apiSandbox.missions?.length ? ` (${dashboard.apiSandbox.missions.length})` : ""}`;
        button.addEventListener("click", openCompanyApiSandboxInbox);
        shell.querySelector(".partner-mission-actions")?.prepend(button);
    }
    await markPartnerNotificationsRead();
    enablePartnerNotificationDeletion(shell, alerts);
    shell.querySelector("#refreshPartnerMissions").addEventListener("click", renderPartnerMissions);
    shell.querySelector("#retryPartnerOutbox")?.addEventListener("click", async () => { const result = await api("/api/partner-missions/outbox/retry", { method: "POST" }); alert(result.ok ? `${result.data.delivered} retour(s) transmis.` : result.message); renderPartnerMissions(); });
    shell.querySelectorAll("[data-mission-space]").forEach(button => button.addEventListener("click", () => { activeMissionSpace = button.dataset.missionSpace; activeMissionTab = "received"; renderPartnerMissions(); }));
    shell.querySelectorAll("[data-mission-tab]").forEach(button => button.addEventListener("click", () => { activeMissionTab = button.dataset.missionTab; renderMissionTab(shell); }));
    renderMissionTab(shell);
    if (options.missionId) options.sourceDialogue ? await openPartnerDialogue(options.missionId, { sourceDialogue: true }) : await showDetail(options.missionId);
}

function openCompanyApiSandboxInbox() {
    const receiver = dashboard?.apiSandbox;
    if (!receiver?.available) return;
    const missions = receiver.missions || [], logs = receiver.logs || [];
    const content = `<div class="company-api-sandbox-inbox"><p class="eyebrow">🧪 MODE SANDBOX · Réception entreprise</p><h3>${escapeHtml(receiver.sandbox?.partner?.name || "Dépann'Home Test Services")}</h3><div class="sandbox-warning-banner"><strong>Données fictives isolées.</strong> Ces missions n’apparaissent pas dans les dossiers, clients ou statistiques de production.</div><h4>Missions reçues par API</h4><div class="partner-mission-list">${missions.length ? missions.map(mission => `<article class="partner-mission-card"><div class="partner-mission-card-title"><div><p class="eyebrow">${escapeHtml(mission.externalMissionId)}</p><h3>${escapeHtml(mission.mappedData?.clientName || "Client test")}</h3><p>${escapeHtml(mission.mappedData?.address || "Adresse test")}</p></div><span class="partner-mission-status ${escapeHtml(mission.status)}">${escapeHtml(labelStatus(mission.status))}</span></div><p>${escapeHtml(mission.mappedData?.interventionType || "Intervention test")}</p><div class="partner-mission-card-actions">${[["accepted","Accepter"],["in_progress","En cours"],["completed","Terminer"],["rejected","Refuser"]].map(([status,label]) => `<button type="button" class="secondary-button" data-company-sandbox-status="${status}" data-company-sandbox-mission="${mission.id}">${label}</button>`).join("")}</div></article>`).join("") : '<p class="muted">Aucune mission Sandbox reçue.</p>'}</div><h4>Échanges API expurgés</h4><div class="partner-sandbox-api-log">${logs.length ? logs.slice(0, 30).map(log => `<article><code>${escapeHtml(log.direction)} · ${escapeHtml(log.endpoint)}</code><span>HTTP ${escapeHtml(log.httpStatus ?? "—")}</span><p>${escapeHtml(log.errorMessage || log.eventType || "Échange traité")}</p><small>${escapeHtml(formatMissionDate(log.createdAt))}</small></article>`).join("") : '<p class="muted">Aucun échange enregistré.</p>'}</div></div>`;
    const dialog = openDialog(content);
    dialog.querySelectorAll("[data-company-sandbox-status]").forEach(button => button.addEventListener("click", async () => {
        button.disabled = true;
        const result = await api("/api/partner-api-sandbox/company/status", { method: "POST", body: JSON.stringify({ missionId: button.dataset.companySandboxMission, status: button.dataset.companySandboxStatus }) });
        if (!result.ok) { button.disabled = false; return alert(result.message || "Mise à jour Sandbox impossible."); }
        dialog.remove();
        await renderPartnerMissions();
        openCompanyApiSandboxInbox();
    }));
}

function renderMissionTab(shell) {
    shell.querySelectorAll("[data-mission-tab]").forEach(button => button.classList.toggle("active", button.dataset.missionTab === activeMissionTab));
    const content = shell.querySelector("#partnerMissionContent");
    if (activeMissionTab === "new") return renderNewMissionEntry(content);
    const sent = activeMissionSpace === "network" && activeMissionTab === "sent";
    const messages = activeMissionTab === "messages";
    const received = dashboard.missions.filter(mission => activeMissionSpace === "network" ? mission.sourceType === "depannhome_network" : mission.sourceType !== "depannhome_network");
    const source = messages && activeMissionSpace === "network" ? [...received.map(mission => ({ ...mission, conversationSide: "received" })), ...dashboard.sentMissions.map(mission => ({ ...mission, conversationSide: "sent" }))] : sent ? dashboard.sentMissions : received;
    const externalIntro = activeMissionSpace === "external" ? '<p class="muted">Ces missions proviennent de connecteurs API. Leur Centre de mission utilise la même interface professionnelle, le même journal et les mêmes échanges de documents que les missions du réseau. Le partenaire externe consulte et alimente ces échanges depuis son propre logiciel via API.</p>' : "";
    content.innerHTML = `${externalIntro}${messages ? '<p class="muted">Une conversation est disponible pour chaque mission. Ouvrez-la pour écrire directement à l’autre entreprise et consulter les informations partagées.</p>' : `<div class="partner-mission-filters"><label>Statut <select id="partnerMissionStatus"><option value="">Tous les statuts</option>${dashboard.statuses.map(status => `<option value="${escapeHtml(status)}">${escapeHtml(labelStatus(status))}</option>`).join("")}</select></label><label>Recherche <input id="partnerMissionSearch" type="search" placeholder="Client, référence, adresse"></label></div>`}<section class="partner-mission-list" id="partnerMissionList"></section>`;
    const renderList = () => {
        const status = content.querySelector("#partnerMissionStatus")?.value || "";
        const query = content.querySelector("#partnerMissionSearch")?.value.trim().toLowerCase() || "";
        const missions = source.filter(mission => {
            const matchesSearch = `${mission.missionNumber} ${mission.externalMissionId} ${mission.partnerReference} ${mission.partnerName} ${mission.mappedData?.clientName} ${mission.mappedData?.address}`.toLowerCase().includes(query);
            return (!status || mission.status === status) && (mission.status !== "closed" || Boolean(query) || status === "closed") && (!query || matchesSearch);
        });
        renderMissions(content.querySelector("#partnerMissionList"), missions, { sent, messages });
    };
    content.querySelector("#partnerMissionStatus")?.addEventListener("change", renderList);
    content.querySelector("#partnerMissionSearch")?.addEventListener("input", renderList);
    renderList();
}

function renderMissions(node, missions, options = {}) { node.innerHTML = missions.length ? missions.map(mission => `<article class="partner-mission-card priority-${escapeHtml(mission.priority)}"><div class="partner-mission-card-title"><div><p class="eyebrow">${escapeHtml(mission.partnerName || "Partenaire")} · ${escapeHtml(mission.missionNumber || "Mission partenaire")}</p><h3>${escapeHtml(mission.mappedData?.clientName || "Client non renseigné")}</h3><p>${escapeHtml(mission.mappedData?.address || "Adresse non renseignée")}</p></div><span class="partner-mission-status ${escapeHtml(mission.status)}">${escapeHtml(labelStatus(mission.status))}</span></div><div class="partner-mission-meta"><span>${escapeHtml(mission.mappedData?.interventionType || "Intervention")}</span><span>${mission.scheduledDate ? escapeHtml(mission.scheduledDate) : "À planifier"}</span><span class="priority">${escapeHtml(labelPriority(mission.priority))}</span></div><p>${escapeHtml(mission.mappedData?.description || mission.mappedData?.comments || "Aucun descriptif transmis.")}</p><div class="partner-mission-card-actions">${options.sent || mission.conversationSide === "sent" ? `<span class="muted">Envoyée le ${escapeHtml(formatMissionDate(mission.sentAt))}</span><button class="secondary-button" data-open-sent-dialogue="${mission.id}">Ouvrir la conversation</button>${["received", "pending_validation"].includes(mission.status) ? `<button class="danger-button" data-delete-sent="${mission.id}">Supprimer</button>` : !["closed", "cancelled", "rejected"].includes(mission.status) ? `<button class="danger-button" data-cancel-sent="${mission.id}">Clôturer / Annuler</button>` : ""}` : `<span class="muted">Reçue le ${escapeHtml(formatMissionDate(mission.createdAt))}</span><button class="secondary-button" data-open="${mission.id}">Détail</button><button class="secondary-button" data-open-dialogue="${mission.id}">Ouvrir la conversation</button>${canManagePartnerMissions() && ["received", "pending_validation"].includes(mission.status) ? `<button class="secondary-button" data-accept="${mission.id}">Accepter et planifier</button><button class="danger-button" data-reject="${mission.id}">Refuser</button>` : canManagePartnerMissions() && !["closed", "cancelled", "rejected"].includes(mission.status) ? `<button class="secondary-button" data-close="${mission.id}">Clôturer la mission</button>` : ""}`}</div></article>`).join("") : '<p class="muted">Aucune mission ne correspond à ce filtre.</p>';
    enableClosedMissionCorrection(node, missions, options);
    enableTerminalMissionSelection(node, missions, options);
    node.querySelectorAll("[data-accept]").forEach(button => {
        const mission = missions.find(item => String(item.id) === button.dataset.accept);
        if (["received", "pending_validation"].includes(mission?.status) && mission?.planningDraft?.pausedAt) {
            button.textContent = "Reprendre la planification";
            button.title = "Reprendre les informations enregistrées après l’appel du client";
            const notice = document.createElement("p");
            notice.className = "muted";
            notice.textContent = `Planification en pause · enregistrée le ${formatMissionDate(mission.planningDraft.pausedAt)}`;
            button.closest(".partner-mission-card-actions")?.before(notice);
        }
    });
    node.querySelectorAll("[data-open]").forEach(button => button.addEventListener("click", () => showDetail(button.dataset.open)));
    node.querySelectorAll("[data-open-dialogue]").forEach(button => button.addEventListener("click", () => openPartnerDialogue(button.dataset.openDialogue)));
    node.querySelectorAll("[data-open-sent-dialogue]").forEach(button => button.addEventListener("click", () => openPartnerDialogue(button.dataset.openSentDialogue, { sourceDialogue: true })));
    node.querySelectorAll("[data-accept]").forEach(button => button.addEventListener("click", () => {
        const mission = dashboard.missions.find(item => Number(item.id) === Number(button.dataset.accept));
        if (mission?.sourceType === "depannhome_network") openNetworkMissionPlanning(mission);
        else showAccept(button.dataset.accept);
    }));
    node.querySelectorAll("[data-reject]").forEach(button => button.addEventListener("click", async () => { const reason = prompt("Motif du refus à transmettre au partenaire :"); if (reason === null) return; const result = await api(`/api/partner-missions/${button.dataset.reject}/reject`, { method: "POST", body: JSON.stringify({ reason }) }); if (!result.ok) return alert(result.message); renderPartnerMissions(); }));
    node.querySelectorAll("[data-delete-sent]").forEach(button => button.addEventListener("click", async () => { if (!confirm("Êtes-vous certain de vouloir supprimer cette mission ?\n\nCette action est irréversible.")) return; const result = await api(`/api/partner-connections/missions/${button.dataset.deleteSent}`, { method: "DELETE" }); if (!result.ok) return alert(result.message); renderPartnerMissions(); }));
    node.querySelectorAll("[data-cancel-sent]").forEach(button => button.addEventListener("click", async () => { if (!confirm("Annuler cette mission acceptée ? L’historique sera conservé chez les deux entreprises.")) return; const reason = prompt("Motif de l’annulation (facultatif) :"); if (reason === null) return; const result = await api(`/api/partner-connections/missions/${button.dataset.cancelSent}/cancel`, { method: "POST", body: JSON.stringify({ reason }) }); if (!result.ok) return alert(result.message); renderPartnerMissions(); }));
    node.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", async () => { if (!confirm("Clôturer cette mission ? Le journal sera conservé et la conversation deviendra en lecture seule.")) return; const result = await api(`/api/partner-missions/${button.dataset.close}/close`, { method: "POST" }); if (!result.ok) return alert(result.message); renderPartnerMissions(); }));
}

function enableClosedMissionCorrection(node, missions, options) {
    if (!canManagePartnerMissions() || options.sent || options.messages) return;
    missions.forEach((mission, index) => {
        if (mission.status !== "closed") return;
        const actions = node.children[index]?.querySelector(".partner-mission-card-actions");
        if (!actions) return;
        actions.insertAdjacentHTML("beforeend", `<button class="secondary-button" data-reopen="${mission.id}">Rouvrir</button><button class="danger-button" data-archive-closed="${mission.id}">Supprimer</button>`);
    });
    node.querySelectorAll("[data-reopen]").forEach(button => button.addEventListener("click", async () => {
        if (!confirm("Rouvrir cette mission ? Le partenaire sera informé du retour au statut opérationnel.")) return;
        const reason = prompt("Motif de la réouverture (facultatif) :"); if (reason === null) return;
        const result = await api(`/api/partner-missions/${button.dataset.reopen}/reopen`, { method: "POST", body: JSON.stringify({ reason }) });
        if (!result.ok) return alert(result.message); renderPartnerMissions();
    }));
    node.querySelectorAll("[data-archive-closed]").forEach(button => button.addEventListener("click", async () => {
        if (!confirm("Supprimer cette mission clôturée de la liste ? Le journal restera conservé.")) return;
        const reason = prompt("Motif de la suppression (facultatif) :"); if (reason === null) return;
        const result = await api(`/api/partner-missions/${button.dataset.archiveClosed}/archive-closed`, { method: "POST", body: JSON.stringify({ reason }) });
        if (!result.ok) return alert(result.message); renderPartnerMissions();
    }));
}

function enablePartnerNotificationDeletion(shell, alerts) {
    const section = shell.querySelector(".partner-mission-alerts");
    const shownAlerts = alerts.slice(0, 10);
    const cards = [...section?.querySelectorAll("article") || []];
    if (!section || !shownAlerts.length || cards.length !== shownAlerts.length) return;
    section.querySelector("h3")?.insertAdjacentHTML("afterend", '<div class="form-actions"><label><input type="checkbox" data-select-all-partner-notifications> Tout sélectionner</label><button type="button" class="danger-button" data-delete-selected-partner-notifications disabled>Supprimer la sélection</button></div>');
    cards.forEach((card, index) => card.insertAdjacentHTML("afterbegin", `<label><input type="checkbox" data-partner-notification-id="${escapeHtml(shownAlerts[index].id)}"> Sélectionner</label>`));
    const button = section.querySelector("[data-delete-selected-partner-notifications]");
    const selectAll = section.querySelector("[data-select-all-partner-notifications]");
    const inputs = [...section.querySelectorAll("[data-partner-notification-id]")];
    const selectedIds = () => inputs.filter(input => input.checked).map(input => Number(input.dataset.partnerNotificationId)).filter(Number.isSafeInteger);
    const updateButton = () => { const count = selectedIds().length; button.disabled = count === 0; button.textContent = count ? `Supprimer la sélection (${count})` : "Supprimer la sélection"; selectAll.checked = count === inputs.length; selectAll.indeterminate = count > 0 && count < inputs.length; };
    inputs.forEach(input => input.addEventListener("change", updateButton));
    selectAll.addEventListener("change", () => { inputs.forEach(input => { input.checked = selectAll.checked; }); updateButton(); });
    button.addEventListener("click", async () => {
        const ids = selectedIds();
        if (!ids.length || !confirm(`Supprimer définitivement ${ids.length} notification${ids.length > 1 ? "s" : ""} partenaire${ids.length > 1 ? "s" : ""} ?`)) return;
        const result = await api("/api/collaboration/partner-notifications", { method: "DELETE", body: JSON.stringify({ ids }) });
        if (!result.ok) return alert(result.message);
        renderPartnerMissions();
    });
    updateButton();
}

function enableTerminalMissionSelection(node, missions, options) {
    if (!canManagePartnerMissions()) return;
    const selectable = missions.map((mission, index) => ({ mission, card: node.children[index] })).filter(({ mission, card }) => card && ["rejected", "cancelled"].includes(mission.status));
    if (!selectable.length) return;
    const toolbar = document.createElement("div");
    toolbar.className = "form-actions";
    toolbar.innerHTML = '<label><input type="checkbox" data-select-all-terminal-missions> Tout sélectionner</label><button type="button" class="danger-button" data-archive-selected-terminal disabled>Supprimer la sélection</button>';
    node.prepend(toolbar);
    selectable.forEach(({ mission, card }) => {
        const sent = options.sent || mission.conversationSide === "sent";
        const actions = card.querySelector(".partner-mission-card-actions") || card;
        actions.insertAdjacentHTML("afterbegin", `<label><input type="checkbox" data-terminal-mission-id="${mission.id}" data-terminal-mission-source="${sent ? "sent" : "received"}"> Sélectionner</label>`);
    });
    const button = toolbar.querySelector("[data-archive-selected-terminal]");
    const selectAll = toolbar.querySelector("[data-select-all-terminal-missions]");
    const inputs = [...node.querySelectorAll("[data-terminal-mission-id]")];
    const selected = () => inputs.filter(input => input.checked);
    const updateButton = () => { const count = selected().length; button.disabled = count === 0; button.textContent = count ? `Supprimer la sélection (${count})` : "Supprimer la sélection"; selectAll.checked = count === inputs.length; selectAll.indeterminate = count > 0 && count < inputs.length; };
    inputs.forEach(input => input.addEventListener("change", updateButton));
    selectAll.addEventListener("change", () => { inputs.forEach(input => { input.checked = selectAll.checked; }); updateButton(); });
    button.addEventListener("click", async () => {
        const inputs = selected();
        if (!inputs.length || !confirm(`Masquer ${inputs.length} mission${inputs.length > 1 ? "s" : ""} refusée${inputs.length > 1 ? "s" : ""} ou annulée${inputs.length > 1 ? "s" : ""} ? L’historique restera conservé.`)) return;
        const sentIds = inputs.filter(input => input.dataset.terminalMissionSource === "sent").map(input => Number(input.dataset.terminalMissionId));
        const receivedIds = inputs.filter(input => input.dataset.terminalMissionSource === "received").map(input => Number(input.dataset.terminalMissionId));
        const results = await Promise.all([
            sentIds.length ? api("/api/partner-connections/missions/archive-terminal", { method: "POST", body: JSON.stringify({ ids: sentIds }) }) : Promise.resolve({ ok: true }),
            receivedIds.length ? api("/api/partner-missions/archive-terminal", { method: "POST", body: JSON.stringify({ ids: receivedIds }) }) : Promise.resolve({ ok: true })
        ]);
        const failed = results.find(result => !result.ok);
        if (failed) return alert(failed.message);
        renderPartnerMissions();
    });
    updateButton();
}

function renderNewMissionEntry(node) {
    const connections = dashboard.connections.filter(connection => connection.status === "connected" && connection.permissions?.canSendInterventions);
    if (!connections.length) { node.innerHTML = '<section class="client-panel"><p class="auth-message error">Aucun partenaire connecté n’est autorisé à recevoir des missions.</p></section>'; return; }
    const clients = getSearchableClients().sort((first, second) => first.name.localeCompare(second.name, "fr"));
    let step = 1;
    const values = { connectionId: preferredConnectionId || String(connections[0].id), clientId: "", clientMode: "existing", missionNumber: "", interventionNumber: "", subject: "", interventionType: "", priority: "normal", comments: "", requestedDate: new Date().toISOString().slice(0, 10), keepInOwnCalendar: false, sharedAttachmentIds: [] };
    const render = () => {
        const connection = connections.find(item => String(item.id) === String(values.connectionId)) || connections[0];
        const selectedClient = clients.find(client => String(client.id) === String(values.clientId));
        const clientSummary = selectedClient ? selectedClient.name : values.clientName || "Nouveau client";
        node.innerHTML = `<section class="client-panel partner-mission-wizard"><div class="form-heading"><div><p class="eyebrow">Nouvelle mission partenaire</p><h2>Étape ${step} sur 4</h2></div><span class="partner-mission-status pending">Brouillon</span></div><ol class="partner-mission-steps"><li class="${step >= 1 ? "active" : ""}">Client</li><li class="${step >= 2 ? "active" : ""}">Partenaire</li><li class="${step >= 3 ? "active" : ""}">Mission</li><li class="${step >= 4 ? "active" : ""}">Récapitulatif</li></ol>${wizardStepHtml(step, values, clients, connections, selectedClient, connection, clientSummary)}<p class="auth-message" aria-live="polite"></p></section>`;
        const form = node.querySelector("form");
        form?.elements.clientMode?.addEventListener("change", event => { values.clientMode = event.currentTarget.value; render(); });
        form?.querySelectorAll("[data-attachment-folder]").forEach(folderInput => folderInput.addEventListener("change", () => {
            form.querySelectorAll("[data-attachment-folder-item]").forEach(item => { if (item.dataset.attachmentFolderItem === folderInput.dataset.attachmentFolder) item.checked = folderInput.checked; });
        }));
        form?.addEventListener("submit", async event => {
            event.preventDefault();
            const formValues = Object.fromEntries(new FormData(form));
            Object.assign(values, formValues);
            if (form.elements.keepInOwnCalendar) values.keepInOwnCalendar = form.elements.keepInOwnCalendar.checked;
            if (step === 4) values.sharedAttachmentIds = [...form.querySelectorAll("[name=sharedAttachmentIds]:checked")].map(input => input.value);
            if (step === 1 && values.clientMode === "existing" && !values.clientId) return showWizardMessage(node, "Choisissez un client existant ou créez-en un.");
            if (step === 1 && values.clientMode === "new" && !values.clientName?.trim()) return showWizardMessage(node, "Le nom du nouveau client est obligatoire.");
            if (step === 3 && (!values.subject?.trim() || !values.requestedDate)) return showWizardMessage(node, "L’objet et la date souhaitée sont obligatoires.");
            if (step < 4) { step += 1; render(); return; }
            const payload = { connectionId: values.connectionId, missionNumber: values.missionNumber, interventionNumber: values.interventionNumber, subject: values.subject, interventionType: values.interventionType, priority: values.priority, comments: values.comments, requestedDate: values.requestedDate, keepInOwnCalendar: values.keepInOwnCalendar === true, sharedAttachmentIds: values.sharedAttachmentIds, client: values.clientMode === "existing" ? { id: values.clientId } : { name: values.clientName, type: values.clientType, phone: values.clientPhone, email: values.clientEmail, address: values.clientAddress, city: values.clientCity } };
            const button = event.submitter instanceof HTMLButtonElement ? event.submitter : form.querySelector("button:not([type]), button[type=submit]");
            if (button) button.disabled = true;
            const result = await api("/api/partner-connections/missions", { method: "POST", body: JSON.stringify(payload) });
            if (!result.ok) { if (button) button.disabled = false; return showWizardMessage(node, result.message || "Mission impossible à envoyer."); }
            node.innerHTML = `<section class="client-panel partner-mission-success"><p class="eyebrow">Mission envoyée</p><h2>La mission a été transmise à ${escapeHtml(result.data.mission.partner.name)}.</h2><p>${values.keepInOwnCalendar ? "Un rendez-vous a également été conservé dans votre planning." : "Aucun rendez-vous n’a été créé dans votre planning : l’entreprise partenaire planifiera son intervention."}</p><div class="form-actions"><button class="secondary-button" data-show-sent>Voir les missions envoyées</button><button class="secondary-button" data-new-mission>Créer une autre mission</button></div></section>`;
            node.querySelector("[data-show-sent]").addEventListener("click", () => { activeMissionTab = "sent"; renderPartnerMissions(); });
            node.querySelector("[data-new-mission]").addEventListener("click", () => renderNewMissionEntry(node));
        });
        node.querySelector("[data-wizard-back]")?.addEventListener("click", () => { step = Math.max(1, step - 1); render(); });
    };
    render();
}

function wizardStepHtml(step, values, clients, connections, selectedClient, connection, clientSummary) {
    if (step === 1) return `<form class="client-form"><div class="form-grid"><label>Mode<select name="clientMode"><option value="existing" ${values.clientMode === "existing" ? "selected" : ""}>Sélectionner un client existant</option><option value="new" ${values.clientMode === "new" ? "selected" : ""}>Créer un nouveau client</option></select></label>${values.clientMode === "existing" ? `<label class="form-wide">Client<select name="clientId"><option value="">Choisir un client</option>${clients.map(client => `<option value="${escapeHtml(client.id)}" ${String(client.id) === String(values.clientId) ? "selected" : ""}>${escapeHtml([client.name, client.city, client.phone].filter(Boolean).join(" · "))}</option>`).join("")}</select></label>` : `<label>Nom / société *<input name="clientName" required value="${escapeHtml(values.clientName || "")}"></label><label>Type<select name="clientType"><option>Particulier</option><option>Professionnel</option><option>Syndic</option></select></label><label>Téléphone<input name="clientPhone" value="${escapeHtml(values.clientPhone || "")}"></label><label>E-mail<input name="clientEmail" type="email" value="${escapeHtml(values.clientEmail || "")}"></label><label class="form-wide">Adresse<input name="clientAddress" value="${escapeHtml(values.clientAddress || "")}"></label><label>Ville<input name="clientCity" value="${escapeHtml(values.clientCity || "")}"></label>`}</div><div class="form-actions"><button class="secondary-button">Continuer</button></div></form>`;
    if (step === 2) return `<form class="client-form"><div class="form-grid"><label class="form-wide">Partenaire connecté<select name="connectionId">${connections.map(item => `<option value="${item.id}" ${String(item.id) === String(values.connectionId) ? "selected" : ""}>${escapeHtml(item.partner.name)} · ${escapeHtml(item.partner.city || "Ville non renseignée")}</option>`).join("")}</select></label></div><p class="muted">Le partenaire est prérempli depuis votre carte. Vous pouvez le modifier avant l’envoi.</p><div class="form-actions"><button type="button" class="secondary-button" data-wizard-back>Retour</button><button class="secondary-button">Continuer</button></div></form>`;
    if (step === 3) return `<form class="client-form"><div class="form-grid"><label>N° de mission<input name="missionNumber" maxlength="64" value="${escapeHtml(values.missionNumber)}" placeholder="Ex. MIS-2026-0042"><small>Facultatif : généré automatiquement si vide.</small></label><label>N° d’intervention<input name="interventionNumber" maxlength="64" value="${escapeHtml(values.interventionNumber)}" placeholder="Ex. INT-2026-0158"><small>Facultatif : généré automatiquement si vide.</small></label><label>Objet de la mission *<input name="subject" required maxlength="160" value="${escapeHtml(values.subject)}" placeholder="Ex. Dépannage volet roulant"></label><label>Type d’intervention<input name="interventionType" maxlength="160" value="${escapeHtml(values.interventionType)}" placeholder="Ex. Motorisation"></label><label>Niveau d’urgence<select name="priority"><option value="low" ${values.priority === "low" ? "selected" : ""}>Faible</option><option value="normal" ${values.priority === "normal" ? "selected" : ""}>Normale</option><option value="high" ${values.priority === "high" ? "selected" : ""}>Haute</option><option value="urgent" ${values.priority === "urgent" ? "selected" : ""}>Urgente</option></select></label><label>Date souhaitée *<input name="requestedDate" type="date" required value="${escapeHtml(values.requestedDate)}"></label><label class="form-wide">Commentaires<textarea name="comments" rows="5" maxlength="2000" placeholder="Informations utiles, accès, matériel, consignes…">${escapeHtml(values.comments)}</textarea></label><label class="creator-switch form-wide">Conserver également cette intervention dans le planning de mon entreprise<input name="keepInOwnCalendar" type="checkbox" ${values.keepInOwnCalendar === true ? "checked" : ""}><span>Option désactivée par défaut. Sans cette option, seul le partenaire exécutant créera et gérera le rendez-vous.</span></label></div><div class="form-actions"><button type="button" class="secondary-button" data-wizard-back>Retour</button><button class="secondary-button">Voir le récapitulatif</button></div></form>`;
    const attachments = Array.isArray(selectedClient?.attachments) ? selectedClient.attachments.filter(attachment => attachment?.id) : [];
    const folders = new Map();
    attachments.forEach(attachment => { const folder = attachment.type || "Autre"; folders.set(folder, [...(folders.get(folder) || []), attachment]); });
    const sharing = attachments.length ? `<section class="partner-mission-details"><h3>Pièces jointes du client</h3><p class="muted">Aucun dossier client n’est transmis par défaut. Sélectionnez uniquement les fichiers utiles à cette mission ; l’historique, les devis, factures, rapports et conversations restent privés.</p>${[...folders.entries()].map(([folder, files]) => `<fieldset><label><input type="checkbox" data-attachment-folder="${escapeHtml(folder)}"> <strong>${escapeHtml(folder)}</strong> — sélectionner ce dossier</label>${files.map(attachment => `<label><input type="checkbox" name="sharedAttachmentIds" value="${escapeHtml(attachment.id)}" data-attachment-folder-item="${escapeHtml(folder)}" ${values.sharedAttachmentIds.includes(String(attachment.id)) ? "checked" : ""}> ${escapeHtml(attachment.name)}${attachment.size ? ` (${escapeHtml(formatAttachmentSize(attachment.size))})` : ""}</label>`).join("")}</fieldset>`).join("")}</section>` : `<section class="partner-mission-details"><h3>Pièces jointes du client</h3><p class="muted">Aucune pièce jointe disponible. Seules les informations de la fiche client seront transmises.</p></section>`;
    return `<form class="client-form"><section class="partner-mission-details"><dl><dt>N° mission</dt><dd>${escapeHtml(values.missionNumber || "Généré automatiquement")}</dd><dt>N° intervention</dt><dd>${escapeHtml(values.interventionNumber || "Généré automatiquement")}</dd><dt>Client</dt><dd>${escapeHtml(clientSummary)}</dd><dt>Partenaire</dt><dd>${escapeHtml(connection.partner.name)}</dd><dt>Objet</dt><dd>${escapeHtml(values.subject)}</dd><dt>Intervention</dt><dd>${escapeHtml(values.interventionType || values.subject)}</dd><dt>Urgence</dt><dd>${escapeHtml(labelPriority(values.priority))}</dd><dt>Date souhaitée</dt><dd>${escapeHtml(values.requestedDate)}</dd><dt>Commentaires</dt><dd>${escapeHtml(values.comments || "Aucun")}</dd></dl></section>${sharing}<div class="form-actions"><button type="button" class="secondary-button" data-wizard-back>Modifier</button><button class="secondary-button">Envoyer la mission</button></div></form>`;
}

function formatAttachmentSize(value) { const size = Number(value) || 0; return size >= 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(1)} Mo` : `${Math.max(1, Math.round(size / 1024))} Ko`; }

function showWizardMessage(node, message) { const target = node.querySelector(".auth-message"); target.textContent = message; target.classList.add("error"); }

async function showDetail(id) { const result = await api(`/api/partner-missions/${id}`); if (!result.ok) return alert(result.message); const { mission, history } = result.data; const details = Object.entries(mission.mappedData).filter(([key, value]) => value && !["attachments", "errors"].includes(key)).map(([key, value]) => `<dt>${escapeHtml(labelField(key))}</dt><dd>${escapeHtml(typeof value === "object" ? JSON.stringify(value) : value)}</dd>`).join(""); const dialog = openDialog(`<h3>Mission ${escapeHtml(mission.missionNumber || "partenaire")}</h3><p class="muted">Reçue le ${escapeHtml(formatMissionDate(mission.createdAt))} · ${escapeHtml(mission.partnerName || "Partenaire")} · ${escapeHtml(labelStatus(mission.status))}</p><div class="partner-mission-card-actions"><button class="secondary-button" id="openPartnerDialogue">Ouvrir le dialogue</button></div><dl class="partner-mission-details">${details}</dl><h4>Journal de mission</h4><ol class="partner-mission-history">${history.map(item => `<li><strong>${escapeHtml(labelStatus(item.status))}</strong> · ${escapeHtml(item.action)}<br><small>${escapeHtml(item.actorName)} · ${escapeHtml(formatMissionDate(item.createdAt))}</small></li>`).join("")}</ol>`); dialog.querySelector("#openPartnerDialogue").addEventListener("click", () => { dialog.remove(); openPartnerDialogue(mission.id); }); }
async function openNetworkMissionPlanning(mission) {
    const { renderCalendar } = await import("./calendar.js?v=166");
    const data = mission.mappedData || {};
    const draft = mission.planningDraft || {};
    const hasDraft = Boolean(draft.pausedAt);
    const date = htmlDateValue(draft.date || mission.scheduledDate || data.date) || new Date().toISOString().slice(0, 10);
    const technicianId = String(draft.assignedTechnicianId || mission.assignedTechnicianId || "");
    const assignedTechnicianIds = Array.isArray(draft.assignedTechnicianIds) && draft.assignedTechnicianIds.length ? draft.assignedTechnicianIds.map(String) : technicianId ? [technicianId] : [];
    const pauseEvent = async payload => {
        const result = await api(`/api/partner-missions/${mission.id}/planning-draft`, { method: "PATCH", body: JSON.stringify(payload) });
        if (result.ok) await renderPartnerMissions();
        return result;
    };
    const saveEvent = async payload => {
        const mode = await api(`/api/partner-missions/${mission.id}/billing-mode`, {
            method: "PATCH",
            body: JSON.stringify({ billingMode: payload.billingMode || mission.billingMode || "direct_client" })
        });
        if (!mode.ok) return mode;
        const accepted = await api(`/api/partner-missions/${mission.id}/accept`, {
            method: "POST",
            body: JSON.stringify({
                date: payload.date,
                startTime: payload.startTime,
                endTime: payload.endTime,
                technicianId: payload.assignedTechnicianId,
                assignedTechnicianIds: payload.assignedTechnicianIds,
                assignmentMode: "manual"
            })
        });
        if (!accepted.ok) return accepted;
        mission.status = accepted.data?.mission?.status || "accepted";
        mission.planningDraft = {};
        const eventId = accepted.data?.mission?.calendarEventId;
        if (eventId) {
            const calendarUpdate = await api(`/api/calendar/events/${encodeURIComponent(eventId)}`, {
                method: "PUT",
                body: JSON.stringify(payload)
            });
            if (!calendarUpdate.ok) {
                alert("La mission est acceptée et visible dans le planning, mais certaines personnalisations du rendez-vous n’ont pas pu être appliquées.");
            }
        }
        return accepted;
    };
    await renderCalendar({
        date: new Date(`${date}T12:00:00`),
        view: "month",
        showAllTechnicians: true,
        event: {
            title: hasDraft ? draft.title : `${data.interventionType || "Intervention"}${data.clientName ? ` · ${data.clientName}` : ""}`,
            clientId: mission.clientId || "",
            clientName: data.clientName || "",
            location: hasDraft ? draft.location : data.interventionAddress || data.address || "",
            date,
            startTime: hasDraft ? draft.startTime : mission.scheduledStartTime || data.startTime || "",
            endTime: hasDraft ? draft.endTime : mission.scheduledEndTime || data.endTime || "",
            color: hasDraft ? draft.color : mission.priority === "urgent" ? "red" : mission.priority === "high" ? "orange" : "blue",
            eventType: "appointment",
            notes: hasDraft ? draft.notes : [data.description, data.comments].filter(Boolean).join("\n"),
            assignedTechnicianId: technicianId,
            assignedTechnicianIds,
            partnerMissionId: mission.id,
            partnerMissionNumber: mission.missionNumber,
            partnerName: mission.partnerName,
            billingMode: hasDraft ? draft.billingMode : mission.billingMode || "direct_client",
            saveEvent,
            pauseEvent
        }
    });
}
function showAccept(id) { const mission = dashboard.missions.find(item => Number(item.id) === Number(id)); if (!mission) return; const options = dashboard.technicians.map(technician => `<option value="${technician.id}">${escapeHtml(technician.fullName)}</option>`).join(""); const dialog = openDialog(`<form id="acceptPartnerMission"><h3>Accepter et planifier</h3><p>${escapeHtml(mission.mappedData.clientName || "Client")}</p><div class="form-grid"><label>Date <input name="date" type="date" value="${escapeHtml(htmlDateValue(mission.scheduledDate || mission.mappedData.date))}"></label><label>Début <input name="startTime" type="time" value="${escapeHtml(mission.scheduledStartTime || mission.mappedData.startTime || "")}"></label><label>Fin <input name="endTime" type="time" value="${escapeHtml(mission.scheduledEndTime || mission.mappedData.endTime || "")}"></label><label>Technicien <select name="technicianId"><option value="">Affectation ultérieure</option>${options}</select></label><label>Mode <select name="assignmentMode"><option value="manual">Manuel</option><option value="automatic">Automatique selon la charge</option></select></label><label class="form-wide">Type de facturation<select name="billingMode"><option value="direct_client" ${mission.billingMode !== "principal" ? "selected" : ""}>Facturation directe au client final — devis, factures et comptabilité restent privés</option><option value="principal" ${mission.billingMode === "principal" ? "selected" : ""}>Facturation destinée à l’entreprise donneuse d’ordre — devis et factures partagés</option></select></label></div><p class="muted">Les documents restent internes par défaut. En mode donneur d’ordre, les devis et factures liés à cette mission sont partagés automatiquement.</p><div class="form-actions"><button class="secondary-button">Confirmer</button></div></form>`); dialog.querySelector("form").addEventListener("submit", async event => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); const mode = await api(`/api/partner-missions/${id}/billing-mode`, { method: "PATCH", body: JSON.stringify({ billingMode: values.billingMode }) }); if (!mode.ok) return alert(mode.message); const result = await api(`/api/partner-missions/${id}/accept`, { method: "POST", body: JSON.stringify(values) }); if (!result.ok) return alert(result.message); dialog.remove(); renderPartnerMissions(); }); }
function openDialog(content) { const dialog = document.createElement("div"); dialog.className = "partner-mission-dialog"; dialog.innerHTML = `<section><button class="text-button partner-dialog-close" aria-label="Fermer">Fermer</button>${content}</section>`; dialog.querySelector(".partner-dialog-close").addEventListener("click", () => dialog.remove()); document.body.appendChild(dialog); return dialog; }
function labelStatus(value) { return ({ received: "Reçue", pending_validation: "À valider", accepted: "Acceptée", rejected: "Refusée", assigned: "Affectée", scheduled: "Planifiée", en_route: "En route", on_site: "Sur site", report_in_progress: "Rapport en cours", report_completed: "Rapport terminé", report_validated: "Rapport validé", quote_sent: "Devis envoyé", quote_accepted: "Devis accepté", work_completed: "Travaux terminés", invoice_sent: "Facture envoyée", closed: "Clôturée", cancelled: "Annulée" })[value] || "Statut non renseigné"; }
function labelPriority(value) { return ({ low: "Faible", normal: "Normale", high: "Haute", urgent: "Urgente" })[value] || value; }
function labelField(value) { return ({ clientName: "Client", address: "Adresse", interventionType: "Intervention", partnerReference: "Référence", claimNumber: "Sinistre", phone: "Téléphone", email: "E-mail", description: "Description", comments: "Commentaires", insurance: "Assureur", expert: "Expert", manager: "Gestionnaire", date: "Date", startTime: "Début", endTime: "Fin", gps: "GPS" })[value] || value; }
function formatDate(value) { return value ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : ""; }
function formatMissionDate(value) { return value ? new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)).replace(/:/g, " h ") : "Date inconnue"; }
function htmlDateValue(value) { const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || "")); return match ? match[1] : ""; }
function canManagePartnerMissions() { return ["admin", "pc_standard", "mobile_admin"].includes(document.body.dataset.role); }
async function api(url, options = {}) {
    try {
        if (/\/api\/partner-missions\/\d+\/accept$/.test(url)) {
            const payload = typeof options.body === "string" ? JSON.parse(options.body) : options.body || {};
            if (!htmlDateValue(payload.date)) return { ok: false, message: "Choisissez une date pour ajouter cette intervention au planning général." };
        }
        const response = await fetch(url, { credentials: "same-origin", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
        const data = response.status === 204 ? null : await response.json().catch(() => null);
        if (response.ok && /\/api\/partner-missions\/\d+\/accept$/.test(url)) {
            await synchronizeClients({ forceFull: true }).catch(() => {});
            const clientId = String(data?.mission?.clientId || "");
            if (clientId) window.dispatchEvent(new CustomEvent("depannhome:partner-client-provisioned", { detail: { clientId } }));
        }
        return { ok: response.ok, data, message: data?.message || "Serveur indisponible." };
    } catch {
        return { ok: false, message: "Serveur indisponible." };
    }
}
