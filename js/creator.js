import { ROUTES } from "./config.js?v=105";
import { clearSearch, getContainer, setPage } from "./ui.js?v=44";
import { escapeHtml } from "./utils.js?v=44";

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
                <div class="creator-form-actions"><button type="button" class="secondary-button auth-outline-button" id="creatorSecurity">Sécurité du compte</button><button type="button" class="secondary-button auth-outline-button" id="creatorBillingProfile">Facturation plateforme</button><button type="button" class="secondary-button" id="creatorNewAccount">+ Nouvelle entreprise</button></div>
            </header>
            <p id="creatorFeedback" class="auth-message" aria-live="polite"></p>
            <section class="creator-subscription-summary" id="creatorSubscriptionSummary" aria-label="Synthèse des abonnements"></section>
            <div class="creator-layout">
                <aside class="creator-accounts" id="creatorAccounts"><p class="muted">Chargement des entreprises…</p></aside>
                <section class="creator-workspace" id="creatorWorkspace"><p class="muted">Sélectionnez une entreprise ou créez-en une.</p></section>
            </div>
        </section>
    `;
    container.querySelector("#creatorNewAccount").addEventListener("click", () => renderAccountForm());
    container.querySelector("#creatorBillingProfile").addEventListener("click", renderSubscriptionBillingProfile);
    container.querySelector("#creatorSecurity").addEventListener("click", renderCreatorSecurity);
    await loadAccounts();
}

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
        showFeedback("Entreprise et administrateur principal créés.");
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
