import { ROUTES } from "./config.js?v=118";
import { clearSearch, getContainer, setPage } from "./ui.js?v=44";
import { escapeHtml } from "./utils.js?v=44";
import { openPartnerDialogue } from "./partner-dialogue.js?v=19";
import { getSearchableClients } from "./clients.js?v=164";
import { synchronizeClients } from "./client-sync.js?v=127";
import { loadPartnerNotifications, markPartnerNotificationsRead } from "./collaboration.js?v=6";

let dashboard = null;
let activeMissionTab = "received";
let activeMissionSpace = "network";
let preferredConnectionId = "";
let partnerMissionRenderSequence = 0;
const partnerMissionPagination = new Map();
const initialEmailSyncDate = new Date();
let emailSyncFrom = localDateValue(new Date(initialEmailSyncDate.getFullYear(), initialEmailSyncDate.getMonth(), 1));
let emailSyncTo = localDateValue(initialEmailSyncDate);

function organizationFeatureEnabled(feature) {
    try { return JSON.parse(document.body.dataset.organizationFeatures || "{}")[feature] === true; } catch { return false; }
}

window.addEventListener("depannhome:new-partner-mission", event => { preferredConnectionId = String(event.detail?.connectionId || ""); activeMissionSpace = "network"; activeMissionTab = "new"; });
window.addEventListener("depannhome:open-partner-missions", event => { activeMissionSpace = "network"; activeMissionTab = event.detail?.tab === "messages" ? "messages" : "received"; });
window.addEventListener("depannhome:show-partner-email-missions", () => { activeMissionSpace = "email"; activeMissionTab = "received"; });
window.addEventListener("depannhome:partner-email-changed", () => {
    if (document.querySelector('.nav-button.active')?.dataset.nav === ROUTES.partnerMissions) renderPartnerMissions();
});

