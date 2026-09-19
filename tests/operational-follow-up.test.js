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
const styles = read("css/style.css");

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
    assert.match(styles, /\.dashboard-follow-up-grid/);
});

test("la date de relance d’un devis est modifiable et persistée", () => {
    assert.match(migration, /follow_up_date DATE/);
    assert.match(schema, /depannhome_billing_documents_follow_up_idx/);
    assert.match(billingClient, /name="followUpDate" type="date"/);
    assert.match(billingServer, /TO_CHAR\(follow_up_date, 'YYYY-MM-DD'\) AS "followUpDate"/);
    assert.match(billingServer, /document\.followUpDate \|\| null/);
    assert.match(billingServer, /documentType === "quote" \? sanitizeDate\(value\?\.followUpDate\)/);
});

test("une intervention peut être suspendue avec un motif puis reprise", () => {
    assert.match(migration, /paused_at TIMESTAMPTZ/);
    assert.match(migration, /pause_reason VARCHAR\(40\)/);
    assert.match(calendarServer, /PAUSE_REASONS = new Set/);
    assert.match(calendarServer, /\/api\/calendar\/events\/:eventId\/pause/);
    assert.match(calendarServer, /\/api\/calendar\/events\/:eventId\/resume/);
    assert.match(calendarServer, /canRequestInterventionPause\(request\.user\)/);
    assert.match(calendarServer, /EXISTS \(SELECT 1 FROM depannhome_calendar_assignments/);
    assert.match(calendarClient, /Matériel non reçu/);
    assert.match(calendarClient, /Technicien absent/);
    assert.match(calendarClient, /data-resume-intervention/);
    assert.match(calendarClient, /event\?\.pausedAt \? "is-paused"/);
    assert.match(styles, /\.calendar-intervention-pause/);
    assert.match(styles, /\.calendar-event\.is-paused/);
});

test("la clôture d’une intervention retire automatiquement son suivi de pause", () => {
    assert.match(calendarServer, /paused_at=CASE WHEN \$13 IN \('completed','cancelled'\) THEN NULL/);
    assert.match(calendarServer, /event\.event_status NOT IN \('completed','cancelled'\)/);
});
