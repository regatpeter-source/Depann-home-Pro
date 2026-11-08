import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../public/mobile-installation.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/mobile-installation.html", import.meta.url), "utf8");

function loadGuide({ standalone = false, serviceWorker } = {}) {
    const handlers = new Map();
    const button = { disabled: false, addEventListener(type, handler) { handlers.set(type, handler); } };
    const control = { hidden: true };
    const status = { textContent: "" };
    const warnings = [];
    vm.runInNewContext(source, {
        document: { querySelector(selector) { return selector === "[data-install-mobile]" ? button : selector === "[data-install-control]" ? control : status; } },
        window: { isSecureContext: Boolean(serviceWorker), matchMedia() { return { matches: standalone }; }, addEventListener(type, handler) { handlers.set(type, handler); } },
        navigator: serviceWorker ? { serviceWorker } : {},
        console: { warn(...values) { warnings.push(values); } }
    });
    return { handlers, button, control, status, warnings };
}

test("le guide est public, sans identifiants dans l’URL, avec étapes Android et iPhone", () => {
    assert.match(html, /Chrome/);
    assert.match(html, /Safari/);
    assert.match(html, /data-install-control hidden/);
    assert.match(html, /href="\/manifest\.json"/);
    assert.match(html, /class="mobile-installation"/);
    assert.match(html, /href="\/site-assets\/mobile-installation\.css\?v=1"/);
    const styles = readFileSync(new URL("../public/mobile-installation.css", import.meta.url), "utf8");
    assert.match(styles, /\.solution-hero > \.section-shell\s*\{\s*position: relative;\s*z-index: 1;/);
    assert.match(html, /href="\/connexion"/);
    assert.match(html, /mot de passe.*séparément/);
    assert.match(html, /ne garantit pas la géolocalisation/);
    assert.doesNotMatch(html, /navigator\.geolocation|\.apk["']|[?&](?:password|token|username)=/);
    const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
    assert.match(app, /app\.get\("\/installer-mobile"/);
    const navigation = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
    assert.match(navigation, /mobileWelcome\.hidden = !payload\.mobileOnboarding/);
    assert.match(navigation, /feedback\.classList\.toggle\("error", payload\.mobileOnboarding\?\.emailSent === false\)/);
    assert.match(navigation, /mobile-welcome`/);
    assert.match(navigation, /guide\.href = "\/installer-mobile"/);
});

test("l’installation est proposée mais ne démarre qu’après un clic de l’utilisateur", async () => {
    const guide = loadGuide();
    assert.equal(guide.control.hidden, true);
    let prompted = 0;
    let prevented = false;
    guide.handlers.get("beforeinstallprompt")({
        preventDefault() { prevented = true; },
        async prompt() { prompted += 1; },
        userChoice: Promise.resolve({ outcome: "accepted" })
    });
    assert.equal(prevented, true);
    assert.equal(guide.control.hidden, false);
    assert.equal(prompted, 0);
    await guide.handlers.get("click")();
    assert.equal(prompted, 1);
    assert.match(guide.status.textContent, /Installation demandée/);
    assert.equal(guide.control.hidden, true);
    guide.handlers.get("appinstalled")();
    assert.match(guide.status.textContent, /application est installée/);
});

test("l’annulation et l’erreur d’installation laissent les instructions disponibles", async () => {
    for (const failed of [false, true]) {
        const guide = loadGuide();
        guide.handlers.get("beforeinstallprompt")({
            preventDefault() {},
            async prompt() { if (failed) throw new Error("Fixture prompt failure"); },
            userChoice: Promise.resolve({ outcome: "dismissed" })
        });
        await guide.handlers.get("click")();
        assert.match(guide.status.textContent, failed ? /n’a pas pu être proposée/ : /Installation annulée/);
        assert.equal(guide.button.disabled, false);
        assert.equal(guide.warnings.length, failed ? 1 : 0);
    }
});

test("le mode installé est explicite et le guide public n’amorce pas un cache privé avant connexion", () => {
    const installed = loadGuide({ standalone: true });
    assert.equal(installed.control.hidden, true);
    assert.match(installed.status.textContent, /application est installée/);
    let registrations = 0;
    loadGuide({ serviceWorker: { async register() { registrations += 1; } } });
    assert.equal(registrations, 0, "Le cache contient des ressources qui nécessitent une session authentifiée.");
});
