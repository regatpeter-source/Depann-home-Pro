import { clientSessionUrl } from "./client-session.js?v=2";
import { getSettings } from "./storage.js?v=45";

let stream = null;
let notifications = [];
let partnerNotifications = [];
let notificationButton = null;

export function initializeCollaboration() {
    if (stream || !window.EventSource) return;
    notificationButton = document.getElementById("notificationsBtn");
    notificationButton?.addEventListener("click", openNotificationCenter);
    loadNotifications();
    loadPartnerNotifications();
    stream = new EventSource(clientSessionUrl("/api/collaboration/stream"));
    stream.addEventListener("notification", event => handleEvent("notification", event));
    ["lock_acquired", "lock_released", "lock_force_released", "report_started", "report_saved", "report_media_added", "report_media_updated", "report_media_deleted", "report_submitted", "report_correction_requested", "report_validated", "report_reopened", "mission_journal_updated"].forEach(type => stream.addEventListener(type, event => handleEvent(type, event)));
    stream.onerror = () => updateSyncIndicator("syncing", "Reconnexion en cours");
    stream.onopen = () => updateSyncIndicator("synced", "Synchronisé en temps réel");
    window.addEventListener("beforeunload", releaseSessionLocks, { capture: true });
    window.addEventListener("online", () => updateSyncIndicator("syncing", "Reconnexion en cours"));
    window.addEventListener("offline", () => updateSyncIndicator("offline", "Hors connexion"));
    window.addEventListener("depannhome:settings-changed", () => { document.getElementById("notificationCenter")?.remove(); renderNotificationBadge(); renderPartnerNotificationBadge(); });
}

export async function acquireReportLock(reportId) { return request(`/api/collaboration/locks/technical_report/${encodeURIComponent(reportId)}/acquire`, { method: "POST" }); }
export async function heartbeatReportLock(reportId) { return request(`/api/collaboration/locks/technical_report/${encodeURIComponent(reportId)}/heartbeat`, { method: "POST" }); }
export async function releaseReportLock(reportId) { return request(`/api/collaboration/locks/technical_report/${encodeURIComponent(reportId)}`, { method: "DELETE" }); }
export async function forceReleaseReportLock(reportId, reason) { return request(`/api/collaboration/locks/technical_report/${encodeURIComponent(reportId)}/force-release`, { method: "POST", body: JSON.stringify({ reason }) }); }
export function getNotifications() { return visibleNotifications(notifications); }
export function getPartnerNotifications() { return visibleNotifications(partnerNotifications); }

async function loadNotifications() { const result = await request("/api/collaboration/notifications"); if (!result.ok) return; notifications = result.data.notifications || []; renderNotificationBadge(); }
export async function loadPartnerNotifications() { const result = await request("/api/collaboration/partner-notifications"); if (!result.ok) return []; partnerNotifications = deduplicatePartnerNotifications(result.data.notifications || []); renderPartnerNotificationBadge(); return visibleNotifications(partnerNotifications); }
export async function markPartnerNotificationsRead() { const unreadIds = visibleNotifications(partnerNotifications).filter(item => !item.readAt).map(item => item.id); if (!unreadIds.length) return; const result = await request("/api/collaboration/notifications/read", { method: "POST", body: JSON.stringify({ ids: unreadIds, scope: "partner" }) }); if (!result.ok) return; const readAt = new Date().toISOString(); partnerNotifications = partnerNotifications.map(item => unreadIds.some(id => String(id) === String(item.id)) ? { ...item, readAt } : item); renderPartnerNotificationBadge(); }
function handleEvent(type, event) { let data = {}; try { data = JSON.parse(event.data); } catch { return; } if (type === "notification" && String(data.recipientId || "") === String(document.body.dataset.userId || "")) { if (isPartnerNotification(data.notification)) { partnerNotifications = deduplicatePartnerNotifications([data.notification, ...partnerNotifications]); renderPartnerNotificationBadge(); } else { notifications.unshift(data.notification); renderNotificationBadge(); } }
    window.dispatchEvent(new CustomEvent("depannhome:collaboration-event", { detail: { type, ...data } }));
}
function renderNotificationBadge() { const unread = visibleNotifications(notifications).filter(item => !item.readAt).length; if (!notificationButton) return; notificationButton.classList.toggle("has-notifications", unread > 0); notificationButton.setAttribute("aria-label", unread ? `${unread} notification${unread > 1 ? "s" : ""} non lue${unread > 1 ? "s" : ""}` : "Notifications"); notificationButton.textContent = unread ? `Notifications (${unread > 99 ? "99+" : unread})` : "Notifications"; }
function renderPartnerNotificationBadge() { const unread = visibleNotifications(partnerNotifications).filter(item => !item.readAt).length; document.querySelectorAll("[data-partner-notification-alert]").forEach(alert => { alert.hidden = unread === 0; alert.textContent = unread > 99 ? "99+" : String(unread); alert.setAttribute("aria-label", `${unread} notification${unread > 1 ? "s" : ""} partenaire${unread > 1 ? "s" : ""} non lue${unread > 1 ? "s" : ""}`); }); window.dispatchEvent(new CustomEvent("depannhome:partner-notifications-changed", { detail: { unread } })); }
function openNotificationCenter() { const existing = document.getElementById("notificationCenter"); if (existing) { existing.remove(); return; } const displayedNotifications = visibleNotifications(notifications); const center = document.createElement("section"); center.id = "notificationCenter"; center.className = "notification-center"; const readNotifications = displayedNotifications.filter(item => item.readAt); center.innerHTML = `<header><div><p class="eyebrow">Collaboration</p><h3>Notifications</h3></div><button type="button" class="secondary-button" data-close-notifications>Fermer</button></header><div class="notification-list">${displayedNotifications.length ? displayedNotifications.map(item => `<article class="${item.readAt ? "read" : "unread"}"><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.body)}</p><small>${formatDateTime(item.createdAt)}</small>${canOpenNotification(item) ? `<button type="button" class="secondary-button" data-open-notification="${escapeHtml(item.id)}">Ouvrir</button>` : ""}</article>`).join("") : '<p class="muted">Aucune notification selon les choix de ce poste.</p>'}</div><div class="form-actions"><button type="button" class="secondary-button" data-read-notifications>Tout marquer comme lu</button>${readNotifications.length ? '<button type="button" class="secondary-button" data-delete-read-notifications>Supprimer les notifications lues</button>' : ""}</div>`; document.body.append(center); center.querySelector("[data-close-notifications]").addEventListener("click", () => center.remove()); center.querySelectorAll("[data-open-notification]").forEach(button => button.addEventListener("click", async () => { const notification = notifications.find(item => String(item.id) === button.dataset.openNotification); if (!notification) return; await markNotificationRead(notification.id); center.remove(); window.dispatchEvent(new CustomEvent("depannhome:open-notification", { detail: { notification } })); })); center.querySelector("[data-read-notifications]").addEventListener("click", async () => { const unreadIds = displayedNotifications.filter(item => !item.readAt).map(item => item.id); if (unreadIds.length) await request("/api/collaboration/notifications/read", { method: "POST", body: JSON.stringify({ ids: unreadIds }) }); const readAt = new Date().toISOString(); notifications = notifications.map(item => unreadIds.some(id => String(id) === String(item.id)) ? { ...item, readAt } : item); renderNotificationBadge(); center.remove(); }); center.querySelector("[data-delete-read-notifications]")?.addEventListener("click", async () => { const result = await request("/api/collaboration/notifications/read", { method: "DELETE" }); if (!result.ok) return; notifications = notifications.filter(item => !item.readAt); renderNotificationBadge(); center.remove(); openNotificationCenter(); }); }

