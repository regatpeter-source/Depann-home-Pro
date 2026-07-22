import { ROUTES } from "./config.js?v=78";
import { resetSelection } from "./state.js?v=44";
import { escapeHtml } from "./utils.js?v=44";
import { clearSearch, getContainer, setPage } from "./ui.js?v=44";

const LAST_READ_KEY_PREFIX = "depannHomePro:messages:lastRead:";

export async function renderMessages() {
    if (document.body.dataset.role === "technician") {
        clearSearch();
        setPage("Notes d’intervention", ROUTES.clients, "detail");
        getContainer().innerHTML = "<section class=\"client-panel\"><p class=\"muted\">Les notes d’intervention sont disponibles dans la fiche de chaque client.</p></section>";
        return;
    }
    clearSearch();
    resetSelection("all");
    setPage("Messagerie", ROUTES.messages, "detail");

    const container = getContainer();
    const panel = document.createElement("section");
    panel.className = "client-panel messages-panel";
    container.appendChild(panel);
    panel.innerHTML = "<p class=\"muted\">Chargement des messages…</p>";

    const result = await request("/api/messages");
    if (!result.ok) {
        panel.innerHTML = `<p class="auth-message error">${escapeHtml(result.message || "Impossible de charger la messagerie.")}</p>`;
        return;
    }
    const messages = result.data.messages || [];
    markMessagesAsRead(messages);
    renderMessagePanel(panel, messages);
    refreshMessageAlert();
}

export async function refreshMessageAlert() {
    const result = await request("/api/messages");
    if (!result.ok) return;
    const unreadCount = getUnreadMessages(result.data.messages || []).length;
    document.querySelectorAll("[data-message-alert]").forEach(alert => {
        alert.hidden = unreadCount === 0;
        alert.textContent = unreadCount > 99 ? "99+" : String(unreadCount);
    });
}

export function renderClientMessages(client) {
    const panel = document.createElement("section");
    panel.className = "client-panel client-messages-panel";
    panel.innerHTML = "<p class=\"muted\">Chargement des notes d’intervention…</p>";
    loadClientMessages(panel, client);
    return panel;
}

async function loadClientMessages(panel, client) {
    const result = await request(`/api/messages?clientId=${encodeURIComponent(client.id)}`);
    if (!result.ok) {
        panel.innerHTML = `<p class="auth-message error">${escapeHtml(result.message || "Impossible de charger les notes d’intervention.")}</p>`;
        return;
    }
    renderClientMessagePanel(panel, client, result.data.messages || []);
}

function renderClientMessagePanel(panel, client, messages) {
    panel.innerHTML = `
        <div class="form-heading"><div><p class="eyebrow">Notes d’intervention</p><h2>Messagerie du dossier</h2><p class="muted">Ajoutez les informations utiles à l’intervention. Vous pouvez modifier vos propres notes.</p></div></div>
        <div class="message-thread client-message-thread"></div>
        <form class="message-form client-message-form"><textarea name="body" rows="3" maxlength="2000" required placeholder="Ex. Moteur à contrôler, accès par le portail arrière…"></textarea><button type="submit" class="secondary-button">Ajouter la note</button><p class="auth-message" aria-live="polite"></p></form>
    `;
    const thread = panel.querySelector(".client-message-thread");
    if (!messages.length) thread.innerHTML = "<p class=\"muted\">Aucune note d’intervention pour ce client.</p>";
    messages.slice().reverse().forEach(message => {
        const article = document.createElement("article");
        const author = message.senderName || message.senderUsername || "Membre de l’équipe";
        const canEdit = String(message.senderId) === String(document.body.dataset.userId || "");
        article.className = `message-bubble ${canEdit ? "outgoing" : "incoming"}`;
        article.innerHTML = `<p>${escapeHtml(message.body)}</p><small>${escapeHtml(author)} · ${escapeHtml(formatDate(message.createdAt))}${message.updatedAt && message.updatedAt !== message.createdAt ? " · modifiée" : ""}</small>${canEdit ? '<button type="button" class="secondary-button message-edit-button">Modifier</button>' : ""}`;
        article.querySelector(".message-edit-button")?.addEventListener("click", () => editClientMessage(article, message, client, panel));
        thread.appendChild(article);
    });
    thread.scrollTop = thread.scrollHeight;
    panel.querySelector("form").addEventListener("submit", async event => {
        event.preventDefault();
        const form = event.currentTarget;
        const feedback = form.querySelector(".auth-message");
        const button = form.querySelector("button");
        button.disabled = true;
        const result = await request("/api/messages", { method: "POST", body: JSON.stringify({ clientId: client.id, body: new FormData(form).get("body") }) });
        if (!result.ok) {
            feedback.textContent = result.message || "Ajout impossible.";
            feedback.classList.add("error");
            button.disabled = false;
            return;
        }
        loadClientMessages(panel, client);
    });
}

