import { ROUTES } from "./config.js?v=139";
import { getContainer, setPage } from "./ui.js?v=44";
import { escapeHtml } from "./utils.js?v=44";

let context = { clients: [], documents: [], events: [], purchases: [] };
let activeTab = "overview";

export async function renderBusinessSuite(options = {}) {
    activeTab = normalizedTab(options.tab || activeTab);
    setPage(pageTitle(activeTab), pageRoute(activeTab), "business-suite");
    const container = getContainer();
    container.innerHTML = '<section class="business-suite-shell"><p class="muted">Chargement des données métier…</p></section>';
    try {
        context = await api("/api/business-suite/overview");
        renderShell(container);
    } catch (error) { renderFailure(container, error); }
}

function renderShell(container) {
    const resourceView = resourceTabs().some(([id]) => id === activeTab);
    setPage(pageTitle(activeTab), pageRoute(activeTab), "business-suite");
    const hero = activeTab === "portal"
        ? '<p class=eyebrow>Clients</p><h2>Portail client</h2><p>Partagez les documents et recueillez les décisions sur les devis depuis l’espace Clients.</p>'
        : activeTab === "profitability"
            ? '<p class=eyebrow>Devis & rapports</p><h2>Rentabilité des interventions</h2><p>Mesurez la marge réelle à partir de la facturation, du temps, des pièces et des achats.</p>'
            : '<p class=eyebrow>Ressources</p><h2>Sites, équipements, stocks et véhicules</h2><p>Gérez les moyens nécessaires aux interventions dans un espace métier unique.</p>';
    container.innerHTML = `<section class="business-suite-shell" data-suite-view="${activeTab}"><header class="business-suite-hero"><div>${hero}</div></header>${resourceView ? `<nav class="business-suite-tabs" aria-label="Ressources métier">${resourceTabs().map(([id, label]) => `<button type=button data-suite-tab=${id} class="${id === activeTab ? "active" : ""}">${label}</button>`).join("")}</nav>` : ""}<div data-suite-content></div></section>`;
    container.querySelectorAll("[data-suite-tab]").forEach(button => button.addEventListener("click", () => { activeTab = button.dataset.suiteTab; renderShell(container); }));
    const content = container.querySelector("[data-suite-content]");
    if (activeTab === "portal") return renderPortal(content);
    if (activeTab === "assets") return renderAssets(content);
    if (activeTab === "inventory") return renderInventory(content);
    if (activeTab === "vehicles") return renderVehicles(content);
    if (activeTab === "profitability") return renderProfitability(content);
    return renderAssets(content);
}

async function renderPortal(container) {
    container.innerHTML = `<div class=business-grid><article class=business-panel><h3>Créer un lien client sécurisé</h3><form data-portal-form class=form-grid><label class=form-wide>Client<select name=clientId required>${clientOptions()}</select></label><fieldset class=form-wide data-document-choices><legend>Documents accessibles</legend></fieldset><label>Durée<select name=durationDays><option value=7>7 jours</option><option value=14 selected>14 jours</option><option value=30>30 jours</option><option value=90>90 jours</option></select></label><label><input type=checkbox name=allowQuoteDecision checked> Autoriser la décision sur les devis</label><label class=form-wide>Libellé<input name=label maxlength=160 placeholder="Ex. Documents chantier rue Victor-Hugo"></label><button type=submit>Créer le lien</button></form><div data-portal-result></div></article><article class=business-panel><h3>Liens et décisions</h3><div data-portal-links><p class=muted>Sélectionnez un client.</p></div></article></div>`;
    const form = container.querySelector("[data-portal-form]"), client = form.elements.clientId;
    const refreshChoices = () => {
        const documents = context.documents.filter(document => document.clientId === client.value);
        container.querySelector("[data-document-choices]").innerHTML = `<legend>Documents accessibles</legend>${documents.map(document => `<label><input type=checkbox name=documentIds value=${document.id}> ${escapeHtml(document.documentType === "quote" ? "Devis" : "Facture")} ${escapeHtml(document.documentNumber)}</label>`).join("") || "<p class=muted>Aucun devis ou facture pour ce client.</p>"}`;
        void loadPortalRecords(container, client.value);
    };
    client.addEventListener("change", refreshChoices); refreshChoices();
    form.addEventListener("submit", async event => {
        event.preventDefault();
        const data = new FormData(form), result = container.querySelector("[data-portal-result]");
        try {
            const created = await api("/api/customer-portal/links", { method: "POST", body: { clientId: data.get("clientId"), documentIds: data.getAll("documentIds").map(Number), durationDays: Number(data.get("durationDays")), allowQuoteDecision: data.get("allowQuoteDecision") === "on", label: data.get("label") } });
            result.innerHTML = `<div class=business-success><strong>Lien créé</strong><input readonly value="${escapeHtml(created.url)}"><button type=button data-copy-link>Copier le lien</button><p>Le lien brut n’est affiché qu’ici ; seul son condensat sécurisé est conservé.</p></div>`;
            result.querySelector("[data-copy-link]").addEventListener("click", () => navigator.clipboard?.writeText(created.url));
            await loadPortalRecords(container, client.value);
        } catch (error) { result.innerHTML = `<p class=error>${escapeHtml(error.message)}</p>`; }
    });
}

