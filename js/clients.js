import { ROUTES } from "./config.js?v=116";
import { addClientActivity, getLocalClients, removeLocalClient, saveLocalClient, scheduleClientSynchronization, synchronizeClients } from "./client-sync.js?v=125";
import { renderClientMessages } from "./messages.js?v=107";
import { resetSelection } from "./state.js?v=44";
import { escapeHtml, normalizeText } from "./utils.js?v=44";
import {
    clearSearch,
    createButton,
    createInfo,
    getContainer,
    setPage
} from "./ui.js?v=44";

const EMPTY_CLIENT = {
    id: null,
    type: "Particulier",
    name: "",
    phone: "",
    email: "",
    address: "",
    city: "",
    equipment: "",
    notes: "",
    attachments: [],
    activityHistory: []
};

const ATTACHMENT_TYPES = ["Devis", "Facture", "Quitus", "Rapport fuite", "Photo", "Photo avant", "Photo après", "Autre"];
const MAX_ATTACHMENT_SIZE = 4 * 1024 * 1024;
let clientScreenOptions = {};
let clientDirectoryFilters = createEmptyDirectoryFilters();

export async function renderClients(options = {}) {
    const refreshFromServer = options.refreshFromServer === true;
    const viewOptions = { ...options };
    delete viewOptions.refreshFromServer;
    const directoryClientId = String(viewOptions.directoryClientId || "");
    delete viewOptions.directoryClientId;
    if (refreshFromServer) await synchronizeClients({ forceFull: true }).catch(() => {});
    else scheduleClientSynchronization();
    clientScreenOptions = { ...clientScreenOptions, ...viewOptions };
    clearSearch();
    resetSelection("all");
    setPage("Clients", ROUTES.clients, "detail");

    const container = getContainer();
    const clients = getClients();
    const readOnly = isClientReadOnly();
    const editingClient = !readOnly && viewOptions.editId ? getClientById(viewOptions.editId) : null;
    const selectedClient = viewOptions.selectedId ? getClientById(viewOptions.selectedId) : null;

    const directory = renderClientDirectory(clients);
    container.appendChild(renderClientToolbar(clients, readOnly, directory));
    if (!readOnly) container.appendChild(renderClientForm(editingClient || EMPTY_CLIENT, clientScreenOptions));

    if (selectedClient) {
        container.appendChild(renderClientDetail(selectedClient, { focusMessages: Boolean(options.focusMessages) }));
    }

    container.appendChild(directory);
    if (directoryClientId) renderProvisionedClientDirectory(directory, clients, directoryClientId);
}

