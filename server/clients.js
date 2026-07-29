import multer from "multer";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getPool } from "./database.js";
import { getAccountOwnerId } from "./auth.js";
import { sendDocumentEmail } from "./email.js";

const MAX_CLIENT_PAYLOAD_SIZE = 20 * 1024 * 1024;
const CLIENT_ID_PATTERN = /^client-[a-zA-Z0-9-]+$/;
const MAX_ACTIVITY_HISTORY = 150;
const MAX_CLIENT_ATTACHMENTS = 30;
const MAX_ATTACHMENT_SIZE = 4 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_UPLOAD = 5;
const MAX_DELETED_ATTACHMENT_IDS = 500;
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
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_deleted_clients (
            owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            client_id VARCHAR(100) NOT NULL,
            deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (owner_id, client_id)
        )
    `);
}

export function registerClientRoutes(app, requireAuthentication) {
    app.get("/api/clients", requireAuthentication, asyncHandler(async (request, response) => {
        const sinceParameter = String(request.query?.since || "");
        const since = sinceParameter ? validDate(sinceParameter) : "";
        if (sinceParameter && !since) return response.status(400).json({ message: "Curseur de synchronisation invalide." });
        const database = getPool();
        const { rows: cursorRows } = await database.query("SELECT NOW() AS cursor");
        const cursor = cursorRows[0].cursor;
        const { rows } = await database.query(`
            SELECT client_data AS client
            FROM depannhome_clients
            WHERE owner_id = $1 AND updated_at <= $2
              AND ($3::timestamptz IS NULL OR updated_at > $3::timestamptz)
            ORDER BY updated_at DESC
        `, [getAccountOwnerId(request), cursor, since || null]);
        const deletedClientIds = since ? (await database.query(`
            SELECT client_id AS "clientId"
            FROM depannhome_deleted_clients
            WHERE owner_id = $1 AND deleted_at <= $2 AND deleted_at > $3::timestamptz
        `, [getAccountOwnerId(request), cursor, since])).rows.map(row => row.clientId) : [];
        response.json({ clients: rows.map(row => row.client), deletedClientIds, cursor: cursor.toISOString() });
    }));

    app.put("/api/clients/:clientId", requireAuthentication, requireClientWriteAccess, asyncHandler(async (request, response) => {
        const clientId = String(request.params.clientId || "");
        const submittedClient = sanitizeClient(request.body?.client, clientId);
        if (!submittedClient) return response.status(400).json({ message: "Dossier client invalide ou trop volumineux." });

        const database = getPool();
        const connection = await database.connect();
        try {
            await connection.query("BEGIN");
            const deleted = await connection.query(
                "SELECT 1 FROM depannhome_deleted_clients WHERE owner_id = $1 AND client_id = $2",
                [getAccountOwnerId(request), clientId]
            );
            if (deleted.rowCount) {
                await connection.query("ROLLBACK");
                return response.status(410).json({ message: "Ce dossier a été supprimé et ne peut pas être restauré par une ancienne synchronisation." });
            }
            const existing = await connection.query(`
                SELECT client_data AS client FROM depannhome_clients
                WHERE owner_id = $1 AND client_id = $2 FOR UPDATE
            `, [getAccountOwnerId(request), clientId]);
            const now = new Date().toISOString();
            const client = mergeDeletedAttachments(existing.rows[0]?.client, { ...submittedClient, updatedAt: now });
            const { rows } = await connection.query(`
                INSERT INTO depannhome_clients (owner_id, client_id, client_data, updated_at)
                VALUES ($1, $2, $3::jsonb, NOW())
                ON CONFLICT (owner_id, client_id)
                DO UPDATE SET client_data = EXCLUDED.client_data, updated_at = NOW()
                RETURNING client_data AS client
            `, [getAccountOwnerId(request), clientId, JSON.stringify(client)]);
            await connection.query("COMMIT");
            response.json({ client: rows[0].client });
        } catch (error) {
            await connection.query("ROLLBACK");
            throw error;
        } finally {
            connection.release();
        }
    }));

    app.delete("/api/clients/:clientId", requireAuthentication, requireClientWriteAccess, asyncHandler(async (request, response) => {
        const clientId = String(request.params.clientId || "");
        if (!CLIENT_ID_PATTERN.test(clientId)) return response.status(400).json({ message: "Identifiant client invalide." });
        const database = getPool();
        const connection = await database.connect();
        try {
            await connection.query("BEGIN");
            await connection.query(
                "DELETE FROM depannhome_clients WHERE owner_id = $1 AND client_id = $2",
                [getAccountOwnerId(request), clientId]
            );
            await connection.query(
                "DELETE FROM depannhome_messages WHERE recipient_id = $1 AND client_id = $2",
                [getAccountOwnerId(request), clientId]
            );
            await connection.query(`
                INSERT INTO depannhome_deleted_clients (owner_id, client_id, deleted_at)
                VALUES ($1, $2, NOW())
                ON CONFLICT (owner_id, client_id) DO UPDATE SET deleted_at = NOW()
            `, [getAccountOwnerId(request), clientId]);
            await connection.query("COMMIT");
            response.status(204).end();
        } catch (error) {
            await connection.query("ROLLBACK");
            throw error;
        } finally {
            connection.release();
        }
    }));

    app.post("/api/clients/:clientId/attachments", requireAuthentication, attachmentUpload.array("files", MAX_ATTACHMENTS_PER_UPLOAD), asyncHandler(async (request, response) => {
        const clientId = String(request.params.clientId || "");
        const files = Array.isArray(request.files) ? request.files : [];
        const attachmentType = ATTACHMENT_TYPES.has(request.body?.type) ? request.body.type : "Autre";
        const appointmentId = positiveId(request.body?.appointmentId);
        if (!CLIENT_ID_PATTERN.test(clientId)) return response.status(400).json({ message: "Identifiant client invalide." });
        if (!files.length) return response.status(400).json({ message: "Ajoutez au moins un fichier accepté." });
        if (appointmentId && !await hasAccessibleAppointment(getAccountOwnerId(request), appointmentId, request)) {
            return response.status(400).json({ message: "Le rendez-vous associé est introuvable ou n’est pas accessible." });
        }

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
                appointmentId: appointmentId || undefined,
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

    app.delete("/api/clients/:clientId/attachments/:attachmentId", requireAuthentication, requireClientWriteAccess, asyncHandler(async (request, response) => {
        const clientId = String(request.params.clientId || "");
        const attachmentId = String(request.params.attachmentId || "").slice(0, 100);
        if (!CLIENT_ID_PATTERN.test(clientId) || !attachmentId) return response.status(400).json({ message: "Fichier invalide." });

        const database = getPool();
        const connection = await database.connect();
        try {
            await connection.query("BEGIN");
            const result = await connection.query(`
                SELECT client_data AS client FROM depannhome_clients
                WHERE owner_id = $1 AND client_id = $2 FOR UPDATE
            `, [getAccountOwnerId(request), clientId]);
            const client = result.rows[0]?.client;
            const attachments = Array.isArray(client?.attachments) ? client.attachments : [];
            const attachment = attachments.find(item => String(item?.id) === attachmentId);
            if (!client || !attachment) {
                await connection.query("ROLLBACK");
                return response.status(404).json({ message: "Fichier introuvable." });
            }
            const now = new Date().toISOString();
            const updatedClient = mergeDeletedAttachments(client, {
                ...client,
                attachments: attachments.filter(item => String(item?.id) !== attachmentId),
                deletedAttachmentIds: [...(Array.isArray(client.deletedAttachmentIds) ? client.deletedAttachmentIds : []), attachmentId],
                updatedAt: now
            });
            await connection.query(`
                UPDATE depannhome_clients SET client_data = $3::jsonb, updated_at = NOW()
                WHERE owner_id = $1 AND client_id = $2
            `, [getAccountOwnerId(request), clientId, JSON.stringify(updatedClient)]);
            await connection.query("COMMIT");
            response.json({ message: "Fichier supprimé définitivement du dossier." });
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

    app.post("/api/clients/:clientId/attachments/:attachmentId/email", requireAuthentication, asyncHandler(async (request, response) => {
        const clientId = String(request.params.clientId || "");
        const attachmentId = String(request.params.attachmentId || "");
        const recipient = sanitizeEmailRecipient(request.body?.recipient);
        if (!CLIENT_ID_PATTERN.test(clientId) || !attachmentId) return response.status(400).json({ message: "Fichier invalide." });
        if (!recipient) return response.status(400).json({ message: "L’adresse e-mail du destinataire est invalide." });

        const { rows } = await getPool().query(`
            SELECT client_data AS client
            FROM depannhome_clients
            WHERE owner_id = $1 AND client_id = $2
        `, [getAccountOwnerId(request), clientId]);
        const client = rows[0]?.client;
        const attachments = Array.isArray(client?.attachments) ? client.attachments : [];
        const attachment = attachments.find(item => String(item?.id) === attachmentId);
        const content = attachment ? decodeAttachmentDataUrl(attachment.dataUrl) : null;
        if (!attachment || !content) return response.status(404).json({ message: "Fichier introuvable." });

        await sendDocumentEmail({
            recipient,
            recipientName: String(client?.name || ""),
            documentLabel: `${String(attachment.type || "Document")} ${safeFilename(attachment.name)}`,
            attachment: { filename: safeFilename(attachment.name), content: content.buffer, contentType: attachmentMimeType(attachment.name) }
        });
        response.json({ message: "Document envoyé par e-mail." });
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
        deletedAttachmentIds: sanitizeDeletedAttachmentIds(value.deletedAttachmentIds),
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
            documentId: String(item.documentId || "").slice(0, 30),
            attachmentId: String(item.attachmentId || "").slice(0, 100),
            actorName: String(item.actorName || "").slice(0, 100),
            createdAt: validDate(item.createdAt) || new Date().toISOString()
        }))
        .slice(0, MAX_ACTIVITY_HISTORY);
}

function validDate(value) {
    const date = new Date(value || "");
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function sanitizeDeletedAttachmentIds(value) {
    return [...new Set((Array.isArray(value) ? value : [])
        .map(item => String(item || "").slice(0, 100))
        .filter(Boolean))].slice(-MAX_DELETED_ATTACHMENT_IDS);
}

function mergeDeletedAttachments(existingClient, nextClient) {
    const deletedAttachmentIds = sanitizeDeletedAttachmentIds([
        ...(Array.isArray(existingClient?.deletedAttachmentIds) ? existingClient.deletedAttachmentIds : []),
        ...(Array.isArray(nextClient?.deletedAttachmentIds) ? nextClient.deletedAttachmentIds : [])
    ]);
    const deleted = new Set(deletedAttachmentIds);
    return {
        ...nextClient,
        attachments: (Array.isArray(nextClient?.attachments) ? nextClient.attachments : [])
            .filter(attachment => attachment && !deleted.has(String(attachment.id || ""))),
        deletedAttachmentIds
    };
}

function positiveId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

async function hasAccessibleAppointment(ownerId, appointmentId, request) {
    const { rowCount } = await getPool().query(`
        SELECT 1 FROM depannhome_calendar_events
        WHERE id = $1 AND owner_id = $2 AND event_type = 'appointment'
          AND ($3 <> 'technician' OR EXISTS (SELECT 1 FROM depannhome_calendar_assignments assignment WHERE assignment.event_id = depannhome_calendar_events.id AND assignment.technician_id = $4::bigint))
    `, [appointmentId, ownerId, request.user?.role || "", request.user?.sub || 0]);
    return Boolean(rowCount);
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

function sanitizeEmailRecipient(value) {
    const recipient = String(value || "").trim().slice(0, 254);
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient) ? recipient : "";
}

function asyncHandler(handler) {
    return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}
