import { getPool } from "./database.js";

const MAX_CLIENT_PAYLOAD_SIZE = 20 * 1024 * 1024;
const CLIENT_ID_PATTERN = /^client-[a-zA-Z0-9-]+$/;

export async function initializeClients() {
    const database = getPool();
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_clients (
            id BIGSERIAL PRIMARY KEY,
            owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            client_id VARCHAR(100) NOT NULL,
            client_data JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT depannhome_clients_owner_client_unique UNIQUE (owner_id, client_id)
        )
    `);
    await database.query(`
        CREATE INDEX IF NOT EXISTS depannhome_clients_owner_updated_idx
        ON depannhome_clients (owner_id, updated_at DESC)
    `);
}

export function registerClientRoutes(app, requireAuthentication) {
    app.get("/api/clients", requireAuthentication, asyncHandler(async (request, response) => {
        const { rows } = await getPool().query(`
            SELECT client_data AS client
            FROM depannhome_clients
            WHERE owner_id = $1
            ORDER BY updated_at DESC
        `, [request.user.sub]);
        response.json({ clients: rows.map(row => row.client) });
    }));

    app.put("/api/clients/:clientId", requireAuthentication, asyncHandler(async (request, response) => {
        const clientId = String(request.params.clientId || "");
        const client = sanitizeClient(request.body?.client, clientId);
        if (!client) return response.status(400).json({ message: "Dossier client invalide ou trop volumineux." });

        const { rows } = await getPool().query(`
            INSERT INTO depannhome_clients (owner_id, client_id, client_data, updated_at)
            VALUES ($1, $2, $3::jsonb, $4)
            ON CONFLICT (owner_id, client_id)
            DO UPDATE SET client_data = EXCLUDED.client_data, updated_at = EXCLUDED.updated_at
            RETURNING client_data AS client
        `, [request.user.sub, clientId, JSON.stringify(client), client.updatedAt]);
        response.json({ client: rows[0].client });
    }));

    app.delete("/api/clients/:clientId", requireAuthentication, asyncHandler(async (request, response) => {
        const clientId = String(request.params.clientId || "");
        if (!CLIENT_ID_PATTERN.test(clientId)) return response.status(400).json({ message: "Identifiant client invalide." });

        await getPool().query(
            "DELETE FROM depannhome_clients WHERE owner_id = $1 AND client_id = $2",
            [request.user.sub, clientId]
        );
        response.status(204).end();
    }));
}

function sanitizeClient(value, expectedId) {
    if (!value || typeof value !== "object" || value.id !== expectedId || !CLIENT_ID_PATTERN.test(expectedId)) return null;
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, "utf8") > MAX_CLIENT_PAYLOAD_SIZE) return null;

    const updatedAt = new Date(value.updatedAt || Date.now());
    if (Number.isNaN(updatedAt.getTime())) return null;

    return {
        ...value,
        id: expectedId,
        updatedAt: updatedAt.toISOString(),
        createdAt: validDate(value.createdAt) || updatedAt.toISOString(),
        attachments: Array.isArray(value.attachments) ? value.attachments.slice(0, 30) : []
    };
}

function validDate(value) {
    const date = new Date(value || "");
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function asyncHandler(handler) {
    return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}
