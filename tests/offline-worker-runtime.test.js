import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const workerSource = readFileSync(new URL("../service-worker.js", import.meta.url), "utf8");
const scope = "company:mobile:technician";

function operation(id, url, metadata = {}, body = { type: "none" }) {
    return { id, scope, url, method: "POST", headers: [], body, metadata, createdAt: Number(id), blocked: false };
}

function createWorker(operations, fetchImplementation) {
    const stores = {
        metadata: new Map([["activeScope", { key: "activeScope", value: scope }]]),
        operations: new Map(operations.map(item => [item.id, structuredClone(item)])),
        mappings: new Map()
    };
    const notifications = [];
    const context = createContext({
        URL, Headers, Response, FormData, Blob, console,
        fetch: fetchImplementation,
        self: {
            location: new URL("https://example.test/"),
            addEventListener() {},
            clients: { matchAll: async () => [{ postMessage: message => notifications.push(message) }] }
        }
    });
    context.importScripts = path => {
        const source = readFileSync(new URL(`../${path.replace(/^\.\//, "").split("?")[0]}`, import.meta.url), "utf8");
        runInContext(source, context);
    };
    runInContext(workerSource, context);
    context.openOfflineDatabase = async () => ({ close() {} });
    context.offlineRequest = async (_database, storeName, _mode, action) => {
        const store = stores[storeName];
        return action({
            get: key => structuredClone(store.get(key)),
            getAll: () => [...store.values()].map(item => structuredClone(item)),
            put: value => { store.set(value.id || value.key, structuredClone(value)); },
            delete: key => { store.delete(key); }
        });
    };
    context.updateOfflineAttempt = async (_database, item, message, blocked) => {
        const current = stores.operations.get(item.id);
        if (current) stores.operations.set(item.id, { ...current, attempts: Number(current.attempts || 0) + 1, lastError: message, blocked });
    };
    return { flush: () => context.flushOfflineOperations(), stores, notifications };
}

test("le service worker rejoue dans l’ordre une intervention, son rapport et ses photos", async () => {
    const localEvent = "offline-event-8e82381c-5034-47a3-aa5b-5965a96f03c7";
    const localReport = "offline-report-9ceabf2e-1031-458a-981c-ea7d2067976c";
    const localMedia = "offline-media-e16fa8a8-a9af-43d9-a1ef-7f6d54d1b40d";
    const operations = [
        operation("1", "/api/calendar/events", { localEventId: localEvent }),
        operation("2", "/api/technical-reports", { localReportId: localReport }, { type: "text", value: JSON.stringify({ appointmentId: localEvent, notes: `Texte ${localEvent}` }) }),
        operation("3", `/api/technical-reports/${localReport}/media`, { localMediaIds: [localMedia] }),
        operation("4", `/api/technical-reports/${localReport}/media/${localMedia}`)
    ];
    const calls = [];
    const worker = createWorker(operations, async (url, options) => {
        calls.push({ url, options });
        if (url === "/api/calendar/events") return Response.json({ id: 41 });
        if (url === "/api/technical-reports") return Response.json({ id: 77 });
        if (url === "/api/technical-reports/77/media") return Response.json({ media: [{ id: "media-123" }] });
        return new Response(null, { status: 204 });
    });

    await worker.flush();

    assert.deepEqual(calls.map(call => call.url), [
        "/api/calendar/events",
        "/api/technical-reports",
        "/api/technical-reports/77/media",
        "/api/technical-reports/77/media/media-123"
    ]);
    assert.equal(JSON.parse(calls[1].options.body).appointmentId, "41");
    assert.equal(JSON.parse(calls[1].options.body).notes, `Texte ${localEvent}`);
    assert.equal(calls[0].options.headers.get("X-DepannHome-Offline-Operation"), "1");
    assert.equal(calls[0].options.headers.get("X-DepannHome-Offline-Scope"), scope);
    assert.equal(worker.stores.operations.size, 0);
    assert.equal(worker.stores.mappings.size, 3);
    assert.equal(worker.notifications.length, 1);
});

