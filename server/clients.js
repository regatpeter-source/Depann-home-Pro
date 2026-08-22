import multer from "multer";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getPool } from "./database.js";
import { getAccountOwnerId } from "./auth.js";
import { sendDocumentEmail } from "./email.js";
import { clientLifecycleDecision, normalizeClientStatus } from "./client-lifecycle.js";

const MAX_CLIENT_PAYLOAD_SIZE = 20 * 1024 * 1024;
const CLIENT_ID_PATTERN = /^client-[a-zA-Z0-9-]+$/;
const MAX_ACTIVITY_HISTORY = 150;
const MAX_CLIENT_ATTACHMENTS = 30;
const MAX_ATTACHMENT_SIZE = 4 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_UPLOAD = 5;
const MAX_DELETED_ATTACHMENT_IDS = 500;
const ATTACHMENT_TYPES = new Set(["Devis", "Facture", "Quitus", "Rapport fuite", "Photo", "Photo avant", "Photo après", "Autre"]);
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
            client_status VARCHAR(20) NOT NULL DEFAULT 'active' CONSTRAINT depannhome_clients_status_check CHECK (client_status IN ('active', 'archived')), archived_at TIMESTAMPTZ, archived_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT depannhome_clients_owner_client_unique UNIQUE (owner_id, client_id)
        )
    `);
    await database.query("ALTER TABLE depannhome_clients ADD COLUMN IF NOT EXISTS client_status VARCHAR(20) NOT NULL DEFAULT 'active', ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS archived_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL");
    await database.query("UPDATE depannhome_clients SET client_status='active' WHERE client_status NOT IN ('active','archived')");
    await database.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='depannhome_clients_status_check') THEN ALTER TABLE depannhome_clients ADD CONSTRAINT depannhome_clients_status_check CHECK (client_status IN ('active','archived')); END IF; END $$`);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_clients_owner_status_updated_idx ON depannhome_clients (owner_id, client_status, updated_at DESC)");
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
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_client_lifecycle_audit (
            id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            client_id VARCHAR(100) NOT NULL, action VARCHAR(30) NOT NULL,
            actor_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL, actor_name VARCHAR(160) NOT NULL DEFAULT '',
            details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_client_lifecycle_audit_client_idx ON depannhome_client_lifecycle_audit (owner_id, client_id, created_at DESC)");
}

export async function listClientsForOwner(ownerId, sinceParameter = "") {
    const since = sinceParameter ? validDate(sinceParameter) : "";
    if (sinceParameter && !since) throw clientError(400, "Curseur de synchronisation invalide.");
    const database = getPool();
    await reconcilePartnerMissionClients(database, ownerId);
    await reconcileValidatedReportAttachments(database, ownerId);
    const { rows: cursorRows } = await database.query("SELECT NOW() AS cursor");
    const cursor = cursorRows[0].cursor;
    const { rows } = await database.query(`
        SELECT client_data AS client, client_status AS "clientStatus", archived_at AS "archivedAt", archived_by AS "archivedBy", updated_at AS "updatedAt"
        FROM depannhome_clients
        WHERE owner_id = $1 AND updated_at <= $2 AND COALESCE(client_data->>'isSandbox','false')<>'true'
          AND ($3::timestamptz IS NULL OR updated_at > $3::timestamptz)
        ORDER BY updated_at DESC
    `, [ownerId, cursor, since || null]);
    const deletedClientIds = since ? (await database.query(`
        SELECT client_id AS "clientId"
        FROM depannhome_deleted_clients
        WHERE owner_id = $1 AND deleted_at <= $2 AND deleted_at > $3::timestamptz
    `, [ownerId, cursor, since])).rows.map(row => row.clientId) : [];
    return { clients: rows.map(publicClient), deletedClientIds, cursor: cursor.toISOString() };
}

