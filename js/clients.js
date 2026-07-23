import { ROUTES } from "./config.js?v=88";
import { addClientActivity, deleteLocalClient, getLocalClients, saveLocalClient, synchronizeClients } from "./client-sync.js?v=88";
import { renderClientMessages } from "./messages.js?v=88";
import { resetSelection } from "./state.js?v=44";
import { escapeHtml, normalizeText } from "./utils.js?v=44";
import { analyzeEquipmentPhoto, isPhotoRecognitionConfident } from "./photo-recognition.js?v=59";
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
    const readOnly = isClientReadOnly();
    const editingClient = !readOnly && options.editId ? getClientById(options.editId) : null;
    const selectedClient = options.selectedId ? getClientById(options.selectedId) : null;

    container.appendChild(renderClientToolbar(clients, readOnly));
    if (!readOnly) container.appendChild(renderClientForm(editingClient || EMPTY_CLIENT, clientScreenOptions));

    if (selectedClient) {
        container.appendChild(renderClientDetail(selectedClient, { focusMessages: Boolean(options.focusMessages) }));
    }

    container.appendChild(renderClientList(clients));
}

function renderClientToolbar(clients, readOnly) {
    const panel = document.createElement("section");
    panel.className = "client-panel";

    panel.innerHTML = `
        <div>
                <p class="eyebrow">${readOnly ? "Dossiers d’intervention" : "Base clients"}</p>
            <h2> ${clients.length} client(s)</h2>
            <p class="muted">${readOnly ? "Recherchez un client pour consulter ses coordonnées, équipements, consignes et documents utiles à l’intervention." : "Les dossiers clients sont synchronisés dans l’espace entreprise."}</p>
        </div>
        <div class="client-toolbar-actions">
            <input id="clientSearch" class="client-search" type="search" placeholder="Saisir le nom d’un client..." aria-describedby="clientSearchHint">
            <button type="button" class="secondary-button" id="syncClientsBtn">${readOnly ? "Actualiser" : "Synchroniser"}</button>
            ${readOnly ? "" : '<button type="button" class="secondary-button" id="newClientBtn">+ Nouveau client</button>'}
        </div>
        <p id="clientSearchHint" class="client-search-hint">Sur téléphone, saisissez le nom d’un client pour afficher son dossier.</p>
        <p id="clientSyncMessage" class="auth-message" aria-live="polite"></p>
    `;

    panel.querySelector("#newClientBtn")?.addEventListener("click", () => renderClients());
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

                ${client.attachments.length ? renderAttachmentsHtml(client.id, client.attachments, false) : "<p class=\"muted\">Aucun fichier enregistré pour ce client.</p>"}

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
    section.className = "client-list client-table-wrapper";
    section.id = "clientList";
    section.dataset.hasQuery = "false";

    if (!clients.length) {
        section.appendChild(createInfo("Aucun client enregistré pour le moment."));
        return section;
    }

    const table = document.createElement("table");
    table.className = "client-table";
    table.innerHTML = `
        <thead>
            <tr>
                <th scope="col">Client</th>
                <th scope="col">Type</th>
                <th scope="col">Coordonnées</th>
                <th scope="col">Adresse</th>
                <th scope="col">Dossier</th>
                <th scope="col"><span class="sr-only">Actions</span></th>
            </tr>
        </thead>
        <tbody></tbody>
    `;
    const body = table.querySelector("tbody");
    clients
        .sort((a, b) => a.name.localeCompare(b.name, "fr"))
        .forEach(client => {
            body.appendChild(renderClientTableRow(client));
        });
    section.appendChild(table);

    return section;
}

function renderClientTableRow(client) {
    const readOnly = isClientReadOnly();
    const row = document.createElement("tr");
    row.className = "client-table-row";
    row.dataset.clientName = normalizeText(client.name);
    row.innerHTML = `
        <td data-label="Client"><strong>${escapeHtml(client.name)}</strong></td>
        <td data-label="Type">${escapeHtml(client.type)}</td>
        <td data-label="Coordonnées"><span>${escapeHtml(client.phone || "Téléphone non renseigné")}</span>${client.email ? `<small>${escapeHtml(client.email)}</small>` : ""}</td>
        <td data-label="Adresse">${escapeHtml(formatClientLocation(client))}</td>
        <td data-label="Dossier">${client.attachments.length} fichier(s)</td>
        <td data-label="Actions"><div class="client-card-actions">
            <button type="button" class="secondary-button" data-action="view">Voir</button>
            ${readOnly ? "" : '<button type="button" class="secondary-button" data-action="edit">Modifier</button><button type="button" class="secondary-button danger-button" data-action="delete">Supprimer</button>'}
        </div></td>
    `;

    row.querySelector('[data-action="view"]').addEventListener("click", () => renderClients({ selectedId: client.id }));
    row.querySelector('[data-action="edit"]')?.addEventListener("click", () => renderClients({ editId: client.id }));
    row.querySelector('[data-action="delete"]')?.addEventListener("click", () => {
        if (confirm(`Supprimer le client ${client.name} ?`)) {
            deleteClient(client.id);
            renderClients();
        }
    });

    return row;
}

