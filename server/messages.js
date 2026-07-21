import { getPool } from "./database.js";

const MAX_MESSAGE_LENGTH = 2000;

export async function initializeMessages() {
    const database = getPool();
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_messages (
            id BIGSERIAL PRIMARY KEY,
            sender_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            recipient_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            body VARCHAR(${MAX_MESSAGE_LENGTH}) NOT NULL,
            read_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT depannhome_messages_distinct_accounts CHECK (sender_id <> recipient_id)
        )
    `);
    await database.query(`
        CREATE INDEX IF NOT EXISTS depannhome_messages_recipient_idx
        ON depannhome_messages (recipient_id, created_at DESC)
    `);
    await database.query(`
        CREATE INDEX IF NOT EXISTS depannhome_messages_sender_idx
        ON depannhome_messages (sender_id, created_at DESC)
    `);
}

export function registerMessageRoutes(app, requireAuthentication) {
    app.get("/api/messages", requireAuthentication, asyncHandler(async (request, response) => {
        const database = getPool();
        const [usersResult, messagesResult] = await Promise.all([
            database.query(`SELECT id, username FROM depannhome_users WHERE id <> $1 ORDER BY LOWER(username)`, [request.user.sub]),
            database.query(`
                SELECT message.id, message.body, message.sender_id AS "senderId", message.recipient_id AS "recipientId",
                    message.read_at AS "readAt", message.created_at AS "createdAt", sender.username AS "senderName",
                    recipient.username AS "recipientName"
                FROM depannhome_messages message
                JOIN depannhome_users sender ON sender.id = message.sender_id
                JOIN depannhome_users recipient ON recipient.id = message.recipient_id
                WHERE message.sender_id = $1 OR message.recipient_id = $1
                ORDER BY message.created_at DESC
                LIMIT 300
            `, [request.user.sub])
        ]);
        response.json({ users: usersResult.rows, messages: messagesResult.rows, currentUserId: Number(request.user.sub) });
    }));

    app.post("/api/messages", requireAuthentication, asyncHandler(async (request, response) => {
        const recipientId = positiveId(request.body?.recipientId);
        const body = cleanMessage(request.body?.body);
        if (!recipientId || recipientId === Number(request.user.sub)) return response.status(400).json({ message: "Choisissez un autre destinataire." });
        if (!body) return response.status(400).json({ message: "Le message ne peut pas être vide." });
        const recipient = await getPool().query("SELECT id FROM depannhome_users WHERE id = $1", [recipientId]);
        if (!recipient.rowCount) return response.status(404).json({ message: "Destinataire introuvable." });
        const { rows } = await getPool().query(`
            INSERT INTO depannhome_messages (sender_id, recipient_id, body)
            VALUES ($1, $2, $3)
            RETURNING id, created_at AS "createdAt"
        `, [request.user.sub, recipientId, body]);
        response.status(201).json({ message: rows[0] });
    }));

    app.put("/api/messages/:messageId/read", requireAuthentication, asyncHandler(async (request, response) => {
        const id = positiveId(request.params.messageId);
        if (!id) return response.status(400).json({ message: "Message invalide." });
        const result = await getPool().query(`
            UPDATE depannhome_messages SET read_at = COALESCE(read_at, NOW())
            WHERE id = $1 AND recipient_id = $2
        `, [id, request.user.sub]);
        if (!result.rowCount) return response.status(404).json({ message: "Message introuvable." });
        response.status(204).end();
    }));
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
