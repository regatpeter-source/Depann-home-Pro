import { ROUTES } from "./config.js?v=105";
import { clearSearch, getContainer, setPage } from "./ui.js?v=44";
import { escapeHtml } from "./utils.js?v=44";
import { renderCreatorConnectors } from "./connectors.js?v=1";

let accounts = [];
let selectedAccountId = "";
let accountListMode = "active";
let creatorNotificationsBound = false;

export async function renderCreatorConsole() {
    clearSearch();
    setPage("Console Créateur", ROUTES.creator, "detail");
    const container = getContainer();
    container.innerHTML = `
        <section class="creator-console">
            <header class="creator-heading">
                <div><p class="eyebrow">Administration plateforme</p><h2>Console Créateur</h2></div>
                <div class="creator-form-actions"><button type="button" class="secondary-button auth-outline-button" id="creatorSubscriptionRequests">Demandes d’offres</button><button type="button" class="secondary-button auth-outline-button" id="creatorPartnerApiSandbox">🧪 Sandbox API partenaire</button><button type="button" class="secondary-button auth-outline-button" id="creatorPlatformAnnouncement">Affichage général</button><button type="button" class="secondary-button auth-outline-button" id="creatorPartnerRequests">Demandes de partenariat</button><button type="button" class="secondary-button auth-outline-button" id="creatorOfficialPartners">Partenaires officiels</button><button type="button" class="secondary-button auth-outline-button" id="creatorSecurity">Sécurité du compte</button><button type="button" class="secondary-button auth-outline-button" id="creatorSubscriptionInvoices">Factures abonnements</button><button type="button" class="secondary-button auth-outline-button" id="creatorBillingProfile">Facturation plateforme</button><button type="button" class="secondary-button auth-outline-button" id="creatorExternalProviders">Prestataires externes</button><button type="button" class="secondary-button" id="creatorNewAccount">+ Nouvelle organisation</button></div>
            </header>
            <p id="creatorFeedback" class="auth-message" aria-live="polite"></p>
            <section class="creator-subscription-summary" id="creatorSubscriptionSummary" aria-label="Synthèse des abonnements"></section>
            <div class="creator-layout">
                <aside class="creator-accounts" id="creatorAccounts"><p class="muted">Chargement des organisations…</p></aside>
                <section class="creator-workspace" id="creatorWorkspace"><p class="muted">Sélectionnez une organisation ou créez-en une.</p></section>
            </div>
        </section>
    `;
    const networkButton = document.createElement("button");
    networkButton.type = "button";
    networkButton.className = "secondary-button auth-outline-button";
    networkButton.textContent = "Réseau Depann'Home Pro";
    document.querySelector(".creator-heading .creator-form-actions").prepend(networkButton);
    const notificationsButton = document.createElement("button");
    notificationsButton.type = "button";
    notificationsButton.id = "creatorRequestNotifications";
    notificationsButton.className = "secondary-button auth-outline-button";
    notificationsButton.innerHTML = 'Notifications <b class="creator-request-alert" hidden>0</b>';
    document.querySelector(".creator-heading .creator-form-actions").prepend(notificationsButton);
    container.querySelector("#creatorNewAccount").addEventListener("click", () => renderAccountForm());
    container.querySelector("#creatorSubscriptionRequests").addEventListener("click", renderSubscriptionChangeRequests);
    container.querySelector("#creatorPartnerApiSandbox").addEventListener("click", renderPartnerApiSandbox);
    networkButton.addEventListener("click", renderNetworkDirectory);
    notificationsButton.addEventListener("click", renderCreatorRequestNotifications);
    container.querySelector("#creatorPlatformAnnouncement").addEventListener("click", renderPlatformAnnouncementSettings);
    container.querySelector("#creatorPartnerRequests").addEventListener("click", renderPartnerRequests);
    container.querySelector("#creatorOfficialPartners").addEventListener("click", renderOfficialPartners);
    container.querySelector("#creatorBillingProfile").addEventListener("click", renderSubscriptionBillingProfile);
    container.querySelector("#creatorSecurity").addEventListener("click", renderCreatorSecurity);
    container.querySelector("#creatorSubscriptionInvoices").addEventListener("click", renderSubscriptionInvoices);
    container.querySelector("#creatorExternalProviders").addEventListener("click", renderCreatorConnectors);
    await Promise.all([loadAccounts(), refreshCreatorRequestNotifications()]);
    if (!creatorNotificationsBound) {
        creatorNotificationsBound = true;
        window.addEventListener("depannhome:collaboration-event", () => {
            if (document.querySelector("#creatorRequestNotifications")) refreshCreatorRequestNotifications();
        });
    }
}

export async function openCreatorRequestNotification(source = "") {
    await renderCreatorConsole();
    if (source === "subscription") return renderSubscriptionChangeRequests();
    if (source === "support") return renderCreatorSupportRequests();
    return renderCreatorRequestNotifications();
}

async function refreshCreatorRequestNotifications() {
    const button = document.querySelector("#creatorRequestNotifications");
    if (!button) return;
    const result = await api("/api/creator/request-notifications");
    if (!result.ok) return;
    const total = Number(result.data.total) || 0;
    const badge = button.querySelector(".creator-request-alert");
    badge.hidden = total === 0;
    badge.textContent = total > 99 ? "99+" : String(total);
    button.classList.toggle("has-notifications", total > 0);
    button.title = `${total} demande${total > 1 ? "s" : ""} à traiter`;
}

async function renderCreatorRequestNotifications() {
    const workspace = document.querySelector("#creatorWorkspace");
    workspace.innerHTML = '<p class="muted">Chargement des notifications…</p>';
    const result = await api("/api/creator/request-notifications");
    if (!result.ok) return showFeedback(result.message || "Impossible de charger les notifications.", true);
    const { items = [], counts = {} } = result.data;
    workspace.innerHTML = `<section class="creator-form creator-request-notifications"><div class="form-heading"><div><p class="eyebrow">Demandes internes et externes</p><h3>Notifications</h3></div><span class="creator-state">${items.length} à traiter</span></div><div class="creator-network-stats"><article><span>Offres / postes</span><strong>${Number(counts.subscriptions) || 0}</strong></article><article><span>Support interne</span><strong>${Number(counts.support) || 0}</strong></article><article><span>Partenariats externes</span><strong>${Number(counts.partners) || 0}</strong></article></div><div class="creator-network-list">${items.length ? items.map(item => `<article class="creator-network-company"><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.senderName || "Demandeur")}</p><small>${escapeHtml(formatDateTime(item.createdAt))} · ${escapeHtml(subscriptionChangeStatusLabel(item.status))}</small></div><button type="button" class="secondary-button" data-open-request-source="${escapeHtml(item.source)}">Traiter</button></article>`).join("") : '<p class="muted">Aucune nouvelle demande.</p>'}</div></section>`;
    workspace.querySelectorAll("[data-open-request-source]").forEach(button => button.addEventListener("click", () => {
        if (button.dataset.openRequestSource === "subscription") return renderSubscriptionChangeRequests();
        if (button.dataset.openRequestSource === "support") return renderCreatorSupportRequests();
        return renderPartnerRequests();
    }));
}

