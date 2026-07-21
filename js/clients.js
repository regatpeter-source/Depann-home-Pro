import { ROUTES, STORAGE_KEYS } from "./config.js?v=56";
import { resetSelection } from "./state.js?v=44";
import { escapeHtml, normalizeText } from "./utils.js?v=44";
import { analyzeEquipmentPhoto, isPhotoRecognitionConfident } from "./photo-recognition.js?v=56";
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
    attachments: []
};

const ATTACHMENT_TYPES = ["Devis", "Facture", "Photo", "Autre"];
const MAX_ATTACHMENT_SIZE = 4 * 1024 * 1024;
let clientScreenOptions = {};

export function renderClients(options = {}) {
    clientScreenOptions = { ...clientScreenOptions, ...options };
    clearSearch();
    resetSelection("all");
    setPage("Clients", ROUTES.clients, "detail");

    const container = getContainer();
    const clients = getClients();
    const editingClient = options.editId ? getClientById(options.editId) : null;
    const selectedClient = options.selectedId ? getClientById(options.selectedId) : null;

    container.appendChild(renderClientToolbar(clients));
    container.appendChild(renderClientForm(editingClient || EMPTY_CLIENT, clientScreenOptions));

    if (selectedClient) {
        container.appendChild(renderClientDetail(selectedClient));
    }

    container.appendChild(renderClientList(clients));
}

function renderClientToolbar(clients) {
    const panel = document.createElement("section");
    panel.className = "client-panel";

    panel.innerHTML = `
        <div>
                <p class="eyebrow">Base locale privée</p>
            <h2> ${clients.length} client(s)</h2>
            <p class="muted">Les clients sont enregistrés sur cet appareil, dans l’espace du compte connecté. Ils apparaissent dans la recherche globale de ce compte.</p>
        </div>
        <div class="client-toolbar-actions">
            <input id="clientSearch" class="client-search" type="search" placeholder="Rechercher un client, une ville, un équipement...">
            <button type="button" class="secondary-button" id="newClientBtn">+ Nouveau client</button>
        </div>
    `;

    panel.querySelector("#newClientBtn").addEventListener("click", () => renderClients());
    panel.querySelector("#clientSearch").addEventListener("input", event => {
        filterClientList(event.target.value);
    });

    return panel;
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

                ${client.attachments.length ? renderAttachmentsHtml(client.attachments, false) : "<p class=\"muted\">Aucun fichier enregistré pour ce client.</p>"}

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

                <section class="procedure-section photo-recognition-inline">
                    <h3> Détection visuelle</h3>
                    <div name="photoRecognitionStatus" class="muted">Prenez une photo pour détecter automatiquement la gamme ou le dossier probable.</div>
                    <div name="photoRecognitionResult"></div>
                </section>

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

        if (saveClient(nextClient)) {
            renderClients({ selectedId: nextClient.id, ...clientScreenOptions });
        }
    });

    panel.querySelector("#cancelEditBtn")?.addEventListener("click", () => renderClients(clientScreenOptions));

    const cameraInput = panel.querySelector('input[name="cameraPhoto"]');
    const recognitionStatus = panel.querySelector('[name="photoRecognitionStatus"]');
    const recognitionResult = panel.querySelector('[name="photoRecognitionResult"]');

    cameraInput?.addEventListener("change", async event => {
        const file = event.target.files?.[0] || null;

        if (!file) {
            recognitionStatus.textContent = "Aucune photo sélectionnée.";
            recognitionResult.innerHTML = "";
            return;
        }

        recognitionStatus.textContent = `Analyse de ${file.name}...`;
        recognitionResult.innerHTML = "";

        try {
            const analysis = await analyzeEquipmentPhoto(file, options.database || { brands: [] });
            renderClientPhotoRecognition(analysis, recognitionStatus, recognitionResult, options.navigateToRef);
        } catch (error) {
            recognitionStatus.textContent = error.message || "Reconnaissance indisponible.";
        }
    });

    return panel;
}

