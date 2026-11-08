importScripts("./js/offline-replay.js?v=1");

const CACHE_NAME = "depann-home-pro-v652";
const offlineReplay = globalThis.DepannHomeOfflineReplay;
const ASSETS = [
    "./",
    "./connexion",
    "./index.html",
    "./css/style.css?v=317",
    "./vendor/maplibre/maplibre-gl.css?v=6.11.2",
    "./css/partner-dialogue.css?v=7",
    "./css/report-editor.css?v=8",
    "./css/health-dashboard.css?v=2",
    "./js/app.js?v=522",
    "./js/app.js?v=523",
    "./js/app.js?v=524",
    "./js/app.js?v=525",
    "./js/app.js?v=526",
    "./js/client-session.js?v=7",
    "./js/client-session.js?v=11",
    "./js/client-session.js?v=12",
    "./js/desktop-workspace.js?v=5",
    "./js/desktop-workspace.js?v=6",
    "./js/offline-sync.js?v=3",
    "./js/offline-sync.js?v=4",
    "./js/offline-replay.js?v=1",
    "./js/offline-tools.js?v=1",
    "./js/accounting.js?v=35",
    "./js/accounting.js?v=36",
    "./js/accounting.js?v=37",
    "./js/accounting.js?v=38",
    "./js/accounting.js?v=39",
    "./js/config.js?v=88",
    "./js/config.js?v=105",
    "./js/config.js?v=111",
    "./js/config.js?v=116",
    "./js/config.js?v=117",
    "./js/config.js?v=118",
    "./js/config.js?v=120",
    "./js/config.js?v=123",
    "./js/config.js?v=128",
    "./js/config.js?v=133",
    "./js/config.js?v=134",
    "./js/config.js?v=135",
    "./js/groups.js?v=10",
    "./js/history.js?v=2",
    "./js/health-dashboard.js?v=1",
    "./js/connectors.js?v=11",
    "./js/connectors.js?v=12",
    "./js/partner-missions.js?v=102",
    "./js/partner-missions.js?v=103",
    "./js/partner-missions.js?v=104",
    "./js/partner-missions.js?v=105",
    "./js/partner-sandbox.js?v=4",
    "./js/partner-dialogue.js?v=19",
    "./js/partner-connections.js?v=61",
    "./js/partner-connections.js?v=62",
    "./js/partner-connections.js?v=63",
    "./js/partner-connections.js?v=64",
    "./js/partner-email-settings.js?v=30",
    "./js/partner-email-settings.js?v=29",
    "./js/technical-reports.js?v=31",
    "./js/technical-reports.js?v=32",
    "./js/technical-reports.js?v=33",
    "./js/auth.js?v=131",
    "./js/billing.js?v=224",
    "./js/billing.js?v=225",
    "./js/billing.js?v=226",
    "./js/billing.js?v=227",
    "./js/billing.js?v=228",
    "./js/document-delivery.js?v=2",
    "./js/document-template-editor.js?v=3",
    "./js/pdf-live-preview.js?v=2",
    "./vendor/pdfjs/build/pdf.min.mjs?v=5.4.54",
    "./vendor/pdfjs/build/pdf.worker.min.mjs?v=5.4.54",
    "./js/calendar.js?v=248",
    "./js/calendar.js?v=249",
    "./js/calendar.js?v=250",
    "./js/calendar.js?v=251",
    "./js/intervention-search.js?v=5",
    "./js/intervention-search.js?v=6",
    "./js/intervention-search.js?v=7",
    "./js/intervention-search.js?v=8",
    "./js/clients.js?v=183",
    "./js/clients.js?v=179",
    "./js/clients.js?v=184",
    "./js/clients.js?v=185",
    "./js/clients.js?v=186",
    "./js/clients.js?v=187",
    "./js/clients.js?v=188",
    "./js/client-sync.js?v=132",
    "./js/collaboration.js?v=14",
    "./js/collaboration.js?v=8",
    "./js/i18n.js?v=6",
    "./js/leak-report-wizard.js?v=70",
    "./js/leak-report-wizard.js?v=71",
    "./js/leak-report-wizard.js?v=72",
    "./js/leak-report-wizard.js?v=73",
    "./js/config.js?v=139",
    "./js/data.js",
    "./js/data.js?v=59",
    "./js/data-imports.js?v=6",
    "./js/data-imports.js?v=5",
    "./js/navigation.js?v=543",
    "./js/navigation.js?v=544",
    "./js/navigation.js?v=545",
    "./js/navigation.js?v=546",
    "./js/navigation.js?v=547",
    "./js/navigation.js?v=548",
    "./js/business-suite.js?v=5",
    "./js/business-suite.js?v=6",
    "./js/business-suite.js?v=7",
    "./js/business-suite.js?v=8",
    "./js/business-suite.js?v=9",
    "./js/reminder-dashboard.js?v=1",
    "./js/reminder-dashboard.js?v=2",
    "./js/operations-map.js?v=10",
    "./vendor/maplibre/maplibre-gl.mjs?v=6.11.2",
    "./vendor/maplibre/maplibre-gl-shared.mjs",
    "./vendor/maplibre/maplibre-gl-worker.mjs",
    "./js/creator.js?v=179",
    "./js/creator.js?v=180",
    "./js/creator-history.js?v=2",
    "./js/library.js?v=124",
    "./js/local-library.js",
    "./js/local-library.js?v=118",
    "./js/messages.js?v=107",
    "./js/platform-announcement.js",
    "./js/platform-announcement.js?v=1",
    "./js/professional-directory.js?v=1",
    "./js/purchases.js?v=133",
    "./js/purchases.js?v=134",
    "./js/purchases.js?v=135",
    "./js/purchases.js?v=136",
    "./js/pagination.js?v=1",
    "./js/search.js?v=80",
    "./js/search.js?v=81",
    "./js/search.js?v=82",
    "./js/search.js?v=83",
    "./js/state.js",
    "./js/state.js?v=44",
    "./js/storage.js?v=45",
    "./js/ui.js",
    "./js/ui.js?v=44",
    "./js/utils.js",
    "./js/utils.js?v=44",
    "./manifest.json",
    "./assets/logo.png.png",
    "./data/database.json",
    "./assets/notices/manifest.json"
];

