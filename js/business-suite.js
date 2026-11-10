import { ROUTES } from "./config.js?v=139";
import { getContainer, setPage } from "./ui.js?v=44";
import { escapeHtml } from "./utils.js?v=44";
import { markDesktopWorkspaceDraftSaved } from "./desktop-workspace.js?v=6";

let context = { clients: [], documents: [], events: [], purchases: [] };
let activeTab = "overview";
let selectedClientId = "";
let selectedEventId = "";

export async function renderBusinessSuite(options = {}) {
    activeTab = normalizedTab(options.tab || activeTab);
    if (options.clientId !== undefined) selectedClientId = String(options.clientId || "");
    if (options.eventId !== undefined) selectedEventId = String(options.eventId || "");
    setPage(pageTitle(activeTab), pageRoute(activeTab), "business-suite");
    const container = getContainer();
    container.innerHTML = `<section class="business-suite-shell" data-suite-view="${activeTab}" data-suite-selected-client="${escapeHtml(selectedClientId)}" data-suite-selected-event="${escapeHtml(selectedEventId)}"><p class="muted">Chargement des données métier…</p></section>`;
    const loadingShell = container.firstElementChild;
    try {
        const nextContext = await api("/api/business-suite/overview");
        if (!loadingShell?.isConnected || container.firstElementChild !== loadingShell) return;
        context = nextContext;
        renderShell(container);
    } catch (error) {
        if (loadingShell?.isConnected && container.firstElementChild === loadingShell) renderFailure(container, error);
    }
}

