import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const auth = readFileSync(new URL("../server/auth.js", import.meta.url), "utf8");
const groupContext = readFileSync(new URL("../server/group-context.js", import.meta.url), "utf8");
const groups = readFileSync(new URL("../server/groups.js", import.meta.url), "utf8");
const clientsServer = readFileSync(new URL("../server/clients.js", import.meta.url), "utf8");
const billingServer = readFileSync(new URL("../server/billing.js", import.meta.url), "utf8");
const calendarServer = readFileSync(new URL("../server/calendar.js", import.meta.url), "utf8");
const accountingServer = readFileSync(new URL("../server/accounting.js", import.meta.url), "utf8");
const clientSync = readFileSync(new URL("../js/client-sync.js", import.meta.url), "utf8");
const appClient = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("la session Groupe résout exclusivement une entreprise active autorisée", () => {
    assert.match(auth, /resolveGroupCompany\(user\.id, session\.activeCompanyId\)/);
    assert.match(auth, /accountOwnerId = String\(groupCompany\?\.companyId \|\| user\.account_owner_id \|\| user\.id\)/);
    assert.match(auth, /activeCompanyId: accountOwnerId/);
    assert.match(auth, /activeCompanyName: groupCompany\?\.companyName \|\| ""/);
    assert.match(auth, /return String\(request\.user\?\.accountOwnerId \|\| request\.user\?\.sub \|\| ""\)/);
    assert.match(groupContext, /principal\.id = \$1/);
    assert.match(groupContext, /principal\.role IN \('pc_standard', 'commercial', 'accountant'\)/);
    assert.match(groupContext, /company\.is_active = TRUE/);
    assert.match(groupContext, /owner\.is_active = TRUE/);
});

test("le changement d’entreprise valide l’appartenance puis renouvelle la session", () => {
    const route = groups.slice(groups.indexOf('app.put("/api/groups/active-company"'), groups.indexOf('app.get("/api/groups/dashboard"'));
    assert.match(route, /groupCompany\(req\.user\.groupId, companyId, true\)/);
    assert.match(route, /!company \|\| !company\.isActive/);
    assert.match(route, /refreshSessionForActiveCompany\(res, user, req\.user\.deviceId, companyId\)/);
});

test("les principales données métier sont filtrées par le owner_id actif", () => {
    for (const source of [clientsServer, billingServer, calendarServer, accountingServer]) {
        assert.match(source, /getAccountOwnerId\(request\)/);
        assert.match(source, /owner_id\s*=\s*\$|owner_id=\$|owner_id\s*=\s*ANY/);
    }
    assert.match(clientSync, /document\.body\.dataset\.accountId/);
    assert.match(clientSync, /`\$\{CLIENTS_KEY_PREFIX\}\$\{accountId\}`/);
    assert.match(clientSync, /`\$\{QUEUE_KEY_PREFIX\}\$\{accountId\}`/);
});

test("le poste actif affiche en permanence l’entreprise active du groupe", () => {
    assert.match(html, /class="pc-workstation-name"><span id="workstationLabel">Poste<\/span> · <strong id="userEmail"><\/strong>/);
    assert.match(appClient, /workstationLabel\.textContent = activeWorkstationLabel\(user\.role, user\.deviceType\)/);
    assert.match(html, /id="activeCompanyBadge"[^>]*>Entreprise active · <strong id="activeCompanyName"><\/strong>/);
    assert.match(appClient, /activeCompanyName\.textContent = user\.activeCompanyName \|\| ""/);
    assert.match(appClient, /activeCompanyBadge\.hidden = !user\.canSwitchGroupCompanies \|\| !user\.activeCompanyName/);
    assert.match(appClient, /document\.body\.dataset\.activeCompanyId = user\.activeCompanyId/);
    assert.match(appClient, /document\.body\.dataset\.activeCompanyName = user\.activeCompanyName/);
});