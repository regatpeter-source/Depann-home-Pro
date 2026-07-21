import { ROUTES } from "./config.js?v=66";
import { resetSelection } from "./state.js?v=44";
import { escapeHtml } from "./utils.js?v=44";
import { clearSearch, getContainer, setPage } from "./ui.js?v=44";

let selectedUserId = null;

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
    const { users = [], messages = [], currentUserId } = result.data;
    if (!selectedUserId || !users.some(user => String(user.id) === String(selectedUserId))) selectedUserId = users[0]?.id || null;
    renderMessagePanel(panel, users, messages, currentUserId);
}

function renderMessagePanel(panel, users, messages, currentUserId) {
    const selectedUser = users.find(user => String(user.id) === String(selectedUserId));
    const conversation = selectedUser
        ? messages.filter(message => String(message.senderId) === String(selectedUser.id) || String(message.recipientId) === String(selectedUser.id)).reverse()
        : [];
    panel.innerHTML = `
        <div class="form-heading"><div><p class="eyebrow">Messagerie interne privée</p><h2>Échanger avec les comptes de l’application</h2><p class="muted">Les messages sont réservés aux utilisateurs connectés de Depann’Home Pro.</p></div></div>
        <div class="messages-layout">
            <aside class="message-user-list" id="messageUserList"></aside>
            <section class="message-conversation">
                <div class="message-conversation-header"><h3>${escapeHtml(selectedUser?.username || "Choisissez un destinataire")}</h3></div>
                <div class="message-thread" id="messageThread"></div>
                ${selectedUser ? `<form id="messageForm" class="message-form"><textarea name="body" rows="3" maxlength="2000" required placeholder="Écrire un message à ${escapeHtml(selectedUser.username)}…"></textarea><button type="submit" class="secondary-button">Envoyer</button><p class="auth-message" aria-live="polite"></p></form>` : '<p class="muted">Aucun autre compte disponible pour le moment.</p>'}
            </section>
        </div>
    `;
    const usersNode = panel.querySelector("#messageUserList");
    if (!users.length) usersNode.innerHTML = "<p class=\"muted\">Aucun autre compte.</p>";
    users.forEach(user => {
        const unread = messages.filter(message => String(message.senderId) === String(user.id) && !message.readAt).length;
        const button = document.createElement("button");
        button.type = "button";
        button.className = `message-user${String(user.id) === String(selectedUserId) ? " selected" : ""}`;
        button.innerHTML = `<span>${escapeHtml(user.username)}</span>${unread ? `<b>${unread}</b>` : ""}`;
        button.addEventListener("click", () => { selectedUserId = user.id; renderMessages(); });
        usersNode.appendChild(button);
    });
    const thread = panel.querySelector("#messageThread");
    if (thread) {
        if (!conversation.length) thread.innerHTML = "<p class=\"muted\">Commencez la conversation.</p>";
        conversation.forEach(message => {
            const outgoing = String(message.senderId) === String(currentUserId);
            const article = document.createElement("article");
            article.className = `message-bubble${outgoing ? " outgoing" : " incoming"}`;
            article.innerHTML = `<p>${escapeHtml(message.body)}</p><small>${escapeHtml(formatDate(message.createdAt))}${outgoing ? " · Vous" : ` · ${escapeHtml(message.senderName)}`}</small>`;
            thread.appendChild(article);
            if (!outgoing && !message.readAt) request(`/api/messages/${encodeURIComponent(message.id)}/read`, { method: "PUT" });
        });
        thread.scrollTop = thread.scrollHeight;
    }
    panel.querySelector("#messageForm")?.addEventListener("submit", async event => {
        event.preventDefault();
        const form = event.currentTarget;
        const message = form.querySelector(".auth-message");
        const button = form.querySelector("button");
        button.disabled = true;
        const result = await request("/api/messages", { method: "POST", body: JSON.stringify({ recipientId: selectedUserId, body: new FormData(form).get("body") }) });
        if (!result.ok) { message.textContent = result.message || "Envoi impossible."; message.classList.add("error"); button.disabled = false; return; }
        renderMessages();
    });
}

function formatDate(value) {
    return new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

async function request(url, options = {}) {
    try {
        const response = await fetch(url, { credentials: "same-origin", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
        const data = response.status === 204 ? null : await response.json().catch(() => null);
        return { ok: response.ok, data, message: data?.message };
    } catch { return { ok: false, data: null, message: "Serveur indisponible." }; }
}
