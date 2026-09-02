import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const server = read("server/calendar.js");
const schema = read("database/schema.sql");
const calendar = read("js/calendar.js");
const clients = read("js/clients.js");
const styles = read("css/style.css");

test("le planning conserve cinq statuts métier distincts de la couleur", () => {
    assert.match(server, /EVENT_STATUSES = new Set\(\["planned", "confirmed", "in_progress", "completed", "cancelled"\]\)/);
    assert.match(schema, /event_status VARCHAR\(20\) NOT NULL DEFAULT 'planned'/);
    assert.match(schema, /depannhome_calendar_events_status_check/);
    assert.match(calendar, /\{ id: "completed", label: "Terminée" \}/);
    assert.match(calendar, /\{ id: "cancelled", label: "Annulée" \}/);
    assert.match(calendar, /<select name="status">/);
});

test("les statuts sont lus, créés et modifiés par l’API du planning", () => {
    assert.match(server, /event\.event_status AS status/g);
    assert.match(server, /event_type, event_status, event_origin/);
    assert.match(server, /event_status = \$13/);
    assert.match(server, /EVENT_STATUSES\.has\(value\?\.status\)/);
    assert.match(calendar, /status: String\(form\.get\("status"\) \|\| "planned"\)/);
});

test("une intervention terminée est rayée et une intervention annulée est grisée", () => {
    assert.match(calendar, /calendarEventClassName\(event/);
    assert.match(calendar, /data-calendar-status/);
    assert.match(styles, /\.calendar-event\.status-completed[\s\S]*?text-decoration:line-through/);
    assert.match(styles, /\.calendar-event\.status-cancelled\{[^}]*background:#e5e7eb!important[^}]*filter:grayscale\(1\)/);
    assert.match(calendar, /calendarEventStatusLabel\(event\)/);
});

test("les événements clos restent visibles mais ne bloquent plus un créneau", () => {
    assert.match(server, /event_status NOT IN \('completed', 'cancelled'\)/);
    assert.match(server, /event_status = 'completed'/);
    assert.doesNotMatch(server, /event_status <> 'cancelled' AND event_type = 'appointment' AND event_date/);
    assert.match(server, /isClosedCalendarStatus\(event\.status\) \? null : await findCalendarConflict/);
    assert.match(calendar, /!\["completed", "cancelled"\]\.includes\(calendarEventStatus\(event\)\)/);
    assert.match(calendar, /if \(\["completed", "cancelled"\]\.includes\(calendarEventStatus\(candidate\)\)\) return null/);
    assert.match(calendar, /Cette intervention reste visible dans le planning et l’historique/);
});

test("l’historique client reprend le statut exact et verrouille les interventions closes", () => {
    assert.match(clients, /confirmed: "Confirmée", in_progress: "En cours", completed: "Terminée", cancelled: "Annulée"/);
    assert.match(clients, /appointment\.isCompleted \|\| appointment\.status === "cancelled"/);
});

test("seuls les postes administratifs et le Poste Admin Mobile finalisent une intervention", () => {
    assert.match(server, /EVENT_STATUS_MANAGER_ROLES = new Set\(\["admin", "pc_standard", "mobile_admin"\]\)/);
    assert.match(server, /!canManageCalendarEventStatus\(request\.user\) && event\.status !== "planned"/);
    assert.match(server, /if \(event\.status !== currentStatus\) return response\.status\(403\)/);
    assert.match(server, /AND \(\$15::boolean OR event_status = \$13\)/);
    assert.match(server, /if \(!canManageCalendarEventStatus\(request\.user\)\) \{\s*return response\.status\(403\)\.json\(\{ message: "La suppression d’une intervention est réservée/);
    assert.match(calendar, /function canManageCalendarEventStatus\(\) \{\s*return \["admin", "pc_standard", "mobile_admin"\]\.includes/);
    assert.match(calendar, /canManageCalendarEventStatus\(\) \? `<label>[\s\S]*?<select name="status">[\s\S]*?type="hidden" name="status"/);
    assert.match(calendar, /isEditing && canManageCalendarEventStatus\(\) \? '<button type="button" class="secondary-button danger-button" id="deleteCalendarEvent">Supprimer/);
});