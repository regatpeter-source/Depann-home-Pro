import { ROUTES } from "./config.js?v=111";
import { getSearchableClients } from "./clients.js?v=160";
import { resetSelection } from "./state.js?v=44";
import { escapeHtml, normalizeText } from "./utils.js?v=44";
import { clearSearch, getContainer, setPage } from "./ui.js?v=44";
import { pageSizeOptions, paginateItems, renderBusinessPagination } from "./pagination.js?v=1";

const PURCHASE_CATEGORIES = ["Matériel", "Consommables", "Loyer", "Véhicule", "Outillage", "Sous-traitance", "Services", "Assurances", "Autre"];
let purchases = [];
let activePurchase = null;
let presentation = {};
const purchasePagination = { page: 1, pageSize: 20 };

export async function renderPurchases(options = {}) {
    presentation = { ...options, readOnly: options.readOnly === true || document.body.dataset.role === "accountant" };
    clearSearch();
    resetSelection("all");
    if (!presentation.embedded) setPage("Achats", ROUTES.purchases, "detail");

    const container = presentation.container || getContainer();
    const overviewPanel = createPanel("purchases-overview-panel");
    const editorPanel = createPanel("purchases-editor-panel");
    const listPanel = createPanel("purchases-list-panel");
    container.append(overviewPanel, editorPanel, listPanel);
    overviewPanel.innerHTML = "<p class=\"muted\">Chargement des achats…</p>";
    [editorPanel, listPanel].forEach(panel => panel.hidden = true);

    const result = await apiRequest("/api/purchases");
    if (!result.ok) {
        overviewPanel.innerHTML = `<p class="auth-message error">${escapeHtml(result.message || "Impossible de charger les achats.")}</p>`;
        return;
    }

    purchases = result.data.purchases || [];
    renderOverview(overviewPanel);
    renderPurchaseEditor(editorPanel);
    renderPurchaseList(listPanel);
}

function createPanel(className) {
    const panel = document.createElement("section");
    panel.className = `client-panel ${className}`;
    return panel;
}

function renderOverview(panel) {
    const totals = calculateTotals(purchases);
    const accountedPurchases = purchases.filter(purchase => purchase.isAccounted);
    const accountedTotals = calculateTotals(accountedPurchases);
    panel.innerHTML = `
        <div class="purchases-overview">
            <div><p class="eyebrow">Base de données fournisseurs</p><h2>Achats & dépenses</h2></div>
            ${presentation.readOnly ? '<span class="auth-message">Consultation uniquement</span>' : '<button type="button" class="secondary-button" id="newPurchase">+ Nouvel achat</button>'}
        </div>
        <div class="billing-metrics purchases-metrics"><span><strong>${purchases.length}</strong> achat(s)</span><span><strong>${formatMoney(totals.ttc)}</strong> achats TTC</span><span><strong>${formatMoney(totals.vat)}</strong> TVA déductible</span><span class="billing-accounted-metric"><strong>${formatMoney(accountedTotals.ttc)}</strong> comptabilisé TTC</span></div>
    `;
    panel.querySelector("#newPurchase")?.addEventListener("click", () => {
        activePurchase = createNewPurchase();
        renderPurchases(presentation);
    });
}

