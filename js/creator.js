import { ROUTES } from "./config.js?v=105";
import { clearSearch, getContainer, setPage } from "./ui.js?v=44";
import { escapeHtml } from "./utils.js?v=44";
import { renderCreatorConnectors } from "./connectors.js?v=1";

let accounts = [];
let selectedAccountId = "";

export async function renderCreatorConsole() {
    clearSearch();
    setPage("Console Créateur", ROUTES.creator, "detail");
    const container = getContainer();
    container.innerHTML = `
        <section class="creator-console">
            <header class="creator-heading">
                <div><p class="eyebrow">Administration plateforme</p><h2>Console Créateur</h2></div>
                <div class="creator-form-actions"><button type="button" class="secondary-button auth-outline-button" id="creatorPartnerRequests">Demandes de partenariat</button><button type="button" class="secondary-button auth-outline-button" id="creatorSecurity">Sécurité du compte</button><button type="button" class="secondary-button auth-outline-button" id="creatorSubscriptionInvoices">Factures abonnements</button><button type="button" class="secondary-button auth-outline-button" id="creatorBillingProfile">Facturation plateforme</button><button type="button" class="secondary-button auth-outline-button" id="creatorExternalProviders">Prestataires externes</button><button type="button" class="secondary-button" id="creatorNewAccount">+ Nouvelle entreprise</button></div>
            </header>
            <p id="creatorFeedback" class="auth-message" aria-live="polite"></p>
            <section class="creator-subscription-summary" id="creatorSubscriptionSummary" aria-label="Synthèse des abonnements"></section>
            <div class="creator-layout">
                <aside class="creator-accounts" id="creatorAccounts"><p class="muted">Chargement des entreprises…</p></aside>
                <section class="creator-workspace" id="creatorWorkspace"><p class="muted">Sélectionnez une entreprise ou créez-en une.</p></section>
            </div>
        </section>
    `;
    const networkButton = document.createElement("button");
    networkButton.type = "button";
    networkButton.className = "secondary-button auth-outline-button";
    networkButton.textContent = "Réseau DepanHomePro";
    document.querySelector(".creator-heading .creator-form-actions").prepend(networkButton);
    container.querySelector("#creatorNewAccount").addEventListener("click", () => renderAccountForm());
    networkButton.addEventListener("click", renderNetworkDirectory);
    container.querySelector("#creatorPartnerRequests").addEventListener("click", renderPartnerRequests);
    container.querySelector("#creatorBillingProfile").addEventListener("click", renderSubscriptionBillingProfile);
    container.querySelector("#creatorSecurity").addEventListener("click", renderCreatorSecurity);
    container.querySelector("#creatorSubscriptionInvoices").addEventListener("click", renderSubscriptionInvoices);
    container.querySelector("#creatorExternalProviders").addEventListener("click", renderCreatorConnectors);
    await loadAccounts();
}

async function renderNetworkDirectory() {
    const workspace = document.querySelector("#creatorWorkspace");
    workspace.innerHTML = '<p class="muted">Chargement du Réseau DepanHomePro…</p>';
    const result = await api("/api/creator/network-directory");
    if (!result.ok) return showFeedback(result.message || "Impossible de charger le réseau.", true);
    const companies = result.data.companies || []; const stats = result.data.statistics || {};
    workspace.innerHTML = `<section class="creator-form creator-network-directory"><div class="form-heading"><div><p class="eyebrow">Répertoire officiel</p><h3>Réseau DepanHomePro</h3></div></div><div class="creator-network-stats"><article><span>Inscrites</span><strong>${stats.registeredCompanies || 0}</strong></article><article><span>Visibles</span><strong>${stats.visibleCompanies || 0}</strong></article><article><span>Suspensions</span><strong>${stats.suspendedCompanies || 0}</strong></article><article><span>Connexions actives</span><strong>${stats.connectedPairs || 0}</strong></article></div><form data-network-filter class="group-filter"><input name="q" type="search" placeholder="Entreprise, ville ou code postal"><button class="secondary-button">Rechercher</button></form><div class="creator-network-list">${companies.length ? companies.map(networkRow).join("") : '<p class="muted">Aucune entreprise inscrite.</p>'}</div><div class="creator-form-actions"><button type="button" class="secondary-button" data-network-back>Retour aux entreprises</button></div></section>`;
    workspace.querySelector("[data-network-back]").addEventListener("click", () => selectedAccountId ? renderAccountDetail(selectedAccountId) : workspace.replaceChildren());
    workspace.querySelector("[data-network-filter]").addEventListener("submit", async event => { event.preventDefault(); const query = new URLSearchParams(new FormData(event.currentTarget)); const refreshed = await api(`/api/creator/network-directory?${query}`); if (!refreshed.ok) return showFeedback(refreshed.message || "Recherche impossible.", true); const list = workspace.querySelector(".creator-network-list"); list.innerHTML = (refreshed.data.companies || []).map(networkRow).join("") || '<p class="muted">Aucune entreprise trouvée.</p>'; bindNetworkActions(list); });
    bindNetworkActions(workspace);
}

