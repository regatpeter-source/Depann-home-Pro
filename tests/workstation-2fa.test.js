import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const auth = readFileSync(new URL("../server/auth.js", import.meta.url), "utf8");
const navigation = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
const clientAuth = readFileSync(new URL("../js/auth.js", import.meta.url), "utf8");
const documentation = readFileSync(new URL("../docs/COMPANY_2FA.md", import.meta.url), "utf8");

test("la 2FA personnelle couvre exactement les rôles PC autorisés", () => {
    assert.match(auth, /const WORKSTATION_TOTP_ROLES = new Set\(\["admin", STANDARD_PC_ROLE, COMMERCIAL_ROLE\]\)/);
    assert.match(auth, /WORKSTATION_TOTP_ROLES\.has\(user\.role\) && device\.type === "desktop"[\s\S]*hasCompanyTotpAuthenticator\(user\.id\)/);
    assert.match(auth, /challenge\.device\?\.type !== "desktop"/);
    assert.match(auth, /request\.user\?\.deviceType === "desktop" && WORKSTATION_TOTP_ROLES\.has\(request\.user\?\.role\)/);
});

test("les opérations 2FA sont personnelles et ne dépendent pas de l’entreprise active", () => {
    for (const route of [
        'app.get("/api/auth/workstation-2fa", requireAuthentication, requireWorkstationSecurityAccess',
        'app.post("/api/auth/workstation-2fa/setup", requireAuthentication, requireWorkstationSecurityAccess',
        'app.post("/api/auth/workstation-2fa/confirm", requireAuthentication, requireWorkstationSecurityAccess',
        'app.delete("/api/auth/workstation-2fa", requireAuthentication, requireWorkstationSecurityAccess'
    ]) assert.equal(auth.includes(route), true);

    assert.match(auth, /hasCompanyTotpAuthenticator\(request\.user\.sub\)/);
    assert.match(auth, /findUserById\(request\.user\.sub\)/);
    assert.match(auth, /DELETE FROM depannhome_company_totp_authenticators WHERE user_id=\$1/);
    assert.doesNotMatch(auth, /\/api\/auth\/company-2fa\/administrators/);
    assert.doesNotMatch(auth, /\/api\/auth\/company-2fa\/policy/);
});

test("la désactivation exige le code courant et l’interface utilise le libre-service", () => {
    assert.match(auth, /app\.delete\("\/api\/auth\/workstation-2fa"[\s\S]*isValidTotpCode\(secret, code, user\.username\)/);
    assert.match(navigation, /fetch\("\/api\/auth\/workstation-2fa\/setup"/);
    assert.match(navigation, /fetch\("\/api\/auth\/workstation-2fa\/confirm"/);
    assert.match(navigation, /fetch\("\/api\/auth\/workstation-2fa", \{ method: "DELETE"/);
});

test("le client de connexion ne propose plus d’enrôlement global", () => {
    assert.doesNotMatch(clientAuth, /companyTotpEnrollmentRequired/);
    assert.doesNotMatch(clientAuth, /company-2fa\/enrollment/);
    assert.match(clientAuth, /companyTotpRequired/);
    assert.match(clientAuth, /\/api\/auth\/verify-company-totp/);
});

test("la documentation garantit l’indépendance par compte, offre et entreprise", () => {
    assert.match(documentation, /Poste administratif \(`pc_standard`\)/);
    assert.match(documentation, /Commercial \/ Chargé d’affaires \(`commercial`\)/);
    assert.match(documentation, /indépendante des autres postes, de l’offre active et de l’entreprise sélectionnée/);
    assert.match(documentation, /téléphone ne reçoit le défi TOTP que lors de ses connexions sur ordinateur/);
});
