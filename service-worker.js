const CACHE_NAME = "depann-home-pro-v590";
const ASSETS = [
    "./",
    "./connexion",
    "./index.html",
    "./css/style.css?v=289",
    "./css/partner-dialogue.css?v=7",
    "./css/report-editor.css?v=8",
    "./css/health-dashboard.css?v=2",
    "./js/app.js?v=469",
    "./js/client-session.js?v=6",
    "./js/accounting.js?v=29",
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
    "./js/billing.js?v=210",
    "./js/document-delivery.js?v=1",
    "./js/pdf-live-preview.js?v=2",
    "./vendor/pdfjs/build/pdf.min.mjs?v=5.4.54",
    "./vendor/pdfjs/build/pdf.worker.min.mjs?v=5.4.54",
    "./js/calendar.js?v=229",
    "./js/intervention-search.js?v=2",
    "./js/clients.js?v=170",
    "./js/client-sync.js?v=131",
    "./js/collaboration.js?v=13",
    "./js/i18n.js?v=6",
    "./js/leak-report-wizard.js?v=57",
    "./js/config.js?v=135",
    "./js/data.js",
    "./js/data-imports.js?v=6",
    "./js/navigation.js?v=494",
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

    const fetchAndCache = () => fetch(event.request)
            .then(response => {
                const copy = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
                return response;
            });
    const cachedFallback = () => caches.match(event.request).then(cached => cached || fetchAndCache());
    event.respondWith(url.searchParams.has("v") ? cachedFallback() : fetchAndCache().catch(cachedFallback));
});
