import { getPool } from "./database.js";
import { getAccountOwnerId } from "./auth.js";
import { randomUUID } from "node:crypto";
import PDFDocument from "pdfkit";
import { synchronizeConnectedAppointment } from "./partner-connections.js";
import { PDF_MIME, renderCompanyTemplate } from "./company-document-template.js";

const EVENT_COLORS = new Set(["blue", "green", "orange", "red", "purple", "gray"]);
const EVENT_TYPES = new Set(["appointment", "task", "vacation", "sick_leave", "unavailable"]);
const QUITUS_STATUS = new Set(["pending", "validated"]);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_CLIENT_PAYLOAD_SIZE = 20 * 1024 * 1024;
const MAX_CLIENT_ATTACHMENTS = 30;
const MAX_ACTIVITY_HISTORY = 150;

export async function initializeCalendar() {
    const database = getPool();
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_calendar_events (
            id BIGSERIAL PRIMARY KEY,
            owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            assigned_technician_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
            title VARCHAR(160) NOT NULL,
            client_id VARCHAR(100) NOT NULL DEFAULT '',
            client_name VARCHAR(160) NOT NULL DEFAULT '',
            location VARCHAR(255) NOT NULL DEFAULT '',
            event_date DATE NOT NULL,
            start_time TIME,
            end_time TIME,
            color VARCHAR(20) NOT NULL DEFAULT 'blue',
            event_type VARCHAR(20) NOT NULL DEFAULT 'appointment',
            event_origin VARCHAR(30) NOT NULL DEFAULT 'standard',
            partner_connection_id BIGINT,
            partner_mission_id BIGINT,
            quitus_status VARCHAR(20) NOT NULL DEFAULT 'pending',
            quitus_signed_by VARCHAR(160) NOT NULL DEFAULT '',
            quitus_signature TEXT NOT NULL DEFAULT '',
            quitus_signed_at TIMESTAMPTZ,
            notes VARCHAR(2000) NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT depannhome_calendar_events_color_check
                CHECK (color IN ('blue', 'green', 'orange', 'red', 'purple', 'gray')),
            CONSTRAINT depannhome_calendar_events_time_check
                CHECK (end_time IS NULL OR start_time IS NULL OR end_time >= start_time)
        )
    `);
    await database.query(`
        ALTER TABLE depannhome_calendar_events
        ADD COLUMN IF NOT EXISTS assigned_technician_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL
    `);
    await database.query("ALTER TABLE depannhome_calendar_events ADD COLUMN IF NOT EXISTS client_id VARCHAR(100) NOT NULL DEFAULT ''");
    await database.query(`
        ALTER TABLE depannhome_calendar_events
        ADD COLUMN IF NOT EXISTS event_type VARCHAR(20) NOT NULL DEFAULT 'appointment'
    `);
    await database.query(`
        ALTER TABLE depannhome_calendar_events
        ADD COLUMN IF NOT EXISTS event_origin VARCHAR(30) NOT NULL DEFAULT 'standard',
        ADD COLUMN IF NOT EXISTS partner_connection_id BIGINT,
        ADD COLUMN IF NOT EXISTS partner_mission_id BIGINT
    `);
    await database.query("UPDATE depannhome_calendar_events SET event_origin='standard' WHERE event_origin IS NULL OR event_origin NOT IN ('standard','partner_mission')");
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_calendar_events_partner_origin_idx ON depannhome_calendar_events(owner_id,event_origin,partner_connection_id)");
    await database.query(`
        ALTER TABLE depannhome_calendar_events
        ADD COLUMN IF NOT EXISTS quitus_status VARCHAR(20) NOT NULL DEFAULT 'pending',
        ADD COLUMN IF NOT EXISTS quitus_signed_by VARCHAR(160) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS quitus_signature TEXT NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS quitus_signed_at TIMESTAMPTZ
    `);
    await database.query(`
        UPDATE depannhome_calendar_events
        SET quitus_status = 'validated'
        WHERE quitus_status = 'signed'
    `);
    await database.query(`
        CREATE INDEX IF NOT EXISTS depannhome_calendar_events_owner_date_idx
        ON depannhome_calendar_events (owner_id, event_date, start_time)
    `);
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_calendar_assignments (
            event_id BIGINT NOT NULL REFERENCES depannhome_calendar_events(id) ON DELETE CASCADE,
            technician_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            is_primary BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (event_id, technician_id)
        )
    `);
    await database.query(`
        CREATE INDEX IF NOT EXISTS depannhome_calendar_assignments_technician_idx
        ON depannhome_calendar_assignments (technician_id, event_id)
    `);
    await database.query(`
        INSERT INTO depannhome_calendar_assignments (event_id, technician_id, is_primary)
        SELECT id, assigned_technician_id, TRUE
        FROM depannhome_calendar_events
        WHERE assigned_technician_id IS NOT NULL
        ON CONFLICT (event_id, technician_id) DO NOTHING
    `);
}

