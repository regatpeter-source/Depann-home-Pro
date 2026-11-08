import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const source = readFileSync(new URL("../service-worker.js", import.meta.url), "utf8");

function loadWorker(caches) {
    const handlers = new Map();
    let skipped = false;
    const context = createContext({
        URL, console: { error() {} }, caches,
        importScripts() {},
        self: {
            addEventListener(name, handler) { handlers.set(name, handler); },
            skipWaiting() { skipped = true; },
            clients: { async claim() {} }
        }
    });
    runInContext(source, context);
    return { handlers, skipped: () => skipped };
}

test("un préchargement incomplet fait échouer l’installation au lieu d’activer un cache partiel", async () => {
    const worker = loadWorker({ async open() { return { async addAll() { throw new Error("ressource indisponible"); } }; } });
    let installed;
    worker.handlers.get("install")({ waitUntil(promise) { installed = promise; } });
    await assert.rejects(installed, /ressource indisponible/);
    assert.equal(worker.skipped(), false);
});

test("l’activation ne supprime que les anciens caches de cette application", async () => {
    const deleted = [];
    const worker = loadWorker({
        async keys() { return ["depann-home-pro-v648", "depann-home-pro-v649", "depann-home-pro-v650", "depann-home-pro-v651", "depann-home-pro-v652", "depann-home-pro-v653", "depann-home-pro-v654", "autre-application"]; },
        async delete(key) { deleted.push(key); }
    });
    let activated;
    worker.handlers.get("activate")({ waitUntil(promise) { activated = promise; } });
    await activated;
    assert.deepEqual(deleted, ["depann-home-pro-v648", "depann-home-pro-v649", "depann-home-pro-v650", "depann-home-pro-v651", "depann-home-pro-v652", "depann-home-pro-v653"]);
});
