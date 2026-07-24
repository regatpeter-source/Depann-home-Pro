import multer from "multer";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getPool } from "./database.js";
import { getAccountOwnerId } from "./auth.js";

const MAX_CLIENT_PAYLOAD_SIZE = 20 * 1024 * 1024;
const CLIENT_ID_PATTERN = /^client-[a-zA-Z0-9-]+$/;
const MAX_ACTIVITY_HISTORY = 150;
const MAX_CLIENT_ATTACHMENTS = 30;
const MAX_ATTACHMENT_SIZE = 4 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_UPLOAD = 5;
const ATTACHMENT_TYPES = new Set(["Devis", "Facture", "Quitus", "Photo", "Photo avant", "Photo après", "Autre"]);
const ALLOWED_ATTACHMENT_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".xls", ".xlsx", ".txt", ".jpg", ".jpeg", ".png", ".webp"]);
const attachmentUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTACHMENT_SIZE, files: MAX_ATTACHMENTS_PER_UPLOAD },
    fileFilter: (request, file, callback) => {
        const extension = path.extname(file.originalname || "").toLowerCase();
        callback(null, ALLOWED_ATTACHMENT_EXTENSIONS.has(extension));
    }
});

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
        `, [getAccountOwnerId(request)]);
        response.json({ clients: rows.map(row => row.client) });
    }));

    app.put("/api/clients/:clientId", requireAuthentication, requireClientWriteAccess, asyncHandler(async (request, response) => {
        const clientId = String(request.params.clientId || "");
        const client = sanitizeClient(request.body?.client, clientId);
        if (!client) return response.status(400).json({ message: "Dossier client invalide ou trop volumineux." });

        const { rows } = await getPool().query(`
            INSERT INTO depannhome_clients (owner_id, client_id, client_data, updated_at)
            VALUES ($1, $2, $3::jsonb, $4)
            ON CONFLICT (owner_id, client_id)
            DO UPDATE SET client_data = EXCLUDED.client_data, updated_at = EXCLUDED.updated_at
            RETURNING client_data AS client
        `, [getAccountOwnerId(request), clientId, JSON.stringify(client), client.updatedAt]);
        response.json({ client: rows[0].client });
    }));

    app.delete("/api/clients/:clientId", requireAuthentication, requireClientWriteAccess, asyncHandler(async (request, response) => {
        const clientId = String(request.params.clientId || "");
        if (!CLIENT_ID_PATTERN.test(clientId)) return response.status(400).json({ message: "Identifiant client invalide." });

        await getPool().query(
            "DELETE FROM depannhome_clients WHERE owner_id = $1 AND client_id = $2",
            [getAccountOwnerId(request), clientId]
        );
        response.status(204).end();
    }));

    app.post("/api/clients/:clientId/attachments", requireAuthentication, attachmentUpload.array("files", MAX_ATTACHMENTS_PER_UPLOAD), asyncHandler(async (request, response) => {
        const clientId = String(request.params.clientId || "");
        const files = Array.isArray(request.files) ? request.files : [];
        const attachmentType = ATTACHMENT_TYPES.has(request.body?.type) ? request.body.type : "Autre";
        if (!CLIENT_ID_PATTERN.test(clientId)) return response.status(400).json({ message: "Identifiant client invalide." });
        if (!files.length) return response.status(400).json({ message: "Ajoutez au moins un fichier accepté." });

        const database = getPool();
        const connection = await database.connect();
        try {
            await connection.query("BEGIN");
            const result = await connection.query(`
                SELECT client_data AS client
                FROM depannhome_clients
                WHERE owner_id = $1 AND client_id = $2
                FOR UPDATE
            `, [getAccountOwnerId(request), clientId]);
            const client = result.rows[0]?.client;
            if (!client) {
                await connection.query("ROLLBACK");
                return response.status(404).json({ message: "Dossier client introuvable." });
            }

            const existingAttachments = Array.isArray(client.attachments) ? client.attachments : [];
            if (existingAttachments.length + files.length > MAX_CLIENT_ATTACHMENTS) {
                await connection.query("ROLLBACK");
                return response.status(400).json({ message: `Ce dossier peut contenir au maximum ${MAX_CLIENT_ATTACHMENTS} fichiers.` });
            }
            const createdAt = new Date().toISOString();
            const attachments = files.map(file => ({
                id: `file-${randomUUID()}`,
                type: attachmentType === "Autre" && attachmentMimeType(file.originalname).startsWith("image/") ? "Photo" : attachmentType,
                name: safeFilename(file.originalname),
                mime: attachmentMimeType(file.originalname),
                size: file.size,
                dataUrl: `data:${attachmentMimeType(file.originalname)};base64,${file.buffer.toString("base64")}`,
                createdAt
            }));
            const activityHistory = Array.isArray(client.activityHistory) ? client.activityHistory : [];
            const updatedClient = {
                ...client,
                attachments: [...existingAttachments, ...attachments],
                activityHistory: [{
                    id: `activity-${randomUUID()}`,
                    type: "attachment",
                    label: `${attachments.length} fichier(s) ajouté(s)`,
                    detail: attachments.map(attachment => attachment.name).join(", ").slice(0, 500),
                    actorName: String(request.user.fullName || request.user.username || "Technicien").slice(0, 100),
                    createdAt
                }, ...activityHistory].slice(0, MAX_ACTIVITY_HISTORY),
                updatedAt: createdAt
            };
            if (Buffer.byteLength(JSON.stringify(updatedClient), "utf8") > MAX_CLIENT_PAYLOAD_SIZE) {
                await connection.query("ROLLBACK");
                return response.status(400).json({ message: "Le dossier est trop volumineux : retirez ou compressez des fichiers avant un nouveau dépôt." });
            }
            await connection.query(`
                UPDATE depannhome_clients
                SET client_data = $3::jsonb, updated_at = $4
                WHERE owner_id = $1 AND client_id = $2
            `, [getAccountOwnerId(request), clientId, JSON.stringify(updatedClient), createdAt]);
            await connection.query("COMMIT");
            response.status(201).json({ client: updatedClient, message: `${attachments.length} fichier(s) ajouté(s) au dossier.` });
        } catch (error) {
            await connection.query("ROLLBACK");
            throw error;
        } finally {
            connection.release();
        }
    }));

    app.get("/api/clients/:clientId/attachments/:attachmentId/open", requireAuthentication, asyncHandler(async (request, response) => {
        const clientId = String(request.params.clientId || "");
        const attachmentId = String(request.params.attachmentId || "");
        if (!CLIENT_ID_PATTERN.test(clientId) || !attachmentId) return response.status(400).json({ message: "Fichier invalide." });

        const { rows } = await getPool().query(`
            SELECT client_data AS client
            FROM depannhome_clients
            WHERE owner_id = $1 AND client_id = $2
        `, [getAccountOwnerId(request), clientId]);
        const attachments = Array.isArray(rows[0]?.client?.attachments) ? rows[0].client.attachments : [];
        const attachment = attachments.find(item => String(item?.id) === attachmentId);
        const content = attachment ? decodeAttachmentDataUrl(attachment.dataUrl) : null;
        if (!attachment || !content) return response.status(404).json({ message: "Fichier introuvable." });

        response.type(attachmentMimeType(attachment.name));
        response.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(safeFilename(attachment.name))}`);
        response.send(content.buffer);
    }));
}