function renderClientPhotoRecognition(analysis, statusNode, resultNode, navigateToRef) {
    const { predictions, query, results } = analysis;
    const predictionsText = predictions.length
        ? predictions.map(item => `${item.label} (${Math.round(item.score * 100)}%)`).join(" · ")
        : "Aucune détection IA disponible";

    statusNode.innerHTML = `
        <strong>Requête :</strong> ${escapeHtml(query)}<br>
        <strong>Indices :</strong> ${escapeHtml(predictionsText)}
    `;

    if (!results.length) {
        resultNode.innerHTML = "<p class=\"muted\">Aucun dossier n’a été trouvé pour cette photo.</p>";
        return;
    }

    const best = results[0];
    resultNode.innerHTML = `
        <div class="photo-recognition-best">
            <p class="eyebrow">Meilleure correspondance</p>
            <h4>${escapeHtml(best.title)}</h4>
            <p class="muted">${escapeHtml(best.subtitle)}</p>
        </div>
    `;

    if (isPhotoRecognitionConfident(predictions, best) && typeof navigateToRef === "function") {
        statusNode.textContent = "Bonne correspondance trouvée, ouverture du dossier...";
        window.setTimeout(() => navigateToRef(best.ref), 650);
    }
}

function renderClientList(clients) {
    const section = document.createElement("section");
    section.className = "client-list";
    section.id = "clientList";

    if (!clients.length) {
        section.appendChild(createInfo("Aucun client enregistré pour le moment."));
        return section;
    }

    clients
        .sort((a, b) => a.name.localeCompare(b.name, "fr"))
        .forEach(client => {
            section.appendChild(renderClientCard(client));
        });

    return section;
}

function renderClientCard(client) {
    const card = document.createElement("article");
    card.className = "client-card";
    card.dataset.search = normalizeText([
        client.name,
        client.type,
        client.phone,
        client.email,
        client.address,
        client.city,
        client.equipment,
        client.notes,
        client.attachments.map(attachment => `${attachment.type} ${attachment.name}`).join(" ")
    ].join(" "));

    card.innerHTML = `
        <div>
            <p class="eyebrow">${escapeHtml(client.type)}</p>
            <h3>${escapeHtml(client.name)}</h3>
            <p>${escapeHtml(formatClientLocation(client))}</p>
            <p class="muted">${escapeHtml(client.phone || "Téléphone non renseigné")}</p>
            <p class="muted"> ${client.attachments.length} fichier(s)</p>
        </div>
        <div class="client-card-actions">
            <button type="button" class="secondary-button" data-action="view">Voir</button>
            <button type="button" class="secondary-button" data-action="edit">Modifier</button>
            <button type="button" class="secondary-button danger-button" data-action="delete">Supprimer</button>
        </div>
    `;

    card.querySelector('[data-action="view"]').addEventListener("click", () => renderClients({ selectedId: client.id }));
    card.querySelector('[data-action="edit"]').addEventListener("click", () => renderClients({ editId: client.id }));
    card.querySelector('[data-action="delete"]').addEventListener("click", () => {
        if (confirm(`Supprimer le client ${client.name} ?`)) {
            deleteClient(client.id);
            renderClients();
        }
    });

    return card;
}

function renderClientDetail(client) {
    const panel = document.createElement("section");
    panel.className = "client-panel";

    panel.innerHTML = `
        <div class="procedure-header">
            <div>
                <p class="eyebrow">Fiche client</p>
                <h2>${escapeHtml(client.name)}</h2>
            </div>
            <button type="button" class="secondary-button" id="editSelectedClient">Modifier</button>
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
            <h3> Fichiers du client</h3>
            ${client.attachments.length ? renderAttachmentsHtml(client.attachments, true) : "<p>Aucun fichier enregistré.</p>"}
        </section>
    `;

    panel.querySelector("#editSelectedClient").addEventListener("click", () => renderClients({ editId: client.id }));
    panel.querySelectorAll("[data-delete-attachment]").forEach(button => {
        button.addEventListener("click", () => {
            const attachmentId = button.dataset.deleteAttachment;

            if (confirm("Supprimer ce fichier du dossier client ?")) {
                deleteClientAttachment(client.id, attachmentId);
                renderClients({ selectedId: client.id });
            }
        });
    });

    return panel;
}

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
        attachments: [
            ...normalizeAttachments(previousClient.attachments),
            ...newAttachments
        ]
    };
}

