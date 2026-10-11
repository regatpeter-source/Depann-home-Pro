import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sanitizePublicAnalyticsEvent } from "../server/public-analytics.js";

const server = readFileSync(new URL("../server/public-analytics.js", import.meta.url), "utf8");
const application = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const migration = readFileSync(new URL("../database/migrations/0039_public_site_analytics.sql", import.meta.url), "utf8");
const schema = readFileSync(new URL("../database/schema.sql", import.meta.url), "utf8");
const publicClient = readFileSync(new URL("../public/site.js", import.meta.url), "utf8");
const creatorClient = readFileSync(new URL("../js/creator.js", import.meta.url), "utf8");

const tableSources = [migration, schema];

test("les événements publics sont limités aux pages et actions connues", () => {
    assert.deepEqual(sanitizePublicAnalyticsEvent({ type: "page_view", page: "/logiciel-planning-interventions?source=test" }), { type: "page_view", page: "/logiciel-planning-interventions", target: "" });
    assert.deepEqual(sanitizePublicAnalyticsEvent({ type: "page_view", page: "/logiciel-gestion-plombier" }), { type: "page_view", page: "/logiciel-gestion-plombier", target: "" });
    assert.deepEqual(sanitizePublicAnalyticsEvent({ type: "click", page: "/", target: "demo_request" }), { type: "click", page: "/", target: "demo_request" });
    assert.equal(sanitizePublicAnalyticsEvent({ type: "click", page: "/", target: "texte-libre" }), null);
    assert.equal(sanitizePublicAnalyticsEvent({ type: "page_view", page: "/api/auth/session" }), null);
    assert.equal(sanitizePublicAnalyticsEvent({ type: "script", page: "/" }), null);
});

test("la mesure est agrégée sans identifiant visiteur ni métadonnée réseau", () => {
    for (const source of tableSources) {
        const start = source.indexOf("CREATE TABLE IF NOT EXISTS depannhome_public_analytics_daily");
        const table = source.slice(start, source.indexOf(";", start) + 1);
        assert.match(table, /CREATE TABLE IF NOT EXISTS depannhome_public_analytics_daily/);
        assert.match(table, /PRIMARY KEY\(metric_date,page_path,event_type,event_target\)/);
        assert.doesNotMatch(table, /^\s*(?:visitor_id|session_id|ip_address|user_agent|referer|referrer)\s+/im);
    }
    assert.match(server, /ON CONFLICT\(metric_date,page_path,event_type,event_target\)/);
    assert.doesNotMatch(server, /request\.(?:ip|headers|cookies)/);
    assert.match(migration, /INTERVAL '25 months'/);
    assert.match(server, /INTERVAL '25 months'/);
});

test("l’écriture est publique, limitée, et les statistiques restent réservées au Créateur", () => {
    assert.match(application, /\/api\/public\/analytics\/events[\s\S]*?limit: 120/);
    assert.match(application, /registerPublicAnalyticsRoutes\(app, requireCreator\)/);
    assert.match(server, /app\.post\("\/api\/public\/analytics\/events"/);
    assert.match(server, /app\.get\("\/api\/creator\/public-analytics", requireCreator/);
    assert.match(server, /const PERIODS = new Set\(\[7, 30, 90, 365\]\)/);
});

test("la vitrine compte les pages et clics sans cookie et respecte Do Not Track", () => {
    assert.match(publicClient, /navigator\.doNotTrack === "1"/);
    assert.match(publicClient, /credentials: "omit"/);
    assert.match(publicClient, /recordPublicAnalytics\("page_view"\)/);
    assert.match(publicClient, /recordPublicAnalytics\("click", target\)/);
    assert.match(publicClient, /\/api\/public\/analytics\/events/);
    assert.doesNotMatch(publicClient, /document\.cookie|localStorage|sessionStorage/);
});

test("la Console Créateur affiche la synthèse et le détail de l’audience", () => {
    assert.match(creatorClient, /id="creatorPublicAnalytics"/);
    assert.match(creatorClient, /renderCreatorPublicAnalytics/);
    assert.match(creatorClient, /\/api\/creator\/public-analytics/);
    assert.match(creatorClient, /Pages vues/);
    assert.match(creatorClient, /Clics d’intention/);
    assert.match(creatorClient, /data-refresh-analytics>Actualiser/);
    assert.match(creatorClient, /public-analytics\?days=\$\{encodeURIComponent\(days\)\}`,[^\n]+cache: "no-store"/);
    assert.match(server, /response\.set\("Cache-Control", "no-store"\)/);
});