function renderClientToolbar(clients, readOnly, directory) {
    const panel = document.createElement("section");
    panel.className = "client-panel";

    panel.innerHTML = `
        <div>
                <p class="eyebrow">${readOnly ? "Dossiers d’intervention" : "Base clients"}</p>
            <h2>Recherche de dossiers clients</h2>
        </div>
        <form id="clientDirectoryForm" class="client-directory-form">
            <fieldset class="client-status-filter"><legend>État des clients</legend><label><input type="radio" name="status" value="active" ${clientDirectoryFilters.status === "active" ? "checked" : ""}> Clients actifs</label><label><input type="radio" name="status" value="archived" ${clientDirectoryFilters.status === "archived" ? "checked" : ""}> Clients archivés</label><label><input type="radio" name="status" value="all" ${clientDirectoryFilters.status === "all" ? "checked" : ""}> Tous</label></fieldset>
            <label>Mode de recherche
                <select name="field" id="clientSearchField">
                    <option value="name" ${clientDirectoryFilters.field === "name" ? "selected" : ""}>Nom / société</option>
                    <option value="phone" ${clientDirectoryFilters.field === "phone" ? "selected" : ""}>Numéro de téléphone</option>
                    <option value="address" ${clientDirectoryFilters.field === "address" ? "selected" : ""}>Adresse ou ville</option>
                    <option value="email" ${clientDirectoryFilters.field === "email" ? "selected" : ""}>E-mail</option>
                </select>
            </label>
            <label>Recherche
                <input name="query" class="client-search" type="search" placeholder="Saisir votre recherche" value="${escapeHtml(clientDirectoryFilters.query)}">
            </label>
            <label>Date de création
                <input name="createdDate" type="date" value="${escapeHtml(clientDirectoryFilters.createdDate)}">
            </label>
            <label>Jour du rendez-vous
                <input name="appointmentDate" type="date" value="${escapeHtml(clientDirectoryFilters.appointmentDate)}">
            </label>
            <label>Année de création
                <select name="year"><option value="">Toutes les années</option>${getDirectoryYears(clients).map(year => `<option value="${year}" ${clientDirectoryFilters.year === String(year) ? "selected" : ""}>${year}</option>`).join("")}</select>
            </label>
            <label>Mois de création
                <select name="month"><option value="">Tous les mois</option>${getDirectoryMonths().map(({ value, label }) => `<option value="${value}" ${clientDirectoryFilters.month === value ? "selected" : ""}>${label}</option>`).join("")}</select>
            </label>
            <div class="client-directory-actions"><button type="submit" class="secondary-button">Rechercher</button><button type="button" class="secondary-button" id="clearClientDirectory">Effacer</button></div>
        </form>
        <div class="client-toolbar-actions">
            <button type="button" class="secondary-button" id="syncClientsBtn">${readOnly ? "Actualiser" : "Synchroniser"}</button>
            ${!readOnly && canImportGroupClient() ? '<button type="button" class="secondary-button" id="importGroupClientBtn">Prendre un client du groupe</button>' : ""}
            ${readOnly ? "" : '<button type="button" class="secondary-button" id="newClientBtn">+ Nouveau client</button>'}
        </div>
        <p id="clientSearchHint" class="client-search-hint">Les dossiers ne sont affichés qu’après une recherche. Vous pouvez combiner le mode de recherche, les dates et la période année/mois.</p>
        <p id="clientSyncMessage" class="auth-message" aria-live="polite"></p>
    `;

    panel.querySelector("#newClientBtn")?.addEventListener("click", () => renderClients());
    panel.querySelector("#importGroupClientBtn")?.addEventListener("click", openGroupClientImportDialog);
    panel.querySelector("#syncClientsBtn").addEventListener("click", async event => {
        const button = event.currentTarget;
        const message = panel.querySelector("#clientSyncMessage");
        button.disabled = true;
        message.classList.remove("error");
        message.textContent = navigator.onLine ? (readOnly ? "Actualisation en cours…" : "Synchronisation en cours…") : "Hors ligne : les dossiers déjà consultés restent disponibles.";
        const result = await synchronizeClients();
        if (result.ok) {
            message.textContent = readOnly ? "Dossiers d’intervention actualisés." : "Dossiers clients synchronisés.";
            renderClients();
            return;
        }
        if (!result.offline) {
            message.textContent = result.message || "Synchronisation impossible pour le moment.";
            message.classList.add("error");
        }
        button.disabled = false;
    });
    panel.querySelector("#clientDirectoryForm").addEventListener("submit", async event => {
        event.preventDefault();
        clientDirectoryFilters = readDirectoryFilters(new FormData(event.currentTarget));
        await applyClientDirectorySearch(directory, clients, clientDirectoryFilters);
        directory.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    panel.querySelector("#clearClientDirectory").addEventListener("click", event => {
        clientDirectoryFilters = createEmptyDirectoryFilters();
        event.currentTarget.form.reset();
        renderClientDirectoryPrompt(directory);
    });

    return panel;
}

function canImportGroupClient() {
    return document.body.dataset.groupAdmin === "true" && Boolean(document.body.dataset.groupId);
}

async function openGroupClientImportDialog() {
    document.querySelector(".group-client-import-dialog")?.remove();
    const dialog = document.createElement("section");
    dialog.className = "client-lifecycle-dialog group-client-import-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "groupClientImportTitle");
    dialog.innerHTML = `
        <div>
            <header><div><p class="eyebrow">Groupe / Multi-entreprises</p><h2 id="groupClientImportTitle">Prendre un client d’une autre entreprise</h2></div><button type="button" class="text-button" data-close-group-import>Fermer</button></header>
            <p>Choisissez l’entreprise puis le client à reprendre dans <strong>${escapeHtml(document.body.dataset.activeCompanyName || "l’entreprise active")}</strong>.</p>
            <p class="muted">Une nouvelle fiche indépendante sera créée. Les devis, factures, rapports, rendez-vous, messages, historiques et fichiers resteront uniquement dans l’entreprise source.</p>
            <form class="form-grid" id="groupClientImportForm">
                <label class="form-wide">Entreprise source<select name="sourceCompanyId" required disabled><option value="">Chargement…</option></select></label>
                <label class="form-wide">Client à reprendre<select name="clientId" required disabled><option value="">Sélectionnez d’abord une entreprise</option></select></label>
                <div class="form-wide procedure-meta" data-group-client-preview hidden></div>
                <div class="form-wide client-lifecycle-actions"><button type="button" class="secondary-button" data-close-group-import>Annuler</button><button type="submit" class="secondary-button" disabled>Créer la fiche dans l’entreprise active</button></div>
                <p class="form-wide auth-message" data-group-import-feedback aria-live="polite"></p>
            </form>
        </div>`;
    document.body.appendChild(dialog);
    const form = dialog.querySelector("form");
    const companySelect = form.elements.sourceCompanyId;
    const clientSelect = form.elements.clientId;
    const submit = form.querySelector('[type="submit"]');
    const feedback = dialog.querySelector("[data-group-import-feedback]");
    const preview = dialog.querySelector("[data-group-client-preview]");
    let sourceClients = [];
    const close = () => dialog.remove();
    dialog.querySelectorAll("[data-close-group-import]").forEach(button => button.addEventListener("click", close));
    dialog.addEventListener("click", event => { if (event.target === dialog) close(); });
    try {
        const payload = await groupClientImportRequest("/api/clients/group-import");
        const companies = Array.isArray(payload.companies) ? payload.companies : [];
        companySelect.innerHTML = `<option value="">Sélectionner une entreprise</option>${companies.map(company => `<option value="${escapeHtml(company.id)}">${escapeHtml(company.companyName)}</option>`).join("")}`;
        companySelect.disabled = !companies.length;
        if (!companies.length) feedback.textContent = "Ajoutez au moins une autre entreprise active au groupe pour reprendre un client.";
    } catch (error) {
        feedback.textContent = error.message || "Impossible de charger les entreprises du groupe.";
        feedback.classList.add("error");
    }
    companySelect.addEventListener("change", async () => {
        sourceClients = [];
        preview.hidden = true;
        submit.disabled = true;
        clientSelect.disabled = true;
        clientSelect.innerHTML = '<option value="">Chargement des clients…</option>';
        feedback.textContent = "";
        feedback.classList.remove("error");
        if (!companySelect.value) {
            clientSelect.innerHTML = '<option value="">Sélectionnez d’abord une entreprise</option>';
            return;
        }
        try {
            const payload = await groupClientImportRequest(`/api/clients/group-import?sourceCompanyId=${encodeURIComponent(companySelect.value)}`);
            sourceClients = Array.isArray(payload.clients) ? payload.clients : [];
            clientSelect.innerHTML = `<option value="">Sélectionner un client</option>${sourceClients.map(client => `<option value="${escapeHtml(client.id)}">${escapeHtml(client.name)}${client.city ? ` · ${escapeHtml(client.city)}` : ""}</option>`).join("")}`;
            clientSelect.disabled = !sourceClients.length;
            if (!sourceClients.length) feedback.textContent = "Cette entreprise ne possède aucun client actif à reprendre.";
        } catch (error) {
            clientSelect.innerHTML = '<option value="">Chargement impossible</option>';
            feedback.textContent = error.message || "Impossible de charger les clients de cette entreprise.";
            feedback.classList.add("error");
        }
    });
    clientSelect.addEventListener("change", () => {
        const client = sourceClients.find(item => String(item.id) === String(clientSelect.value));
        submit.disabled = !client;
        preview.hidden = !client;
        preview.innerHTML = client ? `<span><strong>${escapeHtml(client.type)}</strong></span><span>${escapeHtml(client.phone || "Téléphone non renseigné")}</span><span>${escapeHtml(client.email || "E-mail non renseigné")}</span><span>${escapeHtml([client.address, client.city].filter(Boolean).join(", ") || "Adresse non renseignée")}</span>` : "";
    });
    form.addEventListener("submit", async event => {
        event.preventDefault();
        submit.disabled = true;
        companySelect.disabled = true;
        clientSelect.disabled = true;
        feedback.textContent = "Création de la fiche dans l’entreprise active…";
        feedback.classList.remove("error");
        try {
            const payload = await groupClientImportRequest("/api/clients/group-import", { method: "POST", body: JSON.stringify({ sourceCompanyId: companySelect.value, clientId: clientSelect.value }) });
            feedback.textContent = payload.message || "Client repris dans l’entreprise active.";
            await synchronizeClients({ forceFull: true });
            dialog.remove();
            renderClients({ ...clientScreenOptions, selectedId: payload.client?.id || "" });
        } catch (error) {
            feedback.textContent = error.message || "Impossible de reprendre ce client.";
            feedback.classList.add("error");
            companySelect.disabled = false;
            clientSelect.disabled = false;
            submit.disabled = false;
        }
    });
    companySelect.focus();
}

async function groupClientImportRequest(url, options = {}) {
    const response = await fetch(url, { credentials: "same-origin", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.message || "Action Groupe impossible.");
    return payload || {};
}

function renderClientForm(client, options = {}) {
    const isEdit = Boolean(client.id);
    const panel = document.createElement("section");
    panel.className = "client-panel";

    panel.innerHTML = `
        <form id="clientForm" class="client-form">
            <input type="hidden" name="id" value="${escapeHtml(client.id || "")}">

            <div class="form-heading">
                <div>
                    <p class="eyebrow">${isEdit ? "Modification" : "Création"}</p>
                    <h2>${isEdit ? "Modifier le client" : "Ajouter un client"}</h2>
                </div>
                ${isEdit ? "<button type=\"button\" class=\"secondary-button\" id=\"cancelEditBtn\">Annuler</button>" : ""}
            </div>

            <div class="form-grid">
                <label>
                    Type
                    <select name="type">
                        <option value="Particulier" ${client.type === "Particulier" ? "selected" : ""}>Particulier</option>
                        <option value="Professionnel" ${client.type === "Professionnel" ? "selected" : ""}>Professionnel</option>
                        <option value="Syndic" ${client.type === "Syndic" ? "selected" : ""}>Syndic</option>
                    </select>
                </label>

                <label>
                    Nom / Société *
                    <input name="name" required placeholder="Ex : Mme Martin, Résidence Les Pins" value="${escapeHtml(client.name)}">
                </label>

                <label>
                    Téléphone
                    <input name="phone" type="tel" placeholder="06..." value="${escapeHtml(client.phone)}">
                </label>

                <label>
                    Email
                    <input name="email" type="email" placeholder="client@email.fr" value="${escapeHtml(client.email)}">
                </label>

                <label class="form-wide">
                    Adresse
                    <input name="address" placeholder="Adresse complète" value="${escapeHtml(client.address)}">
                </label>

                <label>
                    Ville
                    <input name="city" placeholder="Ville" value="${escapeHtml(client.city)}">
                </label>

                <label class="form-wide">
                    Équipements sur place
                    <textarea name="equipment" rows="3" placeholder="Ex : 4 volets Somfy RTS, portail FAAC 740, clavier à code...">${escapeHtml(client.equipment)}</textarea>
                </label>

                <label class="form-wide">
                    Notes intervention
                    <textarea name="notes" rows="4" placeholder="Accès, panne récurrente, historique, consignes client...">${escapeHtml(client.notes)}</textarea>
                </label>
            </div>

            <section class="client-files-zone">
                <div class="form-heading">
                    <div>
                        <p class="eyebrow">Dossier client</p>
                        <h3> Devis, factures, photos et documents</h3>
                    </div>
                    <span class="file-count-badge">${client.attachments.length} fichier(s)</span>
                </div>

                ${client.attachments.length ? renderAttachmentsHtml(client.id, client.attachments) : "<p class=\"muted\">Aucun fichier enregistré pour ce client.</p>"}

                <div class="file-input-grid">
                    <label>
                        Catégorie des nouveaux fichiers
                        <select name="fileType">
                            ${ATTACHMENT_TYPES.map(type => `<option value="${type}">${type}</option>`).join("")}
                        </select>
                    </label>

                    <label>
                        Ajouter des fichiers
                        <input name="attachments" type="file" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt">
                    </label>

                    <label class="photo-capture-label">
                        Prendre une photo depuis l'app
                        <input name="cameraPhoto" type="file" accept="image/*" capture="environment">
                    </label>
                </div>

                <p class="muted small-note">Les fichiers sont stockés localement sur cet appareil. Taille conseillée : moins de 4 Mo par fichier.</p>
            </section>

            <div class="form-actions">
                <button type="submit" class="secondary-button">${isEdit ? "Enregistrer les modifications" : "Ajouter le client"}</button>
            </div>
        </form>
    `;

    panel.querySelector("#clientForm").addEventListener("submit", async event => {
        event.preventDefault();
        const nextClient = await readClientForm(event.currentTarget, client);

        const savedClient = saveClient(nextClient);
        if (savedClient) {
            const isNewClient = !client.id;
            addClientActivity(savedClient.id, {
                type: isNewClient ? "client" : "profile",
                label: isNewClient ? "Fiche client créée" : "Fiche client mise à jour"
            });
            const newAttachments = savedClient.attachments.slice(client.attachments.length);
            newAttachments.forEach(attachment => addClientActivity(savedClient.id, {
                type: "attachment",
                label: "Fichier ajouté",
                detail: attachment.name
            }));
            renderClients({ selectedId: nextClient.id, ...clientScreenOptions });
        }
    });

    panel.querySelector("#cancelEditBtn")?.addEventListener("click", () => renderClients(clientScreenOptions));

    return panel;
}

function renderClientDirectory(clients) {
    const section = document.createElement("section");
    section.className = "client-directory-results";
    section.id = "clientDirectoryResults";
    renderClientDirectoryPrompt(section, clients.length);
    return section;
}

function renderClientDirectoryPrompt(section, clientCount = getClients().length) {
    section.innerHTML = "";
    section.appendChild(createInfo(clientCount ? "Utilisez les critères ci-dessus pour rechercher un dossier client. Les résultats seront classés par année et mois de création." : "Aucun client enregistré pour le moment."));
}

function renderProvisionedClientDirectory(section, clients, clientId) {
    const client = clients.find(item => String(item.id) === String(clientId));
    if (!client) return;
    renderClientDirectoryResults(section, [client], new Map());
    const notice = createInfo("La fiche client partenaire vient d’être synchronisée et est affichée ci-dessous.");
    section.prepend(notice);
}

async function applyClientDirectorySearch(section, clients, filters) {
    section.innerHTML = "<p class=\"muted\">Recherche des dossiers…</p>";
    try {
        const appointmentDatesByClient = filters.appointmentDate ? await loadAppointmentDatesByClient() : new Map();
        const results = clients.filter(client => clientMatchesDirectoryFilters(client, filters, appointmentDatesByClient));
        renderClientDirectoryResults(section, results, appointmentDatesByClient);
    } catch (error) {
        section.innerHTML = `<p class="auth-message error">${escapeHtml(error.message || "Impossible de rechercher les rendez-vous.")}</p>`;
    }
}

function renderClientDirectoryResults(section, clients, appointmentDatesByClient) {
    section.innerHTML = "";
    if (!clients.length) {
        section.appendChild(createInfo("Aucun dossier ne correspond à ces critères. Modifiez les critères puis relancez la recherche."));
        return;
    }
    const summary = document.createElement("div");
    summary.className = "client-search-results-summary";
    summary.tabIndex = -1;
    summary.innerHTML = `<strong>${clients.length} dossier${clients.length > 1 ? "s" : ""} trouvé${clients.length > 1 ? "s" : ""}</strong><span>Les résultats apparaissent ci-dessous.</span>`;
    section.appendChild(summary);
    const groups = new Map();
    clients.forEach(client => {
        const date = parseDirectoryDate(client.createdAt) || new Date(0);
        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
        if (!groups.has(key)) groups.set(key, { date, clients: [] });
        groups.get(key).clients.push(client);
    });
    [...groups.values()].sort((first, second) => second.date - first.date).forEach(group => {
        const panel = document.createElement("section");
        panel.className = "client-results-group client-table-wrapper";
        panel.innerHTML = `<div class="client-results-group-heading"><div><p class="eyebrow">Dossiers créés</p><h2>${escapeHtml(formatDirectoryMonth(group.date))}</h2></div><span>${group.clients.length} client(s)</span></div>`;
        panel.appendChild(renderClientTable(group.clients, appointmentDatesByClient));
        section.appendChild(panel);
    });
}

function renderClientTable(clients, appointmentDatesByClient = new Map()) {

    const table = document.createElement("table");
    table.className = "client-table";
    table.innerHTML = `
        <thead>
            <tr>
                <th scope="col">Client</th>
                <th scope="col">Type</th>
                <th scope="col">Coordonnées</th>
                <th scope="col">Adresse</th>
                <th scope="col">Création / rendez-vous</th>
                <th scope="col"><span class="sr-only">Actions</span></th>
            </tr>
        </thead>
        <tbody></tbody>
    `;
    const body = table.querySelector("tbody");
    clients.sort((a, b) => a.name.localeCompare(b.name, "fr")).forEach(client => body.appendChild(renderClientTableRow(client, appointmentDatesByClient.get(client.id) || [])));
    return table;
}

function renderClientTableRow(client, appointmentDates = []) {
    const readOnly = isClientReadOnly();
    const archived = client.clientStatus === "archived";
    const row = document.createElement("tr");
    row.className = "client-table-row";
    row.innerHTML = `
        <td data-label="Client"><strong>${escapeHtml(client.name)}</strong>${archived ? '<span class="client-archived-badge">Client archivé</span>' : ""}</td>
        <td data-label="Type">${escapeHtml(client.type)}</td>
        <td data-label="Coordonnées"><span>${escapeHtml(client.phone || "Téléphone non renseigné")}</span>${client.email ? `<small>${escapeHtml(client.email)}</small>` : ""}</td>
        <td data-label="Adresse">${escapeHtml(formatClientLocation(client))}</td>
        <td data-label="Création / rendez-vous"><strong>Créé le ${escapeHtml(formatDate(client.createdAt))}</strong><small>${appointmentDates.length ? `RDV : ${escapeHtml(appointmentDates.map(formatDirectoryShortDate).join(" · "))}` : `${client.attachments.length} fichier(s)`}</small></td>
        <td data-label="Actions"><div class="client-card-actions">
            <button type="button" class="secondary-button" data-action="view">Voir</button>
            ${readOnly ? "" : archived ? '<button type="button" class="secondary-button" data-action="reactivate">Réactiver</button>' : '<button type="button" class="secondary-button" data-action="edit">Modifier</button>'}
        </div></td>
    `;

    row.querySelector('[data-action="view"]').addEventListener("click", () => renderClients({ selectedId: client.id }));
    row.querySelector('[data-action="edit"]')?.addEventListener("click", () => renderClients({ editId: client.id }));
    row.querySelector('[data-action="reactivate"]')?.addEventListener("click", () => reactivateClient(client.id));

    return row;
}

function renderClientDetail(client, options = {}) {
    const readOnly = isClientReadOnly();
    const archived = client.clientStatus === "archived";
    const navigationHref = getClientNavigationHref(client);
    const interventionPhotos = client.attachments.filter(isInterventionPhoto);
    const clientFiles = client.attachments.filter(attachment => !isInterventionPhoto(attachment) && attachment.type !== "Quitus" && !isLeakReportAttachment(attachment));
    const panel = document.createElement("section");
    panel.className = "client-panel";

    panel.innerHTML = `
        <div class="procedure-header">
            <div>
                <p class="eyebrow">${archived ? "Client archivé" : "Fiche client"}</p>
                <h2>${escapeHtml(client.name)}</h2>
                ${archived ? '<strong class="client-archived-banner">CLIENT ARCHIVÉ</strong>' : ""}
            </div>
            <div class="client-card-actions">
                ${navigationHref ? `<a class="secondary-button client-navigation-button" href="${escapeHtml(navigationHref)}" aria-label="Y aller vers ${escapeHtml(formatClientLocation(client))}">Y aller</a>` : '<button type="button" class="secondary-button client-navigation-button" disabled title="Ajoutez une adresse au client pour lancer la navigation.">Y aller</button>'}
                ${readOnly ? "" : archived ? '<button type="button" class="secondary-button report-primary-action" id="reactivateSelectedClient">Réactiver le client</button>' : '<button type="button" class="secondary-button" id="createClientAppointment">+ Créer un rendez-vous</button><button type="button" class="secondary-button" id="createClientQuote">+ Créer un devis</button><button type="button" class="secondary-button" id="createClientInvoice">+ Créer une facture</button><button type="button" class="secondary-button" id="editSelectedClient">Modifier</button><button type="button" class="secondary-button danger-button" id="deleteSelectedClient">Supprimer le client</button>'}
            </div>
        </div>
        <div class="procedure-meta">
            <span> ${escapeHtml(client.type)}</span>
            <span> ${escapeHtml(client.phone || "Non renseigné")}</span>
            <span> ${escapeHtml(client.email || "Non renseigné")}</span>
            <span> ${escapeHtml(formatClientLocation(client))}</span>
        </div>
        <section class="procedure-section">
            <h3> Équipements</h3>
            <p>${escapeHtml(client.equipment || "Aucun équipement renseigné.")}</p>
        </section>
        <section class="procedure-section">
            <h3> Notes</h3>
            <p>${escapeHtml(client.notes || "Aucune note renseignée.")}</p>
        </section>
        <section class="procedure-section">
            <h3> Historique du client</h3>
            <div id="clientHistory"><p class="muted">Chargement de l’historique du dossier…</p></div>
        </section>
        ${interventionPhotos.length ? `
            <section class="procedure-section client-intervention-photos">
                <div class="form-heading"><div><p class="eyebrow">Interventions terrain</p><h3>Photos ajoutées par les techniciens</h3></div><span class="file-count-badge">${interventionPhotos.length} photo(s)</span></div>
                <div class="client-intervention-photo-gallery">${interventionPhotos.map(attachment => renderInterventionPhotoHtml(client.id, attachment)).join("")}</div>
            </section>
        ` : ""}
        <section class="procedure-section">
            <h3> Fichiers du client</h3>
            ${clientFiles.length ? renderAttachmentsHtml(client.id, clientFiles, client.email) : "<p>Aucun autre fichier enregistré.</p>"}
        </section>
    `;

    panel.querySelector("#editSelectedClient")?.addEventListener("click", () => renderClients({ editId: client.id }));
    panel.querySelector("#deleteSelectedClient")?.addEventListener("click", () => inspectClientDeletion(client));
    panel.querySelector("#reactivateSelectedClient")?.addEventListener("click", () => reactivateClient(client.id));
    panel.querySelector("#createClientAppointment")?.addEventListener("click", () => openClientAppointment(client));
    panel.querySelector("#createClientQuote")?.addEventListener("click", () => openClientBillingDocument("quote", client));
    panel.querySelector("#createClientInvoice")?.addEventListener("click", () => openClientBillingDocument("invoice", client));
    panel.querySelectorAll("[data-email-attachment]").forEach(button => {
        button.addEventListener("click", () => emailClientAttachment(client, button.dataset.emailAttachment));
    });
    loadClientFinancialHistory(panel.querySelector("#clientHistory"), client);

    const detail = document.createDocumentFragment();
    detail.append(panel);
    detail.append(renderClientMessages(client, options.focusMessages));
    return detail;
}

function openClientAppointment(client) {
    if (typeof clientScreenOptions.createCalendarEvent === "function") {
        clientScreenOptions.createCalendarEvent(client);
    }
}

function openClientBillingDocument(type, client) {
    if (typeof clientScreenOptions.createBillingDocument === "function") {
        clientScreenOptions.createBillingDocument(type, client);
    }
}

async function loadClientFinancialHistory(panel, client) {
    if (!panel) return;
    const [billingResult, purchasesResult, appointmentsResult] = await Promise.allSettled([
        loadClientBillingDocuments(client),
        isClientReadOnly() ? Promise.resolve([]) : loadClientPurchases(client.id),
        loadClientAppointments(client.id)
    ]);
    const documents = billingResult.status === "fulfilled" ? billingResult.value : [];
    const purchases = purchasesResult.status === "fulfilled" ? purchasesResult.value : [];
    const appointments = appointmentsResult.status === "fulfilled" ? appointmentsResult.value : [];
    const failedSources = [billingResult, purchasesResult, appointmentsResult].filter(result => result.status === "rejected");
    panel.innerHTML = `${renderClientActivityHistory(client, documents, purchases, appointments)}${failedSources.length ? '<p class="auth-message error">Une partie de l’historique n’a pas pu être chargée. Les éléments disponibles restent affichés.</p>' : ""}`;
    bindClientHistoryActions(panel, client);
}

async function loadClientBillingDocuments(client) {
    const response = await fetch("/api/billing", { credentials: "same-origin" });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.message || "Impossible de charger les documents associés au client.");
    return (data?.documents || []).filter(document => belongsToClient(document, client));
}

async function loadClientAppointments(clientId) {
    const response = await fetch(`/api/calendar/client-history/${encodeURIComponent(clientId)}`, { credentials: "same-origin" });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.message || "Impossible de charger les rendez-vous du client.");
    return Array.isArray(data?.events) ? data.events : [];
}

function belongsToClient(document, client) {
    return Boolean(document?.clientId) && String(document.clientId) === String(client.id);
}

async function loadClientPurchases(clientId) {
    const response = await fetch(`/api/purchases?clientId=${encodeURIComponent(clientId)}`, { credentials: "same-origin" });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.message || "Impossible de charger les achats associés au client.");
    return Array.isArray(data?.purchases) ? data.purchases : [];
}

