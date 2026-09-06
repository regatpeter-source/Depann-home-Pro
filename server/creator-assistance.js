import crypto from "node:crypto";
import { getPool } from "./database.js";
import { isCreatorUsername } from "./auth.js";
import { broadcastOwnerEvent } from "./collaboration.js";

const NORMAL_SESSION_MINUTES = 30;
const EMERGENCY_SESSION_MINUTES = 10;
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

export async function initializeCreatorAssistance() {
    const database = getPool();
    await database.query(`CREATE TABLE IF NOT EXISTS depannhome_creator_support_sessions (
        id UUID PRIMARY KEY,
        created_by BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE RESTRICT,
        target_company_owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
        mode VARCHAR(20) NOT NULL DEFAULT 'readonly' CHECK (mode IN ('readonly','emergency')),
        reason VARCHAR(1000) NOT NULL,
        support_request_id BIGINT REFERENCES depannhome_support_requests(id) ON DELETE SET NULL,
        consent_basis VARCHAR(30) NOT NULL CHECK (consent_basis IN ('support_request','confirmed','emergency')),
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        revoked_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
        revoke_reason VARCHAR(500) NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_creator_support_sessions_creator_idx ON depannhome_creator_support_sessions(created_by,created_at DESC)");
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_creator_support_sessions_company_idx ON depannhome_creator_support_sessions(target_company_owner_id,created_at DESC)");
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_creator_support_sessions_active_idx ON depannhome_creator_support_sessions(expires_at) WHERE revoked_at IS NULL");
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

export function registerCreatorAssistanceRoutes(app, requireCreator) {
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
        const duration = emergency ? EMERGENCY_SESSION_MINUTES : NORMAL_SESSION_MINUTES;
        const database = getPool();
        const connection = await database.connect();
        let rows;
        let notifications;
        try {
            await connection.query("BEGIN");
            ({ rows } = await connection.query(`INSERT INTO depannhome_creator_support_sessions
                (id,created_by,target_company_owner_id,mode,reason,support_request_id,consent_basis,expires_at)
                VALUES($1,$2,$3,$4,$5,$6,$7,NOW()+($8::text||' minutes')::interval)
                RETURNING id,created_by AS "createdBy",target_company_owner_id AS "companyOwnerId",mode,reason,support_request_id AS "supportRequestId",consent_basis AS "consentBasis",expires_at AS "expiresAt",revoked_at AS "revokedAt",created_at AS "createdAt"`,
            [id, request.user.sub, companyOwnerId, emergency ? "emergency" : "readonly", reason, supportRequestId, consentBasis, duration]));
            notifications = await insertCompanyNotifications(connection, companyOwnerId, "creator_support_session_started", id, emergency ? "Assistance d’urgence ouverte" : "Session d’assistance ouverte", emergency ? `Une session d’urgence de ${duration} minutes a été ouverte par le Support. Motif : ${reason}` : `Une session d’assistance en lecture seule de ${duration} minutes a été ouverte. Motif : ${reason}`, { sessionId: id, emergency, expiresAt: rows[0].expiresAt });
            await connection.query("COMMIT");
        } catch (error) {
            await connection.query("ROLLBACK");
            throw error;
        } finally {
            connection.release();
        }
        await safelyBroadcastCompanyNotifications(companyOwnerId, notifications, id);
        response.status(201).json({ session: publicSession({ ...rows[0], companyName: owner.companyName }) });
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
            notifications = await insertCompanyNotifications(connection, session.target_company_owner_id, "creator_support_session_closed", session.id, "Session d’assistance terminée", `Le Support a fermé la session d’assistance. Motif de clôture : ${reason}`, { sessionId: session.id });
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
        [actionId, session.id, creatorId, ownerId, actionType, resourceType, resourceId, reason, JSON.stringify(previousState), JSON.stringify(newState), session.mode === "emergency"]);
        action = rows[0];
        notifications = await insertCompanyNotifications(connection, ownerId, "creator_recovery_action", actionId, "Intervention du Support", `${actionLabel(actionType)}. Motif : ${reason}`, { actionId, sessionId: session.id, actionType, emergency: session.mode === "emergency" });
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
    const { rows } = await getPool().query(`${sessionSelect()} WHERE session.id=$1 AND session.created_by=$2 AND session.revoked_at IS NULL AND session.expires_at>NOW()`, [id, creatorId]);
    return rows[0] || null;
}

function sessionSelect() {
    return `SELECT session.id,session.created_by AS "createdBy",session.target_company_owner_id AS "companyOwnerId",session.target_company_owner_id,session.mode,session.reason,session.support_request_id AS "supportRequestId",session.consent_basis AS "consentBasis",session.expires_at AS "expiresAt",session.revoked_at AS "revokedAt",session.revoke_reason AS "revokeReason",session.created_at AS "createdAt",COALESCE(NULLIF(owner.company_name,''),owner.full_name,owner.username) AS "companyName" FROM depannhome_creator_support_sessions session JOIN depannhome_users owner ON owner.id=session.target_company_owner_id`;
}

async function findCompanyOwner(database, id, lock = false) {
    const { rows } = await database.query(`SELECT id,username,company_name AS "companyName",full_name AS "fullName",is_active,is_archived,max_pc_users FROM depannhome_users WHERE id=$1 AND account_owner_id=id${lock ? " FOR UPDATE" : ""}`, [id]);
    return rows[0] || null;
}

async function ensurePcSeatAvailable(database, ownerId) {
    const { rows } = await database.query(`SELECT owner.max_pc_users AS maximum,COUNT(member.id) FILTER(WHERE member.is_active AND member.role IN ('admin','pc_standard','commercial','accountant'))::int AS active FROM depannhome_users owner LEFT JOIN depannhome_users member ON member.account_owner_id=owner.id WHERE owner.id=$1 GROUP BY owner.id`, [ownerId]);
    if (!rows[0] || Number(rows[0].active) >= Number(rows[0].maximum)) throw clientError(409, "La limite de postes administratifs est atteinte.");
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

function publicSession(session) {
    return { id: session.id, companyOwnerId: String(session.companyOwnerId || session.target_company_owner_id), companyName: session.companyName || "Entreprise", mode: session.mode, reason: session.reason, supportRequestId: session.supportRequestId ? String(session.supportRequestId) : "", consentBasis: session.consentBasis, expiresAt: session.expiresAt, revokedAt: session.revokedAt || null, revokeReason: session.revokeReason || "", createdAt: session.createdAt, active: !session.revokedAt && new Date(session.expiresAt).getTime() > Date.now() };
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