async function loadPortalRecords(container, clientId) {
    const panel = container.querySelector("[data-portal-links]");
    if (!clientId) { panel.innerHTML = "<p class=muted>Sélectionnez un client.</p>"; return; }
    try {
        const [links, decisions] = await Promise.all([api(`/api/customer-portal/links?clientId=${encodeURIComponent(clientId)}`), api(`/api/customer-portal/quote-decisions?clientId=${encodeURIComponent(clientId)}`)]);
        panel.innerHTML = `<h4>Liens</h4>${links.links.map(link => `<div class=business-row><div><strong>${escapeHtml(link.label || "Accès documentaire")}</strong><small>${link.revokedAt ? "Révoqué" : new Date(link.expiresAt) < new Date() ? "Expiré" : `Actif jusqu’au ${dateLabel(link.expiresAt)}`} · ${link.accessCount} consultation(s)</small></div>${!link.revokedAt ? `<button type=button data-revoke=${link.id}>Révoquer</button>` : ""}</div>`).join("") || "<p class=muted>Aucun lien.</p>"}<h4>Décisions de devis</h4>${decisions.decisions.map(item => `<div class=business-row><div><strong>${escapeHtml(item.documentNumber)} · ${item.decision === "accepted" ? "Accepté" : "Refusé"}</strong><small>${escapeHtml(item.signerName)} · ${dateLabel(item.decidedAt)}</small></div></div>`).join("") || "<p class=muted>Aucune décision.</p>"}`;
        panel.querySelectorAll("[data-revoke]").forEach(button => button.addEventListener("click", async () => { await api(`/api/customer-portal/links/${button.dataset.revoke}/revoke`, { method: "POST" }); await loadPortalRecords(container, clientId); }));
    } catch (error) { panel.innerHTML = `<p class=error>${escapeHtml(error.message)}</p>`; }
}

async function renderAssets(container) {
    container.innerHTML = `<article class=business-panel><label>Client<select data-assets-client>${clientOptions()}</select></label><div data-assets-workspace></div></article>`;
    const select = container.querySelector("[data-assets-client]");
    select.addEventListener("change", () => loadAssets(container, select.value));
    await loadAssets(container, select.value);
}