export async function renderPartnerMissions(options = {}) {
    const renderSequence = ++partnerMissionRenderSequence;
    const externalConnectorsEnabled = organizationFeatureEnabled("connectors");
    const emailWorkspaceEnabled = document.body.dataset.canAccessCompanyEmail === "true" && organizationFeatureEnabled("companyEmail");
    const preserveEmailSpace = emailWorkspaceEnabled && activeMissionSpace === "email";
    if (!externalConnectorsEnabled) activeMissionSpace = "network";
    if (preserveEmailSpace) activeMissionSpace = "email";
    clearSearch();
    setPage("Missions partenaires", ROUTES.partnerMissions, "detail");
    const container = getContainer();
    container.innerHTML = '<section class="partner-mission-shell"><p class="muted">Chargement des missions partenaires…</p></section>';
    const shell = container.querySelector(".partner-mission-shell");
    const [result, sentResult, connectionsResult, sandboxResult, emailResult, alerts] = await Promise.all([api("/api/partner-missions"), api("/api/partner-connections/missions-sent"), canManagePartnerMissions() ? api("/api/partner-connections") : Promise.resolve({ ok: true, data: { connections: [] } }), canManagePartnerMissions() && externalConnectorsEnabled ? api("/api/partner-api-sandbox/company") : Promise.resolve({ ok: true, data: { available: false } }), emailWorkspaceEnabled ? api("/api/partner-email") : Promise.resolve({ ok: true, data: { connections: [], candidates: [], oauth: {} } }), loadPartnerNotifications()]);
    if (renderSequence !== partnerMissionRenderSequence || !shell?.isConnected || !container.contains(shell)) return;
    if (!result.ok) { shell.innerHTML = `<section class="client-panel"><p class="auth-message error">${escapeHtml(result.message || "Impossible de charger les missions.")}</p></section>`; return; }
    dashboard = { ...result.data, sentMissions: sentResult.ok ? sentResult.data?.missions || [] : [], connections: connectionsResult.ok ? connectionsResult.data?.connections || [] : [], apiSandbox: sandboxResult.ok ? sandboxResult.data : { available: false }, partnerEmail: emailResult.ok ? emailResult.data : { connections: [], candidates: [], oauth: {} } };
    const partnerEmailChannelCount = dashboard.partnerEmail.connections.length + (dashboard.partnerEmail.inboundAvailable && dashboard.partnerEmail.inboundAddress?.enabled ? 1 : 0);
    const networkMissions = dashboard.missions.filter(mission => mission.sourceType === "depannhome_network");
    const externalMissions = dashboard.missions.filter(mission => mission.sourceType === "external_connector");
    const pending = (activeMissionSpace === "network" ? networkMissions : externalMissions).filter(mission => ["received", "pending_validation"].includes(mission.status)).length;
    const networkTabs = `<button type="button" class="secondary-button" data-mission-tab="received">Missions reçues${pending ? ` (${pending})` : ""}</button><button type="button" class="secondary-button" data-mission-tab="sent">Missions envoyées</button>${canManagePartnerMissions() ? '<button type="button" class="secondary-button" data-mission-tab="new">Nouvelle mission</button>' : ""}<button type="button" class="secondary-button" data-mission-tab="messages">Messagerie</button>`;
    const externalTabs = '<button type="button" class="secondary-button" data-mission-tab="received">Missions reçues</button><button type="button" class="secondary-button" data-mission-tab="messages">Messagerie</button>';
    shell.innerHTML = `<header class="partner-mission-heading"><div><p class="eyebrow">Suivi opérationnel</p><h2>${activeMissionSpace === "network" ? "Réseau Depann’Home Pro" : "Connecteurs externes"}</h2><p class="muted">${activeMissionSpace === "network" ? "Missions, messagerie et documents entre entreprises utilisant Depann’Home Pro." : "Missions transmises directement par vos assurances, donneurs d’ordre, plateformes ou logiciels métiers via API."}</p></div><div class="partner-mission-actions"><button class="secondary-button" id="refreshPartnerMissions">Actualiser</button>${activeMissionSpace === "external" && canManagePartnerMissions() ? '<button class="secondary-button" id="retryPartnerOutbox">Relancer les retours API</button>' : ""}</div></header>${alerts.length ? `<section class="partner-mission-alerts"><h3>Notifications partenaires</h3>${alerts.slice(0, 10).map(alert => `<article class="${alert.readAt ? "read" : "unread"}"><strong>${escapeHtml(alert.title)}</strong><p>${escapeHtml(alert.body)}</p><small>${escapeHtml(formatMissionDate(alert.createdAt))}</small></article>`).join("")}</section>` : ""}<nav class="partner-network-tabs partner-mission-tabs" aria-label="Origine des missions"><button type="button" class="secondary-button${activeMissionSpace === "network" ? " active" : ""}" data-mission-space="network">Réseau Depann’Home Pro</button><button type="button" class="secondary-button${activeMissionSpace === "external" ? " active" : ""}" data-mission-space="external">Connecteurs externes</button></nav><nav class="partner-network-tabs partner-mission-tabs" aria-label="Sections des missions">${activeMissionSpace === "network" ? networkTabs : externalTabs}</nav><section class="partner-mission-counters"><article class="attention"><span>À valider</span><strong>${pending}</strong></article><article><span>${activeMissionSpace === "network" ? "Envoyées" : "Connexions API"}</span><strong>${activeMissionSpace === "network" ? dashboard.sentMissions.length : dashboard.intakes.length}</strong></article><article><span>${activeMissionSpace === "network" ? "Retours en échec" : "Missions reçues"}</span><strong>${activeMissionSpace === "network" ? dashboard.failedDeliveries : externalMissions.length}</strong></article></section><div id="partnerMissionContent"></div>`;
    if (emailWorkspaceEnabled && canManagePartnerMissions() && !partnerEmailChannelCount) {
        shell.querySelector(".partner-mission-heading")?.insertAdjacentHTML("afterend", '<section class="client-panel partner-email-reminder"><p class="eyebrow">Réception par e-mail inactive</p><h3>Aucun canal e-mail n’est configuré</h3><p class="muted">Créez votre adresse de réception Depann’Home Pro ou ajoutez une boîte dans Paramètres → Entreprise · Boîte mail.</p><div class="form-actions"><button type="button" class="secondary-button" id="openPartnerEmailSettings">Configurer la réception e-mail</button></div></section>');
    }
    if (!externalConnectorsEnabled) {
        shell.querySelector('[data-mission-space="external"]')?.remove();
        shell.querySelector("#retryPartnerOutbox")?.remove();
    }
    const spaces = shell.querySelector('[aria-label="Origine des missions"]');
    if (emailWorkspaceEnabled) spaces?.insertAdjacentHTML("beforeend", `<button type="button" class="secondary-button${activeMissionSpace === "email" ? " active" : ""}" data-mission-space="email">Boîte mail professionnelle${dashboard.partnerEmail.candidates.length ? ` (${dashboard.partnerEmail.candidates.length})` : ""}</button>`);
    if (activeMissionSpace === "email") {
        shell.querySelector(".partner-mission-heading h2").textContent = "Missions partenaires par e-mail";
        shell.querySelector(".partner-mission-heading .muted").textContent = "Même suivi, mêmes cartes et même Centre de mission, depuis une boîte connectée ou votre adresse de réception Depann’Home Pro.";
        shell.querySelectorAll('[data-mission-space]').forEach(button => button.classList.toggle("active", button.dataset.missionSpace === "email"));
        shell.querySelectorAll('.partner-mission-tabs')[1].innerHTML = externalTabs;
        if (dashboard.partnerEmail.connections.length) shell.querySelector(".partner-mission-actions")?.insertAdjacentHTML("afterbegin", `<div class="partner-email-sync-period"><label>Du<input type="date" id="partnerEmailSyncFrom" value="${escapeHtml(emailSyncFrom)}"></label><label>Au<input type="date" id="partnerEmailSyncTo" value="${escapeHtml(emailSyncTo)}"></label><button class="secondary-button" id="syncPartnerEmail">Rechercher les e-mails</button></div>`);
        const counters = [...shell.querySelectorAll(".partner-mission-counters article")];
        const emailMissions = dashboard.missions.filter(mission => mission.sourceType === "professional_email");
        if (counters[0]) { counters[0].querySelector("span").textContent = "À valider"; counters[0].querySelector("strong").textContent = dashboard.partnerEmail.candidates.length + emailMissions.filter(mission => ["received", "pending_validation"].includes(mission.status)).length; }
        if (counters[1]) { counters[1].querySelector("span").textContent = "Canaux e-mail"; counters[1].querySelector("strong").textContent = partnerEmailChannelCount; }
        if (counters[2]) { counters[2].querySelector("span").textContent = "Missions reçues"; counters[2].querySelector("strong").textContent = emailMissions.length; }
        if (!["received", "messages"].includes(activeMissionTab)) activeMissionTab = "received";
    }
    if (dashboard.apiSandbox?.available) {
        const button = document.createElement("button");
        button.type = "button"; button.className = "secondary-button sandbox-receiver-button";
        button.textContent = `🧪 API Sandbox${dashboard.apiSandbox.missions?.length ? ` (${dashboard.apiSandbox.missions.length})` : ""}`;
        button.addEventListener("click", openCompanyApiSandboxInbox);
        shell.querySelector(".partner-mission-actions")?.prepend(button);
    }
    await markPartnerNotificationsRead();
    if (renderSequence !== partnerMissionRenderSequence || !shell.isConnected || !container.contains(shell)) return;
    enablePartnerNotificationDeletion(shell, alerts);
    shell.querySelector("#refreshPartnerMissions").addEventListener("click", renderPartnerMissions);
    shell.querySelector("#openPartnerEmailSettings")?.addEventListener("click", () => window.dispatchEvent(new CustomEvent("depannhome:open-partner-email-settings")));
    shell.querySelector("#syncPartnerEmail")?.addEventListener("click", () => synchronizePartnerMailboxes(shell));
    shell.querySelector("#partnerEmailSyncFrom")?.addEventListener("change", event => { emailSyncFrom = event.currentTarget.value; });
    shell.querySelector("#partnerEmailSyncTo")?.addEventListener("change", event => { emailSyncTo = event.currentTarget.value; });
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
    const received = dashboard.missions.filter(mission => activeMissionSpace === "network" ? mission.sourceType === "depannhome_network" : activeMissionSpace === "email" ? mission.sourceType === "professional_email" : mission.sourceType === "external_connector");
    const emailCandidates = activeMissionSpace === "email" && !messages ? (dashboard.partnerEmail.candidates || []).map(emailCandidateMission) : [];
    const source = messages && activeMissionSpace === "network" ? [...received.map(mission => ({ ...mission, conversationSide: "received" })), ...dashboard.sentMissions.map(mission => ({ ...mission, conversationSide: "sent" }))] : sent ? dashboard.sentMissions : [...emailCandidates, ...received];
    const externalIntro = activeMissionSpace === "external" ? '<p class="muted">Ces missions proviennent de connecteurs API. Leur Centre de mission utilise la même interface professionnelle, le même journal et les mêmes échanges de documents que les missions du réseau. Le partenaire externe consulte et alimente ces échanges depuis son propre logiciel via API.</p>' : "";
    const statuses = activeMissionSpace === "email" ? ["email_candidate", ...dashboard.statuses] : dashboard.statuses;
    const paginationKey = `${activeMissionSpace}:${activeMissionTab}`;
    const pagination = partnerMissionPagination.get(paginationKey) || { page: 1, pageSize: 20 };
    partnerMissionPagination.set(paginationKey, pagination);
    const pageSizeControl = `<label>Afficher<select id="partnerMissionPageSize" aria-label="Nombre de missions par page">${[10, 20, 30, 100].map(size => `<option value="${size}" ${pagination.pageSize === size ? "selected" : ""}>${size} missions</option>`).join("")}</select></label>`;
    content.innerHTML = `${externalIntro}${messages ? `<p class="muted">Une conversation est disponible pour chaque mission. Ouvrez-la pour écrire directement à l’autre entreprise et consulter les informations partagées.</p><div class="partner-mission-filters partner-mission-filters-compact">${pageSizeControl}</div>` : `<div class="partner-mission-filters"><label>Statut <select id="partnerMissionStatus"><option value="">Tous les statuts</option>${statuses.map(status => `<option value="${escapeHtml(status)}">${escapeHtml(labelStatus(status))}</option>`).join("")}</select></label><label>Recherche <input id="partnerMissionSearch" type="search" placeholder="Client, référence, adresse"></label>${pageSizeControl}</div>`}<section class="partner-mission-list" id="partnerMissionList"></section><nav class="partner-mission-pagination" id="partnerMissionPagination" aria-label="Pages des missions"></nav>`;
    const renderList = () => {
        const status = content.querySelector("#partnerMissionStatus")?.value || "";
        const query = content.querySelector("#partnerMissionSearch")?.value.trim().toLowerCase() || "";
        const missions = source.filter(mission => {
            const matchesSearch = `${mission.missionNumber} ${mission.externalMissionId} ${mission.partnerReference} ${mission.partnerName} ${mission.mappedData?.clientName} ${mission.mappedData?.address}`.toLowerCase().includes(query);
            return (!status || mission.status === status) && (!query || matchesSearch);
        });
        const totalPages = Math.max(1, Math.ceil(missions.length / pagination.pageSize));
        pagination.page = Math.min(Math.max(1, pagination.page), totalPages);
        const start = (pagination.page - 1) * pagination.pageSize;
        renderMissions(content.querySelector("#partnerMissionList"), missions.slice(start, start + pagination.pageSize), { sent, messages });
        renderMissionPagination(content.querySelector("#partnerMissionPagination"), { ...pagination, total: missions.length, totalPages, start }, nextPage => {
            pagination.page = nextPage;
            renderList();
            content.querySelector("#partnerMissionList")?.scrollIntoView({ behavior: "smooth", block: "start" });
        });
    };
    content.querySelector("#partnerMissionStatus")?.addEventListener("change", () => { pagination.page = 1; renderList(); });
    content.querySelector("#partnerMissionSearch")?.addEventListener("input", () => { pagination.page = 1; renderList(); });
    content.querySelector("#partnerMissionPageSize")?.addEventListener("change", event => {
        pagination.pageSize = [10, 20, 30, 100].includes(Number(event.currentTarget.value)) ? Number(event.currentTarget.value) : 20;
        pagination.page = 1;
        renderList();
    });
    renderList();
}

