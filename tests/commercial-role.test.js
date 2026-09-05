import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { restrictCommercialMobileAccess } from "../server/auth.js";
import {
    hasAccountingWorkspaceAccess,
    hasBillingWorkspaceAccess,
    hasCompanyEmailWorkspaceAccess,
    hasGroupCompanySwitchAccess
} from "../server/workstation-permissions.js";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function invokeRestriction(method, path, user = { role: "commercial", deviceType: "mobile" }) {
    let nextCalled = false;
    let status = 200;
    let body;
    const response = {
        status(value) { status = value; return this; },
        json(value) { body = value; return this; }
    };
    restrictCommercialMobileAccess({ method, path, user }, response, () => { nextCalled = true; });
    return { nextCalled, status, body };
}

test("le Commercial utilise un seul rôle sur PC et mobile", () => {
    const auth = read("server/auth.js");
    assert.match(auth, /const COMMERCIAL_ROLE = "commercial"/);
    assert.match(auth, /const isCrossDeviceMobile = \["admin", COMMERCIAL_ROLE\]\.includes\(user\.role\) && device\.type === "mobile"/);
    assert.doesNotMatch(auth, /commercial_mobile/);
    assert.match(auth, /userHasActiveMobileDevice\(user\.id\)/);
});

test("le Commercial de bureau reprend les permissions configurables du poste administratif", () => {
    const desktop = {
        role: "commercial",
        deviceType: "desktop",
        groupId: "7",
        organization: { subscriptionTier: "pro" },
        canAccessBilling: true,
        canAccessAccounting: true,
        canAccessCompanyEmail: true,
        canSwitchGroupCompanies: true
    };
    assert.equal(hasBillingWorkspaceAccess(desktop), true);
    assert.equal(hasAccountingWorkspaceAccess(desktop), true);
    assert.equal(hasCompanyEmailWorkspaceAccess(desktop), true);
    assert.equal(hasGroupCompanySwitchAccess(desktop), true);
});

test("les espaces administratifs restent interdits au Commercial mobile", () => {
    const mobile = {
        role: "commercial",
        deviceType: "mobile",
        groupId: "7",
        organization: { subscriptionTier: "pro" },
        canAccessBilling: true,
        canAccessAccounting: true,
        canAccessCompanyEmail: true,
        canSwitchGroupCompanies: true
    };
    assert.equal(hasBillingWorkspaceAccess(mobile), false);
    assert.equal(hasAccountingWorkspaceAccess(mobile), false);
    assert.equal(hasCompanyEmailWorkspaceAccess(mobile), false);
    assert.equal(hasGroupCompanySwitchAccess(mobile), false);
});

test("l’API mobile Commercial autorise uniquement la lecture du planning", () => {
    for (const [method, path] of [
        ["GET", "/api/auth/session"],
        ["GET", "/api/calendar/events"],
        ["GET", "/api/creator/platform-announcement/current"],
        ["POST", "/api/auth/logout"]
    ]) assert.equal(invokeRestriction(method, path).nextCalled, true, `${method} ${path}`);

    for (const [method, path] of [
        ["GET", "/api/clients"],
        ["GET", "/api/accounting"],
        ["POST", "/api/calendar/events"],
        ["PUT", "/api/calendar/events/1"]
    ]) {
        const result = invokeRestriction(method, path);
        assert.equal(result.nextCalled, false, `${method} ${path}`);
        assert.equal(result.status, 403, `${method} ${path}`);
        assert.match(result.body.message, /consulte uniquement ses rendez-vous affectés/);
    }
    assert.equal(invokeRestriction("GET", "/api/clients", { role: "commercial", deviceType: "desktop" }).nextCalled, true);
});

test("le planning mobile Commercial est filtré par affectation et reste en lecture seule", () => {
    const server = read("server/calendar.js");
    const client = read("js/calendar.js");
    assert.match(server, /function hasAssignedOnlyCalendar\(user\)[\s\S]*user\?\.role === "commercial" && user\?\.deviceType === "mobile"/);
    assert.match(server, /assignment\.event_id = event\.id AND assignment\.technician_id = \$5::bigint/);
    assert.match(server, /requireCalendarCreateAccess[\s\S]*isCommercialMobile\(request\.user\)/);
    assert.match(client, /function isCommercialMobileCalendar\(\)/);
    assert.match(client, /function canCreateCalendarEvents\(\)/);
    assert.match(client, /function canCreateCalendarEvents\(\) \{\s*return !isReadOnlyCalendar\(\)/);
    assert.doesNotMatch(client, /Cette intervention vous sera automatiquement affectée/);
});

test("le Commercial mobile démarre directement sur son unique bouton Planning", () => {
    const navigation = read("js/navigation.js");
    const styles = read("css/style.css");
    assert.match(navigation, /else if \(isCommercialMobile\(\) \|\| isMobileAdministrator\(\)\) openCalendar\(\)/);
    assert.match(navigation, /isCommercialMobile\(\) \|\| isMobileAdministrator\(\)/);
    assert.match(navigation, /ROUTES\.home && isMobileDeviceContext\(\) && canAccessRoute\(ROUTES\.home\)/);
    assert.match(navigation, /isCommercialMobile\(\) && route !== ROUTES\.calendar/);
    assert.match(styles, /commercial"\]\.mobile-device footer \.nav-button:not\(\[data-nav="calendar"\]\)\{display:none;\}/);
});

test("un Commercial consomme un poste PC et seulement un appareil mobile approuvé en supplément", () => {
    const auth = read("server/auth.js");
    const creator = read("server/creator.js");
    for (const source of [auth, creator]) {
        assert.match(source, /'admin','pc_standard','commercial','accountant'/);
        assert.match(source, /cross_device_account[^\n]+role IN \('admin','commercial'\)/);
        assert.match(source, /COUNT\(DISTINCT cross_device_mobile\.id\) FILTER \(WHERE cross_device_mobile\.status='approved'/);
    }
});

test("le middleware de restriction mobile est installé avant les routes métier", () => {
    const app = read("app.js");
    const authentication = app.indexOf("app.use(authenticateRequest)");
    const restriction = app.indexOf("app.use(restrictCommercialMobileAccess)");
    const calendar = app.lastIndexOf("registerCalendarRoutes(");
    assert.ok(authentication >= 0 && restriction > authentication && calendar > restriction);
});
