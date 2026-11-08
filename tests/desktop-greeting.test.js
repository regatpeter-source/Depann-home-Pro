import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { updateDesktopGreeting } from "../js/desktop-greeting.js";
import { getActiveCompanyId, getSessionDisplayName, sessionAccessIdentity } from "../js/session-context.js";

function greetingFixture() {
    const nodes = Object.fromEntries([
        "desktopGreeting", "desktopGreetingName", "desktopGreetingDefault", "desktopGreetingCompanyContext", "desktopGreetingCompany"
    ].map(id => [id, { textContent: "", title: "", hidden: true }]));
    return { nodes, root: { getElementById: id => nodes[id] || null } };
}

test("le bandeau PC affiche le nom complet et l’entreprise active", () => {
    const { nodes, root } = greetingFixture();
    updateDesktopGreeting({ deviceType: "desktop", fullName: "Léa Martin", username: "lea", activeCompanyName: "Dépannage Ouest" }, root);
    assert.equal(nodes.desktopGreeting.hidden, false);
    assert.equal(nodes.desktopGreetingName.textContent, "Léa Martin");
    assert.equal(nodes.desktopGreetingName.hidden, false);
    assert.equal(nodes.desktopGreetingDefault.hidden, true);
    assert.equal(nodes.desktopGreetingName.title, "Léa Martin");
    assert.equal(nodes.desktopGreetingCompanyContext.hidden, false);
    assert.equal(nodes.desktopGreetingCompany.textContent, "Dépannage Ouest");
    assert.equal(nodes.desktopGreetingCompany.title, "Dépannage Ouest");
});

test("les changements de nom ou d’entreprise remplacent l’ancien contexte", () => {
    const { nodes, root } = greetingFixture();
    updateDesktopGreeting({ deviceType: "desktop", fullName: "Ancien nom", activeCompanyName: "Ancienne entreprise" }, root);
    updateDesktopGreeting({ deviceType: "desktop", fullName: "Nouveau nom", activeCompanyName: "Nouvelle entreprise" }, root);
    assert.equal(nodes.desktopGreetingName.textContent, "Nouveau nom");
    assert.equal(nodes.desktopGreetingCompany.textContent, "Nouvelle entreprise");
    updateDesktopGreeting({ deviceType: "desktop", fullName: "Nouveau nom", activeCompanyName: "" }, root);
    assert.equal(nodes.desktopGreetingCompanyContext.hidden, true);
    assert.equal(nodes.desktopGreetingCompany.textContent, "");
    assert.equal(nodes.desktopGreetingCompany.title, "");
});

test("les contrôles de session identiques ne réécrivent pas les noms annoncés", () => {
    const { nodes, root } = greetingFixture();
    let writes = 0;
    let value = "";
    Object.defineProperty(nodes.desktopGreetingName, "textContent", {
        get: () => value,
        set: next => { value = next; writes += 1; }
    });
    const user = { deviceType: "desktop", fullName: "Léa Martin", activeCompanyName: "Dépannage Ouest" };
    updateDesktopGreeting(user, root);
    updateDesktopGreeting(user, root);
    assert.equal(writes, 1);
});

test("le nom d’utilisateur remplace un nom complet absent sans interpréter de HTML", () => {
    const { nodes, root } = greetingFixture();
    updateDesktopGreeting({ deviceType: "desktop", fullName: " ", username: "<img src=x>", activeCompanyName: "<Entreprise>" }, root);
    assert.equal(nodes.desktopGreetingName.textContent, "<img src=x>");
    assert.equal(nodes.desktopGreetingCompany.textContent, "<Entreprise>");
    updateDesktopGreeting({ deviceType: "desktop" }, root);
    assert.equal(nodes.desktopGreetingName.textContent, "");
    assert.equal(nodes.desktopGreetingName.hidden, true);
    assert.equal(nodes.desktopGreetingDefault.hidden, false);
    assert.equal(nodes.desktopGreetingCompanyContext.hidden, true);
});

