import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const navigation = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
const style = readFileSync(new URL("../css/style.css", import.meta.url), "utf8");

test("le tableau de bord PC affiche des indicateurs réels selon les droits", () => {
    assert.match(navigation, /renderDashboardMetricCards\(calendarEnabled\)/);
    assert.match(navigation, /Clients actifs/);
    assert.match(navigation, /Documents à suivre/);
    assert.match(navigation, /Missions à valider/);
    assert.match(navigation, /Achats à comptabiliser/);
    assert.match(navigation, /canAccessRoute\(ROUTES\.billing\)/);
    assert.match(navigation, /Promise\.allSettled\(requests\)/);
    assert.match(navigation, /Facturation momentanément indisponible/);
});

test("le tableau de bord reste utile sur PC sans module planning", () => {
    assert.match(navigation, /if \(!calendarEnabled && !desktopDashboard\)/);
    assert.match(navigation, /Pilotage administratif/);
    assert.match(navigation, /if \(!calendarEnabled\) return/);
});

test("les indicateurs occupent toute la largeur du poste de travail", () => {
    assert.match(style, /body\.desktop-device \.home-panel\{[\s\S]*width:100%;[\s\S]*max-width:none/);
    assert.match(style, /body\.desktop-device \.dashboard-kpi-grid\{[\s\S]*repeat\(auto-fit,minmax\(175px,1fr\)\)/);
    assert.match(style, /body\.desktop-device \.dashboard-grid\{[\s\S]*minmax\(300px,\.85fr\) minmax\(420px,1\.35fr\)/);
});