function networkRow(company) { return `<article class="creator-network-company"><div><strong>${escapeHtml(company.companyName || "Entreprise")}</strong><p>${escapeHtml([company.city, company.postalCode].filter(Boolean).join(" · ") || "Coordonnées non renseignées")}</p><small>${company.isListed ? "Visible" : "Interne"}${company.creatorSuspended ? " · Suspendue" : ""}${company.acceptsPartnerMissions ? " · Missions acceptées" : ""}</small></div><div class="creator-form-actions"><button type="button" class="secondary-button" data-network-manage="${escapeHtml(company.id)}">Gérer</button><button type="button" class="secondary-button danger-button" data-network-delete="${escapeHtml(company.id)}">Retirer du réseau</button></div></article>`; }

function bindNetworkActions(container) { container.querySelectorAll("[data-network-manage]").forEach(button => button.addEventListener("click", async () => { const company = (await api("/api/creator/network-directory")).data?.companies?.find(item => String(item.id) === button.dataset.networkManage); if (company) renderNetworkCompanyForm(company); })); container.querySelectorAll("[data-network-delete]").forEach(button => button.addEventListener("click", async () => { if (!confirm("Retirer cette fiche du Réseau DepanHomePro ? Le compte et les partenariats existants restent inchangés.")) return; const deleted = await api(`/api/creator/network-directory/${encodeURIComponent(button.dataset.networkDelete)}`, { method: "DELETE" }); if (!deleted.ok) return showFeedback(deleted.message || "Suppression impossible.", true); showFeedback("Fiche retirée du réseau."); renderNetworkDirectory(); })); }

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
    renderSubscriptionSummary();
    renderAccountList();
    if (selectedAccountId) await renderAccountDetail(selectedAccountId);
    else document.querySelector("#creatorWorkspace").innerHTML = '<p class="muted">Aucune entreprise créée pour le moment.</p>';
}

function renderSubscriptionSummary() {
    const summary = document.querySelector("#creatorSubscriptionSummary");
    if (!summary) return;
    const paidAccounts = accounts.filter(account => account.subscriptionPlan === "paid");
    const activePaidAccounts = paidAccounts.filter(account => ["active", "trial", "past_due"].includes(account.subscriptionStatus));
    const monthlyRevenue = activePaidAccounts.reduce((total, account) => total + Number(account.monthlyPriceCents || 0), 0);
    const pastDue = accounts.filter(account => account.subscriptionStatus === "past_due").length;
    summary.innerHTML = `
        <article><span>Entreprises</span><strong>${accounts.length}</strong></article>
        <article><span>Abonnements payants</span><strong>${paidAccounts.length}</strong></article>
        <article><span>Mensuel estimé</span><strong>${formatCurrency(monthlyRevenue)}</strong></article>
        <article class="${pastDue ? "attention" : ""}"><span>Paiements à suivre</span><strong>${pastDue}</strong></article>
    `;
}

