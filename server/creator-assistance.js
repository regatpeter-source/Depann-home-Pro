import crypto from "node:crypto";
import { getPool } from "./database.js";
import { companySeatState } from "./seat-limits.js";
import { getAccountOwnerId, isCompanyAdministrator, isCreatorUsername, startCreatorAssistanceControl, stopCreatorAssistanceControl } from "./auth.js";
import { broadcastOwnerEvent } from "./collaboration.js";

const NORMAL_SESSION_MINUTES = 30;
const EMERGENCY_SESSION_MINUTES = 10;
const CONSENT_REQUEST_MINUTES = 72 * 60;
const WORKSTATION_2FA_RECOVERY_ROLES = new Set(["admin", "pc_standard", "commercial"]);
const ACTION_TYPES = new Set([
    "restore_company",
    "reactivate_company",
    "reactivate_administrator",
    "reset_administrator_2fa",
    "revoke_company_sessions",
    "reject_device",
    "release_company_locks"
]);
const SUPPORT_CONTROL_SENSITIVE_PREFIXES = ["/api/auth", "/api/creator", "/api/assistance", "/api/accounting", "/api/e-invoicing", "/api/connectors", "/api/official-partners", "/api/partner-email", "/api/partner-missions", "/api/partner-dialogue", "/api/partner-connections", "/api/partner-sandbox", "/api/groups", "/api/data-imports", "/api/subscription", "/api/company", "/api/organizations", "/api/support", "/api/history", "/api/messages", "/api/purchases"];
const SUPPORT_CONTROL_WRITABLE_PREFIXES = ["/api/clients", "/api/calendar", "/api/technical-reports", "/api/collaboration"];
const SUPPORT_CONTROL_ALLOWED_EXACT = new Set(["GET /api/auth/session", "POST /api/auth/logout", "POST /api/creator/assistance/control/exit"]);