function renderMissionPagination(node, pagination, goToPage) {
    const first = pagination.total ? pagination.start + 1 : 0;
    const last = Math.min(pagination.start + pagination.pageSize, pagination.total);
    const pageNumbers = missionPaginationPages(pagination.page, pagination.totalPages);
    node.innerHTML = `<span>${first}–${last} sur ${pagination.total} mission${pagination.total > 1 ? "s" : ""}</span><div><button type="button" class="secondary-button" data-mission-page="${pagination.page - 1}" ${pagination.page <= 1 ? "disabled" : ""}>Précédente</button>${pageNumbers.map(page => page === "…" ? '<span class="partner-mission-page-gap" aria-hidden="true">…</span>' : `<button type="button" class="secondary-button${page === pagination.page ? " active" : ""}" data-mission-page="${page}" ${page === pagination.page ? 'aria-current="page"' : ""}>${page}</button>`).join("")}<button type="button" class="secondary-button" data-mission-page="${pagination.page + 1}" ${pagination.page >= pagination.totalPages ? "disabled" : ""}>Suivante</button></div>`;
    node.querySelectorAll("[data-mission-page]:not([disabled])").forEach(button => button.addEventListener("click", () => goToPage(Number(button.dataset.missionPage))));
}

function missionPaginationPages(current, total) {
    if (total <= 7) return Array.from({ length: total }, (_value, index) => index + 1);
    const pages = [...new Set([1, 2, current - 1, current, current + 1, total - 1, total].filter(page => page >= 1 && page <= total))].sort((first, second) => first - second);
    return pages.flatMap((page, index) => index && page - pages[index - 1] > 1 ? ["…", page] : [page]);
}