async function loadAssets(container, clientId) {
    const workspace = container.querySelector("[data-assets-workspace]");
    if (!clientId) { workspace.innerHTML = "<p class=muted>Sélectionnez un client.</p>"; return; }
    try {
        const data = await api(`/api/business-suite/clients/${encodeURIComponent(clientId)}/assets`);
        const clientEvents = context.events.filter(event => event.clientId === clientId);
        workspace.innerHTML = `<div class=business-grid><section><h3>Sites</h3><form data-site-form class=form-grid><label>Nom<input name=name required maxlength=160></label><label>Ville<input name=city maxlength=120></label><label class=form-wide>Adresse<input name=address maxlength=500></label><button type=submit>Ajouter le site</button></form>${recordList(data.sites, item => `${item.name} · ${item.city || item.address || "Adresse non renseignée"}`, "sites")}</section><section><h3>Équipements</h3><form data-equipment-form class=form-grid><label>Nom<input name=name required maxlength=160></label><label>Site<select name=siteId>${optionList(data.sites)}</select></label><label>Catégorie<input name=category maxlength=100></label><label>Marque / modèle<input name=brand maxlength=100></label><button type=submit>Ajouter l’équipement</button></form>${recordList(data.equipment, item => `${item.name} · ${[item.brand,item.model,item.serialNumber].filter(Boolean).join(" · ") || item.status}`, "equipment")}</section><section><h3>Contrats de maintenance</h3><form data-contract-form class=form-grid><label>Référence<input name=reference required maxlength=100></label><label>Titre<input name=title required maxlength=160></label><label>Début<input name=startsOn type=date required></label><label>Fin<input name=endsOn type=date></label><label>Prochaine visite<input name=nextServiceOn type=date></label><label>Fréquence (mois)<input name=frequencyMonths type=number min=1 max=120 value=12></label><label>Montant annuel HT<input name=annualAmountHt type=number min=0 step=.01 value=0></label><button type=submit>Ajouter le contrat</button></form>${recordList(data.contracts, item => `${item.reference} · ${item.title} · ${item.status}`, "contracts")}</section><section><h3>Lier une intervention au parc</h3><form data-event-assets class=form-grid><label>Intervention<select name=eventId required>${optionList(clientEvents,"title")}</select></label><label>Site<select name=siteId>${optionList(data.sites)}</select></label><label>Équipement<select name=equipmentId>${optionList(data.equipment)}</select></label><label>Contrat<select name=contractId>${optionList(data.contracts,"title")}</select></label><button type=submit>Enregistrer les liens</button></form></section></div>`;
        bindJsonForm(workspace.querySelector("[data-site-form]"), `/api/business-suite/clients/${encodeURIComponent(clientId)}/sites`, () => loadAssets(container, clientId));
        bindJsonForm(workspace.querySelector("[data-equipment-form]"), `/api/business-suite/clients/${encodeURIComponent(clientId)}/equipment`, () => loadAssets(container, clientId));
        bindJsonForm(workspace.querySelector("[data-contract-form]"), `/api/business-suite/clients/${encodeURIComponent(clientId)}/contracts`, () => loadAssets(container, clientId));
        workspace.querySelector("[data-event-assets]").addEventListener("submit", async event => { event.preventDefault(); const values=Object.fromEntries(new FormData(event.currentTarget)); await api(`/api/business-suite/events/${values.eventId}/assets`,{method:"PATCH",body:{siteId:values.siteId||null,equipmentId:values.equipmentId||null,contractId:values.contractId||null}}); alert("Intervention reliée au parc client."); });
        workspace.querySelectorAll("[data-delete-resource]").forEach(button => button.addEventListener("click", async () => { if (!confirm("Supprimer cet élément ?")) return; await api(`/api/business-suite/${button.dataset.deleteResource}/${button.dataset.id}`, { method: "DELETE" }); await loadAssets(container, clientId); }));
    } catch (error) { workspace.innerHTML = `<p class=error>${escapeHtml(error.message)}</p>`; }
}

async function renderInventory(container) {
    container.innerHTML = "<p class=muted>Chargement du stock…</p>";
    try {
        const data = await api("/api/business-suite/inventory");
        const warehouses = data.locations.filter(item => item.locationType === "warehouse");
        container.innerHTML = `<div class=business-grid><article class=business-panel><h3>Dépôts</h3><form data-location-form class=form-grid><input type=hidden name=locationType value=warehouse><label>Nom du dépôt<input name=name required></label><button type=submit>Ajouter le dépôt</button></form>${warehouses.map(item => `<div class=business-row><strong>${escapeHtml(item.name)}</strong><small>Dépôt</small></div>`).join("") || "<p class=muted>Aucun dépôt.</p>"}</article><article class=business-panel><h3>Articles</h3><form data-item-form class=form-grid><label>Référence<input name=sku required></label><label>Nom<input name=name required></label><label>Coût unitaire<input name=defaultUnitCost type=number min=0 step=.01></label><label>Seuil d’alerte<input name=reorderLevel type=number min=0 step=.001></label><button type=submit>Ajouter</button></form>${data.items.map(item => `<div class=business-row><div><strong>${escapeHtml(item.sku)} · ${escapeHtml(item.name)}</strong><small>Disponible : ${numberLabel(item.quantity)} ${escapeHtml(item.unit)} · seuil ${numberLabel(item.reorderLevel)}</small></div></div>`).join("")}</article><article class=business-panel><h3>Mouvement de stock</h3><form data-movement-form class=form-grid><label>Article<select name=itemId required>${optionList(data.items, "name")}</select></label><label>Emplacement<select name=locationId required>${optionList(data.locations)}</select></label><label>Type<select name=movementType><option value=in>Entrée</option><option value=out>Sortie</option><option value=consumption>Consommation intervention</option><option value=adjustment>Ajustement signé</option></select></label><label>Quantité<input name=quantity type=number step=.001 required></label><label>Coût unitaire<input name=unitCost type=number min=0 step=.01></label><label>Intervention<select name=eventId>${optionList(context.events, "title")}</select></label><label class=form-wide>Motif<input name=reason maxlength=500></label><button type=submit>Enregistrer</button></form></article><article class="business-panel business-wide"><h3>Derniers mouvements</h3>${data.movements.map(item => `<div class=business-row><div><strong>${escapeHtml(item.itemName)} · ${numberLabel(item.quantity)}</strong><small>${escapeHtml(item.locationName)} · ${escapeHtml(item.movementType)} · ${dateLabel(item.createdAt)}${item.eventId ? ` · intervention ${item.eventId}` : ""}</small></div></div>`).join("") || "<p class=muted>Aucun mouvement.</p>"}</article></div>`;
        bindJsonForm(container.querySelector("[data-location-form]"), "/api/business-suite/inventory/locations", () => renderInventory(container));
        bindJsonForm(container.querySelector("[data-item-form]"), "/api/business-suite/inventory/items", () => renderInventory(container));
        bindJsonForm(container.querySelector("[data-movement-form]"), "/api/business-suite/inventory/movements", () => renderInventory(container));
    } catch (error) { renderFailure(container, error); }
}