async function renderCreatorSupportRequests() {
    const workspace = document.querySelector("#creatorWorkspace");
    workspace.innerHTML = '<p class="muted">Chargement des demandes Support…</p>';
    const result = await api("/api/creator/support-requests");
    if (!result.ok) return showFeedback(result.message || "Impossible de charger les demandes Support.", true);
    const requests = result.data.requests || [];
    workspace.innerHTML = `<section class="creator-form"><div class="form-heading"><div><p class="eyebrow">Entreprises internes</p><h3>Demandes Support</h3></div><span class="creator-state">${requests.length} demande${requests.length > 1 ? "s" : ""}</span></div><div class="creator-network-list">${requests.length ? requests.map(item => `<form class="creator-network-company" data-support-request="${escapeHtml(item.id)}"><div><strong>${escapeHtml(item.companyName || item.senderName || item.senderUsername)}</strong><p>${escapeHtml(item.message)}</p><small>${escapeHtml(formatDateTime(item.createdAt))}${item.senderEmail ? ` · ${escapeHtml(item.senderEmail)}` : ""}</small></div><div class="creator-form-actions"><select name="status">${["new", "under_review", "answered", "closed"].map(status => `<option value="${status}" ${item.status === status ? "selected" : ""}>${supportRequestStatusLabel(status)}</option>`).join("")}</select><input name="creatorNote" maxlength="2000" value="${escapeHtml(item.creatorNote || "")}" placeholder="Note interne"><button class="secondary-button">Enregistrer</button></div></form>`).join("") : '<p class="muted">Aucune demande Support.</p>'}</div></section>`;
    workspace.querySelectorAll("[data-support-request]").forEach(form => form.addEventListener("submit", async event => {
        event.preventDefault();
        const update = await api(`/api/creator/support-requests/${encodeURIComponent(form.dataset.supportRequest)}`, { method: "PATCH", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
        if (!update.ok) return showFeedback(update.message || "Mise à jour impossible.", true);
        showFeedback("Suivi Support enregistré.");
        await refreshCreatorRequestNotifications();
        renderCreatorSupportRequests();
    }));
}

function supportRequestStatusLabel(status) { return ({ new: "Nouvelle", under_review: "En cours d’étude", answered: "Répondue", closed: "Clôturée" })[status] || "Nouvelle"; }

async function renderSubscriptionChangeRequests() {
    const workspace = document.querySelector("#creatorWorkspace");
    workspace.innerHTML = '<p class="muted">Chargement des demandes d’offres…</p>';
    const result = await api("/api/creator/subscription-change-requests");
    if (!result.ok) return showFeedback(result.message || "Impossible de charger les demandes d’offres.", true);
    const requests = result.data.requests || [];
    workspace.innerHTML = `<section class="creator-form"><div class="form-heading"><div><p class="eyebrow">Évolutions, rétrogradations et postes</p><h3>Demandes d’offres</h3></div><span class="creator-state">${requests.length} demande${requests.length > 1 ? "s" : ""}</span></div><div class="creator-network-list">${requests.length ? requests.map(item => `<form class="creator-network-company" data-subscription-request="${escapeHtml(item.id)}"><div><strong>${escapeHtml(item.companyName)}</strong><p>${escapeHtml(subscriptionTierLabel(item.currentTier))} → ${escapeHtml(subscriptionTierLabel(item.requestedTier))}</p><p>${Number(item.requestedPcSeats) || 0} poste(s) PC · ${Number(item.requestedMobileSeats) || 0} poste(s) mobile(s)</p><small>${escapeHtml(formatDateTime(item.createdAt))}${item.companyMessage ? ` · ${escapeHtml(item.companyMessage)}` : ""}</small></div><div class="creator-form-actions"><select name="status">${["new", "under_review", "accepted", "refused", "cancelled"].map(status => `<option value="${status}" ${item.status === status ? "selected" : ""}>${subscriptionChangeStatusLabel(status)}</option>`).join("")}</select><input name="creatorNote" maxlength="2000" value="${escapeHtml(item.creatorNote || "")}" placeholder="Note interne"><button class="secondary-button">Enregistrer</button></div></form>`).join("") : '<p class="muted">Aucune demande d’offre.</p>'}</div></section>`;
    workspace.querySelectorAll("[data-subscription-request]").forEach(form => form.addEventListener("submit", async event => {
        event.preventDefault();
        const values = Object.fromEntries(new FormData(form));
        const update = await api(`/api/creator/subscription-change-requests/${encodeURIComponent(form.dataset.subscriptionRequest)}`, { method: "PATCH", body: JSON.stringify(values) });
        if (!update.ok) return showFeedback(update.message || "Mise à jour impossible.", true);
        showFeedback("Suivi de la demande enregistré.");
        await refreshCreatorRequestNotifications();
        renderSubscriptionChangeRequests();
    }));
}

function subscriptionTierLabel(tier) { return ({ basic: "Basic", basic_plus: "Basic+", pro: "Pro" })[tier] || tier; }
function subscriptionChangeStatusLabel(status) { return ({ new: "Nouvelle", under_review: "En cours d’étude", accepted: "Acceptée", refused: "Refusée", cancelled: "Annulée" })[status] || "Nouvelle"; }

async function renderPartnerApiSandbox() {
    const workspace = document.querySelector("#creatorWorkspace");
    workspace.innerHTML = '<p class="muted">Chargement de la Sandbox API partenaire…</p>';
    const result = await api("/api/creator/partner-api-sandbox");
    if (!result.ok) return showFeedback(result.message || "Impossible de charger la Sandbox API.", true);
    const sandboxes = result.data?.sandboxes || [];
    workspace.innerHTML = `<section class="creator-form partner-api-sandbox-console"><div class="form-heading"><div><p class="eyebrow">🧪 MODE SANDBOX · API externe réelle</p><h3>Dépann'Home Test Services</h3></div><span class="creator-state">Isolé de la production</span></div><p>Cette entreprise fictive appelle le véritable endpoint partenaire avec les vrais headers, contrôles, traitements métier et callbacks HTTP. Les missions, clients et journaux de test restent exclus des vues de production.</p><form data-sandbox-provision class="group-filter"><select name="ownerId" required><option value="">Organisation destinataire…</option>${accounts.map(account => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.companyName || account.ownerFullName)}</option>`).join("")}</select><button class="secondary-button">Provisionner automatiquement</button></form><div class="creator-network-list">${sandboxes.length ? sandboxes.map(sandbox => `<article class="creator-network-company"><div><strong>${escapeHtml(sandbox.ownerName)}</strong><p>${escapeHtml(sandbox.partnerKey)} · ${sandbox.enabled ? "Connexion active" : "Désactivée"}</p><small>${escapeHtml(sandbox.partner.label)} · Défaut : ${escapeHtml(sandbox.faultMode)}</small></div><button type="button" class="secondary-button" data-open-api-sandbox="${escapeHtml(sandbox.ownerId)}">Ouvrir le banc de test</button></article>`).join("") : '<p class="muted">Aucune Sandbox provisionnée.</p>'}</div></section>`;
    workspace.querySelector("[data-sandbox-provision]").addEventListener("submit", async event => { event.preventDefault(); const ownerId = event.currentTarget.elements.ownerId.value; const created = await api("/api/creator/partner-api-sandbox/provision", { method: "POST", body: JSON.stringify({ ownerId }) }); if (!created.ok) return showFeedback(created.message || "Provisionnement impossible.", true); if (created.data?.created) alert(`Clé API Sandbox générée (affichée une seule fois) :\n${created.data.sandbox.apiKey}`); showFeedback(created.data?.created ? "Sandbox API et identifiants générés." : "Cette Sandbox existe déjà."); renderPartnerApiSandboxDetail(ownerId); });
    workspace.querySelectorAll("[data-open-api-sandbox]").forEach(button => button.addEventListener("click", () => renderPartnerApiSandboxDetail(button.dataset.openApiSandbox)));
}

async function renderPartnerApiSandboxDetail(ownerId) {
    const workspace = document.querySelector("#creatorWorkspace"); workspace.innerHTML = '<p class="muted">Ouverture du banc de test HTTP…</p>';
    const result = await api(`/api/creator/partner-api-sandbox/${encodeURIComponent(ownerId)}`);
    if (!result.ok) return showFeedback(result.message || "Sandbox introuvable.", true);
    const sandbox = result.data.sandbox, missions = result.data.missions || [], logs = result.data.logs || [];
    workspace.innerHTML = `<section class="creator-form partner-api-sandbox-console"><div class="form-heading"><div><p class="eyebrow">${escapeHtml(sandbox.partner.label)} · Entreprise externe fictive</p><h3>${escapeHtml(sandbox.partner.name)} → ${escapeHtml(sandbox.ownerName)}</h3></div><span class="creator-state">HTTP réel</span></div><div class="sandbox-warning-banner"><strong>Aucune donnée réelle.</strong> Endpoint : <code>${escapeHtml(sandbox.endpoint)}</code><br>Header : <code>X-API-Key: [SECRET GÉRÉ PAR LE SERVEUR]</code><br>Webhook : <code>${escapeHtml(sandbox.callbackUrl)}</code><br><small>La clé n’est affichée qu’à sa création ou à sa rotation.</small></div><div class="creator-form-actions"><button class="secondary-button" data-sandbox-send>Envoyer une mission test</button><select data-sandbox-scenario>${["none","duplicate","400","401","403","404","500","timeout","unavailable","invalid_json","missing_mission"].map(mode => `<option value="${mode}">${mode === "none" ? "Succès normal" : `Erreur ${mode}`}</option>`).join("")}</select><button class="secondary-button auth-outline-button" data-sandbox-repair>Régénérer le webhook</button><button class="secondary-button auth-outline-button" data-sandbox-rotate>Renouveler la clé</button><button class="secondary-button danger-button" data-sandbox-reset>Réinitialiser</button><button class="secondary-button" data-sandbox-back>Retour</button></div><p class="auth-message" data-sandbox-feedback aria-live="polite"></p><h4>Boîte de réception de l’entreprise externe</h4><div class="creator-network-list">${missions.length ? missions.map(mission => `<article class="creator-network-company"><div><strong>${escapeHtml(mission.externalMissionId)}</strong><p>${escapeHtml(mission.mappedData?.clientName || "Client test")} · ${escapeHtml(mission.status)}</p><small>${escapeHtml(mission.internalMissionNumber || "")} · ${escapeHtml(formatDateTime(mission.createdAt))}</small></div><div class="creator-form-actions">${[["accepted","Accepter"],["in_progress","En cours"],["completed","Terminer"],["rejected","Refuser"]].map(([status,label]) => `<button class="secondary-button" data-sandbox-status="${status}" data-mission-id="${mission.id}">${label}</button>`).join("")}</div></article>`).join("") : '<p class="muted">Aucune mission reçue. Envoyez le premier appel HTTP.</p>'}</div><h4>Journal API expurgé</h4><div class="partner-sandbox-api-log">${logs.length ? logs.map(log => `<article><code>${escapeHtml(log.direction)} · ${escapeHtml(log.endpoint)}</code><span>HTTP ${escapeHtml(log.httpStatus ?? "—")}</span><p>${escapeHtml(log.errorMessage || log.eventType || "Échange traité")}</p><small>${escapeHtml(formatDateTime(log.createdAt))}</small></article>`).join("") : '<p class="muted">Aucun échange enregistré.</p>'}</div></section>`;
    const feedback = workspace.querySelector("[data-sandbox-feedback]");
    workspace.querySelector("[data-sandbox-send]").addEventListener("click", async () => { const scenario = workspace.querySelector("[data-sandbox-scenario]").value; feedback.textContent = "Appel HTTP en cours…"; const sent = await api(`/api/creator/partner-api-sandbox/${encodeURIComponent(ownerId)}/send`, { method: "POST", body: JSON.stringify({ scenario }) }); feedback.textContent = sent.data?.ok ? `Scénario « ${scenario} » validé.` : sent.message || "Le scénario n’a pas produit la réponse attendue."; feedback.classList.toggle("error", !sent.ok); await renderPartnerApiSandboxDetail(ownerId); });
    workspace.querySelectorAll("[data-sandbox-status]").forEach(button => button.addEventListener("click", async () => {
        const selectedScenario = workspace.querySelector("[data-sandbox-scenario]").value;
        const callbackMode = ["500", "timeout", "unavailable"].includes(selectedScenario) ? selectedScenario : "none";
        const fault = await api(`/api/creator/partner-api-sandbox/${encodeURIComponent(ownerId)}/fault`, { method: "PATCH", body: JSON.stringify({ mode: callbackMode }) });
        if (!fault.ok) return showFeedback(fault.message || "Configuration du webhook impossible.", true);
        const changed = await api(`/api/creator/partner-api-sandbox/${encodeURIComponent(ownerId)}/status`, { method: "POST", body: JSON.stringify({ missionId: button.dataset.missionId, status: button.dataset.sandboxStatus }) });
        if (!changed.ok) return showFeedback(changed.message || "Changement de statut impossible.", true);
        showFeedback(callbackMode === "none" ? `Statut transmis par callback (${changed.data.delivery.delivered} webhook livré).` : `Erreur webhook « ${callbackMode} » simulée ; la relance reste dans l’outbox réelle.`);
        renderPartnerApiSandboxDetail(ownerId);
    }));
    workspace.querySelector("[data-sandbox-rotate]").addEventListener("click", async () => { if (!confirm("Renouveler la clé API de test ? L’ancienne clé cessera immédiatement de fonctionner.")) return; const rotated = await api(`/api/creator/partner-api-sandbox/${encodeURIComponent(ownerId)}/rotate-key`, { method: "POST" }); if (!rotated.ok) return showFeedback(rotated.message || "Rotation impossible.", true); alert(`Nouvelle clé API Sandbox :\n${rotated.data.apiKey}`); renderPartnerApiSandboxDetail(ownerId); });
    workspace.querySelector("[data-sandbox-repair]").addEventListener("click", async () => { const repaired = await api(`/api/creator/partner-api-sandbox/${encodeURIComponent(ownerId)}/repair-webhook`, { method: "POST" }); if (!repaired.ok) return showFeedback(repaired.message || "Régénération impossible.", true); showFeedback(repaired.data.message); renderPartnerApiSandboxDetail(ownerId); });
    workspace.querySelector("[data-sandbox-reset]").addEventListener("click", async () => { if (!confirm("Supprimer uniquement cette Sandbox, ses missions, clients test, callbacks et journaux ?")) return; const reset = await api(`/api/creator/partner-api-sandbox/${encodeURIComponent(ownerId)}`, { method: "DELETE" }); if (!reset.ok) return showFeedback(reset.message || "Réinitialisation impossible.", true); showFeedback("Sandbox réinitialisée sans toucher aux données de production."); renderPartnerApiSandbox(); });
    workspace.querySelector("[data-sandbox-back]").addEventListener("click", renderPartnerApiSandbox);
}

export async function openCreatorPartnerRequest(requestId) {
    await renderCreatorConsole();
    if (requestId) await renderPartnerRequestDetail(requestId);
}

async function renderOfficialPartners() {
    const workspace = document.querySelector("#creatorWorkspace");
    workspace.innerHTML = '<p class="muted">Chargement des partenaires officiels…</p>';
    const result = await api("/api/creator/official-partners");
    if (!result.ok) return showFeedback(result.message || "Impossible de charger les partenaires officiels.", true);
    const partners = result.data?.partners || [];
    workspace.innerHTML = `<section class="creator-form creator-network-directory"><div class="form-heading"><div><p class="eyebrow">Connecteurs centralisés</p><h3>Partenaires officiels</h3></div><button type="button" class="secondary-button" data-create-official-partner>+ Nouveau partenaire</button></div><p class="muted">Le type de partenaire détermine automatiquement l’expérience de connexion des entreprises. Elles ne voient jamais les paramètres API, OAuth ou les secrets configurés ici.</p><div class="creator-network-list">${partners.length ? partners.map(officialPartnerRow).join("") : '<p class="muted">Aucun partenaire officiel configuré.</p>'}</div><div class="creator-form-actions"><button type="button" class="secondary-button" data-official-partners-back>Retour aux entreprises</button></div></section>`;
    workspace.querySelector("[data-create-official-partner]").addEventListener("click", () => renderOfficialPartnerForm());
    workspace.querySelector("[data-official-partners-back]").addEventListener("click", () => selectedAccountId ? renderAccountDetail(selectedAccountId) : workspace.replaceChildren());
    workspace.querySelectorAll("[data-edit-official-partner]").forEach(button => button.addEventListener("click", () => renderOfficialPartnerForm(partners.find(partner => String(partner.id) === button.dataset.editOfficialPartner))));
    workspace.querySelectorAll("[data-delete-official-partner]").forEach(button => button.addEventListener("click", async () => {
        const partner = partners.find(item => String(item.id) === button.dataset.deleteOfficialPartner);
        if (!partner || !confirm(`Supprimer ${partner.companyName} du catalogue officiel ?`)) return;
        const deleted = await api(`/api/creator/official-partners/${encodeURIComponent(partner.id)}`, { method: "DELETE" });
        if (!deleted.ok) return showFeedback(deleted.message || "Suppression impossible.", true);
        showFeedback("Partenaire officiel supprimé."); renderOfficialPartners();
    }));
}

function officialPartnerRow(partner) {
    const type = ({ depannhome_company: "Entreprise Depann’Home Pro", credentials: "Authentification classique", oauth: "Autorisation sécurisée OAuth" })[partner.partnerType] || "Authentification classique";
    const state = ({ development: "En développement", beta: "Bêta", available: "Disponible", disabled: "Désactivé" })[partner.connectorState] || "En développement";
    return `<article class="creator-network-company"><div>${partner.logoUrl ? `<img src="${escapeHtml(partner.logoUrl)}" alt="" class="partner-directory-logo">` : ""}<strong>${escapeHtml(partner.companyName)}</strong><p>${escapeHtml([partner.activityCategory, type].filter(Boolean).join(" · "))}</p><small>${escapeHtml(state)}${partner.documentationUrl ? " · Documentation configurée" : ""}</small></div><div class="creator-form-actions"><button type="button" class="secondary-button" data-edit-official-partner="${escapeHtml(partner.id)}">Gérer</button><button type="button" class="secondary-button danger-button" data-delete-official-partner="${escapeHtml(partner.id)}">Supprimer</button></div></article>`;
}

function renderOfficialPartnerForm(partner = null) {
    const workspace = document.querySelector("#creatorWorkspace");
    const value = partner || { partnerType: "credentials", connectorState: "development", credentialFields: [{ label: "Identifiant" }, { label: "Mot de passe" }] };
    const fields = (value.connectorConfig?.credentialFields || value.credentialFields || []).map(field => field.label).join("\n");
    workspace.innerHTML = `<form class="creator-form" data-official-partner-form><div class="form-heading"><div><p class="eyebrow">Catalogue officiel</p><h3>${partner ? "Configurer le partenaire" : "Nouveau partenaire officiel"}</h3></div></div><p class="muted">Les entreprises voient uniquement une action de connexion adaptée. Les paramètres de ce formulaire restent réservés au Créateur.</p><div class="form-grid"><label>Nom du partenaire *<input name="companyName" required maxlength="160" value="${escapeHtml(value.companyName || "")}"></label><label>Catégorie d’activité<input name="activityCategory" maxlength="160" value="${escapeHtml(value.activityCategory || "")}" placeholder="Ex. Assurance, assistance"></label><label>Type de partenaire<select name="partnerType"><option value="depannhome_company" ${value.partnerType === "depannhome_company" ? "selected" : ""}>Entreprise Depann’Home Pro</option><option value="credentials" ${value.partnerType === "credentials" ? "selected" : ""}>Authentification classique</option><option value="oauth" ${value.partnerType === "oauth" ? "selected" : ""}>OAuth / autorisation sécurisée</option></select></label><label>État du connecteur<select name="connectorState">${[["development","En développement"],["beta","Bêta"],["available","Disponible"],["disabled","Désactivé"]].map(([id,label]) => `<option value="${id}" ${value.connectorState === id ? "selected" : ""}>${label}</option>`).join("")}</select></label><label>Logo (URL)<input name="logoUrl" type="url" value="${escapeHtml(value.logoUrl || "")}"></label><label>Site internet<input name="website" type="url" value="${escapeHtml(value.website || "")}"></label><label class="form-wide">Description<textarea name="description" rows="3" maxlength="2000">${escapeHtml(value.description || "")}</textarea></label><label>URL API<input name="apiUrl" type="url" value="${escapeHtml(value.apiUrl || "")}"></label><label>Documentation technique<input name="documentationUrl" type="url" value="${escapeHtml(value.documentationUrl || "")}"></label><label>Sandbox<input name="sandboxUrl" type="url" value="${escapeHtml(value.sandboxUrl || "")}"></label><label data-credential-fields>Informations demandées à l’entreprise<textarea name="credentialFields" rows="4" placeholder="Identifiant&#10;Mot de passe&#10;Clé API">${escapeHtml(fields)}</textarea></label><label data-oauth-field>URL d’autorisation OAuth<input name="authorizationUrl" type="url" value="${escapeHtml(value.connectorConfig?.authorizationUrl || "")}"></label><label data-oauth-field>URL de jeton OAuth<input name="tokenUrl" type="url" value="${escapeHtml(value.connectorConfig?.tokenUrl || "")}"></label><label data-oauth-field>Client ID OAuth<input name="clientId" maxlength="500" value="${escapeHtml(value.connectorConfig?.clientId || "")}"></label><label data-oauth-field>Client secret OAuth${value.hasConnectorSecret ? " (laisser vide pour le conserver)" : ""}<input name="clientSecret" type="password" autocomplete="new-password"></label><label data-oauth-field>Scopes OAuth<input name="scope" maxlength="500" value="${escapeHtml(value.connectorConfig?.scope || "")}" placeholder="openid profile"></label></div><p class="auth-message" aria-live="polite"></p><div class="creator-form-actions"><button type="submit" class="secondary-button">${partner ? "Enregistrer" : "Créer le partenaire"}</button><button type="button" class="secondary-button" data-cancel-official-partner>Retour au catalogue</button></div></form>`;
    const form = workspace.querySelector("form");
    const updateVisibility = () => { const type = form.elements.partnerType.value; form.querySelector("[data-credential-fields]").hidden = type !== "credentials"; form.querySelectorAll("[data-oauth-field]").forEach(field => { field.hidden = type !== "oauth"; }); };
    form.elements.partnerType.addEventListener("change", updateVisibility); updateVisibility();
    workspace.querySelector("[data-cancel-official-partner]").addEventListener("click", renderOfficialPartners);
    form.addEventListener("submit", async event => { event.preventDefault(); const submit = form.querySelector('button[type="submit"]'); const message = form.querySelector(".auth-message"); submit.disabled = true; const result = await api(partner ? `/api/creator/official-partners/${encodeURIComponent(partner.id)}` : "/api/creator/official-partners", { method: partner ? "PATCH" : "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) }); submit.disabled = false; if (!result.ok) { message.textContent = result.message || "Enregistrement impossible."; message.classList.add("error"); return; } showFeedback(partner ? "Partenaire officiel mis à jour." : "Partenaire officiel créé."); renderOfficialPartners(); });
}

async function renderPlatformAnnouncementSettings() {
    const workspace = document.querySelector("#creatorWorkspace");
    workspace.innerHTML = '<p class="muted">Chargement de l’affichage général…</p>';
    const result = await api("/api/creator/platform-announcement");
    if (!result.ok) return showFeedback(result.message || "Impossible de charger l’affichage général.", true);
    const announcement = result.data?.announcement || {};
    workspace.innerHTML = `
        <form id="creatorPlatformAnnouncementForm" class="creator-form creator-platform-announcement-form">
            <div class="form-heading"><div><p class="eyebrow">Communication plateforme</p><h3>Affichage général</h3></div><span class="creator-state${announcement.isActive ? "" : " suspended"}">${announcement.isActive ? "Diffusé" : "Masqué"}</span></div>
            <p class="muted">Ce message est affiché sur l’accueil de tous les postes, pour toutes les entreprises. Utilisez-le notamment pour prévenir d’une mise à jour pouvant ralentir temporairement le logiciel.</p>
            <div class="form-grid"><label class="form-wide">Message à afficher<textarea name="message" rows="6" maxlength="2000" placeholder="Ex. Une mise à jour est en cours. Le logiciel peut être momentanément ralenti.">${escapeHtml(announcement.message || "")}</textarea></label><label class="creator-switch form-wide">Afficher ce message sur tous les accueils<input name="isActive" type="checkbox" ${announcement.isActive ? "checked" : ""}><span>Vous pouvez le masquer sans effacer son contenu.</span></label></div>
            <p class="auth-message" aria-live="polite"></p>
            <div class="creator-form-actions"><button type="submit" class="secondary-button">Enregistrer l’affichage</button><button type="button" class="secondary-button" id="creatorPlatformAnnouncementBack">Retour aux entreprises</button></div>
        </form>
    `;
    workspace.querySelector("#creatorPlatformAnnouncementBack").addEventListener("click", () => selectedAccountId ? renderAccountDetail(selectedAccountId) : workspace.replaceChildren());
    workspace.querySelector("#creatorPlatformAnnouncementForm").addEventListener("submit", async event => {
        event.preventDefault();
        const form = event.currentTarget;
        const feedback = form.querySelector(".auth-message");
        const button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        const save = await api("/api/creator/platform-announcement", { method: "PUT", body: JSON.stringify({ message: form.elements.message.value, isActive: form.elements.isActive.checked }) });
        button.disabled = false;
        if (!save.ok) { feedback.textContent = save.message || "Enregistrement impossible."; feedback.classList.add("error"); return; }
        feedback.textContent = save.data?.announcement?.isActive ? "L’affichage général est diffusé sur tous les accueils." : "L’affichage général est enregistré et masqué.";
        feedback.classList.remove("error");
        form.querySelector(".creator-state").textContent = save.data?.announcement?.isActive ? "Diffusé" : "Masqué";
        form.querySelector(".creator-state").classList.toggle("suspended", !save.data?.announcement?.isActive);
    });
}

async function renderNetworkDirectory() {
    const workspace = document.querySelector("#creatorWorkspace");
    workspace.innerHTML = '<p class="muted">Chargement du Réseau Depann\'Home Pro…</p>';
    const result = await api("/api/creator/network-directory");
    if (!result.ok) return showFeedback(result.message || "Impossible de charger le réseau.", true);
    const companies = result.data.companies || []; const stats = result.data.statistics || {};
    workspace.innerHTML = `<section class="creator-form creator-network-directory"><div class="form-heading"><div><p class="eyebrow">Répertoire officiel</p><h3>Réseau DepanHomePro</h3></div></div><div class="creator-network-stats"><article><span>Inscrites</span><strong>${stats.registeredCompanies || 0}</strong></article><article><span>Visibles</span><strong>${stats.visibleCompanies || 0}</strong></article><article><span>Fiches suspendues</span><strong>${stats.suspendedCompanies || 0}</strong></article><article><span>Entreprises archivées</span><strong>${stats.archivedCompanies || 0}</strong></article><article><span>Connexions actives</span><strong>${stats.connectedPairs || 0}</strong></article></div><form data-network-filter class="group-filter"><input name="q" type="search" placeholder="Entreprise, ville ou code postal"><button class="secondary-button">Rechercher</button></form><div class="creator-network-list">${companies.length ? companies.map(networkRow).join("") : '<p class="muted">Aucune entreprise inscrite.</p>'}</div><div class="creator-form-actions"><button type="button" class="secondary-button" data-network-back>Retour aux entreprises</button></div></section>`;
    workspace.querySelector("[data-network-back]").addEventListener("click", () => selectedAccountId ? renderAccountDetail(selectedAccountId) : workspace.replaceChildren());
    workspace.querySelector("[data-network-filter]").addEventListener("submit", async event => { event.preventDefault(); const query = new URLSearchParams(new FormData(event.currentTarget)); const refreshed = await api(`/api/creator/network-directory?${query}`); if (!refreshed.ok) return showFeedback(refreshed.message || "Recherche impossible.", true); const list = workspace.querySelector(".creator-network-list"); list.innerHTML = (refreshed.data.companies || []).map(networkRow).join("") || '<p class="muted">Aucune entreprise trouvée.</p>'; bindNetworkActions(list); });
    bindNetworkActions(workspace);
}

function networkRow(company) { const directoryArchived = company.creatorSuspended && !company.isListed; return `<article class="creator-network-company${company.isArchived || directoryArchived ? " archived" : ""}"><div><strong>${escapeHtml(company.companyName || "Organisation")}</strong><p>${escapeHtml(company.organizationBadge || "Organisation")}</p><p>${escapeHtml([company.city, company.postalCode].filter(Boolean).join(" · ") || "Coordonnées non renseignées")}</p><small>${company.isArchived ? "Entreprise archivée · Données conservées" : directoryArchived ? "Fiche Réseau archivée · Données conservées" : `${company.isListed ? "Visible" : "Interne"}${company.creatorSuspended ? " · Suspendue" : ""}${company.acceptsPartnerMissions ? " · Missions acceptées" : ""}`}</small></div><div class="creator-form-actions">${company.isArchived ? `<button type="button" class="secondary-button" data-network-restore="${escapeHtml(company.id)}">Réactiver l’entreprise</button>` : directoryArchived ? `<button type="button" class="secondary-button" data-network-directory-restore="${escapeHtml(company.id)}">Restaurer la fiche</button>` : `<button type="button" class="secondary-button" data-network-manage="${escapeHtml(company.id)}">Gérer</button><button type="button" class="secondary-button danger-button" data-network-delete="${escapeHtml(company.id)}">Archiver la fiche</button>`}</div></article>`; }

function bindNetworkActions(container) { container.querySelectorAll("[data-network-manage]").forEach(button => button.addEventListener("click", async () => { const company = (await api("/api/creator/network-directory")).data?.companies?.find(item => String(item.id) === button.dataset.networkManage); if (company) renderNetworkCompanyForm(company); })); container.querySelectorAll("[data-network-delete]").forEach(button => button.addEventListener("click", async () => { if (!confirm("Archiver cette fiche du Réseau DepannHomePro ? Ses informations et ses partenariats seront conservés.")) return; const deleted = await api(`/api/creator/network-directory/${encodeURIComponent(button.dataset.networkDelete)}`, { method: "DELETE" }); if (!deleted.ok) return showFeedback(deleted.message || "Archivage impossible.", true); showFeedback("Fiche Réseau archivée sans perte de données."); renderNetworkDirectory(); })); container.querySelectorAll("[data-network-directory-restore]").forEach(button => button.addEventListener("click", async () => { const restored = await api(`/api/creator/network-directory/${encodeURIComponent(button.dataset.networkDirectoryRestore)}/restore`, { method: "PATCH" }); if (!restored.ok) return showFeedback(restored.message || "Restauration impossible.", true); showFeedback("Fiche Réseau restaurée avec toutes ses informations."); renderNetworkDirectory(); })); container.querySelectorAll("[data-network-restore]").forEach(button => button.addEventListener("click", async () => { if (!confirm("Réactiver cette entreprise et ses accès ?")) return; const restored = await api(`/api/creator/accounts/${encodeURIComponent(button.dataset.networkRestore)}/restore`, { method: "PATCH" }); if (!restored.ok) return showFeedback(restored.message || "Réactivation impossible.", true); await loadAccounts(button.dataset.networkRestore); showFeedback("Entreprise réactivée avec toutes ses données."); renderNetworkDirectory(); })); }

function renderNetworkCompanyForm(company) { const workspace = document.querySelector("#creatorWorkspace"); workspace.innerHTML = `<form class="creator-form" data-network-company-form><div class="form-heading"><div><p class="eyebrow">Fiche Réseau</p><h3>${escapeHtml(company.companyName || "Entreprise")}</h3></div></div><p class="muted">Le Créateur peut corriger les informations professionnelles et suspendre la fiche. Les coordonnées publiées restent sous le contrôle de l’entreprise.</p><div class="form-grid"><label class="creator-switch">Visible<input name="isListed" type="checkbox" ${company.isListed ? "checked" : ""}><span>Apparaît dans les recherches</span></label><label class="creator-switch">Suspendre<input name="creatorSuspended" type="checkbox" ${company.creatorSuspended ? "checked" : ""}><span>Masquer en cas d’abus</span></label><label class="form-wide">Description<textarea name="description" rows="3" maxlength="1000">${escapeHtml(company.description || "")}</textarea></label><label>Métiers<input name="trades" value="${escapeHtml(listText(company.trades))}"></label><label>Marques<input name="supportedBrands" value="${escapeHtml(listText(company.supportedBrands))}"></label><label>Spécialités<input name="specialties" value="${escapeHtml(listText(company.specialties))}"></label><label>Zone<input name="serviceArea" value="${escapeHtml(company.serviceArea || "")}"></label><label>Rayon (km)<input name="serviceRadiusKm" type="number" min="0" max="500" value="${Number(company.serviceRadiusKm) || 0}"></label><label>Départements<input name="departments" value="${escapeHtml(listText(company.departments))}"></label><label>Horaires<textarea name="openingHours" rows="2" maxlength="1000">${escapeHtml(company.openingHours || "")}</textarea></label><label>Site internet<input name="website" type="url" value="${escapeHtml(company.website || "")}"></label><label class="creator-switch">Accepte les missions<input name="acceptsPartnerMissions" type="checkbox" ${company.acceptsPartnerMissions ? "checked" : ""}><span>Indication du réseau</span></label><label class="form-wide">Note interne Créateur<textarea name="creatorNote" rows="3" maxlength="1000">${escapeHtml(company.creatorNote || "")}</textarea></label></div><p class="auth-message" aria-live="polite"></p><div class="creator-form-actions"><button class="secondary-button">Enregistrer la fiche</button><button type="button" class="secondary-button" data-network-back>Retour au réseau</button></div></form>`; const form = workspace.querySelector("form"); workspace.querySelector("[data-network-back]").addEventListener("click", renderNetworkDirectory); form.addEventListener("submit", async event => { event.preventDefault(); const values = Object.fromEntries(new FormData(form)); ["isListed", "creatorSuspended", "acceptsPartnerMissions"].forEach(key => { values[key] = form.elements[key].checked; }); const saved = await api(`/api/creator/network-directory/${encodeURIComponent(company.id)}`, { method: "PATCH", body: JSON.stringify(values) }); if (!saved.ok) { form.querySelector(".auth-message").textContent = saved.message || "Enregistrement impossible."; return; } showFeedback("Fiche Réseau mise à jour."); renderNetworkDirectory(); }); }

function listText(value) { return Array.isArray(value) ? value.join(", ") : ""; }

async function renderPartnerRequests() {
    const workspace = document.querySelector("#creatorWorkspace");
    workspace.innerHTML = '<p class="muted">Chargement des demandes de partenariat…</p>';
    const result = await api("/api/creator/partner-requests");
    if (!result.ok) return showFeedback(result.message || "Impossible de charger les demandes de partenariat.", true);
    const requests = result.data.requests || [];
    workspace.innerHTML = `
        <section class="creator-form creator-partner-requests-panel">
            <div class="form-heading"><div><p class="eyebrow">Prospection et réseau</p><h3>Demandes de partenariat</h3></div><span class="creator-state">${requests.length} demande${requests.length > 1 ? "s" : ""}</span></div>
            <p class="muted">Une demande acceptée crée automatiquement une fiche partenaire officielle prête pour la future gestion des accès, contrats, autorisations et connecteurs.</p>
            <div class="creator-partner-request-list">${requests.length ? requests.map(partnerRequestRow).join("") : '<p class="muted">Aucune demande de partenariat pour le moment.</p>'}</div>
            <div class="creator-form-actions"><button type="button" class="secondary-button" id="creatorPartnerRequestsBack">Retour aux entreprises</button></div>
        </section>
    `;
    workspace.querySelector("#creatorPartnerRequestsBack").addEventListener("click", () => selectedAccountId ? renderAccountDetail(selectedAccountId) : workspace.replaceChildren());
    workspace.querySelectorAll("[data-partner-request-id]").forEach(button => button.addEventListener("click", () => renderPartnerRequestDetail(button.dataset.partnerRequestId)));
}

function partnerRequestRow(partnerRequest) {
    return `<article class="creator-partner-request"><div><p class="eyebrow">${escapeHtml(partnerOrganizationLabel(partnerRequest.organizationType))} · ${escapeHtml(formatDateTime(partnerRequest.createdAt))}</p><h4>${escapeHtml(partnerRequest.companyName)}</h4><p>${escapeHtml(partnerRequest.contactName)} · ${escapeHtml(partnerRequest.contactRole)}</p><small>${escapeHtml(partnerRequest.email)}</small></div><div class="creator-partner-request-actions"><span class="creator-subscription-badge ${escapeHtml(partnerRequest.status)}">${escapeHtml(partnerRequestStatusLabel(partnerRequest.status))}</span><button type="button" class="secondary-button" data-partner-request-id="${escapeHtml(partnerRequest.id)}">Consulter</button></div></article>`;
}

async function renderPartnerRequestDetail(requestId) {
    const workspace = document.querySelector("#creatorWorkspace");
    workspace.innerHTML = '<p class="muted">Chargement de la demande…</p>';
    const result = await api(`/api/creator/partner-requests/${encodeURIComponent(requestId)}`);
    if (!result.ok) return showFeedback(result.message || "Impossible de charger la demande.", true);
    const partnerRequest = result.data.request;
    workspace.innerHTML = `
        <form id="creatorPartnerRequestForm" class="creator-form creator-partner-request-detail">
            <div class="form-heading"><div><p class="eyebrow">${escapeHtml(partnerOrganizationLabel(partnerRequest.organizationType))} · Demande du ${escapeHtml(formatDateTime(partnerRequest.createdAt))}</p><h3>${escapeHtml(partnerRequest.companyName)}</h3></div><span class="creator-subscription-badge ${escapeHtml(partnerRequest.status)}">${escapeHtml(partnerRequestStatusLabel(partnerRequest.status))}</span></div>
            <dl class="creator-partner-request-summary"><div><dt>Contact</dt><dd>${escapeHtml(partnerRequest.contactName)} · ${escapeHtml(partnerRequest.contactRole)}</dd></div><div><dt>E-mail</dt><dd><a href="mailto:${escapeHtml(partnerRequest.email)}">${escapeHtml(partnerRequest.email)}</a></dd></div><div><dt>Téléphone</dt><dd><a href="tel:${escapeHtml(partnerRequest.phone.replace(/[^+0-9]/g, ""))}">${escapeHtml(partnerRequest.phone)}</a></dd></div><div><dt>Site internet</dt><dd>${partnerRequest.website ? `<a href="${escapeHtml(partnerRequest.website)}" target="_blank" rel="noopener noreferrer">${escapeHtml(partnerRequest.website)}</a>` : "Non renseigné"}</dd></div></dl>
            <section class="creator-partner-request-message"><h4>Projet ou besoin</h4><p>${escapeHtml(partnerRequest.message).replace(/\n/g, "<br>")}</p></section>
            <div class="form-grid"><label>Statut<select name="status">${["new", "under_review", "contacted", "accepted", "refused"].map(status => `<option value="${status}" ${partnerRequest.status === status ? "selected" : ""}>${partnerRequestStatusLabel(status)}</option>`).join("")}</select></label><label class="form-wide">Notes administratives internes<textarea name="administrativeNotes" rows="6" maxlength="4000" placeholder="Compte-rendu d’échange, conditions, prochaines étapes…">${escapeHtml(partnerRequest.administrativeNotes || "")}</textarea></label></div>
            <p class="muted">Le statut « Acceptée » crée une fiche partenaire officielle sans créer de compte utilisateur ni donner accès aux données.</p>
            <p class="auth-message" aria-live="polite" id="creatorPartnerRequestFeedback"></p>
            <div class="creator-form-actions"><a class="secondary-button auth-outline-button" href="mailto:${escapeHtml(partnerRequest.email)}?subject=${encodeURIComponent(`Depann’Home Pro — demande de partenariat ${partnerRequest.companyName}`)}">Contacter le partenaire</a><button type="submit" class="secondary-button">Enregistrer le suivi</button><button type="button" class="secondary-button danger-button" id="creatorDeletePartnerRequest">Supprimer la demande</button><button type="button" class="secondary-button" id="creatorPartnerRequestBack">Retour à la liste</button></div>
        </form>
    `;
    workspace.querySelector("#creatorPartnerRequestBack").addEventListener("click", renderPartnerRequests);
    workspace.querySelector("#creatorPartnerRequestForm").addEventListener("submit", async event => {
        event.preventDefault();
        const form = event.currentTarget;
        const feedback = form.querySelector("#creatorPartnerRequestFeedback");
        const submit = form.querySelector('button[type="submit"]');
        submit.disabled = true;
        const update = await api(`/api/creator/partner-requests/${encodeURIComponent(requestId)}`, { method: "PATCH", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
        submit.disabled = false;
        if (!update.ok) { feedback.textContent = update.message || "Enregistrement impossible."; feedback.classList.add("error"); return; }
        feedback.textContent = update.data.request.officialPartnerId ? "Suivi enregistré. La fiche partenaire officielle est prête à être configurée." : "Suivi enregistré.";
        feedback.classList.remove("error");
        await refreshCreatorRequestNotifications();
        renderPartnerRequestDetail(requestId);
    });
    workspace.querySelector("#creatorDeletePartnerRequest").addEventListener("click", async () => {
        if (!confirm(`Supprimer définitivement la demande de ${partnerRequest.companyName} ?`)) return;
        const deleted = await api(`/api/creator/partner-requests/${encodeURIComponent(requestId)}`, { method: "DELETE" });
        if (!deleted.ok) return showFeedback(deleted.message || "Suppression impossible.", true);
        showFeedback("Demande de partenariat supprimée.");
        renderPartnerRequests();
    });
}

function partnerRequestStatusLabel(status) { return ({ new: "Nouvelle", under_review: "En cours d’étude", contacted: "Contactée", accepted: "Acceptée", refused: "Refusée" })[status] || "Nouvelle"; }
function partnerOrganizationLabel(type) { return ({ insurance: "Assurance", assistance_company: "Société d’assistance", expert: "Expert", claims_manager: "Gestionnaire de sinistres", local_authority: "Collectivité", landlord: "Bailleur", franchise_network: "Réseau de franchise", private_company: "Entreprise privée", other: "Autre" })[type] || "Organisation"; }

async function loadAccounts(preferredId = selectedAccountId) {
    const result = await api("/api/creator/accounts");
    if (!result.ok) return showFeedback(result.message || "Impossible de charger les entreprises.", true);
    accounts = result.data.accounts || [];
    selectedAccountId = accounts.some(account => String(account.id) === String(preferredId)) ? String(preferredId) : "";
    const selected = accounts.find(account => String(account.id) === selectedAccountId);
    if (selected) accountListMode = selected.isArchived ? "archived" : "active";
    renderSubscriptionSummary();
    renderAccountList();
    if (selectedAccountId) await renderAccountDetail(selectedAccountId);
    else document.querySelector("#creatorWorkspace").innerHTML = '<p class="muted">Aucune entreprise créée pour le moment.</p>';
}

function renderSubscriptionSummary() {
    const summary = document.querySelector("#creatorSubscriptionSummary");
    if (!summary) return;
    const activeAccounts = accounts.filter(account => !account.isArchived);
    const paidAccounts = activeAccounts.filter(account => account.subscriptionPlan === "paid");
    const activePaidAccounts = paidAccounts.filter(account => ["active", "trial", "past_due"].includes(account.subscriptionStatus));
    const monthlyRevenue = activePaidAccounts.reduce((total, account) => total + subscriptionNetAmountCents(account), 0);
    const pastDue = activeAccounts.filter(account => account.subscriptionStatus === "past_due").length;
    summary.innerHTML = `
        <article><span>Entreprises actives</span><strong>${activeAccounts.length}</strong></article>
        <article><span>Archives conservées</span><strong>${accounts.length - activeAccounts.length}</strong></article>
        <article><span>Mensuel estimé</span><strong>${formatCurrency(monthlyRevenue)}</strong></article>
        <article class="${pastDue ? "attention" : ""}"><span>Paiements à suivre</span><strong>${pastDue}</strong></article>
    `;
}

function renderAccountList() {
    const list = document.querySelector("#creatorAccounts");
    const activeAccounts = accounts.filter(account => !account.isArchived);
    const archivedAccounts = accounts.filter(account => account.isArchived);
    const displayedAccounts = accountListMode === "archived" ? archivedAccounts : activeAccounts;
    list.innerHTML = `<div class="creator-account-filters"><button type="button" class="${accountListMode === "active" ? "active" : ""}" data-account-mode="active">Actives (${activeAccounts.length})</button><button type="button" class="${accountListMode === "archived" ? "active" : ""}" data-account-mode="archived">Archivées (${archivedAccounts.length})</button></div>${displayedAccounts.length ? displayedAccounts.map(account => `
        <button type="button" class="creator-account${account.isArchived ? " archived" : ""}${String(account.id) === selectedAccountId ? " selected" : ""}" data-account-id="${escapeHtml(account.id)}">
            <strong>${escapeHtml(account.companyName || account.ownerFullName || account.ownerUsername)}</strong>
            <span>${escapeHtml(account.ownerUsername)} · ${account.isArchived ? "Archivée" : account.isActive ? "Active" : "Suspendue"}</span>
            <em class="creator-subscription-badge ${escapeHtml(account.subscriptionStatus || "active")}">${escapeHtml(subscriptionPlanLabel(account))} · ${escapeHtml(subscriptionStatusLabel(account.subscriptionStatus))}</em>
            <small>${account.activePcUsers}/${account.maxPcUsers} PC · ${account.activeTechnicians}/${account.maxTechnicians} mobiles</small>
        </button>
    `).join("") : `<p class="muted">Aucune entreprise ${accountListMode === "archived" ? "archivée" : "active"}.</p>`}`;
    list.querySelectorAll("[data-account-mode]").forEach(button => button.addEventListener("click", () => { accountListMode = button.dataset.accountMode; selectedAccountId = ""; renderAccountList(); document.querySelector("#creatorWorkspace").innerHTML = '<p class="muted">Sélectionnez une organisation.</p>'; }));
    list.querySelectorAll("[data-account-id]").forEach(button => button.addEventListener("click", async () => {
        selectedAccountId = button.dataset.accountId;
        renderAccountList();
        await renderAccountDetail(selectedAccountId);
    }));
}

async function renderAccountDetail(accountId) {
    const account = accounts.find(item => String(item.id) === String(accountId));
    if (!account) return;
    const isOwnCreatorAccount = String(account.id) === String(document.body.dataset.userId);
    const accountState = account.isArchived ? "Archivée" : account.isActive ? "Active" : "Suspendue";
    const workspace = document.querySelector("#creatorWorkspace");
    workspace.innerHTML = `
        <form id="creatorAccountForm" class="creator-form">
            <div class="form-heading"><div><p class="eyebrow">${escapeHtml(account.organization?.badge || "Entreprise Depann’Home Pro")}</p><h3>${escapeHtml(account.companyName)}</h3></div><span class="creator-state${account.isArchived ? " archived" : account.isActive ? "" : " suspended"}">${accountState}</span></div>
            <div class="form-grid">
                <label>Raison sociale<input name="companyName" maxlength="160" required value="${escapeHtml(account.companyName)}"></label>
                <label>Responsable principal<input name="fullName" maxlength="100" required value="${escapeHtml(account.ownerFullName)}"></label>
                <label>Téléphone responsable<input name="phone" maxlength="30" value="${escapeHtml(account.ownerPhone)}"></label>
                <label>E-mail de facturation<input name="billingEmail" type="email" maxlength="160" value="${escapeHtml(account.billingEmail || "")}" placeholder="comptabilite@entreprise.fr"></label>
                <label>Postes PC autorisés<input name="maxPcUsers" type="number" min="1" max="100" required value="${escapeHtml(account.maxPcUsers)}"></label>
                <label>Postes mobiles autorisés<input name="maxTechnicians" type="number" min="0" max="500" required value="${escapeHtml(account.maxTechnicians)}"></label>
            </div>
            ${renderCompanyProfileFields(account.companyProfile)}
            ${renderSubscriptionFields(account)}
            ${renderOrganizationFields(account.organization)}
            ${renderDocumentTemplatePolicyFields(account)}
            ${isOwnCreatorAccount ? '<p class="creator-account-status-note">Le compte Créateur reste actif en permanence.</p>' : account.isArchived ? `<section class="creator-account-status-panel archived"><div><strong>Entreprise archivée</strong><p>Tous les accès sont bloqués, mais les clients, interventions, rapports, documents, écritures et partenariats sont intégralement conservés.${account.archivedAt ? ` Archive créée le ${escapeHtml(formatDateTime(account.archivedAt))}.` : ""}</p></div><button type="button" class="secondary-button" id="creatorRestoreAccount">Réactiver l’entreprise</button></section>` : `<section class="creator-account-status-panel ${account.isActive ? "active" : "suspended"}"><div><strong>${account.isActive ? "Entreprise active" : "Entreprise suspendue"}</strong><p>${account.isActive ? "Les membres peuvent se connecter et utiliser leur espace." : "Les connexions et les sessions en cours sont bloquées. Les données restent conservées."}</p></div><button type="button" class="secondary-button ${account.isActive ? "danger-button" : ""}" id="creatorToggleAccountStatus">${account.isActive ? "Suspendre l’entreprise" : "Réactiver l’entreprise"}</button></section>`}
            <div class="creator-form-actions">${account.isArchived ? "" : '<button type="submit" class="secondary-button">Enregistrer l’entreprise</button>'}${isOwnCreatorAccount || account.isArchived ? "" : '<button type="button" class="secondary-button danger-button" id="creatorDeleteAccount">Archiver l’entreprise</button>'}</div>
        </form>
        <section class="creator-members-section"><div class="form-heading"><div><p class="eyebrow">Traçabilité</p><h3>Historique de l’organisation</h3></div></div><div id="creatorOrganizationHistory"><p class="muted">Chargement de l’historique…</p></div></section>
        <section class="creator-members-section"><div class="form-heading"><div><p class="eyebrow">Accès</p><h3>Postes PC et mobiles</h3></div>${account.isArchived ? "" : '<div class="creator-form-actions"><button type="button" class="secondary-button auth-outline-button" id="creatorNewPcMember">+ Poste PC</button><button type="button" class="secondary-button" id="creatorNewTechnician">+ Poste mobile</button></div>'}</div><div id="creatorMembers"><p class="muted">Chargement des accès…</p></div></section>
    `;
    if (account.isArchived) workspace.querySelectorAll("#creatorAccountForm [name]").forEach(field => { field.disabled = true; });
    workspace.querySelector("#creatorAccountForm").addEventListener("submit", async event => {
        event.preventDefault();
        const button = event.currentTarget.querySelector('button[type="submit"]');
        button.disabled = true;
        const values = await companyProfileFromForm(event.currentTarget);
        values.organization = organizationFromForm(event.currentTarget);
        const result = await api(`/api/creator/accounts/${encodeURIComponent(accountId)}`, { method: "PATCH", body: JSON.stringify(values) });
        button.disabled = false;
        if (!result.ok) return showFeedback(result.message || "Mise à jour impossible.", true);
        showFeedback("Entreprise mise à jour.");
        await loadAccounts(accountId);
    });
    workspace.querySelector("#creatorToggleAccountStatus")?.addEventListener("click", async event => {
        const isActivating = !account.isActive;
        const confirmation = isActivating
            ? `Réactiver ${account.companyName} ? Les membres pourront de nouveau se connecter.`
            : `Suspendre ${account.companyName} ? Tous les membres seront déconnectés à leur prochain appel et aucune nouvelle connexion ne sera autorisée.`;
        if (!confirm(confirmation)) return;
        event.currentTarget.disabled = true;
        const result = await api(`/api/creator/accounts/${encodeURIComponent(accountId)}/activation`, { method: "PATCH", body: JSON.stringify({ isActive: isActivating }) });
        if (!result.ok) { event.currentTarget.disabled = false; return showFeedback(result.message || "Modification du statut impossible.", true); }
        showFeedback(isActivating ? "Entreprise réactivée. Les membres peuvent de nouveau se connecter." : "Entreprise suspendue. Les données sont conservées et les accès sont bloqués.");
        await loadAccounts(accountId);
    });
    workspace.querySelector("#creatorDeleteAccount")?.addEventListener("click", async () => {
        if (!confirm(`Archiver ${account.companyName} ? Tous les accès seront bloqués, mais aucune donnée ne sera supprimée.`)) return;
        const reason = prompt("Motif de l’archivage (facultatif) :", "");
        if (reason === null) return;
        const result = await api(`/api/creator/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE", body: JSON.stringify({ reason }) });
        if (!result.ok) return showFeedback(result.message || "Archivage impossible.", true);
        accountListMode = "archived";
        showFeedback("Entreprise archivée. Toutes ses données sont conservées et peuvent être réactivées.");
        await loadAccounts(accountId);
    });
    workspace.querySelector("#creatorRestoreAccount")?.addEventListener("click", async () => { if (!confirm(`Réactiver ${account.companyName} avec tous ses accès et ses données ?`)) return; const result = await api(`/api/creator/accounts/${encodeURIComponent(accountId)}/restore`, { method: "PATCH" }); if (!result.ok) return showFeedback(result.message || "Réactivation impossible.", true); accountListMode = "active"; showFeedback("Entreprise réactivée avec toutes ses données."); await loadAccounts(accountId); });
    workspace.querySelector("#creatorNewPcMember")?.addEventListener("click", () => renderMemberForm(account, null, "admin"));
    workspace.querySelector("#creatorNewTechnician")?.addEventListener("click", () => renderMemberForm(account, null, account.subscriptionTier === "basic" ? "mobile_admin" : "technician"));
    if (!account.isArchived) {
        bindSubscriptionTier(workspace.querySelector("#creatorAccountForm"));
        bindOrganizationInterface(workspace.querySelector("#creatorAccountForm"));
    }
    await loadOrganizationHistory(accountId);
    await loadMembers(accountId);
}

