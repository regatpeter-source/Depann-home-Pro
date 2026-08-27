import { createHash, createHmac } from "node:crypto";
import { getPool } from "./database.js";

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const METRIC_FLUSH_INTERVAL_MS = 60 * 1000;
const INCIDENT_AUTO_RESOLVE_MINUTES = 30;
const metricBuckets = new Map();
let healthTimer = null;
let metricTimer = null;
let lastPublicStatus = { status: "unavailable", checkedAt: null };
let lastCheckTimestamp = 0;

export async function initializeHealthDashboard(database = getPool()) {
    await database.query(`CREATE TABLE IF NOT EXISTS depannhome_health_incidents (
        id BIGSERIAL PRIMARY KEY,
        fingerprint CHAR(64) NOT NULL UNIQUE,
        module VARCHAR(60) NOT NULL,
        severity VARCHAR(20) NOT NULL CHECK(severity IN ('information','warning','important','critical')),
        error_type VARCHAR(100) NOT NULL DEFAULT '',
        route VARCHAR(240) NOT NULL DEFAULT '',
        technical_message VARCHAR(500) NOT NULL DEFAULT '',
        status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK(status IN ('open','monitoring','resolved')),
        occurrence_count INTEGER NOT NULL DEFAULT 1,
        affected_scope_hashes JSONB NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_array_length(affected_scope_hashes)<=100),
        deployment_version VARCHAR(120) NOT NULL DEFAULT '',
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at TIMESTAMPTZ,
        resolution_note VARCHAR(1000) NOT NULL DEFAULT '',
        updated_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL
    )`);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_health_incidents_status_idx ON depannhome_health_incidents(status,severity,last_seen_at DESC)");
    await database.query(`CREATE TABLE IF NOT EXISTS depannhome_health_check_results (
        id BIGSERIAL PRIMARY KEY,
        check_key VARCHAR(100) NOT NULL,
        module VARCHAR(60) NOT NULL,
        status VARCHAR(20) NOT NULL CHECK(status IN ('pass','warning','fail','unavailable')),
        severity VARCHAR(20) NOT NULL CHECK(severity IN ('information','warning','important','critical')),
        message VARCHAR(500) NOT NULL DEFAULT '',
        latency_ms INTEGER,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_health_checks_key_time_idx ON depannhome_health_check_results(check_key,checked_at DESC)");
    await database.query(`CREATE TABLE IF NOT EXISTS depannhome_health_http_metrics (
        bucket_start TIMESTAMPTZ NOT NULL,
        module VARCHAR(60) NOT NULL,
        route VARCHAR(240) NOT NULL,
        method VARCHAR(10) NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 0,
        server_error_count INTEGER NOT NULL DEFAULT 0,
        duration_total_ms BIGINT NOT NULL DEFAULT 0,
        duration_max_ms INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(bucket_start,module,route,method)
    )`);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_health_http_metrics_time_idx ON depannhome_health_http_metrics(bucket_start DESC)");
    await database.query(`CREATE TABLE IF NOT EXISTS depannhome_health_scheduler_runs (
        id BIGSERIAL PRIMARY KEY,
        scheduler_key VARCHAR(100) NOT NULL,
        source VARCHAR(30) NOT NULL DEFAULT 'scheduled',
        status VARCHAR(20) NOT NULL CHECK(status IN ('started','completed','failed','skipped')),
        duration_ms INTEGER,
        summary JSONB NOT NULL DEFAULT '{}'::jsonb,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
    )`);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_health_scheduler_runs_key_time_idx ON depannhome_health_scheduler_runs(scheduler_key,started_at DESC)");
    await database.query(`CREATE TABLE IF NOT EXISTS depannhome_health_deployments (
        id BIGSERIAL PRIMARY KEY,
        version VARCHAR(120) NOT NULL UNIQUE,
        commit_sha VARCHAR(80) NOT NULL DEFAULT '',
        environment VARCHAR(30) NOT NULL DEFAULT 'production',
        test_status VARCHAR(20) NOT NULL DEFAULT 'unknown' CHECK(test_status IN ('unknown','passed','failed')),
        tests_passed INTEGER NOT NULL DEFAULT 0,
        tests_failed INTEGER NOT NULL DEFAULT 0,
        deployed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await registerCurrentDeployment(database);
    await runHealthChecks(database).catch(error => console.warn("[health] initial checks unavailable", safeErrorCode(error)));
}

export function registerHealthDashboardRoutes(app, requireCreator) {
    app.get("/healthz", (_request, response) => {
        const stale = !lastCheckTimestamp || Date.now() - lastCheckTimestamp > CHECK_INTERVAL_MS * 2;
        const status = stale ? "unavailable" : lastPublicStatus.status;
        response.status(status === "unavailable" ? 503 : 200).json({ status, checkedAt: lastPublicStatus.checkedAt });
    });
    app.get("/api/creator/health", requireCreator, asyncHandler(async (_request, response) => {
        response.json(await loadHealthDashboard());
    }));
    app.post("/api/creator/health/diagnostics", requireCreator, asyncHandler(async (_request, response) => {
        const started = Date.now();
        const checks = await runHealthChecks();
        response.json({ checks, durationMs: Date.now() - started, message: "Diagnostic en lecture seule terminé." });
    }));
    app.patch("/api/creator/health/incidents/:incidentId", requireCreator, asyncHandler(async (request, response) => {
        const incidentId = positiveId(request.params.incidentId);
        const status = ["open", "monitoring", "resolved"].includes(request.body?.status) ? request.body.status : "";
        const resolutionNote = cleanText(request.body?.resolutionNote, 1000);
        if (!incidentId || !status) return response.status(400).json({ message: "Suivi d’incident invalide." });
        const { rows } = await getPool().query(`UPDATE depannhome_health_incidents SET status=$2,resolution_note=$3,resolved_at=CASE WHEN $2='resolved' THEN NOW() ELSE NULL END,updated_by=$4 WHERE id=$1 RETURNING id,status,resolved_at AS "resolvedAt"`, [incidentId,status,resolutionNote,request.user.sub]);
        if (!rows[0]) return response.status(404).json({ message: "Incident introuvable." });
        response.json({ incident: rows[0], message: "Suivi de l’incident enregistré." });
    }));
}

export function createHealthRequestMonitor() {
    return (request, response, next) => {
        if (!request.path.startsWith("/api/")) return next();
        const started = performance.now();
        let collected = false;
        const collect = statusCode => {
            if (collected) return;
            collected = true;
            const durationMs = Math.max(0, Math.round(performance.now() - started));
            collectHttpMetric({ method: request.method, route: normalizedRoute(request), module: moduleFromPath(request.path), statusCode, durationMs });
        };
        response.once("finish", () => collect(response.statusCode));
        response.once("close", () => collect(response.writableEnded ? response.statusCode : 0));
        next();
    };
}

export async function recordHealthError(error, request) {
    const status = Number(error?.status);
    if (status >= 400 && status < 500) return;
    const errorType = cleanText(error?.code || error?.name || "SERVER_ERROR", 100);
    const route = normalizedRoute(request);
    const module = moduleFromPath(request?.path || route);
    const severity = databaseError(error) ? "critical" : "important";
    await upsertIncident({ module, severity, errorType, route, technicalMessage: safeTechnicalMessage(error), scopeHash: ownerScopeHash(request) });
}

export async function recordHealthSchedulerRun(schedulerKey, source, status, summary = {}, startedAt = new Date()) {
    try {
        const durationMs = ["completed", "failed", "skipped"].includes(status) ? Math.max(0, Date.now() - new Date(startedAt).getTime()) : null;
        await getPool().query(`INSERT INTO depannhome_health_scheduler_runs(scheduler_key,source,status,duration_ms,summary,started_at,completed_at) VALUES($1::varchar(100),$2::varchar(30),$3::varchar(20),$4::integer,$5::jsonb,$6::timestamptz,CASE WHEN $3::varchar(20)='started' THEN NULL ELSE NOW() END)`, [cleanText(schedulerKey,100),cleanText(source,30),status,durationMs,JSON.stringify(safeDetails(summary)),startedAt]);
        if (status === "failed") await upsertIncident({ module: schedulerKey, severity: "important", errorType: "SCHEDULER_FAILURE", route: "scheduler", technicalMessage: `${schedulerKey} a échoué.` });
        if (status === "completed") await resolveIncident(fingerprintFor(schedulerKey, "SCHEDULER_FAILURE", "scheduler"));
    } catch (error) {
        console.warn("[health] scheduler observation unavailable", safeErrorCode(error));
    }
}

export function startHealthMonitoring() {
    if (!healthTimer) {
        healthTimer = setInterval(() => runHealthChecks().catch(error => console.warn("[health] checks unavailable", safeErrorCode(error))), CHECK_INTERVAL_MS);
        healthTimer.unref?.();
    }
    if (!metricTimer) {
        metricTimer = setInterval(() => flushHttpMetrics().catch(error => console.warn("[health] metric flush unavailable", safeErrorCode(error))), METRIC_FLUSH_INTERVAL_MS);
        metricTimer.unref?.();
    }
}

export async function runHealthChecks(database = getPool()) {
    const checks = [];
    const add = check => checks.push({ severity: "information", latencyMs: null, details: {}, ...check });
    const databaseStarted = performance.now();
    try {
        await database.query("SELECT 1 AS healthy");
        const latencyMs = Math.round(performance.now() - databaseStarted);
        add({ key: "database", module: "database", status: latencyMs > 1000 ? "warning" : "pass", severity: latencyMs > 1000 ? "warning" : "critical", message: latencyMs > 1000 ? "Base accessible mais lente." : "Base de données accessible.", latencyMs });
    } catch (error) {
        add({ key: "database", module: "database", status: "unavailable", severity: "critical", message: `Base de données indisponible (${safeErrorCode(error)}).`, latencyMs: Math.round(performance.now() - databaseStarted) });
        lastCheckTimestamp = Date.now();
        lastPublicStatus = { status: "unavailable", checkedAt: new Date().toISOString() };
        return persistChecks(checks, database).catch(() => checks);
    }
    add({ key: "server", module: "server", status: "pass", severity: "critical", message: "Processus serveur actif." });
    const waiting = Number(database.waitingCount || 0);
    const total = Number(database.totalCount || 0);
    add({ key: "database_pool", module: "database", status: waiting > 0 ? "warning" : "pass", severity: "warning", message: waiting > 0 ? `${waiting} requête(s) attendent une connexion.` : "Pool PostgreSQL disponible.", details: { total, idle: Number(database.idleCount || 0), waiting } });
    const sessionConfigured = String(process.env.SESSION_SECRET || "").length >= 32;
    const creatorConfigured = Boolean(String(process.env.CREATOR_USERNAMES || "").trim());
    add({ key: "authentication", module: "authentication", status: sessionConfigured && creatorConfigured ? "pass" : "fail", severity: "critical", message: sessionConfigured && creatorConfigured ? "Configuration d’authentification présente." : "Configuration d’authentification incomplète.", details: { sessionSecretConfigured: sessionConfigured, creatorAccessConfigured: creatorConfigured } });
    const queues = await database.query(`SELECT
        (SELECT COUNT(*)::int FROM depannhome_subscription_invoices WHERE status='failed') AS subscription_failed,
        (SELECT COUNT(*)::int FROM depannhome_subscription_credit_notes WHERE delivery_status='failed') AS credit_failed,
        (SELECT COUNT(*)::int FROM depannhome_einvoice_transmissions WHERE status IN ('failed','rejected')) AS einvoice_failed,
        (SELECT COUNT(*)::int FROM depannhome_partner_email_connections WHERE enabled=TRUE AND last_error<>'') AS email_failed`);
    const queue = queues.rows[0] || {};
    add(queueCheck("subscription_billing", "billing", Number(queue.subscription_failed), "facture(s) d’abonnement en échec"));
    add(queueCheck("subscription_credits", "credits", Number(queue.credit_failed), "avoir(s) en échec d’envoi"));
    add(queueCheck("electronic_invoicing", "e-invoicing", Number(queue.einvoice_failed), "transmission(s) électroniques en échec"));
    add(queueCheck("company_email", "company-email", Number(queue.email_failed), "connexion(s) e-mail en erreur"));
    add(configurationCheck("smtp", "external-services", ["BREVO_SMTP_HOST","BREVO_SMTP_USER","BREVO_SMTP_PASSWORD","BREVO_SMTP_FROM"]));
    add(configurationCheck("super_pdp", "e-invoicing", ["SUPERPDP_CLIENT_ID","SUPERPDP_CLIENT_SECRET","SUPERPDP_REDIRECT_URI"]));
    const apiMetrics = await database.query(`SELECT COALESCE(SUM(request_count),0)::int AS requests,COALESCE(SUM(server_error_count),0)::int AS errors,COALESCE(MAX(duration_max_ms),0)::int AS max_latency FROM depannhome_health_http_metrics WHERE bucket_start>NOW()-INTERVAL '15 minutes'`);
    const api = apiMetrics.rows[0] || {};
    const errorRate = Number(api.requests) ? Number(api.errors) / Number(api.requests) : 0;
    add({ key: "api_performance", module: "api", status: errorRate >= 0.05 || Number(api.max_latency) >= 5000 ? "warning" : "pass", severity: "warning", message: `${Number(api.requests) || 0} requête(s), ${Number(api.errors) || 0} erreur(s) serveur sur 15 min.`, details: { errorRate: Number(errorRate.toFixed(4)), maxLatencyMs: Number(api.max_latency) || 0 } });
    const schedulers = await latestSchedulers(database);
    for (const scheduler of schedulers) add(scheduler);
    await persistChecks(checks, database);
    await autoResolveStaleIncidents(database);
    const overall = healthStatus(checks, []);
    lastCheckTimestamp = Date.now();
    lastPublicStatus = { status: overall.status === "unavailable" ? "unavailable" : "operational", checkedAt: new Date().toISOString() };
    return checks;
}

async function loadHealthDashboard(database = getPool()) {
    const [latestChecks, incidents, metrics, schedulers, deployments] = await Promise.all([
        database.query(`SELECT DISTINCT ON(check_key) check_key AS key,module,status,severity,message,latency_ms AS "latencyMs",details,checked_at AS "checkedAt" FROM depannhome_health_check_results ORDER BY check_key,checked_at DESC`),
        database.query(`SELECT id,module,severity,error_type AS "errorType",route,technical_message AS "technicalMessage",status,occurrence_count AS "occurrenceCount",jsonb_array_length(affected_scope_hashes) AS "affectedOrganizations",deployment_version AS "deploymentVersion",first_seen_at AS "firstSeenAt",last_seen_at AS "lastSeenAt",resolved_at AS "resolvedAt",resolution_note AS "resolutionNote" FROM depannhome_health_incidents ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'monitoring' THEN 1 ELSE 2 END,CASE severity WHEN 'critical' THEN 0 WHEN 'important' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,last_seen_at DESC LIMIT 100`),
        database.query(`SELECT module,SUM(request_count)::int AS requests,SUM(server_error_count)::int AS errors,CASE WHEN SUM(request_count)>0 THEN ROUND(SUM(duration_total_ms)::numeric/SUM(request_count))::int ELSE 0 END AS "averageLatencyMs",MAX(duration_max_ms)::int AS "maxLatencyMs" FROM depannhome_health_http_metrics WHERE bucket_start>NOW()-INTERVAL '24 hours' GROUP BY module ORDER BY module`),
        database.query(`SELECT DISTINCT ON(scheduler_key) scheduler_key AS "schedulerKey",source,status,duration_ms AS "durationMs",summary,started_at AS "startedAt",completed_at AS "completedAt" FROM depannhome_health_scheduler_runs ORDER BY scheduler_key,started_at DESC`),
        database.query(`SELECT version,commit_sha AS "commitSha",environment,test_status AS "testStatus",tests_passed AS "testsPassed",tests_failed AS "testsFailed",deployed_at AS "deployedAt" FROM depannhome_health_deployments ORDER BY deployed_at DESC LIMIT 20`)
    ]);
    const overall = healthStatus(latestChecks.rows, incidents.rows.filter(item => item.status !== "resolved"));
    return { overall, checks: latestChecks.rows, incidents: incidents.rows, metrics: metrics.rows, schedulers: schedulers.rows, deployments: deployments.rows, generatedAt: new Date().toISOString(), retention: { metricsDays: 30, checksDays: 90, incidentsDays: 365 } };
}

function healthStatus(checks, incidents) {
    let score = 100;
    for (const check of checks) {
        if (check.status === "pass") continue;
        const weight = ({ critical: 30, important: 15, warning: 7, information: 2 })[check.severity] || 5;
        score -= check.status === "warning" ? Math.ceil(weight / 2) : weight;
    }
    score -= incidents.filter(item => item.severity === "critical").length * 10;
    score = Math.max(0, Math.min(100, score));
    const databaseDown = checks.some(check => check.key === "database" && check.status === "unavailable");
    const critical = incidents.some(item => item.severity === "critical") || checks.some(check => check.severity === "critical" && check.status === "fail");
    const failed = checks.some(check => ["fail","unavailable"].includes(check.status)) || incidents.some(item => item.severity === "important");
    const warning = checks.some(check => check.status === "warning") || incidents.some(item => item.severity === "warning");
    return { score, status: databaseDown ? "unavailable" : critical || failed ? "incident" : warning ? "warning" : "operational", label: databaseDown ? "SERVICE INDISPONIBLE" : critical || failed ? "INCIDENT" : warning ? "AVERTISSEMENT" : "OPÉRATIONNEL" };
}

async function persistChecks(checks, database) {
    for (const check of checks) {
        await database.query(`INSERT INTO depannhome_health_check_results(check_key,module,status,severity,message,latency_ms,details) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`, [check.key,check.module,check.status,check.severity,cleanText(check.message,500),check.latencyMs,JSON.stringify(safeDetails(check.details))]);
        const fingerprint = fingerprintFor(check.module, `HEALTH_CHECK_${check.key}`, check.key);
        if (["fail","unavailable"].includes(check.status)) await upsertIncident({ fingerprint, module: check.module, severity: check.severity, errorType: `HEALTH_CHECK_${check.key}`, route: check.key, technicalMessage: check.message }, database);
        else if (check.status === "pass") await resolveIncident(fingerprint, database);
    }
    return checks;
}

async function latestSchedulers(database) {
    const definitions = [{ key: "subscription_invoicing", maximumMinutes: 26 * 60 }, { key: "partner_email", maximumMinutes: 15 }];
    const checks = [];
    for (const definition of definitions) {
        const { rows } = await database.query(`SELECT status,started_at AS "startedAt" FROM depannhome_health_scheduler_runs WHERE scheduler_key=$1 ORDER BY started_at DESC LIMIT 1`, [definition.key]);
        const run = rows[0];
        const ageMinutes = run ? (Date.now() - new Date(run.startedAt).getTime()) / 60000 : Infinity;
        const healthy = run && run.status !== "failed" && ageMinutes <= definition.maximumMinutes;
        const silentFailure = process.uptime() > 10 * 60 && (!run || run.status === "failed" || ageMinutes > definition.maximumMinutes);
        checks.push({ key: `scheduler_${definition.key}`, module: definition.key, status: healthy ? "pass" : silentFailure ? "fail" : "warning", severity: silentFailure ? "important" : "warning", message: healthy ? "Dernière exécution observée dans le délai attendu." : run?.status === "failed" ? "Dernière exécution en échec." : "Aucune exécution récente observée.", latencyMs: null, details: { lastStatus: run?.status || "unknown", ageMinutes: Number.isFinite(ageMinutes) ? Math.round(ageMinutes) : null } });
    }
    return checks;
}

function collectHttpMetric(metric) {
    const bucketStart = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
    const key = [bucketStart,metric.module,metric.route,metric.method].join("|");
    const current = metricBuckets.get(key) || { bucketStart, module: metric.module, route: metric.route, method: metric.method, requestCount: 0, serverErrorCount: 0, durationTotalMs: 0, durationMaxMs: 0 };
    current.requestCount += 1;
    current.serverErrorCount += metric.statusCode === 0 || metric.statusCode >= 500 ? 1 : 0;
    current.durationTotalMs += metric.durationMs;
    current.durationMaxMs = Math.max(current.durationMaxMs, metric.durationMs);
    metricBuckets.set(key, current);
}

async function flushHttpMetrics(database = getPool()) {
    const entries = [...metricBuckets.values()];
    if (!entries.length) return;
    metricBuckets.clear();
    try {
        for (const item of entries) await database.query(`INSERT INTO depannhome_health_http_metrics(bucket_start,module,route,method,request_count,server_error_count,duration_total_ms,duration_max_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(bucket_start,module,route,method) DO UPDATE SET request_count=depannhome_health_http_metrics.request_count+EXCLUDED.request_count,server_error_count=depannhome_health_http_metrics.server_error_count+EXCLUDED.server_error_count,duration_total_ms=depannhome_health_http_metrics.duration_total_ms+EXCLUDED.duration_total_ms,duration_max_ms=GREATEST(depannhome_health_http_metrics.duration_max_ms,EXCLUDED.duration_max_ms)`, [item.bucketStart,item.module,item.route,item.method,item.requestCount,item.serverErrorCount,item.durationTotalMs,item.durationMaxMs]);
    } catch (error) {
        for (const item of entries) metricBuckets.set([item.bucketStart,item.module,item.route,item.method].join("|"), item);
        throw error;
    }
}

async function upsertIncident(incident, database = getPool()) {
    const fingerprint = incident.fingerprint || fingerprintFor(incident.module, incident.errorType, incident.route);
    const scopeHashes = incident.scopeHash ? [incident.scopeHash] : [];
    await database.query(`INSERT INTO depannhome_health_incidents(fingerprint,module,severity,error_type,route,technical_message,affected_scope_hashes,deployment_version) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT(fingerprint) DO UPDATE SET severity=EXCLUDED.severity,technical_message=EXCLUDED.technical_message,status='open',occurrence_count=depannhome_health_incidents.occurrence_count+1,last_seen_at=NOW(),resolved_at=NULL,affected_scope_hashes=CASE WHEN jsonb_array_length(depannhome_health_incidents.affected_scope_hashes)>=100 OR EXCLUDED.affected_scope_hashes='[]'::jsonb OR depannhome_health_incidents.affected_scope_hashes @> EXCLUDED.affected_scope_hashes THEN depannhome_health_incidents.affected_scope_hashes ELSE depannhome_health_incidents.affected_scope_hashes||EXCLUDED.affected_scope_hashes END`, [fingerprint,cleanText(incident.module,60),incident.severity,cleanText(incident.errorType,100),cleanText(incident.route,240),cleanText(incident.technicalMessage,500),JSON.stringify(scopeHashes),deploymentVersion()]);
}

async function resolveIncident(fingerprint, database = getPool()) {
    await database.query("UPDATE depannhome_health_incidents SET status='resolved',resolved_at=NOW() WHERE fingerprint=$1 AND status<>'resolved'", [fingerprint]);
}

async function autoResolveStaleIncidents(database) {
    await database.query(`UPDATE depannhome_health_incidents SET status='monitoring',resolution_note=CASE WHEN resolution_note='' THEN 'Sous surveillance après absence de nouvelle occurrence ; résolution manuelle requise.' ELSE resolution_note END WHERE status='open' AND last_seen_at<NOW()-($1::text||' minutes')::interval`, [INCIDENT_AUTO_RESOLVE_MINUTES]);
    await database.query("DELETE FROM depannhome_health_http_metrics WHERE bucket_start<NOW()-INTERVAL '30 days'");
    await database.query("DELETE FROM depannhome_health_check_results WHERE checked_at<NOW()-INTERVAL '90 days'");
    await database.query("DELETE FROM depannhome_health_scheduler_runs WHERE started_at<NOW()-INTERVAL '90 days'");
}

async function registerCurrentDeployment(database) {
    const version = deploymentVersion();
    await database.query(`INSERT INTO depannhome_health_deployments(version,commit_sha,environment,test_status,tests_passed,tests_failed) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(version) DO NOTHING`, [version,cleanText(process.env.RENDER_GIT_COMMIT,80),cleanText(process.env.NODE_ENV || "development",30),["passed","failed"].includes(process.env.HEALTH_TEST_STATUS) ? process.env.HEALTH_TEST_STATUS : "unknown",positiveInteger(process.env.HEALTH_TESTS_PASSED),positiveInteger(process.env.HEALTH_TESTS_FAILED)]);
}

function queueCheck(key, module, count, wording) {
    return { key, module, status: count > 0 ? "warning" : "pass", severity: "warning", message: count > 0 ? `${count} ${wording}.` : `Aucun ${wording}.`, details: { failedCount: count } };
}

function configurationCheck(key, module, variables) {
    const configured = variables.every(name => Boolean(String(process.env[name] || "").trim()));
    return { key, module, status: configured ? "pass" : "warning", severity: "warning", message: configured ? "Configuration présente." : "Configuration absente ou incomplète.", details: { configured } };
}

function normalizedRoute(request) {
    const raw = String(request?.originalUrl || request?.path || "/").split("?")[0];
    return raw.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":uuid").replace(/\/\d+(?=\/|$)/g, "/:id").replace(/\/[A-Za-z0-9_-]{32,}(?=\/|$)/g, "/:token").slice(0, 240);
}

function moduleFromPath(path) {
    const part = String(path || "").split("/").filter(Boolean).filter(item => !["api","creator"].includes(item))[0] || "server";
    return cleanText(part, 60).toLowerCase();
}

function ownerScopeHash(request) {
    const ownerId = request?.user?.activeCompanyId || request?.user?.accountOwnerId || request?.user?.account_owner_id;
    if (!ownerId) return "";
    const telemetryKey = process.env.HEALTH_TELEMETRY_SECRET || createHash("sha256").update(`${process.env.SESSION_SECRET || "health"}:health-telemetry`).digest("hex");
    return createHmac("sha256", telemetryKey).update(String(ownerId)).digest("hex").slice(0, 24);
}

function fingerprintFor(module, errorType, route) {
    return createHash("sha256").update(`${module}|${errorType}|${route}`).digest("hex");
}

function safeTechnicalMessage(error) {
    const source = String(error?.message || error?.code || error?.name || "Erreur serveur");
    return cleanText(source.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[email]").replace(/(bearer|token|secret|password|authorization|cookie|iban|bic)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]").replace(/https?:\/\/[^\s]+/gi, "[url]"), 500);
}

