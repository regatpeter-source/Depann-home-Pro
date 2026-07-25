const CACHE_NAME = "depann-home-pro-v145";
const ASSETS = [
    "./",
    "./index.html",
    "./css/style.css",
    "./js/app.js",
    "./js/auth.js",
    "./js/billing.js",
    "./js/calendar.js",
    "./js/clients.js",
    "./js/client-sync.js",
    "./js/config.js",
    "./js/data.js",
    "./js/navigation.js",
    "./js/library.js",
    "./js/local-library.js",
    "./js/messages.js",
    "./js/photo-recognition.js",
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
        caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
    );

    self.skipWaiting();
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
