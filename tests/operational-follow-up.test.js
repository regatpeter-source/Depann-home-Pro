import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const navigation = read("js/navigation.js");
const billingClient = read("js/billing.js");
const billingServer = read("server/billing.js");
const calendarClient = read("js/calendar.js");
const calendarServer = read("server/calendar.js");
const schema = read("database/schema.sql");
const migration = read("database/migrations/0024_operational_follow_up.sql");
const reschedulingMigration = read("database/migrations/0025_intervention_rescheduling.sql");
const pausedStatusBackfillMigration = read("database/migrations/0026_paused_intervention_status_backfill.sql");
const singleInterventionPauseMigration = read("database/migrations/0030_single_intervention_pause.sql");
const deliveryMigration = read("database/migrations/0031_document_delivery_tracking.sql");
const styles = read("css/style.css");
const clients = read("js/clients.js");

test("le tableau de bord remplace les clients par les rapports à corriger ou envoyer", () => {
    assert.match(navigation, /Rapports à corriger \/ envoyer/);
    assert.match(navigation, /report\.status === "submitted"/);
    assert.match(navigation, /report\.status === "ready_to_send"/);
    assert.match(navigation, /reports: renderTechnicalReports/);
});

test("les documents à suivre distinguent les actions de remise et d’encaissement", () => {
    assert.match(navigation, /Factures à faire/);
    assert.match(navigation, /Factures à envoyer/);
    assert.match(navigation, /Factures non réglées/);
    assert.match(navigation, /Devis à relancer/);
    assert.match(navigation, /Interventions à reprendre/);
    assert.match(navigation, /document\.status \|\| ""\)\.toLowerCase\(\) === "accepted"/);
    assert.match(navigation, /document\.issuedAt && !document\.deliveredAt/);
    assert.match(navigation, /Number\(document\.outstandingAmount\) > 0\.009/);
    assert.match(navigation, /document\.followUpDate <= today/);
    assert.match(navigation, /\/api\/calendar\/paused/);
    assert.match(navigation, /followUp\.pausedInterventions\[0\]/);
    assert.match(navigation, /renderCalendar\(\{ date: new Date/);
    assert.match(navigation, /dashboard-kpi-breakdown/);
    assert.doesNotMatch(navigation, /<section class="dashboard-follow-up"/);
    assert.match(styles, /\.dashboard-kpi-breakdown/);
});

test("la remise en main propre supprime seulement le rappel d’envoi", () => {
    assert.match(deliveryMigration, /delivery_method IN \('','email','hand_delivered'\)/);
    assert.match(deliveryMigration, /delivered_by BIGINT REFERENCES depannhome_users/);
    assert.match(billingServer, /\/api\/billing\/documents\/:documentId\/hand-delivery/);
    assert.match(billingServer, /delivery_method='hand_delivered',delivered_at=NOW\(\),delivered_by=\$3,delivered_by_name=\$4/);
    const handDeliveryRoute = billingServer.slice(billingServer.indexOf('app.post("/api/billing/documents/:documentId/hand-delivery"'), billingServer.indexOf('app.post("/api/billing/documents/:documentId/issue"'));
    assert.doesNotMatch(handDeliveryRoute, /depannhome_accounting_settlements|INSERT INTO .*settlement/);
    assert.match(billingClient, /Cette action ne vaut pas encaissement/);
});

test("la date de relance d’un devis est modifiable et persistée", () => {
    assert.match(migration, /follow_up_date DATE/);
    assert.match(schema, /depannhome_billing_documents_follow_up_idx/);
    assert.match(billingClient, /name="followUpDate" type="date"/);
    assert.match(billingServer, /TO_CHAR\(follow_up_date, 'YYYY-MM-DD'\) AS "followUpDate"/);
    assert.match(billingServer, /document\.followUpDate \|\| null/);
    assert.match(billingServer, /documentType === "quote" \? sanitizeDate\(value\?\.followUpDate\)/);
});

test("une intervention mise en pause est replanifiée sous le même identifiant", () => {
    assert.match(migration, /paused_at TIMESTAMPTZ/);
    assert.match(migration, /pause_reason VARCHAR\(40\)/);
    assert.match(calendarServer, /PAUSE_REASONS = new Set/);
    assert.match(calendarServer, /\/api\/calendar\/events\/:eventId\/pause/);
    assert.match(calendarServer, /\/api\/calendar\/events\/:eventId\/resume/);
    assert.match(calendarServer, /SET event_status='paused',paused_at=\$3/);
    assert.match(calendarServer, /if \(!note\) return response\.status\(400\)/);
    assert.match(calendarServer, /if \(newDate === source\.date\)/);
    assert.match(calendarServer, /SET event_date=\$3::date,event_status='planned',paused_at=NULL/);
    assert.match(calendarServer, /WHERE id=\$1 AND owner_id=\$2 AND event_status='paused'/);
    assert.match(calendarServer, /synchronizeConnectedAppointment\(ownerId, id\)/);
    assert.doesNotMatch(calendarServer.slice(calendarServer.indexOf('app.post("/api/calendar/events/:eventId/resume"'), calendarServer.indexOf('app.delete("/api/calendar/events/batch')), /INSERT INTO depannhome_calendar_events/);
    assert.match(calendarServer, /canRequestInterventionPause\(request\.user\)/);
    assert.match(calendarServer, /if \(!canManageCalendarSchedule\(request\.user\)\) return response\.status\(403\).*replanification/);
    assert.match(calendarServer, /EXISTS \(SELECT 1 FROM depannhome_calendar_assignments/);
    assert.match(calendarClient, /Matériel non reçu/);
    assert.match(calendarClient, /Technicien absent/);
    assert.match(calendarClient, /data-resume-intervention/);
    assert.match(calendarClient, /data-resume-intervention-date/);
    assert.match(calendarClient, /Replanifier l’intervention/);
    assert.match(calendarClient, /event\?\.pausedAt \? "is-paused"/);
    assert.match(calendarClient, /canManageCalendarSchedule\(\) && canEditCalendarEvent\(event\)/);
    assert.match(styles, /\.calendar-intervention-pause/);
    assert.match(styles, /\.calendar-event\.is-paused/);
});

test("le report complet est conservé dans l’historique client", () => {
    assert.match(reschedulingMigration, /rescheduled_from_event_id BIGINT REFERENCES depannhome_calendar_events\(id\)/);
    assert.match(calendarServer, /Intervention mise en pause/);
    assert.match(calendarServer, /Intervention replanifiée/);
    assert.match(calendarServer, /appendClientInterventionHistory/);
    assert.match(calendarServer, /mission\.calendar_event_id=event\.id/);
    assert.match(clients, /Pause :/);
    assert.match(clients, /Intervention en pause/);
    assert.match(calendarServer, /Intervention n°\$\{id\} · Date initiale/);
});

test("les anciennes interventions en pause sont régularisées avant leur replanification", () => {
    assert.match(pausedStatusBackfillMigration, /event\.paused_at IS NOT NULL/);
    assert.match(pausedStatusBackfillMigration, /event\.event_status IN \('planned', 'confirmed', 'in_progress'\)/);
    assert.match(pausedStatusBackfillMigration, /SET event_status = 'cancelled'/);
    assert.match(pausedStatusBackfillMigration, /resumed\.rescheduled_from_event_id = event\.id/);
    assert.match(singleInterventionPauseMigration, /SET event_status='paused'/);
    assert.match(singleInterventionPauseMigration, /event_status IN \('planned','confirmed','in_progress','completed','cancelled','paused'\)/);
});
