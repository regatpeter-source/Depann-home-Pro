import { ROUTES } from "./config.js?v=100";
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
                <div><p class="eyebrow">Administration plateforme</p><h2>Console Créateur</h2><p class="muted">Gérez les entreprises, leurs accès PC, techniciens et limites de licences.</p></div>
                <button type="button" class="secondary-button" id="creatorNewAccount">+ Nouvelle entreprise</button>
            </header>
            <p id="creatorFeedback" class="auth-message" aria-live="polite"></p>
            <div class="creator-layout">
                <aside class="creator-accounts" id="creatorAccounts"><p class="muted">Chargement des entreprises…</p></aside>
                <section class="creator-workspace" id="creatorWorkspace"><p class="muted">Sélectionnez une entreprise ou créez-en une.</p></section>
            </div>
        </section>
    `;
    container.querySelector("#creatorNewAccount").addEventListener("click", () => renderAccountForm());
    await loadAccounts();
}

async function loadAccounts(preferredId = selectedAccountId) {
    const result = await api("/api/creator/accounts");
    if (!result.ok) return showFeedback(result.message || "Impossible de charger les entreprises.", true);
    accounts = result.data.accounts || [];
    selectedAccountId = accounts.some(account => String(account.id) === String(preferredId)) ? String(preferredId) : "";
    renderAccountList();
    if (selectedAccountId) await renderAccountDetail(selectedAccountId);
    else document.querySelector("#creatorWorkspace").innerHTML = '<p class="muted">Aucune entreprise créée pour le moment.</p>';
}

function renderAccountList() {
    const list = document.querySelector("#creatorAccounts");
    list.innerHTML = accounts.length ? accounts.map(account => `
        <button type="button" class="creator-account${String(account.id) === selectedAccountId ? " selected" : ""}" data-account-id="${escapeHtml(account.id)}">
            <strong>${escapeHtml(account.companyName || account.ownerFullName || account.ownerUsername)}</strong>
            <span>${escapeHtml(account.ownerUsername)} · ${account.isActive ? "Active" : "Suspendue"}</span>
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
    const workspace = document.querySelector("#creatorWorkspace");
    workspace.innerHTML = `
        <form id="creatorAccountForm" class="creator-form">
            <div class="form-heading"><div><p class="eyebrow">Entreprise</p><h3>${escapeHtml(account.companyName)}</h3></div><span class="creator-state${account.isActive ? "" : " suspended"}">${account.isActive ? "Active" : "Suspendue"}</span></div>
            <div class="form-grid">
                <label>Nom de l’entreprise<input name="companyName" maxlength="160" required value="${escapeHtml(account.companyName)}"></label>
                <label>Responsable principal<input name="fullName" maxlength="100" required value="${escapeHtml(account.ownerFullName)}"></label>
                <label>Téléphone responsable<input name="phone" maxlength="30" value="${escapeHtml(account.ownerPhone)}"></label>
                <label>Postes PC autorisés<input name="maxPcUsers" type="number" min="1" max="100" required value="${escapeHtml(account.maxPcUsers)}"></label>
                <label>Techniciens autorisés<input name="maxTechnicians" type="number" min="0" max="500" required value="${escapeHtml(account.maxTechnicians)}"></label>
                <label class="creator-switch">Entreprise active<input name="isActive" type="checkbox" ${account.isActive ? "checked" : ""}><span>Les membres peuvent se connecter</span></label>
            </div>
            <div class="creator-form-actions"><button type="submit" class="secondary-button">Enregistrer l’entreprise</button><button type="button" class="secondary-button danger-button" id="creatorDeleteAccount">Supprimer l’entreprise</button></div>
        </form>
        <section class="creator-members-section"><div class="form-heading"><div><p class="eyebrow">Accès</p><h3>Postes PC et techniciens</h3></div><button type="button" class="secondary-button" id="creatorNewMember">+ Ajouter un accès</button></div><div id="creatorMembers"><p class="muted">Chargement des accès…</p></div></section>
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
    workspace.querySelector("#creatorDeleteAccount").addEventListener("click", async () => {
        if (!confirm(`Supprimer définitivement ${account.companyName}, ses accès et toutes ses données ?`)) return;
        const result = await api(`/api/creator/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" });
        if (!result.ok) return showFeedback(result.message || "Suppression impossible.", true);
        selectedAccountId = "";
        showFeedback("Entreprise supprimée.");
        await loadAccounts();
    });
    workspace.querySelector("#creatorNewMember").addEventListener("click", () => renderMemberForm(account));
    await loadMembers(accountId);
}

