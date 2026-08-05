let stream = null;
let notifications = [];
let notificationButton = null;

export function initializeCollaboration() {
    if (stream || !window.EventSource) return;
    notificationButton = document.getElementById("notificationsBtn");
    notificationButton?.addEventListener("click", openNotificationCenter);
    loadNotifications();
    stream = new EventSource("/api/collaboration/stream");
    stream.addEventListener("notification", event => handleEvent("notification", event));
    ["lock_acquired", "lock_released", "lock_force_released", "report_started", "report_saved", "report_media_added", "report_media_updated", "report_media_deleted", "report_submitted", "report_correction_requested", "report_validated", "report_reopened", "mission_journal_updated"].forEach(type => stream.addEventListener(type, event => handleEvent(type, event)));
    stream.onerror = () => updateSyncIndicator("syncing", "Reconnexion en cours");
    stream.onopen = () => updateSyncIndicator("synced", "Synchronisé en temps réel");
    window.addEventListener("beforeunload", releaseSessionLocks, { capture: true });
    window.addEventListener("online", () => updateSyncIndicator("syncing", "Reconnexion en cours"));
    window.addEventListener("offline", () => updateSyncIndicator("offline", "Hors connexion"));
}

export async function acquireReportLock(reportId) { return request(`/api/collaboration/locks/technical_report/${encodeURIComponent(reportId)}/acquire`, { method: "POST" }); }
export async function heartbeatReportLock(reportId) { return request(`/api/collaboration/locks/technical_report/${encodeURIComponent(reportId)}/heartbeat`, { method: "POST" }); }
export async function releaseReportLock(reportId) { return request(`/api/collaboration/locks/technical_report/${encodeURIComponent(reportId)}`, { method: "DELETE" }); }
export async function forceReleaseReportLock(reportId, reason) { return request(`/api/collaboration/locks/technical_report/${encodeURIComponent(reportId)}/force-release`, { method: "POST", body: JSON.stringify({ reason }) }); }
export function getNotifications() { return notifications; }

async function loadNotifications() { const result = await request("/api/collaboration/notifications"); if (!result.ok) return; notifications = result.data.notifications || []; renderNotificationBadge(); }
function handleEvent(type, event) { let data = {}; try { data = JSON.parse(event.data); } catch { return; } if (type === "notification" && String(data.recipientId || "") === String(document.body.dataset.userId || "")) { notifications.unshift(data.notification); renderNotificationBadge(); }
    window.dispatchEvent(new CustomEvent("depannhome:collaboration-event", { detail: { type, ...data } }));
}
function renderNotificationBadge() { const unread = notifications.filter(item => !item.readAt).length; if (!notificationButton) return; notificationButton.classList.toggle("has-notifications", unread > 0); notificationButton.setAttribute("aria-label", unread ? `${unread} notification${unread > 1 ? "s" : ""} non lue${unread > 1 ? "s" : ""}` : "Notifications"); notificationButton.textContent = unread ? `Notifications (${unread > 99 ? "99+" : unread})` : "Notifications"; }
function openNotificationCenter() { const existing = document.getElementById("notificationCenter"); if (existing) { existing.remove(); return; } const center = document.createElement("section"); center.id = "notificationCenter"; center.className = "notification-center"; center.innerHTML = `<header><div><p class="eyebrow">Collaboration</p><h3>Notifications</h3></div><button type="button" class="secondary-button" data-close-notifications>Fermer</button></header><div class="notification-list">${notifications.length ? notifications.map(item => `<article class="${item.readAt ? "read" : "unread"}"><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.body)}</p><small>${formatDateTime(item.createdAt)}</small>${canOpenNotification(item) ? `<button type="button" class="secondary-button" data-open-notification="${escapeHtml(item.id)}">Ouvrir</button>` : ""}</article>`).join("") : '<p class="muted">Aucune notification.</p>'}</div><button type="button" class="secondary-button" data-read-notifications>Tout marquer comme lu</button>`; document.body.append(center); center.querySelector("[data-close-notifications]").addEventListener("click", () => center.remove()); center.querySelectorAll("[data-open-notification]").forEach(button => button.addEventListener("click", async () => { const notification = notifications.find(item => String(item.id) === button.dataset.openNotification); if (!notification) return; await markNotificationRead(notification.id); center.remove(); window.dispatchEvent(new CustomEvent("depannhome:open-notification", { detail: { notification } })); })); center.querySelector("[data-read-notifications]").addEventListener("click", async () => { await request("/api/collaboration/notifications/read", { method: "POST", body: "{}" }); notifications = notifications.map(item => ({ ...item, readAt: new Date().toISOString() })); renderNotificationBadge(); center.remove(); }); }
function canOpenNotification(notification) { return ["technical_report", "billing_document", "client", "calendar_event", "partner_mission", "partner_connection", "partner_request"].includes(notification?.entityType); }
async function markNotificationRead(id) { if (!id) return; const result = await request("/api/collaboration/notifications/read", { method: "POST", body: JSON.stringify({ ids: [id] }) }); if (!result.ok) return; notifications = notifications.map(item => String(item.id) === String(id) ? { ...item, readAt: new Date().toISOString() } : item); renderNotificationBadge(); }
function releaseSessionLocks() { if (!navigator.sendBeacon) return; navigator.sendBeacon("/api/collaboration/release-session-locks", new Blob(["{}"], { type: "application/json" })); }
function updateSyncIndicator(state, label) { document.querySelectorAll("[data-collaboration-sync]").forEach(element => { element.dataset.collaborationSync = state; element.title = label; element.setAttribute("aria-label", label); }); }
async function request(url, options = {}) { try { const response = await fetch(url, { credentials: "same-origin", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options }); const data = response.status === 204 ? null : await response.json().catch(() => null); return { ok: response.ok, data, message: data?.message }; } catch { return { ok: false, message: "Serveur indisponible." }; } }
function escapeHtml(value) { return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;"); }
function formatDateTime(value) { return value ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : ""; }
