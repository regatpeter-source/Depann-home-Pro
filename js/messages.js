import { ROUTES } from "./config.js?v=68";
import { resetSelection } from "./state.js?v=44";
import { escapeHtml } from "./utils.js?v=44";
import { clearSearch, getContainer, setPage } from "./ui.js?v=44";

const LAST_READ_KEY_PREFIX = "depannHomePro:messages:lastRead:";

export async function renderMessages() {
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

function renderMessagePanel(panel, messages) {
    panel.innerHTML = `
        <div class="form-heading"><div><p class="eyebrow">Notes internes synchronisées</p><h2>Mes notes entre téléphone et PC</h2><p class="muted">Créez des rappels comme « clients à facturer ». Ils sont accessibles uniquement depuis vos appareils connectés à ce même compte.</p></div></div>
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
        article.innerHTML = `<p>${escapeHtml(message.body)}</p><small>${escapeHtml(formatDate(message.createdAt))}</small>`;
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
