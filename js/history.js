import { escapeHtml } from "./utils.js?v=44";

const CATEGORY_LABELS = Object.freeze({
    all: "Tous les journaux",
    account: "Compte & organisation",
    subscription: "Abonnement",
    members: "Utilisateurs & accès",
    imports: "Importations",
    clients: "Clients",
    operations: "Activité métier",
    accounting: "Comptabilité",
    partners: "Missions partenaires",
    group: "Groupe & entreprises"
});
const ACTION_LABELS = Object.freeze({
    account_updated: "Compte modifié", created: "Création", updated: "Modification", archived: "Archivage", restored: "Restauration",
    activated: "Activation", renewed: "Renouvellement", expired: "Expiration", ended: "Fin", converted: "Conversion",
    member_created: "Utilisateur créé", member_updated: "Utilisateur modifié", member_deleted: "Utilisateur supprimé",
    administrator_created: "Administrateur créé", administrator_modified: "Administrateur modifié", administrator_deleted: "Administrateur supprimé",
    device_approved: "Appareil approuvé", device_rejected: "Appareil refusé", import_completed: "Import terminé",
    client_created: "Client créé", client_archived: "Client archivé", client_restored: "Client restauré",
    group_seats_rebalanced: "Postes réattribués", company_updated: "Entreprise modifiée"
});
const PAGE_SIZE = 50;
const DELETABLE_CATEGORIES = new Set(["imports", "clients", "operations", "partners"]);

export function renderHistoryAndJournals(container) {
    const today = new Date();
    const yearAgo = new Date(today); yearAgo.setFullYear(yearAgo.getFullYear() - 1);
    const panel = document.createElement("section");
    panel.className = "history-journals-panel";
    const categories = Object.entries(CATEGORY_LABELS).filter(([value]) => value !== "group" || document.body.dataset.groupAdmin === "true");
    panel.innerHTML = `<div class="form-heading"><div><p class="eyebrow">Traçabilité</p><h2>Historiques & journaux</h2><p class="muted">Consultez ou supprimez les journaux opérationnels. Les traces de compte, d’accès, d’abonnement, de comptabilité et de groupe restent protégées.</p></div></div><form class="history-journals-filters"><label>Catégorie<select name="category">${categories.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></label><label>Du<input name="dateFrom" type="date" value="${dateValue(yearAgo)}"></label><label>Au<input name="dateTo" type="date" value="${dateValue(today)}"></label><label>Classement<select name="order"><option value="desc">Plus récents d’abord</option><option value="asc">Plus anciens d’abord</option></select></label><label class="history-search">Recherche<input name="search" maxlength="120" placeholder="Action, personne, document…"></label><div class="form-actions"><button class="primary-button">Appliquer</button><button type="button" class="secondary-button" data-reset-history>12 derniers mois</button></div></form><aside class="history-deletion-tools"><label><input type="checkbox" data-select-visible-history> Sélectionner les événements supprimables affichés</label><div><button type="button" class="secondary-button danger-button" data-delete-selected-history disabled>Supprimer la sélection</button><button type="button" class="secondary-button danger-button" data-delete-filtered-history>Supprimer les journaux opérationnels de la période</button></div><small>Suppression définitive. Un reçu minimal est conservé sans recopier le contenu supprimé.</small></aside><div class="history-journals-summary" aria-live="polite"></div><div class="history-journals-list"><p class="muted">Chargement des journaux…</p></div><div class="history-journals-pagination"><button type="button" class="secondary-button" data-history-previous>Page précédente</button><span data-history-page></span><button type="button" class="secondary-button" data-history-next>Page suivante</button></div>`;
    container.appendChild(panel);
    const state = { offset: 0, hasMore: false };
    const form = panel.querySelector("form");
    form.addEventListener("submit", event => { event.preventDefault(); state.offset = 0; loadHistory(panel, form, state); });
    panel.querySelector("[data-reset-history]").addEventListener("click", () => {
        form.reset(); form.elements.dateFrom.value = dateValue(yearAgo); form.elements.dateTo.value = dateValue(today); state.offset = 0; loadHistory(panel, form, state);
    });
    panel.querySelector("[data-history-previous]").addEventListener("click", () => { state.offset = Math.max(0, state.offset - PAGE_SIZE); loadHistory(panel, form, state); });
    panel.querySelector("[data-history-next]").addEventListener("click", () => { if (!state.hasMore) return; state.offset += PAGE_SIZE; loadHistory(panel, form, state); });
    panel.querySelector("[data-select-visible-history]").addEventListener("change", event => { panel.querySelectorAll("[data-history-selection]").forEach(input => { input.checked = event.target.checked; }); updateDeletionControls(panel); });
    panel.querySelector(".history-journals-list").addEventListener("change", event => { if (event.target.matches("[data-history-selection]")) updateDeletionControls(panel); });
    panel.querySelector("[data-delete-selected-history]").addEventListener("click", () => deleteHistory(panel, form, state, "selected"));
    panel.querySelector("[data-delete-filtered-history]").addEventListener("click", () => deleteHistory(panel, form, state, "filtered"));
    loadHistory(panel, form, state);
}

