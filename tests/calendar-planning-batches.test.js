import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const server = read("server/calendar.js");
const schema = read("database/schema.sql");
const migration = read("database/migrations/0008_calendar_planning_batches.sql");
const calendar = read("js/calendar.js");

test("une planification étendue reçoit un identifiant de création explicite", () => {
    assert.match(server, /const planningBatchId = dates\.length > 1 \? randomUUID\(\) : null/);
    assert.match(server, /planning_batch_id\)\s*VALUES[\s\S]*\$14::uuid/);
    assert.match(server, /response\.status\(201\)\.json\(\{ id: ids\[0\], ids, count: ids\.length, planningBatchId \}\)/);
    assert.doesNotMatch(server, /planningBatchId[\s\S]{0,200}(?:title|client_name).*GROUP BY/);
});

test("le schéma et la migration indexent le lot dans le périmètre de l’entreprise", () => {
    for (const source of [schema, migration]) {
        assert.match(source, /planning_batch_id UUID/);
        assert.match(source, /\(owner_id,\s*planning_batch_id\)/);
        assert.match(source, /WHERE planning_batch_id IS NOT NULL/);
    }
});

test("la lecture expose le nombre et les bornes réelles de toute la planification", () => {
    assert.match(server, /event\.planning_batch_id AS "planningBatchId"/);
    assert.match(server, /COUNT\(\*\)::integer[\s\S]*batch_event\.owner_id = event\.owner_id/);
    assert.match(server, /MIN\(batch_event\.event_date\)/);
    assert.match(server, /MAX\(batch_event\.event_date\)/);
});

test("la suppression du lot est atomique, isolée par entreprise et refuse tout élément protégé", () => {
    const route = server.slice(server.indexOf('app.delete("/api/calendar/events/batch/:batchId"'), server.indexOf('app.delete("/api/calendar/events/:eventId"'));
    assert.match(route, /requireCalendarWriteAccess/);
    assert.match(route, /canManageCalendarEventStatus\(request\.user\)/);
    assert.match(route, /await connection\.query\("BEGIN"\)/);
    assert.match(route, /WHERE owner_id = \$1 AND planning_batch_id = \$2::uuid\s*FOR UPDATE/);
    assert.match(route, /event\.status === "completed"/);
    assert.match(route, /event\.quitusSignedAt \|\| event\.quitusStatus === "validated"/);
    assert.match(route, /event\.deductibleStatus === "validated"/);
    assert.match(route, /DELETE FROM depannhome_calendar_events WHERE owner_id = \$1 AND planning_batch_id = \$2::uuid/);
    assert.match(route, /await connection\.query\("COMMIT"\)/);
    assert.match(route, /Aucune journée n’a été supprimée/);
});

test("l’éditeur distingue la journée courante de toute la planification", () => {
    assert.match(calendar, /Supprimer cette journée/);
    assert.match(calendar, /Supprimer toute cette planification/);
    assert.match(calendar, /function canDeleteWholePlanning\(event\)/);
    assert.match(calendar, /planningBatchCount/);
    assert.match(calendar, /planningBatchStartDate/);
    assert.match(calendar, /\/api\/calendar\/events\/batch\//);
});