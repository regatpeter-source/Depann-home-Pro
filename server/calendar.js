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
                id,
                title,
                client_name AS "clientName",
                location,
                TO_CHAR(event_date, 'YYYY-MM-DD') AS date,
                TO_CHAR(start_time, 'HH24:MI') AS "startTime",
                TO_CHAR(end_time, 'HH24:MI') AS "endTime",
                color,
                notes,
                created_at AS "createdAt",
                updated_at AS "updatedAt"
            FROM depannhome_calendar_events
            WHERE owner_id = $1 AND event_date BETWEEN $2::date AND $3::date
            ORDER BY event_date, start_time NULLS LAST, created_at
        `, [getAccountOwnerId(request), start, end]);
        response.json({ events: rows });
    }));

    app.post("/api/calendar/events", requireAuthentication, requireCalendarWriteAccess, asyncHandler(async (request, response) => {
        const event = sanitizeEvent(request.body);
        if (!event.ok) return response.status(400).json({ message: event.message });

        const { rows } = await getPool().query(`
            INSERT INTO depannhome_calendar_events
                (owner_id, title, client_name, location, event_date, start_time, end_time, color, notes)
            VALUES ($1, $2, $3, $4, $5::date, $6::time, $7::time, $8, $9)
            RETURNING id
        `, [getAccountOwnerId(request), event.title, event.clientName, event.location, event.date, event.startTime, event.endTime, event.color, event.notes]);
        response.status(201).json({ id: rows[0].id });
    }));

    app.put("/api/calendar/events/:eventId", requireAuthentication, requireCalendarWriteAccess, asyncHandler(async (request, response) => {
        const id = positiveId(request.params.eventId);
        const event = sanitizeEvent(request.body);
        if (!id) return response.status(400).json({ message: "Rendez-vous invalide." });
        if (!event.ok) return response.status(400).json({ message: event.message });

        const { rowCount } = await getPool().query(`
            UPDATE depannhome_calendar_events
            SET title = $3, client_name = $4, location = $5, event_date = $6::date,
                start_time = $7::time, end_time = $8::time, color = $9, notes = $10, updated_at = NOW()
            WHERE id = $1 AND owner_id = $2
        `, [id, getAccountOwnerId(request), event.title, event.clientName, event.location, event.date, event.startTime, event.endTime, event.color, event.notes]);
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

    if (!title) return { ok: false, message: "Le titre du rendez-vous est obligatoire." };
    if (!date) return { ok: false, message: "La date du rendez-vous est invalide." };
    if (value?.startTime && !startTime) return { ok: false, message: "L’heure de début est invalide." };
    if (value?.endTime && !endTime) return { ok: false, message: "L’heure de fin est invalide." };
    if (startTime && endTime && endTime < startTime) return { ok: false, message: "L’heure de fin doit être après l’heure de début." };

    return { ok: true, title, clientName, location, date, startTime, endTime, color, notes };
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

function asyncHandler(handler) {
    return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}
