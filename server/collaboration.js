import { getPool } from "./database.js";
import { getAccountOwnerId } from "./auth.js";

const LOCK_TIMEOUT_SECONDS = 15 * 60;
const ENTITY_TYPES = new Set(["technical_report", "billing_document", "client", "calendar_event", "partner_mission", "partner_connection", "partner_request"]);
const PARTNER_ENTITY_TYPES = new Set(["partner_mission", "partner_connection", "partner_request"]);
const streamsByOwner = new Map();

export async function initializeCollaboration() {
    const database = getPool();
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_collaboration_locks (
            owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            entity_type VARCHAR(40) NOT NULL, entity_id VARCHAR(120) NOT NULL,
            locked_by BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ NOT NULL, device_type VARCHAR(20) NOT NULL DEFAULT 'desktop', device_label VARCHAR(100) NOT NULL DEFAULT '',
            PRIMARY KEY (owner_id, entity_type, entity_id)
        )
    `);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_collaboration_locks_expiry_idx ON depannhome_collaboration_locks (expires_at)");
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_collaboration_notifications (
            id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            recipient_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            event_type VARCHAR(80) NOT NULL, entity_type VARCHAR(40) NOT NULL DEFAULT '', entity_id VARCHAR(120) NOT NULL DEFAULT '',
            title VARCHAR(200) NOT NULL, body VARCHAR(2000) NOT NULL DEFAULT '', payload JSONB NOT NULL DEFAULT '{}'::jsonb,
            read_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_collaboration_notifications_recipient_idx ON depannhome_collaboration_notifications (recipient_id, read_at, created_at DESC)");
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_collaboration_audit (
            id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            entity_type VARCHAR(40) NOT NULL, entity_id VARCHAR(120) NOT NULL, action VARCHAR(80) NOT NULL,
            actor_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL, actor_role VARCHAR(30) NOT NULL DEFAULT '',
            ip_address VARCHAR(100) NOT NULL DEFAULT '', device_type VARCHAR(20) NOT NULL DEFAULT '', device_label VARCHAR(100) NOT NULL DEFAULT '',
            details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_collaboration_audit_entity_idx ON depannhome_collaboration_audit (owner_id, entity_type, entity_id, created_at DESC)");
}

export function registerCollaborationRoutes(app, requireAuthentication) {
    app.get("/api/collaboration/stream", requireAuthentication, (request, response) => {
        const ownerId = getAccountOwnerId(request);
        response.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        response.flushHeaders?.();
        response.write(`event: connected\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
        const stream = { response, userId: String(request.user.sub) };
        if (!streamsByOwner.has(ownerId)) streamsByOwner.set(ownerId, new Set());
        streamsByOwner.get(ownerId).add(stream);
        const heartbeat = setInterval(() => response.write(`event: heartbeat\ndata: {}\n\n`), 25_000);
        request.on("close", () => { clearInterval(heartbeat); streamsByOwner.get(ownerId)?.delete(stream); if (!streamsByOwner.get(ownerId)?.size) streamsByOwner.delete(ownerId); });
    });
    app.get("/api/collaboration/notifications", requireAuthentication, asyncHandler(async (request, response) => {
        const { rows } = await getPool().query(`SELECT id, event_type AS "eventType", entity_type AS "entityType", entity_id AS "entityId", title, body, payload, read_at AS "readAt", created_at AS "createdAt" FROM depannhome_collaboration_notifications WHERE recipient_id=$1 AND NOT (entity_type IN ('partner_mission','partner_connection','partner_request') OR event_type LIKE 'partner_mission_%' OR event_type LIKE 'partner_connection_%' OR event_type LIKE 'partner_request_%' OR event_type='partner_dialogue_updated') ORDER BY created_at DESC LIMIT 100`, [request.user.sub]);
        response.json({ notifications: rows });
    }));
    app.get("/api/collaboration/partner-notifications", requireAuthentication, requirePartnerNotificationAccess, asyncHandler(async (request, response) => {
        const { rows } = await getPool().query(`SELECT id, event_type AS "eventType", entity_type AS "entityType", entity_id AS "entityId", title, body, payload, read_at AS "readAt", created_at AS "createdAt" FROM depannhome_collaboration_notifications WHERE recipient_id=$1 AND (entity_type IN ('partner_mission','partner_connection','partner_request') OR event_type LIKE 'partner_mission_%' OR event_type LIKE 'partner_connection_%' OR event_type LIKE 'partner_request_%' OR event_type='partner_dialogue_updated') ORDER BY created_at DESC LIMIT 100`, [request.user.sub]);
        response.json({ notifications: rows });
    }));
    app.post("/api/collaboration/notifications/read", requireAuthentication, asyncHandler(async (request, response) => {
        const ids = Array.isArray(request.body?.ids) ? request.body.ids.map(positiveId).filter(Boolean).slice(0, 100) : [];
        const partnerOnly = request.body?.scope === "partner";
        const partnerCondition = "(entity_type IN ('partner_mission','partner_connection','partner_request') OR event_type LIKE 'partner_mission_%' OR event_type LIKE 'partner_connection_%' OR event_type LIKE 'partner_request_%' OR event_type='partner_dialogue_updated')";
        await getPool().query(ids.length ? `UPDATE depannhome_collaboration_notifications SET read_at=NOW() WHERE recipient_id=$1 AND id=ANY($2::bigint[]) AND read_at IS NULL${partnerOnly ? ` AND ${partnerCondition}` : ""}` : `UPDATE depannhome_collaboration_notifications SET read_at=NOW() WHERE recipient_id=$1 AND read_at IS NULL${partnerOnly ? ` AND ${partnerCondition}` : ""}`, ids.length ? [request.user.sub, ids] : [request.user.sub]);
        response.status(204).end();
    }));
    app.delete("/api/collaboration/notifications/read", requireAuthentication, asyncHandler(async (request, response) => {
        const result = await getPool().query("DELETE FROM depannhome_collaboration_notifications WHERE recipient_id=$1 AND read_at IS NOT NULL", [request.user.sub]);
        response.json({ deletedCount: result.rowCount || 0 });
    }));
    app.post("/api/collaboration/locks/:entityType/:entityId/acquire", requireAuthentication, asyncHandler(async (request, response) => {
        const result = await acquireLock(request, request.params.entityType, request.params.entityId);
        response.status(result.acquired ? 200 : 409).json(result);
    }));
    app.post("/api/collaboration/locks/:entityType/:entityId/heartbeat", requireAuthentication, asyncHandler(async (request, response) => {
        const result = await heartbeatLock(request, request.params.entityType, request.params.entityId);
        response.status(result.ok ? 200 : 409).json(result);
    }));
    app.delete("/api/collaboration/locks/:entityType/:entityId", requireAuthentication, asyncHandler(async (request, response) => {
        const released = await releaseLock(request, request.params.entityType, request.params.entityId);
        response.status(released ? 204 : 404).end();
    }));
    app.post("/api/collaboration/locks/:entityType/:entityId/force-release", requireAuthentication, requireAdministrator, asyncHandler(async (request, response) => {
        const result = await forceReleaseLock(request, request.params.entityType, request.params.entityId, cleanText(request.body?.reason, 500));
        response.status(result.released ? 200 : 404).json(result);
    }));
    app.post("/api/collaboration/release-session-locks", requireAuthentication, asyncHandler(async (request, response) => {
        await releaseLocksForUser(request, "session_closed"); response.status(204).end();
    }));
}

