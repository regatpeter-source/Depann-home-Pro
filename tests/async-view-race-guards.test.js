import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function source(name) {
    return readFileSync(new URL(`../js/${name}`, import.meta.url), "utf8");
}

test("les chargements métier tardifs ne remplacent pas la vue courante", () => {
    const businessSuite = source("business-suite.js");
    const accounting = source("accounting.js");
    const billing = source("billing.js");
    const purchases = source("purchases.js");

    assert.match(businessSuite, /const loadingShell = container\.firstElementChild;[\s\S]+?!loadingShell\?\.isConnected \|\| container\.firstElementChild !== loadingShell/);
    assert.match(accounting, /const shell = container\.querySelector\("\.accounting-shell"\);[\s\S]+?!shell\?\.isConnected \|\| container\.firstElementChild !== shell/);
    assert.match(billing, /const result = await apiRequest\(billingFinancialApiUrl\(\)\);\s+if \(!overviewPanel\.isConnected\) return;/);
    assert.match(purchases, /const result = await apiRequest\("\/api\/purchases"\);\s+if \(!overviewPanel\.isConnected\) return;/);
});

test("les espaces administratifs et rapports ignorent leurs réponses obsolètes", () => {
    const groups = source("groups.js");
    const connectors = source("connectors.js");
    const sandbox = source("partner-sandbox.js");
    const reports = source("leak-report-wizard.js");

    for (const module of [groups, connectors, sandbox]) {
        assert.match(module, /!shell\?\.isConnected \|\| container\.firstElementChild !== shell/);
    }
    assert.match(reports, /!shell\?\.isConnected \|\| root\.firstElementChild !== shell/);
    assert.match(reports, /!shell\.isConnected \|\| root\.firstElementChild !== shell/);
});

test("la carte et les temporisations ne peuvent pas rouvrir une ancienne vue", () => {
    const map = source("operations-map.js");
    const navigation = source("navigation.js");

    assert.match(map, /const operationsMapRequests = new WeakMap\(\)/);
    assert.equal((map.match(/operationsMapRequests\.get\(panel\) !== requestVersion/g) || []).length, 2);
    assert.match(navigation, /window\.setTimeout\(\(\) => \{\s+if \(document\.querySelector\("\.nav-button\.active"\)\?\.dataset\.nav === ROUTES\.companyEmail\) renderCompanyEmail\(\);/);
});

test("les mutations ne rouvrent leur module que si leur panneau existe encore", () => {
    const accounting = source("accounting.js");
    const billing = source("billing.js");
    const purchases = source("purchases.js");
    const groups = source("groups.js");
    const connectors = source("connectors.js");

    assert.match(accounting, /if \(button\.isConnected\) renderAccounting\("electronic"\)/);
    assert.match(billing, /if \(form\.isConnected\) await renderBilling\(\{ documentId: document\.id \}\)/);
    assert.equal((purchases.match(/if \(panel\.isConnected\) renderPurchases\(presentation\)/g) || []).length, 2);
    assert.match(groups, /if \(button\.isConnected\) renderGroupWorkspace\(\)/);
    assert.match(connectors, /if \(document\.querySelector\("\.connectors-shell"\)\) renderConnectors/);
});