self.addEventListener("install", event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(ASSETS))
            .then(() => self.skipWaiting())
            .catch(error => {
                console.error("Préchargement du cache impossible.", error);
                throw error;
            })
    );
});

self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys
                    .filter(key => key.startsWith("depann-home-pro-") && key !== CACHE_NAME)
                    .map(key => caches.delete(key))
                ))
                .then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", event => {
    if (event.request.method !== "GET") return;

    const url = new URL(event.request.url);
    const isOfflineStaticData = ["/data/database.json", "/assets/notices/manifest.json", "/assets/logo.png.png"].includes(url.pathname);
    const isPublicAsset = url.origin === self.location.origin
        && !url.pathname.startsWith("/api/")
        && ((!url.pathname.startsWith("/data/") && !url.pathname.startsWith("/assets/")) || isOfflineStaticData);

    if (!isPublicAsset) return;

    const fetchAndCache = () => fetch(event.request)
            .then(response => {
                const copy = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
                return response;
            });
    const cachedFallback = () => caches.match(event.request, { ignoreSearch: isOfflineStaticData }).then(cached => cached || fetchAndCache());
    event.respondWith(url.searchParams.has("v") ? cachedFallback() : fetchAndCache().catch(cachedFallback));
});

self.addEventListener("sync", event => {
    if (event.tag !== "depannhome-offline-sync") return;
    event.waitUntil(flushOfflineOperations());
});