export async function acquireLock(request, entityType, entityId) {
    const target = validTarget(entityType, entityId); if (!target) return { acquired: false, message: "Ressource collaborative invalide." };
    const ownerId = getAccountOwnerId(request); const database = getPool();
    await database.query("DELETE FROM depannhome_collaboration_locks WHERE owner_id=$1 AND entity_type=$2 AND entity_id=$3 AND expires_at <= NOW()", [ownerId, target.entityType, target.entityId]);
    const current = await getLock(ownerId, target.entityType, target.entityId);
    if (current && String(current.lockedBy) !== String(request.user.sub)) return { acquired: false, message: lockMessage(current), lock: current };
    if (current) {
        const { rows } = await database.query(`UPDATE depannhome_collaboration_locks SET last_activity_at=NOW(), expires_at=NOW()+($4::text || ' seconds')::interval WHERE owner_id=$1 AND entity_type=$2 AND entity_id=$3 RETURNING *`, [ownerId, target.entityType, target.entityId, LOCK_TIMEOUT_SECONDS]);
        return { acquired: true, lock: mapLock(rows[0]) };
    }
    try {
        const { rows } = await database.query(`INSERT INTO depannhome_collaboration_locks (owner_id, entity_type, entity_id, locked_by, expires_at, device_type, device_label) VALUES ($1,$2,$3,$4,NOW()+($5::text || ' seconds')::interval,$6,$7) RETURNING *`, [ownerId, target.entityType, target.entityId, request.user.sub, LOCK_TIMEOUT_SECONDS, deviceType(request), deviceLabel(request)]);
        const lock = mapLock({ ...rows[0], full_name: request.user.fullName, username: request.user.username, role: request.user.role });
        await recordEvent(request, target, "lock_acquired", { lock }); await broadcast(ownerId, "lock_acquired", { entityType: target.entityType, entityId: target.entityId, lock });
        return { acquired: true, lock };
    } catch (error) {
        if (error.code !== "23505") throw error;
        const lock = await getLock(ownerId, target.entityType, target.entityId);
        return { acquired: false, message: lock ? lockMessage(lock) : "Le verrouillage est en cours, réessayez.", lock };
    }
}

