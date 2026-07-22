import { getPool } from "./database.js";
import { getAccountOwnerId } from "./auth.js";

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
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
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
}

export function registerMessageRoutes(app, requireAuthentication) {
    app.get("/api/messages", requireAuthentication, asyncHandler(async (request, response) => {
        const { rows } = await getPool().query(`
                 SELECT message.id, message.body, message.created_at AS "createdAt",
                     sender.full_name AS "senderName", sender.username AS "senderUsername"
                 FROM depannhome_messages message
                 JOIN depannhome_users sender ON sender.id = message.sender_id
                 WHERE message.recipient_id = $1
            ORDER BY created_at DESC
            LIMIT 300
        `, [getAccountOwnerId(request)]);
        response.json({ messages: rows });
    }));

    app.post("/api/messages", requireAuthentication, asyncHandler(async (request, response) => {
        const body = cleanMessage(request.body?.body);
        if (!body) return response.status(400).json({ message: "La note ne peut pas être vide." });
        const { rows } = await getPool().query(`
            INSERT INTO depannhome_messages (sender_id, recipient_id, body)
            VALUES ($1, $2, $3)
            RETURNING id, created_at AS "createdAt"
        `, [request.user.sub, getAccountOwnerId(request), body]);
        response.status(201).json({ note: rows[0] });
    }));
}

function cleanMessage(value) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE_LENGTH);
}

function asyncHandler(handler) {
    return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}