function emailBillingDocument(document, client) {
    if (!client.email) { alert("Ajoutez d’abord l’adresse e-mail du client."); return; }
    sendBillingEmail(document, client.email, client.name);
}

async function getClientBillingDocument(client, documentId, documentNumber) {
    const response = await fetch("/api/billing", { credentials: "same-origin" });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.message || "Impossible de charger le document.");
    const document = (data?.documents || []).find(item =>
        belongsToClient(item, client)
        && (String(item.id) === String(documentId) || (!documentId && item.documentNumber === documentNumber))
    );
    if (!document) throw new Error("Le devis ou la facture n’est plus disponible.");
    return document;
}

async function viewClientBillingDocument(client, documentId, documentNumber) {
    try {
        const document = await getClientBillingDocument(client, documentId, documentNumber);
        if (typeof clientScreenOptions.viewBillingDocument !== "function") throw new Error("Ouverture du document indisponible.");
        clientScreenOptions.viewBillingDocument(document.id);
    } catch (error) { alert(error.message || "Impossible d’ouvrir le document."); }
}

async function printClientBillingDocument(client, documentId, documentNumber) {
    const popup = window.open("", "_blank");
    if (!popup) { alert("Autorisez les fenêtres pop-up pour imprimer le document."); return; }
    popup.document.write("<p>Préparation du PDF…</p>");
    try {
        const document = await getClientBillingDocument(client, documentId, documentNumber);
        await printBillingDocument(document.id, popup);
    } catch (error) {
        popup.document.body.innerHTML = `<p>Erreur : ${escapeHtml(error.message || "document indisponible")}</p>`;
    }
}