function renderClientDetail(client, options = {}) {
    const readOnly = isClientReadOnly();
    const navigationHref = getClientNavigationHref(client);
    const panel = document.createElement("section");
    panel.className = "client-panel";

    panel.innerHTML = `
        <div class="procedure-header">
            <div>
                <p class="eyebrow">Fiche client</p>
                <h2>${escapeHtml(client.name)}</h2>
            </div>
            <div class="client-card-actions">
                ${navigationHref ? `<a class="secondary-button client-navigation-button" href="${escapeHtml(navigationHref)}" aria-label="Y aller vers ${escapeHtml(formatClientLocation(client))}">Y aller</a>` : '<button type="button" class="secondary-button client-navigation-button" disabled title="Ajoutez une adresse au client pour lancer la navigation.">Y aller</button>'}
                ${readOnly ? '<button type="button" class="secondary-button" id="createClientQuote">+ Créer un devis</button><button type="button" class="secondary-button" id="createClientInvoice">+ Créer une facture</button>' : '<button type="button" class="secondary-button" id="createClientAppointment">+ Créer un rendez-vous</button><button type="button" class="secondary-button" id="createClientQuote">+ Créer un devis</button><button type="button" class="secondary-button" id="createClientInvoice">+ Créer une facture</button><button type="button" class="secondary-button" id="editSelectedClient">Modifier</button>'}
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
            ${renderClientActivityHistory(client.activityHistory)}
        </section>
        <section class="procedure-section">
            <h3> Fichiers du client</h3>
            ${client.attachments.length ? renderAttachmentsHtml(client.id, client.attachments, !readOnly) : "<p>Aucun fichier enregistré.</p>"}
        </section>
    `;

    panel.querySelector("#editSelectedClient")?.addEventListener("click", () => renderClients({ editId: client.id }));
    panel.querySelector("#createClientAppointment")?.addEventListener("click", () => openClientAppointment(client));
    panel.querySelector("#createClientQuote")?.addEventListener("click", () => openClientBillingDocument("quote", client));
    panel.querySelector("#createClientInvoice")?.addEventListener("click", () => openClientBillingDocument("invoice", client));
    panel.querySelectorAll("[data-delete-attachment]").forEach(button => {
        button.addEventListener("click", () => {
            const attachmentId = button.dataset.deleteAttachment;

            if (confirm("Supprimer ce fichier du dossier client ?")) {
                deleteClientAttachment(client.id, attachmentId);
                renderClients({ selectedId: client.id });
            }
        });
    });

    const detail = document.createDocumentFragment();
    detail.append(panel);
    detail.append(renderClientMessages(client, options.focusMessages));
    detail.append(renderClientBillingDocuments(client));
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

function renderClientBillingDocuments(client) {
    const panel = document.createElement("section");
    panel.className = "client-panel client-billing-panel";
    panel.innerHTML = "<p class=\"muted\">Chargement des devis et factures du client…</p>";
    loadClientBillingDocuments(panel, client);
    return panel;
}

async function loadClientBillingDocuments(panel, client) {
    try {
        const response = await fetch("/api/billing", { credentials: "same-origin" });
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.message);
        const documents = (data?.documents || []).filter(document => normalizeText(document.customerName) === normalizeText(client.name));
        panel.innerHTML = `
            <div class="form-heading"><div><p class="eyebrow">Devis, factures et envois</p><h2>${documents.length} document(s) pour ${escapeHtml(client.name)}</h2><p class="muted">Les documents associés à ce client peuvent être imprimés ou préparés pour un envoi e-mail.</p></div></div>
            <div class="client-billing-list" id="clientBillingList"></div>
        `;
        const list = panel.querySelector("#clientBillingList");
        if (!documents.length) {
            list.innerHTML = "<p class=\"muted\">Aucun devis ou aucune facture associé(e) à ce client pour le moment.</p>";
            return;
        }
        documents.forEach(document => {
            const article = document.createElement("article");
            article.className = "client-billing-item";
            article.innerHTML = `<div><p class="eyebrow">${document.documentType === "invoice" ? "Facture" : "Devis"} · ${escapeHtml(document.status || "brouillon")}</p><h3>${escapeHtml(document.documentNumber)}</h3><p>${escapeHtml(formatBillingDate(document.issueDate))}</p></div><div class="client-card-actions"><button type="button" class="secondary-button" data-action="email">E-mail</button><button type="button" class="secondary-button" data-action="print">Imprimer / PDF</button></div>`;
            article.querySelector('[data-action="email"]').addEventListener("click", () => emailBillingDocument(document, client));
            article.querySelector('[data-action="print"]').addEventListener("click", () => printBillingDocument(document.id));
            list.appendChild(article);
        });
    } catch (error) {
        panel.innerHTML = `<p class="auth-message error">${escapeHtml(error.message || "Impossible de charger les documents du client.")}</p>`;
    }
}