export async function heartbeatLock(request, entityType, entityId) {
    const target = validTarget(entityType, entityId); if (!target) return { ok: false, message: "Ressource collaborative invalide." };
    const { rows } = await getPool().query(`UPDATE depannhome_collaboration_locks SET last_activity_at=NOW(), expires_at=NOW()+($5::text || ' seconds')::interval WHERE owner_id=$1 AND entity_type=$2 AND entity_id=$3 AND locked_by=$4 AND expires_at>NOW() RETURNING *`, [getAccountOwnerId(request), target.entityType, target.entityId, request.user.sub, LOCK_TIMEOUT_SECONDS]);
    return rows[0] ? { ok: true, lock: mapLock(rows[0]) } : { ok: false, message: "Le verrouillage a expiré ou a été repris." };
}

export async function releaseLock(request, entityType, entityId, action = "lock_released") {
    const target = validTarget(entityType, entityId); if (!target) return false; const ownerId = getAccountOwnerId(request);
    const result = await getPool().query("DELETE FROM depannhome_collaboration_locks WHERE owner_id=$1 AND entity_type=$2 AND entity_id=$3 AND locked_by=$4", [ownerId, target.entityType, target.entityId, request.user.sub]);
    if (result.rowCount) { await recordEvent(request, target, action); await broadcast(ownerId, action, { entityType: target.entityType, entityId: target.entityId }); }
    return Boolean(result.rowCount);
}

export async function forceReleaseLock(request, entityType, entityId, reason = "") {
    const target = validTarget(entityType, entityId); if (!target) return { released: false, message: "Ressource collaborative invalide." }; const ownerId = getAccountOwnerId(request);
    const lock = await getLock(ownerId, target.entityType, target.entityId); if (!lock) return { released: false, message: "Aucun verrou actif." };
    await getPool().query("DELETE FROM depannhome_collaboration_locks WHERE owner_id=$1 AND entity_type=$2 AND entity_id=$3", [ownerId, target.entityType, target.entityId]);
    await recordEvent(request, target, "lock_force_released", { previousLock: lock, reason }); await broadcast(ownerId, "lock_force_released", { entityType: target.entityType, entityId: target.entityId, reason });
    if (lock.lockedBy) await createNotification(ownerId, lock.lockedBy, "lock_force_released", target, "Verrouillage repris par l’administration", `Le verrou du rapport a été repris${reason ? ` : ${reason}` : "."}`);
    return { released: true };
}