function renderAccountList() {
    const list = document.querySelector("#creatorAccounts");
    list.innerHTML = accounts.length ? accounts.map(account => `
        <button type="button" class="creator-account${String(account.id) === selectedAccountId ? " selected" : ""}" data-account-id="${escapeHtml(account.id)}">
            <strong>${escapeHtml(account.companyName || account.ownerFullName || account.ownerUsername)}</strong>
            <span>${escapeHtml(account.ownerUsername)} · ${account.isActive ? "Active" : "Suspendue"}</span>
            <em class="creator-subscription-badge ${escapeHtml(account.subscriptionStatus || "active")}">${escapeHtml(subscriptionPlanLabel(account))} · ${escapeHtml(subscriptionStatusLabel(account.subscriptionStatus))}</em>
            <small>${account.activePcUsers}/${account.maxPcUsers} PC · ${account.activeTechnicians}/${account.maxTechnicians} techniciens</small>
        </button>
    `).join("") : '<p class="muted">Aucune entreprise.</p>';
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
    const workspace = document.querySelector("#creatorWorkspace");
    workspace.innerHTML = `
        <form id="creatorAccountForm" class="creator-form">
            <div class="form-heading"><div><p class="eyebrow">Entreprise</p><h3>${escapeHtml(account.companyName)}</h3></div><span class="creator-state${account.isActive ? "" : " suspended"}">${account.isActive ? "Active" : "Suspendue"}</span></div>
            <div class="form-grid">
                <label>Nom de l’entreprise<input name="companyName" maxlength="160" required value="${escapeHtml(account.companyName)}"></label>
                <label>Responsable principal<input name="fullName" maxlength="100" required value="${escapeHtml(account.ownerFullName)}"></label>
                <label>Téléphone responsable<input name="phone" maxlength="30" value="${escapeHtml(account.ownerPhone)}"></label>
                <label>E-mail de facturation<input name="billingEmail" type="email" maxlength="160" value="${escapeHtml(account.billingEmail || "")}" placeholder="comptabilite@entreprise.fr"></label>
                <label>Postes PC autorisés<input name="maxPcUsers" type="number" min="1" max="100" required value="${escapeHtml(account.maxPcUsers)}"></label>
                <label>Techniciens autorisés<input name="maxTechnicians" type="number" min="0" max="500" required value="${escapeHtml(account.maxTechnicians)}"></label>
                <label class="creator-switch">Entreprise active<input name="isActive" type="checkbox" ${account.isActive ? "checked" : ""} ${isOwnCreatorAccount ? "disabled" : ""}><span>${isOwnCreatorAccount ? "Le compte Créateur reste actif" : "Les membres peuvent se connecter"}</span></label>
            </div>
            ${renderSubscriptionFields(account)}
            ${renderQuoteTemplatePolicyFields(account)}
            <div class="creator-form-actions"><button type="submit" class="secondary-button">Enregistrer l’entreprise</button>${isOwnCreatorAccount ? "" : '<button type="button" class="secondary-button danger-button" id="creatorDeleteAccount">Supprimer l’entreprise</button>'}</div>
        </form>
        <section class="creator-members-section"><div class="form-heading"><div><p class="eyebrow">Accès</p><h3>Postes PC et techniciens</h3></div><div class="creator-form-actions"><button type="button" class="secondary-button auth-outline-button" id="creatorNewPcMember">+ Poste PC</button><button type="button" class="secondary-button" id="creatorNewTechnician">+ Technicien</button></div></div><div id="creatorMembers"><p class="muted">Chargement des accès…</p></div></section>
    `;
    workspace.querySelector("#creatorAccountForm").addEventListener("submit", async event => {
        event.preventDefault();
        const button = event.currentTarget.querySelector('button[type="submit"]');
        button.disabled = true;
        const values = Object.fromEntries(new FormData(event.currentTarget));
        values.isActive = event.currentTarget.elements.isActive.checked;
        const result = await api(`/api/creator/accounts/${encodeURIComponent(accountId)}`, { method: "PATCH", body: JSON.stringify(values) });
        button.disabled = false;
        if (!result.ok) return showFeedback(result.message || "Mise à jour impossible.", true);
        showFeedback("Entreprise mise à jour.");
        await loadAccounts(accountId);
    });
    workspace.querySelector("#creatorDeleteAccount")?.addEventListener("click", async () => {
        if (!confirm(`Supprimer définitivement ${account.companyName}, ses accès et toutes ses données ?`)) return;
        const result = await api(`/api/creator/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" });
        if (!result.ok) return showFeedback(result.message || "Suppression impossible.", true);
        selectedAccountId = "";
        showFeedback("Entreprise supprimée.");
        await loadAccounts();
    });
    workspace.querySelector("#creatorNewPcMember").addEventListener("click", () => renderMemberForm(account, null, "admin"));
    workspace.querySelector("#creatorNewTechnician").addEventListener("click", () => renderMemberForm(account, null, "technician"));
    bindSubscriptionPlan(workspace.querySelector("#creatorAccountForm"));
    await loadMembers(accountId);
}

function renderAccountForm() {
    selectedAccountId = "";
    renderAccountList();
    document.querySelector("#creatorWorkspace").innerHTML = `
        <form id="creatorNewAccountForm" class="creator-form">
            <div class="form-heading"><div><p class="eyebrow">Nouvelle entreprise</p><h3>Créer un espace client</h3></div></div>
            <div class="form-grid">
                <label>Nom de l’entreprise<input name="companyName" maxlength="160" required placeholder="Ex. Martin Automatismes"></label>
                <label>Responsable principal<input name="fullName" maxlength="100" required placeholder="Nom et prénom"></label>
                <label>Téléphone responsable<input name="phone" maxlength="30" placeholder="06 12 34 56 78"></label>
                <label>E-mail de facturation<input name="billingEmail" type="email" maxlength="160" placeholder="comptabilite@entreprise.fr"></label>
                <label>Identifiant administrateur<input name="username" minlength="3" maxlength="32" required placeholder="minuscules, chiffres, . _ -"></label>
                <label>Mot de passe initial<input name="password" type="password" minlength="12" required autocomplete="new-password"></label>
                <label>Postes PC autorisés<input name="maxPcUsers" type="number" min="1" max="100" required value="1"></label>
                <label>Techniciens autorisés<input name="maxTechnicians" type="number" min="0" max="500" required value="1"></label>
            </div>
            ${renderSubscriptionFields({ subscriptionPlan: "free", subscriptionLabel: "", monthlyPriceCents: 0, subscriptionStatus: "active", subscriptionRenewalDate: "", billingReference: "", creatorNote: "" })}
            ${renderQuoteTemplatePolicyFields({ quoteTemplatePolicy: "company_choice" })}
            <div class="creator-form-actions"><button type="submit" class="secondary-button">Créer l’entreprise</button></div>
        </form>
    `;
    bindSubscriptionPlan(document.querySelector("#creatorNewAccountForm"));
    document.querySelector("#creatorNewAccountForm").addEventListener("submit", async event => {
        event.preventDefault();
        const button = event.currentTarget.querySelector('button[type="submit"]');
        button.disabled = true;
        const result = await api("/api/creator/accounts", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
        button.disabled = false;
        if (!result.ok) return showFeedback(result.message || "Création impossible.", true);
        selectedAccountId = result.data.id;
        showFeedback("Entreprise et Administrateur (PC) créés.");
        await loadAccounts(selectedAccountId);
    });
}

function renderSubscriptionFields(account) {
    const plan = account.subscriptionPlan === "paid" ? "paid" : "free";
    return `
        <fieldset class="creator-subscription-fields"><legend>Abonnement et suivi commercial</legend>
            <div class="form-grid">
                <label>Formule<select name="subscriptionPlan"><option value="free" ${plan === "free" ? "selected" : ""}>Abonnement mensuel gratuit</option><option value="paid" ${plan === "paid" ? "selected" : ""}>Abonnement mensuel payant</option></select></label>
                <label>Nom de l’offre<input name="subscriptionLabel" maxlength="80" value="${escapeHtml(account.subscriptionLabel || "")}" placeholder="Ex. Pro équipe"></label>
                <label>Tarif mensuel TTC (€)<input name="monthlyPrice" type="number" min="0" max="999999.99" step="0.01" value="${escapeHtml(centsToAmount(account.monthlyPriceCents))}" ${plan === "free" ? "disabled" : ""}></label>
                <label>Statut de l’abonnement<select name="subscriptionStatus">${["active", "trial", "past_due", "suspended", "cancelled"].map(status => `<option value="${status}" ${account.subscriptionStatus === status ? "selected" : ""}>${subscriptionStatusLabel(status)}</option>`).join("")}</select></label>
                <label>Prochaine échéance<input name="subscriptionRenewalDate" type="date" value="${escapeHtml(account.subscriptionRenewalDate || "")}"></label>
                <label>Référence de paiement / facture<input name="billingReference" maxlength="100" value="${escapeHtml(account.billingReference || "")}" placeholder="Ex. Virement juillet 2026"></label>
                <label class="form-wide">Note interne Créateur<textarea name="creatorNote" rows="3" maxlength="1000" placeholder="Suivi commercial, demande client, action à prévoir…">${escapeHtml(account.creatorNote || "")}</textarea></label>
            </div>
        </fieldset>
    `;
}

function renderQuoteTemplatePolicyFields(account) {
    const policy = account.quoteTemplatePolicy || "company_choice";
    return `
        <fieldset class="creator-subscription-fields"><legend>Base de devis</legend>
            <div class="form-grid">
                <label class="form-wide">Mode autorisé pour cette entreprise<select name="quoteTemplatePolicy">
                    <option value="integrated_only" ${policy === "integrated_only" ? "selected" : ""}>Modèle Depann’Home intégré uniquement</option>
                    <option value="company_choice" ${policy === "company_choice" ? "selected" : ""}>L’entreprise choisit son modèle</option>
                    <option value="external_only" ${policy === "external_only" ? "selected" : ""}>Base PDF / Word déposée par l’entreprise uniquement</option>
                </select></label>
                <p class="muted form-wide">Une base externe est stockée dans l’espace privé de l’entreprise et téléchargée depuis le poste PC administrateur. Elle n’est jamais partagée entre entreprises.</p>
            </div>
        </fieldset>
    `;
}

function bindSubscriptionPlan(form) {
    const plan = form.elements.subscriptionPlan;
    const price = form.elements.monthlyPrice;
    const billingEmail = form.elements.billingEmail;
    const update = () => {
        const isPaid = plan.value === "paid";
        price.disabled = !isPaid;
        billingEmail.required = isPaid;
        if (!isPaid) price.value = "0";
    };
    plan.addEventListener("change", update);
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
                <label>N° TVA intracommunautaire<input name="taxNumber" maxlength="100" value="${escapeHtml(profile.taxNumber || "")}"></label>
                <label class="form-wide">Adresse *<input name="address" maxlength="255" required value="${escapeHtml(profile.address || "")}"></label>
                <label>Code postal *<input name="postalCode" maxlength="20" required value="${escapeHtml(profile.postalCode || "")}"></label>
                <label>Ville *<input name="city" maxlength="100" required value="${escapeHtml(profile.city || "")}"></label>
                <label>Téléphone<input name="phone" maxlength="50" value="${escapeHtml(profile.phone || "")}"></label>
                <label>E-mail de facturation *<input name="email" type="email" maxlength="160" required value="${escapeHtml(profile.email || "")}"></label>
                <label>IBAN *<input name="bankIban" maxlength="34" required value="${escapeHtml(profile.bankIban || "")}" placeholder="FR76…"></label>
                <label>BIC *<input name="bankBic" maxlength="11" required value="${escapeHtml(profile.bankBic || "")}" placeholder="ABCDEFGHXXX"></label>
                <label>Taux de TVA (%)<input name="vatRate" type="number" min="0" max="100" step="0.01" value="${escapeHtml(profile.vatRate ?? 20)}"></label>
                <label class="form-wide">Conditions de règlement<input name="paymentTerms" maxlength="500" value="${escapeHtml(profile.paymentTerms || "")}" placeholder="Paiement à réception de facture par virement bancaire."></label>
                <label class="form-wide">Mention de bas de page<textarea name="footerNote" rows="3" maxlength="1000">${escapeHtml(profile.footerNote || "")}</textarea></label>
            </div>
            <div class="creator-form-actions"><button type="submit" class="secondary-button">Enregistrer les coordonnées</button><button type="button" class="secondary-button" id="creatorBackToAccounts">Retour aux entreprises</button></div>
        </form>
    `;
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
    workspace.innerHTML = `
        <section class="creator-form creator-subscription-invoices-panel">
            <div class="form-heading"><div><p class="eyebrow">Facturation plateforme</p><h3>Factures d’abonnement envoyées</h3></div><span class="creator-state">${invoices.length} facture${invoices.length > 1 ? "s" : ""}</span></div>
            <p class="muted">Chaque PDF reprend les informations légales, bancaires et tarifaires enregistrées au moment de son émission.</p>
            <div class="creator-subscription-invoice-list">${invoices.length ? invoices.map(renderSubscriptionInvoice).join("") : '<p class="muted">Aucune facture d’abonnement n’a encore été créée.</p>'}</div>
            <div class="creator-form-actions"><button type="button" class="secondary-button" id="creatorSubscriptionInvoicesBack">Retour aux entreprises</button></div>
        </section>
    `;
    workspace.querySelector("#creatorSubscriptionInvoicesBack").addEventListener("click", () => selectedAccountId ? renderAccountDetail(selectedAccountId) : workspace.replaceChildren());
}

function renderSubscriptionInvoice(invoice) {
    const status = subscriptionInvoiceStatus(invoice.status);
    const sentAt = invoice.sentAt ? `Envoyée le ${formatDateTime(invoice.sentAt)}` : invoice.status === "failed" ? "Envoi en échec" : "En attente d’envoi";
    const error = invoice.status === "failed" && invoice.lastError ? `<p class="auth-message error">${escapeHtml(invoice.lastError)}</p>` : "";
    return `
        <article class="creator-subscription-invoice">
            <div><p class="eyebrow">${escapeHtml(invoice.subscriptionLabel || "Abonnement Depann’Home Pro")}</p><h4>${escapeHtml(invoice.invoiceNumber)}</h4><p>${escapeHtml(invoice.companyName || invoice.recipientName)} · ${escapeHtml(invoice.recipientEmail || "E-mail non renseigné")}</p></div>
            <div class="creator-subscription-invoice-details"><span class="creator-subscription-badge ${escapeHtml(invoice.status || "pending")}">${status}</span><strong>${formatCurrency(invoice.amountCents)}</strong><small>Émise le ${formatDate(invoice.issueDate)} · Échéance ${formatDate(invoice.dueDate)}</small><small>${escapeHtml(sentAt)}</small>${error}</div>
            <a class="secondary-button" href="/api/creator/subscription-invoices/${encodeURIComponent(invoice.id)}/pdf" download> Télécharger le PDF</a>
        </article>
    `;
}

function subscriptionInvoiceStatus(status) {
    return ({ sent: "Envoyée", pending: "À envoyer", sending: "Envoi en cours", failed: "Échec d’envoi" })[status] || "À envoyer";
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
    container.innerHTML = members.length ? `<div class="creator-members">${members.map(member => `
        <article class="creator-member">
            <div><strong>${escapeHtml(member.fullName || member.username)}</strong><span>${member.role === "admin" ? "Poste PC" : "Technicien"} · ${escapeHtml(member.username)}${member.phone ? ` · ${escapeHtml(member.phone)}` : ""}${member.email ? ` · ${escapeHtml(member.email)}` : ""}</span></div>
            <div class="creator-member-actions"><span class="creator-state${member.isActive ? "" : " suspended"}">${member.isActive ? "Actif" : "Désactivé"}</span><button type="button" class="secondary-button" data-edit-member="${escapeHtml(member.id)}">Gérer</button></div>
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
            <div class="form-heading"><div><p class="eyebrow">${editing ? "Modifier l’accès" : "Nouvel accès"}</p><h3>${editing ? escapeHtml(member.fullName || member.username) : role === "technician" ? "Créer un poste technicien" : "Créer un poste PC"}</h3></div></div>
            <div class="form-grid">
                ${editing ? `<label>Type d’accès<input value="${member.role === "admin" ? "Poste PC" : "Technicien"}" disabled></label>` : `<label>Type d’accès<select name="role"><option value="admin" ${role === "admin" ? "selected" : ""}>Poste PC</option><option value="technician" ${role === "technician" ? "selected" : ""}>Technicien</option></select></label>`}
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
        const isTechnician = (roleInput?.value || initialRole) === "technician";
        phone.required = isTechnician;
        email.required = isTechnician;
        form.querySelector("[data-member-phone]").firstChild.textContent = isTechnician ? "Téléphone du technicien *" : "Téléphone";
        form.querySelector("[data-member-email]").firstChild.textContent = isTechnician ? "E-mail professionnel du technicien *" : "E-mail professionnel";
        hint.textContent = isTechnician
            ? "Le téléphone, l’e-mail professionnel, l’identifiant et le mot de passe sont nécessaires pour créer un poste technicien."
            : "L’identifiant et le mot de passe permettent la connexion au poste PC.";
    };
    roleInput?.addEventListener("change", update);
    update();
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
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12_000);
    try {
        const response = await fetch(url, { credentials: "same-origin", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options, signal: controller.signal });
        const data = response.status === 204 ? null : await response.json().catch(() => null);
        return { ok: response.ok, data, message: data?.message };
    } catch (error) {
        if (error.name === "AbortError") return { ok: false, message: "Le chargement des accès a expiré. Réessayez dans quelques instants." };
        return { ok: false, message: "Impossible de joindre le serveur." };
    } finally {
        window.clearTimeout(timeout);
    }
}
