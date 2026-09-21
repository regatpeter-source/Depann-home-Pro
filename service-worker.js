const CACHE_NAME = "depann-home-pro-v596";
const ASSETS = [
    "./",
    "./connexion",
    "./index.html",
    "./css/style.css?v=290",
    "./css/partner-dialogue.css?v=7",
    "./css/report-editor.css?v=8",
    "./css/health-dashboard.css?v=2",
    "./js/app.js?v=475",
    "./js/client-session.js?v=8",
    "./js/offline-sync.js?v=2",
    "./js/accounting.js?v=30",
    "./js/groups.js?v=9",
    "./js/history.js?v=2",
    "./js/health-dashboard.js?v=1",
    "./js/connectors.js?v=6",
    "./js/partner-missions.js?v=90",
    "./js/partner-sandbox.js",
    "./js/partner-dialogue.js?v=19",
    "./js/partner-connections.js?v=50",
    "./js/partner-email-settings.js?v=30",
    "./js/technical-reports.js?v=22",
    "./js/auth.js?v=130",
    "./js/billing.js?v=212",
    "./js/document-delivery.js?v=2",
    "./js/pdf-live-preview.js?v=2",
    "./vendor/pdfjs/build/pdf.min.mjs?v=5.4.54",
    "./vendor/pdfjs/build/pdf.worker.min.mjs?v=5.4.54",
    "./js/calendar.js?v=232",
    "./js/intervention-search.js?v=2",
    "./js/clients.js?v=172",
    "./js/client-sync.js?v=132",
    "./js/collaboration.js?v=14",
    "./js/i18n.js?v=6",
    "./js/leak-report-wizard.js?v=59",
    "./js/config.js?v=135",
    "./js/data.js",
    "./js/data-imports.js?v=6",
    "./js/navigation.js?v=498",
    "./js/creator.js?v=170",
    "./js/creator-history.js?v=1",
    "./js/library.js",
    "./js/local-library.js",
    "./js/messages.js?v=107",
    "./js/platform-announcement.js",
    "./js/purchases.js?v=128",
    "./js/pagination.js?v=1",
    "./js/search.js?v=77",
    "./js/state.js",
    "./js/storage.js?v=45",
    "./js/ui.js",
    "./js/utils.js",
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
            })
    );
});

self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys
                    .filter(key => key !== CACHE_NAME)
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
    const scope = (await offlineRequest(database, "metadata", "readonly", store => store.get("activeScope")))?.value;
    if (!scope) return;
    const operations = (await offlineRequest(database, "operations", "readonly", store => store.getAll()))
        .filter(operation => operation.scope === scope && !operation.blocked)
        .sort((left, right) => left.createdAt - right.createdAt);
    for (const operation of operations) {
        const mappings = (await offlineRequest(database, "mappings", "readonly", store => store.getAll())).filter(mapping => mapping.scope === scope);
        let url = operation.url;
        mappings.forEach(mapping => { url = url.replaceAll(encodeURIComponent(mapping.localId), encodeURIComponent(mapping.remoteId)).replaceAll(mapping.localId, mapping.remoteId); });
        const headers = new Headers(operation.headers || []);
        headers.set("X-DepannHome-Offline-Operation", operation.id);
        const body = restoreOfflineBody(operation.body);
        if (operation.body?.type === "form-data") headers.delete("Content-Type");
        let response;
        try { response = await fetch(url, { method: operation.method, credentials: "same-origin", headers, ...(body === undefined ? {} : { body }) }); }
        catch { throw new Error("Réseau indisponible pendant la synchronisation hors ligne."); }
        if (response.status >= 500 || [408, 425, 429].includes(response.status)) throw new Error(`Synchronisation temporairement indisponible (${response.status}).`);
        if (!response.ok) return;
        if (operation.metadata?.localMediaIds?.length || operation.metadata?.localEventId || operation.metadata?.localReportId) {
            const data = await response.clone().json().catch(() => null);
            const media = Array.isArray(data?.media) ? data.media : [];
            for (let index = 0; index < operation.metadata.localMediaIds.length; index += 1) {
                if (!media[index]?.id) continue;
                const localId = operation.metadata.localMediaIds[index];
                await offlineRequest(database, "mappings", "readwrite", store => store.put({ key: `${scope}:${localId}`, scope, localId, remoteId: String(media[index].id) }));
            }
            if (operation.metadata?.localEventId && data?.id) {
                const localId = operation.metadata.localEventId;
                await offlineRequest(database, "mappings", "readwrite", store => store.put({ key: `${scope}:${localId}`, scope, localId, remoteId: String(data.id) }));
            }
            if (operation.metadata?.localReportId && data?.id) {
                const localId = operation.metadata.localReportId;
                await offlineRequest(database, "mappings", "readwrite", store => store.put({ key: `${scope}:${localId}`, scope, localId, remoteId: String(data.id) }));
            }
        }
        await offlineRequest(database, "operations", "readwrite", store => store.delete(operation.id));
    }
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    clients.forEach(client => client.postMessage({ type: "depannhome:flush-offline-queue" }));
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
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}