export function notificationPreferenceKey(notification) {
    const eventType = String(notification?.eventType || "");
    const entityType = String(notification?.entityType || "");
    if (eventType === "partner_mission_received" || eventType === "partner_connection_intervention") return "partnerNewMission";
    if (entityType === "partner_mission" || eventType === "partner_dialogue_updated" || eventType.startsWith("partner_mission_")) return "partnerMissionUpdates";
    if (entityType === "calendar_event" || eventType.startsWith("calendar_") || eventType.startsWith("appointment_")) return "appointments";
    if (entityType === "technical_report" || eventType.startsWith("report_")) return "reports";
    if (entityType === "billing_document" || eventType.startsWith("billing_")) return "billing";
    if (entityType === "client" || eventType === "client_message_received") return "clientMessages";
    if (["partner_connection", "partner_request"].includes(entityType) || eventType.startsWith("partner_connection_") || eventType.startsWith("partner_request_")) return "partnerNetwork";
    return "system";
}

function visibleNotifications(items) {
    const preferences = getSettings().notifications || {};
    return items.filter(item => preferences[notificationPreferenceKey(item)] !== false);
}
function canOpenNotification(notification) { return ["technical_report", "billing_document", "client", "calendar_event", "partner_mission", "partner_connection", "partner_request"].includes(notification?.entityType); }
async function markNotificationRead(id) { if (!id) return; const result = await request("/api/collaboration/notifications/read", { method: "POST", body: JSON.stringify({ ids: [id] }) }); if (!result.ok) return; notifications = notifications.map(item => String(item.id) === String(id) ? { ...item, readAt: new Date().toISOString() } : item); renderNotificationBadge(); }
function isPartnerNotification(notification) { const type = String(notification?.eventType || ""); return ["partner_mission", "partner_connection", "partner_request"].includes(notification?.entityType) || type.startsWith("partner_mission_") || type.startsWith("partner_connection_") || type.startsWith("partner_request_") || type === "partner_dialogue_updated"; }
function deduplicatePartnerNotifications(items) {
    const seen = new Set();
    return (Array.isArray(items) ? items : []).filter(item => {
        const key = [item?.eventType, item?.entityType, item?.entityId, item?.title, item?.body].map(value => String(value || "")).join("\u0000");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
function releaseSessionLocks() { if (!navigator.sendBeacon) return; navigator.sendBeacon(clientSessionUrl("/api/collaboration/release-session-locks"), new Blob(["{}"], { type: "application/json" })); }
function updateSyncIndicator(state, label) { document.querySelectorAll("[data-collaboration-sync]").forEach(element => { element.dataset.collaborationSync = state; element.title = label; element.setAttribute("aria-label", label); }); }
async function request(url, options = {}) { try { const response = await fetch(url, { credentials: "same-origin", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options }); const data = response.status === 204 ? null : await response.json().catch(() => null); return { ok: response.ok, data, message: data?.message }; } catch { return { ok: false, message: "Serveur indisponible." }; } }
function escapeHtml(value) { return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;"); }
function formatDateTime(value) { return value ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : ""; }