function renderAccountForm() {
    selectedAccountId = "";
    renderAccountList();
    document.querySelector("#creatorWorkspace").innerHTML = `
        <form id="creatorNewAccountForm" class="creator-form">
            <div class="form-heading"><div><p class="eyebrow">Nouvelle organisation</p><h3>Créer un espace client</h3></div></div>
            <div class="form-grid">
                <label>Raison sociale<input name="companyName" maxlength="160" required placeholder="Ex. Martin Automatismes"></label>
                <label>Responsable principal<input name="fullName" maxlength="100" required placeholder="Nom et prénom"></label>
                <label>Téléphone responsable<input name="phone" maxlength="30" placeholder="06 12 34 56 78"></label>
                <label>E-mail de facturation<input name="billingEmail" type="email" maxlength="160" placeholder="comptabilite@entreprise.fr"></label>
                <label>Identifiant administrateur<input name="username" minlength="3" maxlength="32" required placeholder="minuscules, chiffres, . _ -"></label>
                <label>Mot de passe initial<input name="password" type="password" minlength="12" required autocomplete="new-password"></label>
                <label>Postes PC autorisés<input name="maxPcUsers" type="number" min="1" max="100" required value="1"></label>
                <label>Postes mobiles autorisés<input name="maxTechnicians" type="number" min="0" max="500" required value="1"></label>
            </div>
            ${renderCompanyProfileFields()}
            ${renderSubscriptionFields({ subscriptionTier: "basic", subscriptionPlan: "paid", subscriptionLabel: "Basic", monthlyPriceCents: 2500, subscriptionDiscountLabel: "", subscriptionDiscountMode: "fixed", subscriptionDiscountValue: 0, subscriptionStatus: "active", subscriptionRenewalDate: "", billingReference: "", creatorNote: "" })}
            ${renderOrganizationFields()}
            ${renderDocumentTemplatePolicyFields({ quoteTemplatePolicy: "company_choice", quitusTemplatePolicy: "company_choice", reportTemplatePolicy: "company_choice" })}
            <div class="creator-form-actions"><button type="submit" class="secondary-button">Créer l’entreprise</button></div>
        </form>
    `;
    bindSubscriptionTier(document.querySelector("#creatorNewAccountForm"));
    bindOrganizationInterface(document.querySelector("#creatorNewAccountForm"));
    document.querySelector("#creatorNewAccountForm").addEventListener("submit", async event => {
        event.preventDefault();
        const button = event.currentTarget.querySelector('button[type="submit"]');
        button.disabled = true;
        const values = await companyProfileFromForm(event.currentTarget);
        values.organization = organizationFromForm(event.currentTarget);
        const result = await api("/api/creator/accounts", { method: "POST", body: JSON.stringify(values) });
        button.disabled = false;
        if (!result.ok) return showFeedback(result.message || "Création impossible.", true);
        selectedAccountId = result.data.id;
        showFeedback("Organisation et Administrateur (PC) créés.");
        await loadAccounts(selectedAccountId);
    });
}

