const CACHE_NAME = "depann-home-pro-v382";
const ASSETS = [
    "./",
    "./index.html",
    "./css/style.css?v=203",
    "./css/partner-dialogue.css?v=5",
    "./css/report-editor.css?v=7",
    "./js/app.js?v=315",
    "./js/client-session.js?v=2",
    "./js/accounting.js?v=13",
    "./js/groups.js",
    "./js/connectors.js",
    "./js/partner-missions.js",
    "./js/partner-sandbox.js",
    "./js/partner-dialogue.js",
    "./js/partner-connections.js",
    "./js/technical-reports.js",
    "./js/auth.js",
    "./js/billing.js?v=179",
    "./js/document-delivery.js?v=1",
    "./js/pdf-live-preview.js?v=1",
    "./vendor/pdfjs/build/pdf.min.mjs?v=5.4.54",
    "./vendor/pdfjs/build/pdf.worker.min.mjs?v=5.4.54",
    "./js/calendar.js",
    "./js/clients.js?v=146",
    "./js/client-sync.js?v=125",
    "./js/collaboration.js?v=5",
    "./js/leak-report-wizard.js",
    "./js/config.js",
    "./js/data.js",
    "./js/data-imports.js",
    "./js/navigation.js?v=340",
    "./js/library.js",
    "./js/local-library.js",
    "./js/messages.js",
    "./js/photo-recognition.js",
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
        caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).catch(error => {
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
