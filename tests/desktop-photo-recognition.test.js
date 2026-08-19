import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const navigation = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
const clients = readFileSync(new URL("../js/clients.js", import.meta.url), "utf8");
const recognition = readFileSync(new URL("../js/photo-recognition.js", import.meta.url), "utf8");

test("visual detection is unavailable on desktop navigation", () => {
    assert.match(navigation, /route === ROUTES\.photo && isDesktopDevice\(\)/);
    assert.match(navigation, /menu === "photo" && isDesktopDevice\(\)/);
});

test("client forms hide visual detection on PC but keep normal camera attachments", () => {
    assert.match(clients, /document\.body\.classList\.contains\("desktop-device"\) \? ""/);
    assert.match(clients, /input name="cameraPhoto" type="file" accept="image\/\*" capture="environment"/);
    assert.match(clients, /cameraInput && recognitionStatus && recognitionResult/);
});

test("direct visual recognition rendering is guarded on desktop", () => {
    assert.match(recognition, /document\.body\.classList\.contains\("desktop-device"\)/);
    assert.match(recognition, /document\.body\.dataset\.deviceType === "desktop"/);
});