export async function initializeCreatorAssistance() {
    const database = getPool();
    await database.query(`CREATE TABLE IF NOT EXISTS depannhome_creator_support_sessions (
        id UUID PRIMARY KEY,
        created_by BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE RESTRICT,
        target_company_owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
        mode VARCHAR(20) NOT NULL DEFAULT 'readonly' CHECK (mode IN ('readonly','emergency')),
        access_scope VARCHAR(20) NOT NULL DEFAULT 'diagnostic' CHECK (access_scope IN ('diagnostic','control')),
        control_started_at TIMESTAMPTZ,
        control_last_seen_at TIMESTAMPTZ,
        reason VARCHAR(1000) NOT NULL,
        support_request_id BIGINT REFERENCES depannhome_support_requests(id) ON DELETE SET NULL,
        consent_basis VARCHAR(30) NOT NULL CHECK (consent_basis IN ('support_request','confirmed','emergency')),
        expires_at TIMESTAMPTZ NOT NULL,
        accepted_at TIMESTAMPTZ,
        accepted_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
        declined_at TIMESTAMPTZ,
        declined_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
        revoked_at TIMESTAMPTZ,
        revoked_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
        revoke_reason VARCHAR(500) NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await database.query(`ALTER TABLE depannhome_creator_support_sessions
        ADD COLUMN IF NOT EXISTS access_scope VARCHAR(20) NOT NULL DEFAULT 'diagnostic',
        ADD COLUMN IF NOT EXISTS control_started_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS control_last_seen_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS accepted_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS declined_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS declined_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL`);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_creator_support_sessions_creator_idx ON depannhome_creator_support_sessions(created_by,created_at DESC)");
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_creator_support_sessions_company_idx ON depannhome_creator_support_sessions(target_company_owner_id,created_at DESC)");
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_creator_support_sessions_active_idx ON depannhome_creator_support_sessions(expires_at) WHERE revoked_at IS NULL");
    await database.query(`CREATE TABLE IF NOT EXISTS depannhome_creator_support_activity (
        id BIGSERIAL PRIMARY KEY,
        support_session_id UUID NOT NULL REFERENCES depannhome_creator_support_sessions(id) ON DELETE CASCADE,
        creator_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE RESTRICT,
        target_company_owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
        method VARCHAR(10) NOT NULL,
        path VARCHAR(300) NOT NULL,
        status_code INTEGER NOT NULL DEFAULT 0,
        outcome VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending','success','failure','blocked')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_creator_support_activity_session_created_idx ON depannhome_creator_support_activity(support_session_id,created_at DESC)");
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_creator_support_activity_company_created_idx ON depannhome_creator_support_activity(target_company_owner_id,created_at DESC)");
    await database.query(`CREATE TABLE IF NOT EXISTS depannhome_creator_recovery_actions (
        id UUID PRIMARY KEY,
        support_session_id UUID NOT NULL REFERENCES depannhome_creator_support_sessions(id) ON DELETE RESTRICT,
        created_by BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE RESTRICT,
        target_company_owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
        action_type VARCHAR(50) NOT NULL CHECK (action_type IN ('restore_company','reactivate_company','reactivate_administrator','reset_administrator_2fa','revoke_company_sessions','reject_device','release_company_locks')),
        target_resource_type VARCHAR(30) NOT NULL DEFAULT '',
        target_resource_id VARCHAR(120) NOT NULL DEFAULT '',
        reason VARCHAR(1000) NOT NULL,
        previous_state JSONB NOT NULL DEFAULT '{}'::jsonb,
        new_state JSONB NOT NULL DEFAULT '{}'::jsonb,
        status VARCHAR(20) NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','failed')),
        error_message VARCHAR(500) NOT NULL DEFAULT '',
        is_emergency BOOLEAN NOT NULL DEFAULT FALSE,
        company_notified_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_creator_recovery_actions_company_idx ON depannhome_creator_recovery_actions(target_company_owner_id,created_at DESC)");
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_creator_recovery_actions_session_idx ON depannhome_creator_recovery_actions(support_session_id,created_at DESC)");
}

export async function enforceCreatorAssistanceControl(request, response, next) {
    if (!request.user?.isSupportControl || !String(request.originalUrl || "").startsWith("/api/")) return next();
    const path = String(request.originalUrl || request.path || "").split("?")[0].slice(0, 300);
    const method = String(request.method || "GET").toUpperCase();
    const exact = `${method} ${path}`;
    const mutation = !["GET", "HEAD", "OPTIONS"].includes(method);
    const sensitive = SUPPORT_CONTROL_SENSITIVE_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
    const writable = SUPPORT_CONTROL_WRITABLE_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`)) && isAllowedSupportControlMutation(method, path);
    const destructive = method === "DELETE" && !path.startsWith("/api/collaboration/locks/");
    const sensitiveAction = mutation && /\/(?:validate|validation|submit|send|email|deliver|delivery|reopen|cancel)(?:\/|$)/i.test(path);
    if (!SUPPORT_CONTROL_ALLOWED_EXACT.has(exact) && (sensitive || destructive || sensitiveAction || (mutation && !writable))) {
        await recordSupportActivity(request.user.supportSessionId, request.user.sub, getAccountOwnerId(request), method, path, 403, "blocked");
        return response.status(403).json({ message: "Cette opération sensible est bloquée pendant la prise en main. Quittez le mode assistance ou utilisez une action de récupération encadrée." });
    }
    let mandatoryActivityId = 0;
    if (mutation && !SUPPORT_CONTROL_ALLOWED_EXACT.has(exact)) {
        try {
            mandatoryActivityId = await createPendingSupportActivity(request.user.supportSessionId, request.user.sub, getAccountOwnerId(request), method, path);
        } catch (error) {
            console.error("[creator-assistance] mandatory support audit unavailable", { sessionId: request.user.supportSessionId, code: error.code || error.name || "AUDIT_ERROR" });
            return response.status(503).json({ message: "L’action est bloquée car sa traçabilité ne peut pas être garantie pour le moment." });
        }
    }
    response.once("finish", () => {
        const outcome = response.statusCode < 400 ? "success" : "failure";
        if (mandatoryActivityId) void completeSupportActivity(mandatoryActivityId, response.statusCode, outcome);
        else void recordSupportActivity(request.user.supportSessionId, request.user.sub, getAccountOwnerId(request), method, path, response.statusCode, outcome);
    });
    return next();
}

function isAllowedSupportControlMutation(method, path) {
    if (path.startsWith("/api/collaboration/locks/")) return true;
    if (method === "PUT" && /^\/api\/clients\/[^/]+$/.test(path)) return true;
    if (method === "POST" && /^\/api\/clients\/[^/]+\/attachments$/.test(path)) return true;
    if (method === "POST" && path === "/api/calendar/events") return true;
    if (method === "PUT" && /^\/api\/calendar\/events\/[^/]+$/.test(path)) return true;
    if (method === "POST" && path === "/api/technical-reports") return true;
    if (method === "PUT" && /^\/api\/technical-reports\/(?!template$)[^/]+$/.test(path)) return true;
    if (method === "POST" && /^\/api\/technical-reports\/[^/]+\/(?:pdf-preview|media)$/.test(path)) return true;
    if (method === "POST" && /^\/api\/technical-reports\/[^/]+\/sections\/[^/]+\/duplicate-media$/.test(path)) return true;
    return method === "PATCH" && /^\/api\/technical-reports\/[^/]+\/media\/[^/]+$/.test(path);
}

export function registerCreatorAssistanceRoutes(app, requireCreator, requireAuthentication) {
    app.get("/api/creator/assistance/sessions", requireCreator, asyncHandler(async (request, response) => {
        const { rows } = await getPool().query(`${sessionSelect()}
            WHERE session.created_by=$1
            ORDER BY session.created_at DESC LIMIT 100`, [request.user.sub]);
        response.json({ sessions: rows.map(publicSession) });
    }));

    app.post("/api/creator/assistance/sessions", requireCreator, asyncHandler(async (request, response) => {
        const companyOwnerId = positiveId(request.body?.companyOwnerId);
        const supportRequestId = positiveId(request.body?.supportRequestId) || null;
        const emergency = request.body?.emergency === true;
        const accessScope = !emergency && request.body?.accessScope === "control" ? "control" : "diagnostic";
        const reason = cleanMultilineText(request.body?.reason, 1000);
        if (!companyOwnerId) return response.status(400).json({ message: "Sélectionnez une entreprise." });
        if (reason.length < (emergency ? 20 : 10)) return response.status(400).json({ message: emergency ? "Décrivez précisément l’urgence en au moins 20 caractères." : "Décrivez la demande d’assistance en au moins 10 caractères." });
        const owner = await findCompanyOwner(getPool(), companyOwnerId);
        if (!owner || isCreatorUsername(owner.username)) return response.status(404).json({ message: "Entreprise cliente introuvable." });
        let consentBasis = emergency ? "emergency" : request.body?.consentConfirmed === true ? "confirmed" : "";
        if (supportRequestId) {
            const linked = await getPool().query("SELECT id FROM depannhome_support_requests WHERE id=$1 AND owner_id=$2", [supportRequestId, companyOwnerId]);
            if (!linked.rowCount) return response.status(400).json({ message: "La demande Support ne correspond pas à cette entreprise." });
            consentBasis = "support_request";
        }
        if (!consentBasis) return response.status(400).json({ message: "Confirmez l’accord de l’entreprise ou liez une demande Support." });
        const id = crypto.randomUUID();
        const duration = emergency ? EMERGENCY_SESSION_MINUTES : CONSENT_REQUEST_MINUTES;
        const database = getPool();
        const connection = await database.connect();
        let rows;
        try {
            await connection.query("BEGIN");
            ({ rows } = await connection.query(`INSERT INTO depannhome_creator_support_sessions
                (id,created_by,target_company_owner_id,mode,access_scope,reason,support_request_id,consent_basis,expires_at,accepted_at)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW()+($9::text||' minutes')::interval,CASE WHEN $10::boolean THEN NOW() ELSE NULL END)
                RETURNING id,created_by AS "createdBy",target_company_owner_id AS "companyOwnerId",mode,access_scope AS "accessScope",reason,support_request_id AS "supportRequestId",consent_basis AS "consentBasis",expires_at AS "expiresAt",accepted_at AS "acceptedAt",revoked_at AS "revokedAt",created_at AS "createdAt"`,
            [id, request.user.sub, companyOwnerId, emergency ? "emergency" : "readonly", accessScope, reason, supportRequestId, consentBasis, duration, emergency]));
            await connection.query("COMMIT");
        } catch (error) {
            await connection.query("ROLLBACK");
            throw error;
        } finally {
            connection.release();
        }
        const controlRequested = accessScope === "control";
        const notifications = await safelyInsertCompanyNotifications(companyOwnerId, emergency ? "support_assistance_emergency_started" : "support_assistance_consent_requested", id, emergency ? "Assistance d’urgence du Support" : controlRequested ? "Demande de prise en main du Support" : "Demande d’assistance du Support", emergency ? `Le Support Depann’Home Pro a ouvert une session d’urgence de ${EMERGENCY_SESSION_MINUTES} minutes limitée au diagnostic. Motif : ${reason}` : controlRequested ? `Le Support Depann’Home Pro demande une prise en main temporaire et tracée de 30 minutes. Ouvrez cette notification pour accepter ou refuser. Motif : ${reason}` : `Le Support Depann’Home Pro demande un diagnostic temporaire en lecture seule. Ouvrez cette notification pour accepter ou refuser. Motif : ${reason}`, { sessionId: id, emergency, accessScope, expiresAt: rows[0].expiresAt, consentRequired: !emergency });
        await safelyBroadcastCompanyNotifications(companyOwnerId, notifications, id);
        response.status(201).json({ session: publicSession({ ...rows[0], companyName: owner.companyName }) });
    }));

    app.get("/api/assistance/sessions", requireAuthentication, asyncHandler(async (request, response) => {
        if (!isCompanyAdministrator(request)) return response.status(403).json({ message: "Seul un Poste Admin autorisé peut consulter les demandes d’assistance." });
        const { rows } = await getPool().query(`${sessionSelect()} WHERE session.target_company_owner_id=$1 ORDER BY session.created_at DESC LIMIT 30`, [getAccountOwnerId(request)]);
        response.json({ sessions: rows.map(publicSession) });
    }));

    app.get("/api/assistance/active", requireAuthentication, asyncHandler(async (request, response) => {
        const { rows } = await getPool().query(`${sessionSelect()} WHERE session.target_company_owner_id=$1 AND session.access_scope='control' AND session.accepted_at IS NOT NULL AND session.control_last_seen_at>NOW()-INTERVAL '30 seconds' AND session.declined_at IS NULL AND session.revoked_at IS NULL AND session.expires_at>NOW() ORDER BY session.control_last_seen_at DESC LIMIT 1`, [getAccountOwnerId(request)]);
        response.json({ session: rows[0] ? publicSession(rows[0]) : null, canRevoke: isCompanyAdministrator(request) });
    }));

    app.get("/api/assistance/sessions/:sessionId", requireAuthentication, asyncHandler(async (request, response) => {
        if (!isCompanyAdministrator(request)) return response.status(403).json({ message: "Seul un Poste Admin autorisé peut répondre à cette demande d’assistance." });
        const sessionId = validUuid(request.params.sessionId);
        if (!sessionId) return response.status(400).json({ message: "Demande d’assistance invalide." });
        const { rows } = await getPool().query(`${sessionSelect()} WHERE session.id=$1 AND session.target_company_owner_id=$2`, [sessionId, getAccountOwnerId(request)]);
        if (!rows[0]) return response.status(404).json({ message: "Demande d’assistance introuvable pour cette entreprise." });
        response.json({ session: publicSession(rows[0]) });
    }));

    app.post("/api/creator/assistance/sessions/:sessionId/control", requireCreator, asyncHandler(async (request, response) => {
        const session = await activeSession(request.params.sessionId, request.user.sub);
        if (!session || session.accessScope !== "control" || session.mode === "emergency") return response.status(403).json({ message: "La prise en main n’a pas été autorisée par l’entreprise." });
        await getPool().query("UPDATE depannhome_creator_support_sessions SET control_started_at=COALESCE(control_started_at,NOW()),control_last_seen_at=NOW(),updated_at=NOW() WHERE id=$1", [session.id]);
        await startCreatorAssistanceControl(response, request.user, session.id);
        await recordSupportActivity(session.id, request.user.sub, session.target_company_owner_id, "POST", "/api/creator/assistance/control/enter", 200, "success");
        response.json({ active: true, session: publicSession(session) });
    }));

    app.post("/api/creator/assistance/control/exit", requireCreator, asyncHandler(async (request, response) => {
        const sessionId = request.user.supportSessionId;
        if (sessionId) {
            await getPool().query("UPDATE depannhome_creator_support_sessions SET control_last_seen_at=NULL,updated_at=NOW() WHERE id=$1 AND created_by=$2", [sessionId, request.user.sub]);
        }
        await stopCreatorAssistanceControl(response, request.user);
        response.json({ active: false });
    }));

    app.post("/api/assistance/sessions/:sessionId/decision", requireAuthentication, asyncHandler(async (request, response) => {
        if (!isCompanyAdministrator(request)) return response.status(403).json({ message: "Seul un Poste Admin autorisé peut accepter ou refuser l’assistance." });
        const sessionId = validUuid(request.params.sessionId);
        const decision = request.body?.decision === "accept" ? "accept" : request.body?.decision === "decline" ? "decline" : "";
        if (!sessionId || !decision) return response.status(400).json({ message: "Décision d’assistance invalide." });
        const ownerId = getAccountOwnerId(request);
        const connection = await getPool().connect();
        let session;
        let notifications;
        try {
            await connection.query("BEGIN");
            const locked = await connection.query(`${sessionSelect()} WHERE session.id=$1 AND session.target_company_owner_id=$2 FOR UPDATE OF session`, [sessionId, ownerId]);
            session = locked.rows[0];
            if (!session) { await connection.query("ROLLBACK"); return response.status(404).json({ message: "Demande d’assistance introuvable." }); }
            if (session.mode === "emergency" || session.acceptedAt || session.declinedAt || session.revokedAt || new Date(session.expiresAt).getTime() <= Date.now()) {
                await connection.query("ROLLBACK");
                return response.status(409).json({ message: "Cette demande d’assistance a déjà été traitée ou a expiré." });
            }
            if (decision === "accept") {
                const updated = await connection.query("UPDATE depannhome_creator_support_sessions SET accepted_at=NOW(),accepted_by=$2,expires_at=NOW()+($3::text||' minutes')::interval,updated_at=NOW() WHERE id=$1 RETURNING accepted_at AS \"acceptedAt\",expires_at AS \"expiresAt\"", [sessionId, request.user.sub, NORMAL_SESSION_MINUTES]);
                Object.assign(session, updated.rows[0]);
                notifications = await insertCompanyNotifications(connection, ownerId, "support_assistance_accepted", sessionId, "Assistance acceptée", session.accessScope === "control" ? `La prise en main temporaire et tracée du Support Depann’Home Pro est autorisée pendant ${NORMAL_SESSION_MINUTES} minutes.` : `Le diagnostic temporaire en lecture seule du Support Depann’Home Pro est autorisé pendant ${NORMAL_SESSION_MINUTES} minutes.`, { sessionId, accessScope: session.accessScope, expiresAt: session.expiresAt });
            } else {
                const updated = await connection.query("UPDATE depannhome_creator_support_sessions SET declined_at=NOW(),declined_by=$2,revoked_at=NOW(),revoked_by=$2,revoke_reason='Assistance refusée par l’entreprise',updated_at=NOW() WHERE id=$1 RETURNING declined_at AS \"declinedAt\",revoked_at AS \"revokedAt\",revoke_reason AS \"revokeReason\"", [sessionId, request.user.sub]);
                Object.assign(session, updated.rows[0]);
                notifications = await insertCompanyNotifications(connection, ownerId, "support_assistance_declined", sessionId, "Assistance refusée", "La demande d’accès temporaire du Support Depann’Home Pro a été refusée.", { sessionId });
            }
            await connection.query("COMMIT");
        } catch (error) {
            await connection.query("ROLLBACK");
            throw error;
        } finally {
            connection.release();
        }
        await safelyBroadcastCompanyNotifications(ownerId, notifications, sessionId);
        await safelyBroadcastCreatorDecision(session.createdBy, sessionId, decision);
        response.json({ session: publicSession(session) });
    }));

    app.post("/api/assistance/sessions/:sessionId/revoke", requireAuthentication, asyncHandler(async (request, response) => {
        if (!isCompanyAdministrator(request)) return response.status(403).json({ message: "Seul un Poste Admin autorisé peut retirer cet accès." });
        const sessionId = validUuid(request.params.sessionId);
        if (!sessionId) return response.status(400).json({ message: "Session d’assistance invalide." });
        const ownerId = getAccountOwnerId(request);
        const { rows } = await getPool().query(`UPDATE depannhome_creator_support_sessions SET revoked_at=NOW(),revoked_by=$3,revoke_reason='Accès retiré par l’entreprise',updated_at=NOW()
            WHERE id=$1 AND target_company_owner_id=$2 AND accepted_at IS NOT NULL AND revoked_at IS NULL AND expires_at>NOW()
            RETURNING created_by AS "createdBy"`, [sessionId, ownerId, request.user.sub]);
        if (!rows[0]) return response.status(409).json({ message: "Cette session est déjà terminée ou expirée." });
        await safelyBroadcastCreatorDecision(rows[0].createdBy, sessionId, "revoke");
        response.json({ revoked: true });
    }));

    app.get("/api/creator/assistance/sessions/:sessionId/diagnostics", requireCreator, asyncHandler(async (request, response) => {
        const session = await activeSession(request.params.sessionId, request.user.sub);
        if (!session) return response.status(404).json({ message: "Session d’assistance absente, révoquée ou expirée." });
        await getPool().query("UPDATE depannhome_creator_support_sessions SET updated_at=NOW() WHERE id=$1", [session.id]);
        response.json({ session: publicSession(session), diagnostics: await loadDiagnostics(session.target_company_owner_id) });
    }));

    app.delete("/api/creator/assistance/sessions/:sessionId", requireCreator, asyncHandler(async (request, response) => {
        const reason = cleanText(request.body?.reason || "Assistance terminée", 500);
        const database = getPool();
        const connection = await database.connect();
        let session;
        let notifications;
        try {
            await connection.query("BEGIN");
            const { rows } = await connection.query(`${sessionSelect()}
                WHERE session.id=$1 AND session.created_by=$2 AND session.revoked_at IS NULL
                FOR UPDATE`, [validUuid(request.params.sessionId), request.user.sub]);
            session = rows[0];
            if (!session) {
                await connection.query("ROLLBACK");
                return response.status(404).json({ message: "Session d’assistance active introuvable." });
            }
            await connection.query("UPDATE depannhome_creator_support_sessions SET revoked_at=NOW(),revoked_by=$2,revoke_reason=$3,updated_at=NOW() WHERE id=$1", [session.id, request.user.sub, reason]);
            notifications = await insertCompanyNotifications(connection, session.target_company_owner_id, "support_assistance_closed", session.id, "Session d’assistance terminée", `Le Support Depann’Home Pro a fermé la session d’assistance. Motif de clôture : ${reason}`, { sessionId: session.id });
            await connection.query("COMMIT");
        } catch (error) {
            await connection.query("ROLLBACK");
            throw error;
        } finally {
            connection.release();
        }
        await safelyBroadcastCompanyNotifications(session.target_company_owner_id, notifications, session.id);
        response.status(204).end();
    }));

    app.post("/api/creator/assistance/sessions/:sessionId/actions", requireCreator, asyncHandler(async (request, response) => {
        const session = await activeSession(request.params.sessionId, request.user.sub);
        if (!session) return response.status(404).json({ message: "Session d’assistance absente, révoquée ou expirée." });
        const actionType = ACTION_TYPES.has(request.body?.actionType) ? request.body.actionType : "";
        const reason = cleanMultilineText(request.body?.reason, 1000);
        const targetId = cleanText(request.body?.targetId, 120);
        if (!actionType) return response.status(400).json({ message: "Action de récupération invalide." });
        if (reason.length < 10) return response.status(400).json({ message: "Justifiez cette réparation en au moins 10 caractères." });
        let action;
        try {
            action = await executeRecoveryAction(session, request.user.sub, actionType, targetId, reason);
        } catch (error) {
            await recordFailedAction(session, request.user.sub, actionType, targetId, reason, error);
            throw error;
        }
        response.json({ action, diagnostics: await loadDiagnostics(session.target_company_owner_id) });
    }));
}

async function executeRecoveryAction(session, creatorId, actionType, targetId, reason) {
    const database = getPool();
    const connection = await database.connect();
    const ownerId = Number(session.target_company_owner_id);
    let previousState = {};
    let newState = {};
    let resourceType = "company";
    let resourceId = String(ownerId);
    let action;
    let notifications;
    try {
        await connection.query("BEGIN");
        const { rows: sessions } = await connection.query(`${sessionSelect()}
            WHERE session.id=$1 AND session.created_by=$2 AND session.target_company_owner_id=$3
                AND session.accepted_at IS NOT NULL AND session.declined_at IS NULL
                AND session.revoked_at IS NULL AND session.expires_at>NOW()
            FOR UPDATE OF session`, [session.id, creatorId, ownerId]);
        const lockedSession = sessions[0];
        if (!lockedSession) throw clientError(409, "Cette session d’assistance a été révoquée ou a expiré.");
        const owner = await findCompanyOwner(connection, ownerId, true);
        if (!owner || isCreatorUsername(owner.username)) throw clientError(404, "Entreprise cliente introuvable.");
        if (actionType === "restore_company") {
            previousState = companyState(owner);
            if (!owner.is_archived) throw clientError(409, "Cette entreprise n’est pas archivée.");
            const result = await connection.query("UPDATE depannhome_users SET is_archived=FALSE,is_active=TRUE,archived_at=NULL,archived_by=NULL,updated_at=NOW() WHERE id=$1 RETURNING is_active,is_archived,updated_at", [ownerId]);
            newState = companyState(result.rows[0]);
            await connection.query("INSERT INTO depannhome_account_lifecycle_audit(account_owner_id,actor_id,action,reason) VALUES($1,$2,'restored',$3)", [ownerId, creatorId, reason]);
        } else if (actionType === "reactivate_company") {
            previousState = companyState(owner);
            if (owner.is_archived) throw clientError(409, "Restaurez d’abord l’entreprise archivée.");
            const result = await connection.query("UPDATE depannhome_users SET is_active=TRUE,updated_at=NOW() WHERE id=$1 RETURNING is_active,is_archived,updated_at", [ownerId]);
            newState = companyState(result.rows[0]);
        } else if (["reactivate_administrator", "reset_administrator_2fa"].includes(actionType)) {
            const memberId = positiveId(targetId);
            const member = memberId && (await connection.query(`SELECT id,username,full_name,role,is_active FROM depannhome_users WHERE id=$1 AND account_owner_id=$2 FOR UPDATE`, [memberId, ownerId])).rows[0];
            if (!member) throw clientError(404, "Compte utilisateur introuvable.");
            if (actionType === "reactivate_administrator" && member.role !== "admin") throw clientError(404, "Poste Admin introuvable.");
            if (actionType === "reset_administrator_2fa" && !WORKSTATION_2FA_RECOVERY_ROLES.has(member.role)) throw clientError(404, "Poste PC compatible avec la double authentification introuvable.");
            resourceType = "user"; resourceId = String(member.id);
            if (actionType === "reactivate_administrator") {
                if (Number(member.id) === ownerId) throw clientError(409, "Utilisez l’action de réactivation de l’entreprise pour son Poste Admin d’ancrage.");
                previousState = memberState(member);
                if (!member.is_active) await ensurePcSeatAvailable(connection, ownerId);
                const result = await connection.query("UPDATE depannhome_users SET is_active=TRUE,updated_at=NOW() WHERE id=$1 RETURNING id,username,full_name,role,is_active,updated_at", [member.id]);
                newState = memberState(result.rows[0]);
                await recordMemberAudit(connection, ownerId, creatorId, member, "creator_administrator_reactivated", { reason, supportSessionId: session.id });
            } else {
                const authenticators = await connection.query("SELECT id,status,confirmed_at FROM depannhome_company_totp_authenticators WHERE owner_id=$1 AND user_id=$2", [ownerId, member.id]);
                const devices = await connection.query(`SELECT device.id,device.status,device.device_type,device.session_id IS NOT NULL AS has_session FROM depannhome_auth_devices device JOIN depannhome_users account ON account.id=device.user_id WHERE device.user_id=$1 AND account.account_owner_id=$2`, [member.id, ownerId]);
                previousState = { authenticators: authenticators.rows, devices: devices.rows };
                await connection.query("DELETE FROM depannhome_company_totp_challenges WHERE owner_id=$1 AND user_id=$2", [ownerId, member.id]);
                await connection.query("DELETE FROM depannhome_company_totp_authenticators WHERE owner_id=$1 AND user_id=$2", [ownerId, member.id]);
                const resetDevices = await connection.query(`UPDATE depannhome_auth_devices device SET status=CASE WHEN device.device_type='desktop' THEN device.status ELSE 'rejected' END,session_id=NULL,verification_code_hash='',verification_code_expires_at=NULL,verification_attempts=0 FROM depannhome_users account WHERE device.user_id=account.id AND account.account_owner_id=$1 AND device.user_id=$2`, [ownerId, member.id]);
                newState = { authenticators: [], invalidatedDevices: resetDevices.rowCount };
                await recordMemberAudit(connection, ownerId, creatorId, member, "creator_workstation_2fa_reset", { reason, supportSessionId: session.id, role: member.role, invalidatedDevices: resetDevices.rowCount });
            }
        } else if (actionType === "revoke_company_sessions") {
            resourceType = "sessions"; resourceId = String(ownerId);
            const before = await connection.query(`SELECT COUNT(*)::int AS total,COUNT(*) FILTER(WHERE device.status='approved')::int AS approved FROM depannhome_auth_devices device JOIN depannhome_users member ON member.id=device.user_id WHERE member.account_owner_id=$1`, [ownerId]);
            previousState = before.rows[0];
            const result = await connection.query(`UPDATE depannhome_auth_devices device SET status=CASE WHEN member.role='admin' AND device.device_type='desktop' THEN device.status ELSE 'rejected' END,session_id=NULL,verification_code_hash='',verification_code_expires_at=NULL,verification_attempts=0 FROM depannhome_users member WHERE device.user_id=member.id AND member.account_owner_id=$1 AND (device.status<>'rejected' OR device.session_id IS NOT NULL)`, [ownerId]);
            newState = { invalidatedDevices: result.rowCount, administratorDesktopApprovalPreserved: true };
        } else if (actionType === "reject_device") {
            if (!validUuid(targetId)) throw clientError(400, "Appareil invalide.");
            resourceType = "device"; resourceId = targetId;
            const device = (await connection.query(`SELECT device.id,device.status,device.device_type,device.label,device.user_id FROM depannhome_auth_devices device JOIN depannhome_users member ON member.id=device.user_id WHERE device.id=$1 AND member.account_owner_id=$2 FOR UPDATE`, [targetId, ownerId])).rows[0];
            if (!device) throw clientError(404, "Appareil introuvable.");
            previousState = deviceState(device);
            const result = await connection.query("UPDATE depannhome_auth_devices SET status='rejected',session_id=NULL,verification_code_hash='',verification_code_expires_at=NULL,verification_attempts=0 WHERE id=$1 RETURNING id,status,device_type,label,user_id", [targetId]);
            newState = deviceState(result.rows[0]);
        } else if (actionType === "release_company_locks") {
            resourceType = "locks"; resourceId = String(ownerId);
            const locks = await connection.query("SELECT entity_type,entity_id,locked_by,expires_at FROM depannhome_collaboration_locks WHERE owner_id=$1", [ownerId]);
            previousState = { locks: locks.rows };
            const result = await connection.query("DELETE FROM depannhome_collaboration_locks WHERE owner_id=$1", [ownerId]);
            newState = { releasedLocks: result.rowCount };
        }
        const actionId = crypto.randomUUID();
        const { rows } = await connection.query(`INSERT INTO depannhome_creator_recovery_actions
            (id,support_session_id,created_by,target_company_owner_id,action_type,target_resource_type,target_resource_id,reason,previous_state,new_state,is_emergency,company_notified_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,NOW())
            RETURNING id,action_type AS "actionType",target_resource_type AS "targetResourceType",target_resource_id AS "targetResourceId",reason,previous_state AS "previousState",new_state AS "newState",status,is_emergency AS "isEmergency",created_at AS "createdAt"`,
        [actionId, lockedSession.id, creatorId, ownerId, actionType, resourceType, resourceId, reason, JSON.stringify(previousState), JSON.stringify(newState), lockedSession.mode === "emergency"]);
        action = rows[0];
        notifications = await insertCompanyNotifications(connection, ownerId, "creator_recovery_action", actionId, "Intervention du Support", `${actionLabel(actionType)}. Motif : ${reason}`, { actionId, sessionId: lockedSession.id, actionType, emergency: lockedSession.mode === "emergency" });
        await connection.query("COMMIT");
    } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
    } finally {
        connection.release();
    }
    await safelyBroadcastCompanyNotifications(ownerId, notifications, session.id);
    return action;
}

