import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = relativePath => fs.readFileSync(path.join(root, relativePath), "utf8");

test("une intervention reste ouverte après sa date tant qu’un poste autorisé ne la termine pas", () => {
    const calendar = read("server/calendar.js");
    assert.doesNotMatch(calendar, /event_date < \(CURRENT_TIMESTAMP AT TIME ZONE 'Europe\/Paris'\)::date/);
    assert.match(calendar, /\(event\.event_status = 'completed'\) AS "isCompleted"/);
    assert.match(calendar, /WHERE id = \$1 AND owner_id = \$2 AND event_status = 'completed'/);
    assert.doesNotMatch(calendar, /end_time\s*<\s*(?:CURRENT_TIME|LOCALTIME)/);
});

test("une intervention terminée reste dans l’historique et devient non modifiable", () => {
    const calendar = read("server/calendar.js");
    const clients = read("js/clients.js");
    const calendarClient = read("js/calendar.js");
    const historyRoute = calendar.slice(calendar.indexOf('app.get("/api/calendar/client-history/:clientId"'), calendar.indexOf('app.get("/api/calendar/events"'));
    assert.match(historyRoute, /WHERE event\.owner_id = \$1[\s\S]*event\.client_id = \$2/);
    assert.doesNotMatch(historyRoute, /LIMIT\s+1/);
    assert.match(calendar, /Cette intervention est terminée et conservée dans l’historique/);
    assert.match(calendar, /Cette intervention terminée doit rester dans l’historique/);
    assert.match(clients, /label: appointment\.eventType === "appointment" \? "Intervention créée"/);
    assert.match(clients, /`Intervention n°\$\{appointment\.id\}`/);
    assert.match(clients, /appointment\.isCompleted \? "Terminée" : \(\{ planned: "Planifiée", confirmed: "Confirmée", in_progress: "En cours", completed: "Terminée", cancelled: "Annulée" \}\)\[appointment\.status\] \|\| "Planifiée"/);
    assert.doesNotMatch(clients, /"Intervention planifiée"/);
    assert.match(calendarClient, /id="openCompletedAppointmentClient">Aller sur la fiche client/);
    assert.match(calendarClient, /id="scheduleCompletedAppointmentFollowUp">Planifier un nouveau rendez-vous/);
    assert.match(calendarClient, /newEventForDate\(date\)/);
    assert.match(calendarClient, /depannhome:open-client/);
});

test("le quitus archivé reste consultable mais non modifiable après une finalisation administrative", () => {
    const calendarServer = read("server/calendar.js");
    const clientsServer = read("server/clients.js");
    const calendarClient = read("js/calendar.js");
    const clientsClient = read("js/clients.js");
    assert.doesNotMatch(calendarServer, /event\.event_date >= \(CURRENT_TIMESTAMP AT TIME ZONE 'Europe\/Paris'\)::date/);
    assert.match(calendarServer, /event\.event_status NOT IN \('completed','cancelled'\)/);
    assert.doesNotMatch(clientsServer, /isCompletedInterventionQuitus/);
    assert.doesNotMatch(clientsServer, /son quitus n[’']est plus accessible|son quitus ne peut plus être envoyé/);
    assert.match(calendarClient, /event\.eventType === "appointment" && event\.isCompleted/);
    assert.match(calendarClient, /function renderQuitusHtml\(event\) \{\s*if \(event\.isCompleted\) return ""/);
    assert.match(clientsClient, /Quitus archivé/);
    assert.doesNotMatch(clientsClient, /Quitus archivé et inaccessible/);
    assert.match(clientsClient, /const quitusActions = quitusAttachment \?/);
});

test("la planification étendue utilise uniquement une date de début et une date de fin", () => {
    const calendarClient = read("js/calendar.js");
    const rangeSelection = calendarClient.slice(calendarClient.indexOf("function renderMultiDatePlanning"), calendarClient.indexOf("function datesBetween"));
    assert.match(rangeSelection, /Date de début \*<input name="date" type="date"/);
    assert.match(rangeSelection, /Date de fin \*<input type="date" id="calendarRangeEnd"/);
    assert.match(rangeSelection, /datesBetween\(start, end\)\.slice\(0, 31\)/);
    assert.match(rangeSelection, /La période ne peut pas dépasser 30 jours/);
    assert.match(rangeSelection, /\/api\/calendar\/availability/);
    assert.doesNotMatch(rangeSelection, /calendarRangePicker|calendarAdditionalDate|data-range-date|data-planning-date/);
});

test("tous les jours de la période sont contrôlés contre le planning général", () => {
    const calendarServer = read("server/calendar.js");
    const creationRoute = calendarServer.slice(calendarServer.indexOf('app.post("/api/calendar/events"'), calendarServer.indexOf('app.put("/api/calendar/events/:eventId"'));
    assert.match(creationRoute, /for \(const date of dates\) \{\s*const conflict = await findCalendarConflict/);
    assert.match(calendarServer, /const conflicts = \[\]/);
    assert.match(calendarServer, /conflicts\.push\(\{ date, title: conflict\.title, startTime: conflict\.startTime, endTime: conflict\.endTime \}\)/);
    assert.match(calendarServer, /response\.json\(\{ availableDates, conflicts \}\)/);
});

test("une nouvelle version PWA active immédiatement les correctifs du planning", () => {
    const application = read("js/app.js");
    const worker = read("service-worker.js");
    assert.match(application, /updateViaCache: "none"/);
    assert.match(application, /addEventListener\("controllerchange"/);
    assert.match(application, /reloadingForServiceWorkerUpdate/);
    assert.doesNotMatch(application, /depannhome:service-worker-reloaded/);
    assert.match(application, /\.then\(registration => registration\.update\(\)\)/);
    assert.match(worker, /self\.skipWaiting\(\)/);
    assert.match(worker, /self\.clients\.claim\(\)/);
    assert.match(worker, /\.\/js\/calendar\.js\?v=205/);
});