function emailBillingDocument(document, client) {
    const type = document.documentType === "invoice" ? "facture" : "devis";
    const subject = `${type.charAt(0).toUpperCase()}${type.slice(1)} ${document.documentNumber}`;
    const body = `Bonjour ${client.name},%0D%0A%0D%0AVeuillez trouver ci-joint votre ${type} ${document.documentNumber}.%0D%0A%0D%Cordialement,`;
    window.location.href = `mailto:${encodeURIComponent(client.email || "")}?subject=${encodeURIComponent(subject)}&body=${body}`;
}

async function printBillingDocument(documentId) {
    const popup = window.open("", "_blank");
    if (!popup) { alert("Autorisez les fenêtres pop-up pour imprimer le document."); return; }
    popup.document.write("<p>Préparation du document…</p>");
    try {
        const response = await fetch(`/api/billing/documents/${encodeURIComponent(documentId)}`, { credentials: "same-origin" });
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.message);
        popup.document.open();
        popup.document.write(buildPrintableBillingHtml(data.document, data.profile));
        popup.document.close();
        popup.focus();
        popup.print();
    } catch (error) {
        popup.document.body.innerHTML = `<p>Erreur : ${escapeHtml(error.message || "document indisponible")}</p>`;
    }
}

function buildPrintableBillingHtml(document, profile) {
    const lines = Array.isArray(document.lines) ? document.lines : [];
    const totalHt = lines.reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unitPrice || 0), 0);
    const totalVat = lines.reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unitPrice || 0) * Number(line.vatRate || 0) / 100, 0);
    const title = document.documentType === "invoice" ? "FACTURE" : "DEVIS";
    return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${escapeHtml(title)} ${escapeHtml(document.documentNumber)}</title><style>body{font-family:Arial,sans-serif;color:#172033;margin:42px;line-height:1.45}.top{display:flex;justify-content:space-between;gap:30px;border-bottom:3px solid #0a5c36;padding-bottom:22px}.company{max-width:52%}.logo{max-width:160px;max-height:80px;object-fit:contain}.title{font-size:29px;color:#003b73;font-weight:800}.meta{margin:28px 0;display:flex;justify-content:space-between;gap:30px}table{width:100%;border-collapse:collapse;margin-top:24px}th{background:#003b73;color:#fff;text-align:left}th,td{padding:10px;border:1px solid #dbe3ea}td.num{text-align:right}.totals{margin:24px 0 0 auto;width:300px}.totals p{display:flex;justify-content:space-between;margin:5px 0}.total{border-top:2px solid #0a5c36;padding-top:8px;font-size:19px;font-weight:800;color:#003b73}.notes{margin-top:35px;border-top:1px solid #dbe3ea;padding-top:15px;white-space:pre-wrap}@media print{body{margin:18mm}}</style></head><body><div class="top"><div class="company">${profile.hasLogo ? '<img class="logo" src="/api/billing/logo" alt="Logo">' : ""}<h2>${escapeHtml(profile.companyName || "Votre structure")}</h2><p>${escapeHtml([profile.legalForm, profile.address, [profile.postalCode, profile.city].filter(Boolean).join(" "), profile.phone, profile.email, profile.registrationNumber, profile.taxNumber].filter(Boolean).join(" · "))}</p></div><div><div class="title">${title}</div><p><strong>N° ${escapeHtml(document.documentNumber)}</strong><br>Date : ${escapeHtml(formatBillingDate(document.issueDate))}${document.dueDate ? `<br>Échéance : ${escapeHtml(formatBillingDate(document.dueDate))}` : ""}</p></div></div><div class="meta"><div><strong>Destinataire</strong><br>${escapeHtml(document.customerName)}<br>${escapeHtml(document.customerAddress || "")}</div><div><strong>Catégorie</strong><br>${escapeHtml(document.customerType)}</div></div><table><thead><tr><th>Description</th><th>Qté</th><th>Unité</th><th>PU HT</th><th>TVA</th><th>Total HT</th></tr></thead><tbody>${lines.map(line => `<tr><td>${escapeHtml(line.description)}</td><td class="num">${escapeHtml(line.quantity)}</td><td>${escapeHtml(line.unit)}</td><td class="num">${formatBillingMoney(line.unitPrice)}</td><td class="num">${escapeHtml(line.vatRate)} %</td><td class="num">${formatBillingMoney(Number(line.quantity || 0) * Number(line.unitPrice || 0))}</td></tr>`).join("")}</tbody></table><div class="totals"><p><span>Total HT</span><strong>${formatBillingMoney(totalHt)}</strong></p><p><span>TVA</span><strong>${formatBillingMoney(totalVat)}</strong></p><p class="total"><span>Total TTC</span><span>${formatBillingMoney(totalHt + totalVat)}</span></p></div>${document.notes ? `<div class="notes"><strong>Notes / conditions</strong><br>${escapeHtml(document.notes)}</div>` : ""}${profile.footerNote ? `<div class="notes">${escapeHtml(profile.footerNote)}</div>` : ""}</body></html>`;
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

function deleteClient(id) {
    if (isClientReadOnly()) return;
    deleteLocalClient(id);
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


function normalizeClient(client) {
    return {
        ...EMPTY_CLIENT,
        ...client,
        id: client.id || createClientId(),
        name: client.name || "Client sans nom",
        attachments: normalizeAttachments(client.attachments),
        activityHistory: normalizeActivityHistory(client.activityHistory)
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

function renderClientActivityHistory(history) {
    const entries = normalizeActivityHistory(history);
    if (!entries.length) return "<p class=\"muted\">Les rendez-vous, documents et actions de ce dossier apparaîtront ici.</p>";
    return `<div class="client-activity-list">${entries.map(entry => `<article class="client-activity-item"><div><strong>${escapeHtml(entry.label)}</strong>${entry.detail ? `<p>${escapeHtml(entry.detail)}</p>` : ""}${entry.actorName ? `<p class="muted">Par ${escapeHtml(entry.actorName)}</p>` : ""}</div><time datetime="${escapeHtml(entry.createdAt)}">${escapeHtml(formatActivityDate(entry.createdAt))}</time></article>`).join("")}</div>`;
}

function normalizeActivityHistory(history) {
    return (Array.isArray(history) ? history : [])
        .filter(entry => entry && entry.id && entry.label)
        .map(entry => ({ id: String(entry.id), label: String(entry.label), detail: String(entry.detail || ""), actorName: String(entry.actorName || ""), createdAt: entry.createdAt || new Date().toISOString() }))
        .sort((first, second) => new Date(second.createdAt).getTime() - new Date(first.createdAt).getTime());
}

function formatActivityDate(value) {
    return new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
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

function filterClientList(query) {
    const normalizedQuery = normalizeText(query).trim();
    const list = document.getElementById("clientList");
    if (list) list.dataset.hasQuery = String(Boolean(normalizedQuery));

    document.querySelectorAll(".client-table-row").forEach(row => {
        row.hidden = Boolean(normalizedQuery) && !row.dataset.clientName.includes(normalizedQuery);
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

function renderAttachmentsHtml(clientId, attachments, withActions) {
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

    const attachment = client.attachments.find(item => item.id === attachmentId);
    const savedClient = saveClient({
        ...client,
        attachments: client.attachments.filter(attachment => attachment.id !== attachmentId)
    });
    if (savedClient && attachment) addClientActivity(savedClient.id, { type: "attachment", label: "Fichier supprimé", detail: attachment.name });
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