async function emailClientBillingDocument(client, documentId, documentNumber) {
    try {
        const document = await getClientBillingDocument(client, documentId, documentNumber);
        emailBillingDocument(document, client);
    } catch (error) { alert(error.message || "Impossible d’envoyer le document par e-mail."); }
}

async function printBillingDocument(documentId, existingPopup = null) {
    const popup = existingPopup || window.open("", "_blank");
    if (!popup) { alert("Autorisez les fenêtres pop-up pour imprimer le document."); return; }
    popup.location.href = `/api/billing/documents/${encodeURIComponent(documentId)}/pdf`;
}

async function sendBillingEmail(document, recipient, clientName) {
    const destination = window.prompt("Adresse e-mail du destinataire :", recipient);
    if (destination === null) return;
    if (!destination.trim()) { alert("Saisissez une adresse e-mail valide."); return; }
    const type = document.documentType === "invoice" ? "facture" : "devis";
    if (!confirm(`Envoyer la ${type} ${document.documentNumber} en PDF à ${destination.trim()} ?`)) return;
    try {
        const response = await fetch(`/api/billing/documents/${encodeURIComponent(document.id)}/email`, {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ recipient: destination.trim() })
        });
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.message);
        alert(data?.message || "Document envoyé par e-mail.");
    } catch (error) { alert(error.message || "Impossible d’envoyer le document par e-mail."); }
}

function openClientAttachment(clientId, attachmentId) {
    if (!attachmentId) return;
    const popup = window.open("", "_blank");
    if (!popup) { alert("Autorisez les fenêtres pop-up pour ouvrir le quitus."); return; }
    popup.location.href = `/api/clients/${encodeURIComponent(clientId)}/attachments/${encodeURIComponent(attachmentId)}/open`;
}

async function emailClientAttachment(client, attachmentId) {
    if (!client.email) { alert("Ajoutez d’abord l’adresse e-mail du client."); return; }
    const attachment = client.attachments.find(item => item.id === attachmentId);
    if (!attachment) { alert("Ce fichier n’est plus disponible."); return; }
    const destination = window.prompt("Adresse e-mail du destinataire :", client.email);
    if (destination === null) return;
    if (!destination.trim()) { alert("Saisissez une adresse e-mail valide."); return; }
    if (!confirm(`Envoyer « ${attachment.name} » à ${destination.trim()} ?`)) return;
    try {
        const response = await fetch(`/api/clients/${encodeURIComponent(client.id)}/attachments/${encodeURIComponent(attachment.id)}/email`, {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ recipient: destination.trim() })
        });
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.message);
        alert(data?.message || "Document envoyé par e-mail.");
    } catch (error) { alert(error.message || "Impossible d’envoyer le document par e-mail."); }
}

