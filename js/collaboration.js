import { clientSessionUrl } from "./client-session.js?v=2";
import { getSettings } from "./storage.js?v=45";

let stream = null;
let notifications = [];
let partnerNotifications = [];
let notificationButton = null;
let companyAssistancePresenceTimer = null;
let activeAssistanceSessionId = "";
let followingSupport = false;
let lastCursorSentAt = 0;
let scrollTimer = null;

export function initializeCollaboration() {
    if (stream || !window.EventSource) return;
    notificationButton = document.getElementById("notificationsBtn");
    notificationButton?.addEventListener("click", openNotificationCenter);
    loadNotifications();
    loadPartnerNotifications();
    loadCompanyAssistancePresence();
    companyAssistancePresenceTimer ||= window.setInterval(loadCompanyAssistancePresence, 15_000);
    stream = new EventSource(clientSessionUrl("/api/collaboration/stream"));
    stream.addEventListener("notification", event => handleEvent("notification", event));
    ["lock_acquired", "lock_released", "lock_force_released", "report_started", "report_saved", "report_media_added", "report_media_updated", "report_media_deleted", "report_submitted", "report_correction_requested", "report_validated", "report_reopened", "mission_journal_updated", "creator_assistance_decision", "support_cobrowse"].forEach(type => stream.addEventListener(type, event => handleEvent(type, event)));
    stream.onerror = () => updateSyncIndicator("syncing", "Reconnexion en cours");
    stream.onopen = () => updateSyncIndicator("synced", "Synchronisé en temps réel");
    window.addEventListener("beforeunload", releaseSessionLocks, { capture: true });
    window.addEventListener("online", () => updateSyncIndicator("syncing", "Reconnexion en cours"));
    window.addEventListener("offline", () => updateSyncIndicator("offline", "Hors connexion"));
    window.addEventListener("depannhome:settings-changed", () => { document.getElementById("notificationCenter")?.remove(); renderNotificationBadge(); renderPartnerNotificationBadge(); });
    window.addEventListener("depannhome:open-company-assistance", event => openCompanyAssistanceRequest(event.detail?.sessionId));
    window.addEventListener("depannhome:company-assistance-decided", loadCompanyAssistancePresence);
    window.addEventListener("depannhome:route-changed", event => sendCobrowse({ type: "route", route: event.detail?.route }));
    document.addEventListener("pointermove", emitSupportCursor, { passive: true });
    document.addEventListener("click", emitSupportClick, { capture: true });
    window.addEventListener("scroll", emitSupportScroll, { passive: true });
    document.addEventListener("keydown", event => { if (event.key === "Escape" && followingSupport) stopFollowingSupport(); });
}

export async function acquireReportLock(reportId) { return request(`/api/collaboration/locks/technical_report/${encodeURIComponent(reportId)}/acquire`, { method: "POST" }); }
export async function heartbeatReportLock(reportId) { return request(`/api/collaboration/locks/technical_report/${encodeURIComponent(reportId)}/heartbeat`, { method: "POST" }); }
export async function releaseReportLock(reportId) { return request(`/api/collaboration/locks/technical_report/${encodeURIComponent(reportId)}`, { method: "DELETE" }); }
export async function forceReleaseReportLock(reportId, reason) { return request(`/api/collaboration/locks/technical_report/${encodeURIComponent(reportId)}/force-release`, { method: "POST", body: JSON.stringify({ reason }) }); }
export function getNotifications() { return visibleNotifications(notifications); }
export function getPartnerNotifications() { return visibleNotifications(partnerNotifications); }