function renderMissions(node, missions, options = {}) { node.innerHTML = missions.length ? missions.map(mission => `<article class="partner-mission-card priority-${escapeHtml(mission.priority)}"><div class="partner-mission-card-title"><div><p class="eyebrow">${escapeHtml(mission.partnerName || "Partenaire")} · ${escapeHtml(mission.missionNumber || "Mission partenaire")}</p><h3>${escapeHtml(mission.mappedData?.clientName || "Client non renseigné")}</h3><p>${escapeHtml(mission.mappedData?.address || "Adresse non renseignée")}</p></div><span class="partner-mission-status ${escapeHtml(mission.status)}">${escapeHtml(labelStatus(mission.status))}</span></div><div class="partner-mission-meta"><span>${escapeHtml(mission.mappedData?.interventionType || "Intervention")}</span><span>${mission.scheduledDate ? escapeHtml(mission.scheduledDate) : "À planifier"}</span><span class="priority">${escapeHtml(labelPriority(mission.priority))}</span></div><p>${escapeHtml(mission.mappedData?.description || mission.mappedData?.comments || "Aucun descriptif transmis.")}</p><div class="partner-mission-card-actions">${options.sent || mission.conversationSide === "sent" ? `<span class="muted">Envoyée le ${escapeHtml(formatMissionDate(mission.sentAt))}</span><button class="secondary-button" data-open-sent-dialogue="${mission.id}">Ouvrir la conversation</button>${["received", "pending_validation"].includes(mission.status) ? `<button class="danger-button" data-delete-sent="${mission.id}">Supprimer</button>` : !["closed", "cancelled", "rejected"].includes(mission.status) ? `<button class="danger-button" data-cancel-sent="${mission.id}">Clôturer / Annuler</button>` : ""}` : `<span class="muted">Reçue le ${escapeHtml(formatMissionDate(mission.createdAt))}</span><button class="secondary-button" data-open="${mission.id}">Détail</button><button class="secondary-button" data-open-dialogue="${mission.id}">Ouvrir la conversation</button>${canManagePartnerMissions() && ["received", "pending_validation"].includes(mission.status) ? `<button class="secondary-button" data-accept="${mission.id}">Accepter et planifier</button><button class="danger-button" data-reject="${mission.id}">Refuser</button>` : canManagePartnerMissions() && !["closed", "cancelled", "rejected"].includes(mission.status) ? `<button class="secondary-button" data-close="${mission.id}">Clôturer la mission</button>` : ""}`}</div></article>`).join("") : '<p class="muted">Aucune mission ne correspond à ce filtre.</p>';
    node.querySelectorAll("[data-delete-sent]").forEach(button => {
        button.dataset.cancelSent = button.dataset.deleteSent;
        delete button.dataset.deleteSent;
        button.textContent = "Annuler";
    });
    missions.forEach((mission, index) => {
        if (!mission.emailCandidate) return;
        const card = node.children[index];
        if (!card) return;
        card.dataset.emailCandidateCard = String(mission.emailCandidate.id);
        card.querySelector(".partner-mission-status")?.classList.replace("email_candidate", "pending_validation");
        const meta = card.querySelector(".partner-mission-meta");
        if (meta) meta.innerHTML = `<span>${mission.emailCandidate.attachments?.length || 0} pièce(s)</span><span>Fiabilité ${escapeHtml(mission.emailCandidate.classificationScore)}/100</span><span>Import à confirmer</span>`;
        const reasons = Array.isArray(mission.emailCandidate.classificationReasons) ? mission.emailCandidate.classificationReasons : [];
        if (reasons.length) card.querySelector(".partner-mission-card-actions")?.insertAdjacentHTML("beforebegin", `<p class="muted">${reasons.map(reason => escapeHtml(reason)).join(" · ")}</p>`);
        const actions = card.querySelector(".partner-mission-card-actions");
        if (actions) actions.innerHTML = `<label class="partner-mission-choice"><input type="checkbox" data-email-candidate="${mission.emailCandidate.id}"> Sélectionner</label><span class="muted">Reçue le ${escapeHtml(formatMissionDate(mission.createdAt))}</span><button type="button" class="secondary-button" data-email-confirm-one="${mission.emailCandidate.id}">Confirmer</button><button type="button" class="danger-button" data-email-delete-one="${mission.emailCandidate.id}">Supprimer</button>`;
    });
    if (!options.sent) missions.forEach((mission, index) => {
        if (mission.sourceType !== "professional_email") return;
        node.children[index]?.querySelector(".partner-mission-card-actions")?.insertAdjacentHTML("beforeend", `<button class="secondary-button" data-email-reply="${mission.id}">Répondre à l’e-mail</button>`);
    });
    node.querySelectorAll("[data-email-reply]").forEach(button => button.addEventListener("click", () => openEmailReply(button.dataset.emailReply)));
    enableClosedMissionCorrection(node, missions, options);
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
        if (mission) openPartnerMissionPlanning(mission);
    }));
    node.querySelectorAll("[data-reject]").forEach(button => button.addEventListener("click", async () => { const reason = prompt("Motif du refus à transmettre au partenaire :"); if (reason === null) return; const result = await api(`/api/partner-missions/${button.dataset.reject}/reject`, { method: "POST", body: JSON.stringify({ reason }) }); if (!result.ok) return alert(result.message); renderPartnerMissions(); }));
    node.querySelectorAll("[data-cancel-sent]").forEach(button => button.addEventListener("click", async () => { if (!confirm("Annuler cette mission acceptée ? L’historique sera conservé chez les deux entreprises.")) return; const reason = prompt("Motif de l’annulation (facultatif) :"); if (reason === null) return; const result = await api(`/api/partner-connections/missions/${button.dataset.cancelSent}/cancel`, { method: "POST", body: JSON.stringify({ reason }) }); if (!result.ok) return alert(result.message); renderPartnerMissions(); }));
    node.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", async () => { if (!confirm("Clôturer cette mission ? Le journal sera conservé et la conversation deviendra en lecture seule.")) return; const result = await api(`/api/partner-missions/${button.dataset.close}/close`, { method: "POST" }); if (!result.ok) return alert(result.message); renderPartnerMissions(); }));
    if (node.querySelector("[data-email-candidate]")) {
        const toolbar = document.createElement("div");
        toolbar.className = "form-actions partner-mission-selection";
        toolbar.innerHTML = '<label><input type="checkbox" data-email-select-all> Tout sélectionner</label><button class="secondary-button" data-email-import disabled>Confirmer la sélection</button><button class="danger-button" data-email-ignore disabled>Supprimer la sélection</button><small>Supprimer retire uniquement la proposition : l’e-mail reste dans la boîte connectée.</small>';
        node.prepend(toolbar);
        enableEmailCandidateSelection(node);
    }
}