function renderCompanyProfileFields(profile = {}) {
    const activities = ["Recherche de fuite", "Plomberie", "Serrurerie", "Menuiserie", "Volets roulants", "Portails", "Portes de garage", "Domotique", "Électricité", "Chauffage", "Climatisation", "Assèchement", "Vitrerie", "Autres"];
    const specialties = Array.isArray(profile.specialties) ? profile.specialties : [];
    const departments = Array.isArray(profile.departments) ? profile.departments.join(", ") : "";
    const regions = Array.isArray(profile.regions) ? profile.regions.join(", ") : profile.region || "";
    const coverageMode = profile.coverageMode || "custom";
    return `
        <fieldset class="creator-subscription-fields creator-company-profile-fields"><legend>Fiche entreprise et Réseau Depann’Home Pro</legend>
            <p class="muted">Ces informations créent et actualisent automatiquement la fiche publique de l’entreprise dans le Réseau Depann’Home Pro.</p>
            <div class="form-grid">
                <label>Nom commercial (facultatif)<input name="commercialName" maxlength="160" value="${escapeHtml(profile.commercialName || "")}"></label>
                <label>SIRET *<input name="siret" inputmode="numeric" maxlength="14" required value="${escapeHtml(profile.siret || "")}" placeholder="14 chiffres"></label>
                <label class="form-wide">Adresse complète *<input name="address" maxlength="255" required value="${escapeHtml(profile.address || "")}"></label>
                <label>Code postal *<input name="postalCode" maxlength="20" required value="${escapeHtml(profile.postalCode || "")}"></label>
                <label>Ville *<input name="city" maxlength="100" required value="${escapeHtml(profile.city || "")}"></label>
                <label>Département(s)<input name="departments" maxlength="300" value="${escapeHtml(departments)}" placeholder="Ex. 69, 01"></label>
                <label>Région(s)<input name="regions" maxlength="500" value="${escapeHtml(regions)}" placeholder="Ex. Auvergne-Rhône-Alpes"></label>
                <label>Pays<input name="country" maxlength="100" value="${escapeHtml(profile.country || "France")}"></label>
                <label>Téléphone principal *<input name="companyPhone" type="tel" maxlength="50" required value="${escapeHtml(profile.phone || "")}"></label>
                <label>Téléphone secondaire<input name="secondaryPhone" type="tel" maxlength="50" value="${escapeHtml(profile.secondaryPhone || "")}"></label>
                <label>E-mail *<input name="companyEmail" type="email" maxlength="160" required value="${escapeHtml(profile.email || "")}"></label>
                <label>Site Internet<input name="website" type="url" maxlength="500" value="${escapeHtml(profile.website || "")}" placeholder="https://www.exemple.fr"></label>
                <label class="form-wide">Spécialités<select name="specialties" multiple size="6" aria-describedby="companySpecialtiesHelp">${activities.map(activity => `<option value="${escapeHtml(activity)}" ${specialties.includes(activity) ? "selected" : ""}>${escapeHtml(activity)}</option>`).join("")}</select><small id="companySpecialtiesHelp">Utilisez Ctrl ou Cmd pour sélectionner plusieurs activités.</small></label>
                <label>Zone d’intervention<select name="coverageMode"><option value="france" ${coverageMode === "france" ? "selected" : ""}>France entière</option><option value="departments" ${coverageMode === "departments" ? "selected" : ""}>Département(s)</option><option value="regions" ${coverageMode === "regions" ? "selected" : ""}>Région(s)</option><option value="radius" ${coverageMode === "radius" ? "selected" : ""}>Rayon kilométrique personnalisé</option><option value="custom" ${coverageMode === "custom" ? "selected" : ""}>Zone personnalisée</option></select></label>
                <label>Rayon personnalisé (km)<input name="serviceRadiusKm" type="number" min="0" max="500" value="${escapeHtml(profile.serviceRadiusKm || 0)}"></label>
                <label class="form-wide">Précision sur la zone<input name="serviceArea" maxlength="500" value="${escapeHtml(profile.serviceArea || "")}" placeholder="Ex. Lyon et 40 km autour"></label>
                <label class="form-wide">Présentation de l’entreprise<textarea name="description" rows="4" maxlength="1000" placeholder="Historique, domaines d’expertise et types d’interventions réalisés.">${escapeHtml(profile.description || "")}</textarea></label>
                <label>Logo (PNG, JPEG ou WebP, 2 Mo max)<input name="companyLogo" type="file" accept="image/png,image/jpeg,image/webp"></label>
                <label class="creator-switch">Disponible pour recevoir des missions partenaires<input name="acceptsPartnerMissions" type="checkbox" ${profile.acceptsPartnerMissions !== false ? "checked" : ""}><span>Si cette option est désactivée, l’entreprise reste dans l’annuaire avec le statut temporairement indisponible.</span></label>
            </div>
        </fieldset>
    `;
}