async function loadNotifications() { const result = await request("/api/collaboration/notifications"); if (!result.ok) return; notifications = result.data.notifications || []; renderNotificationBadge(); }
export async function loadPartnerNotifications() { const result = await request("/api/collaboration/partner-notifications"); if (!result.ok) return []; partnerNotifications = deduplicatePartnerNotifications(result.data.notifications || []); renderPartnerNotificationBadge(); return visibleNotifications(partnerNotifications); }
async function loadCompanyAssistancePresence() {
    const result = await request("/api/assistance/active");
    if (!result.ok) return;
    document.getElementById("companySupportPresenceBanner")?.remove();
    const session = result.data?.session;
    if (!session) { activeAssistanceSessionId = ""; followingSupport = false; removeSupportOverlay(); return; }
    activeAssistanceSessionId = String(session.id || "");
    const banner = document.createElement("aside");
    banner.id = "companySupportPresenceBanner";
    banner.className = "support-control-banner company-support-presence-banner";
    banner.innerHTML = `<div><strong>Support Depann’Home Pro connecté à distance</strong><span>Accès autorisé jusqu’au ${escapeHtml(formatDateTime(session.expiresAt))}</span><small>${escapeHtml(session.reason || "Assistance à distance")}</small></div><div class="support-presence-actions"><button type="button" class="secondary-button" data-follow-company-support>${followingSupport ? "Arrêter de suivre" : "Suivre le Support"}</button>${result.data?.canRevoke ? `<button type="button" class="secondary-button danger-button" data-manage-company-assistance="${escapeHtml(session.id)}">Gérer ou retirer l’accès</button>` : '<strong>Accès supervisé par votre Poste Admin</strong>'}</div>`;
    document.body.prepend(banner);
    banner.querySelector("[data-manage-company-assistance]")?.addEventListener("click", () => openCompanyAssistanceRequest(session.id));
    banner.querySelector("[data-follow-company-support]")?.addEventListener("click", event => { followingSupport = !followingSupport; event.currentTarget.textContent = followingSupport ? "Arrêter de suivre" : "Suivre le Support"; if (!followingSupport) removeSupportOverlay(); });
}
export async function markPartnerNotificationsRead() { const unreadIds = visibleNotifications(partnerNotifications).filter(item => !item.readAt).map(item => item.id); if (!unreadIds.length) return; const result = await request("/api/collaboration/notifications/read", { method: "POST", body: JSON.stringify({ ids: unreadIds, scope: "partner" }) }); if (!result.ok) return; const readAt = new Date().toISOString(); partnerNotifications = partnerNotifications.map(item => unreadIds.some(id => String(id) === String(item.id)) ? { ...item, readAt } : item); renderPartnerNotificationBadge(); }
function handleEvent(type, event) { let data = {}; try { data = JSON.parse(event.data); } catch { return; } if (type === "support_cobrowse") handleSupportCobrowse(data); if (type === "notification" && String(data.recipientId || "") === String(document.body.dataset.userId || "")) { if (isPartnerNotification(data.notification)) { partnerNotifications = deduplicatePartnerNotifications([data.notification, ...partnerNotifications]); renderPartnerNotificationBadge(); } else { notifications.unshift(data.notification); renderNotificationBadge(); } }
    window.dispatchEvent(new CustomEvent("depannhome:collaboration-event", { detail: { type, ...data } }));
}