async function renderVehicles(container) {
    container.innerHTML = "<p class=muted>Chargement des véhicules…</p>";
    try {
        const data = await api("/api/business-suite/inventory");
        const vehicles = data.locations.filter(item => item.locationType === "vehicle");
        container.innerHTML = `<article class=business-panel><h3>Véhicules et stocks embarqués</h3><p class=muted>Chaque véhicule constitue un emplacement de stock utilisable dans les mouvements et consommations d’intervention.</p><form data-vehicle-form class=form-grid><input type=hidden name=locationType value=vehicle><label>Nom du véhicule<input name=name required placeholder="Ex. Fourgon Nantes 1"></label><label>Immatriculation<input name=vehicleRegistration maxlength=40></label><button type=submit>Ajouter le véhicule</button></form>${vehicles.map(item => `<div class=business-row><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.vehicleRegistration || "Immatriculation non renseignée")}</small></div></div>`).join("") || "<p class=muted>Aucun véhicule enregistré.</p>"}</article>`;
        bindJsonForm(container.querySelector("[data-vehicle-form]"), "/api/business-suite/inventory/locations", () => renderVehicles(container));
    } catch (error) { renderFailure(container, error); }
}

function renderProfitability(container) {
    const canConfigure = ["admin", "pc_standard", "mobile_admin"].includes(document.body.dataset.role);
    container.innerHTML = `<div class=business-grid><article class=business-panel><h3>Rentabilité réelle d’une intervention</h3><p class=muted>Chiffre d’affaires HT des factures émises moins temps valorisé, pièces consommées et achats affectés.</p><label>Intervention<select data-profit-event>${optionList(context.events, "title")}</select></label><div data-profit-result></div></article><article class=business-panel><h3>Affecter un achat</h3><form data-purchase-allocation class=form-grid><label>Achat<select name=purchaseId required>${optionList(context.purchases || [], "description")}</select></label><label>Intervention<select name=eventId required>${optionList(context.events, "title")}</select></label><button type=submit>Affecter au coût réel</button></form>${canConfigure ? `<h3>Coûts horaires chargés</h3><form data-labor-cost class=form-grid><label>Rôle<select name=role><option value=technician>Technicien</option><option value=team_lead>Chef d’équipe</option><option value=mobile_admin>Admin mobile</option></select></label><label>Coût horaire<input name=hourlyCost type=number min=0 step=.01 required></label><button type=submit>Enregistrer</button></form>` : ""}</article></div>`;
    const select = container.querySelector("[data-profit-event]"), result = container.querySelector("[data-profit-result]");
    const load = async () => {
        if (!select.value) { result.innerHTML = "<p class=muted>Sélectionnez une intervention.</p>"; return; }
        try { const { profitability: item } = await api(`/api/business-suite/events/${select.value}/profitability`); result.innerHTML = `<div class=business-metrics><article><strong>${moneyLabel(item.revenueHt)}</strong><span>CA HT</span></article><article><strong>${moneyLabel(item.laborCost)}</strong><span>Main-d’œuvre (${numberLabel(item.laborHours)} h)</span></article><article><strong>${moneyLabel(item.partsCost + item.purchasesCost)}</strong><span>Pièces et achats</span></article><article><strong class="${item.margin < 0 ? "negative" : "positive"}">${moneyLabel(item.margin)}</strong><span>Marge${item.marginRate === null ? "" : ` · ${numberLabel(item.marginRate)} %`}</span></article></div>`; } catch (error) { result.innerHTML = `<p class=error>${escapeHtml(error.message)}</p>`; }
    };
    select.addEventListener("change", load); void load();
    container.querySelector("[data-purchase-allocation]").addEventListener("submit", async event => { event.preventDefault(); const data=new FormData(event.currentTarget); await api(`/api/business-suite/purchases/${data.get("purchaseId")}/event`,{method:"PATCH",body:{eventId:Number(data.get("eventId"))}}); if(String(select.value)===String(data.get("eventId"))) await load(); });
    container.querySelector("[data-labor-cost]")?.addEventListener("submit", async event => { event.preventDefault(); const data=new FormData(event.currentTarget); await api(`/api/business-suite/labor-costs/${encodeURIComponent(data.get("role"))}`,{method:"PUT",body:{hourlyCost:Number(data.get("hourlyCost"))}}); if(select.value) await load(); });
}