async function loadDiagnostics(ownerId) {
    const database = getPool();
    const [company, members, devices, locks, security, memberAudit, lifecycle, supportRequests, actions] = await Promise.all([
        database.query(`SELECT id,company_name AS "companyName",username,full_name AS "fullName",email,is_active AS "isActive",is_archived AS "isArchived",subscription_tier AS "subscriptionTier",subscription_status AS "subscriptionStatus",max_pc_users AS "maxPcUsers",max_technicians AS "maxMobileUsers",created_at AS "createdAt",updated_at AS "updatedAt" FROM depannhome_users WHERE id=$1 AND account_owner_id=id`, [ownerId]),
        database.query(`SELECT member.id,member.username,member.full_name AS "fullName",member.email,member.role,member.is_active AS "isActive",COUNT(authenticator.id) FILTER(WHERE authenticator.status='active')::int AS "activeAuthenticators" FROM depannhome_users member LEFT JOIN depannhome_company_totp_authenticators authenticator ON authenticator.user_id=member.id AND authenticator.owner_id=$1 WHERE member.account_owner_id=$1 GROUP BY member.id ORDER BY CASE WHEN member.role='admin' THEN 0 ELSE 1 END,LOWER(member.full_name),member.username`, [ownerId]),
        database.query(`SELECT device.id,device.user_id AS "userId",member.full_name AS "userName",member.username,device.label,device.device_type AS "deviceType",device.status,device.approved_at AS "approvedAt",device.last_seen_at AS "lastSeenAt",device.created_at AS "createdAt",device.session_id IS NOT NULL AS "hasSession" FROM depannhome_auth_devices device JOIN depannhome_users member ON member.id=device.user_id WHERE member.account_owner_id=$1 ORDER BY device.last_seen_at DESC LIMIT 100`, [ownerId]),
        database.query(`SELECT lock.entity_type AS "entityType",lock.entity_id AS "entityId",lock.locked_by AS "lockedBy",member.full_name AS "userName",member.username,lock.device_type AS "deviceType",lock.locked_at AS "lockedAt",lock.last_activity_at AS "lastActivityAt",lock.expires_at AS "expiresAt" FROM depannhome_collaboration_locks lock LEFT JOIN depannhome_users member ON member.id=lock.locked_by WHERE lock.owner_id=$1 AND lock.expires_at>NOW() ORDER BY lock.expires_at`, [ownerId]),
        database.query(`SELECT event_type AS "eventType",outcome,details,created_at AS "createdAt" FROM depannhome_security_events WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 50`, [ownerId]),
        database.query(`SELECT audit.action,audit.target_username AS "targetUsername",audit.target_full_name AS "targetFullName",audit.details,audit.created_at AS "createdAt",actor.full_name AS "actorName",actor.username AS "actorUsername" FROM depannhome_member_audit audit LEFT JOIN depannhome_users actor ON actor.id=audit.actor_id WHERE audit.owner_id=$1 ORDER BY audit.created_at DESC LIMIT 50`, [ownerId]),
        database.query(`SELECT audit.action,audit.reason,audit.created_at AS "createdAt",actor.full_name AS "actorName",actor.username AS "actorUsername" FROM depannhome_account_lifecycle_audit audit LEFT JOIN depannhome_users actor ON actor.id=audit.actor_id WHERE audit.account_owner_id=$1 ORDER BY audit.created_at DESC LIMIT 30`, [ownerId]),
        database.query(`SELECT id,status,message,created_at AS "createdAt" FROM depannhome_support_requests WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 20`, [ownerId]),
        database.query(`SELECT action.id,action.action_type AS "actionType",action.target_resource_type AS "targetResourceType",action.target_resource_id AS "targetResourceId",action.reason,action.status,action.error_message AS "errorMessage",action.is_emergency AS "isEmergency",action.created_at AS "createdAt",creator.full_name AS "creatorName",creator.username AS "creatorUsername" FROM depannhome_creator_recovery_actions action LEFT JOIN depannhome_users creator ON creator.id=action.created_by WHERE action.target_company_owner_id=$1 ORDER BY action.created_at DESC LIMIT 50`, [ownerId])
    ]);
    const policy = await database.query("SELECT enabled,enabled_at AS \"enabledAt\",updated_at AS \"updatedAt\" FROM depannhome_company_totp_policies WHERE owner_id=$1", [ownerId]);
    return { company: company.rows[0] || null, twoFactorPolicy: policy.rows[0] || { enabled: false }, members: members.rows, devices: devices.rows, locks: locks.rows, securityEvents: security.rows, memberAudit: memberAudit.rows, lifecycle: lifecycle.rows, supportRequests: supportRequests.rows, recoveryActions: actions.rows };
}