export function registerCalendarRoutes(app, requireAuthentication) {
    app.use("/api/calendar", requireAuthentication, requireCalendarReadAccess);
    app.get("/api/calendar/client-history/:clientId", requireAuthentication, asyncHandler(async (request, response) => {
        const clientId = String(request.params.clientId || "");
        if (!/^client-[a-zA-Z0-9-]+$/.test(clientId)) return response.status(400).json({ message: "Client invalide." });
        const ownerId = getAccountOwnerId(request);
        const clientResult = await getPool().query("SELECT 1 FROM depannhome_clients WHERE owner_id = $1 AND client_id = $2", [ownerId, clientId]);
        if (!clientResult.rows[0]) return response.status(404).json({ message: "Dossier client introuvable." });
        const { rows } = await getPool().query(`
            SELECT event.id, event.title, event.client_name AS "clientName", event.location, TO_CHAR(event.event_date, 'YYYY-MM-DD') AS date,
                TO_CHAR(event.start_time, 'HH24:MI') AS "startTime", TO_CHAR(event.end_time, 'HH24:MI') AS "endTime", event.event_type AS "eventType",
                event.quitus_status AS "quitusStatus", event.created_at AS "createdAt", event.updated_at AS "updatedAt",
                COALESCE(technician.full_name, technician.username, '') AS "assignedTechnicianName"
            FROM depannhome_calendar_events event
            LEFT JOIN depannhome_users technician ON technician.id = event.assigned_technician_id
            WHERE event.owner_id = $1
                            AND event.client_id = $2
              AND ($3 NOT IN ('technician', 'accountant') OR EXISTS (
                    SELECT 1 FROM depannhome_calendar_assignments assignment
                    WHERE assignment.event_id = event.id AND assignment.technician_id = $4::bigint
              ))
            ORDER BY event.event_date DESC, event.start_time DESC NULLS LAST, event.id DESC
        `, [ownerId, clientId, request.user?.role || "", request.user?.sub || 0]);
        response.json({ events: rows });
    }));
    app.get("/api/calendar/events", requireAuthentication, asyncHandler(async (request, response) => {
        const start = sanitizeDate(request.query?.start);
        const end = sanitizeDate(request.query?.end);
        if (!start || !end || start > end) return response.status(400).json({ message: "Période de calendrier invalide." });

        const { rows } = await getPool().query(`
            SELECT
                event.id,
                event.title,
                assigned_technician_id AS "assignedTechnicianId",
                COALESCE(technician.full_name, technician.username, '') AS "assignedTechnicianName",
                COALESCE((
                    SELECT json_agg(json_build_object(
                        'id', assignment.technician_id,
                        'fullName', COALESCE(assigned.full_name, assigned.username, ''),
                        'department', assigned.department,
                        'role', assigned.role,
                        'isPrimary', assignment.is_primary
                    ) ORDER BY assignment.is_primary DESC, LOWER(COALESCE(assigned.full_name, assigned.username, '')))
                    FROM depannhome_calendar_assignments assignment
                    JOIN depannhome_users assigned ON assigned.id = assignment.technician_id
                    WHERE assignment.event_id = event.id
                ), '[]'::json) AS "assignedTechnicians",
                COALESCE(NULLIF(event.client_id,''), (SELECT mission.client_id FROM depannhome_partner_missions mission WHERE mission.owner_id=event.owner_id AND mission.calendar_event_id=event.id AND mission.client_id<>'' ORDER BY mission.updated_at DESC LIMIT 1), '') AS "clientId", event.client_name AS "clientName",
                event.location,
                TO_CHAR(event.event_date, 'YYYY-MM-DD') AS date,
                TO_CHAR(event.start_time, 'HH24:MI') AS "startTime",
                TO_CHAR(event.end_time, 'HH24:MI') AS "endTime",
                event.color,
                event.event_type AS "eventType",
                event.event_origin AS "eventOrigin",
                event.partner_connection_id AS "partnerConnectionId",
                event.partner_mission_id AS "partnerMissionId",
                event.quitus_status AS "quitusStatus",
                event.quitus_signed_by AS "quitusSignedBy",
                event.quitus_signature AS "quitusSignature",
                event.quitus_signed_at AS "quitusSignedAt",
                event.notes,
                event.created_at AS "createdAt",
                event.updated_at AS "updatedAt"
            FROM depannhome_calendar_events event
            LEFT JOIN depannhome_users technician ON technician.id = event.assigned_technician_id
                        WHERE event.owner_id = $1
                            AND event_date BETWEEN $2::date AND $3::date
                            AND ($4 NOT IN ('technician', 'accountant') OR EXISTS (
                                SELECT 1 FROM depannhome_calendar_assignments assignment
                                WHERE assignment.event_id = event.id AND assignment.technician_id = $5::bigint
                            ))
            ORDER BY event.event_date, event.start_time NULLS LAST, event.created_at
                `, [getAccountOwnerId(request), start, end, request.user.role, request.user.sub]);
        response.json({ events: rows });
    }));

    app.get("/api/calendar/availability", requireAuthentication, asyncHandler(async (request, response) => {
        const start = sanitizeDate(request.query?.start);
        const end = sanitizeDate(request.query?.end);
        const technicianIds = sanitizePositiveIds(String(request.query?.technicianIds || "").split(",").filter(Boolean));
        const startTime = sanitizeTime(request.query?.startTime);
        const endTime = sanitizeTime(request.query?.endTime);
        const requestedCount = Number(request.query?.count);
        const count = Number.isInteger(requestedCount) ? Math.min(Math.max(requestedCount, 1), 31) : 12;
        if (!start || !end || start > end || daysBetween(start, end) > 90) return response.status(400).json({ message: "Période de recherche invalide." });
        if (request.query?.technicianIds && !technicianIds.length) return response.status(400).json({ message: "Membre affecté invalide." });
        if ((request.query?.startTime && !startTime) || (request.query?.endTime && !endTime) || (startTime && endTime && endTime < startTime)) {
            return response.status(400).json({ message: "Plage horaire invalide." });
        }
        const assignmentError = await validateAssignedMembers(getAccountOwnerId(request), technicianIds);
        if (assignmentError) return response.status(400).json({ message: assignmentError });

        const { rows } = await getPool().query(`
            SELECT TO_CHAR(event_date, 'YYYY-MM-DD') AS date, TO_CHAR(start_time, 'HH24:MI') AS "startTime", TO_CHAR(end_time, 'HH24:MI') AS "endTime"
            FROM depannhome_calendar_events
            WHERE owner_id = $1 AND event_date BETWEEN $2::date AND $3::date
                AND (
                    (cardinality($4::bigint[]) > 0 AND EXISTS (
                        SELECT 1 FROM depannhome_calendar_assignments assignment
                        WHERE assignment.event_id = depannhome_calendar_events.id AND assignment.technician_id = ANY($4::bigint[])
                    ))
                    OR (cardinality($4::bigint[]) = 0 AND assigned_technician_id IS NULL)
                )
        `, [getAccountOwnerId(request), start, end, technicianIds]);
        const eventsByDate = new Map();
        rows.forEach(event => {
            if (!eventsByDate.has(event.date)) eventsByDate.set(event.date, []);
            eventsByDate.get(event.date).push(event);
        });
        const availableDates = [];
        for (const date of datesInRange(start, end)) {
            const conflict = eventsByDate.get(date)?.some(event => calendarTimesOverlap(event, { startTime, endTime }));
            if (!conflict) availableDates.push(date);
            if (availableDates.length >= count) break;
        }
        response.json({ availableDates });
    }));

    app.post("/api/calendar/events", requireAuthentication, requireCalendarWriteAccess, asyncHandler(async (request, response) => {
        const event = sanitizeEvent(request.body);
        if (!event.ok) return response.status(400).json({ message: event.message });
        const dates = sanitizeEventDates(request.body?.dates, event.date);
        if (!dates.length) return response.status(400).json({ message: "Une des dates sélectionnées est invalide." });
        const assignmentError = await validateAssignedMembers(getAccountOwnerId(request), event.assignedTechnicianIds);
        if (assignmentError) return response.status(400).json({ message: assignmentError });
        for (const date of dates) {
            const conflict = await findCalendarConflict(getAccountOwnerId(request), { ...event, date });
            if (conflict) return response.status(409).json({ message: `${conflictMessage(conflict)} Date concernée : ${date}.` });
        }

        const connection = await getPool().connect();
        try {
            await connection.query("BEGIN");
            const ids = [];
            for (const date of dates) {
                const { rows } = await connection.query(`
                    INSERT INTO depannhome_calendar_events
                        (owner_id, assigned_technician_id, title, client_id, client_name, location, event_date, start_time, end_time, color, event_type, event_origin, notes)
                    VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::time, $9::time, $10, $11, 'standard', $12)
                    RETURNING id
                `, [getAccountOwnerId(request), event.assignedTechnicianId || null, event.title, await resolveClientId(connection, getAccountOwnerId(request), event.clientName, true), event.clientName, event.location, date, optionalTime(event.startTime), optionalTime(event.endTime), event.color, event.eventType, event.notes]);
                await replaceEventAssignments(connection, rows[0].id, event.assignedTechnicianIds, event.assignedTechnicianId);
                ids.push(rows[0].id);
            }
            await connection.query("COMMIT");
            response.status(201).json({ id: ids[0], ids, count: ids.length });
        } catch (error) {
            await connection.query("ROLLBACK");
            throw error;
        } finally {
            connection.release();
        }
    }));

    app.put("/api/calendar/events/:eventId", requireAuthentication, requireCalendarWriteAccess, asyncHandler(async (request, response) => {
        const id = positiveId(request.params.eventId);
        const event = sanitizeEvent(request.body);
        if (!id) return response.status(400).json({ message: "Rendez-vous invalide." });
        if (!event.ok) return response.status(400).json({ message: event.message });
        const assignmentError = await validateAssignedMembers(getAccountOwnerId(request), event.assignedTechnicianIds);
        if (assignmentError) return response.status(400).json({ message: assignmentError });
        const conflict = await findCalendarConflict(getAccountOwnerId(request), event, id);
        if (conflict) return response.status(409).json({ message: conflictMessage(conflict) });

        const connection = await getPool().connect();
        try {
            await connection.query("BEGIN");
            const { rowCount } = await connection.query(`
                UPDATE depannhome_calendar_events
                SET assigned_technician_id = $3, title = $4, client_id = $5, client_name = $6, location = $7, event_date = $8::date,
                    start_time = $9::time, end_time = $10::time, color = $11, event_type = $12, notes = $13, updated_at = NOW()
                WHERE id = $1 AND owner_id = $2
            `, [id, getAccountOwnerId(request), event.assignedTechnicianId || null, event.title, await resolveClientId(connection, getAccountOwnerId(request), event.clientName), event.clientName, event.location, event.date, optionalTime(event.startTime), optionalTime(event.endTime), event.color, event.eventType, event.notes]);
            if (!rowCount) {
                await connection.query("ROLLBACK");
                return response.status(404).json({ message: "Rendez-vous introuvable." });
            }
            await replaceEventAssignments(connection, id, event.assignedTechnicianIds, event.assignedTechnicianId);
            await connection.query("COMMIT");
            await synchronizeConnectedAppointment(getAccountOwnerId(request), id);
            response.status(204).end();
        } catch (error) {
            await connection.query("ROLLBACK");
            throw error;
        } finally {
            connection.release();
        }
    }));

    app.delete("/api/calendar/events/:eventId", requireAuthentication, requireCalendarWriteAccess, asyncHandler(async (request, response) => {
        const id = positiveId(request.params.eventId);
        if (!id) return response.status(400).json({ message: "Rendez-vous invalide." });
        const { rowCount } = await getPool().query(
            "DELETE FROM depannhome_calendar_events WHERE id = $1 AND owner_id = $2",
            [id, getAccountOwnerId(request)]
        );
        if (!rowCount) return response.status(404).json({ message: "Rendez-vous introuvable." });
        response.status(204).end();
    }));

    app.patch("/api/calendar/events/:eventId/quitus", requireAuthentication, asyncHandler(async (request, response) => {
        const id = positiveId(request.params.eventId);
        const quitus = sanitizeQuitus(request.body);
        if (!id) return response.status(400).json({ message: "Rendez-vous invalide." });
        if (!quitus.ok) return response.status(400).json({ message: quitus.message });

        const accountOwnerId = getAccountOwnerId(request);
        const database = getPool();
        const connection = await database.connect();
        try {
            await connection.query("BEGIN");
            const eventResult = await connection.query(`
                SELECT id, title, client_name AS "clientName", location,
                    TO_CHAR(event_date, 'YYYY-MM-DD') AS date,
                    TO_CHAR(start_time, 'HH24:MI') AS "startTime", TO_CHAR(end_time, 'HH24:MI') AS "endTime",
                    notes, quitus_status AS "quitusStatus"
                FROM depannhome_calendar_events
                                WHERE id = $1 AND owner_id = $2 AND event_type = 'appointment' AND client_name <> ''
                                    AND ($3 NOT IN ('technician', 'accountant') OR EXISTS (
                                        SELECT 1 FROM depannhome_calendar_assignments assignment
                                        WHERE assignment.event_id = depannhome_calendar_events.id AND assignment.technician_id = $4::bigint
                                    ))
                FOR UPDATE
                        `, [id, accountOwnerId, request.user.role, request.user.sub]);
            const event = eventResult.rows[0];
            if (!event) {
                await connection.query("ROLLBACK");
                return response.status(404).json({ message: "Rendez-vous introuvable." });
            }
            if (event.quitusStatus !== "pending") {
                await connection.query("ROLLBACK");
                return response.status(409).json({ message: "Ce quitus est déjà validé et ne peut plus être modifié." });
            }

            const clientResult = await connection.query(`
                SELECT client_id AS "clientId", client_data AS client
                FROM depannhome_clients
                WHERE owner_id = $1 AND LOWER(BTRIM(client_data->>'name')) = LOWER(BTRIM($2))
                ORDER BY updated_at DESC
                LIMIT 1
                FOR UPDATE
            `, [accountOwnerId, event.clientName]);
            const clientRow = clientResult.rows[0];
            if (!clientRow) {
                await connection.query("ROLLBACK");
                return response.status(400).json({ message: "Aucun dossier client correspondant : le quitus ne peut pas être validé." });
            }

            const profileResult = await connection.query(`SELECT profile.company_name AS "companyName",profile.address,profile.postal_code AS "postalCode",profile.city,profile.phone,profile.email,profile.registration_number AS "registrationNumber",profile.logo_data AS "logoData",profile.logo_mime_type AS "logoMimeType",profile.quitus_template AS "quitusTemplate",profile.quitus_template_mode AS "quitusTemplateMode",profile.quitus_template_filename AS "quitusTemplateFilename",profile.quitus_template_data AS "quitusTemplateData",profile.quitus_template_mime_type AS "quitusTemplateMimeType",owner.quitus_template_policy AS "quitusTemplatePolicy" FROM depannhome_users owner LEFT JOIN depannhome_billing_profiles profile ON profile.owner_id=owner.id WHERE owner.id=$1`, [accountOwnerId]);
            const output = await createQuitusDocumentOutput(event, quitus, profileResult.rows[0] || {});
            const createdAt = new Date().toISOString();
            const attachment = {
                id: `file-${randomUUID()}`,
                type: "Quitus",
                name: output.filename,
                mime: output.mimeType,
                size: output.buffer.length,
                dataUrl: `data:${output.mimeType};base64,${output.buffer.toString("base64")}`,
                createdAt
            };
            const client = clientRow.client || {};
            const attachments = Array.isArray(client.attachments) ? client.attachments : [];
            if (attachments.length >= MAX_CLIENT_ATTACHMENTS) {
                await connection.query("ROLLBACK");
                return response.status(400).json({ message: `Le dossier client contient déjà le maximum de ${MAX_CLIENT_ATTACHMENTS} fichiers.` });
            }
            const activityHistory = Array.isArray(client.activityHistory) ? client.activityHistory : [];
            const updatedClient = {
                ...client,
                attachments: [...attachments, attachment],
                activityHistory: [{
                    id: `activity-${randomUUID()}`,
                    type: "quitus",
                    label: "Quitus validé",
                    detail: attachment.name,
                    attachmentId: attachment.id,
                    actorName: String(request.user.fullName || request.user.username || "Technicien").slice(0, 100),
                    createdAt
                }, ...activityHistory].slice(0, MAX_ACTIVITY_HISTORY),
                updatedAt: createdAt
            };
            if (Buffer.byteLength(JSON.stringify(updatedClient), "utf8") > MAX_CLIENT_PAYLOAD_SIZE) {
                await connection.query("ROLLBACK");
                return response.status(400).json({ message: "Le dossier client est trop volumineux pour y ajouter le PDF du quitus." });
            }
            await connection.query(`
                UPDATE depannhome_clients SET client_data = $3::jsonb, updated_at = $4
                WHERE owner_id = $1 AND client_id = $2
            `, [accountOwnerId, clientRow.clientId, JSON.stringify(updatedClient), createdAt]);
            const { rows } = await connection.query(`
                UPDATE depannhome_calendar_events
                SET quitus_status = 'validated', quitus_signed_by = $3, quitus_signature = $4,
                    quitus_signed_at = NOW(), updated_at = NOW()
                WHERE id = $1 AND owner_id = $2
                RETURNING quitus_status AS "quitusStatus", quitus_signed_by AS "quitusSignedBy",
                    quitus_signature AS "quitusSignature", quitus_signed_at AS "quitusSignedAt"
            `, [id, accountOwnerId, quitus.signedBy, quitus.signature]);
            await connection.query("COMMIT");
            response.json({ quitus: rows[0], message: "Quitus validé et document officiel ajouté au dossier client." });
        } catch (error) {
            await connection.query("ROLLBACK");
            throw error;
        } finally {
            connection.release();
        }
    }));
}

