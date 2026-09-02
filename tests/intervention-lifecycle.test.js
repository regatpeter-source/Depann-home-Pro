import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = relativePath => fs.readFileSync(path.join(root, relativePath), "utf8");

test("une intervention est terminée seulement lorsque sa date est passée à Paris", () => {
    const calendar = read("server/calendar.js");
    const completionRules = calendar.match(/event_date < \(CURRENT_TIMESTAMP AT TIME ZONE 'Europe\/Paris'\)::date/g) || [];
    assert.ok(completionRules.length >= 4);
    assert.doesNotMatch(calendar, /end_time\s*<\s*(?:CURRENT_TIME|LOCALTIME)/);
    assert.match(calendar, /AS "isCompleted"/);
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
    assert.match(clients, /appointment\.isCompleted \? "Terminée" : "Planifiée"/);
    assert.doesNotMatch(clients, /"Intervention planifiée"/);
    assert.match(calendarClient, /id="openCompletedAppointmentClient">Aller sur la fiche client/);
    assert.match(calendarClient, /id="scheduleCompletedAppointmentFollowUp">Planifier un nouveau rendez-vous/);
    assert.match(calendarClient, /newEventForDate\(date\)/);
    assert.match(calendarClient, /depannhome:open-client/);
});

test("le quitus devient inaccessible après la date de l’intervention", () => {
    const calendarServer = read("server/calendar.js");
    const clientsServer = read("server/clients.js");
    const calendarClient = read("js/calendar.js");
    const clientsClient = read("js/clients.js");
    assert.match(calendarServer, /if \(event\.isCompleted\)[\s\S]*son quitus n’est plus accessible/);
    assert.match(calendarServer, /event\.event_date >= \(CURRENT_TIMESTAMP AT TIME ZONE 'Europe\/Paris'\)::date/);
    assert.match(clientsServer, /isCompletedInterventionQuitus/);
    assert.match(calendarClient, /event\.eventType === "appointment" && event\.isCompleted/);
    assert.match(calendarClient, /function renderQuitusHtml\(event\) \{\s*if \(event\.isCompleted\) return ""/);
    assert.match(clientsClient, /Quitus archivé et inaccessible/);
    assert.match(clientsClient, /!completedAppointmentIds\.has\(quitusAppointmentId\)/);
});

test("la sélection étendue du planning est déterminée par deux clics, sans sélection au survol", () => {
    const calendarClient = read("js/calendar.js");
    const rangeSelection = calendarClient.slice(calendarClient.indexOf("function initializeMultiDatePlanning"), calendarClient.indexOf("function renderRangeMonth"));
    assert.match(rangeSelection, /let selectingRange = false/);
    assert.match(rangeSelection, /if \(selectingRange\) return addDateRange\(rangeAnchor, button\.dataset\.rangeDate\)/);
    assert.match(rangeSelection, /selectingRange = true;\s*render\(\)/);
    assert.match(rangeSelection, /eventKey\.key !== "Escape"/);
    assert.doesNotMatch(rangeSelection, /document\.addEventListener\("pointerup"/);
    assert.doesNotMatch(rangeSelection, /addEventListener\("pointerdown"/);
    assert.doesNotMatch(rangeSelection, /addEventListener\("pointerenter"/);
});

test("une nouvelle version PWA active immédiatement les correctifs du planning", () => {
    const application = read("js/app.js");
    const worker = read("service-worker.js");
    assert.match(application, /updateViaCache: "none"/);
    assert.match(application, /addEventListener\("controllerchange"/);
    assert.match(application, /depannhome:service-worker-reloaded/);
    assert.match(application, /\.then\(registration => registration\.update\(\)\)/);
    assert.match(worker, /self\.skipWaiting\(\)/);
    assert.match(worker, /self\.clients\.claim\(\)/);
    assert.match(worker, /\.\/js\/calendar\.js\?v=192/);
});