async function flushOfflineOperations() {
    const database = await openOfflineDatabase();
    try {
        const scope = (await offlineRequest(database, "metadata", "readonly", store => store.get("activeScope")))?.value;
        if (!scope) return;
        const operations = (await offlineRequest(database, "operations", "readonly", store => store.getAll()))
            .filter(operation => operation.scope === scope)
            .sort((left, right) => left.createdAt - right.createdAt);
        for (const operation of operations) {
            if (operation.blocked) return;
            const mappings = (await offlineRequest(database, "mappings", "readonly", store => store.getAll())).filter(mapping => mapping.scope === scope);
            const url = offlineReplay.remapUrl(operation.url, mappings);
            const headers = new Headers(operation.headers || []);
            headers.set("X-DepannHome-Offline-Operation", operation.id);
            headers.set("X-DepannHome-Offline-Scope", operation.scope);
            if (operation.retryAfterConflict) headers.set("X-DepannHome-Offline-Retry", "true");
            const body = restoreOfflineBody(offlineReplay.remapBody(operation.body, mappings));
            if (operation.body?.type === "form-data") headers.delete("Content-Type");
            let response;
            try { response = await fetch(url, { method: operation.method, credentials: "same-origin", headers, ...(body === undefined ? {} : { body }) }); }
            catch {
                await updateOfflineAttempt(database, operation, "Réseau indisponible", false);
                throw new Error("Réseau indisponible pendant la synchronisation hors ligne.");
            }
            if (response.status >= 500 || [408, 425, 429].includes(response.status)) {
                await updateOfflineAttempt(database, operation, `Erreur ${response.status}`, false);
                throw new Error(`Synchronisation temporairement indisponible (${response.status}).`);
            }
            if (!response.ok) {
                const details = await response.clone().json().catch(() => null);
                await updateOfflineAttempt(database, operation, details?.message || `Erreur ${response.status}`, response.status !== 401);
                return;
            }
            if (offlineReplay.hasExpectedMappings(operation)) {
                const data = await response.clone().json().catch(() => null);
                let resolved;
                try { resolved = offlineReplay.responseMappings(operation, data); }
                catch (error) { await updateOfflineAttempt(database, operation, error.message, true); return; }
                for (const [localId, remoteId] of resolved) {
                    await offlineRequest(database, "mappings", "readwrite", store => store.put({ key: `${scope}:${localId}`, scope, localId, remoteId }));
                }
            }
            await offlineRequest(database, "operations", "readwrite", store => store.delete(operation.id));
        }
    } finally {
        database.close();
        const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        clients.forEach(client => client.postMessage({ type: "depannhome:flush-offline-queue" }));
    }
}

async function updateOfflineAttempt(database, operation, message, blocked) {
    await offlineReplay.recordAttempt(database, operation.id, message, blocked);
}

function restoreOfflineBody(body) {
    if (!body || body.type === "none") return undefined;
    if (body.type === "text" || body.type === "blob") return body.value;
    if (body.type !== "form-data") return undefined;
    const form = new FormData();
    body.entries.forEach(entry => entry.kind === "blob" ? form.append(entry.name, entry.value, entry.filename) : form.append(entry.name, entry.value));
    return form;
}

function openOfflineDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open("depannhome-mobile-offline", 2);
        request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains("operations")) database.createObjectStore("operations", { keyPath: "id" });
            if (!database.objectStoreNames.contains("responses")) database.createObjectStore("responses", { keyPath: "key" });
            if (!database.objectStoreNames.contains("mappings")) database.createObjectStore("mappings", { keyPath: "key" });
            if (!database.objectStoreNames.contains("metadata")) database.createObjectStore("metadata", { keyPath: "key" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function offlineRequest(database, storeName, mode, operation) {
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, mode);
        const request = operation(transaction.objectStore(storeName));
        let result;
        request.onsuccess = () => { result = request.result; };
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = transaction.onerror = () => reject(transaction.error || request.error || new Error("Transaction hors ligne impossible."));
    });
}