function requireCalendarWriteAccess(request, response, next) {
    if (["technician", "accountant"].includes(request.user?.role)) {
        return response.status(403).json({ message: "Ce poste peut consulter son planning, sans le modifier." });
    }
    return next();
}

function requireCalendarReadAccess(request, response, next) {
    return next();
}

function sanitizeEvent(value) {
    const title = cleanText(value?.title, 160);
    const clientName = cleanText(value?.clientName, 160);
    const location = cleanText(value?.location, 255);
    const date = sanitizeDate(value?.date);
    const startTime = sanitizeTime(value?.startTime);
    const endTime = sanitizeTime(value?.endTime);
    const color = EVENT_COLORS.has(value?.color) ? value.color : "blue";
    const eventType = EVENT_TYPES.has(value?.eventType) ? value.eventType : "appointment";
    const notes = cleanText(value?.notes, 2000);
    const assignedTechnicianIds = sanitizePositiveIds(value?.assignedTechnicianIds);
    const requestedPrimaryTechnicianId = optionalPositiveId(value?.assignedTechnicianId);
    if (requestedPrimaryTechnicianId && !assignedTechnicianIds.includes(requestedPrimaryTechnicianId)) assignedTechnicianIds.unshift(requestedPrimaryTechnicianId);
    const assignedTechnicianId = requestedPrimaryTechnicianId || assignedTechnicianIds[0] || 0;

    if (!title) return { ok: false, message: "Le titre du rendez-vous est obligatoire." };
    if (!date) return { ok: false, message: "La date du rendez-vous est invalide." };
    if (value?.startTime && !startTime) return { ok: false, message: "L’heure de début est invalide." };
    if (value?.endTime && !endTime) return { ok: false, message: "L’heure de fin est invalide." };
    if (startTime && endTime && endTime < startTime) return { ok: false, message: "L’heure de fin doit être après l’heure de début." };

    if ((value?.assignedTechnicianId && !requestedPrimaryTechnicianId) || (Array.isArray(value?.assignedTechnicianIds) && value.assignedTechnicianIds.length > 0 && !assignedTechnicianIds.length)) return { ok: false, message: "Un membre sélectionné est invalide." };
    return { ok: true, title, clientName, location, date, startTime, endTime, color, eventType, notes, assignedTechnicianId, assignedTechnicianIds };
}

