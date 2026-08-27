import { escapeHtml } from "./utils.js?v=44";

const STATUS_META = {
    operational: { icon: "🟢", label: "OPÉRATIONNEL" },
    warning: { icon: "🟠", label: "AVERTISSEMENT" },
    incident: { icon: "🔴", label: "INCIDENT" },
    unavailable: { icon: "⚫", label: "SERVICE INDISPONIBLE" },
    pass: { icon: "🟢", label: "OK" },
    fail: { icon: "🔴", label: "Erreur" }
};

export async function renderHealthDashboard(workspace = document.querySelector("#creatorWorkspace")) {
    if (!workspace) return;
    workspace.innerHTML = '<p class="muted">Analyse silencieuse de la santé du système…</p>';
    const result = await api("/api/creator/health");
    if (!result.ok) {
        workspace.innerHTML = `<p class="auth-message error">${escapeHtml(result.message || "Impossible de charger le tableau de santé.")}</p>`;
        return;
    }
    render(workspace, result.data);
}

function render(workspace, data) {
    const overall = data.overall || { score: 0, status: "unavailable", label: "SERVICE INDISPONIBLE" };
    const meta = STATUS_META[overall.status] || STATUS_META.unavailable;
    const openIncidents = (data.incidents || []).filter(item => item.status !== "resolved");
    const criticalCount = openIncidents.filter(item => item.severity === "critical").length;
    const warningCount = openIncidents.filter(item => ["warning","important"].includes(item.severity)).length;
    workspace.innerHTML = `<section class="creator-health-dashboard">
        <header class="health-hero health-${escapeHtml(overall.status)}"><div><p class="eyebrow">🩺 Centre de contrôle Créateur</p><h3>Santé du système</h3><p>Surveillance en lecture seule · mise à jour ${escapeHtml(formatDateTime(data.generatedAt))}</p></div><div class="health-score"><strong>${Number(overall.score) || 0} %</strong><span>${meta.icon} ${escapeHtml(overall.label || meta.label)}</span></div></header>
        <div class="health-alert-summary"><article class="${criticalCount ? "attention" : ""}"><span>Incidents critiques</span><strong>${criticalCount}</strong></article><article class="${warningCount ? "attention" : ""}"><span>Alertes à examiner</span><strong>${warningCount}</strong></article><article><span>Contrôles actifs</span><strong>${(data.checks || []).length}</strong></article><article><span>Modules mesurés sur 24 h</span><strong>${(data.metrics || []).length}</strong></article></div>
        <nav class="health-tabs" aria-label="Sections Santé">${[["services","Services"],["incidents","Incidents"],["performance","Performance"],["schedulers","Tâches"],["deployments","Tests & déploiements"],["diagnostics","Diagnostic"]].map(([id,label],index) => `<button type="button" class="secondary-button${index === 0 ? " active" : ""}" data-health-tab="${id}">${label}</button>`).join("")}</nav>
        <section class="health-tab-panel" data-health-panel="services">${renderChecks(data.checks || [])}</section>
        <section class="health-tab-panel" data-health-panel="incidents" hidden>${renderIncidents(data.incidents || [])}</section>
        <section class="health-tab-panel" data-health-panel="performance" hidden>${renderMetrics(data.metrics || [])}</section>
        <section class="health-tab-panel" data-health-panel="schedulers" hidden>${renderSchedulers(data.schedulers || [])}</section>
        <section class="health-tab-panel" data-health-panel="deployments" hidden>${renderDeployments(data.deployments || [])}</section>
        <section class="health-tab-panel" data-health-panel="diagnostics" hidden><article class="health-diagnostic-card"><h4>Diagnostic manuel sécurisé</h4><p>Exécute uniquement des lectures légères : base, files d’échec, configuration et métriques. Aucune donnée métier n’est créée, modifiée ou supprimée.</p><button type="button" class="primary-button" data-health-diagnostic>Exécuter le diagnostic</button><p class="auth-message" data-health-diagnostic-feedback aria-live="polite"></p></article></section>
        <p class="health-retention">Rétention : métriques ${Number(data.retention?.metricsDays) || 30} jours · contrôles ${Number(data.retention?.checksDays) || 90} jours · incidents ${Number(data.retention?.incidentsDays) || 365} jours.</p>
    </section>`;
    bindDashboard(workspace);
}