export async function assertLockOwner(request, entityType, entityId) {
    const target = validTarget(entityType, entityId); if (!target) return { ok: false, message: "Ressource collaborative invalide." }; const ownerId = getAccountOwnerId(request);
    await getPool().query("DELETE FROM depannhome_collaboration_locks WHERE owner_id=$1 AND entity_type=$2 AND entity_id=$3 AND expires_at<=NOW()", [ownerId, target.entityType, target.entityId]);
    const lock = await getLock(ownerId, target.entityType, target.entityId);
    if (lock && String(lock.lockedBy) !== String(request.user.sub)) return { ok: false, message: lockMessage(lock), lock };
    if (!lock) return { ok: false, message: "Ouvrez le rapport en mode modification avant de l’enregistrer." };
    return heartbeatLock(request, target.entityType, target.entityId);
}

export async function getLock(ownerId, entityType, entityId) {
    const target = validTarget(entityType, entityId); if (!target) return null;
    const { rows } = await getPool().query(`SELECT lock.*, account.full_name, account.username, account.role FROM depannhome_collaboration_locks lock JOIN depannhome_users account ON account.id=lock.locked_by WHERE lock.owner_id=$1 AND lock.entity_type=$2 AND lock.entity_id=$3 AND lock.expires_at>NOW()`, [ownerId, target.entityType, target.entityId]);
    return rows[0] ? mapLock(rows[0]) : null;
}

export async function recordEvent(request, target, action, details = {}) {
    if (!target?.entityType || !target?.entityId) return;
    const ownerId = getAccountOwnerId(request); if (!ownerId) return;
    await getPool().query(`INSERT INTO depannhome_collaboration_audit (owner_id, entity_type, entity_id, action, actor_id, actor_role, ip_address, device_type, device_label, details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`, [ownerId, target.entityType, target.entityId, action, request.user?.sub || null, request.user?.principalRole || request.user?.role || "", request.ip || "", deviceType(request), deviceLabel(request), JSON.stringify(details)]);
}

export async function publishEvent(request, target, action, details = {}, notifications = []) {
    await recordEvent(request, target, action, details);
    const ownerId = getAccountOwnerId(request);
    await broadcast(ownerId, action, { entityType: target.entityType, entityId: target.entityId, details, actor: actor(request) });
    await Promise.all(notifications.map(notification => createNotification(ownerId, notification.recipientId, notification.eventType || action, target, notification.title, notification.body, notification.payload || {})));
}

export async function createNotification(ownerId, recipientId, eventType, target, title, body = "", payload = {}) {
    if (!recipientId) return null;
    if (isPartnerBusinessNotification(eventType, target)) {
        const { rows: recipients } = await getPool().query("SELECT role FROM depannhome_users WHERE id=$1 AND account_owner_id=$2", [recipientId, ownerId]);
        if (["technician", "team_lead"].includes(recipients[0]?.role)) return null;
    }
    const { rows } = await getPool().query(`INSERT INTO depannhome_collaboration_notifications (owner_id, recipient_id, event_type, entity_type, entity_id, title, body, payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING id, created_at AS "createdAt"`, [ownerId, recipientId, eventType, target.entityType, target.entityId, cleanText(title, 200), cleanText(body, 2000), JSON.stringify(payload)]);
    await broadcast(ownerId, "notification", { recipientId: String(recipientId), notification: { id: rows[0].id, eventType, entityType: target.entityType, entityId: target.entityId, title, body, payload, createdAt: rows[0].createdAt } }); return rows[0];
}