test("le bandeau reste masqué sur mobile et en l’absence de session", () => {
    const { nodes, root } = greetingFixture();
    updateDesktopGreeting({ deviceType: "mobile", fullName: "Technicien", activeCompanyName: "Entreprise" }, root);
    assert.equal(nodes.desktopGreeting.hidden, true);
    updateDesktopGreeting(null, root);
    assert.equal(nodes.desktopGreeting.hidden, true);
    assert.equal(nodes.desktopGreetingName.textContent, "");
    assert.equal(nodes.desktopGreetingDefault.hidden, true);
    assert.equal(nodes.desktopGreetingCompany.textContent, "");
});

test("l’identité d’entreprise utilise le contexte actif avant le compte propriétaire ou l’utilisateur", () => {
    assert.equal(getActiveCompanyId({ id: 1, accountOwnerId: 2, activeCompanyId: 3 }), "3");
    assert.equal(getActiveCompanyId({ id: 1, accountOwnerId: 2 }), "2");
    assert.equal(getActiveCompanyId({ id: 1 }), "1");
    assert.equal(getActiveCompanyId(null), "");
});

test("le nom de session est normalisé de la même façon dans les deux en-têtes", () => {
    assert.equal(getSessionDisplayName({ fullName: "  Léa Martin  ", username: "lea" }), "Léa Martin");
    assert.equal(getSessionDisplayName({ fullName: "  ", username: "  lea  " }), "lea");
    assert.equal(getSessionDisplayName(null), "");
});

test("seuls les changements de contexte ou de droits entraînent un changement d’identité de session", () => {
    const user = { id: "1", role: "admin", deviceType: "desktop", activeCompanyId: "a", fullName: "Ancien nom", activeCompanyName: "Ancienne société" };
    const initial = sessionAccessIdentity(user);
    assert.equal(sessionAccessIdentity({ ...user, fullName: "Nouveau nom", activeCompanyName: "Nouvelle société" }), initial);
    for (const change of [{ id: "2" }, { activeCompanyId: "b" }, { role: "pc_standard" }, { deviceType: "mobile" }, { canManageCalendar: true }, { supportSessionId: "support" }]) {
        assert.notEqual(sessionAccessIdentity({ ...user, ...change }), initial);
    }
});

test("le bandeau fixe suit la session et recharge avant un changement d’entreprise", () => {
    const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    const html = read("index.html");
    const style = read("css/style.css");
    const app = read("js/app.js");
    const navigation = read("js/navigation.js");
    assert.match(html, /id="desktopGreeting"[^>]*hidden/);
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /id="desktopGreetingName" data-no-translate/);
    assert.match(html, /id="desktopGreetingCompany" data-no-translate/);
    assert.match(style, /\.desktop-greeting\{\s*display:none/);
    assert.match(style, /body\.desktop-device \.desktop-greeting:not\(\[hidden\]\)\{[\s\S]*?font-size:clamp\(20px/);
    assert.match(style, /--desktop-header-height:102px/);
    assert.match(style, /body\.desktop-device #authRoot\{[\s\S]*grid-template-rows:var\(--desktop-header-height\)/);
    assert.match(style, /body\.desktop-device\[data-support-control="true"\] #authRoot\{[\s\S]*?height:auto/);
    assert.match(style, /body\.desktop-device \.user-session\{[\s\S]*?min-width:0/);
    assert.match(style, /body\.desktop-device \.pc-workstation-name,\s*body\.desktop-device \.active-company-badge\{[\s\S]*?text-overflow:ellipsis/);
    assert.match(app, /dataset\.activeCompanyId = getActiveCompanyId\(user\)/);
    assert.match(app, /sessionAccessIdentity\(session\.user\) !== initialAccessIdentity\) \{\s*window\.location\.reload\(\);\s*return;\s*\}\s*synchronizeActiveCompanyIdentity\(session\.user\)/);
    assert.match(navigation, /activeCompanyId !== String\(document\.body\.dataset\.activeCompanyId \|\| ""\)\) \{\s*window\.location\.reload\(\);\s*return true;\s*\}[\s\S]*?synchronizeActiveCompanyIdentity\(session\.user\)/);
    assert.match(navigation, /synchronizeActiveCompanyIdentity\(session\.user\)/);
    assert.match(navigation, /updateDesktopGreeting\(user\)/);
});
