import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const authServer = readFileSync(new URL("../server/auth.js", import.meta.url), "utf8");
const authClient = readFileSync(new URL("../js/auth.js", import.meta.url), "utf8");
const appClient = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
const clientSession = readFileSync(new URL("../js/client-session.js", import.meta.url), "utf8");
const navigation = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("le navigateur transmet son identité locale sans autoriser une reclassification silencieuse", () => {
    assert.match(authClient, /export function getDeviceIdentity\(\)/);
    assert.match(clientSession, /X-DepannHome-Device-Id/);
    assert.match(clientSession, /X-DepannHome-Device-Type/);
    assert.match(authServer, /currentDevice\.id !== device\.id \|\| currentDevice\.type !== device\.device_type/);
    assert.match(authServer, /throw new Error\("Identité appareil modifiée"\)/);
    assert.doesNotMatch(authServer, /UPDATE depannhome_auth_devices SET device_type[^\n]+X-DepannHome-Device-Type/);
});

test("les rôles dédiés restent dans leur famille de poste", () => {
    assert.match(authServer, /\[MOBILE_ADMIN_ROLE, TEAM_LEAD_ROLE, "technician"\]\.includes\(user\.role\)/);
    assert.match(authServer, /isDedicatedMobileRole && device\.type !== "mobile"/);
    assert.match(authServer, /\[STANDARD_PC_ROLE, "accountant"\]\.includes\(user\.role\) && device\.type !== "desktop"/);
    assert.match(authServer, /const authDeviceDetails = \{ \.\.\.device \}/);
});

test("l’en-tête affiche le poste actif et jamais un Poste administratif codé en dur", () => {
    assert.match(index, /id="workstationLabel">Poste<\/span>/);
    assert.doesNotMatch(index, />Poste administratif ·/);
    assert.match(appClient, /Poste Admin Mobile/);
    assert.match(appClient, /Chef d’équipe mobile/);
    assert.match(appClient, /Technicien mobile/);
    assert.match(appClient, /Poste Admin/);
});

test("les compteurs et la liste distinguent les utilisateurs administratifs des appareils mobiles", () => {
    assert.match(authServer, /COUNT\(DISTINCT account\.id\).*account\.role IN \('admin','pc_standard','accountant'\)/);
    assert.doesNotMatch(authServer, /COUNT\(DISTINCT device\.id\) FILTER \(WHERE device\.status = 'approved' AND device\.device_type = 'desktop'\)/);
    assert.match(navigation, /\["admin", "pc_standard", "accountant"\]\.includes\(device\.userRole\)/);
    assert.match(navigation, /Chef d’équipe mobile/);
    assert.match(navigation, /Technicien mobile/);
});
