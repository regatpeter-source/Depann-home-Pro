import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("le poste mobile conserve les mutations dans IndexedDB et les rejoue automatiquement", () => {
    const source = read("js/offline-sync.js");
    assert.match(source, /indexedDB\.open\(DATABASE_NAME, DATABASE_VERSION\)/);
    assert.match(source, /window\.addEventListener\("online", \(\) => scheduleFlush\(250\)\)/);
    assert.match(source, /sort\(\(a, b\) => a\.createdAt - b\.createdAt\)/);
    assert.match(source, /X-DepannHome-Offline-Operation/);
    assert.match(source, /body instanceof FormData/);
    assert.match(source, /operation\.metadata\.localMediaIds/);
    assert.match(source, /operation\.metadata\.localReportId/);
});

test("le transport global couvre planning, notes et rapports sans intercepter les opérations administratives finales", () => {
    const source = read("js/offline-sync.js");
    assert.match(source, /pathname\.startsWith\("\/api\/messages"\)/);
    assert.match(source, /pathname\.startsWith\("\/api\/calendar\/events"\)/);
    assert.match(source, /pathname\.startsWith\("\/api\/technical-reports\/"\)/);
    assert.match(source, /!pathname\.endsWith\("\/validate"\)/);
    assert.match(source, /!pathname\.endsWith\("\/proofread"\)/);
});

test("la page web restaure le dernier contexte mobile et précharge ses ressources hors ligne", () => {
    const auth = read("js/auth.js");
    const worker = read("service-worker.js");
    assert.match(auth, /OFFLINE_MOBILE_SESSION_KEY/);
    assert.match(auth, /session\.networkError && navigator\.onLine === false/);
    assert.match(worker, /\.\/js\/offline-sync\.js\?v=1/);
    assert.match(worker, /\.\/data\/database\.json/);
    assert.match(worker, /depannhome-offline-sync/);
    assert.match(worker, /flushOfflineOperations\(\)/);
    assert.match(worker, /indexedDB\.open\("depannhome-mobile-offline", 2\)/);
});

test("le serveur déduplique chaque rejeu et récupère seulement un verrou libre", () => {
    const middleware = read("server/offline-idempotency.js");
    const reports = read("server/technical-reports.js");
    const migration = read("database/migrations/0029_offline_operation_idempotency.sql");
    assert.match(middleware, /ON CONFLICT \(owner_id,user_id,operation_id\) DO NOTHING/);
    assert.match(middleware, /X-DepannHome-Offline-Replayed/);
    assert.match(reports, /request\.get\("X-DepannHome-Offline-Operation"\) && !result\.lock/);
    assert.match(migration, /PRIMARY KEY \(owner_id, user_id, operation_id\)/);
});
