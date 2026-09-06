const CACHE_NAME = "depann-home-pro-v522";
const ASSETS = [
    "./",
    "./connexion",
    "./index.html",
    "./css/style.css?v=258",
    "./css/partner-dialogue.css?v=7",
    "./css/report-editor.css?v=8",
    "./css/health-dashboard.css?v=2",
    "./js/app.js?v=416",
    "./js/client-session.js?v=5",
    "./js/accounting.js?v=25",
    "./js/groups.js?v=4",
    "./js/health-dashboard.js?v=1",
    "./js/connectors.js?v=3",
    "./js/partner-missions.js?v=81",
    "./js/partner-sandbox.js",
    "./js/partner-dialogue.js?v=19",
    "./js/partner-connections.js?v=44",
    "./js/partner-email-settings.js?v=28",
    "./js/technical-reports.js?v=17",
    "./js/auth.js?v=126",
    "./js/billing.js?v=204",
    "./js/document-delivery.js?v=1",
    "./js/pdf-live-preview.js?v=1",
    "./vendor/pdfjs/build/pdf.min.mjs?v=5.4.54",
    "./vendor/pdfjs/build/pdf.worker.min.mjs?v=5.4.54",
    "./js/calendar.js?v=207",
    "./js/intervention-search.js?v=1",
    "./js/clients.js?v=164",
    "./js/client-sync.js?v=127",
    "./js/collaboration.js?v=7",
    "./js/i18n.js?v=5",
    "./js/leak-report-wizard.js?v=50",
    "./js/config.js?v=135",
    "./js/data.js",
    "./js/data-imports.js?v=5",
    "./js/navigation.js?v=445",
    "./js/creator.js?v=156",
    "./js/library.js",
    "./js/local-library.js",
    "./js/messages.js?v=107",
    "./js/platform-announcement.js",
    "./js/purchases.js?v=126",
    "./js/pagination.js?v=1",
    "./js/search.js?v=75",
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