function buildLegacyPrintableBillingHtml(document, profile) {
    const lines = Array.isArray(document.lines) ? document.lines : [];
    const totalHt = lines.reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unitPrice || 0), 0);
    const totalVat = lines.reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unitPrice || 0) * Number(line.vatRate || 0) / 100, 0);
    const title = document.documentType === "invoice" ? "FACTURE" : "DEVIS";
    return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${escapeHtml(title)} ${escapeHtml(document.documentNumber)}</title><style>body{font-family:Arial,sans-serif;color:#172033;margin:42px;line-height:1.45}.top{display:flex;justify-content:space-between;gap:30px;border-bottom:3px solid #0a5c36;padding-bottom:22px}.company{max-width:52%}.logo{max-width:160px;max-height:80px;object-fit:contain}.title{font-size:29px;color:#003b73;font-weight:800}.meta{margin:28px 0;display:flex;justify-content:space-between;gap:30px}table{width:100%;border-collapse:collapse;margin-top:24px}th{background:#003b73;color:#fff;text-align:left}th,td{padding:10px;border:1px solid #dbe3ea}td.num{text-align:right}.totals{margin:24px 0 0 auto;width:300px}.totals p{display:flex;justify-content:space-between;margin:5px 0}.total{border-top:2px solid #0a5c36;padding-top:8px;font-size:19px;font-weight:800;color:#003b73}.notes{margin-top:35px;border-top:1px solid #dbe3ea;padding-top:15px;white-space:pre-wrap}@media print{body{margin:18mm}}</style></head><body><div class="top"><div class="company">${profile.hasLogo ? '<img class="logo" src="/api/billing/logo" alt="Logo">' : ""}<h2>${escapeHtml(profile.companyName || "Votre structure")}</h2><p>${escapeHtml([profile.legalForm, profile.address, [profile.postalCode, profile.city].filter(Boolean).join(" "), profile.phone, profile.email, profile.registrationNumber, profile.taxNumber].filter(Boolean).join(" · "))}</p></div><div><div class="title">${title}</div><p><strong>N° ${escapeHtml(document.documentNumber)}</strong><br>Date : ${escapeHtml(formatBillingDate(document.issueDate))}${document.dueDate ? `<br>Échéance : ${escapeHtml(formatBillingDate(document.dueDate))}` : ""}</p></div></div><div class="meta"><div><strong>Destinataire</strong><br>${escapeHtml(document.customerName)}<br>${escapeHtml(document.customerAddress || "")}</div><div><strong>Catégorie</strong><br>${escapeHtml(document.customerType)}</div></div><table><thead><tr><th>Description</th><th>Qté</th><th>Unité</th><th>PU HT</th><th>TVA</th><th>Total HT</th></tr></thead><tbody>${lines.map(line => `<tr><td>${escapeHtml(line.description)}</td><td class="num">${escapeHtml(line.quantity)}</td><td>${escapeHtml(line.unit)}</td><td class="num">${formatBillingMoney(line.unitPrice)}</td><td class="num">${escapeHtml(line.vatRate)} %</td><td class="num">${formatBillingMoney(Number(line.quantity || 0) * Number(line.unitPrice || 0))}</td></tr>`).join("")}</tbody></table><div class="totals"><p><span>Total HT</span><strong>${formatBillingMoney(totalHt)}</strong></p><p><span>TVA</span><strong>${formatBillingMoney(totalVat)}</strong></p><p class="total"><span>Total TTC</span><span>${formatBillingMoney(totalHt + totalVat)}</span></p></div>${document.notes ? `<div class="notes"><strong>Notes / conditions</strong><br>${escapeHtml(document.notes)}</div>` : ""}${profile.footerNote ? `<div class="notes">${escapeHtml(profile.footerNote)}</div>` : ""}</body></html>`;
}

function buildPrintableBillingHtml(document, profile) {
    const lines = Array.isArray(document.lines) ? document.lines : [];
    const totalHt = lines.reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unitPrice || 0), 0);
    const totalVat = lines.reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unitPrice || 0) * Number(line.vatRate || 0) / 100, 0);
    const totalTtc = totalHt + totalVat;
    const title = document.documentType === "invoice" ? "FACTURE" : "DEVIS";
    const companyDetails = [
        profile.legalForm,
        profile.address,
        [profile.postalCode, profile.city].filter(Boolean).join(" "),
        profile.phone ? `Tél. ${profile.phone}` : "",
        profile.email,
        profile.registrationNumber ? `SIRET ${profile.registrationNumber}` : "",
        profile.taxNumber ? `TVA ${profile.taxNumber}` : ""
    ].filter(Boolean);
    const conditions = document.notes || profile.paymentTerms || "Conditions de règlement non renseignées.";
    const acceptance = document.documentType === "quote"
        ? `<section class="acceptance"><strong>Bon pour accord</strong><p>Devis accepté avant le début de la prestation.</p><div>Date et signature du client :</div></section>`
        : "";
    const rows = lines.map(line => `<tr><td>${escapeHtml(line.description)}</td><td class="number">${escapeHtml(String(line.quantity))}</td><td>${escapeHtml(line.unit || "")}</td><td class="number">${escapeHtml(formatBillingMoney(line.unitPrice))}</td><td class="number">${escapeHtml(String(line.vatRate || 0))} %</td><td class="number">${escapeHtml(formatBillingMoney(Number(line.quantity || 0) * Number(line.unitPrice || 0)))}</td></tr>`).join("");
    return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${escapeHtml(title)} ${escapeHtml(document.documentNumber)}</title><style>@page{size:A4;margin:14mm}*{box-sizing:border-box}body{margin:0;color:#172033;font:11px Arial,sans-serif;line-height:1.35}.page{max-width:190mm;margin:auto}.header{display:grid;grid-template-columns:1fr auto;gap:28px;padding-bottom:14px;border-bottom:2px solid #172033}.issuer{display:flex;gap:13px}.logo{width:74px;height:62px;object-fit:contain;border:1px solid #e5e7eb;border-radius:50%}.issuer h2{margin:0 0 5px;font-size:17px}.issuer p,.party p{margin:0;white-space:pre-line}.document-title{text-align:right}.document-title h1{margin:0;font-size:28px;letter-spacing:.04em}.document-title p{margin:7px 0 0}.parties{display:grid;grid-template-columns:1fr 1fr;gap:28px;margin:24px 0}.party{min-height:100px;padding:12px 14px;background:#f0f2f4}.party h3{margin:0 0 7px;font-size:11px;text-transform:uppercase}.object{margin:14px 0;padding:9px 12px;border-left:4px solid #172033;background:#fafafa}.object strong{display:block;margin-bottom:3px}.lines{width:100%;border-collapse:collapse;margin-top:15px}.lines th{padding:8px 6px;background:#172033;color:#fff;text-align:left;font-size:10px}.lines td{padding:8px 6px;border-bottom:1px solid #d7dde3;vertical-align:top}.lines .number{text-align:right;white-space:nowrap}.summary{display:grid;grid-template-columns:1fr 190px;gap:25px;align-items:end;margin-top:22px}.conditions h3{margin:0 0 7px;font-size:12px}.conditions p{margin:0;white-space:pre-wrap}.totals{width:100%;border-collapse:collapse}.totals td{padding:6px 9px;background:#172033;color:#fff;text-align:right;font-weight:700}.totals td:first-child{text-align:left}.totals tr:last-child td{background:#0a5c36;font-size:14px}.acceptance{width:48%;min-height:75px;margin:25px 0 0 auto;padding:10px;border:1px solid #d7dde3;background:#f5f6f7}.acceptance p{margin:4px 0 20px}.footer{margin-top:22px;padding-top:9px;border-top:1px solid #d7dde3;color:#4b5563;font-size:9px;text-align:center}@media print{body{font-size:10px}.document-title h1{font-size:25px}}</style></head><body><main class="page"><header class="header"><section class="issuer">${profile.hasLogo ? '<img class="logo" src="/api/billing/logo" alt="Logo de la structure">' : ""}<div><h2>${escapeHtml(profile.companyName || "Votre structure")}</h2><p>${escapeHtml(companyDetails.join("\n"))}</p></div></section><section class="document-title"><h1>${title}</h1><p><strong>N° ${escapeHtml(document.documentNumber)}</strong><br>Date d’émission : ${escapeHtml(formatBillingDate(document.issueDate))}${document.dueDate ? `<br>Échéance : ${escapeHtml(formatBillingDate(document.dueDate))}` : ""}</p></section></header><section class="parties"><div class="party"><h3>Émetteur</h3><p>${escapeHtml(profile.companyName || "Votre structure")}</p></div><div class="party"><h3>Client</h3><p><strong>${escapeHtml(document.customerName)}</strong>${document.customerAddress ? `<br>${escapeHtml(document.customerAddress)}` : ""}</p></div></section><section class="object"><strong>Objet / prestation</strong>${escapeHtml(document.customerType || "Client")}</section><table class="lines"><thead><tr><th>Désignation</th><th class="number">Quantité</th><th>Unité</th><th class="number">Prix unitaire HT</th><th class="number">TVA</th><th class="number">Total HT</th></tr></thead><tbody>${rows}</tbody></table><section class="summary"><div class="conditions"><h3>Conditions de règlement</h3><p>${escapeHtml(conditions)}</p></div><table class="totals"><tbody><tr><td>Total HT</td><td>${escapeHtml(formatBillingMoney(totalHt))}</td></tr><tr><td>Total TVA</td><td>${escapeHtml(formatBillingMoney(totalVat))}</td></tr><tr><td>Total TTC</td><td>${escapeHtml(formatBillingMoney(totalTtc))}</td></tr></tbody></table></section>${acceptance}<footer class="footer">${escapeHtml([profile.companyName, profile.registrationNumber ? `SIRET ${profile.registrationNumber}` : "", profile.taxNumber ? `TVA intracommunautaire ${profile.taxNumber}` : ""].filter(Boolean).join(" · "))}</footer></main></body></html>`;
}

