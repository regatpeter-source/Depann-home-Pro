import { getPool } from "./database.js";
import { getAccountOwnerId } from "./auth.js";

const EVENT_COLORS = new Set(["blue", "green", "orange", "red", "purple", "gray"]);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function initializeCalendar() {
    const database = getPool();
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_calendar_events (
            id BIGSERIAL PRIMARY KEY,
            owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            assigned_technician_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
            title VARCHAR(160) NOT NULL,
            client_name VARCHAR(160) NOT NULL DEFAULT '',
            location VARCHAR(255) NOT NULL DEFAULT '',
            event_date DATE NOT NULL,
            start_time TIME,
            end_time TIME,
            color VARCHAR(20) NOT NULL DEFAULT 'blue',
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
    await database.query(`
        CREATE INDEX IF NOT EXISTS depannhome_calendar_events_owner_date_idx
        ON depannhome_calendar_events (owner_id, event_date, start_time)
    `);
}

export function registerCalendarRoutes(app, requireAuthentication) {
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
                event.client_name AS "clientName",
                event.location,
                TO_CHAR(event.event_date, 'YYYY-MM-DD') AS date,
                TO_CHAR(event.start_time, 'HH24:MI') AS "startTime",
                TO_CHAR(event.end_time, 'HH24:MI') AS "endTime",
                event.color,
                event.notes,
                event.created_at AS "createdAt",
                event.updated_at AS "updatedAt"
            FROM depannhome_calendar_events event
            LEFT JOIN depannhome_users technician ON technician.id = event.assigned_technician_id
            WHERE event.owner_id = $1 AND event_date BETWEEN $2::date AND $3::date
            ORDER BY event.event_date, event.start_time NULLS LAST, event.created_at
        `, [getAccountOwnerId(request), start, end]);
        response.json({ events: rows });
    }));

    app.post("/api/calendar/events", requireAuthentication, requireCalendarWriteAccess, asyncHandler(async (request, response) => {
        const event = sanitizeEvent(request.body);
        if (!event.ok) return response.status(400).json({ message: event.message });
        const assignmentError = await validateAssignedTechnician(getAccountOwnerId(request), event.assignedTechnicianId);
        if (assignmentError) return response.status(400).json({ message: assignmentError });
        const conflict = await findCalendarConflict(getAccountOwnerId(request), event);
        if (conflict) return response.status(409).json({ message: conflictMessage(conflict) });

        const { rows } = await getPool().query(`
            INSERT INTO depannhome_calendar_events
                (owner_id, assigned_technician_id, title, client_name, location, event_date, start_time, end_time, color, notes)
            VALUES ($1, $2, $3, $4, $5, $6::date, $7::time, $8::time, $9, $10)
            RETURNING id
        `, [getAccountOwnerId(request), event.assignedTechnicianId || null, event.title, event.clientName, event.location, event.date, event.startTime, event.endTime, event.color, event.notes]);
        response.status(201).json({ id: rows[0].id });
    }));

    app.put("/api/calendar/events/:eventId", requireAuthentication, requireCalendarWriteAccess, asyncHandler(async (request, response) => {
        const id = positiveId(request.params.eventId);
        const event = sanitizeEvent(request.body);
        if (!id) return response.status(400).json({ message: "Rendez-vous invalide." });
        if (!event.ok) return response.status(400).json({ message: event.message });
        const assignmentError = await validateAssignedTechnician(getAccountOwnerId(request), event.assignedTechnicianId);
        if (assignmentError) return response.status(400).json({ message: assignmentError });
        const conflict = await findCalendarConflict(getAccountOwnerId(request), event, id);
        if (conflict) return response.status(409).json({ message: conflictMessage(conflict) });

        const { rowCount } = await getPool().query(`
            UPDATE depannhome_calendar_events
            SET assigned_technician_id = $3, title = $4, client_name = $5, location = $6, event_date = $7::date,
                start_time = $8::time, end_time = $9::time, color = $10, notes = $11, updated_at = NOW()
            WHERE id = $1 AND owner_id = $2
        `, [id, getAccountOwnerId(request), event.assignedTechnicianId || null, event.title, event.clientName, event.location, event.date, event.startTime, event.endTime, event.color, event.notes]);
        if (!rowCount) return response.status(404).json({ message: "Rendez-vous introuvable." });
        response.status(204).end();
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
}

function requireCalendarWriteAccess(request, response, next) {
    if (request.user?.role === "technician") {
        return response.status(403).json({ message: "Les techniciens peuvent consulter le planning, sans le modifier." });
    }
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
    const notes = cleanText(value?.notes, 2000);
    const assignedTechnicianId = optionalPositiveId(value?.assignedTechnicianId);

    if (!title) return { ok: false, message: "Le titre du rendez-vous est obligatoire." };
    if (!date) return { ok: false, message: "La date du rendez-vous est invalide." };
    if (value?.startTime && !startTime) return { ok: false, message: "L’heure de début est invalide." };
    if (value?.endTime && !endTime) return { ok: false, message: "L’heure de fin est invalide." };
    if (startTime && endTime && endTime < startTime) return { ok: false, message: "L’heure de fin doit être après l’heure de début." };

    if (value?.assignedTechnicianId && !assignedTechnicianId) return { ok: false, message: "Le technicien sélectionné est invalide." };
    return { ok: true, title, clientName, location, date, startTime, endTime, color, notes, assignedTechnicianId };
}

async function validateAssignedTechnician(accountOwnerId, technicianId) {
    if (!technicianId) return "";
    const { rowCount } = await getPool().query(`
        SELECT 1 FROM depannhome_users
        WHERE id = $1 AND account_owner_id = $2 AND role = 'technician' AND is_active = TRUE
    `, [technicianId, accountOwnerId]);
    return rowCount ? "" : "Le technicien sélectionné est introuvable ou inactif.";
}

async function findCalendarConflict(accountOwnerId, event, excludedEventId = 0) {
    const timedEvent = Boolean(event.startTime && event.endTime);
    const { rows } = await getPool().query(`
        SELECT title, TO_CHAR(start_time, 'HH24:MI') AS "startTime", TO_CHAR(end_time, 'HH24:MI') AS "endTime"
        FROM depannhome_calendar_events
        WHERE owner_id = $1
          AND event_date = $2::date
          AND id <> $3
          AND ${timedEvent
        ? "(start_time IS NULL OR end_time IS NULL OR (start_time < $5::time AND end_time > $4::time))"
        : "TRUE"}
        ORDER BY start_time NULLS FIRST, created_at
        LIMIT 1
    `, timedEvent
        ? [accountOwnerId, event.date, excludedEventId, event.startTime, event.endTime]
        : [accountOwnerId, event.date, excludedEventId]);
    return rows[0] || null;
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

function asyncHandler(handler) {
    return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}