async function reconcilePartnerMissionClients(database, ownerId) {
    const { rows: missions } = await database.query(`
        SELECT mission.id, mission.client_id AS "missionClientId", mission.mapped_data AS "mappedData",
            mission.created_at AS "createdAt"
        FROM depannhome_partner_missions mission
        JOIN depannhome_partner_intakes intake ON intake.id=mission.intake_id
        LEFT JOIN depannhome_clients client ON client.owner_id = mission.owner_id
            AND client.client_id = NULLIF(mission.client_id, '')
        WHERE mission.owner_id = $1 AND mission.deleted_at IS NULL AND intake.is_sandbox=FALSE
            AND (mission.client_id = '' OR client.client_id IS NULL)
    `, [ownerId]);
    if (!missions.length) return;

    const connection = await database.connect();
    try {
        await connection.query("BEGIN");
        for (const mission of missions) {
            const clientId = String(mission.missionClientId || `client-${randomUUID()}`);
            const data = mission.mappedData || {};
            const createdAt = mission.createdAt ? new Date(mission.createdAt).toISOString() : new Date().toISOString();
            const client = {
                id: clientId,
                type: "Particulier",
                name: String(data.clientName || "Client partenaire").slice(0, 160),
                firstName: String(data.firstName || "").slice(0, 100),
                lastName: String(data.lastName || "").slice(0, 100),
                address: String(data.address || "").slice(0, 255),
                interventionAddress: String(data.interventionAddress || data.address || "").slice(0, 255),
                city: String(data.city || "").slice(0, 100),
                phone: String(data.phone || "").slice(0, 50),
                email: String(data.email || "").slice(0, 160),
                insurance: String(data.insurance || "").slice(0, 160),
                principal: String(data.principal || "").slice(0, 160),
                claimNumber: String(data.claimNumber || "").slice(0, 160),
                expert: String(data.expert || "").slice(0, 160),
                manager: String(data.manager || "").slice(0, 160),
                equipment: "", notes: String(data.description || data.comments || "").slice(0, 2000),
                attachments: [], activityHistory: [{ id: `activity-partner-repair-${mission.id}`, type: "partner_mission", label: "Fiche client restaurée depuis une mission partenaire", detail: String(data.partnerReference || data.externalMissionId || "").slice(0, 500), actorName: "Depann’Home Pro", createdAt }],
                createdAt, updatedAt: new Date().toISOString()
            };
            await connection.query(`
                INSERT INTO depannhome_clients(owner_id, client_id, client_data, updated_at)
                VALUES($1, $2, $3::jsonb, NOW())
                ON CONFLICT(owner_id, client_id) DO NOTHING
            `, [ownerId, clientId, JSON.stringify(client)]);
            await connection.query("UPDATE depannhome_partner_missions SET client_id=$3,updated_at=NOW() WHERE id=$1 AND owner_id=$2", [mission.id, ownerId, clientId]);
            await connection.query("UPDATE depannhome_calendar_events SET client_id=$3,updated_at=NOW() WHERE owner_id=$1 AND partner_mission_id=$2", [ownerId, mission.id, clientId]);
        }
        await connection.query("COMMIT");
    } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
    } finally {
        connection.release();
    }
}

