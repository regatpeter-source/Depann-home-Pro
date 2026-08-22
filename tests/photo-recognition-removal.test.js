import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const config = readFileSync(new URL("../js/config.js", import.meta.url), "utf8");
const navigation = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
const clients = readFileSync(new URL("../js/clients.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const serviceWorker = readFileSync(new URL("../service-worker.js", import.meta.url), "utf8");

test("la reconnaissance photo inaboutie est retirée de l’application", () => {
    assert.equal(existsSync(new URL("../js/photo-recognition.js", import.meta.url)), false);
    for (const source of [config, navigation, clients, html, serviceWorker]) {
        assert.doesNotMatch(source, /photo-recognition|photoRecognition|ROUTES\.photo|photoBtn|data-nav="photo"/);
    }
});

test("la prise de photo normale des dossiers clients reste disponible", () => {
    assert.match(clients, /input name="cameraPhoto" type="file" accept="image\/\*" capture="environment"/);
    assert.match(clients, /input name="attachments" type="file" multiple accept="image\/\*/);
});