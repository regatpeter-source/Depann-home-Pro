import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const style = readFileSync(new URL("../css/style.css", import.meta.url), "utf8");
const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const serviceWorker = readFileSync(new URL("../service-worker.js", import.meta.url), "utf8");

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

test("desktop stylesheet cache versions remain synchronized", () => {
    assert.match(index, /css\/style\.css\?v=239/);
    assert.match(index, /js\/app\.js\?v=388/);
    assert.match(serviceWorker, /css\/style\.css\?v=239/);
    assert.match(serviceWorker, /js\/app\.js\?v=388/);
    assert.match(serviceWorker, /js\/clients\.js\?v=158/);
    assert.match(serviceWorker, /js\/client-sync\.js\?v=126/);
    assert.match(serviceWorker, /js\/navigation\.js\?v=421/);
    assert.match(serviceWorker, /depann-home-pro-v486/);
});