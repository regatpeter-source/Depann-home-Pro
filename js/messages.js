import { ROUTES } from "./config.js?v=85";
import { escapeHtml } from "./utils.js?v=44";
import { clearSearch, getContainer, setPage } from "./ui.js?v=44";

const CLIENT_LAST_READ_KEY_PREFIX = "depannHomePro:clientMessages:lastRead:";

export async function renderMessages() {
    clearSearch();
    setPage("Notes d’intervention", ROUTES.clients, "detail");
    getContainer().innerHTML = "<section class=\"client-panel\"><p class=\"muted\">Les notes d’intervention sont disponibles dans la fiche de chaque client.</p></section>";
}

export function renderClientMessages(client, focus = false) {
    const panel = document.createElement("section");
    panel.className = "client-panel client-messages-panel";
    panel.innerHTML = "<p class=\"muted\">Chargement des notes d’intervention…</p>";
    loadClientMessages(panel, client, focus);
    return panel;
}

async function loadClientMessages(panel, client, focus = false) {
    const result = await request(`/api/messages?clientId=${encodeURIComponent(client.id)}`);
    if (!result.ok) {
        panel.innerHTML = `<p class="auth-message error">${escapeHtml(result.message || "Impossible de charger les notes d’intervention.")}</p>`;
        return;
    }
    const messages = result.data.messages || [];
    const unreadMessageId = focus ? getFirstUnreadMessageId(client.id, messages) : "";
    markClientMessagesAsRead(client.id, messages);
    renderClientMessagePanel(panel, client, messages, unreadMessageId);
    refreshClientMessageAlert();
    if (focus && !unreadMessageId) {
        panel.scrollIntoView({ behavior: "smooth", block: "start" });
        panel.querySelector("textarea")?.focus({ preventScroll: true });
    }
}

export async function refreshClientMessageAlert() {
    const result = await request("/api/messages/unread-summary");
    if (!result.ok) return;
    const unreadClientIds = getUnreadClientIds(result.data.messages || []);
    document.querySelectorAll("[data-client-message-alert]").forEach(alert => {
        alert.hidden = unreadClientIds.length === 0;
        alert.textContent = unreadClientIds.length > 99 ? "99+" : String(unreadClientIds.length);
        alert.setAttribute("aria-label", `${unreadClientIds.length} dossier(s) avec une nouvelle note`);
    });
}

export async function getFirstUnreadClientId() {
    const result = await request("/api/messages/unread-summary");
    if (!result.ok) return "";
    const unreadClientIds = getUnreadClientIds(result.data.messages || []);
    return unreadClientIds[0] || "";
}

function renderClientMessagePanel(panel, client, messages, unreadMessageId = "") {
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
        article.className = `message-bubble ${canEdit ? "outgoing" : "incoming"}${String(message.id) === String(unreadMessageId) ? " message-unread-target" : ""}`;
        article.dataset.messageId = message.id;
        article.innerHTML = `<p>${escapeHtml(message.body)}</p><small>${escapeHtml(author)} · ${escapeHtml(formatDate(message.createdAt))}${message.updatedAt && message.updatedAt !== message.createdAt ? " · modifiée" : ""}</small>${canEdit ? '<button type="button" class="secondary-button message-edit-button">Modifier</button>' : ""}`;
        article.querySelector(".message-edit-button")?.addEventListener("click", () => editClientMessage(article, message, client, panel));
        thread.appendChild(article);
    });
    thread.scrollTop = thread.scrollHeight;
    const unreadMessage = unreadMessageId ? thread.querySelector(`[data-message-id="${CSS.escape(String(unreadMessageId))}"]`) : null;
    if (unreadMessage) {
        unreadMessage.tabIndex = -1;
        unreadMessage.scrollIntoView({ behavior: "smooth", block: "center" });
        unreadMessage.focus({ preventScroll: true });
    }
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

function formatDate(value) {
    return new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function getUnreadClientIds(messages) {
    const currentUserId = String(document.body.dataset.userId || "");
    const oldestUnreadByClient = new Map();
    messages.forEach(message => {
        if (!message.clientId || String(message.senderId) === currentUserId) return;
        const timestamp = new Date(message.createdAt).getTime();
        if (!Number.isFinite(timestamp) || timestamp <= getClientLastRead(message.clientId)) return;
        const previous = oldestUnreadByClient.get(message.clientId);
        if (!previous || timestamp < previous) oldestUnreadByClient.set(message.clientId, timestamp);
    });
    return [...oldestUnreadByClient.entries()]
        .sort((first, second) => first[1] - second[1])
        .map(([clientId]) => clientId);
}

function getFirstUnreadMessageId(clientId, messages) {
    const currentUserId = String(document.body.dataset.userId || "");
    const lastRead = getClientLastRead(clientId);
    return messages
        .filter(message => String(message.senderId) !== currentUserId && new Date(message.createdAt).getTime() > lastRead)
        .sort((first, second) => new Date(first.createdAt).getTime() - new Date(second.createdAt).getTime())[0]?.id || "";
}

function markClientMessagesAsRead(clientId, messages) {
    const latest = messages.reduce((timestamp, message) => Math.max(timestamp, new Date(message.createdAt).getTime() || 0), 0);
    if (latest) localStorage.setItem(getClientLastReadKey(clientId), String(latest));
}

function getClientLastRead(clientId) {
    return Number(localStorage.getItem(getClientLastReadKey(clientId))) || 0;
}

function getClientLastReadKey(clientId) {
    return `${CLIENT_LAST_READ_KEY_PREFIX}${document.body.dataset.userId || "anonymous"}:${clientId}`;
}

async function request(url, options = {}) {
    try {
        const response = await fetch(url, { credentials: "same-origin", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
        const data = response.status === 204 ? null : await response.json().catch(() => null);
        return { ok: response.ok, data, message: data?.message };
    } catch { return { ok: false, data: null, message: "Serveur indisponible." }; }
}
