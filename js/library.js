import { ROUTES } from "./config.js?v=81";
import { resetSelection } from "./state.js?v=44";
import { escapeHtml } from "./utils.js?v=44";
import { clearSearch, createInfo, getContainer, setPage } from "./ui.js?v=44";

const MAX_FILE_SIZE_LABEL = "20 Mo";
let selectedSectionId = null;

export async function renderLibrary() {
    clearSearch();
    resetSelection("all");
    setPage("Bibliothèque", ROUTES.library, "detail");

    const container = getContainer();
    container.appendChild(createInfo("Conservez vos notices et documents techniques dans votre espace personnel. Ils ne sont visibles que depuis votre compte."));

    const [sectionPanel, uploadPanel, listPanel] = [
        document.createElement("section"),
        document.createElement("section"),
        document.createElement("section")
    ];
    sectionPanel.className = "client-panel library-section-panel";
    uploadPanel.className = "client-panel library-upload-panel";
    listPanel.className = "client-panel library-list-panel";
    container.append(sectionPanel, uploadPanel, listPanel);

    sectionPanel.innerHTML = "<p class=\"muted\">Chargement des sections…</p>";
    uploadPanel.hidden = true;
    listPanel.hidden = true;

    const result = await apiRequest("/api/library");
    if (!result.ok) {
        sectionPanel.innerHTML = `<p class="auth-message error">${escapeHtml(result.data?.message || "Impossible de charger la bibliothèque.")}</p>`;
        return;
    }

    const sections = result.data.sections || [];
    if (!selectedSectionId || !sections.some(section => String(section.id) === String(selectedSectionId))) {
        selectedSectionId = sections[0]?.id || null;
    }

    renderSectionPanel(sectionPanel, sections, () => renderLibrary());
    renderUploadPanel(uploadPanel, sections, () => renderLibrary());
    await renderDocumentPanel(listPanel, sections);
}

export async function openLibrarySection(sectionId) {
    selectedSectionId = sectionId;
    await renderLibrary();
}

export async function searchPersonalLibrary(query) {
    const result = await apiRequest(`/api/library/search?q=${encodeURIComponent(query)}`);
    return result.ok ? result.data : { sections: [], documents: [] };
}

function renderSectionPanel(panel, sections, refresh) {
    panel.innerHTML = `
        <div class="form-heading">
            <div>
                <p class="eyebrow">Vos sections privées</p>
                <h2>Votre bibliothèque technique</h2>
                <p class="muted">Créez une section métier : Serrurerie, Interphonie, Alarmes, Domotique…</p>
            </div>
        </div>
        <div class="library-section-layout">
            <form id="librarySectionForm" class="library-section-form">
                <label>Nouvelle section<input name="name" maxlength="80" minlength="2" placeholder="Ex. Serrurerie" required></label>
                <button type="submit" class="secondary-button">Créer la section</button>
            </form>
            <div class="library-section-list" id="librarySectionList"></div>
        </div>
        <p id="librarySectionMessage" class="auth-message" aria-live="polite"></p>
    `;

    const list = panel.querySelector("#librarySectionList");
    if (!sections.length) {
        list.innerHTML = "<p class=\"muted\">Aucune section pour le moment. Créez la première.</p>";
    } else {
        sections.forEach(section => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = `library-section-button${String(section.id) === String(selectedSectionId) ? " selected" : ""}`;
            button.innerHTML = `<strong>${escapeHtml(section.name)}</strong><span>${Number(section.documentCount) || 0} document(s)</span>`;
            button.addEventListener("click", () => {
                selectedSectionId = section.id;
                renderLibrary();
            });
            list.appendChild(button);
        });
    }

    panel.querySelector("#librarySectionForm").addEventListener("submit", async event => {
        event.preventDefault();
        const form = event.currentTarget;
        const message = panel.querySelector("#librarySectionMessage");
        const submit = form.querySelector("button");
        submit.disabled = true;
        message.textContent = "Création de la section…";
        message.classList.remove("error");

        const result = await apiRequest("/api/library/sections", {
            method: "POST",
            body: JSON.stringify({ name: new FormData(form).get("name") })
        });
        if (!result.ok) {
            message.textContent = result.data?.message || "Impossible de créer la section.";
            message.classList.add("error");
            submit.disabled = false;
            return;
        }
        selectedSectionId = result.data.section.id;
        refresh();
    });
}

