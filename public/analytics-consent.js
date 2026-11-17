(() => {
    const GTM_ID = "GTM-PSP482R9";
    const STORAGE_KEY = "dhp-analytics-consent";
    const CONSENT_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 182;
    let gtmLoaded = false;

    function readConsent() {
        try {
            const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null");
            if (!stored || !["granted", "denied"].includes(stored.choice)) return null;
            if (Date.now() - Number(stored.at || 0) > CONSENT_MAX_AGE_MS) return null;
            return stored.choice;
        } catch {
            return null;
        }
    }

    function saveConsent(choice) {
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ choice, at: Date.now() }));
        } catch {
            // Le choix reste valable pour la page courante si le stockage est indisponible.
        }
    }

    function loadGoogleTagManager() {
        if (gtmLoaded) return;
        gtmLoaded = true;
        const script = document.createElement("script");
        script.async = true;
        script.src = `https://www.googletagmanager.com/gtm.js?id=${GTM_ID}`;
        document.head.appendChild(script);
        window.dataLayer = window.dataLayer || [];
        window.gtag = window.gtag || function gtag() { window.dataLayer.push(arguments); };
        window.gtag("js", new Date());
    }

    function clearGoogleAnalyticsCookies() {
        const domains = ["", window.location.hostname, `.${window.location.hostname.replace(/^www\./, "")}`];
        for (const cookie of document.cookie.split(";")) {
            const name = cookie.split("=")[0].trim();
            if (!/^(_ga|_gid|_gat)/.test(name)) continue;
            for (const domain of domains) document.cookie = `${name}=; Max-Age=0; path=/${domain ? `; domain=${domain}` : ""}`;
        }
    }

    function injectStyles() {
        if (document.getElementById("dhp-consent-style")) return;
        const style = document.createElement("style");
        style.id = "dhp-consent-style";
        style.textContent = `
.dhp-consent{position:fixed;z-index:2147483000;left:16px;right:16px;bottom:16px;max-width:560px;margin:0 auto;padding:18px 20px;border-radius:14px;background:#071f36;color:#fff;box-shadow:0 12px 40px rgba(0,0,0,.35);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.dhp-consent p{margin:0 0 12px}
.dhp-consent a{color:#9fd3ff}
.dhp-consent-actions{display:flex;flex-wrap:wrap;gap:10px;justify-content:flex-end}
.dhp-consent button{cursor:pointer;border-radius:8px;padding:9px 16px;font:inherit;font-weight:600;border:1px solid #fff;background:transparent;color:#fff}
.dhp-consent button[data-consent="granted"]{background:#fff;color:#071f36}
.dhp-consent button:focus-visible{outline:3px solid #9fd3ff;outline-offset:2px}`;
        document.head.appendChild(style);
    }

    function closeBanner() {
        document.getElementById("dhp-consent")?.remove();
    }

    function applyChoice(choice) {
        saveConsent(choice);
        closeBanner();
        if (choice === "granted") loadGoogleTagManager();
        else {
            clearGoogleAnalyticsCookies();
            if (gtmLoaded) window.location.reload();
        }
    }

    function showBanner() {
        if (!document.body || document.getElementById("dhp-consent")) return;
        injectStyles();
        const banner = document.createElement("section");
        banner.id = "dhp-consent";
        banner.className = "dhp-consent";
        banner.setAttribute("role", "dialog");
        banner.setAttribute("aria-live", "polite");
        banner.setAttribute("aria-label", "Préférences de cookies");
        banner.innerHTML = `<p>Avec votre accord, nous utilisons des cookies de mesure d’audience Google Analytics (via Google Tag Manager) pour comprendre l’utilisation du site et l’améliorer. Vous pouvez accepter ou refuser ; votre choix est modifiable à tout moment. <a href="/privacy#cookies">En savoir plus</a></p>
<div class="dhp-consent-actions"><button type="button" data-consent="denied">Refuser</button><button type="button" data-consent="granted">Accepter</button></div>`;
        banner.addEventListener("click", event => {
            const choice = event.target.closest?.("[data-consent]")?.dataset.consent;
            if (choice) applyChoice(choice);
        });
        document.body.appendChild(banner);
    }

    function bindSettingsLinks() {
        document.addEventListener("click", event => {
            const trigger = event.target.closest?.("[data-cookie-settings]");
            if (!trigger) return;
            event.preventDefault();
            showBanner();
        });
    }

    const consent = readConsent();
    if (consent === "granted") loadGoogleTagManager();
    bindSettingsLinks();
    if (consent === null) {
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", showBanner, { once: true });
        else showBanner();
    }
})();
