const CACHE_NAME = "depann-home-pro-v440";
const ASSETS = [
    "./",
    "./index.html",
    "./css/style.css?v=221",
    "./css/partner-dialogue.css?v=5",
    "./css/report-editor.css?v=7",
    "./css/health-dashboard.css?v=1",
    "./js/app.js?v=356",
    "./js/client-session.js?v=3",
    "./js/accounting.js?v=18",
    "./js/groups.js",
    "./js/health-dashboard.js?v=1",
    "./js/connectors.js",
    "./js/partner-missions.js?v=50",
    "./js/partner-sandbox.js",
    "./js/partner-dialogue.js",
    "./js/partner-connections.js?v=25",
    "./js/partner-email-settings.js?v=16",
    "./js/technical-reports.js",
    "./js/auth.js?v=123",
    "./js/billing.js?v=182",
    "./js/document-delivery.js?v=1",
    "./js/pdf-live-preview.js?v=1",
    "./vendor/pdfjs/build/pdf.min.mjs?v=5.4.54",
    "./vendor/pdfjs/build/pdf.worker.min.mjs?v=5.4.54",
    "./js/calendar.js?v=176",
    "./js/clients.js?v=149",
    "./js/client-sync.js?v=125",
    "./js/collaboration.js?v=5",
    "./js/leak-report-wizard.js",
    "./js/config.js?v=131",
    "./js/data.js",
    "./js/data-imports.js",
    "./js/navigation.js?v=385",
    "./js/library.js",
    "./js/local-library.js",
    "./js/messages.js?v=107",
    "./js/platform-announcement.js",
    "./js/purchases.js",
    "./js/search.js",
    "./js/state.js",
    "./js/storage.js",
    "./js/ui.js",
    "./js/utils.js",
    "./manifest.json",
    "./assets/logo.png.png"
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
    const isPublicAsset = url.origin === self.location.origin
        && !url.pathname.startsWith("/api/")
        && !url.pathname.startsWith("/data/")
        && !url.pathname.startsWith("/assets/");

    if (!isPublicAsset) return;

    event.respondWith(
        fetch(event.request)
            .then(response => {
                const copy = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
                return response;
            })
            .catch(() => caches.match(event.request))
    );
});