function bindJsonForm(form, url, complete) {
    form?.addEventListener("submit", async event => {
        event.preventDefault(); const button = form.querySelector("button[type=submit]"); button.disabled = true;
        try { await api(url, { method: "POST", body: Object.fromEntries(new FormData(form)) }); await complete(); }
        catch (error) { alert(error.message); button.disabled = false; }
    });
}
function recordList(items, label, resource) { return items.map(item => `<div class=business-row><div><strong>${escapeHtml(label(item))}</strong></div><button type=button data-delete-resource=${resource} data-id=${item.id}>Supprimer</button></div>`).join("") || "<p class=muted>Aucun élément.</p>"; }
function clientOptions() { return `<option value="">Choisir un client</option>${context.clients.map(client => `<option value="${escapeHtml(client.id)}">${escapeHtml(client.name || client.id)}</option>`).join("")}`; }
function optionList(items, field="name") { return `<option value="">Aucun / choisir</option>${items.map(item => `<option value=${item.id}>${escapeHtml(item[field] || item.documentNumber || item.id)}${item.eventDate ? ` · ${escapeHtml(item.eventDate)}` : ""}</option>`).join("")}`; }
function resourceTabs() { return [["assets","Sites & équipements"],["inventory","Stock"],["vehicles","Véhicules"]]; }
function normalizedTab(value) { return ["portal", "profitability", ...resourceTabs().map(([id]) => id)].includes(value) ? value : "assets"; }
function pageTitle(tab) { return tab === "portal" ? "Clients · Portail client" : tab === "profitability" ? "Devis & rapports · Rentabilité" : `Ressources · ${resourceTabs().find(([id]) => id === tab)?.[1] || "Sites & équipements"}`; }
function pageRoute(tab) { return tab === "portal" ? ROUTES.clients : tab === "profitability" ? ROUTES.billing : ROUTES.businessSuite; }
async function api(url, options={}) { const response=await fetch(url,{method:options.method||"GET",credentials:"same-origin",headers:options.body?{"Content-Type":"application/json"}:undefined,body:options.body?JSON.stringify(options.body):undefined}); if(response.status===204)return null; const payload=await response.json().catch(()=>({})); if(!response.ok)throw new Error(payload.message||"Opération impossible."); return payload; }
function renderFailure(container,error){container.innerHTML=`<article class=business-panel><p class=error>${escapeHtml(error.message||"Chargement impossible.")}</p></article>`;} function dateLabel(value){return value?new Date(value).toLocaleDateString("fr-FR"):"—";} function numberLabel(value){return new Intl.NumberFormat("fr-FR",{maximumFractionDigits:3}).format(Number(value)||0);} function moneyLabel(value){return new Intl.NumberFormat("fr-FR",{style:"currency",currency:"EUR"}).format(Number(value)||0);}