async function companyProfileFromForm(form) {
    const values = Object.fromEntries(new FormData(form));
    values.specialties = [...form.querySelectorAll('select[name="specialties"] option:checked')].map(option => option.value);
    values.acceptsPartnerMissions = form.elements.acceptsPartnerMissions?.checked !== false;
    const logo = form.elements.companyLogo?.files?.[0];
    if (logo) values.logoDataUrl = await fileAsDataUrl(logo);
    return values;
}

function fileAsDataUrl(file) {
    return new Promise((resolve, reject) => { const reader = new FileReader(); reader.addEventListener("load", () => resolve(String(reader.result || ""))); reader.addEventListener("error", () => reject(new Error("Le logo n’a pas pu être lu."))); reader.readAsDataURL(file); });
}

function renderSubscriptionFields(account) {
    const tier = ["basic", "basic_plus", "pro"].includes(account.subscriptionTier) ? account.subscriptionTier : "pro";
    const discountMode = account.subscriptionDiscountMode === "percentage" ? "percentage" : "fixed";
    return `
        <fieldset class="creator-subscription-fields"><legend>Abonnement et suivi commercial</legend>
            <div class="form-grid">
                <input name="subscriptionPlan" type="hidden" value="paid">
                <label>Offre Depann’Home Pro<select name="subscriptionTier"><option value="basic" ${tier === "basic" ? "selected" : ""}>Basic — 20 € / PC + 5 € / mobile</option><option value="basic_plus" ${tier === "basic_plus" ? "selected" : ""}>Basic+ — 35 € / PC + 8 € / mobile</option><option value="pro" ${tier === "pro" ? "selected" : ""}>Pro — 70 € / PC + 15 € / mobile</option></select></label>
                <label>Tarif mensuel calculé TTC<input name="monthlyPrice" type="text" value="${escapeHtml(centsToAmount(account.monthlyPriceCents))} €" readonly></label>
                <article class="subscription-tier-summary form-wide" data-tier-summary></article>
                <label>Libellé de la réduction<input name="subscriptionDiscountLabel" maxlength="160" value="${escapeHtml(account.subscriptionDiscountLabel || "")}" placeholder="Ex. Offre d’essai"></label>
                <label>Type de réduction<select name="subscriptionDiscountMode"><option value="fixed" ${discountMode === "fixed" ? "selected" : ""}>Montant TTC (€)</option><option value="percentage" ${discountMode === "percentage" ? "selected" : ""}>Pourcentage (%)</option></select></label>
                <label>Valeur de la réduction<input name="subscriptionDiscountValue" type="number" min="0" step="0.01" value="${escapeHtml(account.subscriptionDiscountValue || 0)}"></label>
                <label>Statut de l’abonnement<select name="subscriptionStatus">${["active", "trial", "past_due", "suspended", "cancelled"].map(status => `<option value="${status}" ${account.subscriptionStatus === status ? "selected" : ""}>${subscriptionStatusLabel(status)}</option>`).join("")}</select></label>
                <label>Prochaine échéance<input name="subscriptionRenewalDate" type="date" value="${escapeHtml(account.subscriptionRenewalDate || "")}"></label>
                <label>Référence de paiement / facture<input name="billingReference" maxlength="100" value="${escapeHtml(account.billingReference || "")}" placeholder="Ex. Virement juillet 2026"></label>
                <label class="form-wide">Note interne Créateur<textarea name="creatorNote" rows="3" maxlength="1000" placeholder="Suivi commercial, demande client, action à prévoir…">${escapeHtml(account.creatorNote || "")}</textarea></label>
            </div>
        </fieldset>
    `;
}