function emailCandidateMission(message) {
    const score = Number(message.classificationScore) || 0;
    return {
        id: `email-candidate-${message.id}`,
        emailCandidate: message,
        sourceType: "professional_email_candidate",
        status: "email_candidate",
        priority: /urgent|urgence|prioritaire/i.test(`${message.subject || ""} ${message.bodyText || ""}`) ? "urgent" : "normal",
        partnerName: message.senderName || message.senderAddress || "Partenaire e-mail",
        missionNumber: "E-mail à confirmer",
        createdAt: message.receivedAt,
        mappedData: {
            clientName: message.subject || "Mission reçue par e-mail",
            address: message.senderAddress || "Expéditeur non renseigné",
            interventionType: score >= 80 ? "Mission détectée avec forte fiabilité" : "Mission à contrôler",
            description: String(message.bodyText || "Aucun descriptif transmis.").slice(0, 600)
        }
    };
}

async function synchronizePartnerMailboxes(shell) {
    const button = shell.querySelector("#syncPartnerEmail");
    const from = shell.querySelector("#partnerEmailSyncFrom")?.value || "";
    const to = shell.querySelector("#partnerEmailSyncTo")?.value || "";
    const periodError = validateEmailSyncPeriod(from, to);
    if (periodError) return alert(periodError);
    emailSyncFrom = from; emailSyncTo = to;
    if (button) button.disabled = true;
    let fetched = 0, candidates = 0, imported = 0, limited = false;
    for (const connection of dashboard.partnerEmail.connections || []) {
        const result = await api(`/api/partner-email/${connection.id}/sync`, { method: "POST", body: JSON.stringify({ from, to }) });
        if (!result.ok) { if (button) button.disabled = false; return alert(result.message); }
        fetched += Number(result.data?.fetched) || 0;
        candidates += Number(result.data?.candidates) || 0;
        imported += Number(result.data?.imported) || 0;
        limited ||= result.data?.limited === true;
    }
    alert(`${fetched} e-mail(s) lu(s) du ${formatShortDate(from)} au ${formatShortDate(to)}, ${candidates} mission(s) à confirmer, ${imported} mission(s) importée(s).${limited ? " Plus de 500 e-mails ont été trouvés dans une boîte : réduisez la période pour consulter les autres." : ""}`);
    await renderPartnerMissions();
}

function validateEmailSyncPeriod(from, to) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return "Sélectionnez une date de début et une date de fin.";
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;
    if (days < 0) return "La date de fin doit être postérieure ou égale à la date de début.";
    if (days > 30) return "Sélectionnez une période maximale de 31 jours.";
    return "";
}