function editClientMessage(article, message, client, panel) {
    const editor = document.createElement("div");
    editor.className = "message-edit-form";
    editor.innerHTML = `<textarea rows="3" maxlength="2000">${escapeHtml(message.body)}</textarea><div><button type="button" class="secondary-button" data-action="save">Enregistrer</button><button type="button" class="secondary-button" data-action="cancel">Annuler</button></div><p class="auth-message" aria-live="polite"></p>`;
    article.replaceChildren(editor);
    editor.querySelector('[data-action="cancel"]').addEventListener("click", () => loadClientMessages(panel, client));
    editor.querySelector('[data-action="save"]').addEventListener("click", async event => {
        const button = event.currentTarget;
        button.disabled = true;
        const result = await request(`/api/messages/${encodeURIComponent(message.id)}`, { method: "PATCH", body: JSON.stringify({ body: editor.querySelector("textarea").value }) });
        if (!result.ok) {
            editor.querySelector(".auth-message").textContent = result.message || "Modification impossible.";
            editor.querySelector(".auth-message").classList.add("error");
            button.disabled = false;
            return;
        }
        loadClientMessages(panel, client);
    });
}

function renderMessagePanel(panel, messages) {
    panel.innerHTML = `
        <div class="form-heading"><div><p class="eyebrow">Notes internes synchronisées</p><h2>Notes de l’équipe</h2><p class="muted">Créez des rappels comme « clients à facturer ». Ils restent accessibles uniquement aux membres de votre entreprise.</p></div></div>
        <section class="message-conversation message-self-conversation">
            <div class="message-conversation-header"><h3>Notes du compte</h3></div>
            <div class="message-thread" id="messageThread"></div>
            <form id="messageForm" class="message-form"><textarea name="body" rows="3" maxlength="2000" required placeholder="Ex. Clients à facturer : Martin, Résidence Les Pins…"></textarea><button type="submit" class="secondary-button">Ajouter la note</button><p class="auth-message" aria-live="polite"></p></form>
        </section>
    `;
    const thread = panel.querySelector("#messageThread");
    if (!messages.length) thread.innerHTML = "<p class=\"muted\">Aucune note pour le moment. Ajoutez votre premier rappel.</p>";
    messages.slice().reverse().forEach(message => {
        const article = document.createElement("article");
        article.className = "message-bubble outgoing";
        const author = message.senderName || message.senderUsername || "Membre de l’équipe";
        article.innerHTML = `<p>${escapeHtml(message.body)}</p><small>${escapeHtml(author)} · ${escapeHtml(formatDate(message.createdAt))}</small>`;
        thread.appendChild(article);
    });
    thread.scrollTop = thread.scrollHeight;
    panel.querySelector("#messageForm").addEventListener("submit", async event => {
        event.preventDefault();
        const form = event.currentTarget;
        const message = form.querySelector(".auth-message");
        const button = form.querySelector("button");
        button.disabled = true;
        const result = await request("/api/messages", { method: "POST", body: JSON.stringify({ body: new FormData(form).get("body") }) });
        if (!result.ok) { message.textContent = result.message || "Envoi impossible."; message.classList.add("error"); button.disabled = false; return; }
        renderMessages();
    });
}

function formatDate(value) {
    return new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function getUnreadMessages(messages) {
    const lastRead = new Date(localStorage.getItem(getLastReadKey()) || 0).getTime();
    return messages.filter(message => new Date(message.createdAt).getTime() > lastRead);
}

function markMessagesAsRead(messages) {
    const newest = messages.reduce((latest, message) => {
        const timestamp = new Date(message.createdAt).getTime();
        return timestamp > latest ? timestamp : latest;
    }, 0);
    if (newest) localStorage.setItem(getLastReadKey(), new Date(newest).toISOString());
}

function getLastReadKey() {
    return `${LAST_READ_KEY_PREFIX}${document.body.dataset.userId || "anonymous"}`;
}

async function request(url, options = {}) {
    try {
        const response = await fetch(url, { credentials: "same-origin", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
        const data = response.status === 204 ? null : await response.json().catch(() => null);
        return { ok: response.ok, data, message: data?.message };
    } catch { return { ok: false, data: null, message: "Serveur indisponible." }; }
}