function renderAccountForm() {
    selectedAccountId = "";
    renderAccountList();
    document.querySelector("#creatorWorkspace").innerHTML = `
        <form id="creatorNewAccountForm" class="creator-form">
            <div class="form-heading"><div><p class="eyebrow">Nouvelle entreprise</p><h3>Créer un espace client</h3><p class="muted">Le premier poste PC est l’administrateur principal de l’entreprise.</p></div></div>
            <div class="form-grid">
                <label>Nom de l’entreprise<input name="companyName" maxlength="160" required placeholder="Ex. Martin Automatismes"></label>
                <label>Responsable principal<input name="fullName" maxlength="100" required placeholder="Nom et prénom"></label>
                <label>Téléphone responsable<input name="phone" maxlength="30" placeholder="06 12 34 56 78"></label>
                <label>Identifiant administrateur<input name="username" minlength="3" maxlength="32" required placeholder="minuscules, chiffres, . _ -"></label>
                <label>Mot de passe initial<input name="password" type="password" minlength="12" required autocomplete="new-password"></label>
                <label>Postes PC autorisés<input name="maxPcUsers" type="number" min="1" max="100" required value="1"></label>
                <label>Techniciens autorisés<input name="maxTechnicians" type="number" min="0" max="500" required value="1"></label>
            </div>
            <div class="creator-form-actions"><button type="submit" class="secondary-button">Créer l’entreprise</button></div>
        </form>
    `;
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

async function loadMembers(accountId) {
    const result = await api(`/api/creator/accounts/${encodeURIComponent(accountId)}/members`);
    const container = document.querySelector("#creatorMembers");
    if (!result.ok) return container.innerHTML = `<p class="auth-message error">${escapeHtml(result.message || "Impossible de charger les accès.")}</p>`;
    const members = result.data.members || [];
    container.innerHTML = members.length ? `<div class="creator-members">${members.map(member => `
        <article class="creator-member">
            <div><strong>${escapeHtml(member.fullName || member.username)}</strong><span>${member.role === "admin" ? "Poste PC" : "Technicien"} · ${escapeHtml(member.username)}${member.phone ? ` · ${escapeHtml(member.phone)}` : ""}</span></div>
            <div class="creator-member-actions"><span class="creator-state${member.isActive ? "" : " suspended"}">${member.isActive ? "Actif" : "Désactivé"}</span><button type="button" class="secondary-button" data-edit-member="${escapeHtml(member.id)}">Gérer</button></div>
        </article>
    `).join("")}</div>` : '<p class="muted">Aucun accès pour le moment.</p>';
    container.querySelectorAll("[data-edit-member]").forEach(button => button.addEventListener("click", () => {
        const member = members.find(item => String(item.id) === button.dataset.editMember);
        if (member) renderMemberForm(accounts.find(item => String(item.id) === String(accountId)), member);
    }));
}

function renderMemberForm(account, member = null) {
    const editing = Boolean(member);
    const primary = editing && String(member.id) === String(account.id);
    const workspace = document.querySelector("#creatorWorkspace");
    workspace.innerHTML = `
        <form id="creatorMemberForm" class="creator-form">
            <div class="form-heading"><div><p class="eyebrow">${editing ? "Modifier l’accès" : "Nouvel accès"}</p><h3>${editing ? escapeHtml(member.fullName || member.username) : "Créer un accès"}</h3><p class="muted">${primary ? "Administrateur principal : l’état de connexion se pilote au niveau de l’entreprise." : "Les limites de licences actives sont contrôlées à l’enregistrement."}</p></div></div>
            <div class="form-grid">
                ${editing ? `<label>Type d’accès<input value="${member.role === "admin" ? "Poste PC" : "Technicien"}" disabled></label>` : `<label>Type d’accès<select name="role"><option value="admin">Poste PC</option><option value="technician">Technicien</option></select></label>`}
                <label>Nom et prénom<input name="fullName" maxlength="100" required value="${escapeHtml(member?.fullName || "")}"></label>
                <label>Téléphone<input name="phone" maxlength="30" value="${escapeHtml(member?.phone || "")}" placeholder="Obligatoire pour un technicien"></label>
                <label>Identifiant<input name="username" minlength="3" maxlength="32" required value="${escapeHtml(member?.username || "")}"></label>
                <label>${editing ? "Nouveau mot de passe (facultatif)" : "Mot de passe initial"}<input name="password" type="password" minlength="12" ${editing ? "" : "required"} autocomplete="new-password"></label>
                ${primary ? "" : `<label class="creator-switch">Accès actif<input name="isActive" type="checkbox" ${member?.isActive !== false ? "checked" : ""}><span>Autoriser la connexion</span></label>`}
            </div>
            <div class="creator-form-actions"><button type="submit" class="secondary-button">${editing ? "Enregistrer l’accès" : "Créer l’accès"}</button><button type="button" class="secondary-button" id="creatorCancelMember">Retour à l’entreprise</button>${editing && !primary ? '<button type="button" class="secondary-button danger-button" id="creatorDeleteMember">Supprimer l’accès</button>' : ""}</div>
        </form>
    `;
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
        showFeedback(editing ? "Accès mis à jour." : "Accès créé.");
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

function showFeedback(message, isError = false) {
    const feedback = document.querySelector("#creatorFeedback");
    if (!feedback) return;
    feedback.textContent = message;
    feedback.classList.toggle("error", isError);
}

async function api(url, options = {}) {
    try {
        const response = await fetch(url, { credentials: "same-origin", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
        const data = response.status === 204 ? null : await response.json().catch(() => null);
        return { ok: response.ok, data, message: data?.message };
    } catch {
        return { ok: false, message: "Impossible de joindre le serveur." };
    }
}