function localDateValue(value) { const offset = value.getTimezoneOffset() * 60000; return new Date(value.getTime() - offset).toISOString().slice(0, 10); }
function formatShortDate(value) { return new Intl.DateTimeFormat("fr-FR").format(new Date(`${value}T12:00:00`)); }

function enableClosedMissionCorrection(node, missions, options) {
    if (!isPartnerMissionAdministrator() || options.sent || options.messages) return;
    missions.forEach((mission, index) => {
        if (!["rejected", "cancelled", "closed"].includes(mission.status)) return;
        const actions = node.children[index]?.querySelector(".partner-mission-card-actions");
        if (!actions) return;
        actions.insertAdjacentHTML("beforeend", `<button class="secondary-button" data-reactivate="${mission.id}">Réactiver et corriger</button>`);
    });
    node.querySelectorAll("[data-reactivate]").forEach(button => button.addEventListener("click", async () => {
        if (!confirm("Réactiver cette mission pour la corriger ? Le partenaire sera informé et l’opération restera inscrite dans le journal.")) return;
        const reason = prompt("Motif obligatoire de la réactivation :");
        if (reason === null) return;
        if (!reason.trim()) return alert("Indiquez le motif de la réactivation.");
        const existing = missions.find(mission => String(mission.id) === button.dataset.reactivate);
        const result = await api(`/api/partner-missions/${button.dataset.reactivate}/reactivate`, { method: "POST", body: JSON.stringify({ reason }) });
        if (!result.ok) return alert(result.message);
        await openPartnerMissionPlanning({ ...existing, ...result.data.mission, partnerName: existing?.partnerName, mappedData: result.data.mission?.mappedData || existing?.mappedData || {} });
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

function openEmailReply(missionId) {
    const dialog = openDialog(`<form class="client-form partner-email-reply-dialog" data-email-reply-form><header><span class="partner-email-reply-icon" aria-hidden="true">↩</span><div><p class="eyebrow">Mission e-mail</p><h3>Répondre dans le fil d’origine</h3></div></header><p class="partner-email-reply-notice">La réponse partira de votre boîte professionnelle connectée et restera associée à cette mission.</p><label class="partner-email-reply-message">Message<textarea name="body" rows="7" maxlength="4000" required placeholder="Bonjour,&#10;&#10;Rédigez votre réponse au partenaire…"></textarea><small data-email-reply-count>0 / 4 000 caractères</small></label><label class="partner-email-reply-files"><strong>Documents à joindre</strong><span>PDF, images ou documents bureautiques · 5 fichiers maximum · 5 Mo par fichier</span><input name="files" type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx,.xls,.xlsx,.txt"><output data-email-reply-files>Aucun document sélectionné.</output></label><div class="form-actions partner-email-reply-actions"><button type="submit" class="primary-button">Envoyer par e-mail</button></div><p class="auth-message" aria-live="polite"></p></form>`);
    const form = dialog.querySelector("[data-email-reply-form]");
    form.elements.body.addEventListener("input", () => { form.querySelector("[data-email-reply-count]").textContent = `${form.elements.body.value.length.toLocaleString("fr-FR")} / 4 000 caractères`; });
    form.elements.files.addEventListener("change", () => { const files = [...form.elements.files.files]; form.querySelector("[data-email-reply-files]").textContent = files.length ? `${files.length} document${files.length > 1 ? "s" : ""} : ${files.map(file => file.name).join(", ")}` : "Aucun document sélectionné."; });
    form.addEventListener("submit", async event => {
        event.preventDefault(); const form = event.currentTarget; const button = event.submitter; const files = [...form.elements.files.files];
        if (files.length > 5 || files.some(file => file.size > 5 * 1024 * 1024)) return showWizardMessage(dialog, "Maximum : 5 documents de 5 Mo chacun.");
        button.disabled = true; const originalLabel = button.textContent; button.textContent = "Envoi en cours…";
        let attachments;
        try { attachments = await Promise.all(files.map(file => fileToEmailAttachment(file))); }
        catch (error) { button.disabled = false; button.textContent = originalLabel; return showWizardMessage(dialog, error.message); }
        const result = await api(`/api/partner-email/missions/${missionId}/reply`, { method: "POST", body: JSON.stringify({ body: form.elements.body.value, attachments }) });
        if (!result.ok) { button.disabled = false; button.textContent = originalLabel; return showWizardMessage(dialog, result.message); }
        dialog.remove(); alert(result.data.message);
    });
}

function fileToEmailAttachment(file) {
    return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve({ name: file.name, dataUrl: reader.result }); reader.onerror = () => reject(new Error("Lecture du document impossible.")); reader.readAsDataURL(file); });
}

function enableEmailCandidateSelection(node) {
    const inputs = [...node.querySelectorAll("[data-email-candidate]")], selectAll = node.querySelector("[data-email-select-all]"), importButton = node.querySelector("[data-email-import]"), ignoreButton = node.querySelector("[data-email-ignore]");
    if (!inputs.length) return;
    const ids = () => inputs.filter(input => input.checked).map(input => Number(input.dataset.emailCandidate));
    const refresh = () => { const count = ids().length; importButton.disabled = !count; ignoreButton.disabled = !count; importButton.textContent = count ? `Confirmer la sélection (${count})` : "Confirmer la sélection"; ignoreButton.textContent = count ? `Supprimer la sélection (${count})` : "Supprimer la sélection"; selectAll.checked = count === inputs.length; selectAll.indeterminate = count > 0 && count < inputs.length; };
    const confirmCandidates = async selectedIds => { if (!selectedIds.length || !confirm(`Confirmer ${selectedIds.length} proposition${selectedIds.length > 1 ? "s" : ""} et créer ${selectedIds.length} mission${selectedIds.length > 1 ? "s" : ""} à valider ?`)) return; const result = await api("/api/partner-email/candidates/import", { method: "POST", body: JSON.stringify({ ids: selectedIds }) }); if (!result.ok) return alert(result.message); await synchronizeClients({ forceFull: true }).catch(() => {}); activeMissionTab = "received"; renderPartnerMissions(); };
    const deleteCandidates = async selectedIds => { if (!selectedIds.length || !confirm(`Supprimer ${selectedIds.length} proposition${selectedIds.length > 1 ? "s" : ""} ? Les e-mails resteront dans la boîte connectée et aucune mission ne sera créée.`)) return; const result = await api("/api/partner-email/candidates/ignore", { method: "POST", body: JSON.stringify({ ids: selectedIds }) }); if (!result.ok) return alert(result.message); renderPartnerMissions(); };
    inputs.forEach(input => input.addEventListener("change", refresh)); selectAll.addEventListener("change", () => { inputs.forEach(input => { input.checked = selectAll.checked; }); refresh(); });
    importButton.addEventListener("click", () => confirmCandidates(ids()));
    ignoreButton.addEventListener("click", () => deleteCandidates(ids()));
    node.querySelectorAll("[data-email-confirm-one]").forEach(button => button.addEventListener("click", () => confirmCandidates([Number(button.dataset.emailConfirmOne)])));
    node.querySelectorAll("[data-email-delete-one]").forEach(button => button.addEventListener("click", () => deleteCandidates([Number(button.dataset.emailDeleteOne)])));
    refresh();
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

async function showDetail(id) {
    const renderSequence = partnerMissionRenderSequence;
    const shell = document.querySelector(".partner-mission-shell");
    const content = shell?.querySelector("#partnerMissionContent");
    if (!content) return;
    content.innerHTML = '<section class="partner-mission-full-detail"><p class="muted">Chargement de la mission complète…</p></section>';
    const result = await api(`/api/partner-missions/${encodeURIComponent(id)}`);
    if (renderSequence !== partnerMissionRenderSequence || !content.isConnected) return;
    if (!result.ok) { content.innerHTML = `<section class="client-panel"><p class="auth-message error">${escapeHtml(result.message || "Impossible de charger la mission.")}</p><button type="button" class="secondary-button" data-back-to-missions>Retour aux missions</button></section>`; content.querySelector("[data-back-to-missions]").addEventListener("click", () => renderMissionTab(shell)); return; }
    const { mission, history = [], emailAttachments = [] } = result.data;
    const details = Object.entries(mission.mappedData || {}).filter(([key, value]) => value && !["attachments", "errors"].includes(key)).map(([key, value]) => `<dt>${escapeHtml(labelField(key))}</dt><dd>${escapeHtml(typeof value === "object" ? JSON.stringify(value) : value)}</dd>`).join("");
    const emailDocuments = emailAttachments.length ? `<section class="procedure-section"><div class="form-heading"><div><p class="eyebrow">Documents d’origine</p><h3>Pièces jointes reçues par e-mail</h3></div><span class="file-count-badge">${emailAttachments.length} fichier(s)</span></div><div class="attachment-list">${emailAttachments.map(attachment => `<article class="attachment-card"><div><p class="eyebrow">${escapeHtml(attachment.mimeType || "Document")}</p><h4>${escapeHtml(attachment.name || "Pièce jointe")}</h4><p class="muted">${escapeHtml(formatAttachmentSize(attachment.fileSize))} · ${escapeHtml(formatMissionDate(attachment.createdAt))}</p></div><div class="attachment-actions"><a class="secondary-button" href="${escapeHtml(attachment.url)}" target="_blank" rel="noopener">Visualiser</a><a class="secondary-button" href="${escapeHtml(attachment.url)}" download="${escapeHtml(attachment.name || "document")}">Télécharger</a></div></article>`).join("")}</div></section>` : "";
    content.innerHTML = `<article class="partner-mission-full-detail"><header><button type="button" class="secondary-button" data-back-to-missions>← Retour aux missions</button><div><p class="eyebrow">Mission partenaire intégrale</p><h2>Mission ${escapeHtml(mission.missionNumber || "partenaire")}</h2><p class="muted">Reçue le ${escapeHtml(formatMissionDate(mission.createdAt))} · ${escapeHtml(mission.partnerName || "Partenaire")} · ${escapeHtml(labelStatus(mission.status))}</p></div><button type="button" class="secondary-button" data-open-mission-dialogue>Ouvrir le dialogue</button></header><section class="procedure-section"><h3>Informations de la mission</h3><dl class="partner-mission-details">${details || "<dt>Informations</dt><dd>Aucune donnée complémentaire transmise.</dd>"}</dl></section>${emailDocuments}<section class="procedure-section"><h3>Journal complet de la mission</h3><ol class="partner-mission-history">${history.length ? history.map(item => `<li><strong>${escapeHtml(labelStatus(item.status))}</strong> · ${escapeHtml(item.action)}<br><small>${escapeHtml(item.actorName)} · ${escapeHtml(formatMissionDate(item.createdAt))}</small></li>`).join("") : "<li>Aucun événement enregistré.</li>"}</ol></section></article>`;
    content.querySelector("[data-back-to-missions]").addEventListener("click", () => renderMissionTab(shell));
    content.querySelector("[data-open-mission-dialogue]").addEventListener("click", () => openPartnerDialogue(mission.id));
    content.scrollIntoView({ behavior: "smooth", block: "start" });
}
async function openPartnerMissionPlanning(mission) {
    const { renderCalendar } = await import("./calendar.js?v=201");
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
        await openPartnerDialogue(mission.id);
        return accepted;
    };
    await renderCalendar({
        date: new Date(`${date}T12:00:00`),
        view: "day",
        visibleTechnicianIds: assignedTechnicianIds,
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
function showAccept(id) { const mission = dashboard.missions.find(item => Number(item.id) === Number(id)); if (!mission) return; const options = dashboard.technicians.map(technician => `<option value="${technician.id}">${escapeHtml(technician.fullName)}</option>`).join(""); const dialog = openDialog(`<form id="acceptPartnerMission"><h3>Accepter et planifier</h3><p>${escapeHtml(mission.mappedData.clientName || "Client")}</p><div class="form-grid"><label>Date <input name="date" type="date" value="${escapeHtml(htmlDateValue(mission.scheduledDate || mission.mappedData.date))}"></label><label>Début <input name="startTime" type="time" value="${escapeHtml(mission.scheduledStartTime || mission.mappedData.startTime || "")}"></label><label>Fin <input name="endTime" type="time" value="${escapeHtml(mission.scheduledEndTime || mission.mappedData.endTime || "")}"></label><label>Technicien <select name="technicianId"><option value="">Affectation ultérieure</option>${options}</select></label><label>Mode <select name="assignmentMode"><option value="manual">Manuel</option><option value="automatic">Automatique selon la charge</option></select></label><label class="form-wide">Type de facturation<select name="billingMode"><option value="direct_client" ${mission.billingMode !== "principal" ? "selected" : ""}>Facturation directe au client final — devis, factures et comptabilité restent privés</option><option value="principal" ${mission.billingMode === "principal" ? "selected" : ""}>Facturation destinée à l’entreprise donneuse d’ordre — devis et factures partagés</option></select></label></div><p class="muted">Les documents restent internes par défaut. En mode donneur d’ordre, les devis et factures liés à cette mission sont partagés automatiquement.</p><div class="form-actions"><button class="secondary-button">Confirmer</button></div></form>`); dialog.querySelector("form").addEventListener("submit", async event => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); const mode = await api(`/api/partner-missions/${id}/billing-mode`, { method: "PATCH", body: JSON.stringify({ billingMode: values.billingMode }) }); if (!mode.ok) return alert(mode.message); const result = await api(`/api/partner-missions/${id}/accept`, { method: "POST", body: JSON.stringify(values) }); if (!result.ok) return alert(result.message); dialog.remove(); await renderPartnerMissions(); await openPartnerDialogue(id); }); }
function openDialog(content) { const dialog = document.createElement("div"); dialog.className = "partner-mission-dialog"; dialog.innerHTML = `<section><button class="text-button partner-dialog-close" aria-label="Fermer">Fermer</button>${content}</section>`; dialog.querySelector(".partner-dialog-close").addEventListener("click", () => dialog.remove()); document.body.appendChild(dialog); return dialog; }
function labelStatus(value) { return ({ email_candidate: "À confirmer", received: "Reçue", pending_validation: "À valider", accepted: "Acceptée", rejected: "Refusée", assigned: "Affectée", scheduled: "Planifiée", en_route: "En route", on_site: "Sur site", report_in_progress: "Rapport en cours", report_completed: "Rapport terminé", report_validated: "Rapport validé", quote_sent: "Devis envoyé", quote_accepted: "Devis accepté", work_completed: "Travaux terminés", invoice_sent: "Facture envoyée", closed: "Clôturée", cancelled: "Annulée" })[value] || "Statut non renseigné"; }
function labelPriority(value) { return ({ low: "Faible", normal: "Normale", high: "Haute", urgent: "Urgente" })[value] || value; }
function labelField(value) { return ({ clientName: "Client", address: "Adresse", postalCode: "Code postal", city: "Ville", interventionType: "Intervention", partnerReference: "N° dossier", claimNumber: "Sinistre", insuredNumber: "N° assuré / sociétaire", phone: "Téléphone", email: "E-mail", description: "Description", comments: "Commentaires", insurance: "Assureur", expert: "Expert", manager: "Gestionnaire", date: "Date", startTime: "Début", endTime: "Fin", gps: "GPS" })[value] || value; }
function formatDate(value) { return value ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : ""; }
function formatMissionDate(value) { return value ? new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)).replace(/:/g, " h ") : "Date inconnue"; }
function htmlDateValue(value) { const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || "")); return match ? match[1] : ""; }
function canManagePartnerMissions() { return ["admin", "pc_standard", "mobile_admin"].includes(document.body.dataset.role); }
function isPartnerMissionAdministrator() { return document.body.dataset.role === "admin"; }
async function api(url, options = {}) {
    try {
        if (/\/api\/partner-missions\/\d+\/accept$/.test(url)) {
            const payload = typeof options.body === "string" ? JSON.parse(options.body) : options.body || {};
            if (!htmlDateValue(payload.date)) return { ok: false, message: "Choisissez une date pour ajouter cette intervention au planning général." };
        }
        const requestOptions = { credentials: "same-origin", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options };
        const retryable = String(options.method || "GET").toUpperCase() === "GET";
        let response;
        try {
            response = await fetch(url, requestOptions);
        } catch (error) {
            if (!retryable) throw error;
            console.warn(`[partner-missions] Lecture interrompue, nouvelle tentative : ${url}`);
            response = await fetch(url, { ...requestOptions, cache: "no-store" });
        }
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