function renderPurchaseEditor(panel) {
    if (!activePurchase || presentation.readOnly) { activePurchase = null; panel.hidden = true; panel.innerHTML = ""; return; }
    panel.hidden = false;
    const purchase = activePurchase;
    const isEditing = Boolean(purchase.id);
    const clients = getSearchableClients().sort((first, second) => first.name.localeCompare(second.name, "fr"));
    const selectedClient = clients.find(client => client.id === purchase.clientId);
    const unavailableClientOption = purchase.clientId && !selectedClient
        ? `<option value="${escapeHtml(purchase.clientId)}" selected>${escapeHtml(purchase.clientName || "Client archivé")}</option>`
        : "";
    panel.innerHTML = `
        <form id="purchaseForm" class="client-form">
            <div class="form-heading"><div><p class="eyebrow">${isEditing ? "Modification" : "Nouvel achat"}</p><h2>${isEditing ? "Modifier l’achat" : "Enregistrer un achat"}</h2></div><button type="button" class="secondary-button" id="cancelPurchase">Annuler</button></div>
            <div class="form-grid">
                <label>Date *<input name="purchaseDate" type="date" required value="${escapeHtml(purchase.purchaseDate)}"></label>
                <label>Catégorie *<select name="category">${PURCHASE_CATEGORIES.map(category => `<option value="${escapeHtml(category)}" ${purchase.category === category ? "selected" : ""}>${escapeHtml(category)}</option>`).join("")}</select></label>
                <label>Client concerné<select name="clientId"><option value="">Aucun client</option>${unavailableClientOption}${clients.map(client => `<option value="${escapeHtml(client.id)}" ${purchase.clientId === client.id ? "selected" : ""}>${escapeHtml(client.name)}</option>`).join("")}</select></label>
                <label>Fournisseur<input name="supplier" maxlength="160" placeholder="Ex. fournisseur, bailleur…" value="${escapeHtml(purchase.supplier)}"></label>
                <label>Référence / justificatif<input name="reference" maxlength="100" placeholder="N° facture, ticket, contrat…" value="${escapeHtml(purchase.reference)}"></label>
                <label class="form-wide">Libellé *<input name="description" maxlength="500" required placeholder="Ex. Moteur de portail, fournitures, loyer atelier…" value="${escapeHtml(purchase.description)}"></label>
                <label>Montant HT *<input name="amountHt" type="number" min="0" step="0.01" required value="${escapeHtml(purchase.amountHt)}"></label>
                <label>TVA %<input name="vatRate" type="number" min="0" max="100" step="0.01" value="${escapeHtml(purchase.vatRate)}"></label>
                <label class="billing-accounting-option"><input name="isAccounted" type="checkbox" ${purchase.isAccounted ? "checked" : ""}> Achat comptabilisé</label>
                <label class="form-wide">Notes<textarea name="notes" rows="3" maxlength="2000" placeholder="Informations complémentaires">${escapeHtml(purchase.notes)}</textarea></label>
            </div>
            <div class="purchase-editor-total" id="purchaseEditorTotal"></div>
            <p id="purchaseMessage" class="auth-message" aria-live="polite"></p>
            <div class="calendar-form-actions"><button type="submit" class="secondary-button">${isEditing ? "Enregistrer les modifications" : "Enregistrer l’achat"}</button>${isEditing ? '<button type="button" class="danger-button" id="deletePurchase">Supprimer</button>' : ""}</div>
        </form>
    `;
    const form = panel.querySelector("form");
    const renderEditorTotal = () => {
        purchase.amountHt = Number(form.elements.amountHt.value) || 0;
        purchase.vatRate = Number(form.elements.vatRate.value) || 0;
        const totals = calculateTotals([purchase]);
        panel.querySelector("#purchaseEditorTotal").innerHTML = `<span>HT <strong>${formatMoney(totals.ht)}</strong></span><span>TVA <strong>${formatMoney(totals.vat)}</strong></span><span>TTC <strong>${formatMoney(totals.ttc)}</strong></span>`;
    };
    form.elements.amountHt.addEventListener("input", renderEditorTotal);
    form.elements.vatRate.addEventListener("input", renderEditorTotal);
    renderEditorTotal();
    panel.querySelector("#cancelPurchase").addEventListener("click", () => { activePurchase = null; renderPurchases(presentation); });
    form.addEventListener("submit", async event => {
        event.preventDefault();
        const message = panel.querySelector("#purchaseMessage");
        const payload = formDataToObject(new FormData(form));
        payload.clientName = payload.clientId ? (clients.find(client => client.id === payload.clientId)?.name || purchase.clientName || "") : "";
        const result = await apiRequest(isEditing ? `/api/purchases/${encodeURIComponent(purchase.id)}` : "/api/purchases", { method: isEditing ? "PUT" : "POST", body: JSON.stringify(payload) });
        if (!result.ok) { message.textContent = result.message || "Impossible d’enregistrer l’achat."; message.classList.add("error"); return; }
        activePurchase = null;
        renderPurchases(presentation);
    });
    panel.querySelector("#deletePurchase")?.addEventListener("click", async () => {
        if (!confirm("Supprimer cet achat ?")) return;
        const result = await apiRequest(`/api/purchases/${encodeURIComponent(purchase.id)}`, { method: "DELETE" });
        if (!result.ok) { alert(result.message || "Suppression impossible."); return; }
        activePurchase = null;
        renderPurchases(presentation);
    });
}