function renderChecks(checks) {
    return `<div class="health-section-heading"><div><p class="eyebrow">Services et modules existants</p><h4>Contrôles automatiques</h4></div></div><div class="health-card-grid">${checks.length ? checks.map(check => { const meta = STATUS_META[check.status] || (check.status === "warning" ? STATUS_META.warning : STATUS_META.unavailable); return `<article class="health-card health-${escapeHtml(check.status)}"><div class="health-card-title"><strong>${meta.icon} ${escapeHtml(moduleLabel(check.module))}</strong><span>${escapeHtml(meta.label)}</span></div><p>${escapeHtml(check.message)}</p><small>${check.latencyMs !== null && check.latencyMs !== undefined ? `${Number(check.latencyMs)} ms · ` : ""}${escapeHtml(formatDateTime(check.checkedAt))}</small>${renderSafeDetails(check.details)}</article>`; }).join("") : '<p class="muted">Aucun contrôle disponible.</p>'}</div>`;
}

function renderIncidents(incidents) {
    return `<div class="health-section-heading"><div><p class="eyebrow">Détection dédupliquée</p><h4>🚨 Incidents</h4></div></div><div class="health-incident-list">${incidents.length ? incidents.map(incident => `<article class="health-incident health-severity-${escapeHtml(incident.severity)}"><div><div class="health-card-title"><strong>${severityIcon(incident.severity)} ${escapeHtml(moduleLabel(incident.module))}</strong><span>${escapeHtml(incidentStatusLabel(incident.status))}</span></div><h5>${escapeHtml(incident.errorType || "Incident technique")}</h5><p>${escapeHtml(incident.technicalMessage || "Détail technique non exposé.")}</p><small>Première détection : ${escapeHtml(formatDateTime(incident.firstSeenAt))} · Dernière : ${escapeHtml(formatDateTime(incident.lastSeenAt))}</small><small>Durée observée : ${escapeHtml(formatDuration(incident.firstSeenAt, incident.resolvedAt || incident.lastSeenAt))} · Occurrences : ${Number(incident.occurrenceCount) || 1} · Entreprises potentiellement concernées : ${Number(incident.affectedOrganizations) || 0}${incident.deploymentVersion ? ` · Version : ${escapeHtml(incident.deploymentVersion)}` : ""}</small>${incident.resolvedAt ? `<small class="health-resolved">Résolu : ${escapeHtml(formatDateTime(incident.resolvedAt))}${incident.resolutionNote ? ` · ${escapeHtml(incident.resolutionNote)}` : ""}</small>` : ""}</div>${incident.status !== "resolved" ? `<form data-health-incident-form="${escapeHtml(incident.id)}"><select name="status"><option value="monitoring" ${incident.status === "monitoring" ? "selected" : ""}>Sous surveillance</option><option value="resolved">Résolu</option><option value="open" ${incident.status === "open" ? "selected" : ""}>En cours</option></select><input name="resolutionNote" maxlength="1000" value="${escapeHtml(incident.resolutionNote || "")}" placeholder="Note de résolution sans donnée sensible"><button class="secondary-button">Enregistrer</button></form>` : ""}</article>`).join("") : '<p class="health-empty-success">🟢 Aucun incident enregistré.</p>'}</div>`;
}

function renderMetrics(metrics) {
    return `<div class="health-section-heading"><div><p class="eyebrow">Agrégation anonyme sur 24 heures</p><h4>Temps de réponse API</h4></div></div><div class="health-table-wrap"><table class="health-table"><thead><tr><th>Module</th><th>Requêtes</th><th>Erreurs serveur</th><th>Moyenne</th><th>Maximum</th></tr></thead><tbody>${metrics.length ? metrics.map(metric => `<tr><td>${escapeHtml(moduleLabel(metric.module))}</td><td>${Number(metric.requests) || 0}</td><td class="${Number(metric.errors) ? "health-cell-alert" : ""}">${Number(metric.errors) || 0}</td><td>${Number(metric.averageLatencyMs) || 0} ms</td><td class="${Number(metric.maxLatencyMs) >= 5000 ? "health-cell-alert" : ""}">${Number(metric.maxLatencyMs) || 0} ms</td></tr>`).join("") : '<tr><td colspan="5">Les premières métriques apparaîtront après une minute d’utilisation.</td></tr>'}</tbody></table></div>`;
}

function renderSchedulers(schedulers) {
    return `<div class="health-section-heading"><div><p class="eyebrow">Exécutions observées</p><h4>Tâches planifiées</h4></div></div><div class="health-card-grid">${schedulers.length ? schedulers.map(run => `<article class="health-card health-${run.status === "completed" ? "pass" : run.status === "failed" ? "fail" : "warning"}"><div class="health-card-title"><strong>${run.status === "completed" ? "🟢" : run.status === "failed" ? "🔴" : "🟠"} ${escapeHtml(moduleLabel(run.schedulerKey))}</strong><span>${escapeHtml(run.status)}</span></div><p>${escapeHtml(run.source || "scheduled")}${run.durationMs !== null ? ` · ${Number(run.durationMs)} ms` : ""}</p><small>${escapeHtml(formatDateTime(run.completedAt || run.startedAt))}</small>${renderSafeDetails(run.summary)}</article>`).join("") : '<p class="muted">Aucune exécution observée depuis l’activation du module.</p>'}</div>`;
}