function renderOrganizationFields(organization = {}) {
    const interfaceType = organization.interfaceType || "standard";
    const organizationType = organization.organizationType || "troubleshooting_company";
    const licenseType = organization.licenseType || "depannhome_standard";
    return `
        <fieldset class="creator-subscription-fields"><legend>Organisation et interface</legend>
            <p class="muted">L’organisation conserve toujours le même compte, ses utilisateurs et toutes ses données. Modifier cette interface active simplement les modules correspondants.</p>
            <div class="form-grid">
                <label>Type d’interface<select name="organizationInterfaceType"><option value="partner" ${interfaceType === "partner" ? "selected" : ""}>Interface Partenaire — Pro requis</option><option value="standard" ${interfaceType === "standard" ? "selected" : ""}>Interface Standard — modules selon Basic / Basic+ / Pro</option><option value="group" ${interfaceType === "group" ? "selected" : ""}>Interface Groupe / Multi-entreprises — Pro requis</option></select></label>
                <label>Type d’organisation<select name="organizationType"><option value="troubleshooting_company" ${organizationType === "troubleshooting_company" ? "selected" : ""}>Entreprise de dépannage</option><option value="leak_detection_company" ${organizationType === "leak_detection_company" ? "selected" : ""}>Recherche de fuite</option><option value="locksmith" ${organizationType === "locksmith" ? "selected" : ""}>Serrurier</option><option value="plumber" ${organizationType === "plumber" ? "selected" : ""}>Plombier</option><option value="property_manager" ${organizationType === "property_manager" ? "selected" : ""}>Syndic</option><option value="real_estate_agency" ${organizationType === "real_estate_agency" ? "selected" : ""}>Agence immobilière</option><option value="insurance" ${organizationType === "insurance" ? "selected" : ""}>Assurance</option><option value="expert" ${organizationType === "expert" ? "selected" : ""}>Expert</option><option value="principal" ${organizationType === "principal" ? "selected" : ""}>Donneur d’ordre</option><option value="partner_platform" ${organizationType === "partner_platform" ? "selected" : ""}>Plateforme partenaire</option><option value="other" ${organizationType === "other" ? "selected" : ""}>Autre</option></select></label>
                <label>Licence<select name="organizationLicenseType"><option value="partner_portal" ${licenseType === "partner_portal" ? "selected" : ""}>Portail Partenaire</option><option value="depannhome_standard" ${licenseType === "depannhome_standard" ? "selected" : ""}>Depann’Home Pro Standard</option><option value="depannhome_group" ${licenseType === "depannhome_group" ? "selected" : ""}>Depann’Home Pro Groupe</option></select></label>
            </div>
        </fieldset>
    `;
}

function organizationFromForm(form) {
    return { interfaceType: form.elements.organizationInterfaceType.value, organizationType: form.elements.organizationType.value, licenseType: form.elements.organizationLicenseType.value };
}

function bindOrganizationInterface(form) {
    const interfaceType = form.elements.organizationInterfaceType;
    const licenseType = form.elements.organizationLicenseType;
    const subscriptionTier = form.elements.subscriptionTier;
    if (!interfaceType || !licenseType) return;
    const syncLicense = () => {
        const isPro = !subscriptionTier || subscriptionTier.value === "pro";
        [...interfaceType.options].forEach(option => { if (["partner", "group"].includes(option.value)) option.disabled = !isPro; });
        if (!isPro && interfaceType.value !== "standard") interfaceType.value = "standard";
        const expected = interfaceType.value === "partner" ? "partner_portal" : interfaceType.value === "group" ? "depannhome_group" : "depannhome_standard";
        licenseType.value = expected;
    };
    interfaceType.addEventListener("change", syncLicense);
    subscriptionTier?.addEventListener("change", syncLicense);
    syncLicense();
}

async function loadOrganizationHistory(accountId) {
    const container = document.querySelector("#creatorOrganizationHistory");
    if (!container) return;
    const result = await api(`/api/creator/accounts/${encodeURIComponent(accountId)}/organization-history`);
    if (!result.ok) { container.innerHTML = '<p class="muted">Historique indisponible.</p>'; return; }
    const history = result.data?.history || [];
    container.innerHTML = history.length ? `<div class="creator-network-list">${history.map(entry => `<article class="creator-network-company"><div><strong>${escapeHtml(entry.action === "created" ? "Organisation créée" : "Interface ou licence modifiée")}</strong><p>${escapeHtml(entry.nextValue?.interfaceType || "standard")} · ${escapeHtml(entry.nextValue?.licenseType || "depannhome_standard")}</p><small>${escapeHtml(entry.actorName || "Système")} · ${escapeHtml(formatDateTime(entry.createdAt))}</small></div></article>`).join("")}</div>` : '<p class="muted">Aucune modification d’interface ou de licence enregistrée.</p>';
}

function renderDocumentTemplatePolicyFields(account) {
    return `
        <fieldset class="creator-subscription-fields"><legend>Bases officielles des documents</legend>
            <div class="form-grid">
                ${renderTemplatePolicySelect("quoteTemplatePolicy", "Devis", account.quoteTemplatePolicy)}
                ${renderTemplatePolicySelect("quitusTemplatePolicy", "Quitus", account.quitusTemplatePolicy)}
                ${renderTemplatePolicySelect("reportTemplatePolicy", "Rapports", account.reportTemplatePolicy)}
                <p class="muted form-wide">Chaque base externe PDF ou Word reste privée à l’entreprise. Une fois activée, elle devient sa base officielle à télécharger pour la rédaction du document concerné.</p>
            </div>
        </fieldset>
    `;
}

function renderTemplatePolicySelect(name, label, value) {
    const policy = value || "company_choice";
    return `<label>Base de ${escapeHtml(label)}<select name="${name}"><option value="integrated_only" ${policy === "integrated_only" ? "selected" : ""}>Modèle intégré uniquement</option><option value="company_choice" ${policy === "company_choice" ? "selected" : ""}>L’entreprise choisit</option><option value="external_only" ${policy === "external_only" ? "selected" : ""}>Base externe obligatoire</option></select></label>`;
}

function bindSubscriptionTier(form) {
    const tier = form.elements.subscriptionTier;
    const price = form.elements.monthlyPrice;
    const billingEmail = form.elements.billingEmail;
    const discountMode = form.elements.subscriptionDiscountMode;
    const discountValue = form.elements.subscriptionDiscountValue;
    const pcSeats = form.elements.maxPcUsers;
    const mobileSeats = form.elements.maxTechnicians;
    const summary = form.querySelector("[data-tier-summary]");
    const tiers = {
        basic: { label: "Basic", pc: 20, mobile: 5, access: "Postes PC et Administrateur Mobile · bibliothèque mobile · achats sur tous les PC et l’Administrateur Mobile." },
        basic_plus: { label: "Basic+", pc: 35, mobile: 8, access: "Tous postes · planning · bibliothèque mobile · achats sur tous les PC et l’Administrateur Mobile." },
        pro: { label: "Pro", pc: 70, mobile: 15, access: "Tous postes · accès complet · bibliothèque mobile · achats sur tous les PC et l’Administrateur Mobile." }
    };
    const update = () => {
        const selected = tiers[tier.value] || tiers.basic;
        const pc = Math.max(1, Number(pcSeats.value) || 1);
        const mobile = Math.max(0, Number(mobileSeats.value) || 0);
        const total = pc * selected.pc + mobile * selected.mobile;
        price.value = `${total.toFixed(2)} €`;
        billingEmail.required = true;
        discountValue.max = discountMode.value === "percentage" ? "100" : "999999.99";
        summary.innerHTML = `<strong>${selected.label} · ${total.toFixed(2)} € TTC / mois</strong><span>${pc} poste(s) PC × ${selected.pc} € + ${mobile} poste(s) mobile × ${selected.mobile} €</span><small>${selected.access}</small>`;
    };
    tier.addEventListener("change", update);
    pcSeats.addEventListener("input", update);
    mobileSeats.addEventListener("input", update);
    discountMode.addEventListener("change", update);
    update();
}