function renderUploadPanel(panel, sections, refresh) {
    if (!sections.length) return;
    panel.hidden = false;
    panel.innerHTML = `
        <form id="libraryUploadForm" class="client-form" enctype="multipart/form-data">
            <div class="form-heading">
                <div>
                    <p class="eyebrow">Nouveau document</p>
                    <h2>Ajouter une notice ou un fichier</h2>
                </div>
            </div>
            <div class="form-grid">
                <label>
                    Section
                    <select name="sectionId" required>
                        ${sections.map(section => `<option value="${escapeHtml(section.id)}" ${String(section.id) === String(selectedSectionId) ? "selected" : ""}>${escapeHtml(section.name)}</option>`).join("")}
                    </select>
                </label>
                <label>
                    Titre *
                    <input name="title" maxlength="160" required placeholder="Ex. Notice serrure connectée">
                </label>
                <label class="form-wide">
                    Description / mots-clés
                    <textarea name="description" rows="2" maxlength="1000" placeholder="Marque, référence, procédure, informations utiles…"></textarea>
                </label>
                <label class="form-wide">
                    Fichiers *
                    <input name="files" type="file" multiple required accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.jpg,.jpeg,.png,.webp">
                </label>
            </div>
            <p class="muted small-note">PDF, documents Office, texte et images. Maximum 5 fichiers et ${MAX_FILE_SIZE_LABEL} par fichier.</p>
            <p id="libraryUploadMessage" class="auth-message" aria-live="polite"></p>
            <div class="form-actions"><button type="submit" class="secondary-button">Ajouter à la bibliothèque</button></div>
        </form>
    `;

    panel.querySelector("#libraryUploadForm").addEventListener("submit", async event => {
        event.preventDefault();
        const form = event.currentTarget;
        const message = panel.querySelector("#libraryUploadMessage");
        const submit = form.querySelector("button[type=submit]");
        submit.disabled = true;
        message.textContent = "Envoi des fichiers…";
        message.classList.remove("error");

        const result = await apiRequest("/api/library/documents", { method: "POST", body: new FormData(form) });
        if (!result.ok) {
            message.textContent = result.data?.message || "Impossible d’ajouter les fichiers.";
            message.classList.add("error");
            submit.disabled = false;
            return;
        }
        selectedSectionId = new FormData(form).get("sectionId");
        refresh();
    });
}

async function renderDocumentPanel(panel, sections) {
    if (!sections.length || !selectedSectionId) return;
    panel.hidden = false;
    panel.innerHTML = "<p class=\"muted\">Chargement des documents…</p>";

    const result = await apiRequest(`/api/library/sections/${encodeURIComponent(selectedSectionId)}/documents`);
    if (!result.ok) {
        panel.innerHTML = `<p class="auth-message error">${escapeHtml(result.data?.message || "Impossible de charger les documents.")}</p>`;
        return;
    }

    const currentSection = sections.find(section => String(section.id) === String(selectedSectionId));
    const documents = result.data.documents || [];
    panel.innerHTML = `
        <div class="form-heading">
            <div>
                <p class="eyebrow">${escapeHtml(currentSection?.name || "Section")}</p>
                <h2>${documents.length} document(s)</h2>
            </div>
        </div>
        <div class="library-document-list" id="libraryDocumentList"></div>
    `;

    const list = panel.querySelector("#libraryDocumentList");
    if (!documents.length) {
        list.innerHTML = "<p class=\"muted\">Aucun document dans cette section pour le moment.</p>";
        return;
    }

    documents.forEach(document => {
        const article = document.createElement("article");
        article.className = "library-document-card";
        article.innerHTML = `
            <div>
                <h3>${escapeHtml(document.title)}</h3>
                <p class="muted">${escapeHtml(document.description || document.originalFilename)}</p>
                <small>${escapeHtml(document.originalFilename)} · ${formatFileSize(document.fileSize)} · ajouté par ${escapeHtml(document.createdBy)}</small>
            </div>
            <div class="library-document-actions">
                <a class="secondary-button" target="_blank" rel="noopener noreferrer" href="/api/library/documents/${encodeURIComponent(document.id)}/download">Ouvrir</a>
                ${document.canDelete ? `<button type="button" class="danger-button" data-document-id="${escapeHtml(document.id)}">Supprimer</button>` : ""}
            </div>
        `;
        list.appendChild(article);
    });

    list.querySelectorAll("[data-document-id]").forEach(button => {
        button.addEventListener("click", async () => {
            if (!confirm("Supprimer ce document ?")) return;
            button.disabled = true;
            const result = await apiRequest(`/api/library/documents/${encodeURIComponent(button.dataset.documentId)}`, { method: "DELETE" });
            if (!result.ok) {
                alert(result.data?.message || "Impossible de supprimer le document.");
                button.disabled = false;
                return;
            }
            renderLibrary();
        });
    });
}

async function apiRequest(url, options = {}) {
    try {
        const isFormData = options.body instanceof FormData;
        const response = await fetch(url, {
            credentials: "same-origin",
            ...options,
            headers: isFormData ? options.headers : { "Content-Type": "application/json", ...(options.headers || {}) }
        });
        const data = response.status === 204 ? null : await response.json().catch(() => null);
        return { ok: response.ok, data };
    } catch {
        return { ok: false, data: null };
    }
}

function formatFileSize(value) {
    const size = Number(value) || 0;
    if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} Ko`;
    return `${(size / (1024 * 1024)).toFixed(1).replace(".", ",")} Mo`;
}
