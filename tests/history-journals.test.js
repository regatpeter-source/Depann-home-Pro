import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getUnifiedHistory, normalizeHistoryFilters } from "../server/history.js";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const server = read("server/history.js");
const app = read("app.js");
const navigation = read("js/navigation.js");
const client = read("js/history.js");
const serviceWorker = read("service-worker.js");

function validFilters(overrides = {}) {
    return { ok: true, category: "members", order: "desc", limit: 50, offset: 0, search: "", dateFrom: "2025-09-18T00:00:00.000Z", dateTo: "2026-09-18T00:00:00.000Z", dateToExclusive: "2026-09-19T00:00:00.000Z", ...overrides };
}

test("les journaux utilisent une période de douze mois par défaut", () => {
    const filters = normalizeHistoryFilters({}, new Date("2026-09-18T12:00:00.000Z"));
    assert.equal(filters.ok, true);
    assert.equal(filters.dateFrom.slice(0, 10), "2025-09-18");
    assert.equal(filters.dateTo.slice(0, 10), "2026-09-18");
    assert.equal(filters.category, "all");
    assert.equal(filters.order, "desc");
    assert.equal(filters.limit, 50);
});

test("les filtres refusent une catégorie ou une période invalide", () => {
    assert.equal(normalizeHistoryFilters({ category: "secrets" }).ok, false);
    assert.equal(normalizeHistoryFilters({ dateFrom: "2026-10-01", dateTo: "2026-09-01" }).ok, false);
    assert.equal(normalizeHistoryFilters({ dateFrom: "18/09/2025" }).ok, false);
});

test("chaque journal d’entreprise reste filtré par le propriétaire actif", async () => {
    const calls = [];
    const database = { async query(sql, values) { calls.push({ sql, values }); return { rows: [{ id: 7, source: "member", category: "members", action: "member_created", actorName: "Admin", target: "Technicien", details: {}, createdAt: "2026-09-01T08:00:00.000Z" }] }; } };
    const result = await getUnifiedHistory("42", validFilters(), database);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /audit\.owner_id=\$1/);
    assert.equal(calls[0].values[0], "42");
    assert.equal(result.entries[0].id, "member:7");
    assert.equal(result.page.hasMore, false);
});

test("le journal Groupe emploie exclusivement l’identifiant du Groupe autorisé", async () => {
    const calls = [];
    const database = { async query(sql, values) { calls.push({ sql, values }); return { rows: [] }; } };
    await getUnifiedHistory("42", validFilters({ category: "group" }), database, "9");
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /audit\.group_id=\$1/);
    assert.equal(calls[0].values[0], "9");
    calls.length = 0;
    await getUnifiedHistory("42", validFilters({ category: "group" }), database, "");
    assert.equal(calls.length, 0);
});

test("l’écran unifié reste réservé à l’administrateur local", () => {
    assert.match(server, /if \(!isCompanyAdministrator\(request\)\) return response\.status\(403\)/);
    assert.match(app, /registerHistoryRoutes\(app, requireAuthentication\)/);
    assert.match(navigation, /isLocalCompanyAdministrator\(\) \? \[\["history"/);
    assert.match(navigation, /if \(section === "history"\) return renderHistoryAndJournals\(container\)/);
});

test("l’interface classe, recherche, pagine et supprime uniquement les journaux opérationnels", () => {
    assert.match(client, /12 derniers mois/);
    assert.match(client, /Plus récents d’abord/);
    assert.match(client, /Plus anciens d’abord/);
    assert.match(client, /data-history-previous/);
    assert.match(client, /data-history-next/);
    assert.match(server, /app\.post\("\/api\/history\/delete"/);
    assert.match(server, /DELETABLE_HISTORY_CATEGORIES = Object\.freeze\(\["imports", "clients", "operations", "partners"\]\)/);
    assert.match(client, /Supprimer la sélection/);
    assert.match(client, /traces légales ou de sécurité protégées/);
    assert.match(serviceWorker, /js\/history\.js\?v=2/);
});