export function registerClientRoutes(app, requireAuthentication) {
    app.use("/api/clients", requireAuthentication, requireClientReadAccess);
    app.get("/api/clients", requireAuthentication, asyncHandler(async (request, response) => {
        response.json(await listClientsForOwner(getAccountOwnerId(request), String(request.query?.since || "")));
    }));

    app.get("/api/clients/group-import", requireAuthentication, requireGroupClientImportAccess, asyncHandler(async (request, response) => {
        const targetCompanyId = getAccountOwnerId(request);
        const sourceCompanyId = positiveId(request.query?.sourceCompanyId);
        const companies = await groupImportCompanies(request.user.groupId, targetCompanyId);
        if (!sourceCompanyId) return response.json({ companies, clients: [] });
        const sourceCompany = companies.find(company => String(company.id) === String(sourceCompanyId));
        if (!sourceCompany) return response.status(404).json({ message: "Entreprise source inactive ou non autorisée dans ce groupe." });
        const { rows } = await getPool().query(`
            SELECT client_id AS id, client_data AS client
            FROM depannhome_clients
            WHERE owner_id=$1 AND client_status='active' AND COALESCE(client_data->>'isSandbox','false')<>'true'
            ORDER BY LOWER(COALESCE(client_data->>'name','')), client_id
            LIMIT 1000
        `, [sourceCompanyId]);
        response.json({ companies, sourceCompany, clients: rows.map(groupImportClientSummary) });
    }));

    app.post("/api/clients/group-import", requireAuthentication, requireClientWriteAccess, requireGroupClientImportAccess, asyncHandler(async (request, response) => {
        const targetCompanyId = getAccountOwnerId(request);
        const sourceCompanyId = positiveId(request.body?.sourceCompanyId);
        const sourceClientId = String(request.body?.clientId || "");
        if (!sourceCompanyId || !CLIENT_ID_PATTERN.test(sourceClientId)) return response.status(400).json({ message: "Entreprise ou client source invalide." });
        const sourceCompany = (await groupImportCompanies(request.user.groupId, targetCompanyId)).find(company => String(company.id) === String(sourceCompanyId));
        if (!sourceCompany) return response.status(404).json({ message: "Entreprise source inactive ou non autorisée dans ce groupe." });

        const connection = await getPool().connect();
        try {
            await connection.query("BEGIN");
            const sourceResult = await connection.query(`
                                SELECT source_client.client_data AS client
                                FROM depannhome_clients source_client
                                JOIN depannhome_group_companies company ON company.company_owner_id=source_client.owner_id
                                        AND company.group_id=$3 AND company.is_active=TRUE
                                JOIN depannhome_groups group_data ON group_data.id=company.group_id AND group_data.is_active=TRUE
                                WHERE source_client.owner_id=$1 AND source_client.client_id=$2 AND source_client.client_status='active'
                                    AND COALESCE(source_client.client_data->>'isSandbox','false')<>'true'
                                FOR SHARE OF source_client,company
                        `, [sourceCompanyId, sourceClientId, request.user.groupId]);
            const sourceClient = sourceResult.rows[0]?.client;
            if (!sourceClient) {
                await connection.query("ROLLBACK");
                return response.status(404).json({ message: "Client source introuvable ou archivé." });
            }
            await connection.query("SELECT pg_advisory_xact_lock($1::bigint)", [targetCompanyId]);
            const targetClients = await connection.query("SELECT client_id AS id,client_data AS client FROM depannhome_clients WHERE owner_id=$1 AND client_status='active' FOR UPDATE", [targetCompanyId]);
            const duplicate = targetClients.rows.find(row => isSameGroupClientIdentity(row.client, sourceClient, { sourceCompanyId, sourceClientId }));
            if (duplicate) {
                await connection.query("ROLLBACK");
                return response.status(409).json({ message: "Ce client existe déjà dans l’entreprise active.", existingClientId: duplicate.id });
            }
            const client = createGroupClientCopy(sourceClient, {
                sourceCompanyId,
                sourceClientId,
                sourceCompanyName: sourceCompany.companyName,
                actorName: request.user.fullName || request.user.username
            });
            await connection.query("INSERT INTO depannhome_clients(owner_id,client_id,client_data,updated_at) VALUES($1,$2,$3::jsonb,NOW())", [targetCompanyId, client.id, JSON.stringify(client)]);
            await connection.query("INSERT INTO depannhome_client_lifecycle_audit(owner_id,client_id,action,actor_id,actor_name,details) VALUES($1,$2,'group_imported',$3,$4,$5::jsonb)", [targetCompanyId, client.id, request.user.sub, String(request.user.fullName || request.user.username || "").slice(0, 160), JSON.stringify({ sourceCompanyId: String(sourceCompanyId), sourceCompanyName: sourceCompany.companyName, sourceClientId })]);
            await connection.query("INSERT INTO depannhome_group_audit(group_id,company_owner_id,actor_id,action,details,ip_address) VALUES($1,$2,$3,'client_imported',$4::jsonb,$5)", [request.user.groupId, targetCompanyId, request.user.sub, JSON.stringify({ sourceCompanyId: String(sourceCompanyId), sourceCompanyName: sourceCompany.companyName, sourceClientId, targetClientId: client.id, clientName: client.name }), String(request.ip || "").slice(0, 100)]);
            await connection.query("COMMIT");
            response.status(201).json({ client: { ...client, clientStatus: "active" }, message: `Client repris depuis ${sourceCompany.companyName}. Les documents de l’entreprise source n’ont pas été copiés.` });
        } catch (error) {
            await connection.query("ROLLBACK");
            throw error;
        } finally {
            connection.release();
        }
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
            const client = mergeDeletedAttachments(existing.rows[0]?.client, {
                ...submittedClient,
                attachments: mergeClientAttachments(existing.rows[0]?.client?.attachments, submittedClient.attachments),
                updatedAt: now
            });
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

    app.get("/api/clients/:clientId/deletion-analysis", requireAuthentication, requireClientWriteAccess, asyncHandler(async (request, response) => {
        const clientId = String(request.params.clientId || "");
        if (!CLIENT_ID_PATTERN.test(clientId)) return response.status(400).json({ message: "Identifiant client invalide." });
        const analysis = await analyzeClientLifecycle(getPool(), getAccountOwnerId(request), clientId);
        if (!analysis) return response.status(404).json({ message: "Dossier client introuvable." });
        response.json({ analysis });
    }));

    app.patch("/api/clients/:clientId/archive", requireAuthentication, requireClientWriteAccess, asyncHandler(async (request, response) => {
        const clientId = String(request.params.clientId || "");
        if (!CLIENT_ID_PATTERN.test(clientId)) return response.status(400).json({ message: "Identifiant client invalide." });
        const ownerId = getAccountOwnerId(request);
        const connection = await getPool().connect();
        try {
            await connection.query("BEGIN");
            const { rowCount } = await connection.query("UPDATE depannhome_clients SET client_status='archived', archived_at=NOW(), archived_by=$3, updated_at=NOW() WHERE owner_id=$1 AND client_id=$2 AND client_status<>'archived'", [ownerId, clientId, request.user.sub]);
            if (!rowCount) { await connection.query("ROLLBACK"); return response.status(404).json({ message: "Dossier client introuvable ou déjà archivé." }); }
            await recordClientLifecycle(connection, ownerId, clientId, "archived", request);
            await connection.query("COMMIT");
            response.json({ message: "Client archivé. Tous ses documents et son historique sont conservés." });
        } catch (error) { await connection.query("ROLLBACK"); throw error; } finally { connection.release(); }
    }));

    app.patch("/api/clients/:clientId/reactivate", requireAuthentication, requireClientWriteAccess, asyncHandler(async (request, response) => {
        const clientId = String(request.params.clientId || "");
        if (!CLIENT_ID_PATTERN.test(clientId)) return response.status(400).json({ message: "Identifiant client invalide." });
        const ownerId = getAccountOwnerId(request);
        const connection = await getPool().connect();
        try {
            await connection.query("BEGIN");
            const { rowCount } = await connection.query("UPDATE depannhome_clients SET client_status='active', archived_at=NULL, archived_by=NULL, updated_at=NOW() WHERE owner_id=$1 AND client_id=$2 AND client_status='archived'", [ownerId, clientId]);
            if (!rowCount) { await connection.query("ROLLBACK"); return response.status(404).json({ message: "Dossier client introuvable ou déjà actif." }); }
            await recordClientLifecycle(connection, ownerId, clientId, "reactivated", request);
            await connection.query("COMMIT");
            response.json({ message: "Client réactivé." });
        } catch (error) { await connection.query("ROLLBACK"); throw error; } finally { connection.release(); }
    }));

    app.delete("/api/clients/:clientId", requireAuthentication, requirePermanentClientDeletion, asyncHandler(async (request, response) => {
        const clientId = String(request.params.clientId || "");
        if (!CLIENT_ID_PATTERN.test(clientId)) return response.status(400).json({ message: "Identifiant client invalide." });
        if (request.body?.confirmation !== "SUPPRESSION DÉFINITIVE") return response.status(400).json({ message: "Une confirmation explicite est obligatoire." });
        const ownerId = getAccountOwnerId(request);
        const database = getPool();
        const connection = await database.connect();
        try {
            await connection.query("BEGIN");
            const existing = await connection.query(
                "SELECT client_data AS client FROM depannhome_clients WHERE owner_id=$1 AND client_id=$2 FOR UPDATE",
                [ownerId, clientId]
            );
            if (!existing.rowCount) {
                await connection.query("ROLLBACK");
                return response.status(404).json({ message: "Dossier client introuvable." });
            }
            const analysis = await analyzeClientLifecycle(connection, ownerId, clientId, existing.rows[0].client);
            if (!analysis.canDeletePermanently) {
                await connection.query("ROLLBACK");
                return response.status(409).json({ message: "Ce client possède des documents ou un historique qui doivent être conservés. La suppression définitive n'est pas disponible. Vous pouvez archiver ce client.", analysis });
            }
            await recordClientLifecycle(connection, ownerId, clientId, "deleted", request, analysis.dependencies);
            await connection.query("DELETE FROM depannhome_clients WHERE owner_id=$1 AND client_id=$2", [ownerId, clientId]);
            await connection.query(`
                INSERT INTO depannhome_deleted_clients (owner_id, client_id, deleted_at)
                VALUES ($1, $2, NOW())
                ON CONFLICT (owner_id, client_id) DO UPDATE SET deleted_at = NOW()
            `, [ownerId, clientId]);
            await connection.query("COMMIT");
            response.json({ message: "Le client sans historique a été supprimé définitivement." });
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
        response.status(409).json({ message: "Les fichiers du dossier client sont conservés et ne peuvent pas être supprimés." });
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
        const content = attachment ? await loadClientAttachmentContent(getPool(), getAccountOwnerId(request), clientId, attachment) : null;
        if (!attachment || !content) return response.status(404).json({ message: "Fichier introuvable." });

        response.type(content.mime || attachmentMimeType(attachment.name));
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
        const content = attachment ? await loadClientAttachmentContent(getPool(), getAccountOwnerId(request), clientId, attachment) : null;
        if (!attachment || !content) return response.status(404).json({ message: "Fichier introuvable." });

        await sendDocumentEmail({
            recipient,
            recipientName: String(client?.name || ""),
            documentLabel: `${String(attachment.type || "Document")} ${safeFilename(attachment.name)}`,
            attachment: { filename: safeFilename(attachment.name), content: content.buffer, contentType: content.mime || attachmentMimeType(attachment.name) }
        });
        response.json({ message: "Document envoyé par e-mail." });
    }));
}

async function analyzeClientLifecycle(database, ownerId, clientId, knownClient = null) {
    const clientResult = knownClient ? { rows: [{ client: knownClient }] } : await database.query("SELECT client_data AS client FROM depannhome_clients WHERE owner_id=$1 AND client_id=$2", [ownerId, clientId]);
    const client = clientResult.rows[0]?.client;
    if (!client) return null;
    const { rows } = await database.query(`
        WITH events AS (SELECT id FROM depannhome_calendar_events WHERE owner_id=$1 AND client_id=$2),
        reports AS (SELECT id FROM depannhome_technical_reports WHERE owner_id=$1 AND (client_id=$2 OR appointment_id IN (SELECT id FROM events))),
        documents AS (SELECT id FROM depannhome_billing_documents WHERE owner_id=$1 AND (client_id=$2 OR appointment_id IN (SELECT id FROM events))),
        missions AS (SELECT id FROM depannhome_partner_missions WHERE owner_id=$1 AND (client_id=$2 OR calendar_event_id IN (SELECT id FROM events) OR technical_report_id IN (SELECT id FROM reports)))
        SELECT (SELECT COUNT(*)::int FROM events) AS appointments,
            (SELECT COUNT(*)::int FROM reports) AS reports,
            (SELECT COUNT(*)::int FROM documents) AS "billingDocuments",
            (SELECT COUNT(*)::int FROM missions) AS "partnerMissions",
            (SELECT COUNT(*)::int FROM depannhome_purchases WHERE owner_id=$1 AND client_id=$2) AS purchases,
            (SELECT COUNT(*)::int FROM depannhome_messages message JOIN depannhome_users recipient ON recipient.id=message.recipient_id WHERE (recipient.id=$1 OR recipient.account_owner_id=$1) AND message.client_id=$2) AS messages,
            (SELECT COUNT(*)::int FROM depannhome_collaboration_audit WHERE owner_id=$1 AND entity_type='client' AND entity_id=$2) AS "auditEntries",
            (SELECT COUNT(*)::int FROM depannhome_accounting_entries WHERE owner_id=$1 AND client_id=$2) AS "accountingEntries"
    `, [ownerId, clientId]);
    return clientLifecycleDecision(rows[0], client);
}

async function recordClientLifecycle(database, ownerId, clientId, action, request, details = {}) {
    await database.query("INSERT INTO depannhome_client_lifecycle_audit(owner_id,client_id,action,actor_id,actor_name,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)", [ownerId, clientId, action, request.user.sub, String(request.user.fullName || request.user.username || "").slice(0, 160), JSON.stringify(details)]);
}

function publicClient(row) {
    return { ...(row.client || {}), clientStatus: normalizeClientStatus(row.clientStatus), archivedAt: row.archivedAt || null, archivedBy: row.archivedBy || null, updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : row.client?.updatedAt };
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

function requirePermanentClientDeletion(request, response, next) {
    if (request.user?.role !== "admin") return response.status(403).json({ message: "La suppression définitive d’un client est réservée aux administrateurs." });
    return next();
}

function requireClientReadAccess(request, response, next) {
    if (request.user?.role === "accountant") return response.status(403).json({ message: "L’espace comptabilité ne donne pas accès aux dossiers clients." });
    return next();
}

function requireGroupClientImportAccess(request, response, next) {
    if (request.user?.role !== "admin" || !request.user?.isGroupAdministrator || !request.user?.groupId) {
        return response.status(403).json({ message: "La reprise d’un client est réservée à l’administrateur d’un groupe d’entreprises." });
    }
    return next();
}

async function groupImportCompanies(groupId, targetCompanyId) {
    const { rows } = await getPool().query(`
        SELECT company.company_owner_id AS id, COALESCE(owner.company_name,owner.full_name,'Entreprise') AS "companyName"
        FROM depannhome_group_companies company
        JOIN depannhome_groups group_data ON group_data.id=company.group_id AND group_data.is_active=TRUE
        JOIN depannhome_users owner ON owner.id=company.company_owner_id AND owner.is_active=TRUE
        WHERE company.group_id=$1 AND company.is_active=TRUE AND company.company_owner_id<>$2
        ORDER BY LOWER(COALESCE(owner.company_name,owner.full_name,'Entreprise')), company.company_owner_id
    `, [groupId, targetCompanyId]);
    return rows.map(row => ({ id: String(row.id), companyName: row.companyName }));
}

function groupImportClientSummary(row) {
    const client = row.client || {};
    return {
        id: String(row.id || client.id || ""),
        type: String(client.type || "Particulier").slice(0, 50),
        name: String(client.name || "Client sans nom").slice(0, 160),
        phone: String(client.phone || "").slice(0, 50),
        email: String(client.email || "").slice(0, 160),
        address: String(client.address || "").slice(0, 255),
        city: String(client.city || "").slice(0, 100)
    };
}

export function createGroupClientCopy(sourceClient, context, options = {}) {
    const now = validDate(options.now) || new Date().toISOString();
    const clientId = options.clientId || `client-${randomUUID()}`;
    const copy = {
        id: clientId,
        type: String(sourceClient?.type || "Particulier").slice(0, 50),
        name: String(sourceClient?.name || "Client sans nom").slice(0, 160),
        firstName: String(sourceClient?.firstName || "").slice(0, 100),
        lastName: String(sourceClient?.lastName || "").slice(0, 100),
        phone: String(sourceClient?.phone || "").slice(0, 50),
        email: String(sourceClient?.email || "").slice(0, 160),
        address: String(sourceClient?.address || "").slice(0, 255),
        interventionAddress: String(sourceClient?.interventionAddress || "").slice(0, 255),
        city: String(sourceClient?.city || "").slice(0, 100),
        insurance: String(sourceClient?.insurance || "").slice(0, 160),
        principal: String(sourceClient?.principal || "").slice(0, 160),
        claimNumber: String(sourceClient?.claimNumber || "").slice(0, 160),
        expert: String(sourceClient?.expert || "").slice(0, 160),
        manager: String(sourceClient?.manager || "").slice(0, 160),
        equipment: String(sourceClient?.equipment || "").slice(0, 4000),
        notes: String(sourceClient?.notes || "").slice(0, 4000),
        attachments: [],
        deletedAttachmentIds: [],
        activityHistory: [{
            id: `activity-group-import-${randomUUID()}`,
            type: "group_import",
            label: `Client importé depuis ${String(context.sourceCompanyName || "une entreprise du groupe").slice(0, 160)}`,
            detail: "Coordonnées reprises sans les documents ni l’historique de l’entreprise source.",
            actorName: String(context.actorName || "Administrateur Groupe").slice(0, 100),
            createdAt: now
        }],
        groupImport: {
            sourceCompanyId: String(context.sourceCompanyId || ""),
            sourceCompanyName: String(context.sourceCompanyName || "").slice(0, 160),
            sourceClientId: String(context.sourceClientId || "").slice(0, 100),
            importedAt: now
        },
        createdAt: now,
        updatedAt: now
    };
    return sanitizeClient(copy, clientId);
}

export function isSameGroupClientIdentity(targetClient, sourceClient, source = {}) {
    const hasSourceOrigin = Boolean(source.sourceCompanyId && source.sourceClientId);
    const importedFromSameClient = hasSourceOrigin
        && String(targetClient?.groupImport?.sourceCompanyId || "") === String(source.sourceCompanyId)
        && String(targetClient?.groupImport?.sourceClientId || "") === String(source.sourceClientId || "");
    if (importedFromSameClient) return true;
    const targetEmail = normalizeIdentityText(targetClient?.email);
    const sourceEmail = normalizeIdentityText(sourceClient?.email);
    if (targetEmail && sourceEmail && targetEmail === sourceEmail) return true;
    const targetPhone = normalizeIdentityPhone(targetClient?.phone);
    const sourcePhone = normalizeIdentityPhone(sourceClient?.phone);
    if (targetPhone.length >= 6 && sourcePhone.length >= 6 && targetPhone === sourcePhone) return true;
    const targetName = normalizeIdentityText(targetClient?.name);
    const sourceName = normalizeIdentityText(sourceClient?.name);
    const targetAddress = normalizeIdentityText([targetClient?.address, targetClient?.city].filter(Boolean).join(" "));
    const sourceAddress = normalizeIdentityText([sourceClient?.address, sourceClient?.city].filter(Boolean).join(" "));
    return Boolean(targetName && sourceName && targetAddress && sourceAddress && targetName === sourceName && targetAddress === sourceAddress);
}

function normalizeIdentityText(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeIdentityPhone(value) {
    const digits = String(value || "").replace(/\D/g, "");
    return digits.length === 11 && digits.startsWith("33") ? `0${digits.slice(2)}` : digits;
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
    return {
        ...nextClient,
        attachments: Array.isArray(nextClient?.attachments) ? nextClient.attachments.filter(Boolean) : [],
        deletedAttachmentIds: []
    };
}

async function reconcileValidatedReportAttachments(database, ownerId) {
    const { rows } = await database.query(`
        SELECT report.id, report.client_id AS "clientId", report.appointment_id AS "appointmentId",
            report.pdf_filename AS filename, report.document_mime_type AS mime, OCTET_LENGTH(report.pdf_data)::int AS size,
            report.validated_at AS "validatedAt", client.client_data AS client
        FROM depannhome_technical_reports report
        JOIN depannhome_clients client ON client.owner_id = report.owner_id AND client.client_id = report.client_id
        WHERE report.owner_id = $1 AND report.status = 'validated' AND report.pdf_data IS NOT NULL AND report.client_id <> ''
    `, [ownerId]);
    for (const row of rows) {
        const client = row.client || {};
        const attachments = Array.isArray(client.attachments) ? client.attachments : [];
        const history = Array.isArray(client.activityHistory) ? client.activityHistory : [];
        const filename = safeFilename(row.filename || `rapport-recherche-fuite-${row.id}.pdf`);
        const matchingHistory = history.find(entry => entry?.type === "technical_report" && (String(entry.detail || "") === filename || String(entry.attachmentId || "") && attachments.some(item => String(item?.id) === String(entry.attachmentId) && String(item?.reportId || "") === String(row.id))));
        const matchingAttachments = attachments.filter(item => String(item?.reportId || "") === String(row.id) || isLegacyReportAttachment(item, filename));
        const attachmentId = String(matchingAttachments[0]?.id || matchingHistory?.attachmentId || `file-${randomUUID()}`);
        const attachment = { ...(matchingAttachments[0] || {}), id: attachmentId, type: "Rapport fuite", name: filename, mime: row.mime || "application/pdf", size: Number(row.size) || 0, reportId: String(row.id), appointmentId: row.appointmentId || undefined, createdAt: matchingAttachments[0]?.createdAt || row.validatedAt || new Date().toISOString() };
        const nextAttachments = [...attachments.filter(item => !matchingAttachments.includes(item)), attachment];
        const nextHistory = matchingHistory ? history.map(entry => entry === matchingHistory ? { ...entry, attachmentId } : entry) : [{ id: `activity-${randomUUID()}`, type: "technical_report", label: "Rapport de recherche de fuite validé", detail: filename, attachmentId, actorName: "Administration", createdAt: row.validatedAt || new Date().toISOString() }, ...history];
        const deletedAttachmentIds = sanitizeDeletedAttachmentIds(client.deletedAttachmentIds).filter(id => id !== attachmentId);
        const changed = matchingAttachments.length !== 1 || matchingAttachments[0]?.reportId !== String(row.id) || matchingHistory?.attachmentId !== attachmentId || deletedAttachmentIds.length !== sanitizeDeletedAttachmentIds(client.deletedAttachmentIds).length;
        if (!changed) continue;
        await database.query("UPDATE depannhome_clients SET client_data=$3::jsonb, updated_at=NOW() WHERE owner_id=$1 AND client_id=$2", [ownerId, row.clientId, JSON.stringify({ ...client, attachments: nextAttachments, activityHistory: nextHistory, deletedAttachmentIds })]);
    }
}

function isLegacyReportAttachment(attachment, filename) {
    return attachment?.type === "Rapport fuite" && String(attachment.name || "") === filename;
}

function mergeClientAttachments(existingAttachments, submittedAttachments) {
    const merged = new Map((Array.isArray(existingAttachments) ? existingAttachments : [])
        .filter(attachment => attachment?.id)
        .map(attachment => [String(attachment.id), attachment]));
    (Array.isArray(submittedAttachments) ? submittedAttachments : [])
        .filter(attachment => attachment?.id && attachment?.dataUrl)
        .forEach(attachment => merged.set(String(attachment.id), attachment));
    return [...merged.values()].slice(0, MAX_CLIENT_ATTACHMENTS);
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

async function loadClientAttachmentContent(database, ownerId, clientId, attachment) {
    const embedded = decodeAttachmentDataUrl(attachment?.dataUrl);
    if (embedded) return embedded;
    const reportId = positiveId(attachment?.reportId);
    if (!reportId) return null;
    const { rows } = await database.query(`
        SELECT pdf_data AS "pdfData", document_mime_type AS "mimeType"
        FROM depannhome_technical_reports
        WHERE id = $1 AND owner_id = $2 AND client_id = $3 AND status = 'validated'
    `, [reportId, ownerId, clientId]);
    const report = rows[0];
    return report?.pdfData ? { buffer: report.pdfData, mime: report.mimeType || attachment.mime || attachmentMimeType(attachment.name) } : null;
}

function sanitizeEmailRecipient(value) {
    const recipient = String(value || "").trim().slice(0, 254);
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient) ? recipient : "";
}

function asyncHandler(handler) {
    return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}
