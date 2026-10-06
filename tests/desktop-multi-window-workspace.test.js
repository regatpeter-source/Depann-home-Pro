import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workspace = readFileSync(new URL("../js/desktop-workspace.js", import.meta.url), "utf8");
const clients = readFileSync(new URL("../js/clients.js", import.meta.url), "utf8");
const missions = readFileSync(new URL("../js/partner-missions.js", import.meta.url), "utf8");
const navigation = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("le poste PC expose une barre persistante de fenêtres ouvertes", () => {
    assert.match(index, /id="desktopWorkspace"/);
    assert.match(workspace, /localStorage\.setItem\(storageKey\(\), JSON\.stringify\(tabs\)\)/);
    assert.match(workspace, /const MAX_TABS = 12/);
    assert.match(navigation, /initializeDesktopWorkspace\(\{ open: openDesktopWorkspaceItem \}\)/);
});

test("les clients et missions possèdent chacun leur onglet réouvrable", () => {
    assert.match(clients, /type: "client", id: String\(client\.id\)/);
    assert.match(missions, /type: "mission", id: String\(mission\.id\)/);
    assert.match(navigation, /item\.type === "client"/);
    assert.match(navigation, /item\.type === "mission"/);
});

test("un onglet peut être détaché en conservant la preuve de la session source", () => {
    assert.match(workspace, /url\.searchParams\.set\("clientSession", getClientSessionId\(\)\)/);
    assert.match(workspace, /window\.open\(url\.href/);
    assert.match(workspace, /popup=yes,width=1180,height=820/);
});

test("les saisies courantes sont conservées en mémoire entre les onglets", () => {
    assert.match(workspace, /const drafts = new Map\(\)/);
    assert.match(workspace, /captureDraft\(activeKey\)/);
    assert.match(workspace, /restoreDraftSoon\(item\.key\)/);
    assert.match(workspace, /abandonner les modifications non enregistrées/);
});