async function resolveClientId(connection, ownerId, clientName, activeOnly = false) {
    if (!clientName) return "";
    const { rows } = await connection.query("SELECT client_id FROM depannhome_clients WHERE owner_id=$1 AND LOWER(BTRIM(client_data->>'name'))=LOWER(BTRIM($2)) AND ($3::boolean=FALSE OR client_status='active') ORDER BY updated_at DESC LIMIT 1", [ownerId, clientName, activeOnly]);
    return rows[0]?.client_id || "";
}

function sanitizeEventDates(value, fallbackDate) {
    const rawDates = Array.isArray(value) ? value : value === undefined || value === null || value === "" ? [fallbackDate] : [value];
    if (!rawDates.length || rawDates.length > 30) return [];
    const dates = rawDates.map(sanitizeDate);
    if (dates.some(date => !date)) return [];
    const uniqueDates = [...new Set(dates)];
    return uniqueDates.length > 30 ? [] : uniqueDates;
}

function sanitizeQuitus(value) {
    const status = QUITUS_STATUS.has(value?.status) ? value.status : "pending";
    const signedBy = cleanText(value?.signedBy, 160);
    const signature = String(value?.signature || "");
    if (status !== "validated") return { ok: false, message: "Le quitus doit être validé avec la signature du client." };
    if (!signedBy) return { ok: false, message: "Indiquez le nom du client signataire." };
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signature) || Buffer.byteLength(signature, "utf8") > 700000) {
        return { ok: false, message: "La signature est invalide ou trop volumineuse." };
    }
    return { ok: true, status, signedBy, signature };
}