function renderPurchaseList(panel) {
    panel.hidden = false;
    panel.innerHTML = `
        <div class="form-heading"><div><p class="eyebrow">Registre des dépenses</p><h2>Achats enregistrés</h2></div></div>
        <div class="billing-register-filters"><input id="purchaseSearch" type="search" placeholder="Rechercher un fournisseur, une référence ou un achat" aria-label="Rechercher un achat"><select id="purchaseCategoryFilter" aria-label="Filtrer par catégorie"><option value="all">Toutes les catégories</option>${PURCHASE_CATEGORIES.map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("")}</select><select id="purchaseAccountingFilter" aria-label="Filtrer par comptabilisation"><option value="all">Tous les statuts comptables</option><option value="accounted">Comptabilisés</option><option value="unaccounted">À comptabiliser</option></select><label>Afficher<select id="purchasePageSize" aria-label="Nombre d’achats par page">${pageSizeOptions(purchasePagination.pageSize, "achats")}</select></label></div>
        <div class="purchase-list" id="purchaseList"></div>
        <nav class="business-pagination" id="purchasePagination" aria-label="Pages des achats"></nav>
    `;
    const list = panel.querySelector("#purchaseList");
    const search = panel.querySelector("#purchaseSearch");
    const categoryFilter = panel.querySelector("#purchaseCategoryFilter");
    const accountingFilter = panel.querySelector("#purchaseAccountingFilter");
    const pageSize = panel.querySelector("#purchasePageSize");
    const renderFilteredPurchases = () => {
        const query = normalizeText(search.value);
        const visiblePurchases = purchases.filter(purchase => {
            const matchesQuery = !query || normalizeText(`${purchase.clientName} ${purchase.supplier} ${purchase.description} ${purchase.reference}`).includes(query);
            const matchesCategory = categoryFilter.value === "all" || purchase.category === categoryFilter.value;
            const matchesAccounting = accountingFilter.value === "all" || (accountingFilter.value === "accounted" ? purchase.isAccounted : !purchase.isAccounted);
            return matchesQuery && matchesCategory && matchesAccounting;
        });
        const pagination = paginateItems(visiblePurchases, purchasePagination);
        list.innerHTML = "";
        if (!visiblePurchases.length) { list.innerHTML = `<p class="muted">${purchases.length ? "Aucun achat ne correspond aux filtres." : "Ajoutez votre premier achat."}</p>`; panel.querySelector("#purchasePagination").innerHTML = ""; return; }
        pagination.items.forEach(purchase => {
            const item = document.createElement("article");
            item.className = "purchase-item";
            const totals = calculateTotals([purchase]);
            const accountingLabel = purchase.isAccounted ? `Comptabilisé le ${formatDate(purchase.accountedAt)}` : "À comptabiliser";
            item.innerHTML = `<div><p class="eyebrow">${escapeHtml(purchase.category)}${purchase.clientName ? ` · Client : ${escapeHtml(purchase.clientName)}` : ""}</p><h3>${escapeHtml(purchase.description)}</h3><p>${escapeHtml(purchase.supplier || "Fournisseur non renseigné")}${purchase.reference ? ` · ${escapeHtml(purchase.reference)}` : ""}</p><small>${escapeHtml(formatDate(purchase.purchaseDate))} · <span class="billing-accounting-status ${purchase.isAccounted ? "is-accounted" : ""}">${escapeHtml(accountingLabel)}</span></small></div><div class="billing-document-amount"><strong>${formatMoney(totals.ttc)}</strong><small>${formatMoney(totals.ht)} HT · TVA ${formatMoney(totals.vat)}</small></div><div class="billing-document-actions">${presentation.readOnly ? '<small>Consultation uniquement</small>' : `<button type="button" class="secondary-button" data-accounting="${purchase.isAccounted ? "false" : "true"}">${purchase.isAccounted ? "Décomptabiliser" : "Comptabiliser"}</button><button type="button" class="secondary-button" data-open-purchase>Ouvrir</button>`}</div>`;
            item.querySelector("[data-open-purchase]")?.addEventListener("click", () => { activePurchase = normalizePurchase(purchase); renderPurchases(presentation); });
            item.querySelector("[data-accounting]")?.addEventListener("click", async event => {
                const result = await apiRequest(`/api/purchases/${encodeURIComponent(purchase.id)}/accounting`, { method: "PATCH", body: JSON.stringify({ isAccounted: event.currentTarget.dataset.accounting === "true" }) });
                if (!result.ok) { alert(result.message || "Impossible de mettre à jour la comptabilité."); return; }
                renderPurchases(presentation);
            });
            list.appendChild(item);
        });
        renderBusinessPagination(panel.querySelector("#purchasePagination"), pagination, { singular: "achat", plural: "achats", onPageChange: page => {
            purchasePagination.page = page;
            renderFilteredPurchases();
            list.scrollIntoView({ behavior: "smooth", block: "start" });
        } });
    };
    [search, categoryFilter, accountingFilter].forEach(input => input.addEventListener(input === search ? "input" : "change", () => { purchasePagination.page = 1; renderFilteredPurchases(); }));
    pageSize.addEventListener("change", () => { purchasePagination.pageSize = Number(pageSize.value); purchasePagination.page = 1; renderFilteredPurchases(); });
    renderFilteredPurchases();
}

function createNewPurchase() {
    return { id: null, purchaseDate: today(), category: "Matériel", clientId: "", clientName: "", supplier: "", description: "", reference: "", amountHt: 0, vatRate: 20, isAccounted: false, notes: "" };
}

function normalizePurchase(purchase) {
    return { ...createNewPurchase(), ...purchase, isAccounted: Boolean(purchase.isAccounted) };
}

function calculateTotals(entries) {
    return entries.reduce((totals, entry) => {
        const ht = Number(entry.amountHt) || 0;
        const vat = ht * (Number(entry.vatRate) || 0) / 100;
        return { ht: totals.ht + ht, vat: totals.vat + vat, ttc: totals.ttc + ht + vat };
    }, { ht: 0, vat: 0, ttc: 0 });
}

function formatMoney(value) { return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(Number(value) || 0); }
function formatDate(value) { return value ? new Intl.DateTimeFormat("fr-FR").format(new Date(`${value}T12:00:00`)) : "Date non renseignée"; }
function today() { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function formDataToObject(data) { return Object.fromEntries(data.entries()); }
async function apiRequest(url, options = {}) {
    try {
        const response = await fetch(url, { credentials: "same-origin", ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
        const data = response.status === 204 ? null : await response.json().catch(() => null);
        return { ok: response.ok, data, message: data?.message };
    } catch { return { ok: false, data: null, message: "Serveur indisponible." }; }
}
