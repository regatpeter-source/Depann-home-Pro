import { ROUTES } from "./config.js?v=120";
import { clearSearch, getContainer, setPage } from "./ui.js?v=44";
import { escapeHtml } from "./utils.js?v=44";

export async function renderGroupWorkspace() {
    clearSearch();
    setPage("Groupe & entreprises", ROUTES.groups, "detail");
    const container = getContainer();
    container.innerHTML = '<section class="group-shell"><p class="muted">Chargement du groupe…</p></section>';
    const [context, dashboard, audit] = await Promise.all([api("/api/groups/context"), api("/api/groups/dashboard"), api("/api/groups/audit")]);
    if (!context.ok || !context.data?.enabled) {
        container.innerHTML = '<section class="client-panel"><p class="auth-message error">Le mode Groupe n’est pas disponible.</p></section>';
        return;
    }
    const shell = container.querySelector(".group-shell");
    renderWorkspace(shell, context.data, dashboard.data?.dashboard, audit.data?.entries || []);
}

export function renderGroupActivation(container) {
    const card = document.createElement("article");
    card.className = "brand-card full-card procedure-card group-activation";
    card.innerHTML = '<p class="eyebrow">Optionnel</p><h2>Mode Groupe / Multi-entreprises</h2><p>Créez un groupe pour piloter plusieurs sociétés strictement indépendantes. Cette activation conserve toutes les données de votre entreprise actuelle et ne partage aucune information automatiquement.</p><form><label>Nom du groupe<input name="name" maxlength="160" placeholder="Ex. Groupe Habitat France" required></label><p class="auth-message"></p><button class="secondary-button">Activer le mode Groupe</button></form>';
    card.querySelector("form").addEventListener("submit", async event => {
        event.preventDefault();
        const result = await api("/api/groups/activate", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
        if (!result.ok) {
            const message = card.querySelector(".auth-message");
            message.textContent = result.message || "Activation impossible.";
            message.classList.add("error");
            return;
        }
        window.location.reload();
    });
    container.appendChild(card);
}

function renderWorkspace(shell, context, dashboard = { total: {}, companies: [] }, entries) {
    const total = dashboard.total || {};
    shell.innerHTML = `<header class="group-heading"><div><p class="eyebrow">Pilotage multi-entreprises</p><h2>${escapeHtml(context.group?.name || "Groupe")}</h2><p class="muted">Chaque indicateur reste calculé par entreprise. Les données opérationnelles ne sont jamais fusionnées.</p></div></header><section class="group-cards"><article><span>CA consolidé</span><strong data-group-total="turnover">${money(total.turnover)}</strong></article><article><span>Interventions</span><strong data-group-total="interventions">${total.interventions || 0}</strong></article><article><span>Devis</span><strong data-group-total="quotes">${total.quotes || 0}</strong></article><article><span>Factures</span><strong data-group-total="invoices">${total.invoices || 0}</strong></article><article><span>Techniciens</span><strong data-group-total="technicians">${total.technicians || 0}</strong></article></section><section class="group-panel"><div class="form-heading"><div><p class="eyebrow">Consolidation</p><h3>Indicateurs par entreprise</h3></div><form id="groupFilter" class="group-filter"><select name="companyId"><option value="">Toutes les entreprises</option>${context.companies.map(companyOption).join("")}</select><input name="start" type="date" aria-label="Début"><input name="end" type="date" aria-label="Fin"><button class="secondary-button">Filtrer</button></form></div><div class="group-company-list">${companyRows(dashboard.companies, context.companies)}</div></section><section class="group-panel"><div class="form-heading"><div><p class="eyebrow">Administration Groupe</p><h3>Entreprises juridiquement distinctes</h3></div></div><form id="newGroupCompany" class="form-grid"><label>Nom de l’entreprise *<input name="companyName" maxlength="160" required></label><label>Administrateur principal *<input name="fullName" maxlength="100" required></label><label>Identifiant administrateur *<input name="username" maxlength="32" required></label><label>Mot de passe initial *<input name="password" type="password" minlength="12" required></label><label>Téléphone<input name="phone" maxlength="30"></label><label>E-mail<input name="email" type="email" maxlength="160"></label><label>Postes PC<input name="maxPcUsers" type="number" min="1" max="100" value="1" required></label><label>Techniciens<input name="maxTechnicians" type="number" min="0" max="500" value="5" required></label><div class="form-actions"><button class="secondary-button">Créer l’entreprise</button></div></form><div class="group-company-management">${context.companies.map(item => companyManagementRow(item, context.activeCompanyId)).join("")}</div></section><section class="group-panel"><div class="form-heading"><div><p class="eyebrow">Traçabilité</p><h3>Journal des actions Groupe</h3></div></div><div class="group-audit-list">${auditRows(entries)}</div></section>`;
    shell.querySelector("#groupFilter").addEventListener("submit", event => { event.preventDefault(); loadDashboard(shell, new FormData(event.currentTarget)); });
    shell.querySelector("#newGroupCompany").addEventListener("submit", async event => {
        event.preventDefault();
        const button = event.currentTarget.querySelector("button");
        button.disabled = true;
        const result = await api("/api/groups/companies", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
        if (!result.ok) { button.disabled = false; return alert(result.message || "Création impossible."); }
        renderGroupWorkspace();
    });
    shell.querySelectorAll("[data-edit-company]").forEach(button => button.addEventListener("click", () => editCompany(button)));
    shell.querySelectorAll("[data-toggle-company]").forEach(button => button.addEventListener("click", () => toggleCompany(button)));
    renderGroupDeactivation(shell, context);
}

function renderGroupDeactivation(shell, context) {
    const companyCount = context.companies?.length || 0;
    const panel = document.createElement("section");
    panel.className = "group-panel group-deactivation";
    panel.innerHTML = `
        <div class="form-heading"><div><p class="eyebrow">Annulation du mode Groupe</p><h3>Désactiver le mode Groupe</h3></div></div>
        <p class="muted">Cette action supprime uniquement le groupe et les liens multi-entreprises. Aucune société, aucun utilisateur, client, planning, devis, facture ou autre donnée métier ne sera supprimé.</p>
        <p class="muted">Chaque société conservera son espace indépendant. ${companyCount > 1 ? `${companyCount} sociétés seront retirées de ce groupe.` : "Votre entreprise reprendra immédiatement son fonctionnement indépendant."}</p>
        <button type="button" class="secondary-button danger-button" data-deactivate-group>Désactiver le mode Groupe</button>
    `;
    const button = panel.querySelector("[data-deactivate-group]");
    button.addEventListener("click", async () => {
        const firstConfirmation = companyCount > 1
            ? `Dissoudre ce groupe et rendre ses ${companyCount} sociétés indépendantes ? Aucune donnée métier ne sera supprimée.`
            : "Désactiver ce groupe ? Votre entreprise redeviendra indépendante et aucune donnée métier ne sera supprimée.";
        if (!confirm(firstConfirmation)) return;
        if (!confirm("Confirmez la désactivation définitive du mode Groupe.")) return;
        button.disabled = true;
        const result = await api("/api/groups/current", { method: "DELETE" });
        if (!result.ok) {
            button.disabled = false;
            alert(result.message || "La désactivation du mode Groupe a échoué.");
            return;
        }
        window.location.reload();
    });
    shell.appendChild(panel);
}

async function loadDashboard(shell, form) {
    const query = new URLSearchParams();
    for (const [key, value] of form.entries()) if (value) query.set(key, value);
    const result = await api(`/api/groups/dashboard?${query}`);
    if (!result.ok) return alert(result.message || "Impossible de charger les indicateurs.");
    const total = result.data.dashboard.total || {};
    Object.entries(total).forEach(([key, value]) => {
        const node = shell.querySelector(`[data-group-total="${key}"]`);
        if (node) node.textContent = key === "turnover" ? money(value) : String(value || 0);
    });
    shell.querySelector(".group-company-list").innerHTML = companyRows(result.data.dashboard.companies, result.data.companies);
}

async function editCompany(button) {
    const currentName = button.dataset.companyName || "";
    const companyName = window.prompt("Nom de l’entreprise :", currentName);
    if (companyName === null || companyName.trim() === currentName) return;
    button.disabled = true;
    const result = await api(`/api/groups/companies/${encodeURIComponent(button.dataset.editCompany)}`, { method: "PATCH", body: JSON.stringify({ companyName: companyName.trim() }) });
    if (!result.ok) { button.disabled = false; return alert(result.message || "Mise à jour impossible."); }
    renderGroupWorkspace();
}

async function toggleCompany(button) {
    const active = button.dataset.companyActive === "true";
    if (!confirm(`${active ? "Désactiver" : "Réactiver"} cette entreprise ?`)) return;
    button.disabled = true;
    const result = await api(`/api/groups/companies/${encodeURIComponent(button.dataset.toggleCompany)}`, { method: "PATCH", body: JSON.stringify({ isActive: !active }) });
    if (!result.ok) { button.disabled = false; return alert(result.message || "Mise à jour impossible."); }
    renderGroupWorkspace();
}

function companyOption(item) { return `<option value="${escapeHtml(item.id)}">${escapeHtml(item.companyName)}</option>`; }
function companyRows(rows = [], companies = []) { const names = new Map(companies.map(item => [String(item.id), item.companyName])); return rows.map(item => `<article><strong>${escapeHtml(names.get(String(item.companyId)) || "Entreprise")}</strong><span>CA ${money(item.turnover)}</span><span>${item.interventions} intervention(s)</span><span>${item.quotes} devis · ${item.invoices} facture(s)</span><span>${item.technicians} technicien(s)</span></article>`).join("") || '<p class="muted">Aucune donnée sur cette période.</p>'; }
function companyManagementRow(item, activeCompanyId) { const active = Boolean(item.isActive); return `<article><div><strong>${escapeHtml(item.companyName)}</strong><p>${active ? "Active" : "Désactivée"}${String(item.id) === String(activeCompanyId) ? " · Entreprise active" : ""}</p></div><div class="group-company-actions"><button type="button" class="secondary-button" data-edit-company="${escapeHtml(item.id)}" data-company-name="${escapeHtml(item.companyName)}">Modifier</button><button type="button" class="secondary-button${active ? " danger-button" : ""}" data-toggle-company="${escapeHtml(item.id)}" data-company-active="${active}">${active ? "Désactiver" : "Réactiver"}</button></div></article>`; }
function auditRows(entries) { return entries.map(entry => `<article><strong>${escapeHtml(auditLabel(entry.action))}</strong><span>${escapeHtml(entry.companyName || "Groupe")}</span><span>${escapeHtml(entry.actorName || entry.actorUsername || "Administrateur")}</span><time datetime="${escapeHtml(entry.createdAt || "")}">${formatDate(entry.createdAt)}</time></article>`).join("") || '<p class="muted">Aucune action Groupe enregistrée.</p>'; }
function auditLabel(action) { return ({ group_activated: "Groupe activé", company_created: "Entreprise créée", company_updated: "Entreprise modifiée", company_activated: "Entreprise activée", company_deactivated: "Entreprise désactivée", company_switched: "Entreprise sélectionnée", client_imported: "Client repris depuis une entreprise du groupe" })[action] || action || "Action Groupe"; }
function formatDate(value) { return value ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : ""; }
function money(value) { return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(Number(value) || 0); }
async function api(url, options = {}) { try { const response = await fetch(url, { credentials: "same-origin", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options }); const data = response.status === 204 ? null : await response.json().catch(() => null); return { ok: response.ok, data, message: data?.message }; } catch { return { ok: false, message: "Serveur indisponible." }; } }