function quitusPdfFileName(event) {
    return `quitus-intervention-${event.id}-${event.date}.pdf`;
}

export async function createQuitusDocumentOutput(event, quitus, profile = {}) {
    const generatedPdf = await createQuitusPdf(event, quitus, profile);
    const policy = ["integrated_only", "company_choice", "external_only"].includes(profile.quitusTemplatePolicy) ? profile.quitusTemplatePolicy : "company_choice";
    const external = policy === "external_only" || (policy !== "integrated_only" && profile.quitusTemplateMode === "external");
    if (!external) return { buffer: generatedPdf, filename: quitusPdfFileName(event), mimeType: PDF_MIME };
    return renderCompanyTemplate({ buffer: profile.quitusTemplateData, filename: profile.quitusTemplateFilename || quitusPdfFileName(event), mimeType: profile.quitusTemplateMimeType, generatedPdf, values: quitusTemplateValues(event, quitus, profile) });
}

function quitusTemplateValues(event, quitus, profile) {
    const template = normalizeQuitusTemplate(profile.quitusTemplate);
    return { numero_intervention: event.id, intervention: event.title, date: event.date, heure_debut: event.startTime || "", heure_fin: event.endTime || "", client_nom: event.clientName, adresse_intervention: event.location, observations: event.notes, entreprise_nom: profile.companyName, entreprise_adresse: [profile.address, profile.postalCode, profile.city].filter(Boolean).join(" "), entreprise_telephone: profile.phone, entreprise_email: profile.email, siret: profile.registrationNumber, signataire: quitus.signedBy, validation: quitus.signature ? "Validé électroniquement avec signature du client" : "Aperçu avant signature", texte_entete: template.headerText, texte_pied_page: template.footerText };
}

