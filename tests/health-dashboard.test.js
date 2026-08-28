import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { healthStatusForTest, sanitizeHealthErrorForTest } from "../server/health-dashboard.js";

const server = readFileSync(new URL("../server/health-dashboard.js", import.meta.url), "utf8");
const application = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const creator = readFileSync(new URL("../js/creator.js", import.meta.url), "utf8");
const client = readFileSync(new URL("../js/health-dashboard.js", import.meta.url), "utf8");
const schema = readFileSync(new URL("../database/schema.sql", import.meta.url), "utf8");

const healthyChecks = [
    { key: "database", status: "pass", severity: "critical" },
    { key: "server", status: "pass", severity: "critical" },
    { key: "api", status: "pass", severity: "warning" }
];

test("le score de santé distingue fonctionnement, avertissement, incident et indisponibilité", () => {
    assert.deepEqual(healthStatusForTest(healthyChecks, []), { score: 100, status: "operational", label: "OPÉRATIONNEL" });
    assert.equal(healthStatusForTest([...healthyChecks, { key: "smtp", status: "warning", severity: "warning" }], []).status, "warning");
    assert.equal(healthStatusForTest(healthyChecks, [{ severity: "important" }]).status, "incident");
    assert.equal(healthStatusForTest([{ key: "database", status: "unavailable", severity: "critical" }], []).status, "unavailable");
});

test("les erreurs sont expurgées avant conservation", () => {
    const sanitized = sanitizeHealthErrorForTest(new Error("token=secret-value pour client@example.com via https://private.example/path"));
    assert.doesNotMatch(sanitized, /secret-value|client@example|private\.example/);
    assert.match(sanitized, /\[redacted\]|\[email\]|\[url\]/);
});

test("les tables Santé sont isolées et disposent de rétention", () => {
    for (const table of ["depannhome_health_incidents", "depannhome_health_check_results", "depannhome_health_http_metrics", "depannhome_health_scheduler_runs", "depannhome_health_deployments"]) {
        assert.match(server, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
        assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    }
    assert.match(server, /DELETE FROM depannhome_health_http_metrics WHERE bucket_start<NOW\(\)-INTERVAL '30 days'/);
    assert.match(server, /DELETE FROM depannhome_health_check_results WHERE checked_at<NOW\(\)-INTERVAL '90 days'/);
    assert.doesNotMatch(server, /DELETE FROM depannhome_(?:users|clients|billing_documents|subscription_invoices)/);
});

test("les diagnostics détaillés et la résolution sont réservés au Créateur", () => {
    assert.match(server, /app\.get\("\/api\/creator\/health", requireCreator/);
    assert.match(server, /app\.post\("\/api\/creator\/health\/diagnostics", requireCreator/);
    assert.match(server, /app\.patch\("\/api\/creator\/health\/incidents\/:incidentId", requireCreator/);
    assert.match(server, /app\.get\("\/healthz"/);
    assert.match(server, /version: deploymentVersion\(\)/);
    assert.doesNotMatch(server, /app\.get\("\/healthz"[\s\S]{0,300}(?:incidents|technicalMessage|details)/);
    assert.match(server, /status=\$2::varchar\(20\)[\s\S]*CASE WHEN \$2::varchar\(20\)='resolved'/);
});

test("la collecte HTTP est agrégée et ne conserve aucun corps ni secret", () => {
    const collector = server.slice(server.indexOf("export function createHealthRequestMonitor"), server.indexOf("export async function recordHealthError"));
    assert.match(collector, /response\.once\("finish"/);
    assert.match(collector, /response\.once\("close"/);
    assert.match(collector, /metricBuckets|collectHttpMetric/);
    assert.match(server, /ON CONFLICT\(bucket_start,module,route,method\) DO UPDATE/);
    assert.doesNotMatch(collector, /request\.body|request\.headers|request\.cookies/);
    assert.match(server, /password\|secret\|token\|cookie\|authorization\|iban\|bic/);
    assert.match(server, /status='monitoring'/);
    assert.doesNotMatch(server, /Résolu automatiquement après absence/);
});

test("le gestionnaire global enregistre les 5xx sans exposer la stack", () => {
    assert.match(application, /recordHealthError\(error, request\)/);
    assert.match(application, /createHealthRequestMonitor\(\)/);
    assert.doesNotMatch(client, /\.stack|stackTrace/);
    assert.match(application, /Erreur interne du serveur/);
});

test("la Console Créateur donne accès au centre de contrôle", () => {
    assert.match(creator, /id="creatorHealthDashboard"/);
    assert.match(creator, /renderHealthDashboard/);
    assert.match(client, /Santé du système/);
    assert.match(client, /Incidents critiques/);
    assert.match(client, /Diagnostic manuel sécurisé/);
    assert.match(client, /Aucune donnée métier n’est créée, modifiée ou supprimée/);
});

test("les ordonnanceurs publient uniquement des observations techniques", () => {
    const invoicing = readFileSync(new URL("../server/invoicing.js", import.meta.url), "utf8");
    const email = readFileSync(new URL("../server/partner-email.js", import.meta.url), "utf8");
    assert.match(invoicing, /recordHealthSchedulerRun\("subscription_invoicing"/);
    assert.match(email, /recordHealthSchedulerRun\("partner_email"/);
    assert.match(server, /\$1::varchar\(100\).*\$3::varchar\(20\).*\$4::integer.*\$6::timestamptz/);
    assert.match(server, /CASE WHEN \$3::varchar\(20\)='started'/);
});
