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
const styles = read("css/style.css");
const clients = read("js/clients.js");

test("le tableau de bord remplace les clients par les rapports à corriger ou envoyer", () => {
    assert.match(navigation, /Rapports à corriger \/ envoyer/);
    assert.match(navigation, /report\.status === "submitted"/);
    assert.match(navigation, /report\.status === "ready_to_send"/);
    assert.match(navigation, /reports: renderTechnicalReports/);
});

test("les documents à suivre distinguent les quatre actions opérationnelles", () => {
    assert.match(navigation, /Factures à faire/);
    assert.match(navigation, /Factures à envoyer/);
    assert.match(navigation, /Devis à relancer/);
    assert.match(navigation, /Interventions à reprendre/);
    assert.match(navigation, /document\.status \|\| ""\)\.toLowerCase\(\) === "accepted"/);
    assert.match(navigation, /document\.issuedAt && !document\.isEmailSent/);
    assert.match(navigation, /document\.followUpDate <= today/);
    assert.match(navigation, /\/api\/calendar\/paused/);
    assert.match(navigation, /followUp\.pausedInterventions\[0\]/);
    assert.match(navigation, /renderCalendar\(\{ date: new Date/);
    assert.match(navigation, /dashboard-kpi-breakdown/);
    assert.doesNotMatch(navigation, /<section class="dashboard-follow-up"/);
    assert.match(styles, /\.dashboard-kpi-breakdown/);
});

test("la date de relance d’un devis est modifiable et persistée", () => {
    assert.match(migration, /follow_up_date DATE/);
    assert.match(schema, /depannhome_billing_documents_follow_up_idx/);
    assert.match(billingClient, /name="followUpDate" type="date"/);
    assert.match(billingServer, /TO_CHAR\(follow_up_date, 'YYYY-MM-DD'\) AS "followUpDate"/);
    assert.match(billingServer, /document\.followUpDate \|\| null/);
    assert.match(billingServer, /documentType === "quote" \? sanitizeDate\(value\?\.followUpDate\)/);
});

test("une intervention mise en pause est annulée puis replanifiée à une autre date", () => {
    assert.match(migration, /paused_at TIMESTAMPTZ/);
    assert.match(migration, /pause_reason VARCHAR\(40\)/);
    assert.match(calendarServer, /PAUSE_REASONS = new Set/);
    assert.match(calendarServer, /\/api\/calendar\/events\/:eventId\/pause/);
    assert.match(calendarServer, /\/api\/calendar\/events\/:eventId\/resume/);
    assert.match(calendarServer, /SET event_status='cancelled',paused_at=\$3/);
    assert.match(calendarServer, /if \(newDate === source\.date\)/);
    assert.match(calendarServer, /INSERT INTO depannhome_calendar_events/);
    assert.match(calendarServer, /rescheduled_from_event_id/);
    assert.match(calendarServer, /event\.event_type='appointment' AND event\.paused_at IS NOT NULL/);
    assert.match(calendarServer, /if \(source\.status !== "cancelled"\)/);
    assert.match(calendarServer, /SET event_status='cancelled',updated_at=NOW\(\) WHERE id=\$1 AND owner_id=\$2/);
    assert.match(calendarServer, /canRequestInterventionPause\(request\.user\)/);
    assert.match(calendarServer, /EXISTS \(SELECT 1 FROM depannhome_calendar_assignments/);
    assert.match(calendarClient, /Matériel non reçu/);
    assert.match(calendarClient, /Technicien absent/);
    assert.match(calendarClient, /data-resume-intervention/);
    assert.match(calendarClient, /data-resume-intervention-date/);
    assert.match(calendarClient, /Replanifier l’intervention/);
    assert.match(calendarClient, /event\?\.pausedAt \? "is-paused"/);
    assert.match(styles, /\.calendar-intervention-pause/);
    assert.match(styles, /\.calendar-event\.is-paused/);
});

test("le report complet est conservé dans l’historique client", () => {
    assert.match(reschedulingMigration, /rescheduled_from_event_id BIGINT REFERENCES depannhome_calendar_events\(id\)/);
    assert.match(calendarServer, /Intervention mise en pause et annulée/);
    assert.match(calendarServer, /Intervention reprise après pause/);
    assert.match(calendarServer, /Intervention replanifiée/);
    assert.match(calendarServer, /appendClientInterventionHistory/);
    assert.match(calendarServer, /mission\.calendar_event_id=event\.id/);
    assert.match(clients, /Pause :/);
    assert.match(clients, /Replanifiée sous l’intervention/);
    assert.match(clients, /Reprise de l’intervention/);
    assert.match(calendarServer, /Cette intervention mise en pause et annulée doit rester dans l’historique du client/);
});

test("les anciennes interventions en pause sont régularisées avant leur replanification", () => {
    assert.match(pausedStatusBackfillMigration, /event\.paused_at IS NOT NULL/);
    assert.match(pausedStatusBackfillMigration, /event\.event_status IN \('planned', 'confirmed', 'in_progress'\)/);
    assert.match(pausedStatusBackfillMigration, /SET event_status = 'cancelled'/);
    assert.match(pausedStatusBackfillMigration, /resumed\.rescheduled_from_event_id = event\.id/);
    assert.match(calendarServer, /if \(source\.status === "completed"\)/);
});
