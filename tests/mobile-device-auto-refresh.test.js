import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const navigationSource = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");

test("l’écran Équipe actualise automatiquement les nouvelles demandes mobiles", () => {
    assert.match(navigationSource, /const DEVICE_REFRESH_INTERVAL_MS = 3_000/);
    assert.match(navigationSource, /await load\(\{ silent: true \}\)/);
    assert.match(navigationSource, /window\.setTimeout\(refreshDevicesWhileVisible, DEVICE_REFRESH_INTERVAL_MS\)/);
});

test("la surveillance des appareils s’arrête en quittant l’écran Équipe", () => {
    assert.match(navigationSource, /if \(!card\.isConnected\) return/);
    assert.match(navigationSource, /if \(card\.isConnected\) window\.setTimeout/);
    assert.match(navigationSource, /document\.visibilityState === "visible"/);
});

test("l’actualisation silencieuse évite les chargements concurrents et le clignotement", () => {
    assert.match(navigationSource, /if \(loadingTeam \|\| !card\.isConnected\) return/);
    assert.match(navigationSource, /if \(!silent\) list\.textContent = "Chargement de l’équipe…"/);
    assert.match(navigationSource, /finally \{\s*loadingTeam = false/);
});