export function clientUploadErrorHandler(error, request, response, next) {
    if (error instanceof multer.MulterError) {
        const message = error.code === "LIMIT_FILE_SIZE"
            ? "Chaque fichier est limité à 4 Mo."
            : "Envoi impossible : vérifiez le nombre et la taille des fichiers.";
        return response.status(400).json({ message });
    }
    return next(error);
}

function requireClientWriteAccess(request, response, next) {
    if (request.user?.role === "technician") {
        return response.status(403).json({ message: "Les techniciens peuvent consulter les dossiers clients, sans les modifier." });
    }
    return next();
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
        attachments: Array.isArray(value.attachments) ? value.attachments.slice(0, MAX_CLIENT_ATTACHMENTS) : [],
        activityHistory: sanitizeActivityHistory(value.activityHistory)
    };
}

function sanitizeActivityHistory(value) {
    if (!Array.isArray(value)) return [];
    return value
        .filter(item => item && typeof item === "object" && item.id && item.label)
        .map(item => ({
            id: String(item.id).slice(0, 100),
            type: String(item.type || "other").slice(0, 40),
            label: String(item.label).slice(0, 200),
            detail: String(item.detail || "").slice(0, 500),
            actorName: String(item.actorName || "").slice(0, 100),
            createdAt: validDate(item.createdAt) || new Date().toISOString()
        }))
        .slice(0, MAX_ACTIVITY_HISTORY);
}

function validDate(value) {
    const date = new Date(value || "");
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function safeFilename(value) {
    return path.basename(String(value || "fichier")).replace(/[\r\n]/g, " ").slice(0, 255) || "fichier";
}

function attachmentMimeType(filename) {
    const extension = path.extname(filename || "").toLowerCase();
    return {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".pdf": "application/pdf",
        ".doc": "application/msword",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".xls": "application/vnd.ms-excel",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".txt": "text/plain"
    }[extension] || "application/octet-stream";
}

function decodeAttachmentDataUrl(value) {
    const match = /^data:([^;,]+);base64,([a-zA-Z0-9+/=]+)$/.exec(String(value || ""));
    if (!match) return null;
    try {
        return { mime: match[1], buffer: Buffer.from(match[2], "base64") };
    } catch {
        return null;
    }
}

function asyncHandler(handler) {
    return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}
