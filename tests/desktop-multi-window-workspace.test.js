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
    assert.match(workspace, /const MAX_TABS = 30/);
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

test("tous les menus et sous-menus deviennent des onglets distincts et restaurables", () => {
    assert.match(navigation, /new CustomEvent\("depannhome:application-view"/);
    assert.match(navigation, /key: `view:\$\{entry\.route\}:\$\{identity\}`/);
    assert.match(navigation, /view: entry\.view/);
    assert.match(workspace, /window\.addEventListener\("depannhome:application-view"/);
    assert.match(workspace, /const view = value\.view/);
    assert.match(navigation, /restoreApplicationRoute\(\{ route: item\.route, view: item\.view \|\| \{\}, title: item\.title \}\)/);
});

test("les sous-menus Paramètres, catalogue et recherche d’intervention conservent leur destination", () => {
    assert.match(navigation, /return \{ settingsSection, templateType \}/);
    assert.match(navigation, /return \{ level, brandIndex, categoryIndex, productIndex \}/);
    assert.match(navigation, /workspace: "intervention-search"/);
    assert.match(navigation, /view\.workspace === "intervention-search"/);
});

test("les sous-écrans métier possèdent une identité et une restauration ciblées", () => {
    assert.match(navigation, /view\.calendarEventId/);
    assert.match(navigation, /view\.documentId/);
    assert.match(navigation, /view\.accountingSection/);
    assert.match(navigation, /view\.purchaseId/);
    assert.match(navigation, /view\.reportId/);
    assert.match(navigation, /view\.librarySectionId/);
});