async function activeSession(id, creatorId) {
    if (!validUuid(id)) return null;
    const { rows } = await getPool().query(`${sessionSelect()} WHERE session.id=$1 AND session.created_by=$2 AND (session.mode='emergency' OR session.accepted_at IS NOT NULL) AND session.declined_at IS NULL AND session.revoked_at IS NULL AND session.expires_at>NOW()`, [id, creatorId]);
    return rows[0] || null;
}

function sessionSelect() {
    return `SELECT session.id,session.created_by AS "createdBy",session.target_company_owner_id AS "companyOwnerId",session.target_company_owner_id,session.mode,session.access_scope AS "accessScope",session.reason,session.support_request_id AS "supportRequestId",session.consent_basis AS "consentBasis",session.expires_at AS "expiresAt",session.accepted_at AS "acceptedAt",session.accepted_by AS "acceptedBy",session.declined_at AS "declinedAt",session.declined_by AS "declinedBy",session.revoked_at AS "revokedAt",session.revoke_reason AS "revokeReason",session.created_at AS "createdAt",COALESCE(NULLIF(owner.company_name,''),owner.full_name,owner.username) AS "companyName" FROM depannhome_creator_support_sessions session JOIN depannhome_users owner ON owner.id=session.target_company_owner_id`;
}