function formatBillingDate(value) { return value ? new Intl.DateTimeFormat("fr-FR").format(new Date(`${value}T12:00:00`)) : "Date non renseignée"; }
function formatBillingMoney(value) { return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(Number(value) || 0); }

async function readClientForm(form, previousClient = EMPTY_CLIENT) {
    const formData = new FormData(form);
    const documentFiles = formData.getAll("attachments").filter(isUsableFile);
    const cameraFiles = formData.getAll("cameraPhoto").filter(isUsableFile);
    const fileType = ATTACHMENT_TYPES.includes(formData.get("fileType")) ? formData.get("fileType") : "Autre";
    const newAttachments = [
        ...await filesToAttachments(documentFiles, fileType),
        ...await filesToAttachments(cameraFiles, "Photo")
    ];

    return {
        id: formData.get("id") || createClientId(),
        type: String(formData.get("type") || "Particulier").trim(),
        name: String(formData.get("name") || "").trim(),
        phone: String(formData.get("phone") || "").trim(),
        email: String(formData.get("email") || "").trim(),
        address: String(formData.get("address") || "").trim(),
        city: String(formData.get("city") || "").trim(),
        equipment: String(formData.get("equipment") || "").trim(),
        notes: String(formData.get("notes") || "").trim(),
        activityHistory: normalizeActivityHistory(previousClient.activityHistory),
        attachments: [
            ...normalizeAttachments(previousClient.attachments),
            ...newAttachments
        ]
    };
}

function saveClient(client) {
    try {
        return saveLocalClient(client);
    } catch {
        alert("Le stockage local est plein. Supprime quelques fichiers lourds ou compresse les photos avant de réessayer.");
        return false;
    }
}

async function inspectClientDeletion(client) {
    if (isClientReadOnly()) return;
    try {
        const response = await fetch(`/api/clients/${encodeURIComponent(client.id)}/deletion-analysis`, { credentials: "same-origin" });
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.message);
        openClientLifecycleDialog(client, data.analysis || {});
    } catch (error) {
        alert(error.message || "Analyse du dossier impossible.");
    }
}

function openClientLifecycleDialog(client, analysis) {
    document.querySelector(".client-lifecycle-dialog")?.remove();
    const canDelete = Boolean(analysis.canDeletePermanently) && document.body.dataset.role === "admin";
    const dialog = document.createElement("section");
    dialog.className = "client-lifecycle-dialog";
    dialog.innerHTML = `<div><header><div><p class="eyebrow">${canDelete ? "Suppression définitive" : "Conservation obligatoire"}</p><h2>${escapeHtml(client.name)}</h2></div><button type="button" class="text-button" data-close-client-lifecycle>Fermer</button></header>${analysis.canDeletePermanently ? `<p>Ce client ne possède aucun document nécessitant une conservation.</p>${canDelete ? '<p class="auth-message error"><strong>Cette opération est irréversible.</strong> La fiche client sera supprimée définitivement.</p><label class="client-delete-confirmation">Pour confirmer, saisissez <strong>SUPPRESSION DÉFINITIVE</strong><input data-permanent-delete-confirmation autocomplete="off"></label>' : '<p>La suppression définitive est réservée aux administrateurs. Vous pouvez archiver ce client.</p>'}` : '<p class="auth-message error">Ce client possède des documents ou un historique qui doivent être conservés. La suppression définitive n’est pas disponible. Vous pouvez archiver ce client.</p>'}<div class="client-lifecycle-actions"><button type="button" class="secondary-button" data-close-client-lifecycle>Annuler</button><button type="button" class="secondary-button" data-archive-client>Archiver le client</button>${canDelete ? '<button type="button" class="secondary-button danger-button" data-delete-client disabled>Supprimer définitivement</button>' : ""}</div><p class="auth-message" data-client-lifecycle-feedback aria-live="polite"></p></div>`;
    document.body.append(dialog);
    const close = () => dialog.remove();
    dialog.querySelectorAll("[data-close-client-lifecycle]").forEach(button => button.addEventListener("click", close));
    dialog.querySelector("[data-permanent-delete-confirmation]")?.addEventListener("input", event => { dialog.querySelector("[data-delete-client]").disabled = event.target.value !== "SUPPRESSION DÉFINITIVE"; });
    dialog.querySelector("[data-archive-client]").addEventListener("click", () => changeClientStatus(client.id, "archive", dialog));
    dialog.querySelector("[data-delete-client]")?.addEventListener("click", () => permanentlyDeleteClient(client.id, dialog));
}

async function changeClientStatus(clientId, action, dialog = null) {
    const response = await fetch(`/api/clients/${encodeURIComponent(clientId)}/${action}`, { method: "PATCH", credentials: "same-origin" });
    const data = await response.json().catch(() => null);
    if (!response.ok) { const feedback = dialog?.querySelector("[data-client-lifecycle-feedback]"); if (feedback) { feedback.textContent = data?.message || "Action impossible."; feedback.classList.add("error"); return; } throw new Error(data?.message); }
    dialog?.remove();
    await synchronizeClients({ forceFull: true });
    renderClients({ ...clientScreenOptions, selectedId: action === "reactivate" ? clientId : "" });
}

async function reactivateClient(clientId) {
    try { await changeClientStatus(clientId, "reactivate"); } catch (error) { alert(error.message || "Réactivation impossible."); }
}

async function permanentlyDeleteClient(clientId, dialog) {
    const confirmation = dialog.querySelector("[data-permanent-delete-confirmation]")?.value || "";
    const response = await fetch(`/api/clients/${encodeURIComponent(clientId)}`, { method: "DELETE", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmation }) });
    const data = await response.json().catch(() => null);
    if (!response.ok) { const feedback = dialog.querySelector("[data-client-lifecycle-feedback]"); feedback.textContent = data?.message || "Suppression impossible."; feedback.classList.add("error"); return; }
    removeLocalClient(clientId);
    dialog.remove();
    await synchronizeClients({ forceFull: true });
    renderClients(clientScreenOptions);
}

function isClientReadOnly() {
    return document.body.dataset.role === "technician";
}

function getClientById(id) {
    return getClients().find(client => client.id === id) || null;
}

function getClients() {
    return getLocalClients().map(normalizeClient);
}

export function getSearchableClients() {
    return getClients().filter(client => client.clientStatus !== "archived").map(client => ({
        id: client.id,
        type: client.type,
        name: client.name,
        phone: client.phone,
        email: client.email,
        address: client.address,
        city: client.city,
        equipment: client.equipment,
        notes: client.notes,
        attachments: client.attachments.map(attachment => ({
            id: attachment.id,
            type: attachment.type,
            name: attachment.name,
            dataUrl: attachment.dataUrl,
            reportId: attachment.reportId || "",
            appointmentId: attachment.appointmentId || "",
            createdAt: attachment.createdAt
        }))
    }));
}


function normalizeClient(client) {
    return {
        ...EMPTY_CLIENT,
        ...client,
        id: client.id || createClientId(),
        name: client.name || "Client sans nom",
        clientStatus: client.clientStatus === "archived" ? "archived" : "active",
        attachments: normalizeAttachments(client.attachments),
        activityHistory: normalizeActivityHistory(client.activityHistory)
    };
}