function safeDetails(details) {
    const allowed = {};
    for (const [key, value] of Object.entries(details && typeof details === "object" ? details : {})) {
        if (/password|secret|token|cookie|authorization|iban|bic|email|phone|name|address/i.test(key)) continue;
        if (["string","number","boolean"].includes(typeof value) || value === null) allowed[key] = typeof value === "string" ? safeDetailValue(value) : value;
    }
    return allowed;
}

function safeErrorCode(error) { return cleanText(error?.code || error?.name || "ERROR", 80); }
function databaseError(error) { return /^PG|ECONN|57P|08/.test(String(error?.code || "")) || /database|postgres/i.test(String(error?.name || "")); }
function safeDetailValue(value) {
    const cleaned = cleanText(value, 200);
    return /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?:bearer|token|secret|password|authorization|cookie|iban|bic)\s*[:=]|https?:\/\//i.test(cleaned) ? "[redacted]" : cleaned;
}
function deploymentVersion() {
    const version = cleanText(process.env.RENDER_GIT_COMMIT || process.env.APP_VERSION || `${process.env.NODE_ENV || "development"}-local`, 80);
    return /^[a-z0-9._-]+$/i.test(version) ? version : "invalid-version";
}
function cleanText(value, limit) { return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit); }
function positiveId(value) { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : 0; }
function positiveInteger(value) { const number = Number(value); return Number.isSafeInteger(number) && number >= 0 ? number : 0; }
function asyncHandler(handler) { return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next); }

export const healthStatusForTest = healthStatus;
export const sanitizeHealthErrorForTest = safeTechnicalMessage;