async function findCompanyOwner(database, id, lock = false) {
    const { rows } = await database.query(`SELECT id,username,company_name AS "companyName",full_name AS "fullName",is_active,is_archived,max_pc_users FROM depannhome_users WHERE id=$1 AND account_owner_id=id${lock ? " FOR UPDATE" : ""}`, [id]);
    return rows[0] || null;
}

async function ensurePcSeatAvailable(database, ownerId) {
    const seats = await companySeatState(database, ownerId);
    if (!seats || Number(seats.activePcUsers) >= Number(seats.maxPcUsers)) throw clientError(409, "La limite de postes administratifs est atteinte.");
}

async function recordMemberAudit(database, ownerId, creatorId, member, action, details) {
    await database.query(`INSERT INTO depannhome_member_audit(owner_id,actor_id,target_user_id,target_username,target_full_name,action,details) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`, [ownerId, creatorId, member.id, cleanText(member.username, 32), cleanText(member.full_name, 100), action, JSON.stringify(details)]);
}

async function recordFailedAction(session, creatorId, actionType, targetId, reason, error) {
    try {
        await getPool().query(`INSERT INTO depannhome_creator_recovery_actions(id,support_session_id,created_by,target_company_owner_id,action_type,target_resource_type,target_resource_id,reason,status,error_message,is_emergency) VALUES($1,$2,$3,$4,$5,'',$6,$7,'failed',$8,$9)`, [crypto.randomUUID(), session.id, creatorId, session.target_company_owner_id, actionType, targetId, reason, cleanText(error?.message || "Échec de l’action", 500), session.mode === "emergency"]);
    } catch (auditError) {
        console.error("[creator-assistance] failed action audit unavailable", { sessionId: session.id, actionType, code: auditError.code || auditError.name || "AUDIT_ERROR" });
    }
}