export function createQuitusPdf(event, quitus, profile = {}) {
    return new Promise((resolve, reject) => {
        const template = normalizeQuitusTemplate(profile.quitusTemplate);
        const boldFont = template.font === "Times-Roman" ? "Times-Bold" : template.font === "Courier" ? "Courier-Bold" : "Helvetica-Bold";
        const pdf = new PDFDocument({ size: "A4", margin: 48, info: { Title: `Quitus d’intervention ${event.id}`, Author: profile.companyName || "Depann'Home Pro" } });
        const chunks = [];
        pdf.on("data", chunk => chunks.push(chunk));
        pdf.on("end", () => resolve(Buffer.concat(chunks)));
        pdf.on("error", reject);
        const text = (value, x, y, width, options = {}) => pdf.fillColor(options.color || template.primaryColor).font(options.bold ? boldFont : template.font).fontSize(options.size || 10).text(String(value || ""), x, y, { width, ...options });
        const formatDate = value => new Intl.DateTimeFormat("fr-FR", { dateStyle: "long" }).format(new Date(`${value}T12:00:00`));

        if (profile.logoData && ["image/png", "image/jpeg"].includes(profile.logoMimeType)) try { pdf.image(profile.logoData, 48, 44, { fit: [58, 48] }); } catch {}
        const titleX = profile.logoData ? 120 : 48;
        text("QUITUS D’INTERVENTION", titleX, 48, 547 - titleX, { size: 22, bold: true, color: template.primaryColor });
        text(template.headerText || "Document validé", titleX, 78, 547 - titleX, { size: 10, bold: true, color: template.secondaryColor });
        pdf.moveTo(48, 102).lineTo(547, 102).lineWidth(1).strokeColor(template.separatorColor).stroke();
        text("INTERVENTION", 48, 124, 220, { size: 9, bold: true });
        text([event.title, formatDate(event.date), [event.startTime, event.endTime].filter(Boolean).join(" – "), event.location].filter(Boolean).join("\n"), 48, 140, 220, { size: 10, lineGap: 4 });
        text("CLIENT", 315, 124, 232, { size: 9, bold: true });
        text(event.clientName, 315, 140, 232, { size: 10, lineGap: 4 });
        if (event.notes) {
            text("NOTES D’INTERVENTION", 48, 232, 499, { size: 9, bold: true });
            text(event.notes, 48, 248, 499, { size: 10, lineGap: 4 });
        }
        const signatureY = event.notes ? 340 : 272;
        pdf.rect(48, signatureY, 499, 190).lineWidth(1).strokeColor(template.separatorColor).stroke();
        text("VALIDATION DU CLIENT", 62, signatureY + 14, 250, { size: 9, bold: true });
        text(`Signé par : ${quitus.signedBy}`, 62, signatureY + 34, 300, { size: 10 });
        text(`Validé le : ${new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeStyle: "short" }).format(new Date())}`, 62, signatureY + 52, 420, { size: 9, color: "#4b5563" });
        if (/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(String(quitus.signature || ""))) {
            const signature = Buffer.from(quitus.signature.replace(/^data:image\/png;base64,/, ""), "base64");
            try { pdf.image(signature, 62, signatureY + 78, { fit: [300, 94] }); } catch { /* La signature est validée avant la génération ; le PDF reste traçable en cas d'image illisible. */ }
        } else {
            text("Emplacement réservé à la signature du client", 62, signatureY + 112, 300, { size: 9, color: "#6b7280", align: "center" });
        }
        const footer = template.footerText || (quitus.signature ? "Ce quitus a été validé électroniquement et ne peut plus être modifié." : "Aperçu du quitus avant validation et signature du client.");
        text(footer, 48, 748, 499, { size: 8, color: template.secondaryColor, align: "center" });
        pdf.end();
    });
}