function renderDeployments(deployments) {
    return `<div class="health-section-heading"><div><p class="eyebrow">Corrélation version / incidents</p><h4>Historique des déploiements</h4></div></div><div class="health-deployment-list">${deployments.length ? deployments.map(deployment => `<article><div><strong>${escapeHtml(deployment.version)}</strong><p>${escapeHtml(deployment.environment)} · ${escapeHtml(formatDateTime(deployment.deployedAt))}</p></div><div><span class="health-test-${escapeHtml(deployment.testStatus)}">Tests : ${escapeHtml(deployment.testStatus)}</span>${deployment.testsPassed || deployment.testsFailed ? `<small>${Number(deployment.testsPassed) || 0} réussis · ${Number(deployment.testsFailed) || 0} échoués</small>` : ""}</div></article>`).join("") : '<p class="muted">Aucun déploiement enregistré.</p>'}</div>`;
}

function bindDashboard(workspace) {
    workspace.querySelectorAll("[data-health-tab]").forEach(button => button.addEventListener("click", () => {
        workspace.querySelectorAll("[data-health-tab]").forEach(item => item.classList.toggle("active", item === button));
        workspace.querySelectorAll("[data-health-panel]").forEach(panel => { panel.hidden = panel.dataset.healthPanel !== button.dataset.healthTab; });
    }));
    workspace.querySelector("[data-health-diagnostic]")?.addEventListener("click", async event => {
        const feedback = workspace.querySelector("[data-health-diagnostic-feedback]");
        event.currentTarget.disabled = true;
        feedback.classList.remove("error");
        feedback.textContent = "Contrôles en lecture seule en cours…";
        const result = await api("/api/creator/health/diagnostics", { method: "POST", body: "{}", timeoutMs: 30_000 });
        if (!result.ok) { event.currentTarget.disabled = false; feedback.classList.add("error"); feedback.textContent = result.message || "Diagnostic impossible."; return; }
        feedback.textContent = `${result.data.message} ${Number(result.data.durationMs) || 0} ms.`;
        await renderHealthDashboard(workspace);
    });
    workspace.querySelectorAll("[data-health-incident-form]").forEach(form => form.addEventListener("submit", async event => {
        event.preventDefault();
        const button = form.querySelector("button"); button.disabled = true;
        const result = await api(`/api/creator/health/incidents/${encodeURIComponent(form.dataset.healthIncidentForm)}`, { method: "PATCH", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
        if (!result.ok) { button.disabled = false; return; }
        await renderHealthDashboard(workspace);
    }));
}

function renderSafeDetails(details) {
    const entries = Object.entries(details && typeof details === "object" ? details : {}).filter(([,value]) => ["string","number","boolean"].includes(typeof value));
    return entries.length ? `<dl class="health-details">${entries.map(([key,value]) => `<div><dt>${escapeHtml(detailLabel(key))}</dt><dd>${escapeHtml(String(value))}</dd></div>`).join("")}</dl>` : "";
}

function moduleLabel(module) { return ({ server: "Serveur / API", database: "Base de données", authentication: "Authentification", billing: "Facturation", credits: "Avoirs", "e-invoicing": "Facturation électronique", "company-email": "Espace e-mail", "external-services": "Services externes", api: "API", subscription_invoicing: "Facturation abonnements", partner_email: "Synchronisation e-mail" })[module] || String(module || "Système").replace(/[-_]/g, " "); }
function detailLabel(key) { return ({ total: "Connexions", idle: "Disponibles", waiting: "En attente", configured: "Configuré", failedCount: "Échecs", errorRate: "Taux d’erreur", maxLatencyMs: "Latence maximale", lastStatus: "Dernier état", ageMinutes: "Ancienneté (min)" })[key] || key; }
function severityIcon(severity) { return ({ critical: "🔴", important: "🔴", warning: "🟠", information: "🟢" })[severity] || "🟠"; }
function incidentStatusLabel(status) { return ({ open: "EN COURS", monitoring: "SOUS SURVEILLANCE", resolved: "RÉSOLU" })[status] || status; }
function formatDateTime(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "date inconnue" : new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(date); }
function formatDuration(start, end) { const duration = Math.max(0, new Date(end).getTime() - new Date(start).getTime()); const minutes = Math.round(duration / 60000); return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`; }

async function api(url, options = {}) {
    try {
        const response = await fetch(url, { credentials: "same-origin", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
        const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
        return { ok: response.ok, data, message: data.message };
    } catch {
        return { ok: false, data: {}, message: "Le serveur ne répond pas." };
    }
}
