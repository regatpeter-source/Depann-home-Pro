import { sendSupportRequestEmail } from "./email.js";
import { getPool } from "./database.js";
import { isCreatorUsername } from "./auth.js";
import { createNotification } from "./collaboration.js";

const MAX_SUPPORT_MESSAGE_LENGTH = 4000;
const SUPPORT_STATUSES = new Set(["new", "under_review", "answered", "closed"]);

export async function initializeSupport() {
    await getPool().query(`
        CREATE TABLE IF NOT EXISTS depannhome_support_requests (
            id BIGSERIAL PRIMARY KEY,
            owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            requested_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
            sender_name VARCHAR(100) NOT NULL DEFAULT '',
            sender_email VARCHAR(160) NOT NULL DEFAULT '',
            sender_username VARCHAR(32) NOT NULL DEFAULT '',
            message VARCHAR(4000) NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'new' CHECK (status IN ('new','under_review','answered','closed')),
            creator_note VARCHAR(2000) NOT NULL DEFAULT '',
            handled_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
            handled_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await getPool().query("CREATE INDEX IF NOT EXISTS depannhome_support_requests_status_created_idx ON depannhome_support_requests(status,created_at DESC)");
}

export function registerSupportRoutes(app, requireAuthentication) {
    app.post("/api/support/requests", requireAuthentication, asyncHandler(async (request, response) => {
        const message = cleanMessage(request.body?.message);
        if (message.length < 10) {
            return response.status(400).json({ message: "Décrivez votre demande en au moins 10 caractères." });
        }

        const senderName = cleanText(request.user?.fullName, 100);
        const senderEmail = cleanText(request.user?.email, 160);
        const senderUsername = cleanText(request.user?.username, 32);
        const { rows } = await getPool().query(`INSERT INTO depannhome_support_requests(owner_id,requested_by,sender_name,sender_email,sender_username,message) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [request.user.accountOwnerId, request.user.sub, senderName, senderEmail, senderUsername, message]);
        await notifyCreators(rows[0].id, request.user.accountOwnerId, senderName || senderUsername, message);
        try { await sendSupportRequestEmail({ senderName, senderEmail, senderUsername, message }); } catch (error) { console.warn("[support-request] email unavailable", { requestId: rows[0].id, code: error.code || "EMAIL_ERROR" }); }
        response.status(202).json({ message: "Votre message est enregistré et transmis au Support." });
    }));

    app.get("/api/creator/support-requests", requireAuthentication, asyncHandler(async (request, response) => {
        if (!request.user?.isCreator) return response.status(403).json({ message: "Accès réservé au Créateur." });
        const { rows } = await getPool().query(`SELECT support.id,support.owner_id AS "ownerId",COALESCE(NULLIF(profile.company_name,''),NULLIF(owner.company_name,''),owner.full_name,owner.username) AS "companyName",support.sender_name AS "senderName",support.sender_email AS "senderEmail",support.sender_username AS "senderUsername",support.message,support.status,support.creator_note AS "creatorNote",support.created_at AS "createdAt",support.updated_at AS "updatedAt" FROM depannhome_support_requests support JOIN depannhome_users owner ON owner.id=support.owner_id LEFT JOIN depannhome_billing_profiles profile ON profile.owner_id=owner.id ORDER BY CASE support.status WHEN 'new' THEN 0 WHEN 'under_review' THEN 1 ELSE 2 END,support.created_at DESC LIMIT 200`);
        response.json({ requests: rows });
    }));

    app.patch("/api/creator/support-requests/:requestId", requireAuthentication, asyncHandler(async (request, response) => {
        if (!request.user?.isCreator) return response.status(403).json({ message: "Accès réservé au Créateur." });
        const requestId = positiveId(request.params.requestId);
        const status = SUPPORT_STATUSES.has(request.body?.status) ? request.body.status : "";
        const creatorNote = cleanText(request.body?.creatorNote, 2000);
        if (!requestId || !status) return response.status(400).json({ message: "Suivi Support invalide." });
        const handled = ["answered", "closed"].includes(status);
        const { rows } = await getPool().query(`UPDATE depannhome_support_requests SET status=$2,creator_note=$3,handled_by=CASE WHEN $4::boolean THEN $5::bigint ELSE NULL::bigint END,handled_at=CASE WHEN $4::boolean THEN NOW() ELSE NULL::timestamptz END,updated_at=NOW() WHERE id=$1 RETURNING id,status`, [requestId, status, creatorNote, handled, request.user.sub]);
        if (!rows[0]) return response.status(404).json({ message: "Demande Support introuvable." });
        response.json({ request: rows[0] });
    }));
}

async function notifyCreators(requestId, ownerId, sender, message) {
    const { rows } = await getPool().query("SELECT id,account_owner_id AS \"ownerId\",username FROM depannhome_users WHERE is_active=TRUE");
    const creators = rows.filter(account => isCreatorUsername(account.username));
    await Promise.all(creators.map(account => createNotification(account.ownerId || account.id, account.id, "support_request_received", { entityType: "support_request", entityId: String(requestId) }, "Nouvelle demande Support", `${sender || "Entreprise"} · ${cleanText(message, 180)}`, { requestId: String(requestId), companyOwnerId: String(ownerId) })));
}

function positiveId(value) { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : 0; }

function cleanMessage(value) {
    return String(value || "").replace(/\r\n/g, "\n").trim().slice(0, MAX_SUPPORT_MESSAGE_LENGTH);
}

function cleanText(value, maximumLength) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximumLength);
}

function asyncHandler(handler) {
    return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}