test("une opération bloquée arrête la file au lieu de rejouer les suivantes", async () => {
    const blocked = { ...operation("1", "/api/calendar/events/1"), blocked: true, lastError: "Conflit" };
    const later = operation("2", "/api/calendar/events/2");
    const calls = [];
    const worker = createWorker([blocked, later], async url => { calls.push(url); return new Response(null, { status: 204 }); });

    await worker.flush();

    assert.deepEqual(calls, []);
    assert.equal(worker.stores.operations.size, 2);
    assert.equal(worker.notifications.length, 1);
});

test("une réponse sans identifiant conserve la création et bloque les opérations dépendantes", async () => {
    const localEvent = "offline-event-8e82381c-5034-47a3-aa5b-5965a96f03c7";
    const operations = [
        operation("1", "/api/calendar/events", { localEventId: localEvent }),
        operation("2", "/api/technical-reports", {}, { type: "text", value: JSON.stringify({ appointmentId: localEvent }) })
    ];
    const calls = [];
    const worker = createWorker(operations, async url => { calls.push(url); return Response.json({}); });

    await worker.flush();

    assert.deepEqual(calls, ["/api/calendar/events"]);
    assert.equal(worker.stores.operations.size, 2);
    assert.equal(worker.stores.operations.get("1").blocked, true);
    assert.match(worker.stores.operations.get("1").lastError, /identifiant|réponse/i);
    assert.equal(worker.notifications.length, 1);
});

test("les créations sur plusieurs dates associent chaque identifiant temporaire à sa journée", async () => {
    const localIds = ["offline-event-premier", "offline-event-second"];
    const operations = [
        operation("1", "/api/calendar/events", { localEventId: localIds[0], localEventIds: localIds }),
        operation("2", `/api/calendar/events/${localIds[1]}`)
    ];
    const calls = [];
    const worker = createWorker(operations, async url => {
        calls.push(url);
        return url === "/api/calendar/events" ? Response.json({ id: 10, ids: [10, 11] }) : new Response(null, { status: 204 });
    });

    await worker.flush();

    assert.deepEqual(calls, ["/api/calendar/events", "/api/calendar/events/11"]);
    assert.equal(worker.stores.operations.size, 0);
    assert.equal(worker.stores.mappings.size, 2);
});

test("une liste partielle d’identifiants bloque toutes les journées au lieu de perdre une correspondance", async () => {
    const localIds = ["offline-event-premier", "offline-event-second"];
    const worker = createWorker([operation("1", "/api/calendar/events", { localEventId: localIds[0], localEventIds: localIds })], async () => Response.json({ id: 10, ids: [10] }));

    await worker.flush();

    assert.equal(worker.stores.operations.get("1").blocked, true);
    assert.equal(worker.stores.mappings.size, 0);
});

test("les identifiants de plusieurs journées restent obligatoires même sans identifiant principal", async () => {
    const localIds = ["offline-event-premier", "offline-event-second"];
    const worker = createWorker([operation("1", "/api/calendar/events", { localEventIds: localIds })], async () => Response.json({ id: 10, ids: [10] }));

    await worker.flush();

    assert.equal(worker.stores.operations.get("1").blocked, true);
    assert.equal(worker.stores.mappings.size, 0);
});

test("une erreur temporaire conserve les opérations et informe les pages ouvertes", async () => {
    const worker = createWorker([operation("1", "/api/calendar/events/1"), operation("2", "/api/calendar/events/2")], async () => new Response(null, { status: 425 }));

    await assert.rejects(worker.flush(), /temporairement indisponible/);

    assert.equal(worker.stores.operations.size, 2);
    assert.equal(worker.stores.operations.get("1").blocked, false);
    assert.equal(worker.stores.operations.get("1").lastError, "Erreur 425");
    assert.equal(worker.notifications.length, 1);
});