async function insertCompanyNotifications(database, ownerId, eventType, entityId, title, body, payload) {
    const { rows } = await database.query("SELECT id FROM depannhome_users WHERE account_owner_id=$1 AND role='admin' AND is_active=TRUE", [ownerId]);
    const recipientIds = rows.length ? rows.map(row => row.id) : [ownerId];
    const notifications = [];
    for (const recipientId of recipientIds) {
        const result = await database.query(`INSERT INTO depannhome_collaboration_notifications(owner_id,recipient_id,event_type,entity_type,entity_id,title,body,payload) VALUES($1,$2,$3,'creator_assistance',$4,$5,$6,$7::jsonb) RETURNING id,created_at AS "createdAt"`, [ownerId, recipientId, eventType, String(entityId), cleanText(title, 200), cleanText(body, 2000), JSON.stringify(payload)]);
        notifications.push({ recipientId: String(recipientId), notification: { id: result.rows[0].id, eventType, entityType: "creator_assistance", entityId: String(entityId), title, body, payload, createdAt: result.rows[0].createdAt } });
    }
    return notifications;
}

async function safelyInsertCompanyNotifications(ownerId, eventType, entityId, title, body, payload) {
    const database = getPool();
    let notifications = [];
    try {
        notifications = await insertCompanyNotifications(database, ownerId, eventType, entityId, title, body, payload);
    } catch (error) {
        console.error("[creator-assistance] local company notification unavailable", { sessionId: entityId, code: error.code || error.name || "NOTIFICATION_ERROR" });
    }
    try {
        const { rows } = await database.query(`SELECT DISTINCT administrator.user_id AS id
            FROM depannhome_group_companies company
            JOIN depannhome_group_administrators administrator ON administrator.group_id=company.group_id
            JOIN depannhome_users principal ON principal.id=administrator.user_id AND principal.is_active=TRUE
            WHERE company.company_owner_id=$1 AND company.is_active=TRUE
                AND administrator.user_id NOT IN (SELECT id FROM depannhome_users WHERE account_owner_id=$1 AND role='admin' AND is_active=TRUE)`, [ownerId]);
        for (const recipient of rows) {
            const result = await database.query(`INSERT INTO depannhome_collaboration_notifications(owner_id,recipient_id,event_type,entity_type,entity_id,title,body,payload) VALUES($1,$2,$3,'creator_assistance',$4,$5,$6,$7::jsonb) RETURNING id,created_at AS "createdAt"`, [ownerId, recipient.id, eventType, String(entityId), cleanText(title, 200), cleanText(body, 2000), JSON.stringify(payload)]);
            notifications.push({ recipientId: String(recipient.id), notification: { id: result.rows[0].id, eventType, entityType: "creator_assistance", entityId: String(entityId), title, body, payload, createdAt: result.rows[0].createdAt } });
        }
    } catch (error) {
        console.error("[creator-assistance] principal group notification unavailable", { sessionId: entityId, code: error.code || error.name || "NOTIFICATION_ERROR" });
    }
    return notifications;
}

