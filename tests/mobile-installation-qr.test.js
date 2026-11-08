import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderMobileInstallationQr } from "../js/mobile-installation-qr.js";

function element(tag) {
    return {
        tag, children: [], classList: new Set(), handlers: new Map(),
        set innerHTML(value) {
            this.children = [];
            if (value.includes("auth-message")) {
                const feedback = element("p");
                feedback.classList.add("auth-message");
                this.children.push(feedback);
            }
        },
        querySelector() { return this.children.find(child => child.classList.has("auth-message")); },
        append(...children) { this.children.push(...children); },
        appendChild(child) { this.children.push(child); },
        addEventListener(type, handler) { this.handlers.set(type, handler); }
    };
}

function setup(t) {
    const previous = globalThis.document;
    globalThis.document = { createElement: element };
    t.after(() => {
        if (previous === undefined) delete globalThis.document;
        else globalThis.document = previous;
    });
    t.mock.method(console, "warn", () => {});
    return element("div");
}

const payload = { installationUrl: "https://application.example.test/installer-mobile", qrCodeDataUrl: "data:image/png;base64,fixture" };

test("le rendu du QR affiche l’image et le lien public sans connexion automatique", async t => {
    const container = setup(t);
    t.mock.method(globalThis, "fetch", async (url, options) => {
        assert.equal(url, "/api/auth/mobile-installation");
        assert.equal(options.credentials, "same-origin");
        assert.equal(options.cache, "no-store");
        return { ok: true, async json() { return payload; } };
    });
    await renderMobileInstallationQr(container);
    const image = container.children.find(child => child.tag === "img");
    const link = container.children.find(child => child.tag === "a");
    assert.equal(image.src, payload.qrCodeDataUrl);
    assert.equal(image.width, 260);
    assert.equal(image.height, 260);
    assert.equal(link.href, payload.installationUrl);
    assert.equal(link.rel, "noopener");
    assert.match(container.querySelector().textContent, /aucun compte n’est connecté ou autorisé/);
});

test("un QR indisponible affiche l’erreur et permet un nouveau chargement sans doublon", async t => {
    const container = setup(t);
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => ({
        ok: ++calls > 1,
        async json() { return calls === 1 ? { message: "Configuration publique absente." } : payload; }
    }));
    await renderMobileInstallationQr(container);
    assert.equal(container.querySelector().textContent, "Configuration publique absente.");
    assert.equal(container.querySelector().classList.has("error"), true);
    await container.children.find(child => child.tag === "button").handlers.get("click")();
    assert.equal(calls, 2);
    assert.equal(container.children.filter(child => child.tag === "img").length, 1);
    assert.equal(container.children.some(child => child.tag === "button"), false);
});

test("le rendu refuse les liens personnalisés ou dangereux et les images de type inattendu", async t => {
    const container = setup(t);
    const invalid = [
        { ...payload, installationUrl: `${payload.installationUrl}?token=fixture` },
        { ...payload, installationUrl: "https://user:fixture@application.example.test/installer-mobile" },
        { ...payload, installationUrl: "http://application.example.test/installer-mobile" },
        { ...payload, qrCodeDataUrl: "data:image/svg+xml,fixture" }
    ];
    let next;
    t.mock.method(globalThis, "fetch", async () => ({ ok: true, async json() { return next; } }));
    for (next of invalid) {
        await renderMobileInstallationQr(container);
        assert.match(container.querySelector().textContent, /invalide/);
        assert.equal(container.children.some(child => child.tag === "img"), false);
    }
});

test("le QR est proposé dans les paramètres PC et rendu après création d’un accès mobile", () => {
    const navigation = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
    assert.match(navigation, /appendMobileInstallationQrButton\(card\.querySelector\("\.settings-heading"\)\)/);
    assert.match(navigation, /appendMobileInstallationQrButton\(hub\.querySelector\("\.settings-hub-heading"\)\)/);
    assert.match(navigation, /payload\.mobileOnboarding && document\.body\.dataset\.deviceType === "desktop"/);
    assert.match(navigation, /await renderMobileInstallationQr\(mobileWelcome\.querySelector/);
    assert.match(navigation, /Installer sur mobile · QR code/);
});