function normalizeAttachments(attachments = []) {
    if (!Array.isArray(attachments)) return [];

    return attachments
        .filter(attachment => attachment && attachment.id)
        .map(attachment => ({
            id: attachment.id || createAttachmentId(),
            type: ATTACHMENT_TYPES.includes(attachment.type) ? attachment.type : "Autre",
            name: attachment.name || "Fichier sans nom",
            mime: attachment.mime || "application/octet-stream",
            size: Number(attachment.size) || 0,
            dataUrl: attachment.dataUrl || "",
            reportId: String(attachment.reportId || "").replace(/[^0-9]/g, ""),
            cachedLocally: attachment.cachedLocally !== false,
            appointmentId: String(attachment.appointmentId || "").replace(/[^0-9]/g, ""),
            createdAt: attachment.createdAt || new Date().toISOString()
        }));
}

function renderClientActivityHistory(client, billingDocuments = [], purchases = [], appointments = []) {
    const activityEntries = deduplicatePartnerMissionActivities(normalizeActivityHistory(client.activityHistory)).filter(entry => !["quote", "invoice", "attachment"].includes(entry.type));
    const billingEntries = billingDocuments.map(document => {
        const type = document.documentType === "invoice" ? "Facture" : document.documentType === "credit" ? "Avoir" : "Devis";
        return {
            id: `billing-${document.id}`,
            type: document.documentType,
            label: `${type} créé(e)`,
            detail: `${document.documentNumber} · ${billingStatusLabel(document.status)}`,
            documentId: String(document.id),
            attachmentId: "",
            actorName: String(document.creatorName || "Auteur non renseigné"),
            createdAt: document.createdAt || document.updatedAt || `${document.issueDate}T12:00:00`
        };
    });
    const purchaseEntries = purchases.map(purchase => {
        const totalTtc = Number(purchase.amountHt || 0) * (1 + Number(purchase.vatRate || 0) / 100);
        return {
            id: `purchase-${purchase.id}`,
            type: "purchase",
            label: "Achat associé au client",
            detail: `${purchase.description}${purchase.supplier ? ` · ${purchase.supplier}` : ""} · ${formatBillingMoney(totalTtc)} TTC`,
            documentId: "",
            attachmentId: "",
            actorName: "",
            createdAt: purchase.createdAt || purchase.updatedAt || `${purchase.purchaseDate}T12:00:00`
        };
    });
    const appointmentEntries = appointments.map(appointment => ({
        id: `appointment-${appointment.id}`,
        type: "appointment",
        label: appointment.eventType === "appointment" ? "Intervention planifiée" : "Événement client",
        detail: [appointment.title, appointment.location, appointment.startTime, appointment.quitusStatus === "validated" ? "Quitus validé" : ""].filter(Boolean).join(" · "),
        documentId: "",
        attachmentId: "",
        actorName: String(appointment.assignedTechnicianName || ""),
        createdAt: `${appointment.date}T${appointment.startTime || "12:00"}:00`
    }));
    const entries = [...activityEntries, ...billingEntries, ...purchaseEntries, ...appointmentEntries]
        .sort((first, second) => new Date(second.createdAt).getTime() - new Date(first.createdAt).getTime());
    if (!entries.length) return "<p class=\"muted\">Les rendez-vous, documents et actions de ce dossier apparaîtront ici.</p>";
    return `<div class="client-activity-list">${entries.map(entry => {
        const isBillingDocument = ["quote", "invoice", "credit"].includes(entry.type) && entry.detail;
        const quitusAttachment = entry.type === "quitus" ? client.attachments.find(attachment => String(attachment.id) === entry.attachmentId || attachment.type === "Quitus" && attachment.name === entry.detail) : null;
        const reportAttachment = entry.type === "technical_report" ? client.attachments.find(attachment => String(attachment.id) === entry.attachmentId || isLeakReportAttachment(attachment) && attachment.name === entry.detail) : null;
        const quitusActions = quitusAttachment ? `<div class="client-card-actions client-activity-actions"><button type="button" class="secondary-button" data-view-quituses="${escapeHtml(quitusAttachment.id)}">Visualiser</button><button type="button" class="secondary-button" data-print-quituses="${escapeHtml(quitusAttachment.id)}">Imprimer / PDF</button><button type="button" class="secondary-button" data-email-quituses="${escapeHtml(quitusAttachment.id)}" ${client.email ? "" : "disabled title=\"Ajoutez l’e-mail du client pour préparer un envoi.\""}>Envoyer par e-mail</button></div>` : "";
        const reportActions = reportAttachment ? `<div class="client-card-actions client-activity-actions"><button type="button" class="secondary-button" data-view-report="${escapeHtml(reportAttachment.id)}">Visualiser</button><button type="button" class="secondary-button" data-print-report="${escapeHtml(reportAttachment.id)}">Imprimer / PDF</button><button type="button" class="secondary-button" data-email-report="${escapeHtml(reportAttachment.id)}" ${client.email ? "" : "disabled title=\"Ajoutez l’e-mail du client pour préparer un envoi.\""}>Envoyer par e-mail</button></div>` : "";
        const actions = isBillingDocument ? `<div class="client-card-actions client-activity-actions"><button type="button" class="secondary-button" data-view-billing-document data-document-id="${escapeHtml(entry.documentId)}" data-document-number="${escapeHtml(entry.detail)}">Visualiser</button><button type="button" class="secondary-button" data-print-billing-document data-document-id="${escapeHtml(entry.documentId)}" data-document-number="${escapeHtml(entry.detail)}">Imprimer / PDF</button><button type="button" class="secondary-button" data-email-billing-document data-document-id="${escapeHtml(entry.documentId)}" data-document-number="${escapeHtml(entry.detail)}" ${client.email ? "" : "disabled title=\"Ajoutez l’e-mail du client pour préparer un envoi.\""}>Envoyer par e-mail</button></div>` : quitusActions || reportActions;
        return `<article class="client-activity-item"><div><strong>${escapeHtml(entry.label)}</strong>${entry.detail ? `<p>${escapeHtml(entry.detail)}</p>` : ""}${entry.actorName ? `<p class="muted">Par ${escapeHtml(entry.actorName)}</p>` : ""}${actions}</div><time datetime="${escapeHtml(entry.createdAt)}">${escapeHtml(formatActivityDate(entry.createdAt))}</time></article>`;
    }).join("")}</div>`;
}

function bindClientHistoryActions(panel, client) {
    panel.querySelectorAll("[data-view-billing-document]").forEach(button => {
        button.addEventListener("click", () => viewClientBillingDocument(client, button.dataset.documentId, button.dataset.documentNumber));
    });
    panel.querySelectorAll("[data-print-billing-document]").forEach(button => {
        button.addEventListener("click", () => printClientBillingDocument(client, button.dataset.documentId, button.dataset.documentNumber));
    });
    panel.querySelectorAll("[data-email-billing-document]").forEach(button => {
        button.addEventListener("click", () => emailClientBillingDocument(client, button.dataset.documentId, button.dataset.documentNumber));
    });
    panel.querySelectorAll("[data-view-quituses]").forEach(button => {
        button.addEventListener("click", () => openClientAttachment(client.id, button.dataset.viewQuituses));
    });
    panel.querySelectorAll("[data-print-quituses]").forEach(button => {
        button.addEventListener("click", () => openClientAttachment(client.id, button.dataset.printQuituses));
    });
    panel.querySelectorAll("[data-email-quituses]").forEach(button => {
        button.addEventListener("click", () => emailClientAttachment(client, button.dataset.emailQuituses));
    });
    panel.querySelectorAll("[data-view-report]").forEach(button => {
        button.addEventListener("click", () => openClientAttachment(client.id, button.dataset.viewReport));
    });
    panel.querySelectorAll("[data-print-report]").forEach(button => {
        button.addEventListener("click", () => openClientAttachment(client.id, button.dataset.printReport));
    });
    panel.querySelectorAll("[data-email-report]").forEach(button => {
        button.addEventListener("click", () => emailClientAttachment(client, button.dataset.emailReport));
    });
}

function isLeakReportAttachment(attachment) {
    return attachment?.type === "Rapport fuite" || /^rapport-recherche-fuite-/i.test(String(attachment?.name || ""));
}

function normalizeActivityHistory(history) {
    return (Array.isArray(history) ? history : [])
        .filter(entry => entry && entry.id && entry.label)
        .map(entry => ({ id: String(entry.id), type: String(entry.type || "other"), label: String(entry.label), detail: String(entry.detail || ""), documentId: String(entry.documentId || ""), attachmentId: String(entry.attachmentId || ""), actorName: String(entry.actorName || ""), createdAt: entry.createdAt || new Date().toISOString() }))
        .sort((first, second) => new Date(second.createdAt).getTime() - new Date(first.createdAt).getTime());
}