async function broadcastCompanyNotifications(ownerId, notifications) {
    await Promise.all(notifications.map(notification => broadcastOwnerEvent(ownerId, "notification", notification)));
}

async function safelyBroadcastCompanyNotifications(ownerId, notifications, sessionId) {
    try {
        await broadcastCompanyNotifications(ownerId, notifications);
    } catch (error) {
        console.error("[creator-assistance] notification broadcast unavailable", { sessionId, code: error.code || error.name || "BROADCAST_ERROR" });
    }
}

async function safelyBroadcastCreatorDecision(creatorId, sessionId, decision) {
    try {
        const { rows } = await getPool().query("SELECT account_owner_id AS \"ownerId\" FROM depannhome_users WHERE id=$1", [creatorId]);
        const ownerId = rows[0]?.ownerId || creatorId;
        await broadcastOwnerEvent(String(ownerId), "creator_assistance_decision", { recipientId: String(creatorId), sessionId, decision });
    } catch (error) {
        console.error("[creator-assistance] creator decision broadcast unavailable", { sessionId, code: error.code || error.name || "BROADCAST_ERROR" });
    }
}

function publicSession(session) {
    const accepted = session.mode === "emergency" || Boolean(session.acceptedAt);
    const expired = new Date(session.expiresAt).getTime() <= Date.now();
    return { id: session.id, companyOwnerId: String(session.companyOwnerId || session.target_company_owner_id), companyName: session.companyName || "Entreprise", mode: session.mode, accessScope: session.accessScope || "diagnostic", reason: session.reason, supportRequestId: session.supportRequestId ? String(session.supportRequestId) : "", consentBasis: session.consentBasis, expiresAt: session.expiresAt, acceptedAt: session.acceptedAt || null, declinedAt: session.declinedAt || null, revokedAt: session.revokedAt || null, revokeReason: session.revokeReason || "", createdAt: session.createdAt, awaitingConsent: !accepted && !session.declinedAt && !session.revokedAt && !expired, active: accepted && !session.declinedAt && !session.revokedAt && !expired };
}