function normalizeQuitusTemplate(value) {
    const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const color = (key, fallback) => /^#[0-9a-fA-F]{6}$/.test(String(input[key] || "")) ? String(input[key]).toLowerCase() : fallback;
    return { primaryColor: color("primaryColor", "#003b73"), secondaryColor: color("secondaryColor", "#0a5c36"), separatorColor: color("separatorColor", "#d7dde3"), font: ["Helvetica", "Times-Roman", "Courier"].includes(input.font) ? input.font : "Helvetica", headerText: cleanText(input.headerText, 500), footerText: cleanText(input.footerText, 500) };
}

async function validateAssignedMembers(accountOwnerId, memberIds) {
    if (!memberIds.length) return "";
    const { rowCount } = await getPool().query(`
        SELECT 1 FROM depannhome_users
        WHERE id = ANY($1::bigint[]) AND account_owner_id = $2 AND is_active = TRUE
    `, [memberIds, accountOwnerId]);
    return rowCount === memberIds.length ? "" : "Un des membres sélectionnés est introuvable ou inactif.";
}

async function findCalendarConflict(accountOwnerId, event, excludedEventId = 0) {
    const timedEvent = Boolean(event.startTime && event.endTime);
    const { rows } = await getPool().query(`
        SELECT title, TO_CHAR(start_time, 'HH24:MI') AS "startTime", TO_CHAR(end_time, 'HH24:MI') AS "endTime"
        FROM depannhome_calendar_events
        WHERE owner_id = $1
          AND event_date = $2::date
          AND id <> $3
                    AND (
                        (cardinality($4::bigint[]) > 0 AND EXISTS (
                            SELECT 1 FROM depannhome_calendar_assignments assignment
                            WHERE assignment.event_id = depannhome_calendar_events.id
                              AND assignment.technician_id = ANY($4::bigint[])
                        ))
                        OR (cardinality($4::bigint[]) = 0 AND assigned_technician_id IS NULL)
                    )
          AND ${timedEvent
                ? "(start_time IS NULL OR end_time IS NULL OR (start_time < $6::time AND end_time > $5::time))"
        : "TRUE"}
        ORDER BY start_time NULLS FIRST, created_at
        LIMIT 1
    `, timedEvent
        ? [accountOwnerId, event.date, excludedEventId, event.assignedTechnicianIds, event.startTime, event.endTime]
        : [accountOwnerId, event.date, excludedEventId, event.assignedTechnicianIds]);
    return rows[0] || null;
}

