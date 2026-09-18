import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MENU_ACCESS, ROUTES } from "../js/config.js";
import { isLocalCompanyAdministrator } from "../server/auth.js";

const navigation = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
const auth = readFileSync(new URL("../server/auth.js", import.meta.url), "utf8");
const billing = readFileSync(new URL("../server/billing.js", import.meta.url), "utf8");

test("le Poste PC administratif accède aux Paramètres sans administrer l’entreprise", () => {
    assert.equal(MENU_ACCESS.quick.settings.includes("pc_standard"), true);
    assert.equal(MENU_ACCESS.navigation[ROUTES.settings].includes("pc_standard"), true);
    assert.match(navigation, /\["network", "company", "personalization"\]\.includes\(section\)/);
    assert.match(navigation, /isLocalCompanyAdministrator\(\) \? \[\["users"/);
    assert.match(navigation, /isLocalCompanyAdministrator\(\) \? \[\["documents"/);
    assert.match(navigation, /\["security", "support"\]\.includes\(section\)[\s\S]*\["admin", "pc_standard", "commercial"\]/);
    assert.match(navigation, /const supportAvailable = canAccessSettingsSection\("support"\)/);
});

test("Utilisateurs et appareils restent réservés au Poste Admin", () => {
    assert.match(auth, /app\.get\("\/api\/auth\/members", requireAccountAdministrator/);
    assert.match(auth, /app\.get\("\/api\/auth\/devices", requireAccountAdministrator/);
    assert.match(auth, /if \(!isCompanyAdministrator\(request\)\)[\s\S]*Accès réservé à l’administrateur du compte/);
});

test("un Poste Admin ne peut administrer que son entreprise d’origine", () => {
    assert.match(auth, /homeAccountOwnerId: String\(user\.account_owner_id \|\| user\.id\)/);
    assert.match(auth, /return user\?\.role === "admin" && Boolean\(activeOwnerId\) && homeOwnerId === activeOwnerId/);
    assert.match(navigation, /dataset\.localCompanyAdmin === "true"/);
    assert.match(navigation, /\["subscription", "storage", "documents", "company", "users", "groups", "imports"\][\s\S]*!isLocalCompanyAdministrator\(\)/);
    assert.equal(isLocalCompanyAdministrator({ role: "admin", homeAccountOwnerId: "10", accountOwnerId: "10" }), true);
    assert.equal(isLocalCompanyAdministrator({ role: "admin", homeAccountOwnerId: "10", accountOwnerId: "20" }), false);
    assert.equal(isLocalCompanyAdministrator({ role: "pc_standard", homeAccountOwnerId: "10", accountOwnerId: "10" }), false);
});

test("la recherche et les événements ne contournent pas les droits des Paramètres", () => {
    for (const section of ["network", "company", "documents", "users", "security", "imports"]) {
        assert.match(navigation, new RegExp(`if \\(canAccessSettingsSection\\("${section}"\\)\\)`));
    }
    assert.match(navigation, /if \(canAccessSettingsSection\("storage"\)\).*renderSettings\(\{ section: "storage" \}\)/);
    assert.match(navigation, /depannhome:open-document-template[\s\S]*if \(!canAccessSettingsSection\("documents"\)\) return/);
    assert.match(navigation, /async function openDocumentTemplateSettings\(type\) \{\s*if \(!canAccessSettingsSection\("documents"\)\) return renderSettings\(\)/);
    assert.match(billing, /function requireBillingAdministration[\s\S]*isCompanyAdministrator\(request\)/);
});