function renderShell(container) {
    const resourceView = resourceTabs().some(([id]) => id === activeTab);
    setPage(pageTitle(activeTab), pageRoute(activeTab), "business-suite");
    const hero = activeTab === "portal"
        ? '<p class=eyebrow>Clients</p><h2>Portail client</h2><p>Partagez les documents et recueillez les décisions sur les devis depuis l’espace Clients.</p>'
        : activeTab === "profitability"
            ? '<p class=eyebrow>Devis & rapports</p><h2>Rentabilité des interventions</h2><p>Mesurez la marge réelle à partir de la facturation, du temps, des pièces et des achats.</p>'
            : '<p class=eyebrow>Ressources</p><h2>Sites, équipements, stocks et véhicules</h2><p>Gérez les moyens nécessaires aux interventions dans un espace métier unique.</p>';
    container.innerHTML = `<section class="business-suite-shell" data-suite-view="${activeTab}" data-suite-selected-client="${escapeHtml(selectedClientId)}" data-suite-selected-event="${escapeHtml(selectedEventId)}"><header class="business-suite-hero"><div>${hero}</div></header>${resourceView ? `<nav class="business-suite-tabs" aria-label="Ressources métier">${resourceTabs().map(([id, label]) => `<button type=button data-suite-tab=${id} class="${id === activeTab ? "active" : ""}">${label}</button>`).join("")}</nav>` : ""}<div data-suite-content></div></section>`;
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
    container.innerHTML = `<div class=business-grid><article class=business-panel><h3>Créer un lien client sécurisé</h3><form data-portal-form class=form-grid><label class=form-wide>Client<select name=clientId required>${clientOptions()}</select></label><fieldset class=form-wide data-document-choices><legend>Documents accessibles</legend></fieldset><label>Durée<select name=durationDays><option value=7>7 jours</option><option value=14 selected>14 jours</option><option value=30>30 jours</option><option value=90>90 jours</option></select></label><label><input type=checkbox name=allowQuoteDecision checked> Autoriser la décision sur les devis</label><label class=form-wide><input type=checkbox name=sendEmail> Envoyer le lien au client par e-mail</label><label class=form-wide>Libellé<input name=label maxlength=160 placeholder="Ex. Documents chantier rue Victor-Hugo"></label><button type=submit>Créer le lien</button></form><div data-portal-result></div></article><article class=business-panel><h3>Liens et décisions</h3><div data-portal-links><p class=muted>Sélectionnez un client.</p></div></article></div>`;
    const form = container.querySelector("[data-portal-form]"), client = form.elements.clientId;
    if ([...client.options].some(option => option.value === selectedClientId)) client.value = selectedClientId;
    const refreshChoices = () => {
        selectedClientId = client.value;
        const documents = context.documents.filter(document => document.clientId === client.value);
        container.querySelector("[data-document-choices]").innerHTML = `<legend>Documents accessibles</legend>${documents.map(document => `<label><input type=checkbox name=documentIds value=${document.id}> ${escapeHtml(document.documentType === "quote" ? "Devis" : "Facture")} ${escapeHtml(document.documentNumber)}</label>`).join("") || "<p class=muted>Aucun devis ou facture pour ce client.</p>"}`;
        void loadPortalRecords(container, client.value);
    };
    client.addEventListener("change", () => { refreshChoices(); announceViewChange(); }); refreshChoices();
    form.addEventListener("submit", async event => {
        event.preventDefault();
        const data = new FormData(form), result = container.querySelector("[data-portal-result]");
        try {
            const created = await api("/api/customer-portal/links", { method: "POST", body: { clientId: data.get("clientId"), documentIds: data.getAll("documentIds").map(Number), durationDays: Number(data.get("durationDays")), allowQuoteDecision: data.get("allowQuoteDecision") === "on", sendEmail: data.get("sendEmail") === "on", label: data.get("label") } });
            markDesktopWorkspaceDraftSaved();
            const emailStatus = created.emailSent ? "<p>E-mail envoyé au client.</p>" : created.emailWarning ? `<p class=error>${escapeHtml(created.emailWarning)}</p>` : "<p>Envoyez le lien au client par le canal de votre choix.</p>";
            result.innerHTML = `<div class=business-success><strong>Lien créé</strong><input readonly value="${escapeHtml(created.url)}"><button type=button data-copy-link>Copier le lien</button><p>Le lien brut n’est affiché qu’ici ; seul son condensat sécurisé est conservé.</p>${emailStatus}</div>`;
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
        panel.innerHTML = `<h4>Liens</h4>${links.links.map(link => `<div class=business-row><div><strong>${escapeHtml(link.label || "Accès documentaire")}</strong><small>${link.revokedAt ? "Révoqué" : new Date(link.expiresAt) < new Date() ? "Expiré" : `Actif jusqu’au ${dateLabel(link.expiresAt)}`} · ${link.accessCount} consultation(s)</small></div>${!link.revokedAt ? `<button type=button data-revoke=${link.id}>Révoquer</button>` : ""}</div>`).join("") || "<p class=muted>Aucun lien.</p>"}<h4>Décisions de devis</h4>${decisions.decisions.map(item => `<div class=business-row><div><strong>${escapeHtml(item.documentNumber)} · ${item.decision === "accepted" ? "Accepté" : "Refusé"}</strong><small>${escapeHtml(item.signerName)} · ${dateLabel(item.decidedAt)} · E-mail ${item.notificationStatus === "sent" ? "envoyé" : "à vérifier"}</small></div>${item.notificationStatus !== "sent" ? `<button type=button data-notify=${item.documentId}>Renvoyer l’e-mail</button>` : ""}</div>`).join("") || "<p class=muted>Aucune décision.</p>"}`;
        panel.querySelectorAll("[data-revoke]").forEach(button => button.addEventListener("click", async () => { await api(`/api/customer-portal/links/${button.dataset.revoke}/revoke`, { method: "POST" }); await loadPortalRecords(container, clientId); }));
        panel.querySelectorAll("[data-notify]").forEach(button => button.addEventListener("click", async () => { try { await api(`/api/customer-portal/quote-decisions/${button.dataset.notify}/notify`, { method: "POST" }); await loadPortalRecords(container, clientId); } catch (error) { panel.insertAdjacentHTML("afterbegin", `<p class=error>${escapeHtml(error.message)}</p>`); } }));
    } catch (error) { panel.innerHTML = `<p class=error>${escapeHtml(error.message)}</p>`; }
}

async function renderAssets(container) {
    container.innerHTML = `<article class=business-panel><label>Client<select data-assets-client>${clientOptions()}</select></label><div data-assets-workspace></div></article>`;
    const select = container.querySelector("[data-assets-client]");
    if ([...select.options].some(option => option.value === selectedClientId)) select.value = selectedClientId;
    select.addEventListener("change", () => { selectedClientId = select.value; announceViewChange(); loadAssets(container, select.value); });
    await loadAssets(container, select.value);
}

async function loadAssets(container, clientId) {
    const workspace = container.querySelector("[data-assets-workspace]");
    if (!clientId) { workspace.innerHTML = "<p class=muted>Sélectionnez un client.</p>"; return; }
    try {
        const data = await api(`/api/business-suite/clients/${encodeURIComponent(clientId)}/assets`);
        if (!workspace.isConnected || container.querySelector("[data-assets-client]")?.value !== clientId) return;
        const clientEvents = context.events.filter(event => event.clientId === clientId);
        const canEditContracts = ["admin", "pc_standard", "commercial", "mobile_admin"].includes(document.body.dataset.role);
        const canManageContractTemplate = ["admin", "pc_standard", "mobile_admin"].includes(document.body.dataset.role);
        workspace.innerHTML = `<div class=business-grid>
            ${canManageContractTemplate ? `<section class="business-panel form-wide" data-contract-template-panel><h3>Modèle de contrat de maintenance</h3><p class=muted>Personnalisez les clauses reprises dans les prochains PDF. Faites vérifier leur conformité avant toute signature. Les documents déjà générés restent inchangés.</p><p class=muted data-contract-template-message aria-live=polite></p><p class=muted>Chargement du modèle…</p></section>` : ""}
            <section><h3>Sites</h3>${canEditContracts ? '<form data-site-form class=form-grid><label>Nom<input name=name required maxlength=160></label><label>Ville<input name=city maxlength=120></label><label class=form-wide>Adresse<input name=address maxlength=500></label><button type=submit>Ajouter le site</button></form>' : ""}${recordList(data.sites, item => `${item.name} · ${item.city || item.address || "Adresse non renseignée"}`, "sites")}</section>
            <section><h3>Équipements</h3>${canEditContracts ? `<form data-equipment-form class=form-grid><label>Nom<input name=name required maxlength=160></label><label>Site<select name=siteId>${optionList(data.sites)}</select></label><label>Catégorie<input name=category maxlength=100></label><label>Marque / modèle<input name=brand maxlength=100></label><button type=submit>Ajouter l’équipement</button></form>` : ""}${recordList(data.equipment, item => `${item.name} · ${[item.brand,item.model,item.serialNumber].filter(Boolean).join(" · ") || item.status}`, "equipment")}</section>
            <section class="form-wide"><h3>Contrats de maintenance</h3>
                ${canEditContracts ? `<form data-contract-form class=form-grid>
                    <label>Référence<input name=reference required maxlength=100></label><label>Titre<input name=title required maxlength=160></label>
                    <label>Statut initial<select name=status><option value=draft selected>Brouillon - à signer</option><option value=active>Actif - déjà signé hors logiciel</option></select></label>
                    <label>Début<input name=startsOn type=date required></label><label>Fin<input name=endsOn type=date></label>
                    <label>Prochaine visite<input name=nextServiceOn type=date></label><label>Fréquence des visites (mois)<input name=frequencyMonths type=number min=1 max=120 value=12></label>
                    <label>Montant annuel HT<input name=annualAmountHt type=number min=0 step=.01 value=0></label>
                    <label class=form-wide>Prestations prévues<input name=serviceDescription maxlength=5000></label>
                    <label>Montant HT par facture<input name=billingAmountHt type=number min=0 step=.01 value=0></label>
                    <label>Intervalle de facturation (mois)<input name=billingIntervalMonths type=number min=1 max=120 value=12></label>
                    <label>TVA (%)<input name=billingVatRate type=number min=0 max=100 step=.01 value=20></label>
                    <label>Première échéance de facturation<input name=nextInvoiceOn type=date></label>
                    <p class="muted form-wide">Les échéances périodiques créent uniquement un brouillon de facture à contrôler. Aucune facture n’est émise ou envoyée automatiquement.</p>
                    <button type=submit>Ajouter la fiche de contrat</button>
                </form>` : ""}
                ${contractList(data.contracts, canEditContracts)}
            </section>
            <section class="form-wide"><h3>Lier une intervention au parc</h3><form data-event-assets class=form-grid><label>Intervention<select name=eventId required>${optionList(clientEvents,"title")}</select></label><label>Site<select name=siteId>${optionList(data.sites)}</select></label><label>Équipement<select name=equipmentId>${optionList(data.equipment)}</select></label><label>Contrat<select name=contractId>${optionList(data.contracts,"title")}</select></label><button type=submit>Enregistrer les liens</button></form></section>
        </div>`;
        if (canManageContractTemplate) void loadContractTemplate(workspace);
        bindJsonForm(workspace.querySelector("[data-site-form]"), `/api/business-suite/clients/${encodeURIComponent(clientId)}/sites`, () => loadAssets(container, clientId));
        bindJsonForm(workspace.querySelector("[data-equipment-form]"), `/api/business-suite/clients/${encodeURIComponent(clientId)}/equipment`, () => loadAssets(container, clientId));
        bindJsonForm(workspace.querySelector("[data-contract-form]"), `/api/business-suite/clients/${encodeURIComponent(clientId)}/contracts`, () => loadAssets(container, clientId));
        workspace.querySelectorAll("[data-contract-schedule]").forEach(form => bindPatchForm(form, `/api/business-suite/clients/${encodeURIComponent(clientId)}/contracts/${encodeURIComponent(form.dataset.contractSchedule)}/schedule`, () => loadAssets(container, clientId)));
        workspace.querySelectorAll("[data-contract-generate]").forEach(button => button.addEventListener("click", async () => {
            button.disabled = true;
            try { await api(`/api/business-suite/contracts/${button.dataset.contractGenerate}/documents/generate`, { method: "POST", body: {} }); markDesktopWorkspaceDraftSaved(); await loadAssets(container, clientId); }
            catch (error) { alert(error.message || "Impossible de générer le projet de contrat."); button.disabled = false; }
        }));
        workspace.querySelectorAll("[data-contract-signed]").forEach(form => form.addEventListener("submit", async event => {
            event.preventDefault();
            const button = form.querySelector("button[type=submit]");
            const message = form.querySelector("[data-signed-message]");
            button.disabled = true;
            message.textContent = "Archivage…";
            try {
                const response = await fetch(`/api/business-suite/contracts/${encodeURIComponent(form.dataset.contractSigned)}/documents/signed`, { method: "POST", credentials: "same-origin", body: new FormData(form) });
                const result = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(result.message || "Impossible d’archiver le PDF signé.");
                markDesktopWorkspaceDraftSaved();
                await loadAssets(container, clientId);
            } catch (error) {
                message.textContent = error.message || "Impossible d’archiver le PDF signé.";
                button.disabled = false;
            }
        }));
        workspace.querySelectorAll("[data-contract-invoice-draft]").forEach(button => button.addEventListener("click", async () => {
            button.disabled = true;
            try {
                const draft = await api(`/api/business-suite/contracts/${button.dataset.contractInvoiceDraft}/invoice-drafts`, { method: "POST", body: {} });
                markDesktopWorkspaceDraftSaved();
                window.dispatchEvent(new CustomEvent("depannhome:open-billing-document", { detail: { documentId: draft.id } }));
            } catch (error) { alert(error.message || "Impossible de créer le brouillon de facture."); button.disabled = false; }
        }));
        workspace.querySelectorAll("[data-open-contract-invoice]").forEach(button => button.addEventListener("click", () => {
            window.dispatchEvent(new CustomEvent("depannhome:open-billing-document", { detail: { documentId: button.dataset.openContractInvoice } }));
        }));
        workspace.querySelectorAll("[data-contract-renew]").forEach(form => bindJsonForm(form, `/api/business-suite/contracts/${encodeURIComponent(form.dataset.contractRenew)}/renew`, () => loadAssets(container, clientId)));
        workspace.querySelector("[data-event-assets]").addEventListener("submit", async event => { event.preventDefault(); const values=Object.fromEntries(new FormData(event.currentTarget)); await api(`/api/business-suite/events/${values.eventId}/assets`,{method:"PATCH",body:{siteId:values.siteId||null,equipmentId:values.equipmentId||null,contractId:values.contractId||null}}); markDesktopWorkspaceDraftSaved(); alert("Intervention reliée au parc client."); });
        workspace.querySelectorAll("[data-delete-resource]").forEach(button => button.addEventListener("click", async () => { if (!confirm("Supprimer cet élément ?")) return; await api(`/api/business-suite/${button.dataset.deleteResource}/${button.dataset.id}`, { method: "DELETE" }); await loadAssets(container, clientId); }));
    } catch (error) {
        if (workspace.isConnected && container.querySelector("[data-assets-client]")?.value === clientId) workspace.innerHTML = `<p class=error>${escapeHtml(error.message)}</p>`;
    }
}

async function renderInventory(container) {
    container.innerHTML = "<p class=muted>Chargement du stock…</p>";
    try {
        const data = await api("/api/business-suite/inventory");
        if (!Array.isArray(data.balances)) throw new Error("La répartition du stock est indisponible. Actualisez l’application ou contactez votre administrateur.");
        const warehouses = data.locations.filter(item => item.locationType === "warehouse");
        const activeLocations = data.locations.filter(item => item.isActive);
        const activeItems = data.items.filter(item => item.isActive);
        const balancesByItem = groupInventoryBalances(data.balances, "itemId");
        const canTransfer = ["admin", "pc_standard", "commercial", "mobile_admin"].includes(document.body.dataset.role);
        const canEditThreshold = ["admin", "pc_standard", "mobile_admin"].includes(document.body.dataset.role);
        const articleRows = data.items.map(item => {
            const balances = balancesByItem.get(String(item.id)) || [];
            const low = item.isActive && Number(item.quantity) <= Number(item.reorderLevel);
            return `<div class=business-row><div><strong>${escapeHtml(item.sku)} · ${escapeHtml(item.name)}${item.isActive ? "" : " · inactif"}</strong><small>Disponible total : ${numberLabel(item.quantity)} ${escapeHtml(item.unit)} · seuil ${numberLabel(item.reorderLevel)}${low ? " · Stock faible" : ""}</small><small>${balances.map(balance => `${escapeHtml(balance.locationName)} (${balance.locationType === "vehicle" ? "véhicule" : "dépôt"}${balance.locationIsActive === false ? " inactif" : ""}) : ${numberLabel(balance.quantity)} ${escapeHtml(item.unit)}`).join(" · ") || "Aucun mouvement par emplacement."}</small>${canEditThreshold ? `<form class="business-threshold-form" data-item-threshold="${escapeHtml(String(item.id))}"><label>Seuil d’alerte<input name=reorderLevel type=number min=0 max=100000000 step=.001 value="${escapeHtml(String(item.reorderLevel))}" required></label><button type=submit class=secondary-button>Enregistrer le seuil</button><span class="auth-message error" data-patch-error aria-live=polite></span></form>` : ""}</div></div>`;
        }).join("");
        const transfer = canTransfer ? `<article class=business-panel><h3>Transférer entre emplacements</h3><p class=muted>Le transfert conserve le total et vérifie le stock de l’emplacement source.</p><form data-transfer-form class=form-grid><label>Article<select name=itemId required>${optionList(activeItems, "name")}</select></label><label>Depuis<select name=fromLocationId required>${optionList(activeLocations)}</select></label><label>Vers<select name=toLocationId required>${optionList(activeLocations)}</select></label><label>Quantité<input name=quantity type=number min=.001 step=.001 required></label><label class=form-wide>Motif<input name=reason maxlength=500></label><button type=submit>Transférer</button></form></article>` : "";
        container.innerHTML = `<div class=business-grid><article class=business-panel><h3>Dépôts</h3><form data-location-form class=form-grid><input type=hidden name=locationType value=warehouse><label>Nom du dépôt<input name=name required></label><button type=submit>Ajouter le dépôt</button></form>${warehouses.map(item => `<div class=business-row><strong>${escapeHtml(item.name)}</strong><small>Dépôt</small></div>`).join("") || "<p class=muted>Aucun dépôt.</p>"}</article><article class=business-panel><h3>Articles</h3><form data-item-form class=form-grid><label>Référence<input name=sku required></label><label>Nom<input name=name required></label><label>Coût unitaire<input name=defaultUnitCost type=number min=0 step=.01></label><label>Seuil d’alerte<input name=reorderLevel type=number min=0 step=.001></label><button type=submit>Ajouter</button></form>${articleRows || "<p class=muted>Aucun article.</p>"}</article><article class=business-panel><h3>Mouvement de stock</h3><form data-movement-form class=form-grid><label>Article<select name=itemId required>${optionList(data.items, "name")}</select></label><label>Emplacement<select name=locationId required>${optionList(data.locations)}</select></label><label>Type<select name=movementType><option value=in>Entrée</option><option value=out>Sortie</option><option value=consumption>Consommation intervention</option><option value=adjustment>Ajustement signé</option></select></label><label>Quantité<input name=quantity type=number step=.001 required></label><label>Coût unitaire<input name=unitCost type=number min=0 step=.01></label><label>Intervention<select name=eventId>${optionList(context.events, "title")}</select></label><label class=form-wide>Motif<input name=reason maxlength=500></label><button type=submit>Enregistrer</button></form></article>${transfer}<article class="business-panel business-wide"><h3>Derniers mouvements</h3>${data.movements.map(item => `<div class=business-row><div><strong>${escapeHtml(item.itemName)} · ${numberLabel(item.quantity)}</strong><small>${escapeHtml(item.locationName)} · ${escapeHtml(item.movementType)} · ${dateLabel(item.createdAt)}${item.eventId ? ` · intervention ${item.eventId}` : ""}</small></div></div>`).join("") || "<p class=muted>Aucun mouvement.</p>"}</article></div>`;
        bindJsonForm(container.querySelector("[data-location-form]"), "/api/business-suite/inventory/locations", () => renderInventory(container));
        bindJsonForm(container.querySelector("[data-item-form]"), "/api/business-suite/inventory/items", () => renderInventory(container));
        container.querySelectorAll("[data-item-threshold]").forEach(form => bindPatchForm(form, `/api/business-suite/inventory/items/${encodeURIComponent(form.dataset.itemThreshold)}/threshold`, () => renderInventory(container)));
        bindJsonForm(container.querySelector("[data-movement-form]"), "/api/business-suite/inventory/movements", () => renderInventory(container));
        bindJsonForm(container.querySelector("[data-transfer-form]"), "/api/business-suite/inventory/transfers", () => renderInventory(container));
    } catch (error) { renderFailure(container, error); }
}

async function renderVehicles(container) {
    container.innerHTML = "<p class=muted>Chargement des véhicules…</p>";
    try {
        const data = await api("/api/business-suite/inventory");
        if (!Array.isArray(data.balances)) throw new Error("Le stock des véhicules est indisponible. Actualisez l’application ou contactez votre administrateur.");
        const vehicles = data.locations.filter(item => item.locationType === "vehicle");
        const balancesByLocation = groupInventoryBalances(data.balances, "locationId");
        const itemsById = new Map(data.items.map(item => [String(item.id), item]));
        container.innerHTML = `<article class=business-panel><h3>Véhicules et stocks embarqués</h3><p class=muted>Chaque véhicule constitue un emplacement de stock utilisable dans les mouvements et consommations d’intervention.</p><form data-vehicle-form class=form-grid><input type=hidden name=locationType value=vehicle><label>Nom du véhicule<input name=name required placeholder="Ex. Fourgon Nantes 1"></label><label>Immatriculation<input name=vehicleRegistration maxlength=40></label><button type=submit>Ajouter le véhicule</button></form>${vehicles.map(vehicle => {
            const balances = balancesByLocation.get(String(vehicle.id)) || [];
            const stock = balances.map(balance => {
                const item = itemsById.get(String(balance.itemId));
                if (!item) throw new Error("Un article du stock véhicule est introuvable. Actualisez l’application ou contactez votre administrateur.");
                return `${escapeHtml(item.name)} : ${numberLabel(balance.quantity)} ${escapeHtml(item.unit)}`;
            }).join(" · ");
            return `<div class=business-row><div><strong>${escapeHtml(vehicle.name)}${vehicle.isActive ? "" : " · inactif"}</strong><small>${escapeHtml(vehicle.vehicleRegistration || "Immatriculation non renseignée")}</small><small>${stock || "Aucun mouvement de stock."}</small></div></div>`;
        }).join("") || "<p class=muted>Aucun véhicule enregistré.</p>"}</article>`;
        bindJsonForm(container.querySelector("[data-vehicle-form]"), "/api/business-suite/inventory/locations", () => renderVehicles(container));
    } catch (error) { renderFailure(container, error); }
}

function renderProfitability(container) {
    const canConfigure = ["admin", "pc_standard", "mobile_admin"].includes(document.body.dataset.role);
    container.innerHTML = `<div class=business-grid><article class=business-panel><h3>Rentabilité réelle d’une intervention</h3><p class=muted>Chiffre d’affaires HT des factures émises moins temps valorisé, pièces consommées et achats affectés.</p><label>Intervention<select data-profit-event>${optionList(context.events, "title")}</select></label><div data-profit-result></div></article><article class=business-panel><h3>Affecter un achat</h3><form data-purchase-allocation class=form-grid><label>Achat<select name=purchaseId required>${optionList(context.purchases || [], "description")}</select></label><label>Intervention<select name=eventId required>${optionList(context.events, "title")}</select></label><button type=submit>Affecter au coût réel</button></form>${canConfigure ? `<h3>Coûts horaires chargés</h3><form data-labor-cost class=form-grid><label>Rôle<select name=role><option value=technician>Technicien</option><option value=team_lead>Chef d’équipe</option><option value=mobile_admin>Admin mobile</option></select></label><label>Coût horaire<input name=hourlyCost type=number min=0 step=.01 required></label><button type=submit>Enregistrer</button></form>` : ""}</article></div>`;
    const select = container.querySelector("[data-profit-event]"), result = container.querySelector("[data-profit-result]");
    if ([...select.options].some(option => option.value === selectedEventId)) select.value = selectedEventId;
    const load = async () => {
        if (!select.value) { result.innerHTML = "<p class=muted>Sélectionnez une intervention.</p>"; return; }
        try { const { profitability: item } = await api(`/api/business-suite/events/${select.value}/profitability`); result.innerHTML = `<div class=business-metrics><article><strong>${moneyLabel(item.revenueHt)}</strong><span>CA HT</span></article><article><strong>${moneyLabel(item.laborCost)}</strong><span>Main-d’œuvre (${numberLabel(item.laborHours)} h)</span></article><article><strong>${moneyLabel(item.partsCost + item.purchasesCost)}</strong><span>Pièces et achats</span></article><article><strong class="${item.margin < 0 ? "negative" : "positive"}">${moneyLabel(item.margin)}</strong><span>Marge${item.marginRate === null ? "" : ` · ${numberLabel(item.marginRate)} %`}</span></article></div>`; } catch (error) { result.innerHTML = `<p class=error>${escapeHtml(error.message)}</p>`; }
    };
    select.addEventListener("change", () => { selectedEventId = select.value; announceViewChange(); void load(); }); void load();
    container.querySelector("[data-purchase-allocation]").addEventListener("submit", async event => { event.preventDefault(); const data=new FormData(event.currentTarget); await api(`/api/business-suite/purchases/${data.get("purchaseId")}/event`,{method:"PATCH",body:{eventId:Number(data.get("eventId"))}}); markDesktopWorkspaceDraftSaved(); if(String(select.value)===String(data.get("eventId"))) await load(); });
    container.querySelector("[data-labor-cost]")?.addEventListener("submit", async event => { event.preventDefault(); const data=new FormData(event.currentTarget); await api(`/api/business-suite/labor-costs/${encodeURIComponent(data.get("role"))}`,{method:"PUT",body:{hourlyCost:Number(data.get("hourlyCost"))}}); markDesktopWorkspaceDraftSaved(); if(select.value) await load(); });
}

function bindJsonForm(form, url, complete) {
    form?.addEventListener("submit", async event => {
        event.preventDefault(); const button = form.querySelector("button[type=submit]"); button.disabled = true;
        try { await api(url, { method: "POST", body: Object.fromEntries(new FormData(form)) }); markDesktopWorkspaceDraftSaved(); await complete(); }
        catch (error) { alert(error.message); button.disabled = false; }
    });
}
function bindPatchForm(form, url, complete) {
    form.addEventListener("submit", async event => {
        event.preventDefault();
        const button = form.querySelector("button[type=submit]");
        const message = form.querySelector("[data-patch-error]");
        button.disabled = true;
        message.textContent = "";
        try {
            await api(url, { method: "PATCH", body: Object.fromEntries(new FormData(form)) });
            markDesktopWorkspaceDraftSaved();
            await complete();
        } catch (error) {
            if (form.isConnected) {
                message.textContent = error.message || "Enregistrement impossible.";
                button.disabled = false;
            }
        }
    });
}
async function loadContractTemplate(workspace) {
    const panel = workspace.querySelector("[data-contract-template-panel]");
    if (!panel) return;
    try {
        const { template } = await api("/api/business-suite/contracts/template");
        if (!panel.isConnected) return;
        panel.innerHTML = `<h3>Modèle de contrat de maintenance</h3>
            <p class=muted>Personnalisez les clauses reprises dans les prochains PDF. Faites vérifier leur conformité avant toute signature. Les documents déjà générés restent inchangés.</p>
            <form data-contract-template-form class=form-grid>
                <label class=form-wide>Introduction<textarea name=introduction rows=3 maxlength=3000>${escapeHtml(template.introduction)}</textarea></label>
                <label class=form-wide>Périmètre des prestations<textarea name=scope rows=4 maxlength=5000>${escapeHtml(template.scope)}</textarea></label>
                <label class=form-wide>Exclusions<textarea name=exclusions rows=3 maxlength=5000>${escapeHtml(template.exclusions)}</textarea></label>
                <label class=form-wide>Modalités de paiement<textarea name=paymentTerms rows=3 maxlength=3000>${escapeHtml(template.paymentTerms)}</textarea></label>
                <label class=form-wide>Renouvellement<textarea name=renewalTerms rows=3 maxlength=3000>${escapeHtml(template.renewalTerms)}</textarea></label>
                <label class=form-wide>Résiliation<textarea name=cancellationTerms rows=3 maxlength=3000>${escapeHtml(template.cancellationTerms)}</textarea></label>
                <p class="muted form-wide" data-contract-template-message aria-live=polite></p>
                <button type=submit>Enregistrer le modèle</button>
            </form>`;
        panel.querySelector("[data-contract-template-form]").addEventListener("submit", async event => {
            event.preventDefault();
            const form = event.currentTarget;
            const button = form.querySelector("button[type=submit]");
            const message = form.querySelector("[data-contract-template-message]");
            button.disabled = true;
            message.textContent = "Enregistrement…";
            try {
                await api("/api/business-suite/contracts/template", { method: "PUT", body: Object.fromEntries(new FormData(form)) });
                message.textContent = "Modèle enregistré. Il sera appliqué aux prochains PDF générés.";
                markDesktopWorkspaceDraftSaved();
            } catch (error) {
                message.textContent = error.message || "Impossible d’enregistrer le modèle.";
                message.classList.add("error");
            } finally { button.disabled = false; }
        });
    } catch (error) {
        if (panel.isConnected) panel.innerHTML = `<h3>Modèle de contrat de maintenance</h3><p class=error>${escapeHtml(error.message || "Impossible de charger le modèle.")}</p>`;
    }
}
function contractList(contracts, canEdit) {
    const statuses = { draft: "Brouillon", active: "Actif", suspended: "Suspendu", expired: "Expiré", cancelled: "Annulé" };
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    return contracts.map(contract => {
        const id = escapeHtml(String(contract.id));
        const documents = Array.isArray(contract.documents) ? contract.documents : [];
        const invoices = Array.isArray(contract.invoiceDrafts) ? contract.invoiceDrafts : [];
        const signedDocument = documents.find(item => item.kind === "signed");
        const canRenew = canEdit && ["active", "expired"].includes(contract.status);
        const canCreateInvoice = ["admin", "pc_standard", "mobile_admin"].includes(document.body.dataset.role)
            && contract.status === "active" && Number(contract.billingAmountHt) > 0
            && contract.nextInvoiceOn && contract.nextInvoiceOn <= today;
        const renewalStartsOn = contract.endsOn ? addDays(contract.endsOn, 1) : "";
        return `<article class=business-contract>
            <div class=business-row><div><strong>${escapeHtml(contract.reference)} · ${escapeHtml(contract.title)}</strong>
                <small>${escapeHtml(statuses[contract.status] || contract.status)} · Fin : ${escapeHtml(contract.endsOn || "non renseignée")} · Prochaine visite : ${escapeHtml(contract.nextServiceOn || "non renseignée")}</small>
                <small>Facturation : ${Number(contract.billingAmountHt || 0).toFixed(2)} € HT tous les ${escapeHtml(String(contract.billingIntervalMonths || 12))} mois · prochaine échéance ${escapeHtml(contract.nextInvoiceOn || "non définie")}</small>
            </div>${canEdit ? `<button type=button data-delete-resource=contracts data-id="${id}">Supprimer</button>` : ""}</div>
            <p>${escapeHtml(contract.serviceDescription || "Prestations non détaillées.")}</p>
            ${canEdit ? `<details><summary>Modifier les échéances et le statut</summary><form class=form-grid data-contract-schedule="${id}">
                <label>Statut<select name=status>${Object.entries(statuses).map(([value, label]) => `<option value="${value}" ${contract.status === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
                <label>Fin<input name=endsOn type=date value="${escapeHtml(contract.endsOn || "")}"></label>
                <label>Prochaine visite<input name=nextServiceOn type=date value="${escapeHtml(contract.nextServiceOn || "")}"></label>
                <button type=submit class=secondary-button>Enregistrer les échéances</button><p class="auth-message error form-wide" data-patch-error aria-live=polite></p>
            </form></details>
            <div class=business-contract-documents><h4>Documents contractuels</h4>
                <button type=button class=secondary-button data-contract-generate="${id}">Générer le projet PDF</button>
                <ul>${documents.map(item => `<li><a href="/api/business-suite/contracts/${id}/documents/${encodeURIComponent(item.id)}" target=_blank rel=noopener>${item.kind === "signed" ? "PDF signé, archivé manuellement" : "Projet PDF"} · ${escapeHtml(item.fileName)}</a><small>Empreinte SHA-256 : ${escapeHtml(String(item.sha256 || "").slice(0, 16))}…</small></li>`).join("") || "<li class=muted>Aucun PDF généré ou signé archivé.</li>"}</ul>
                ${signedDocument ? "" : `<form class=form-grid data-contract-signed="${id}"><label>Importer le PDF signé (après signature hors logiciel)<input name=file type=file accept=application/pdf required></label><button type=submit class=secondary-button>Archiver le PDF signé</button><p class="auth-message error form-wide" data-signed-message aria-live=polite></p></form>`}
                <p class=muted>L’archivage d’un PDF signé n’active pas le contrat. Vérifiez le document et son statut séparément.</p>
            </div>` : ""}
            ${canRenew ? `<details><summary>Préparer le renouvellement manuel</summary><p class=muted>Cette action crée un nouveau contrat en brouillon. L’ancien contrat reste inchangé et aucun renouvellement automatique n’a lieu.</p><form class=form-grid data-contract-renew="${id}">
                <label>Référence du nouveau contrat<input name=reference required maxlength=100 value="${escapeHtml(`${contract.reference}-R`)}"></label>
                <label>Début<input name=startsOn type=date required value="${escapeHtml(renewalStartsOn)}"></label>
                <label>Fin<input name=endsOn type=date></label><label>Prochaine visite<input name=nextServiceOn type=date></label>
                <label>Première échéance de facturation<input name=nextInvoiceOn type=date></label>
                <button type=submit class=secondary-button>Créer le nouveau contrat en brouillon</button>
            </form></details>` : ""}
            <div class=business-contract-invoices><h4>Facturation périodique</h4>
                ${canCreateInvoice ? `<button type=button class=secondary-button data-contract-invoice-draft="${id}">Créer le brouillon de facture échu</button>` : ""}
                <ul>${invoices.map(invoice => `<li><button type=button class=secondary-button data-open-contract-invoice="${escapeHtml(String(invoice.id))}">Ouvrir ${escapeHtml(invoice.documentNumber || "la facture brouillon")}</button> · Échéance ${escapeHtml(invoice.periodStart)} · ${Number(invoice.amountHt || 0).toFixed(2)} € HT</li>`).join("") || "<li class=muted>Aucun brouillon périodique créé.</li>"}</ul>
            </div>
        </article>`;
    }).join("") || "<p class=muted>Aucun élément.</p>";
}
function addDays(date, days) {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
}
function groupInventoryBalances(balances, key) {
    const groups = new Map();
    for (const balance of balances) {
        const id = String(balance[key]);
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(balance);
    }
    return groups;
}
function recordList(items, label, resource) { return items.map(item => `<div class=business-row><div><strong>${escapeHtml(label(item))}</strong></div><button type=button data-delete-resource=${resource} data-id=${item.id}>Supprimer</button></div>`).join("") || "<p class=muted>Aucun élément.</p>"; }
function clientOptions() { return `<option value="">Choisir un client</option>${context.clients.map(client => `<option value="${escapeHtml(client.id)}">${escapeHtml(client.name || client.id)}</option>`).join("")}`; }
function optionList(items, field="name") { return `<option value="">Aucun / choisir</option>${items.map(item => `<option value=${item.id}>${escapeHtml(item[field] || item.documentNumber || item.id)}${item.eventDate ? ` · ${escapeHtml(item.eventDate)}` : ""}</option>`).join("")}`; }
function resourceTabs() { return [["assets","Sites & équipements"],["inventory","Stock"],["vehicles","Véhicules"]]; }
function normalizedTab(value) { return ["portal", "profitability", ...resourceTabs().map(([id]) => id)].includes(value) ? value : "assets"; }
function announceViewChange() { window.dispatchEvent(new CustomEvent("depannhome:application-view-changed")); }
function pageTitle(tab) { return tab === "portal" ? "Clients · Portail client" : tab === "profitability" ? "Devis & rapports · Rentabilité" : `Ressources · ${resourceTabs().find(([id]) => id === tab)?.[1] || "Sites & équipements"}`; }
function pageRoute(tab) { return tab === "portal" ? ROUTES.clients : tab === "profitability" ? ROUTES.billing : ROUTES.businessSuite; }
async function api(url, options={}) { const method=options.method||"GET"; const response=await fetch(url,{method,credentials:"same-origin",cache:method==="GET"?"no-store":undefined,headers:options.body?{"Content-Type":"application/json"}:undefined,body:options.body?JSON.stringify(options.body):undefined}); if(response.status===204)return null; const payload=await response.json().catch(()=>({})); if(!response.ok)throw new Error(payload.message||"Opération impossible."); return payload; }
function renderFailure(container,error){container.innerHTML=`<article class=business-panel><p class=error>${escapeHtml(error.message||"Chargement impossible.")}</p></article>`;} function dateLabel(value){return value?new Date(value).toLocaleDateString("fr-FR"):"—";} function numberLabel(value){return new Intl.NumberFormat("fr-FR",{maximumFractionDigits:3}).format(Number(value)||0);} function moneyLabel(value){return new Intl.NumberFormat("fr-FR",{style:"currency",currency:"EUR"}).format(Number(value)||0);}