function deduplicatePartnerMissionActivities(activities) {
    const seenMissionActivities = new Set();
    return activities.filter(activity => {
        if (activity.type !== "partner_mission" || activity.label !== "Mission partenaire reçue") return true;
        const key = `${activity.label}\u0000${activity.detail}`;
        if (seenMissionActivities.has(key)) return false;
        seenMissionActivities.add(key);
        return true;
    });
}

function formatActivityDate(value) {
    return new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function billingStatusLabel(value) {
    return ({ draft: "Brouillon", sent: "Envoyé", validated: "Validé", paid: "Réglé", issued: "Émis", cancelled: "Annulé", accepted: "Accepté", rejected: "Refusé", pending: "En attente" })[String(value || "").toLowerCase()] || "Brouillon";
}

function createClientId() {
    return `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createAttachmentId() {
    return `file-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatClientLocation(client) {
    return [client.address, client.city].filter(Boolean).join(", ") || "Adresse non renseignée";
}

function getClientNavigationHref(client) {
    const address = [client.address, client.city].filter(Boolean).join(", ").trim();
    return address ? `geo:0,0?q=${encodeURIComponent(address)}` : "";
}

function createEmptyDirectoryFilters() {
    return { status: "active", field: "name", query: "", createdDate: "", appointmentDate: "", year: "", month: "" };
}

function readDirectoryFilters(formData) {
    return {
        status: ["active", "archived", "all"].includes(formData.get("status")) ? formData.get("status") : "active",
        field: ["name", "phone", "address", "email"].includes(formData.get("field")) ? formData.get("field") : "name",
        query: String(formData.get("query") || "").trim(),
        createdDate: String(formData.get("createdDate") || ""),
        appointmentDate: String(formData.get("appointmentDate") || ""),
        year: /^\d{4}$/.test(String(formData.get("year") || "")) ? String(formData.get("year")) : "",
        month: /^(0[1-9]|1[0-2])$/.test(String(formData.get("month") || "")) ? String(formData.get("month")) : ""
    };
}

function getDirectoryYears(clients) {
    return [...new Set(clients.map(client => parseDirectoryDate(client.createdAt)?.getFullYear()).filter(Boolean))].sort((first, second) => second - first);
}

function getDirectoryMonths() {
    return Array.from({ length: 12 }, (_, index) => {
        const date = new Date(2024, index, 1);
        return { value: String(index + 1).padStart(2, "0"), label: new Intl.DateTimeFormat("fr-FR", { month: "long" }).format(date) };
    });
}

function clientMatchesDirectoryFilters(client, filters, appointmentDatesByClient) {
    if (filters.status !== "all" && client.clientStatus !== filters.status) return false;
    const date = parseDirectoryDate(client.createdAt);
    const searchableValue = filters.field === "address"
        ? [client.address, client.city].join(" ")
        : client[filters.field] || "";
    if (filters.query && !normalizeText(searchableValue).includes(normalizeText(filters.query))) return false;
    if (filters.createdDate && toDirectoryDateString(date) !== filters.createdDate) return false;
    if (filters.year && String(date?.getFullYear() || "") !== filters.year) return false;
    if (filters.month && String((date?.getMonth() || 0) + 1).padStart(2, "0") !== filters.month) return false;
    if (filters.appointmentDate && !(appointmentDatesByClient.get(client.id) || []).some(value => value === filters.appointmentDate)) return false;
    return true;
}

async function loadAppointmentDatesByClient() {
    const response = await fetch("/api/calendar/events?start=2000-01-01&end=2100-12-31", { credentials: "same-origin" });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.message || "Impossible de charger les rendez-vous.");
    const clientsByName = new Map(getClients().map(client => [normalizeText(client.name), client.id]));
    const datesByClient = new Map();
    (payload?.events || []).filter(event => event.eventType === "appointment" && event.clientName && /^\d{4}-\d{2}-\d{2}$/.test(event.date || "")).forEach(event => {
        const clientId = clientsByName.get(normalizeText(event.clientName));
        if (!clientId) return;
        const dates = datesByClient.get(clientId) || [];
        if (!dates.includes(event.date)) dates.push(event.date);
        datesByClient.set(clientId, dates.sort());
    });
    return datesByClient;
}

function parseDirectoryDate(value) {
    const date = new Date(value || "");
    return Number.isNaN(date.getTime()) ? null : date;
}

function toDirectoryDateString(date) {
    if (!date) return "";
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

function formatDirectoryMonth(date) {
    return new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" }).format(date).replace(/^./, letter => letter.toUpperCase());
}

function formatDirectoryShortDate(value) {
    return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(`${value}T12:00:00`));
}

function isUsableFile(file) {
    return file instanceof File && file.size > 0;
}

async function filesToAttachments(files, type) {
    const attachments = [];

    for (const file of files) {
        if (file.size > MAX_ATTACHMENT_SIZE) {
            alert(`${file.name} est trop lourd. Limite : ${formatFileSize(MAX_ATTACHMENT_SIZE)} par fichier.`);
            continue;
        }

        attachments.push({
            id: createAttachmentId(),
            type,
            name: file.name || `${type}-${new Date().toISOString().slice(0, 10)}.jpg`,
            mime: file.type || "application/octet-stream",
            size: file.size,
            dataUrl: await readFileAsDataUrl(file),
            createdAt: new Date().toISOString()
        });
    }

    return attachments;
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => resolve(reader.result));
        reader.addEventListener("error", () => reject(reader.error));
        reader.readAsDataURL(file);
    });
}

function renderAttachmentsHtml(clientId, attachments, recipient) {
    return `
        <div class="attachment-list">
            ${normalizeAttachments(attachments).map(attachment => `
                <article class="attachment-card">
                    ${renderAttachmentPreview(attachment)}
                    <div>
                        <p class="eyebrow">${escapeHtml(attachment.type)}</p>
                        <h4>${getAttachmentIcon(attachment)} ${escapeHtml(attachment.name)}</h4>
                        <p class="muted">${escapeHtml(formatFileSize(attachment.size))} · ${escapeHtml(formatDate(attachment.createdAt))}</p>
                    </div>
                    <div class="attachment-actions">
                        <a class="secondary-button" href="/api/clients/${encodeURIComponent(clientId)}/attachments/${encodeURIComponent(attachment.id)}/open" target="_blank" rel="noopener">Ouvrir</a>
                        <a class="secondary-button" href="/api/clients/${encodeURIComponent(clientId)}/attachments/${encodeURIComponent(attachment.id)}/open" download="${escapeHtml(attachment.name)}">Télécharger</a>
                        <button type="button" class="secondary-button" data-email-attachment="${escapeHtml(attachment.id)}" ${recipient ? "" : "disabled title=\"Ajoutez l’e-mail du client pour envoyer ce fichier.\""}>Envoyer par e-mail</button>
                    </div>
                </article>
            `).join("")}
        </div>
    `;
}

function isInterventionPhoto(attachment) {
    return Boolean(attachment?.appointmentId) && ["Photo", "Photo avant", "Photo après"].includes(attachment.type);
}

function renderInterventionPhotoHtml(clientId, attachment) {
    const type = attachment.type === "Photo avant" ? "Avant intervention" : attachment.type === "Photo après" ? "Après intervention" : "Photo d’intervention";
    const url = `/api/clients/${encodeURIComponent(clientId)}/attachments/${encodeURIComponent(attachment.id)}/open`;
    return `<article class="client-intervention-photo"><a href="${url}" target="_blank" rel="noopener"><img src="${escapeHtml(attachment.dataUrl || url)}" alt="${escapeHtml(attachment.name)}"></a><div><strong>${escapeHtml(type)}</strong><span>${escapeHtml(attachment.name)}</span><small>${escapeHtml(formatDate(attachment.createdAt))}</small></div></article>`;
}


function getAttachmentIcon(attachment) {
    if (attachment.type === "Photo" || attachment.mime.startsWith("image/")) return "";
    if (attachment.type === "Devis") return "";
    if (attachment.type === "Facture") return "";
    if (attachment.type === "Quitus") return "";
    if (attachment.mime.includes("pdf")) return "";
    return "";
}

function renderAttachmentPreview(attachment) {
    if (!attachment.mime.startsWith("image/") || !attachment.dataUrl) return "";

    return `<img class="attachment-preview" src="${escapeHtml(attachment.dataUrl)}" alt="Aperçu ${escapeHtml(attachment.name)}">`;
}

function formatFileSize(size) {
    if (!size) return "Taille inconnue";
    if (size < 1024) return `${size} o`;
    if (size < 1024 * 1024) return `${Math.round(size / 1024)} Ko`;
    return `${(size / 1024 / 1024).toFixed(1)} Mo`;
}

function formatDate(value) {
    if (!value) return "Date inconnue";

    return new Intl.DateTimeFormat("fr-FR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric"
    }).format(new Date(value));
}
