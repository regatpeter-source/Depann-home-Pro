import test from "node:test";
import assert from "node:assert/strict";
import { offlinePlanningRanges, prepareOfflineDay } from "../js/offline-tools.js";

const ready = async () => ({ pending: 0, blocked: null });
const synchronized = async () => ({ ok: true });

test("les périodes préparées correspondent aux vues jour, semaine et mois du planning", () => {
    assert.deepEqual(offlinePlanningRanges(new Date(2026, 2, 1, 23)), [
        { start: "2026-03-01", end: "2026-03-01" },
        { start: "2026-02-23", end: "2026-03-01" },
        { start: "2026-02-23", end: "2026-04-05" }
    ]);
    assert.deepEqual(offlinePlanningRanges(new Date(2024, 1, 29, 1)), [
        { start: "2024-02-29", end: "2024-02-29" },
        { start: "2024-02-26", end: "2024-03-03" },
        { start: "2024-01-29", end: "2024-03-03" }
    ]);
});

test("la préparation actualise le planning, les clients et les rapports du jour", async () => {
    const calls = [];
    const fetcher = async url => {
        calls.push(url);
        if (url.includes("start=2026-03-01&end=2026-03-01")) {
            return Response.json({ events: [{ id: 8, eventType: "appointment" }, { id: 9, eventType: "task" }] });
        }
        if (url.startsWith("/api/calendar/events")) return Response.json({ events: [] });
        if (url === "/api/technical-reports") return Response.json({ reports: [] });
        if (url === "/api/technical-reports/appointments/8") return Response.json({ appointment: { id: 8 }, report: { id: 23 } });
        if (url === "/api/technical-reports/23") return Response.json({ report: { id: 23 } });
        throw new Error(`Requête inattendue : ${url}`);
    };
    let synchronizations = 0;
    const result = await prepareOfflineDay({
        now: new Date(2026, 2, 1),
        fetcher,
        queueStatus: ready,
        synchronize: async () => { synchronizations += 1; return { ok: true }; }
    });

    assert.deepEqual(result, { day: "2026-03-01", appointments: 1, reports: 1, reportsAvailable: true });
    assert.equal(synchronizations, 1);
    assert.equal(calls.filter(url => url.startsWith("/api/calendar/events")).length, 3);
    assert.ok(calls.includes("/api/technical-reports/appointments/8"));
    assert.ok(calls.includes("/api/technical-reports/23"));
});

test("l’absence de droit sur les rapports est signalée sans masquer le planning préparé", async () => {
    const result = await prepareOfflineDay({
        now: new Date(2026, 2, 1),
        queueStatus: ready,
        synchronize: synchronized,
        fetcher: async url => url === "/api/technical-reports"
            ? Response.json({ message: "Accès interdit." }, { status: 403 })
            : Response.json({ events: [{ id: 8, eventType: "appointment" }] })
    });
    assert.deepEqual(result, { day: "2026-03-01", appointments: 1, reports: 0, reportsAvailable: false });
});

test("une réponse mise en cache ne certifie pas une journée préparée à jour", async () => {
    await assert.rejects(prepareOfflineDay({
        now: new Date(2026, 2, 1),
        queueStatus: ready,
        synchronize: synchronized,
        fetcher: async () => Response.json({ events: [] }, { headers: { "X-DepannHome-Offline": "true" } })
    }), /données en cache/);
});

test("la préparation refuse les envois en attente au début ou apparus pendant le chargement", async () => {
    let requested = false;
    await assert.rejects(prepareOfflineDay({
        queueStatus: async () => ({ pending: 1 }),
        synchronize: async () => { requested = true; return { ok: true }; }
    }), /Synchronisez d’abord/);
    assert.equal(requested, false);

    let checks = 0;
    await assert.rejects(prepareOfflineDay({
        now: new Date(2026, 2, 1),
        queueStatus: async () => ({ pending: checks++ ? 1 : 0 }),
        synchronize: synchronized,
        fetcher: async url => url === "/api/technical-reports" ? Response.json({ reports: [] }) : Response.json({ events: [] })
    }), /pendant la préparation/);
});

test("un échec des dossiers clients ou une réponse de planning invalide interrompt la préparation", async () => {
    await assert.rejects(prepareOfflineDay({
        queueStatus: ready,
        synchronize: async () => ({ ok: false, message: "Dossier à synchroniser." })
    }), /Dossier à synchroniser/);
    await assert.rejects(prepareOfflineDay({
        queueStatus: ready,
        synchronize: synchronized,
        fetcher: async () => Response.json({ invalid: true })
    }), /planning est incomplète/);
});