async function loadHistory(panel, form, state) {
    const list = panel.querySelector(".history-journals-list");
    const summary = panel.querySelector(".history-journals-summary");
    list.innerHTML = '<p class="muted">Chargement des journaux…</p>';
    const query = new URLSearchParams(Object.fromEntries(new FormData(form)));
    query.set("offset", String(state.offset)); query.set("limit", String(PAGE_SIZE));
    const response = await fetch(`/api/history?${query}`, { credentials: "same-origin", cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        list.innerHTML = `<p class="auth-message error">${escapeHtml(data.message || "Impossible de charger les journaux.")}</p>`;
        return;
    }
    state.hasMore = Boolean(data.page?.hasMore);
    const entries = data.entries || [];
    summary.textContent = `${entries.length} événement(s) affiché(s) · période du ${formatDay(data.filters?.dateFrom)} au ${formatDay(data.filters?.dateTo)}`;
    list.innerHTML = entries.map(historyEntry).join("") || '<p class="muted">Aucun événement ne correspond à ces filtres.</p>';
    panel.querySelector("[data-select-visible-history]").checked = false;
    updateDeletionControls(panel);
    panel.querySelector("[data-history-previous]").disabled = state.offset === 0;
    panel.querySelector("[data-history-next]").disabled = !state.hasMore;
    panel.querySelector("[data-history-page]").textContent = `Page ${Math.floor(state.offset / PAGE_SIZE) + 1}`;
}

function historyEntry(entry) {
    const details = readableDetails(entry.details);
    return `<article class="history-journals-entry">${entry.deletable ? `<label class="history-entry-selection"><input type="checkbox" data-history-selection value="${escapeHtml(entry.id)}"><span class="sr-only">Sélectionner cet événement</span></label>` : '<span class="history-entry-protected" title="Trace protégée">Protégé</span>'}<div><span class="history-category">${escapeHtml(CATEGORY_LABELS[entry.category] || entry.category)}</span><time datetime="${escapeHtml(entry.createdAt || "")}">${formatDate(entry.createdAt)}</time></div><div><strong>${escapeHtml(ACTION_LABELS[entry.action] || humanize(entry.action))}</strong><p>${escapeHtml(entry.target || "Événement")}</p><small>Par ${escapeHtml(entry.actorName || "Système")}</small>${details ? `<details><summary>Afficher les détails</summary><pre>${escapeHtml(details)}</pre></details>` : ""}</div></article>`;
}

function updateDeletionControls(panel) {
    const selected = panel.querySelectorAll("[data-history-selection]:checked").length;
    const button = panel.querySelector("[data-delete-selected-history]");
    button.disabled = selected === 0;
    button.textContent = selected ? `Supprimer la sélection (${selected})` : "Supprimer la sélection";
}

async function deleteHistory(panel, form, state, mode) {
    const category = form.elements.category.value;
    const items = [...panel.querySelectorAll("[data-history-selection]:checked")].map(input => input.value);
    if (mode === "selected" && !items.length) return;
    if (mode === "filtered" && category !== "all" && !DELETABLE_CATEGORIES.has(category)) return alert("Cette catégorie contient des traces légales ou de sécurité protégées.");
    const scope = mode === "selected" ? `${items.length} événement(s) sélectionné(s)` : `les journaux opérationnels du ${formatDay(form.elements.dateFrom.value)} au ${formatDay(form.elements.dateTo.value)}`;
    if (!confirm(`Supprimer définitivement ${scope} ? Cette action est irréversible.`)) return;
    const reason = prompt("Indiquez le motif de cette suppression (10 caractères minimum) :", "Réduction des journaux devenus inutiles");
    if (reason === null) return;
    if (reason.trim().length < 10) return alert("Le motif doit contenir au moins 10 caractères.");
    const response = await fetch("/api/history/delete", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode, items, category, dateFrom: form.elements.dateFrom.value, dateTo: form.elements.dateTo.value, reason }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return alert(data.message || "La suppression n’a pas pu être effectuée.");
    alert(`${data.deletedCount || 0} événement(s) supprimé(s). Les traces légales et de sécurité ont été conservées.`);
    state.offset = 0;
    loadHistory(panel, form, state);
}

function readableDetails(value) {
    if (!value || typeof value !== "object" || !Object.keys(value).length) return "";
    const text = JSON.stringify(value, null, 2);
    return text.length > 3000 ? `${text.slice(0, 3000)}\n…` : text;
}
function humanize(value) { return String(value || "Événement").replaceAll("_", " ").replace(/^./, letter => letter.toUpperCase()); }
function dateValue(value) { return value.toISOString().slice(0, 10); }
function formatDay(value) { return value ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "short" }).format(new Date(`${value}T12:00:00`)) : "—"; }
function formatDate(value) { return value ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "—"; }