function saveClient(client) {
    const clients = getClients();
    const now = new Date().toISOString();
    const existing = clients.find(item => item.id === client.id);

    const nextClient = {
        ...client,
        createdAt: existing?.createdAt || now,
        updatedAt: now
    };

    const nextClients = existing
        ? clients.map(item => item.id === client.id ? nextClient : item)
        : [...clients, nextClient];

    try {
        localStorage.setItem(getClientsStorageKey(), JSON.stringify(nextClients));
        return true;
    } catch {
        alert("Le stockage local est plein. Supprime quelques fichiers lourds ou compresse les photos avant de réessayer.");
        return false;
    }
}

function deleteClient(id) {
    const clients = getClients().filter(client => client.id !== id);
    localStorage.setItem(getClientsStorageKey(), JSON.stringify(clients));
}

function getClientById(id) {
    return getClients().find(client => client.id === id) || null;
}

function getClients() {
    try {
        return (JSON.parse(localStorage.getItem(getClientsStorageKey())) || []).map(normalizeClient);
    } catch {
        return [];
    }
}

export function getSearchableClients() {
    return getClients().map(client => ({
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
            name: attachment.name
        }))
    }));
}

function getClientsStorageKey() {
    const userId = String(document.body.dataset.userId || "anonymous").replace(/[^a-zA-Z0-9_-]/g, "");
    return `${STORAGE_KEYS.clients}:${userId || "anonymous"}`;
}

function normalizeClient(client) {
    return {
        ...EMPTY_CLIENT,
        ...client,
        id: client.id || createClientId(),
        name: client.name || "Client sans nom",
        attachments: normalizeAttachments(client.attachments)
    };
}

function normalizeAttachments(attachments = []) {
    if (!Array.isArray(attachments)) return [];

    return attachments
        .filter(attachment => attachment && attachment.dataUrl)
        .map(attachment => ({
            id: attachment.id || createAttachmentId(),
            type: ATTACHMENT_TYPES.includes(attachment.type) ? attachment.type : "Autre",
            name: attachment.name || "Fichier sans nom",
            mime: attachment.mime || "application/octet-stream",
            size: Number(attachment.size) || 0,
            dataUrl: attachment.dataUrl,
            createdAt: attachment.createdAt || new Date().toISOString()
        }));
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

function filterClientList(query) {
    const normalizedQuery = normalizeText(query);
    document.querySelectorAll(".client-card").forEach(card => {
        card.hidden = normalizedQuery && !card.dataset.search.includes(normalizedQuery);
    });
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

function renderAttachmentsHtml(attachments, withActions) {
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
                        <a class="secondary-button" href="${escapeHtml(attachment.dataUrl)}" target="_blank" rel="noopener">Ouvrir</a>
                        <a class="secondary-button" href="${escapeHtml(attachment.dataUrl)}" download="${escapeHtml(attachment.name)}">Télécharger</a>
                        ${withActions ? `<button type="button" class="secondary-button danger-button" data-delete-attachment="${escapeHtml(attachment.id)}">Supprimer</button>` : ""}
                    </div>
                </article>
            `).join("")}
        </div>
    `;
}

function deleteClientAttachment(clientId, attachmentId) {
    const client = getClientById(clientId);

    if (!client) return;

    saveClient({
        ...client,
        attachments: client.attachments.filter(attachment => attachment.id !== attachmentId)
    });
}

function getAttachmentIcon(attachment) {
    if (attachment.type === "Photo" || attachment.mime.startsWith("image/")) return "";
    if (attachment.type === "Devis") return "";
    if (attachment.type === "Facture") return "";
    if (attachment.mime.includes("pdf")) return "";
    return "";
}

function renderAttachmentPreview(attachment) {
    if (!attachment.mime.startsWith("image/")) return "";

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