function isPartnerBusinessNotification(eventType, target = {}) {
    const type = String(eventType || "");
    return PARTNER_ENTITY_TYPES.has(String(target?.entityType || "")) || type.startsWith("partner_mission_") || type.startsWith("partner_connection_") || type.startsWith("partner_request_") || type === "partner_dialogue_updated";
}

export async function releaseLocksForUser(request, action = "session_closed") {
    const ownerId = getAccountOwnerId(request); const { rows } = await getPool().query("DELETE FROM depannhome_collaboration_locks WHERE owner_id=$1 AND locked_by=$2 RETURNING entity_type, entity_id", [ownerId, request.user.sub]);
    await Promise.all(rows.map(row => publishEvent(request, { entityType: row.entity_type, entityId: row.entity_id }, action)));
}

export async function getAudit(ownerId, entityType, entityId) {
    const target = validTarget(entityType, entityId); if (!target) return [];
    const { rows } = await getPool().query(`SELECT audit.id, audit.action, audit.actor_role AS "actorRole", audit.ip_address AS "ipAddress", audit.device_type AS "deviceType", audit.device_label AS "deviceLabel", audit.details, audit.created_at AS "createdAt", account.full_name AS "actorName", account.username AS "actorUsername" FROM depannhome_collaboration_audit audit LEFT JOIN depannhome_users account ON account.id=audit.actor_id WHERE audit.owner_id=$1 AND audit.entity_type=$2 AND audit.entity_id=$3 ORDER BY audit.created_at DESC LIMIT 150`, [ownerId, target.entityType, target.entityId]); return rows;
}

async function broadcast(ownerId, event, data) { for (const stream of streamsByOwner.get(String(ownerId)) || []) { try { stream.response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* Le handler close retire la connexion. */ } } }
export async function broadcastOwnerEvent(ownerId, event, data) { await broadcast(ownerId, event, data); }
function mapLock(lock) { return { entityType: lock.entity_type, entityId: lock.entity_id, lockedBy: String(lock.locked_by), userName: lock.full_name || lock.username || "Utilisateur", role: lock.role || "", openedAt: lock.locked_at, lastActivityAt: lock.last_activity_at, expiresAt: lock.expires_at, deviceType: lock.device_type || "desktop" }; }
function lockMessage(lock) { return `Rapport actuellement modifié par ${lock.userName} (${roleLabel(lock.role)}) depuis ${new Intl.DateTimeFormat("fr-FR", { timeStyle: "short" }).format(new Date(lock.openedAt))}.`; }
function roleLabel(role) { return ({ technician: "Technicien", admin: "Administrateur", accountant: "Comptabilité" })[role] || "Utilisateur"; }
function actor(request) { return { id: String(request.user.sub), name: request.user.fullName || request.user.username || "Utilisateur", role: request.user.role || "", deviceType: deviceType(request) }; }
function validTarget(entityType, entityId) { const type = String(entityType || ""); const id = String(entityId || "").slice(0, 120); return ENTITY_TYPES.has(type) && /^[a-zA-Z0-9_-]+$/.test(id) ? { entityType: type, entityId: id } : null; }
function deviceType(request) { return request.user?.deviceType === "mobile" ? "mobile" : /mobile|android|iphone|ipad/i.test(request.get?.("user-agent") || "") ? "mobile" : "desktop"; }
function deviceLabel(request) { return String(request.get?.("user-agent") || "").slice(0, 100); }
function positiveId(value) { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : 0; }
function cleanText(value, max) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, max); }
function requireAdministrator(request, response, next) { if (request.user?.role !== "admin") return response.status(403).json({ message: "La reprise de verrou est réservée à l’administration." }); return next(); }
function requirePartnerNotificationAccess(request, response, next) { if (["admin", "pc_standard", "mobile_admin"].includes(request.user?.role)) return next(); return response.status(403).json({ message: "Les notifications partenaires sont réservées à l’administration." }); }
function asyncHandler(handler) { return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next); }