async function recordSupportActivity(sessionId, creatorId, ownerId, method, path, statusCode, outcome) {
    if (!validUuid(sessionId)) return;
    try {
        await getPool().query(`INSERT INTO depannhome_creator_support_activity(support_session_id,creator_id,target_company_owner_id,method,path,status_code,outcome)
            VALUES($1,$2,$3,$4,$5,$6,$7)`, [sessionId, creatorId, ownerId, cleanText(method, 10), cleanText(path, 300), Number(statusCode) || 0, outcome]);
    } catch (error) {
        console.error("[creator-assistance] support activity audit unavailable", { sessionId, code: error.code || error.name || "AUDIT_ERROR" });
    }
}

async function createPendingSupportActivity(sessionId, creatorId, ownerId, method, path) {
    const { rows } = await getPool().query(`INSERT INTO depannhome_creator_support_activity(support_session_id,creator_id,target_company_owner_id,method,path,status_code,outcome)
        VALUES($1,$2,$3,$4,$5,0,'pending') RETURNING id`, [sessionId, creatorId, ownerId, cleanText(method, 10), cleanText(path, 300)]);
    const activityId = Number(rows[0]?.id) || 0;
    if (!activityId) throw new Error("Journal de prise en main introuvable");
    return activityId;
}

async function completeSupportActivity(activityId, statusCode, outcome) {
    try {
        await getPool().query("UPDATE depannhome_creator_support_activity SET status_code=$2,outcome=$3 WHERE id=$1", [activityId, Number(statusCode) || 0, outcome]);
    } catch (error) {
        console.error("[creator-assistance] support audit completion unavailable", { activityId, code: error.code || error.name || "AUDIT_ERROR" });
    }
}

function companyState(value) { return { isActive: Boolean(value?.is_active), isArchived: Boolean(value?.is_archived), updatedAt: value?.updated_at || null }; }
function memberState(value) { return { id: String(value.id), username: value.username, fullName: value.full_name || value.fullName || "", role: value.role, isActive: Boolean(value.is_active ?? value.isActive), updatedAt: value.updated_at || null }; }
function deviceState(value) { return { id: value.id, userId: String(value.user_id), label: value.label || "", deviceType: value.device_type, status: value.status }; }
function actionLabel(value) { return ({ restore_company: "Entreprise restaurée", reactivate_company: "Entreprise réactivée", reactivate_administrator: "Poste Admin réactivé", reset_administrator_2fa: "Double authentification du poste PC réinitialisée", revoke_company_sessions: "Sessions de l’entreprise révoquées", reject_device: "Appareil révoqué", release_company_locks: "Verrous de l’entreprise libérés" })[value] || "Intervention réalisée"; }
function validUuid(value) { const id = String(value || ""); return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ? id : ""; }
function positiveId(value) { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : 0; }
function cleanText(value, max) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, max); }
function cleanMultilineText(value, max) { return String(value || "").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim().slice(0, max); }
function clientError(status, message) { const error = new Error(message); error.status = status; return error; }
function asyncHandler(handler) { return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next); }