function emitSupportCursor(event) { const now = Date.now(); if (now - lastCursorSentAt < 100) return; lastCursorSentAt = now; sendCobrowse({ type: "cursor", route: currentRoute(), x: event.clientX / Math.max(window.innerWidth, 1), y: event.clientY / Math.max(window.innerHeight, 1) }); }
function emitSupportClick(event) { if (document.body.dataset.supportControl !== "true" && followingSupport) stopFollowingSupport(); if (event.target?.closest?.("input, textarea, select, [contenteditable=true], [data-sensitive]")) return; sendCobrowse({ type: "click", route: currentRoute(), x: event.clientX / Math.max(window.innerWidth, 1), y: event.clientY / Math.max(window.innerHeight, 1) }); }
function emitSupportScroll() { window.clearTimeout(scrollTimer); scrollTimer = window.setTimeout(() => sendCobrowse({ type: "scroll", route: currentRoute(), y: window.scrollY / Math.max(document.documentElement.scrollHeight - window.innerHeight, 1) }), 150); }
function currentRoute() { return document.querySelector(".nav-button.active")?.dataset.nav || "home"; }
function sendCobrowse(payload) { if (document.body.dataset.supportControl !== "true") return; void fetch(clientSessionUrl("/api/collaboration/support-cobrowse"), { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).catch(() => {}); }
function handleSupportCobrowse(data) {
    if (document.body.dataset.supportControl === "true" || !activeAssistanceSessionId || String(data.sessionId || "") !== activeAssistanceSessionId) return;
    if (data.type === "route" && followingSupport) window.dispatchEvent(new CustomEvent("depannhome:support-follow-route", { detail: { route: data.route } }));
    if (data.type === "cursor" || data.type === "click") renderSupportPointer(data, data.type === "click");
    if (data.type === "scroll" && followingSupport) window.scrollTo({ top: Number(data.y || 0) * Math.max(document.documentElement.scrollHeight - window.innerHeight, 0), behavior: "smooth" });
}
function renderSupportPointer(data, clicked) { let pointer = document.getElementById("companySupportCursor"); if (!pointer) { pointer = document.createElement("div"); pointer.id = "companySupportCursor"; pointer.className = "support-cursor-overlay"; pointer.setAttribute("aria-hidden", "true"); document.body.append(pointer); } pointer.style.left = `${Math.max(0, Math.min(1, Number(data.x) || 0)) * 100}vw`; pointer.style.top = `${Math.max(0, Math.min(1, Number(data.y) || 0)) * 100}vh`; if (clicked) { pointer.classList.remove("clicked"); void pointer.offsetWidth; pointer.classList.add("clicked"); } }
function removeSupportOverlay() { document.getElementById("companySupportCursor")?.remove(); }
function stopFollowingSupport() { followingSupport = false; removeSupportOverlay(); const button = document.querySelector("[data-follow-company-support]"); if (button) button.textContent = "Suivre le Support"; }
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
    return items.filter(item => item?.entityType === "creator_assistance" || preferences[notificationPreferenceKey(item)] !== false);
}
function canOpenNotification(notification) { return ["technical_report", "billing_document", "client", "calendar_event", "partner_mission", "partner_connection", "partner_request", "creator_assistance"].includes(notification?.entityType); }
export async function openCompanyAssistanceRequest(sessionId) {
    if (!sessionId) return;
    document.getElementById("companyAssistanceDialog")?.remove();
    const result = await request(`/api/assistance/sessions/${encodeURIComponent(sessionId)}`);
    if (!result.ok) return alert(result.message || "Cette demande d’assistance n’est plus disponible.");
    const dialog = document.createElement("div");
    dialog.id = "companyAssistanceDialog";
    dialog.className = "group-company-modal";
    const session = result.data?.session || {};
    const controlRequested = session.accessScope === "control";
    const status = session.awaitingConsent ? "Votre décision est requise" : session.active ? "Assistance autorisée" : session.declinedAt ? "Assistance refusée" : "Demande terminée";
        dialog.innerHTML = `<section class="company-assistance-dialog" role="dialog" aria-modal="true" aria-labelledby="companyAssistanceTitle"><div class="form-heading"><div><p class="eyebrow">Support Depann’Home Pro</p><h3 id="companyAssistanceTitle">${controlRequested ? "Demande de prise en main sécurisée" : "Demande d’assistance temporaire"}</h3></div><button type="button" class="icon-button" data-close-assistance-dialog aria-label="Fermer">×</button></div><span class="creator-state${session.awaitingConsent ? " suspended" : ""}">${escapeHtml(status)}</span><p><strong>Motif communiqué par le Support :</strong><br>${escapeHtml(session.reason || "Assistance technique")}</p><aside class="accounting-pdp-notice"><strong>${controlRequested ? "Prise en main limitée, visible et traçable." : "Accès limité et traçable."}</strong> ${controlRequested ? "En acceptant, vous autorisez pendant 30 minutes le Support à naviguer dans les clients, le planning, les rapports, les e-mails, les missions, la comptabilité et les paramètres non sensibles. Vous pouvez suivre sa navigation et son curseur en direct. Les mots de passe, identifiants, utilisateurs, sécurité, OAuth, clés API, banque, envois, validations, clôtures et suppressions restent bloqués. Les valeurs saisies et le contenu des formulaires ne sont jamais retransmis par la co-navigation. Chaque requête est journalisée et vous pouvez retirer l’accès à tout moment." : "En acceptant, vous autorisez pendant 30 minutes un diagnostic technique en lecture seule. Toute réparation éventuelle reste séparée, justifiée, journalisée et vous est notifiée."} Aucun mot de passe, code 2FA ou secret de connexion n’est affiché.</aside>${session.awaitingConsent ? '<div class="form-actions"><button type="button" class="primary-button" data-assistance-decision="accept">Accepter pendant 30 minutes</button><button type="button" class="secondary-button danger-button" data-assistance-decision="decline">Refuser</button></div>' : session.active ? `<p class="auth-message">Accès autorisé jusqu’au ${escapeHtml(formatDateTime(session.expiresAt))}.</p><div class="form-actions"><button type="button" class="secondary-button danger-button" data-revoke-assistance>Retirer l’accès maintenant</button></div>` : '<p class="muted">Cette demande ne permet plus d’ouvrir une session.</p>'}<p class="auth-message" data-assistance-decision-message></p></section>`;
    document.body.appendChild(dialog);
    const close = () => dialog.remove();
    dialog.querySelector("[data-close-assistance-dialog]").addEventListener("click", close);
    dialog.addEventListener("click", event => { if (event.target === dialog) close(); });
    dialog.querySelector("[data-revoke-assistance]")?.addEventListener("click", async () => {
        if (!confirm("Retirer immédiatement l’accès du Support à cette entreprise ?")) return;
        const revoked = await request(`/api/assistance/sessions/${encodeURIComponent(sessionId)}/revoke`, { method: "POST", body: JSON.stringify({}) });
        if (!revoked.ok) return alert(revoked.message || "L’accès n’a pas pu être retiré.");
        close();
        alert("L’accès du Support est retiré.");
        window.dispatchEvent(new CustomEvent("depannhome:company-assistance-decided", { detail: { sessionId, decision: "revoke" } }));
    });
    dialog.querySelectorAll("[data-assistance-decision]").forEach(button => button.addEventListener("click", async () => {
        const decision = button.dataset.assistanceDecision;
        if (decision === "accept" && !confirm("Autoriser le Support Depann’Home Pro à consulter le diagnostic technique pendant 30 minutes ?")) return;
        if (decision === "decline" && !confirm("Refuser cette demande d’assistance ?")) return;
        dialog.querySelectorAll("[data-assistance-decision]").forEach(action => { action.disabled = true; });
        const decided = await request(`/api/assistance/sessions/${encodeURIComponent(sessionId)}/decision`, { method: "POST", body: JSON.stringify({ decision }) });
        if (!decided.ok) {
            const message = dialog.querySelector("[data-assistance-decision-message]");
            message.textContent = decided.message || "La décision n’a pas pu être enregistrée.";
            message.classList.add("error");
            dialog.querySelectorAll("[data-assistance-decision]").forEach(action => { action.disabled = false; });
            return;
        }
        close();
        alert(decision === "accept" ? "Assistance acceptée pour 30 minutes. Le Support peut maintenant ouvrir le diagnostic." : "Demande d’assistance refusée.");
        loadNotifications();
        window.dispatchEvent(new CustomEvent("depannhome:company-assistance-decided", { detail: { sessionId, decision } }));
    }));
}
async function markNotificationRead(id) { if (!id) return; const result = await request("/api/collaboration/notifications/read", { method: "POST", body: JSON.stringify({ ids: [id] }) }); if (!result.ok) return; notifications = notifications.map(item => String(item.id) === String(id) ? { ...item, readAt: new Date().toISOString() } : item); renderNotificationBadge(); }
function isPartnerNotification(notification) { const type = String(notification?.eventType || ""); return ["partner_mission", "partner_connection", "partner_request"].includes(notification?.entityType) || type.startsWith("partner_mission_") || type.startsWith("partner_connection_") || type.startsWith("partner_request_") || type === "partner_dialogue_updated"; }
function deduplicatePartnerNotifications(items) {
    const seen = new Set();
    return (Array.isArray(items) ? items : []).filter(item => {
        const missionId = item?.entityType === "partner_mission" ? (item?.entityId || item?.payload?.missionId) : "";
        const key = missionId
            ? `partner_mission\u0000${String(missionId)}`
            : [item?.eventType, item?.entityType, item?.entityId, item?.title, item?.body].map(value => String(value || "")).join("\u0000");
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