async function replaceEventAssignments(connection, eventId, technicianIds, primaryTechnicianId) {
    await connection.query("DELETE FROM depannhome_calendar_assignments WHERE event_id = $1", [eventId]);
    if (!technicianIds.length) return;
    await connection.query(`
        INSERT INTO depannhome_calendar_assignments (event_id, technician_id, is_primary)
        SELECT $1, technician_id, technician_id = $3::bigint
        FROM UNNEST($2::bigint[]) AS technician_id
    `, [eventId, technicianIds, primaryTechnicianId]);
}

function conflictMessage(event) {
    const time = event.startTime && event.endTime ? ` (${event.startTime} – ${event.endTime})` : " (toute la journée)";
    return `Ce rendez-vous chevauche déjà « ${event.title} »${time}. Choisissez un autre créneau.`;
}

function sanitizeDate(value) {
    const date = String(value || "");
    if (!DATE_PATTERN.test(date) || Number.isNaN(new Date(`${date}T12:00:00`).getTime())) return "";
    return date;
}

function sanitizeTime(value) {
    const time = String(value || "");
    return TIME_PATTERN.test(time) ? time : "";
}

function optionalTime(value) {
    return value || null;
}

function calendarTimesOverlap(first, second) {
    if (!first.startTime || !first.endTime || !second.startTime || !second.endTime) return true;
    return first.startTime < second.endTime && first.endTime > second.startTime;
}

function datesInRange(start, end) {
    const dates = [];
    const date = new Date(`${start}T12:00:00`);
    const last = new Date(`${end}T12:00:00`);
    while (date <= last) {
        dates.push(dateString(date));
        date.setDate(date.getDate() + 1);
    }
    return dates;
}

function daysBetween(start, end) {
    return Math.round((new Date(`${end}T12:00:00`) - new Date(`${start}T12:00:00`)) / 86400000);
}

function dateString(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function cleanText(value, maximumLength) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximumLength);
}

function positiveId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function optionalPositiveId(value) {
    if (value === undefined || value === null || value === "") return 0;
    return positiveId(value);
}

function sanitizePositiveIds(value) {
    const values = Array.isArray(value) ? value : value === undefined || value === null || value === "" ? [] : [value];
    const ids = values.map(optionalPositiveId);
    if (ids.some(id => !id)) return [];
    return [...new Set(ids)].slice(0, 30);
}

function asyncHandler(handler) {
    return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}
