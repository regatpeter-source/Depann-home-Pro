import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const navigation = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
const businessSuite = readFileSync(new URL("../js/business-suite.js", import.meta.url), "utf8");
const application = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("un rechargement restaure l’entrée history accessible avant la route par défaut", () => {
    assert.match(navigation, /const initialApplicationHistoryEntry = initializeApplicationHistory\(\)/);
    assert.match(navigation, /if \(restoreInitialApplicationHistory\(initialApplicationHistoryEntry\)\) return;/);
    assert.match(navigation, /entry\?\.application !== APPLICATION_HISTORY_MARKER/);
    assert.match(navigation, /!canOpenWorkspaceRoute\(route\)/);
});

test("les sous-vues métier alimentent l’historique restaurable", () => {
    assert.match(navigation, /depannhome:workspace-item/);
    assert.match(navigation, /view\.missionId \? \{ missionId: view\.missionId \}/);
    assert.match(navigation, /accountingSection: document\.querySelector/);
    assert.match(navigation, /selectedClientId: document\.querySelector\("\[data-assets-client\]"\)/);
    assert.match(navigation, /item\.type === "client"[\s\S]+?document\.getElementById\("pageTitle"\)/);
});

test("le portail et ses sélections ne sont pas remplacés par une synchronisation silencieuse", () => {
    assert.equal((navigation.match(/if \(document\.querySelector\('\[data-suite-view="portal"\]'\)\) return;/g) || []).length, 2);
    assert.match(businessSuite, /client\.value = selectedClientId/);
    assert.match(businessSuite, /new CustomEvent\("depannhome:application-view-changed"\)/);
    assert.match(businessSuite, /cache:method==="GET"\?"no-store":undefined/);
    assert.match(businessSuite, /data-suite-selected-client/);
    assert.match(businessSuite, /data-suite-selected-event/);
    assert.match(navigation, /portal\.dataset\.suiteSelectedClient/);
    assert.match(navigation, /refreshSharedData\(\{ silent: true, refreshVisibleMessages: false \}\)\.catch/);
    assert.match(navigation, /options\.refreshVisibleMessages \? refreshVisibleClientMessages\(\) : refreshClientMessageAlert\(\)/);
    assert.match(navigation, /restoreApplicationRoute\(recordedEntry\)/);
});

test("toutes les réponses API privées interdisent une copie de cache", () => {
    assert.match(application, /app\.use\("\/api",[\s\S]+?"Cache-Control": "private, no-store"/);
    assert.ok(application.indexOf('"Cache-Control": "private, no-store"') < application.indexOf('app.use("/api", rateLimit('));
});