async function renderSubscriptionBillingProfile() {
    const workspace = document.querySelector("#creatorWorkspace");
    workspace.innerHTML = '<p class="muted">Chargement des paramètres de facturation…</p>';
    const result = await api("/api/creator/subscription-billing-profile");
    if (!result.ok) return showFeedback(result.message || "Impossible de charger les paramètres de facturation.", true);
    const profile = result.data.profile || {};
    workspace.innerHTML = `
        <form id="creatorSubscriptionBillingProfile" class="creator-form">
            <div class="form-heading"><div><p class="eyebrow">Facturation des abonnements</p><h3>Coordonnées de l’émetteur</h3></div></div>
            <p class="muted">Ces coordonnées figurent sur les factures mensuelles envoyées automatiquement aux entreprises payantes. L’IBAN et le BIC ne sont accessibles qu’au Créateur et sont ajoutés uniquement aux PDF envoyés aux destinataires.</p>
            <div class="form-grid">
                <label>Raison sociale *<input name="companyName" maxlength="160" required value="${escapeHtml(profile.companyName || "")}"></label>
                <label>Forme juridique<input name="legalForm" maxlength="100" value="${escapeHtml(profile.legalForm || "")}"></label>
                <label>SIRET / immatriculation *<input name="registrationNumber" maxlength="100" required value="${escapeHtml(profile.registrationNumber || "")}"></label>
                <label>Régime de TVA<select name="vatRegime"><option value="standard" ${profile.vatRegime !== "franchise" ? "selected" : ""}>Assujetti à la TVA</option><option value="franchise" ${profile.vatRegime === "franchise" ? "selected" : ""}>Non assujetti / Franchise en base</option></select></label>
                <label>N° TVA intracommunautaire<input name="taxNumber" maxlength="100" value="${escapeHtml(profile.taxNumber || "")}" placeholder="Ex. FR12345678901"></label>
                <label class="form-wide">Adresse *<input name="address" maxlength="255" required value="${escapeHtml(profile.address || "")}"></label>
                <label>Code postal *<input name="postalCode" maxlength="20" required value="${escapeHtml(profile.postalCode || "")}"></label>
                <label>Ville *<input name="city" maxlength="100" required value="${escapeHtml(profile.city || "")}"></label>
                <label>Téléphone<input name="phone" maxlength="50" value="${escapeHtml(profile.phone || "")}"></label>
                <label>E-mail de facturation *<input name="email" type="email" maxlength="160" required value="${escapeHtml(profile.email || "")}"></label>
                <label>IBAN *<input name="bankIban" maxlength="34" required value="${escapeHtml(profile.bankIban || "")}" placeholder="FR76…"></label>
                <label>BIC *<input name="bankBic" maxlength="11" required value="${escapeHtml(profile.bankBic || "")}" placeholder="ABCDEFGHXXX"></label>
                <label>Taux de TVA (%)<input name="vatRate" type="number" min="0" max="100" step="0.01" value="${escapeHtml(profile.vatRate ?? 20)}"></label>
                <p class="muted form-wide" data-creator-vat-notice></p>
                <label class="form-wide">Conditions de règlement<input name="paymentTerms" maxlength="500" value="${escapeHtml(profile.paymentTerms || "")}" placeholder="Paiement à réception de facture par virement bancaire."></label>
                <label class="form-wide">Mention de bas de page<textarea name="footerNote" rows="3" maxlength="1000">${escapeHtml(profile.footerNote || "")}</textarea></label>
            </div>
            <div class="creator-form-actions"><button type="submit" class="secondary-button">Enregistrer les coordonnées</button><button type="button" class="secondary-button" id="creatorBackToAccounts">Retour aux entreprises</button></div>
        </form>
    `;
    const billingForm = workspace.querySelector("#creatorSubscriptionBillingProfile");
    const bindCreatorVatRegime = () => {
        const franchise = billingForm.elements.vatRegime.value === "franchise";
        billingForm.elements.vatRate.value = franchise ? "0" : (Number(billingForm.elements.vatRate.value) || 20);
        billingForm.elements.vatRate.readOnly = franchise;
        billingForm.elements.taxNumber.disabled = franchise;
        billingForm.querySelector("[data-creator-vat-notice]").innerHTML = franchise ? "<strong>TVA non applicable, art. 293 B du CGI</strong><br>Cette mention apparaîtra automatiquement sur les factures d’abonnement." : "Le taux de TVA et le numéro intracommunautaire seront repris sur les factures d’abonnement.";
    };
    billingForm.elements.vatRegime.addEventListener("change", bindCreatorVatRegime);
    bindCreatorVatRegime();
    workspace.querySelector("#creatorBackToAccounts").addEventListener("click", () => selectedAccountId ? renderAccountDetail(selectedAccountId) : workspace.replaceChildren());
    workspace.querySelector("#creatorSubscriptionBillingProfile").addEventListener("submit", async event => {
        event.preventDefault();
        const button = event.currentTarget.querySelector('button[type="submit"]');
        button.disabled = true;
        const save = await api("/api/creator/subscription-billing-profile", { method: "PUT", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
        button.disabled = false;
        if (!save.ok) return showFeedback(save.message || "Enregistrement impossible.", true);
        showFeedback("Coordonnées de facturation de la plateforme enregistrées.");
    });
}

async function renderSubscriptionInvoices() {
    const workspace = document.querySelector("#creatorWorkspace");
    workspace.innerHTML = '<p class="muted">Chargement des factures d’abonnement…</p>';
    const result = await api("/api/creator/subscription-invoices");
    if (!result.ok) return showFeedback(result.message || "Impossible de charger les factures d’abonnement.", true);
    const invoices = result.data.invoices || [];
    const processing = result.data.processing || {};
    const profileWarning = processing.profileComplete ? "" : `<p class="auth-message error">Profil de facturation incomplet : ${escapeHtml((processing.missingProfileFields || []).join(", ") || "coordonnées manquantes")}.</p>`;
    workspace.innerHTML = `
        <section class="creator-form creator-subscription-invoices-panel">
            <div class="form-heading"><div><p class="eyebrow">Facturation plateforme</p><h3>Factures d’abonnement envoyées</h3></div><span class="creator-state">${invoices.length} facture${invoices.length > 1 ? "s" : ""}</span></div>
            <p class="muted">Chaque PDF reprend les informations légales, bancaires et tarifaires enregistrées au moment de son émission.</p>
            <div class="creator-subscription-processing"><strong>${Number(processing.dueAccounts || 0)} abonnement(s) arrivé(s) à échéance</strong><span>${Number(processing.pending || 0)} en attente · ${Number(processing.failed || 0)} en échec · ${Number(processing.sending || 0)} en cours</span></div>
            ${profileWarning}
            <p class="auth-message" id="creatorSubscriptionProcessingFeedback" aria-live="polite"></p>
            <div class="creator-subscription-invoice-list">${invoices.length ? invoices.map(renderSubscriptionInvoice).join("") : '<p class="muted">Aucune facture d’abonnement n’a encore été créée.</p>'}</div>
            <div class="creator-form-actions"><button type="button" class="primary-button" id="creatorSubscriptionInvoicesProcess" ${processing.profileComplete ? "" : "disabled"}>Créer et envoyer maintenant</button><button type="button" class="secondary-button" id="creatorSubscriptionInvoicesBack">Retour aux entreprises</button></div>
        </section>
    `;
    workspace.querySelector("#creatorSubscriptionInvoicesProcess").addEventListener("click", async event => {
        const button = event.currentTarget;
        const feedback = workspace.querySelector("#creatorSubscriptionProcessingFeedback");
        button.disabled = true;
        feedback.classList.remove("error");
        feedback.textContent = "Création et envoi des factures en cours…";
        const process = await api("/api/creator/subscription-invoices/process", { method: "POST", body: "{}", timeoutMs: 60_000 });
        if (!process.ok) {
            button.disabled = false;
            feedback.classList.add("error");
            feedback.textContent = process.message || "Le traitement des factures a échoué.";
            return;
        }
        showFeedback(process.message || "Traitement des factures terminé.", Boolean(process.data?.failed));
        await renderSubscriptionInvoices();
    });
    workspace.querySelectorAll("[data-subscription-payment-form]").forEach(form => form.addEventListener("submit", async event => {
        event.preventDefault();
        const invoiceNumber = form.dataset.invoiceNumber || "cette facture";
        if (!confirm(`Confirmer la réception du paiement de ${invoiceNumber} ? La facture acquittée sera envoyée automatiquement à l’entreprise.`)) return;
        const button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        const values = Object.fromEntries(new FormData(form));
        const result = await api(`/api/creator/subscription-invoices/${encodeURIComponent(form.dataset.subscriptionPaymentForm)}/payment`, { method: "POST", body: JSON.stringify(values), timeoutMs: 60_000 });
        if (!result.ok) { button.disabled = false; return showFeedback(result.message || "Impossible d’enregistrer le paiement.", true); }
        showFeedback(result.message || "Paiement enregistré.", !result.data?.receiptSent);
        await renderSubscriptionInvoices();
    }));
    workspace.querySelectorAll("[data-resend-paid-invoice]").forEach(button => button.addEventListener("click", async () => {
        button.disabled = true;
        const result = await api(`/api/creator/subscription-invoices/${encodeURIComponent(button.dataset.resendPaidInvoice)}/payment-receipt/send`, { method: "POST", body: "{}", timeoutMs: 60_000 });
        if (!result.ok) { button.disabled = false; return showFeedback(result.message || "Impossible de renvoyer la facture acquittée.", true); }
        showFeedback(result.message || "Facture acquittée renvoyée.");
        await renderSubscriptionInvoices();
    }));
    workspace.querySelector("#creatorSubscriptionInvoicesBack").addEventListener("click", () => selectedAccountId ? renderAccountDetail(selectedAccountId) : workspace.replaceChildren());
}

function renderSubscriptionInvoice(invoice) {
    const status = subscriptionInvoiceStatus(invoice.status);
    const sentAt = invoice.sentAt ? `Envoyée le ${formatDateTime(invoice.sentAt)}` : invoice.status === "failed" ? "Envoi en échec" : "En attente d’envoi";
    const error = invoice.status === "failed" && invoice.lastError ? `<p class="auth-message error">${escapeHtml(invoice.lastError)}</p>` : "";
    const discount = Number(invoice.baseAmountCents || 0) > Number(invoice.amountCents || 0)
        ? `<small>${escapeHtml(invoice.financialData?.discountLabel || "Remise commerciale")} : −${formatCurrency(Number(invoice.baseAmountCents) - Number(invoice.amountCents))}</small>` : "";
    const paid = invoice.paymentStatus === "paid";
    const receiptStatus = paid ? paidReceiptStatus(invoice.receiptDeliveryStatus) : null;
    const paymentDetails = paid ? `<small class="creator-payment-confirmed">Paiement reçu le ${formatDate(invoice.paidDate)}${invoice.paymentReference ? ` · Réf. ${escapeHtml(invoice.paymentReference)}` : ""}</small><small>Facture acquittée : ${escapeHtml(receiptStatus.label)}${invoice.receiptSentAt ? ` le ${escapeHtml(formatDateTime(invoice.receiptSentAt))}` : ""}</small>${invoice.receiptDeliveryStatus === "failed" && invoice.receiptLastError ? `<p class="auth-message error">${escapeHtml(invoice.receiptLastError)}</p>` : ""}` : "";
    const paymentAction = !paid && invoice.status === "sent" ? `<form class="creator-subscription-payment-form" data-subscription-payment-form="${escapeHtml(invoice.id)}" data-invoice-number="${escapeHtml(invoice.invoiceNumber)}"><label>Date du règlement<input name="paidDate" type="date" max="${new Date().toISOString().slice(0, 10)}" value="${new Date().toISOString().slice(0, 10)}" required></label><label>Référence du paiement (facultative)<input name="paymentReference" maxlength="160" placeholder="N° de virement, transaction ou chèque"></label><button type="submit" class="primary-button">Accuser réception du paiement</button></form>` : paid && invoice.receiptDeliveryStatus === "failed" ? `<button type="button" class="secondary-button" data-resend-paid-invoice="${escapeHtml(invoice.id)}">Renvoyer la facture acquittée</button>` : !paid ? '<small class="muted">L’accusé de paiement sera disponible après l’envoi initial.</small>' : "";
    return `
        <article class="creator-subscription-invoice">
            <div><p class="eyebrow">${escapeHtml(invoice.subscriptionLabel || "Abonnement Depann’Home Pro")}</p><h4>${escapeHtml(invoice.invoiceNumber)}</h4><p>${escapeHtml(invoice.companyName || invoice.recipientName)} · ${escapeHtml(invoice.recipientEmail || "E-mail non renseigné")}</p></div>
            <div class="creator-subscription-invoice-details"><span class="creator-subscription-badge ${escapeHtml(invoice.status || "pending")}">${status}</span>${paid ? '<span class="creator-subscription-badge paid">Réglée</span>' : ""}<strong>${formatCurrency(invoice.amountCents)}</strong>${discount}<small>Émise le ${formatDate(invoice.issueDate)} · Échéance ${formatDate(invoice.dueDate)}</small><small>${escapeHtml(sentAt)}</small>${paymentDetails}${error}</div>
            <div class="creator-subscription-invoice-actions"><a class="secondary-button" href="/api/creator/subscription-invoices/${encodeURIComponent(invoice.id)}/pdf" download>Télécharger le PDF</a>${paymentAction}</div>
        </article>
    `;
}

function subscriptionInvoiceStatus(status) {
    return ({ sent: "Envoyée", pending: "À envoyer", sending: "Envoi en cours", failed: "Échec d’envoi" })[status] || "À envoyer";
}

function paidReceiptStatus(status) {
    return ({ pending: { label: "En attente d’envoi" }, sending: { label: "Envoi en cours" }, sent: { label: "Envoyée" }, failed: { label: "Échec d’envoi" } })[status] || { label: "Non envoyée" };
}

function subscriptionNetAmountCents(account) {
    const amount = Math.max(0, Number(account.monthlyPriceCents || 0));
    const value = Math.max(0, Number(account.subscriptionDiscountValue || 0));
    const discount = account.subscriptionDiscountMode === "percentage" ? Math.round(amount * Math.min(100, value) / 100) : Math.round(value * 100);
    return Math.max(0, amount - discount);
}

function formatDate(value) {
    if (!value) return "Non renseignée";
    return new Intl.DateTimeFormat("fr-FR").format(new Date(`${value}T12:00:00`));
}

function formatDateTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "date inconnue" : new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

async function renderCreatorSecurity() {
    const workspace = document.querySelector("#creatorWorkspace");
    workspace.innerHTML = '<p class="muted">Chargement des paramètres de sécurité…</p>';
    const result = await api("/api/auth/creator-2fa");
    if (!result.ok) return showFeedback(result.message || "Impossible de charger les paramètres de sécurité.", true);
    if (result.data?.enabled) {
        workspace.innerHTML = `
            <section class="creator-form creator-security-panel">
                <div class="form-heading"><div><p class="eyebrow">Sécurité du compte Créateur</p><h3>Google Authenticator est activé</h3></div><span class="creator-state">Protégé</span></div>
                <p class="muted">À chaque nouvelle connexion, votre mot de passe doit être complété par le code à 6 chiffres de Google Authenticator.</p>
                <form id="creatorTotpDisableForm" class="creator-security-form"><label>Code actuel Google Authenticator<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required placeholder="000000"></label><p class="auth-message" aria-live="polite"></p><div class="creator-form-actions"><button type="submit" class="secondary-button danger-button">Désactiver la double authentification</button><button type="button" class="secondary-button" id="creatorSecurityBack">Retour aux entreprises</button></div></form>
            </section>
        `;
        workspace.querySelector("#creatorSecurityBack").addEventListener("click", () => selectedAccountId ? renderAccountDetail(selectedAccountId) : workspace.replaceChildren());
        workspace.querySelector("#creatorTotpDisableForm").addEventListener("submit", async event => {
            event.preventDefault();
            const form = event.currentTarget;
            const feedback = form.querySelector(".auth-message");
            const button = form.querySelector('button[type="submit"]');
            button.disabled = true;
            const disable = await api("/api/auth/creator-2fa", { method: "DELETE", body: JSON.stringify({ code: new FormData(form).get("code") }) });
            button.disabled = false;
            if (!disable.ok) { feedback.textContent = disable.message || "Désactivation impossible."; feedback.classList.add("error"); return; }
            showFeedback("La double authentification est désactivée.");
            renderCreatorSecurity();
        });
        return;
    }
    workspace.innerHTML = `
        <section class="creator-form creator-security-panel">
            <div class="form-heading"><div><p class="eyebrow">Sécurité du compte Créateur</p><h3>Protéger avec Google Authenticator</h3></div><span class="creator-state suspended">Non activé</span></div>
            <p class="muted">Ajoutez une seconde vérification à votre compte Créateur. Le code temporaire sera exigé après le mot de passe à chaque connexion.</p>
            <div class="creator-form-actions"><button type="button" class="secondary-button" id="creatorTotpStart">Configurer Google Authenticator</button><button type="button" class="secondary-button" id="creatorSecurityBack">Retour aux entreprises</button></div>
        </section>
    `;
    workspace.querySelector("#creatorSecurityBack").addEventListener("click", () => selectedAccountId ? renderAccountDetail(selectedAccountId) : workspace.replaceChildren());
    workspace.querySelector("#creatorTotpStart").addEventListener("click", async event => {
        const button = event.currentTarget;
        button.disabled = true;
        const setup = await api("/api/auth/creator-2fa/setup", { method: "POST", body: "{}" });
        button.disabled = false;
        if (!setup.ok) return showFeedback(setup.message || "Configuration impossible.", true);
        renderCreatorTotpSetup(setup.data);
    });
}

function renderCreatorTotpSetup(setup) {
    const workspace = document.querySelector("#creatorWorkspace");
    workspace.innerHTML = `
        <section class="creator-form creator-security-panel">
            <div class="form-heading"><div><p class="eyebrow">Sécurité du compte Créateur</p><h3>Associer Google Authenticator</h3></div></div>
            <ol class="creator-totp-steps"><li>Ouvrez Google Authenticator sur votre téléphone.</li><li>Appuyez sur <strong>+</strong>, puis scannez ce QR code.</li><li>Saisissez ci-dessous le code à 6 chiffres affiché par l’application.</li></ol>
            <img class="creator-totp-qr" src="${escapeHtml(setup.qrCodeDataUrl || "")}" alt="QR code Google Authenticator pour Depann’Home Pro">
            <p class="muted">Si le scan est impossible, saisissez cette clé dans Google Authenticator : <code class="creator-totp-secret">${escapeHtml(setup.manualSecret || "")}</code></p>
            <form id="creatorTotpConfirmForm" class="creator-security-form"><label>Code Google Authenticator<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus placeholder="000000"></label><p class="auth-message" aria-live="polite"></p><div class="creator-form-actions"><button type="submit" class="secondary-button">Activer la double authentification</button><button type="button" class="secondary-button" id="creatorTotpCancel">Annuler</button></div></form>
        </section>
    `;
    workspace.querySelector("#creatorTotpCancel").addEventListener("click", renderCreatorSecurity);
    workspace.querySelector("#creatorTotpConfirmForm").addEventListener("submit", async event => {
        event.preventDefault();
        const form = event.currentTarget;
        const feedback = form.querySelector(".auth-message");
        const button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        const confirmation = await api("/api/auth/creator-2fa/confirm", { method: "POST", body: JSON.stringify({ code: new FormData(form).get("code") }) });
        button.disabled = false;
        if (!confirmation.ok) { feedback.textContent = confirmation.message || "Activation impossible."; feedback.classList.add("error"); return; }
        showFeedback(confirmation.message || "Google Authenticator est activé.");
        renderCreatorSecurity();
    });
}

function centsToAmount(value) {
    return (Number(value || 0) / 100).toFixed(2);
}

function formatCurrency(cents) {
    return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(Number(cents || 0) / 100);
}

function subscriptionPlanLabel(account) {
    return account.subscriptionPlan === "paid"
        ? `${account.subscriptionLabel || "Payant"} · ${formatCurrency(account.monthlyPriceCents)}/mois`
        : account.subscriptionLabel || "Gratuit";
}

function subscriptionStatusLabel(status) {
    return ({ active: "À jour", trial: "Période d’essai", past_due: "Paiement à suivre", suspended: "Suspendu", cancelled: "Résilié" })[status] || "À jour";
}

async function loadMembers(accountId) {
    const result = await Promise.race([
        api(`/api/creator/accounts/${encodeURIComponent(accountId)}/members`),
        new Promise(resolve => window.setTimeout(() => resolve({ ok: false, message: "Le chargement des accès a expiré. Réessayez dans quelques instants." }), 12_000))
    ]);
    const container = document.querySelector("#creatorMembers");
    if (!container) return;
    if (!result.ok) {
        container.replaceChildren();
        const message = document.createElement("p");
        message.className = "auth-message error";
        message.textContent = result.message || "Impossible de charger les accès.";
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "secondary-button";
        retry.textContent = "Réessayer";
        retry.addEventListener("click", () => loadMembers(accountId));
        container.append(message, retry);
        return;
    }
    const members = result.data.members || [];
    const accountArchived = Boolean(accounts.find(account => String(account.id) === String(accountId))?.isArchived);
    container.innerHTML = members.length ? `<div class="creator-members">${members.map(member => `
        <article class="creator-member">
            <div><strong>${escapeHtml(member.fullName || member.username)}</strong><span>${escapeHtml(creatorMemberRoleLabel(member.role))} · ${escapeHtml(member.username)}${member.phone ? ` · ${escapeHtml(member.phone)}` : ""}${member.email ? ` · ${escapeHtml(member.email)}` : ""}</span></div>
            <div class="creator-member-actions"><span class="creator-state${member.isActive ? "" : " suspended"}">${member.isActive ? "Actif" : "Désactivé"}</span>${accountArchived ? "" : `<button type="button" class="secondary-button" data-edit-member="${escapeHtml(member.id)}">Gérer</button>`}</div>
        </article>
    `).join("")}</div>` : '<p class="muted">Aucun accès pour le moment.</p>';
    container.querySelectorAll("[data-edit-member]").forEach(button => button.addEventListener("click", () => {
        const member = members.find(item => String(item.id) === button.dataset.editMember);
        if (member) renderMemberForm(accounts.find(item => String(item.id) === String(accountId)), member);
    }));
}

function renderMemberForm(account, member = null, initialRole = "admin") {
    const editing = Boolean(member);
    const primary = editing && String(member.id) === String(account.id);
    const role = member?.role || initialRole;
    const workspace = document.querySelector("#creatorWorkspace");
    workspace.innerHTML = `
        <form id="creatorMemberForm" class="creator-form">
            <div class="form-heading"><div><p class="eyebrow">${editing ? "Modifier l’accès" : "Nouvel accès"}</p><h3>${editing ? escapeHtml(member.fullName || member.username) : `Créer : ${escapeHtml(creatorMemberRoleLabel(role))}`}</h3></div></div>
            <div class="form-grid">
                ${editing ? `<label>Type d’accès<input value="${escapeHtml(creatorMemberRoleLabel(member.role))}" disabled></label>` : `<label>Type d’accès<select name="role">${creatorMemberRoleOptions(account.subscriptionTier, role)}</select></label>`}
                <label>Nom et prénom<input name="fullName" maxlength="100" required value="${escapeHtml(member?.fullName || "")}"></label>
                <label data-member-phone>Téléphone<input name="phone" type="tel" maxlength="30" value="${escapeHtml(member?.phone || "")}" placeholder="06 12 34 56 78"></label>
                <label data-member-email>E-mail professionnel<input name="email" type="email" maxlength="160" value="${escapeHtml(member?.email || "")}" placeholder="technicien@entreprise.fr"></label>
                <label data-member-username>Identifiant<input name="username" minlength="3" maxlength="32" required value="${escapeHtml(member?.username || "")}" placeholder="minuscules, chiffres, . _ -"></label>
                <label data-member-password>${editing ? "Nouveau mot de passe (facultatif)" : "Mot de passe initial"}<span class="password-input"><input name="password" type="password" minlength="12" ${editing ? "" : "required"} autocomplete="new-password"><button type="button" class="secondary-button" data-password-visibility aria-label="Afficher le mot de passe" aria-pressed="false">Afficher</button></span></label>
                ${primary ? "" : `<label class="creator-switch">Accès actif<input name="isActive" type="checkbox" ${member?.isActive !== false ? "checked" : ""}><span>Autoriser la connexion</span></label>`}
            </div>
            <p id="creatorMemberRoleHint" class="muted"></p>
            <div class="creator-form-actions"><button type="submit" class="secondary-button">${editing ? "Enregistrer l’accès" : "Créer l’accès"}</button><button type="button" class="secondary-button" id="creatorCancelMember">Retour à l’entreprise</button>${editing && !primary ? '<button type="button" class="secondary-button danger-button" id="creatorDeleteMember">Supprimer l’accès</button>' : ""}</div>
        </form>
    `;
    bindPasswordVisibilityToggle(workspace);
    bindMemberRoleForm(workspace.querySelector("#creatorMemberForm"), editing, role);
    workspace.querySelector("#creatorCancelMember").addEventListener("click", () => renderAccountDetail(account.id));
    workspace.querySelector("#creatorMemberForm").addEventListener("submit", async event => {
        event.preventDefault();
        const button = event.currentTarget.querySelector('button[type="submit"]');
        button.disabled = true;
        const values = Object.fromEntries(new FormData(event.currentTarget));
        if (!primary) values.isActive = event.currentTarget.elements.isActive.checked;
        const result = editing
            ? await api(`/api/creator/accounts/${encodeURIComponent(account.id)}/members/${encodeURIComponent(member.id)}`, { method: "PATCH", body: JSON.stringify(values) })
            : await api(`/api/creator/accounts/${encodeURIComponent(account.id)}/members`, { method: "POST", body: JSON.stringify(values) });
        button.disabled = false;
        if (!result.ok) return showFeedback(result.message || "Enregistrement impossible.", true);
        showFeedback(editing ? "Accès mis à jour." : values.role === "technician" ? "Technicien créé. Il doit se connecter une première fois pour afficher sa demande de validation dans Équipe." : "Accès créé.");
        await loadAccounts(account.id);
    });
    workspace.querySelector("#creatorDeleteMember")?.addEventListener("click", async () => {
        if (!confirm(`Supprimer définitivement l’accès de ${member.fullName || member.username} ?`)) return;
        const result = await api(`/api/creator/accounts/${encodeURIComponent(account.id)}/members/${encodeURIComponent(member.id)}`, { method: "DELETE" });
        if (!result.ok) return showFeedback(result.message || "Suppression impossible.", true);
        showFeedback("Accès supprimé.");
        await loadAccounts(account.id);
    });
}

function bindMemberRoleForm(form, editing, initialRole) {
    const roleInput = form.elements.role;
    const phone = form.elements.phone;
    const email = form.elements.email;
    const hint = form.querySelector("#creatorMemberRoleHint");
    const update = () => {
        const isMobile = ["mobile_admin", "team_lead", "technician"].includes(roleInput?.value || initialRole);
        phone.required = isMobile;
        email.required = isMobile;
        form.querySelector("[data-member-phone]").firstChild.textContent = isMobile ? "Téléphone du poste mobile *" : "Téléphone";
        form.querySelector("[data-member-email]").firstChild.textContent = isMobile ? "E-mail professionnel du poste mobile *" : "E-mail professionnel";
        hint.textContent = isMobile
            ? "Le téléphone, l’e-mail professionnel, l’identifiant et le mot de passe sont nécessaires pour créer un poste mobile."
            : "L’identifiant et le mot de passe permettent la connexion au poste PC.";
    };
    roleInput?.addEventListener("change", update);
    update();
}

function creatorMemberRoleOptions(tier, selectedRole) {
    const roles = tier === "basic"
        ? ["admin", "pc_standard", "accountant", "mobile_admin"]
        : ["admin", "pc_standard", "accountant", "mobile_admin", "team_lead", "technician"];
    return roles.map(role => `<option value="${role}" ${role === selectedRole ? "selected" : ""}>${escapeHtml(creatorMemberRoleLabel(role))}</option>`).join("");
}

function creatorMemberRoleLabel(role) {
    return ({ admin: "Administrateur (PC)", pc_standard: "Poste PC standard", accountant: "Comptable", mobile_admin: "Administrateur Mobile", team_lead: "Chef d’équipe mobile", technician: "Technicien mobile" })[role] || "Accès";
}

function showFeedback(message, isError = false) {
    const feedback = document.querySelector("#creatorFeedback");
    if (!feedback) return;
    feedback.textContent = message;
    feedback.classList.toggle("error", isError);
}

function bindPasswordVisibilityToggle(container) {
    container.querySelectorAll("[data-password-visibility]").forEach(button => button.addEventListener("click", () => {
        const input = button.parentElement.querySelector("input");
        const visible = input.type === "password";
        input.type = visible ? "text" : "password";
        button.textContent = visible ? "Masquer" : "Afficher";
        button.setAttribute("aria-label", visible ? "Masquer le mot de passe" : "Afficher le mot de passe");
        button.setAttribute("aria-pressed", String(visible));
        input.focus();
    }));
}

async function api(url, options = {}) {
    const { timeoutMs = 12_000, ...fetchOptions } = options;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { credentials: "same-origin", headers: { "Content-Type": "application/json", ...(fetchOptions.headers || {}) }, ...fetchOptions, signal: controller.signal });
        const data = response.status === 204 ? null : await response.json().catch(() => null);
        return { ok: response.ok, data, message: data?.message };
    } catch (error) {
        if (error.name === "AbortError") return { ok: false, message: "Le chargement des accès a expiré. Réessayez dans quelques instants." };
        return { ok: false, message: "Impossible de joindre le serveur." };
    } finally {
        window.clearTimeout(timeout);
    }
}
