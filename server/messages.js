import { getPool } from "./database.js";
import { getAccountOwnerId } from "./auth.js";
import { createNotification } from "./collaboration.js";

const MAX_MESSAGE_LENGTH = 2000;
const CLIENT_ID_PATTERN = /^client-[a-zA-Z0-9-]+$/;

export async function initializeMessages() {
    const database = getPool();
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_messages (
            id BIGSERIAL PRIMARY KEY,
            sender_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            recipient_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            client_id VARCHAR(100) NOT NULL,
            body VARCHAR(${MAX_MESSAGE_LENGTH}) NOT NULL,
            read_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await database.query(`
        ALTER TABLE depannhome_messages
        ADD COLUMN IF NOT EXISTS client_id VARCHAR(100),
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    `);
    await database.query("DELETE FROM depannhome_messages WHERE client_id IS NULL OR BTRIM(client_id) = ''");
    await database.query("ALTER TABLE depannhome_messages ALTER COLUMN client_id SET NOT NULL");
    await database.query(`
        ALTER TABLE depannhome_messages
        DROP CONSTRAINT IF EXISTS depannhome_messages_distinct_accounts
    `);
    await database.query(`
        CREATE INDEX IF NOT EXISTS depannhome_messages_recipient_idx
        ON depannhome_messages (recipient_id, created_at DESC)
    `);
    await database.query(`
        CREATE INDEX IF NOT EXISTS depannhome_messages_sender_idx
        ON depannhome_messages (sender_id, created_at DESC)
    `);
    await database.query(`
        CREATE INDEX IF NOT EXISTS depannhome_messages_client_idx
        ON depannhome_messages (recipient_id, client_id, created_at DESC)
    `);
}

export function registerMessageRoutes(app, requireAuthentication) {
    app.use("/api/messages", requireAuthentication, requireMessageAccess);
    app.get("/api/messages/unread-summary", requireAuthentication, asyncHandler(async (request, response) => {
        const { rows } = await getPool().query(`
            SELECT message.client_id AS "clientId", message.sender_id AS "senderId", message.created_at AS "createdAt"
            FROM depannhome_messages message
            JOIN depannhome_clients client
                ON client.owner_id = message.recipient_id AND client.client_id = message.client_id
            WHERE message.recipient_id = $1 AND message.client_id IS NOT NULL
            ORDER BY message.created_at DESC
            LIMIT 1000
        `, [getAccountOwnerId(request)]);
        response.json({ messages: rows });
    }));

    app.get("/api/messages", requireAuthentication, asyncHandler(async (request, response) => {
        const clientId = optionalClientId(request.query?.clientId);
        if (request.query?.clientId && !clientId) return response.status(400).json({ message: "Dossier client invalide." });
        if (!clientId) return response.status(403).json({ message: "Les notes sont accessibles depuis une fiche client." });
        if (clientId && !await clientExists(getAccountOwnerId(request), clientId)) return response.status(404).json({ message: "Dossier client introuvable." });
        const { rows } = await getPool().query(`
            SELECT message.id, message.body, message.client_id AS "clientId", message.sender_id AS "senderId",
                message.created_at AS "createdAt", message.updated_at AS "updatedAt",
                sender.full_name AS "senderName", sender.username AS "senderUsername"
            FROM depannhome_messages message
            JOIN depannhome_users sender ON sender.id = message.sender_id
            WHERE message.recipient_id = $1
              AND message.client_id = $2
            ORDER BY message.created_at DESC
            LIMIT 300
        `, [getAccountOwnerId(request), clientId]);
        response.json({ messages: rows });
    }));

    app.post("/api/messages", requireAuthentication, asyncHandler(async (request, response) => {
        const body = cleanMessage(request.body?.body);
        const clientId = optionalClientId(request.body?.clientId);
        if (!body) return response.status(400).json({ message: "La note ne peut pas être vide." });
        if (request.body?.clientId && !clientId) return response.status(400).json({ message: "Dossier client invalide." });
        if (!clientId) return response.status(403).json({ message: "Les notes doivent être ajoutées depuis une fiche client." });
        const ownerId = getAccountOwnerId(request);
        if (!await clientExists(ownerId, clientId, true)) return response.status(404).json({ message: "Dossier client introuvable ou archivé." });
        const note = await createClientMessage({ ownerId, senderId: request.user.sub, clientId, body });
        response.status(201).json({ note });
    }));

    app.patch("/api/messages/:messageId", requireAuthentication, asyncHandler(async (request, response) => {
        const messageId = positiveId(request.params.messageId);
        const body = cleanMessage(request.body?.body);
        if (!messageId || !body) return response.status(400).json({ message: "Note invalide." });
        const { rowCount } = await getPool().query(`
            UPDATE depannhome_messages SET body = $4, updated_at = NOW()
            WHERE id = $1 AND recipient_id = $2 AND sender_id = $3 AND client_id IS NOT NULL
        `, [messageId, getAccountOwnerId(request), request.user.sub, body]);
        if (!rowCount) return response.status(403).json({ message: "Vous pouvez modifier uniquement vos propres notes." });
        response.status(204).end();
    }));
}

export async function createClientMessage({ ownerId, senderId, clientId, body, appointmentId = null }) {
    const normalizedClientId = optionalClientId(clientId);
    const normalizedBody = cleanMessage(body);
    if (!ownerId || !senderId || !normalizedClientId || !normalizedBody) throw new Error("Note client invalide.");
    const { rows } = await getPool().query(`
        INSERT INTO depannhome_messages (sender_id, recipient_id, client_id, body)
        VALUES ($1, $2, $3, $4)
        RETURNING id, created_at AS "createdAt", updated_at AS "updatedAt"
    `, [senderId, ownerId, normalizedClientId, normalizedBody]);
    await notifyInternalMessageRecipients(ownerId, senderId, normalizedClientId, rows[0].id, normalizedBody, appointmentId);
    return rows[0];
}

async function notifyInternalMessageRecipients(ownerId, senderId, clientId, messageId, body, appointmentId) {
    const { rows } = await getPool().query(`
        SELECT account.id, COALESCE(client.client_data->>'name', '') AS "clientName"
        FROM depannhome_users account
        JOIN depannhome_clients client ON client.owner_id = $1 AND client.client_id = $3
        WHERE (account.id = $1 OR account.account_owner_id = $1)
          AND account.id <> $2
          AND account.is_active = TRUE
          AND account.role IN ('admin', 'pc_standard', 'mobile_admin', 'team_lead', 'technician')
    `, [ownerId, senderId, clientId]);
    await Promise.all(rows.map(recipient => createNotification(
        ownerId,
        recipient.id,
        "client_message_received",
        { entityType: "client", entityId: clientId },
        `Nouvelle note · ${recipient.clientName || "Dossier client"}`,
        body,
        { clientId, messageId: String(messageId), ...(appointmentId ? { appointmentId: String(appointmentId) } : {}) }
    )));
}

function requireMessageAccess(request, response, next) {
    if (request.user?.role === "accountant") return response.status(403).json({ message: "L’espace comptabilité ne donne pas accès aux notes clients." });
    return next();
}

async function clientExists(accountOwnerId, clientId, activeOnly = false) {
    const { rowCount } = await getPool().query(
        "SELECT 1 FROM depannhome_clients WHERE owner_id = $1 AND client_id = $2 AND ($3::boolean = FALSE OR client_status = 'active')",
        [accountOwnerId, clientId, activeOnly]
    );
    return Boolean(rowCount);
}

function optionalClientId(value) {
    const clientId = String(value || "");
    return CLIENT_ID_PATTERN.test(clientId) ? clientId : "";
}

function positiveId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function cleanMessage(value) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE_LENGTH);
}

function asyncHandler(handler) {
    return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}
