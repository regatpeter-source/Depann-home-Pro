import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const source = readFileSync(new URL("../service-worker.js", import.meta.url), "utf8");

function loadWorker(caches, fetchImplementation) {
    const handlers = new Map();
    const deferred = [];
    let skipped = false;
    const context = createContext({
        URL, console: { error() {}, info(...args) { deferred.push(args); } }, caches,
        fetch: fetchImplementation,
        importScripts() {},
        self: {
            location: new URL("https://example.test/"),
            addEventListener(name, handler) { handlers.set(name, handler); },
            skipWaiting() { skipped = true; },
            clients: { async claim() {} }
        }
    });
    runInContext(source, context);
    return { handlers, deferred, skipped: () => skipped };
}

test("les refus d’accès aux ressources protégées ne bloquent pas le cache public", async () => {
    const protectedAssets = new Map([["./data/database.json", 401], ["./assets/notices/manifest.json", 403]]);
    const requested = [];
    const stored = [];
    const worker = loadWorker({
        async open() {
            return {
                async addAll(assets) {
                    for (const asset of assets) {
                        if (protectedAssets.has(asset)) throw new TypeError("Cache.addAll: réponse non autorisée");
                        stored.push(asset);
                    }
                },
                async put(asset) { stored.push(asset); }
            };
        }
    }, async (asset, options) => {
        assert.equal(options.credentials, "same-origin");
        requested.push(asset);
        return new Response(null, { status: protectedAssets.get(asset) });
    });
    let installed;
    worker.handlers.get("install")({ waitUntil(promise) { installed = promise; } });
    await installed;

    assert.equal(worker.skipped(), true);
    assert.ok(stored.includes("./connexion"));
    assert.ok(stored.includes("./assets/logo.png.png"));
    assert.deepEqual(requested.sort(), [...protectedAssets.keys()].sort());
    assert.equal(stored.some(asset => protectedAssets.has(asset)), false);
    assert.equal(worker.deferred.length, 2);
});

test("une session autorisée conserve le catalogue et les notices hors ligne dès l’installation", async () => {
    const cached = new Map();
    const worker = loadWorker({
        async open() {
            return {
                async addAll(assets) { assets.forEach(asset => cached.set(asset, { available: true })); },
                async put(asset, response) { cached.set(asset, await response.json()); }
            };
        }
    }, async () => Response.json({ available: true }));
    let installed;
    worker.handlers.get("install")({ waitUntil(promise) { installed = promise; } });
    await installed;

    assert.equal(worker.skipped(), true);
    assert.deepEqual(cached.get("./data/database.json"), { available: true });
    assert.deepEqual(cached.get("./assets/notices/manifest.json"), { available: true });
    assert.deepEqual(worker.deferred, []);
});

test("un préchargement incomplet fait échouer l’installation au lieu d’activer un cache partiel", async () => {
    const worker = loadWorker({ async open() { return { async addAll() { throw new Error("ressource indisponible"); } }; } });
    let installed;
    worker.handlers.get("install")({ waitUntil(promise) { installed = promise; } });
    await assert.rejects(installed, /ressource indisponible/);
    assert.equal(worker.skipped(), false);
});

test("une erreur serveur sur le catalogue n’est pas masquée comme un refus d’accès", async () => {
    const worker = loadWorker({
        async open() {
            return {
                async addAll(assets) {
                    if (assets.includes("./data/database.json")) throw new Error("Cache.addAll: réponse 503");
                },
                async put() {}
            };
        }
    }, async () => new Response(null, { status: 503 }));
    let installed;
    worker.handlers.get("install")({ waitUntil(promise) { installed = promise; } });

    await assert.rejects(installed, /503/);
    assert.equal(worker.skipped(), false);
    assert.deepEqual(worker.deferred, []);
});

test("une réponse 401 ne pollue pas le cache et le catalogue reste récupérable après connexion", async () => {
    const cached = new Map();
    let status = 401;
    let fetched = 0;
    const worker = loadWorker({
        async open() {
            return { async put(request, response) { cached.set(new URL(request.url).pathname, response); } };
        },
        async match(request) { return cached.get(new URL(request.url).pathname)?.clone(); }
    }, async () => {
        fetched += 1;
        return Response.json(status === 200 ? { brands: [] } : { message: "Connexion requise." }, { status });
    });
    async function request(version) {
        let result;
        const pending = [];
        worker.handlers.get("fetch")({
            request: new Request(`https://example.test/data/database.json?v=${version}`),
            respondWith(promise) { result = promise; },
            waitUntil(promise) { pending.push(promise); }
        });
        const response = await result;
        await Promise.all(pending);
        return response;
    }

    assert.equal((await request(1)).status, 401);
    assert.equal(cached.size, 0);
    status = 200;
    assert.deepEqual(await (await request(1)).json(), { brands: [] });
    assert.equal(cached.size, 1);
    assert.deepEqual(await (await request(2)).json(), { brands: [] });
    assert.equal(fetched, 2);
});

test("l’activation ne supprime que les anciens caches de cette application", async () => {
    const deleted = [];
    const worker = loadWorker({
        async keys() { return ["depann-home-pro-v648", "depann-home-pro-v649", "depann-home-pro-v650", "depann-home-pro-v651", "depann-home-pro-v652", "depann-home-pro-v653", "depann-home-pro-v654", "depann-home-pro-v655", "depann-home-pro-v656", "depann-home-pro-v657", "depann-home-pro-v658", "depann-home-pro-v659", "depann-home-pro-v660", "depann-home-pro-v661", "depann-home-pro-v662", "autre-application"]; },
        async delete(key) { deleted.push(key); }
    });
    let activated;
    worker.handlers.get("activate")({ waitUntil(promise) { activated = promise; } });
    await activated;
    assert.deepEqual(deleted, ["depann-home-pro-v648", "depann-home-pro-v649", "depann-home-pro-v650", "depann-home-pro-v651", "depann-home-pro-v652", "depann-home-pro-v653", "depann-home-pro-v654", "depann-home-pro-v655", "depann-home-pro-v656", "depann-home-pro-v657", "depann-home-pro-v658", "depann-home-pro-v659", "depann-home-pro-v660", "depann-home-pro-v661"]);
});
