import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const style = readFileSync(new URL("../css/style.css", import.meta.url), "utf8");
const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const serviceWorker = readFileSync(new URL("../service-worker.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
const navigation = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
const library = readFileSync(new URL("../js/library.js", import.meta.url), "utf8");
const libraryServer = readFileSync(new URL("../server/library.js", import.meta.url), "utf8");

test("desktop uses a viewport application shell with internal content scrolling", () => {
    assert.match(style, /body\.desktop-device #authRoot\{[\s\S]*grid-template-columns:var\(--desktop-sidebar-width\) minmax\(0,1fr\)/);
    assert.match(style, /body\.desktop-device #app\{[\s\S]*min-height:0;[\s\S]*overflow:auto/);
    assert.match(style, /body\.desktop-device #authRoot > footer\{[\s\S]*grid-column:1;[\s\S]*flex-direction:column/);
    assert.match(style, /body\.desktop-device #authRoot > footer \.nav-button:not\(\[data-nav="home"\]\)\{[\s\S]*display:grid/);
});

test("desktop density rules stay isolated from the mobile shell", () => {
    assert.match(style, /body\.desktop-device \.brand-card\{[\s\S]*--desktop-radius/);
    assert.match(style, /body\.desktop-device \.quick-actions\{\s*display:none/);
    assert.match(style, /body\.desktop-device \.group-shell,[\s\S]*body\.desktop-device \.connectors-shell\{[\s\S]*max-width:none/);
    assert.match(style, /body\.desktop-device #authRoot > footer \.nav-button\[data-nav="search"\],[\s\S]*\.nav-button\[data-nav="store"\]\{\s*display:none/);
    assert.match(index, /<button class="nav-button" data-nav="search">/);
    assert.match(style, /body\.desktop-device #authRoot > footer \.nav-button,[\s\S]*grid-template-columns:minmax\(0,1fr\) auto/);
    assert.doesNotMatch(style, /\.nav-button\[data-nav="home"\]::before\{content:"AC"/);
    assert.match(style, /body\.desktop-device \.client-workspace-tabs\{/);
    assert.match(style, /body\.desktop-device \.client-workspace-tab > span\{\s*display:none/);
    assert.match(style, /--primary:#2f607d/);
    assert.match(style, /--secondary:#4f806f/);
    assert.match(style, /body\.desktop-device \.client-form > \.form-grid\{[\s\S]*repeat\(3/);
    assert.match(style, /body\.mobile-device:not\(\.report-writing-active\) #authRoot > footer/);
    assert.doesNotMatch(style, /body\.mobile-device[^{]*\{[^}]*--desktop-sidebar-width/);
});

test("authentication hides the restored shell until desktop menus are filtered", () => {
    const authenticatedCallback = app.slice(app.indexOf("onAuthenticated: user =>"), app.indexOf("startAdministratorSessionMonitor(user)"));
    assert.ok(authenticatedCallback.indexOf('classList.add("auth-pending")') < authenticatedCallback.indexOf("restoreApplicationShell()"));
    assert.match(style, /\.auth-pending #authRoot\{\s*visibility:hidden/);
});

test("Gammes and Library never appear in the PC software", () => {
    assert.doesNotMatch(index, /id="libraryBtn"/);
    assert.doesNotMatch(index, /<button class="nav-button" data-nav="library">/);
    assert.match(index, /<h2 class="section-title" id="pageTitle">\s*Accueil\s*<\/h2>/);
    assert.match(navigation, /function ensureMobileLibraryQuickAction\(\) \{\s*if \(!isMobileDeviceContext\(\) \|\| document\.getElementById\("libraryBtn"\)\) return/);
    assert.match(navigation, /if \(isDesktopDevice\(\) && route === ROUTES\.library\) return false/);
    assert.match(navigation, /function restoreCatalogView\(view = \{\}\) \{\s*if \(isDesktopDevice\(\)\) return false/);
    assert.match(navigation, /export function renderBrands\(\) \{\s*if \(isDesktopDevice\(\)\) return renderHome\(\)/);
    assert.match(navigation, /function navigateToRef\(ref\) \{\s*if \(isDesktopDevice\(\)\) return renderHome\(\)/);
    assert.match(library, /export async function renderLibrary\(\) \{\s*if \(isPcSoftware\(\)\) return false/);
    assert.match(libraryServer, /request\.user\?\.deviceType !== "mobile"/);
    assert.match(style, /desktop-device\[data-role="technician"\] \.quick-actions > :not\(#calendarBtn\)/);
    assert.doesNotMatch(style, /desktop-device\[data-role="technician"\][^\n]*library/);
});

test("desktop stylesheet cache versions remain synchronized", () => {
    assert.match(index, /css\/style\.css\?v=309/);
    assert.match(index, /js\/app\.js\?v=504/);
    assert.match(serviceWorker, /css\/style\.css\?v=309/);
    assert.match(serviceWorker, /js\/app\.js\?v=504/);
    assert.match(serviceWorker, /js\/clients\.js\?v=176/);
    assert.match(serviceWorker, /js\/client-sync\.js\?v=132/);
    assert.match(serviceWorker, /js\/desktop-workspace\.js\?v=4/);
    assert.match(serviceWorker, /js\/navigation\.js\?v=526/);
    assert.match(serviceWorker, /js\/library\.js\?v=124/);
    assert.match(serviceWorker, /js\/creator\.js\?v=175/);
    assert.match(serviceWorker, /js\/i18n\.js\?v=6/);
    assert.match(serviceWorker, /depann-home-pro-v628/);
});