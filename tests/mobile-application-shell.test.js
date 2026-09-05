import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const navigation = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../css/style.css", import.meta.url), "utf8");
const config = readFileSync(new URL("../js/config.js", import.meta.url), "utf8");
const purchases = readFileSync(new URL("../server/purchases.js", import.meta.url), "utf8");

const mobileMenuSource = navigation.slice(
    navigation.indexOf("function initializeMobileWorkspaceMenu"),
    navigation.indexOf("function ensureMobileHomeNavigationButton")
);

test("le poste mobile conserve Accueil, Planning et Menu dans sa barre inférieure", () => {
    assert.match(navigation, /button\.dataset\.nav === ROUTES\.calendar && canAccessRoute\(ROUTES\.calendar\)/);
    assert.match(mobileMenuSource, /mobile-workspace-menu-button/);
    assert.match(styles, /not\(\[data-nav="home"\]\):not\(\[data-nav="calendar"\]\):not\(\.mobile-workspace-menu-button\)/);
    assert.match(styles, /body\.mobile-device #authRoot>footer \.nav-button\{[^}]*flex:1/);
});

test("le menu mobile range les actions existantes dans des sous-dossiers", () => {
    assert.match(mobileMenuSource, /\["Interventions", \["calendarBtn", "interventionSearchBtn", "clientsBtn", "partnerMissionsBtn"\]\]/);
    assert.match(mobileMenuSource, /\["Gestion", \["billingBtn", "accountingBtn", "purchasesBtn"\]\]/);
    assert.match(mobileMenuSource, /\["Communication", \["companyEmailBtn"\]\]/);
    assert.match(mobileMenuSource, /\["Ressources et compte", \["libraryBtn", "settingsBtn"\]\]/);
    assert.match(mobileMenuSource, /source\?\.click\(\)/);
    assert.match(mobileMenuSource, /quickActions\.querySelector\(`#\$\{id\}`\)/);
});

test("Technicien et Chef d’équipe retrouvent leurs interventions sans accès aux Achats", () => {
    assert.match(config, /INTERVENTION_SEARCH_USERS = \["team_lead", "technician"\]/);
    assert.match(navigation, /searchScope = "interventions"/);
    assert.match(navigation, /Retrouver une intervention…/);
    assert.match(navigation, /interventionSearch \? \[\] : getSearchModules\(\)/);
    assert.match(purchases, /\["admin", "pc_standard", "commercial", "accountant", "mobile_admin"\]\.includes\(request\.user\?\.role\)/);
    assert.doesNotMatch(config.match(/const PURCHASE_USERS = [^;]+/)?.[0] || "", /team_lead|technician/);
});

test("le tiroir mobile est accessible et se ferme sans perdre les actions", () => {
    assert.match(mobileMenuSource, /role="dialog" aria-modal="true"/);
    assert.match(mobileMenuSource, /aria-expanded/);
    assert.match(mobileMenuSource, /event\.key === "Escape"/);
    assert.match(styles, /\.mobile-workspace-menu\[hidden\]\{display:none\}/);
    assert.match(styles, /min-height:50px/);
});

test("la densité mobile reste isolée du poste PC", () => {
    assert.match(styles, /body\.mobile-device \.quick-actions\{display:none!important\}/);
    assert.match(styles, /body\.mobile-device \.dashboard-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
    assert.match(styles, /body\.mobile-device \.calendar-grid-panel\{padding:6px;border:0;border-radius:16px/);
    assert.match(styles, /body\.mobile-device \.calendar-grid-panel:has\(\.calendar-timeline\)/);
    assert.match(styles, /body\.mobile-device \.calendar-weekdays,body\.mobile-device \.calendar-grid\{width:100%;min-width:0\}/);
    assert.match(styles, /body\.mobile-device \.calendar-timeline\{[^}]*width:100%;min-width:0/);
    assert.doesNotMatch(styles, /body\.desktop-device[^\n{]*mobile-workspace-menu/);
});
