import crypto from "node:crypto";
import { getPool } from "./database.js";
import { getAccountOwnerId } from "./auth.js";
import { createNotification } from "./collaboration.js";
import { recordMissionDialogueDocument, recordMissionDialogueEvent } from "./partner-dialogue.js";
import { provisionPartnerMissionClient } from "./partner-missions.js";
import { organizationBadge } from "./organizations.js";

const STATES = new Set(["pending", "connected", "refused", "disconnected"]);
const AVAILABILITY_STATUSES = new Set(["available", "unavailable", "temporarily_unavailable"]);
const PERMISSION_KEYS = ["canSendInterventions", "canReceiveInterventions", "canViewReports", "canViewQuotes", "canViewInvoices", "canUseMessaging", "canViewStatusChanges"];
const DEFAULT_PERMISSIONS = Object.freeze({ canSendInterventions: true, canReceiveInterventions: true, canViewReports: true, canViewQuotes: true, canViewInvoices: false, canUseMessaging: true, canViewStatusChanges: true });

export async function initializePartnerConnections() {
    const db = getPool();
    await db.query(`CREATE TABLE IF NOT EXISTS depannhome_partner_directory (
        owner_id BIGINT PRIMARY KEY REFERENCES depannhome_users(id) ON DELETE CASCADE,
        is_listed BOOLEAN NOT NULL DEFAULT FALSE, visibility_explicit BOOLEAN NOT NULL DEFAULT FALSE,
        description VARCHAR(1000) NOT NULL DEFAULT '', trades JSONB NOT NULL DEFAULT '[]'::jsonb,
        supported_brands JSONB NOT NULL DEFAULT '[]'::jsonb, specialties JSONB NOT NULL DEFAULT '[]'::jsonb,
        service_area VARCHAR(500) NOT NULL DEFAULT '', service_radius_km INTEGER NOT NULL DEFAULT 0,
        departments JSONB NOT NULL DEFAULT '[]'::jsonb, opening_hours VARCHAR(1000) NOT NULL DEFAULT '',
        share_phone BOOLEAN NOT NULL DEFAULT FALSE, share_email BOOLEAN NOT NULL DEFAULT FALSE,
        website VARCHAR(500) NOT NULL DEFAULT '', accepts_partner_missions BOOLEAN NOT NULL DEFAULT FALSE,
        availability_status VARCHAR(30) NOT NULL DEFAULT 'available', commercial_name VARCHAR(160) NOT NULL DEFAULT '', region VARCHAR(100) NOT NULL DEFAULT '',
        regions JSONB NOT NULL DEFAULT '[]'::jsonb, coverage_mode VARCHAR(20) NOT NULL DEFAULT 'custom',
        latitude NUMERIC(9,6), longitude NUMERIC(9,6), creator_suspended BOOLEAN NOT NULL DEFAULT FALSE,
        creator_note VARCHAR(1000) NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.query(`ALTER TABLE depannhome_partner_directory
        ADD COLUMN IF NOT EXISTS visibility_explicit BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS description VARCHAR(1000) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS trades JSONB NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS supported_brands JSONB NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS specialties JSONB NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS service_area VARCHAR(500) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS service_radius_km INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS departments JSONB NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS opening_hours VARCHAR(1000) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS share_phone BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS share_email BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS website VARCHAR(500) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS accepts_partner_missions BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS availability_status VARCHAR(30) NOT NULL DEFAULT 'available',
        ADD COLUMN IF NOT EXISTS commercial_name VARCHAR(160) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS region VARCHAR(100) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS regions JSONB NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS coverage_mode VARCHAR(20) NOT NULL DEFAULT 'custom',
        ADD COLUMN IF NOT EXISTS latitude NUMERIC(9,6), ADD COLUMN IF NOT EXISTS longitude NUMERIC(9,6),
        ADD COLUMN IF NOT EXISTS creator_suspended BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS creator_note VARCHAR(1000) NOT NULL DEFAULT ''`);
    await db.query("ALTER TABLE depannhome_partner_directory ALTER COLUMN is_listed SET DEFAULT FALSE");
    await db.query("ALTER TABLE depannhome_partner_directory DROP CONSTRAINT IF EXISTS depannhome_partner_directory_availability_status_check");
    await db.query("ALTER TABLE depannhome_partner_directory ADD CONSTRAINT depannhome_partner_directory_availability_status_check CHECK (availability_status IN ('available','unavailable','temporarily_unavailable'))");
    await db.query("UPDATE depannhome_partner_directory SET is_listed=FALSE,updated_at=NOW() WHERE visibility_explicit=FALSE");
    await db.query(`CREATE OR REPLACE FUNCTION depannhome_register_partner_directory() RETURNS trigger AS $$
        BEGIN
            IF NEW.account_owner_id = NEW.id THEN
                INSERT INTO depannhome_partner_directory(owner_id,is_listed,visibility_explicit)
                VALUES(NEW.id,FALSE,FALSE) ON CONFLICT(owner_id) DO NOTHING;
            END IF;
            RETURN NEW;
        END;
    $$ LANGUAGE plpgsql`);
    await db.query("DROP TRIGGER IF EXISTS depannhome_partner_directory_registration ON depannhome_users");
    await db.query("CREATE TRIGGER depannhome_partner_directory_registration AFTER INSERT OR UPDATE OF account_owner_id ON depannhome_users FOR EACH ROW EXECUTE FUNCTION depannhome_register_partner_directory()");
    await db.query("INSERT INTO depannhome_partner_directory(owner_id,is_listed,visibility_explicit) SELECT id,FALSE,FALSE FROM depannhome_users WHERE account_owner_id=id ON CONFLICT(owner_id) DO NOTHING");
    await db.query("CREATE INDEX IF NOT EXISTS depannhome_partner_directory_search_idx ON depannhome_partner_directory(is_listed,creator_suspended,updated_at DESC)");
    await db.query(`CREATE TABLE IF NOT EXISTS depannhome_partner_connections (
        id BIGSERIAL PRIMARY KEY, company_low_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
        company_high_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
        requester_owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE RESTRICT,
        status VARCHAR(20) NOT NULL DEFAULT 'pending', permissions_for_low JSONB NOT NULL DEFAULT '{}'::jsonb,
        permissions_for_high JSONB NOT NULL DEFAULT '{}'::jsonb, requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        responded_at TIMESTAMPTZ, responded_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
        disconnected_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT depannhome_partner_connections_pair_unique UNIQUE(company_low_id, company_high_id),
        CONSTRAINT depannhome_partner_connections_pair_check CHECK(company_low_id < company_high_id),
        CONSTRAINT depannhome_partner_connections_state_check CHECK(status IN ('pending','connected','refused','disconnected'))
    )`);
    await db.query("CREATE INDEX IF NOT EXISTS depannhome_partner_connections_company_idx ON depannhome_partner_connections(company_low_id, company_high_id, status, updated_at DESC)");
    await db.query(`CREATE TABLE IF NOT EXISTS depannhome_partner_connection_sync_log (
        id BIGSERIAL PRIMARY KEY, connection_id BIGINT NOT NULL REFERENCES depannhome_partner_connections(id) ON DELETE CASCADE,
        source_owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
        target_owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
        source_event_id BIGINT REFERENCES depannhome_calendar_events(id) ON DELETE SET NULL,
        target_mission_id BIGINT REFERENCES depannhome_partner_missions(id) ON DELETE SET NULL,
        event_type VARCHAR(60) NOT NULL, details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.query("CREATE INDEX IF NOT EXISTS depannhome_partner_connection_sync_source_event_idx ON depannhome_partner_connection_sync_log(source_owner_id, source_event_id, created_at DESC)");
}

export function registerPartnerConnectionRoutes(app, requireAuthentication) {
    app.use("/api/partner-connections", requireAuthentication, requireAdministration);
    app.get("/api/partner-connections", asyncHandler(async (req, res) => { const ownerId = getAccountOwnerId(req); await ensureDirectory(ownerId); res.json({ directory: await directorySettings(ownerId), connections: await loadConnections(ownerId), incomingRequests: await incomingRequests(ownerId) }); }));
    app.get("/api/partner-connections/search", asyncHandler(async (req, res) => res.json({ companies: await searchCompanies(getAccountOwnerId(req), req.query?.q) })));
    app.get("/api/partner-connections/directory/search", asyncHandler(async (req, res) => res.json({ companies: await searchDirectory(getAccountOwnerId(req), req.query || {}) })));
    app.get("/api/partner-connections/directory/professional-search", asyncHandler(async (req, res) => res.json({ companies: await searchProfessionalDirectory(getAccountOwnerId(req), req.query || {}) })));
    app.patch("/api/partner-connections/directory/availability", asyncHandler(async (req, res) => { const availabilityStatus = AVAILABILITY_STATUSES.has(req.body?.availabilityStatus) ? req.body.availabilityStatus : ""; if (!availabilityStatus) return res.status(400).json({ message: "Disponibilité invalide." }); await ensureDirectory(getAccountOwnerId(req)); await getPool().query("UPDATE depannhome_partner_directory SET availability_status=$2,updated_at=NOW() WHERE owner_id=$1", [getAccountOwnerId(req), availabilityStatus]); res.status(204).end(); }));
    app.get("/api/partner-connections/directory/:companyId/logo", asyncHandler(async (req, res) => {
        const companyId = positiveId(req.params.companyId); const logo = companyId && await visibleCompanyLogo(companyId);
        if (!logo?.data) return res.status(404).end();
        res.set({ "Content-Type": logo.mimeType || "application/octet-stream", "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" }).send(logo.data);
    }));
    app.put("/api/partner-connections/directory", asyncHandler(async (req, res) => { const ownerId = getAccountOwnerId(req); await updateDirectory(ownerId, req.body, true); res.status(204).end(); }));
    app.post("/api/partner-connections/requests", asyncHandler(async (req, res) => { const connection = await requestConnection(req, positiveId(req.body?.companyId)); res.status(201).json({ connection }); }));
    app.post("/api/partner-connections/:connectionId/accept", asyncHandler(async (req, res) => res.json({ connection: await respondToRequest(req, positiveId(req.params.connectionId), "connected") })));
    app.post("/api/partner-connections/:connectionId/refuse", asyncHandler(async (req, res) => res.json({ connection: await respondToRequest(req, positiveId(req.params.connectionId), "refused") })));
    app.patch("/api/partner-connections/:connectionId/permissions", asyncHandler(async (req, res) => res.json({ connection: await updatePermissions(req, positiveId(req.params.connectionId)) })));
    app.post("/api/partner-connections/:connectionId/disconnect", asyncHandler(async (req, res) => res.json({ connection: await disconnect(req, positiveId(req.params.connectionId)) })));
    app.get("/api/partner-connections/missions-sent", asyncHandler(async (req, res) => res.json({ missions: await sentMissions(getAccountOwnerId(req)) })));
    app.post("/api/partner-connections/missions", asyncHandler(async (req, res) => {
        const mission = await createConnectedMission(req);
        res.status(201).json({ mission });
    }));
}

export async function synchronizeConnectedAppointment(ownerId, eventId, connectionId = 0) {
    if (!ownerId || !eventId) return;
    const db = getPool();
    const { rows: sourceRows } = await db.query("SELECT id,title,client_name,location,TO_CHAR(event_date,'YYYY-MM-DD') AS date,TO_CHAR(start_time,'HH24:MI') AS \"startTime\",TO_CHAR(end_time,'HH24:MI') AS \"endTime\",notes,event_type FROM depannhome_calendar_events WHERE id=$1 AND owner_id=$2", [eventId, ownerId]);
    const event = sourceRows[0]; if (!event || event.event_type !== "appointment") return;
    const sourceClient = await sourceClientForEvent(db, ownerId, event);
    const sourceCompany = await companyIdentity(ownerId);
    const connections = await activeConnections(ownerId);
    for (const connection of connectionId ? connections.filter(item => Number(item.id) === Number(connectionId)) : connections) {
        const own = ownPermissions(connection, ownerId), partner = partnerPermissions(connection, ownerId);
        if (!own.canSendInterventions || !partner.canReceiveInterventions) continue;
        const targetOwnerId = partnerOwnerId(connection, ownerId); const intakeId = await ensureManagedIntake(targetOwnerId, sourceCompany.name, connection.id);
        const externalMissionId = `dpc-${connection.id}-${event.id}`;
        const mapped = { externalMissionId, partnerReference: `Intervention ${event.id}`, date: event.date, startTime: event.startTime || "", endTime: event.endTime || "", priority: "normal", interventionType: event.title, clientName: event.client_name || sourceClient?.name || "", address: sourceClient?.address || event.location, city: sourceClient?.city || "", phone: sourceClient?.phone || "", email: sourceClient?.email || "", insurance: sourceClient?.insurance || "", claimNumber: sourceClient?.claimNumber || "", expert: sourceClient?.expert || "", manager: sourceClient?.manager || "", description: event.notes, connectionId: connection.id, sourceEventId: event.id };
        const { rows } = await db.query(`INSERT INTO depannhome_partner_missions(owner_id,intake_id,external_mission_id,partner_reference,status,priority,source_data,mapped_data,scheduled_date,scheduled_start_time,scheduled_end_time)
            VALUES($1,$2,$3,$4,'pending_validation','normal',$5::jsonb,$6::jsonb,$7::date,$8::time,$9::time)
            ON CONFLICT(owner_id,intake_id,external_mission_id) DO UPDATE SET source_data=EXCLUDED.source_data,mapped_data=EXCLUDED.mapped_data,scheduled_date=EXCLUDED.scheduled_date,scheduled_start_time=EXCLUDED.scheduled_start_time,scheduled_end_time=EXCLUDED.scheduled_end_time,updated_at=NOW() RETURNING id,(xmax=0) AS inserted`, [targetOwnerId, intakeId, externalMissionId, mapped.partnerReference, JSON.stringify({ managedConnection: true, event }), JSON.stringify(mapped), event.date, event.startTime || null, event.endTime || null]);
        const mission = rows[0]; const client = await provisionPartnerMissionClient(db, targetOwnerId, mapped, { user: { fullName: sourceCompany.name } }); await db.query("UPDATE depannhome_partner_missions SET client_id=$3,updated_at=NOW() WHERE id=$1 AND owner_id=$2", [mission.id, targetOwnerId, client.id]); await db.query("INSERT INTO depannhome_partner_connection_sync_log(connection_id,source_owner_id,target_owner_id,source_event_id,target_mission_id,event_type,details) VALUES($1,$2,$3,$4,$5,'appointment_synced',$6::jsonb)", [connection.id, ownerId, targetOwnerId, event.id, mission.id, JSON.stringify({ inserted: mission.inserted, clientId: client.id, clientCreated: client.created })]);
        await recordMissionDialogueEvent({ ownerId: targetOwnerId, missionId: mission.id, status: mission.inserted ? "received" : "pending_validation", action: mission.inserted ? "received" : "updated", actorName: sourceCompany.name });
        await notifyAdmins(targetOwnerId, "partner_connection_intervention", "Nouvelle intervention partenaire", `${sourceCompany.name} a partagé l’intervention « ${event.title} ».`, { connectionId: connection.id, missionId: mission.id });
    }
}

async function createConnectedMission(req) {
    const ownerId = getAccountOwnerId(req);
    const value = sanitizeConnectedMission(req.body);
    if (!value.ok) throw clientError(400, value.message);
    const connection = await connectionForOwner(value.connectionId, ownerId);
    if (!connection || connection.status !== "connected") throw clientError(404, "Partenaire connecté introuvable.");
    if (!ownPermissions(connection, ownerId).canSendInterventions || !partnerPermissions(connection, ownerId).canReceiveInterventions) {
        throw clientError(403, "Ce partenaire n’est pas autorisé à recevoir des missions.");
    }

    const database = getPool();
    const client = await upsertMissionClient(database, ownerId, value.client, req);
    const { rows } = await database.query(`
        INSERT INTO depannhome_calendar_events
            (owner_id, title, client_name, location, event_date, color, event_type, notes)
        VALUES ($1, $2, $3, $4, $5::date, $6, 'appointment', $7)
        RETURNING id
    `, [ownerId, value.subject, client.name, [client.address, client.city].filter(Boolean).join(", "), value.requestedDate, value.priority === "urgent" ? "red" : value.priority === "high" ? "orange" : "blue", missionNotes(value)]);
    const eventId = rows[0].id;
    await synchronizeConnectedAppointment(ownerId, eventId, connection.id);
    const { rows: synced } = await database.query(`
        SELECT log.target_mission_id AS "missionId", mission.external_mission_id AS "externalMissionId"
        FROM depannhome_partner_connection_sync_log log
        JOIN depannhome_partner_missions mission ON mission.id = log.target_mission_id
        WHERE log.connection_id = $1 AND log.source_owner_id = $2 AND log.source_event_id = $3
        ORDER BY log.created_at DESC LIMIT 1
    `, [connection.id, ownerId, eventId]);
    const targetMission = synced[0];
    if (!targetMission) throw clientError(409, "La mission locale a été créée, mais sa transmission au partenaire n’a pas pu être confirmée.");
    return { id: targetMission.missionId, externalMissionId: targetMission.externalMissionId, calendarEventId: eventId, partner: (await publicConnection(connection, ownerId)).partner, status: "pending_validation" };
}

async function upsertMissionClient(database, ownerId, client, req) {
    if (client.id) {
        const { rows } = await database.query("SELECT client_data AS client FROM depannhome_clients WHERE owner_id=$1 AND client_id=$2", [ownerId, client.id]);
        if (!rows[0]?.client) throw clientError(404, "Client sélectionné introuvable.");
        return rows[0].client;
    }
    const now = new Date().toISOString();
    const id = `client-${crypto.randomUUID()}`;
    const created = { id, type: client.type, name: client.name, phone: client.phone, email: client.email, address: client.address, city: client.city, equipment: "", notes: "", attachments: [], activityHistory: [{ id: `activity-${crypto.randomUUID()}`, type: "partner_mission", label: "Client créé depuis une mission partenaire", actorName: String(req.user.fullName || req.user.username || "Depann’Home Pro").slice(0, 100), createdAt: now }], createdAt: now, updatedAt: now };
    await database.query("INSERT INTO depannhome_clients(owner_id,client_id,client_data,updated_at) VALUES($1,$2,$3::jsonb,NOW())", [ownerId, id, JSON.stringify(created)]);
    return created;
}

async function sourceClientForEvent(database, ownerId, event) {
    if (!event.client_name) return null;
    const { rows } = await database.query("SELECT client_data FROM depannhome_clients WHERE owner_id=$1 AND LOWER(BTRIM(client_data->>'name'))=LOWER(BTRIM($2)) ORDER BY updated_at DESC LIMIT 20", [ownerId, event.client_name]);
    const eventAddress = normalizedText(event.location);
    const candidates = rows.map(row => row.client_data || {}).filter(client => !eventAddress || normalizedText([client.address, client.city].filter(Boolean).join(", ")) === eventAddress || normalizedText(client.address) === eventAddress);
    return candidates.length === 1 ? candidates[0] : null;
}

async function sentMissions(ownerId) {
    const { rows } = await getPool().query(`
        SELECT DISTINCT ON (log.connection_id, log.source_event_id)
            log.connection_id AS "connectionId", log.source_event_id AS "calendarEventId", log.target_mission_id AS id,
            log.created_at AS "sentAt", mission.external_mission_id AS "externalMissionId", mission.partner_reference AS "partnerReference",
            mission.status, mission.priority, mission.mapped_data AS "mappedData", mission.scheduled_date AS "scheduledDate",
            mission.scheduled_start_time AS "scheduledStartTime", mission.scheduled_end_time AS "scheduledEndTime",
            COALESCE(NULLIF(profile.company_name,''),NULLIF(partner.company_name,''),partner.full_name,partner.username) AS "partnerName"
        FROM depannhome_partner_connection_sync_log log
        JOIN depannhome_partner_connections connection ON connection.id=log.connection_id AND connection.status='connected'
        JOIN depannhome_partner_missions mission ON mission.id=log.target_mission_id AND mission.owner_id=log.target_owner_id
        JOIN depannhome_users partner ON partner.id=log.target_owner_id
        LEFT JOIN depannhome_billing_profiles profile ON profile.owner_id=partner.id
        WHERE log.source_owner_id=$1 AND log.event_type='appointment_synced'
        ORDER BY log.connection_id, log.source_event_id, log.created_at DESC
    `, [ownerId]);
    return rows;
}

function sanitizeConnectedMission(value) {
    const connectionId = positiveId(value?.connectionId);
    const subject = clean(value?.subject, 160);
    const interventionType = clean(value?.interventionType, 160);
    const comments = clean(value?.comments, 2000);
    const requestedDate = validDate(value?.requestedDate);
    const priority = ["low", "normal", "high", "urgent"].includes(value?.priority) ? value.priority : "normal";
    const input = value?.client && typeof value.client === "object" ? value.client : {};
    const client = { id: clean(input.id, 100), type: clean(input.type, 80) || "Particulier", name: clean(input.name, 160), phone: clean(input.phone, 50), email: clean(input.email, 160), address: clean(input.address, 255), city: clean(input.city, 100) };
    if (!connectionId) return { ok: false, message: "Choisissez un partenaire connecté." };
    if (!client.id && !client.name) return { ok: false, message: "Choisissez ou créez un client." };
    if (!subject) return { ok: false, message: "L’objet de la mission est obligatoire." };
    if (!requestedDate) return { ok: false, message: "La date souhaitée est invalide." };
    return { ok: true, connectionId, subject, interventionType: interventionType || subject, comments, requestedDate, priority, client };
}

function missionNotes(value) {
    return [
        `Mission partenaire : ${value.subject}`,
        `Type d’intervention : ${value.interventionType}`,
        `Urgence : ${value.priority}`,
        value.comments
    ].filter(Boolean).join("\n").slice(0, 2000);
}

export async function synchronizeConnectedReport(ownerId, reportId) {
    const db = getPool(); const { rows } = await db.query("SELECT id,appointment_id,title,pdf_data,pdf_filename FROM depannhome_technical_reports WHERE id=$1 AND owner_id=$2 AND status='validated'", [reportId, ownerId]); const report = rows[0]; if (!report?.appointment_id) return;
    for (const connection of await activeConnections(ownerId)) {
        if (!ownPermissions(connection, ownerId).canViewReports) continue;
        const targetOwnerId = partnerOwnerId(connection, ownerId); const mission = await connectedMission(connection.id, targetOwnerId, report.appointment_id); if (!mission) continue;
        const canAttach = report.pdf_data && report.pdf_data.length <= 5 * 1024 * 1024;
        if (canAttach) await recordMissionDialogueDocument({ ownerId: targetOwnerId, missionId: mission.id, actorName: (await companyIdentity(ownerId)).name, body: `Rapport partagé : ${report.title || "rapport d’intervention"}.`, attachment: { type: "report", filename: report.pdf_filename || `rapport-${report.id}.pdf`, mimeType: "application/pdf", buffer: report.pdf_data }, partnerVisible: true, eventType: "report_shared" });
        else await recordMissionDialogueEvent({ ownerId: targetOwnerId, missionId: mission.id, status: "report_validated", action: "report_shared", actorName: (await companyIdentity(ownerId)).name, partnerVisible: true });
        await db.query("INSERT INTO depannhome_partner_connection_sync_log(connection_id,source_owner_id,target_owner_id,source_event_id,target_mission_id,event_type,details) VALUES($1,$2,$3,$4,$5,'report_shared',$6::jsonb)", [connection.id, ownerId, targetOwnerId, report.appointment_id, mission.id, JSON.stringify({ reportId })]);
    }
}

export async function synchronizeConnectedBillingDocument(ownerId, documentId) {
    const db = getPool(); const { rows } = await db.query("SELECT * FROM depannhome_billing_documents WHERE id=$1 AND owner_id=$2", [documentId, ownerId]); const document = rows[0]; if (!document?.appointment_id || !["quote", "invoice"].includes(document.document_type)) return;
    const permission = document.document_type === "invoice" ? "canViewInvoices" : "canViewQuotes"; const profile = await loadBillingProfile(ownerId); const source = await companyIdentity(ownerId);
    for (const connection of await activeConnections(ownerId)) {
        if (!ownPermissions(connection, ownerId)[permission]) continue;
        const targetOwnerId = partnerOwnerId(connection, ownerId); const mission = await connectedMission(connection.id, targetOwnerId, document.appointment_id); if (!mission) continue;
        const pdf = await createSharedBillingPdf(document, profile); const label = document.document_type === "invoice" ? "Facture" : "Devis"; await recordMissionDialogueDocument({ ownerId: targetOwnerId, missionId: mission.id, actorName: source.name, body: `${label} partagé : ${document.document_number}.`, attachment: { type: document.document_type, filename: `${document.document_type === "invoice" ? "facture" : "devis"}-${safeName(document.document_number)}.pdf`, mimeType: "application/pdf", buffer: pdf }, partnerVisible: true, eventType: `${document.document_type}_shared` });
        await db.query("INSERT INTO depannhome_partner_connection_sync_log(connection_id,source_owner_id,target_owner_id,source_event_id,target_mission_id,event_type,details) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)", [connection.id, ownerId, targetOwnerId, document.appointment_id, mission.id, `${document.document_type}_shared`, JSON.stringify({ documentId, documentNumber: document.document_number })]);
    }
}

async function requestConnection(req, targetOwnerId) {
    const ownerId = getAccountOwnerId(req); if (!targetOwnerId || targetOwnerId === ownerId) throw clientError(400, "Choisissez une autre entreprise.");
    const target = await listedCompany(targetOwnerId); if (!target) throw clientError(404, "Entreprise introuvable."); await ensureDirectory(ownerId);
    const [low, high] = pair(ownerId, targetOwnerId); const db = getPool(); const { rows } = await db.query(`INSERT INTO depannhome_partner_connections(company_low_id,company_high_id,requester_owner_id,status,permissions_for_low,permissions_for_high)
        VALUES($1,$2,$3,'pending',$4::jsonb,$5::jsonb)
        ON CONFLICT(company_low_id,company_high_id) DO UPDATE SET requester_owner_id=EXCLUDED.requester_owner_id,status='pending',requested_at=NOW(),responded_at=NULL,responded_by=NULL,disconnected_at=NULL,updated_at=NOW()
        RETURNING *`, [low, high, ownerId, JSON.stringify(ownerId === low ? DEFAULT_PERMISSIONS : {}), JSON.stringify(ownerId === high ? DEFAULT_PERMISSIONS : {})]);
    const source = await companyIdentity(ownerId); await notifyAdmins(targetOwnerId, "partner_connection_requested", "Demande de connexion partenaire", `L’entreprise « ${source.name} » souhaite établir une connexion afin d’échanger des interventions.`, { connectionId: rows[0].id }); return publicConnection(rows[0], ownerId);
}
async function respondToRequest(req, id, status) {
    const ownerId = getAccountOwnerId(req); const connection = await connectionForOwner(id, ownerId); if (!connection || connection.status !== "pending" || Number(connection.requester_owner_id) === Number(ownerId)) throw clientError(404, "Demande de connexion introuvable.");
    const permissions = status === "connected" ? sanitizePermissions(req.body?.permissions, DEFAULT_PERMISSIONS) : {};
    const column = Number(connection.company_low_id) === Number(ownerId) ? "permissions_for_low" : "permissions_for_high";
    const { rows } = await getPool().query(`UPDATE depannhome_partner_connections SET status=$3,${column}=$4::jsonb,responded_at=NOW(),responded_by=$5,updated_at=NOW() WHERE id=$1 AND ($2=company_low_id OR $2=company_high_id) RETURNING *`, [id, ownerId, status, JSON.stringify(permissions), req.user.sub]);
    const responder = await companyIdentity(ownerId); const requesterId = Number(connection.requester_owner_id); await notifyAdmins(requesterId, status === "connected" ? "partner_connection_accepted" : "partner_connection_refused", status === "connected" ? "Connexion partenaire acceptée" : "Connexion partenaire refusée", `${responder.name} a ${status === "connected" ? "accepté" : "refusé"} votre demande de connexion.`, { connectionId: id }); return publicConnection(rows[0], ownerId);
}
async function updatePermissions(req, id) { const ownerId = getAccountOwnerId(req); const connection = await connectionForOwner(id, ownerId); if (!connection || connection.status !== "connected") throw clientError(404, "Connexion introuvable."); const column = Number(connection.company_low_id) === Number(ownerId) ? "permissions_for_low" : "permissions_for_high"; const { rows } = await getPool().query(`UPDATE depannhome_partner_connections SET ${column}=$3::jsonb,updated_at=NOW() WHERE id=$1 AND ($2=company_low_id OR $2=company_high_id) RETURNING *`, [id, ownerId, JSON.stringify(sanitizePermissions(req.body?.permissions, ownPermissions(connection, ownerId)))]); return publicConnection(rows[0], ownerId); }
async function disconnect(req, id) { const ownerId = getAccountOwnerId(req); const { rows } = await getPool().query("UPDATE depannhome_partner_connections SET status='disconnected',disconnected_at=NOW(),updated_at=NOW() WHERE id=$1 AND ($2=company_low_id OR $2=company_high_id) RETURNING *", [id, ownerId]); if (!rows[0]) throw clientError(404, "Connexion introuvable."); const partnerId = partnerOwnerId(rows[0], ownerId); const source = await companyIdentity(ownerId); await notifyAdmins(partnerId, "partner_connection_disconnected", "Connexion partenaire interrompue", `${source.name} a interrompu la connexion partenaire.`, { connectionId: id }); return publicConnection(rows[0], ownerId); }
async function loadConnections(ownerId) { const { rows } = await getPool().query("SELECT * FROM depannhome_partner_connections WHERE company_low_id=$1 OR company_high_id=$1 ORDER BY updated_at DESC", [ownerId]); return Promise.all(rows.map(row => publicConnection(row, ownerId))); }
async function incomingRequests(ownerId) { const { rows } = await getPool().query("SELECT * FROM depannhome_partner_connections WHERE status='pending' AND requester_owner_id<>$1 AND (company_low_id=$1 OR company_high_id=$1) ORDER BY requested_at DESC", [ownerId]); return Promise.all(rows.map(row => publicConnection(row, ownerId))); }
async function publicConnection(row, ownerId) { const partnerId = partnerOwnerId(row, ownerId); const partner = await companyIdentity(partnerId); const { rows: last } = await getPool().query("SELECT created_at AS \"createdAt\" FROM depannhome_partner_connection_sync_log WHERE connection_id=$1 AND (source_owner_id=$2 OR target_owner_id=$2) ORDER BY created_at DESC LIMIT 1", [row.id, ownerId]); return { id: row.id, partner: { id: partnerId, name: partner.name, siren: partner.siren, siret: partner.siret, city: partner.city, postalCode: partner.postalCode, department: String(partner.postalCode || "").slice(0, 2), hasLogo: Boolean(partner.hasLogo), interfaceType: partner.interfaceType, organizationBadge: organizationBadge(partner.interfaceType) }, status: STATES.has(row.status) ? row.status : "pending", isRequester: Number(row.requester_owner_id) === Number(ownerId), permissions: ownPermissions(row, ownerId), requestedAt: row.requested_at, respondedAt: row.responded_at, updatedAt: row.updated_at, lastSynchronizedAt: last[0]?.createdAt || null }; }
async function searchCompanies(ownerId, value) { return searchDirectory(ownerId, { q: value }); }
async function searchDirectory(ownerId, query) {
    const filters = directorySearchFilters(query);
    if (!filters.hasQuery) return [];
    const { rows } = await getPool().query(`
        SELECT owner.id,COALESCE(NULLIF(profile.company_name,''),NULLIF(owner.company_name,''),owner.full_name,owner.username) AS name,
            COALESCE(profile.siren,'') AS siren,COALESCE(profile.registration_number,'') AS siret,COALESCE(profile.city,'') AS city,
            COALESCE(profile.postal_code,'') AS "postalCode",directory.description,directory.trades AS "trades",
            directory.supported_brands AS "supportedBrands",directory.specialties,directory.service_area AS "serviceArea",
            directory.service_radius_km AS "serviceRadiusKm",directory.departments,directory.opening_hours AS "openingHours",
            directory.website,directory.accepts_partner_missions AS "acceptsPartnerMissions",COALESCE(organization.interface_type,'standard') AS "interfaceType",
            (profile.logo_data IS NOT NULL) AS "hasLogo",
            CASE WHEN directory.share_phone THEN COALESCE(profile.phone,'') ELSE '' END AS phone,
            CASE WHEN directory.share_email THEN COALESCE(profile.email,'') ELSE '' END AS email,
            CASE WHEN $9::numeric IS NOT NULL AND $10::numeric IS NOT NULL AND directory.latitude IS NOT NULL AND directory.longitude IS NOT NULL
                THEN 6371 * acos(LEAST(1,cos(radians($9::numeric))*cos(radians(directory.latitude))*cos(radians(directory.longitude)-radians($10::numeric))+sin(radians($9::numeric))*sin(radians(directory.latitude)))) END AS "distanceKm"
        FROM depannhome_partner_directory directory
        JOIN depannhome_users owner ON owner.id=directory.owner_id
        LEFT JOIN depannhome_billing_profiles profile ON profile.owner_id=owner.id
        LEFT JOIN depannhome_organizations organization ON organization.account_owner_id=owner.id
        WHERE directory.is_listed=TRUE AND directory.creator_suspended=FALSE AND owner.is_active=TRUE AND owner.account_owner_id=owner.id AND owner.id<>$1
          AND ($2='' OR COALESCE(profile.company_name,owner.company_name,'') ILIKE '%' || $2 || '%' OR COALESCE(profile.siren,'') ILIKE '%' || $2 || '%' OR COALESCE(profile.registration_number,'') ILIKE '%' || $2 || '%')
          AND ($3='' OR COALESCE(profile.city,'') ILIKE '%' || $3 || '%')
          AND ($4='' OR COALESCE(profile.postal_code,'') ILIKE '%' || $4 || '%')
          AND ($5='' OR directory.trades::text ILIKE '%' || $5 || '%' OR directory.specialties::text ILIKE '%' || $5 || '%')
          AND ($6='' OR directory.supported_brands::text ILIKE '%' || $6 || '%')
          AND ($7='' OR directory.departments::text ILIKE '%' || $7 || '%')
          AND ($8='' OR directory.specialties::text ILIKE '%' || $8 || '%')
        ORDER BY "distanceKm" NULLS LAST,LOWER(COALESCE(NULLIF(profile.company_name,''),NULLIF(owner.company_name,''),owner.username)) LIMIT 50`, [ownerId, filters.name, filters.city, filters.postalCode, filters.trade, filters.brand, filters.department, filters.specialty, filters.latitude, filters.longitude]);
    return rows.filter(row => filters.radiusKm <= 0 || (row.distanceKm !== null && Number(row.distanceKm) <= filters.radiusKm)).map(publicDirectoryCompany);
}
async function searchProfessionalDirectory(ownerId, query) {
    const filters = professionalDirectoryFilters(query);
    const orderBy = { name_asc: "LOWER(display_name) ASC", name_desc: "LOWER(display_name) DESC", distance: "distance_km NULLS LAST, LOWER(display_name) ASC", department: "primary_department ASC NULLS LAST, LOWER(display_name) ASC", registration: "registered_at DESC", activity: "last_activity_at DESC" }[filters.sort] || "LOWER(display_name) ASC";
    const { rows } = await getPool().query(`SELECT * FROM (
        SELECT owner.id,COALESCE(NULLIF(directory.commercial_name,''),NULLIF(profile.company_name,''),NULLIF(owner.company_name,''),owner.full_name,owner.username) AS display_name,
            COALESCE(NULLIF(profile.company_name,''),NULLIF(owner.company_name,''),owner.full_name,owner.username) AS legal_name,
            COALESCE(profile.siren,'') AS siren,COALESCE(profile.registration_number,'') AS siret,COALESCE(profile.city,'') AS city,COALESCE(profile.postal_code,'') AS postal_code,
            directory.description,directory.trades,directory.supported_brands,directory.specialties,directory.service_area,directory.service_radius_km,directory.departments,directory.opening_hours,directory.website,
            directory.accepts_partner_missions,directory.availability_status,directory.commercial_name,directory.region,directory.regions,directory.coverage_mode,COALESCE(organization.interface_type,'standard') AS interface_type,
            (profile.logo_data IS NOT NULL) AS has_logo,CASE WHEN directory.share_phone THEN COALESCE(profile.phone,'') ELSE '' END AS phone,CASE WHEN directory.share_email THEN COALESCE(profile.email,'') ELSE '' END AS email,
            connection.status AS connection_status,connection.requester_owner_id,group_company.group_id IS NOT NULL AS is_group,owner.created_at AS registered_at,directory.updated_at AS last_activity_at,
            NULLIF(directory.departments->>0,'') AS primary_department,
            CASE WHEN $10::numeric IS NOT NULL AND $11::numeric IS NOT NULL AND directory.latitude IS NOT NULL AND directory.longitude IS NOT NULL THEN 6371 * acos(LEAST(1,cos(radians($10::numeric))*cos(radians(directory.latitude))*cos(radians(directory.longitude)-radians($11::numeric))+sin(radians($10::numeric))*sin(radians(directory.latitude)))) END AS distance_km
        FROM depannhome_partner_directory directory
        JOIN depannhome_users owner ON owner.id=directory.owner_id
        LEFT JOIN depannhome_billing_profiles profile ON profile.owner_id=owner.id
        LEFT JOIN depannhome_organizations organization ON organization.account_owner_id=owner.id
        LEFT JOIN depannhome_group_companies group_company ON group_company.company_owner_id=owner.id AND group_company.is_active=TRUE
        LEFT JOIN depannhome_partner_connections connection ON connection.company_low_id=LEAST(owner.id,$1::bigint) AND connection.company_high_id=GREATEST(owner.id,$1::bigint)
        WHERE directory.is_listed=TRUE AND directory.creator_suspended=FALSE AND owner.is_active=TRUE AND owner.account_owner_id=owner.id AND owner.id<>$1
          AND ($2='' OR COALESCE(directory.commercial_name,'') ILIKE '%' || $2 || '%' OR COALESCE(profile.company_name,owner.company_name,'') ILIKE '%' || $2 || '%' OR COALESCE(profile.city,'') ILIKE '%' || $2 || '%' OR COALESCE(profile.postal_code,'') ILIKE '%' || $2 || '%' OR directory.region ILIKE '%' || $2 || '%' OR directory.service_area ILIKE '%' || $2 || '%' OR directory.departments::text ILIKE '%' || $2 || '%' OR directory.trades::text ILIKE '%' || $2 || '%' OR directory.specialties::text ILIKE '%' || $2 || '%' OR directory.supported_brands::text ILIKE '%' || $2 || '%' OR COALESCE(profile.registration_number,'') ILIKE '%' || $2 || '%')
          AND ($3='' OR directory.region ILIKE '%' || $3 || '%' OR directory.regions::text ILIKE '%' || $3 || '%' OR directory.service_area ILIKE '%' || $3 || '%')
          AND ($4='' OR directory.departments::text ILIKE '%' || $4 || '%' OR COALESCE(profile.postal_code,'') ILIKE '%' || $4 || '%')
          AND ($5='all' OR directory.availability_status=$5)
          AND ($6='all' OR ($6='new' AND (connection.status IS NULL OR connection.status IN ('refused','disconnected'))) OR ($6<>'new' AND connection.status=$6))
          AND ($7='all' OR ($7='group' AND group_company.group_id IS NOT NULL) OR ($7='independent' AND group_company.group_id IS NULL))
          AND (cardinality($8::text[])=0 OR EXISTS(SELECT 1 FROM unnest($8::text[]) AS activity WHERE directory.trades::text ILIKE '%' || activity || '%' OR directory.specialties::text ILIKE '%' || activity || '%'))
          AND ($9=FALSE OR directory.accepts_partner_missions=TRUE)
    ) directory_result WHERE ($12::numeric<=0 OR distance_km<=$12::numeric) ORDER BY ${orderBy} LIMIT 200`, [ownerId, filters.query, filters.region, filters.department, filters.availability, filters.partnership, filters.groupMode, filters.activities, filters.acceptsMissions, filters.latitude, filters.longitude, filters.radiusKm]);
    return rows.map(row => publicProfessionalDirectoryCompany(row, ownerId));
}
async function ensureDirectory(ownerId) { await getPool().query("INSERT INTO depannhome_partner_directory(owner_id) VALUES($1) ON CONFLICT(owner_id) DO NOTHING", [ownerId]); }
async function directorySettings(ownerId) { const { rows } = await getPool().query(`SELECT is_listed AS "isListed",description,trades,supported_brands AS "supportedBrands",specialties,service_area AS "serviceArea",service_radius_km AS "serviceRadiusKm",departments,opening_hours AS "openingHours",share_phone AS "sharePhone",share_email AS "shareEmail",website,accepts_partner_missions AS "acceptsPartnerMissions",availability_status AS "availabilityStatus",commercial_name AS "commercialName",region,regions,coverage_mode AS "coverageMode",latitude::float AS latitude,longitude::float AS longitude FROM depannhome_partner_directory WHERE owner_id=$1`, [ownerId]); return rows[0] || emptyDirectory(); }
async function updateDirectory(ownerId, value, companyControlled) {
    await ensureDirectory(ownerId); const profile = sanitizeDirectory(value, companyControlled);
    if (!profile.ok) throw clientError(400, profile.message);
    await getPool().query(`UPDATE depannhome_partner_directory SET is_listed=$2,visibility_explicit=TRUE,description=$3,trades=$4::jsonb,supported_brands=$5::jsonb,specialties=$6::jsonb,service_area=$7,service_radius_km=$8,departments=$9::jsonb,opening_hours=$10,share_phone=$11,share_email=$12,website=$13,accepts_partner_missions=$14,availability_status=CASE WHEN NOT $14 THEN 'temporarily_unavailable' WHEN $15='' THEN availability_status ELSE $15 END,commercial_name=CASE WHEN $16='' THEN commercial_name ELSE $16 END,region=CASE WHEN $17='' THEN region ELSE $17 END,regions=$18::jsonb,coverage_mode=$19,latitude=$20,longitude=$21,updated_at=NOW() WHERE owner_id=$1`, [ownerId, profile.isListed, profile.description, JSON.stringify(profile.trades), JSON.stringify(profile.supportedBrands), JSON.stringify(profile.specialties), profile.serviceArea, profile.serviceRadiusKm, JSON.stringify(profile.departments), profile.openingHours, profile.sharePhone, profile.shareEmail, profile.website, profile.acceptsPartnerMissions, profile.availabilityStatus, profile.commercialName, profile.region, JSON.stringify(profile.regions), profile.coverageMode, profile.latitude, profile.longitude]);
}
async function listedCompany(ownerId) { const { rows } = await getPool().query("SELECT directory.owner_id FROM depannhome_partner_directory directory JOIN depannhome_users owner ON owner.id=directory.owner_id WHERE directory.owner_id=$1 AND directory.is_listed=TRUE AND directory.creator_suspended=FALSE AND owner.is_active=TRUE", [ownerId]); return rows[0] || null; }
async function visibleCompanyLogo(ownerId) { const { rows } = await getPool().query("SELECT profile.logo_data AS data,profile.logo_mime_type AS \"mimeType\" FROM depannhome_partner_directory directory JOIN depannhome_users owner ON owner.id=directory.owner_id JOIN depannhome_billing_profiles profile ON profile.owner_id=owner.id WHERE directory.owner_id=$1 AND directory.is_listed=TRUE AND directory.creator_suspended=FALSE AND owner.is_active=TRUE", [ownerId]); return rows[0] || null; }
async function companyIdentity(ownerId) { const { rows } = await getPool().query("SELECT COALESCE(NULLIF(profile.company_name,''),NULLIF(owner.company_name,''),NULLIF(owner.full_name,''),owner.username) AS name,COALESCE(profile.siren,'') AS siren,COALESCE(profile.registration_number,'') AS siret,COALESCE(profile.city,'') AS city,COALESCE(profile.postal_code,'') AS \"postalCode\",(profile.logo_data IS NOT NULL) AS \"hasLogo\",COALESCE(organization.interface_type,'standard') AS \"interfaceType\" FROM depannhome_users owner LEFT JOIN depannhome_billing_profiles profile ON profile.owner_id=owner.id LEFT JOIN depannhome_organizations organization ON organization.account_owner_id=owner.id WHERE owner.id=$1", [ownerId]); return rows[0] || { name: "Organisation partenaire", siren: "", siret: "", city: "", postalCode: "", hasLogo: false, interfaceType: "partner" }; }
async function activeConnections(ownerId) { const { rows } = await getPool().query("SELECT * FROM depannhome_partner_connections WHERE status='connected' AND (company_low_id=$1 OR company_high_id=$1)", [ownerId]); return rows; }
async function connectionForOwner(id, ownerId) { if (!id) return null; const { rows } = await getPool().query("SELECT * FROM depannhome_partner_connections WHERE id=$1 AND ($2=company_low_id OR $2=company_high_id)", [id, ownerId]); return rows[0] || null; }
async function ensureManagedIntake(ownerId, partnerName, connectionId) { const key = `connection-${connectionId}`; const secretHash = crypto.createHash("sha256").update(`managed:${connectionId}:${ownerId}`).digest("hex"); const { rows } = await getPool().query("INSERT INTO depannhome_partner_intakes(owner_id,partner_key,partner_name,api_key_hash,assignment_mode,rules,enabled) VALUES($1,$2,$3,$4,'manual',$5::jsonb,TRUE) ON CONFLICT(owner_id,partner_key) DO UPDATE SET partner_name=EXCLUDED.partner_name,enabled=TRUE,updated_at=NOW() RETURNING id", [ownerId, key, partnerName, secretHash, JSON.stringify({ managedBy: "partner_connections", connectionId })]); return rows[0].id; }
async function connectedMission(connectionId, targetOwnerId, sourceEventId) { const { rows } = await getPool().query("SELECT mission.id FROM depannhome_partner_missions mission JOIN depannhome_partner_intakes intake ON intake.id=mission.intake_id WHERE mission.owner_id=$1 AND intake.partner_key=$2 AND mission.mapped_data->>'sourceEventId'=$3 LIMIT 1", [targetOwnerId, `connection-${connectionId}`, String(sourceEventId)]); return rows[0] || null; }
async function loadBillingProfile(ownerId) { const { rows } = await getPool().query("SELECT company_name AS \"companyName\",legal_form AS \"legalForm\",address,postal_code AS \"postalCode\",city,phone,email,registration_number AS \"registrationNumber\",siren,tax_number AS \"taxNumber\",bank_iban AS \"bankIban\",bank_bic AS \"bankBic\",payment_terms AS \"paymentTerms\",deposit_terms AS \"depositTerms\",footer_note AS \"footerNote\",logo_data AS \"logoData\",logo_mime_type AS \"logoMimeType\" FROM depannhome_billing_profiles WHERE owner_id=$1", [ownerId]); return rows[0] || {}; }
async function createSharedBillingPdf(document, profile) { const { createBillingPdf } = await import("./billing.js"); return createBillingPdf({ documentType: document.document_type, documentNumber: document.document_number, customerName: document.customer_name, customerAddress: document.customer_address, issueDate: String(document.issue_date).slice(0, 10), dueDate: document.due_date ? String(document.due_date).slice(0, 10) : "", quoteReference: document.quote_reference, lines: document.lines || [], notes: document.notes, financialData: document.financial_data || {} }, profile); }
async function notifyAdmins(ownerId, eventType, title, body, payload) { const { rows } = await getPool().query("SELECT id FROM depannhome_users WHERE account_owner_id=$1 AND role='admin' AND is_active=TRUE", [ownerId]); await Promise.all(rows.map(row => createNotification(ownerId, row.id, eventType, { entityType: "partner_connection", entityId: String(payload.connectionId || "") }, title, body, payload))); }
export async function creatorNetworkDirectory(query = "") {
    const needle = clean(query, 160); const { rows } = await getPool().query(`SELECT owner.id,COALESCE(NULLIF(profile.company_name,''),NULLIF(owner.company_name,''),owner.full_name,owner.username) AS "companyName",owner.is_active AS "accountActive",directory.is_listed AS "isListed",directory.creator_suspended AS "creatorSuspended",directory.description,directory.trades,directory.supported_brands AS "supportedBrands",directory.specialties,directory.service_area AS "serviceArea",directory.service_radius_km AS "serviceRadiusKm",directory.departments,directory.opening_hours AS "openingHours",directory.website,directory.accepts_partner_missions AS "acceptsPartnerMissions",directory.creator_note AS "creatorNote",directory.updated_at AS "updatedAt",COALESCE(profile.city,'') AS city,COALESCE(profile.postal_code,'') AS "postalCode",(profile.logo_data IS NOT NULL) AS "hasLogo",COALESCE(organization.interface_type,'standard') AS "interfaceType" FROM depannhome_partner_directory directory JOIN depannhome_users owner ON owner.id=directory.owner_id LEFT JOIN depannhome_billing_profiles profile ON profile.owner_id=owner.id LEFT JOIN depannhome_organizations organization ON organization.account_owner_id=owner.id WHERE ($1='' OR COALESCE(profile.company_name,owner.company_name,'') ILIKE '%' || $1 || '%' OR COALESCE(profile.city,'') ILIKE '%' || $1 || '%' OR COALESCE(profile.postal_code,'') ILIKE '%' || $1 || '%') ORDER BY directory.creator_suspended DESC,directory.is_listed DESC,LOWER(COALESCE(NULLIF(profile.company_name,''),NULLIF(owner.company_name,''),owner.username)) LIMIT 200`, [needle]);
    return rows.map(company => ({ ...company, organizationBadge: organizationBadge(company.interfaceType) }));
}
export async function creatorNetworkStatistics() { const { rows } = await getPool().query(`SELECT COUNT(*)::int AS "registeredCompanies",COUNT(*) FILTER (WHERE is_listed AND NOT creator_suspended)::int AS "visibleCompanies",COUNT(*) FILTER (WHERE creator_suspended)::int AS "suspendedCompanies",COUNT(*) FILTER (WHERE accepts_partner_missions AND is_listed AND NOT creator_suspended)::int AS "missionReadyCompanies" FROM depannhome_partner_directory`); const connections = await getPool().query("SELECT COUNT(*)::int AS connected FROM depannhome_partner_connections WHERE status='connected'"); return { ...(rows[0] || {}), connectedPairs: connections.rows[0]?.connected || 0 }; }
export async function updateCreatorNetworkDirectory(ownerId, value) {
    await ensureDirectory(ownerId); const profile = sanitizeDirectory(value, false); if (!profile.ok) throw clientError(400, profile.message);
    await getPool().query(`UPDATE depannhome_partner_directory SET is_listed=$2,visibility_explicit=TRUE,description=$3,trades=$4::jsonb,supported_brands=$5::jsonb,specialties=$6::jsonb,service_area=$7,service_radius_km=$8,departments=$9::jsonb,opening_hours=$10,website=$11,accepts_partner_missions=$12,latitude=$13,longitude=$14,creator_suspended=$15,creator_note=$16,updated_at=NOW() WHERE owner_id=$1`, [ownerId, profile.isListed, profile.description, JSON.stringify(profile.trades), JSON.stringify(profile.supportedBrands), JSON.stringify(profile.specialties), profile.serviceArea, profile.serviceRadiusKm, JSON.stringify(profile.departments), profile.openingHours, profile.website, profile.acceptsPartnerMissions, profile.latitude, profile.longitude, Boolean(value?.creatorSuspended), clean(value?.creatorNote, 1000)]);
}
function ownPermissions(connection, ownerId) { const value = Number(connection.company_low_id) === Number(ownerId) ? connection.permissions_for_low : connection.permissions_for_high; return sanitizePermissions(value, DEFAULT_PERMISSIONS); }
function partnerPermissions(connection, ownerId) { const value = Number(connection.company_low_id) === Number(ownerId) ? connection.permissions_for_high : connection.permissions_for_low; return sanitizePermissions(value, DEFAULT_PERMISSIONS); }
function partnerOwnerId(connection, ownerId) { return Number(connection.company_low_id) === Number(ownerId) ? Number(connection.company_high_id) : Number(connection.company_low_id); }
function sanitizePermissions(value, fallback = DEFAULT_PERMISSIONS) { const input = value && typeof value === "object" && !Array.isArray(value) ? value : {}; return Object.fromEntries(PERMISSION_KEYS.map(key => [key, typeof input[key] === "boolean" ? input[key] : Boolean(fallback[key])])); }
function pair(one, two) { return one < two ? [one, two] : [two, one]; }
function emptyDirectory() { return { isListed: false, description: "", trades: [], supportedBrands: [], specialties: [], serviceArea: "", serviceRadiusKm: 0, departments: [], openingHours: "", sharePhone: false, shareEmail: false, website: "", acceptsPartnerMissions: false, availabilityStatus: "available", commercialName: "", region: "", regions: [], coverageMode: "custom", latitude: null, longitude: null }; }
function professionalDirectoryFilters(value) { const number = input => Number.isFinite(Number(input)) ? Number(input) : null; const list = input => [...new Set(String(input || "").split("|").map(item => clean(item, 80)).filter(Boolean))].slice(0, 20); return { query: clean(value?.q, 160), region: clean(value?.region, 100), department: clean(value?.department, 10), availability: AVAILABILITY_STATUSES.has(value?.availability) ? value.availability : "all", partnership: ["all", "connected", "pending", "new"].includes(value?.partnership) ? value.partnership : "all", groupMode: ["all", "group", "independent"].includes(value?.groupMode) ? value.groupMode : "all", activities: list(value?.activities), acceptsMissions: value?.acceptsMissions === "true", radiusKm: Math.min(500, Math.max(0, Math.round(number(value?.radiusKm) || 0))), latitude: number(value?.latitude), longitude: number(value?.longitude), sort: ["name_asc", "name_desc", "distance", "department", "registration", "activity"].includes(value?.sort) ? value.sort : "name_asc" }; }
function publicProfessionalDirectoryCompany(row, ownerId) { const connectionStatus = STATES.has(row.connection_status) ? row.connection_status : "new"; const interfaceType = ["partner", "standard", "group"].includes(row.interface_type) ? row.interface_type : "standard"; return { id: String(row.id), name: row.display_name || "Organisation Depann’Home Pro", legalName: row.legal_name || "", commercialName: row.commercial_name || "", city: row.city || "", postalCode: row.postal_code || "", department: row.primary_department || String(row.postal_code || "").slice(0, 2), region: row.region || "", regions: jsonList(row.regions), coverageMode: row.coverage_mode || "custom", description: row.description || "", trades: jsonList(row.trades), supportedBrands: jsonList(row.supported_brands), specialties: jsonList(row.specialties), serviceArea: row.service_area || "", serviceRadiusKm: Number(row.service_radius_km) || 0, departments: jsonList(row.departments), openingHours: row.opening_hours || "", availabilityStatus: AVAILABILITY_STATUSES.has(row.availability_status) ? row.availability_status : "available", acceptsPartnerMissions: Boolean(row.accepts_partner_missions), phone: row.phone || "", email: row.email || "", website: row.website || "", hasLogo: Boolean(row.has_logo), interfaceType, organizationBadge: organizationBadge(interfaceType), isGroup: Boolean(row.is_group), connectionStatus, isRequester: String(row.requester_owner_id || "") === String(ownerId), distanceKm: row.distance_km === null || row.distance_km === undefined ? null : Math.round(Number(row.distance_km) * 10) / 10, registeredAt: row.registered_at, lastActivityAt: row.last_activity_at }; }
function directorySearchFilters(value) { const number = input => Number.isFinite(Number(input)) ? Number(input) : null; const filters = { name: clean(value?.q || value?.name, 160), trade: clean(value?.trade, 100), brand: clean(value?.brand, 100), department: clean(value?.department, 10), city: clean(value?.city || value?.municipality, 100), postalCode: clean(value?.postalCode, 20), specialty: clean(value?.specialty, 100), radiusKm: Math.min(500, Math.max(0, Math.round(number(value?.radiusKm) || 0))), latitude: number(value?.latitude), longitude: number(value?.longitude) }; filters.hasQuery = Boolean(filters.name || filters.trade || filters.brand || filters.department || filters.city || filters.postalCode || filters.specialty); return filters; }
function publicDirectoryCompany(row) { const interfaceType = ["partner","standard","group"].includes(row.interfaceType) ? row.interfaceType : "standard"; return { id: String(row.id), name: row.name || "Organisation Depann’Home Pro", siren: row.siren || "", siret: row.siret || "", city: row.city || "", postalCode: row.postalCode || "", description: row.description || "", trades: jsonList(row.trades), supportedBrands: jsonList(row.supportedBrands), specialties: jsonList(row.specialties), serviceArea: row.serviceArea || "", serviceRadiusKm: Number(row.serviceRadiusKm) || 0, departments: jsonList(row.departments), openingHours: row.openingHours || "", website: row.website || "", acceptsPartnerMissions: Boolean(row.acceptsPartnerMissions), hasLogo: Boolean(row.hasLogo), phone: row.phone || "", email: row.email || "", interfaceType, organizationBadge: organizationBadge(interfaceType), distanceKm: row.distanceKm === null || row.distanceKm === undefined ? null : Math.round(Number(row.distanceKm) * 10) / 10 }; }
function sanitizeDirectory(value, companyControlled) { const base = emptyDirectory(); const isListed = typeof value?.isListed === "boolean" ? value.isListed : base.isListed; const website = clean(value?.website, 500); const serviceRadiusKm = Math.min(500, Math.max(0, Math.round(Number(value?.serviceRadiusKm) || 0))); const latitude = coordinate(value?.latitude, -90, 90); const longitude = coordinate(value?.longitude, -180, 180); if (website && !/^https?:\/\/[^\s]+$/i.test(website)) return { ok: false, message: "Le site internet doit commencer par http:// or https://." }; if ((latitude === null) !== (longitude === null)) return { ok: false, message: "Les deux coordonnées géographiques doivent être renseignées ensemble." }; return { ok: true, isListed, description: clean(value?.description, 1000), trades: stringList(value?.trades, 30, 80), supportedBrands: stringList(value?.supportedBrands, 50, 80), specialties: stringList(value?.specialties, 30, 80), serviceArea: clean(value?.serviceArea, 500), serviceRadiusKm, departments: stringList(value?.departments, 30, 10), openingHours: clean(value?.openingHours, 1000), sharePhone: companyControlled && Boolean(value?.sharePhone), shareEmail: companyControlled && Boolean(value?.shareEmail), website, acceptsPartnerMissions: Boolean(value?.acceptsPartnerMissions), availabilityStatus: AVAILABILITY_STATUSES.has(value?.availabilityStatus) ? value.availabilityStatus : "", commercialName: clean(value?.commercialName, 160), region: clean(value?.region, 100), regions: stringList(value?.regions, 20, 100), coverageMode: ["france", "departments", "regions", "radius", "custom"].includes(value?.coverageMode) ? value.coverageMode : "custom", latitude, longitude }; }
function stringList(value, maximumItems, maximumLength) { const values = Array.isArray(value) ? value : String(value || "").split(/[,;\n]/); return [...new Set(values.map(item => clean(item, maximumLength)).filter(Boolean))].slice(0, maximumItems); }
function jsonList(value) { return Array.isArray(value) ? value.map(item => clean(item, 100)).filter(Boolean) : []; }
function coordinate(value, minimum, maximum) { if (value === "" || value === null || value === undefined) return null; const number = Number(value); return Number.isFinite(number) && number >= minimum && number <= maximum ? Math.round(number * 1000000) / 1000000 : null; }
function clean(value, max) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, max); }
function normalizedText(value) { return clean(value, 500).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function safeName(value) { return clean(value, 80).replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "document"; }
function positiveId(value) { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : 0; }
function validDate(value) { const date = String(value || "").slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(new Date(`${date}T12:00:00`).getTime()) ? date : ""; }
function requireAdministration(req, res, next) { return ["admin", "pc_standard"].includes(req.user?.role) ? next() : res.status(403).json({ message: "La gestion des partenaires est réservée aux postes PC autorisés." }); }
function clientError(status, message) { const error = new Error(message); error.status = status; return error; }
function asyncHandler(handler) { return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(error => error.status ? res.status(error.status).json({ message: error.message }) : next(error)); }
