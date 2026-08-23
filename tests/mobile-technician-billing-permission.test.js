import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const navigation = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
const auth = readFileSync(new URL("../server/auth.js", import.meta.url), "utf8");
const database = readFileSync(new URL("../server/database.js", import.meta.url), "utf8");

test("la création d’un technicien mobile propose explicitement le droit devis et factures", () => {
    assert.match(navigation, /<legend>Autorisation du technicien mobile<\/legend>/);
    assert.match(navigation, /name="canCreateBilling"/);
    assert.match(navigation, /mobileBillingPermissionField\.hidden = roleInput\.value !== "technician"/);
    assert.match(navigation, /values\.canCreateBilling = roleInput\.value === "technician"/);
});

test("le serveur limite et persiste ce droit au rôle technicien", () => {
    assert.match(auth, /const canCreateBilling = role === "technician" && request\.body\?\.canCreateBilling === true/);
    assert.match(auth, /createUser\(\{[^}]*canCreateBilling/s);
    assert.match(auth, /member_created", \{ role, canCreateBilling,/);
    assert.match(database, /canCreateBilling = false/);
    assert.match(database, /can_create_billing, can_access_billing/);
    assert.match(database, /department, canCreateBilling, canAccessBilling/);
});

test("la rétrogradation Administrateur Mobile vers Technicien conserve un appareil mobile cohérent", () => {
    assert.match(database, /account\.role NOT IN \('admin', 'mobile_admin', 'team_lead', 'technician'\)/);
    assert.match(database, /account\.role IN \('mobile_admin', 'team_lead', 'technician'\)\)\s+AND device\.status <> 'rejected'/);
    assert.match(database, /SET device_type = 'mobile'[\s\S]*account\.role IN \('mobile_admin', 'team_lead', 'technician'\)/);
    assert.match(auth, /SELECT id, username, full_name AS "fullName", role, is_active AS "isActive"[\s\S]*FOR UPDATE/);
    assert.match(auth, /can_create_billing = CASE WHEN \$3 = 'technician' THEN FALSE ELSE can_create_billing END/);
    assert.match(auth, /recordMemberAudit\(ownerId, request\.user\.sub, member, "role_changed", \{ previousRole: member\.role, nextRole \}, database\)/);
    assert.match(auth, /\[member-role-change\] failed/);
});

test("le changement de rôle filtre les choix par offre et ne recharge pas après un échec", () => {
    assert.match(navigation, /const availableRoles = tier === "basic"/);
    assert.match(navigation, /await chooseMemberRole\(member, availableRoles\)/);
    assert.match(navigation, /if \(!response\.ok\) \{[\s\S]*?changeRole\.disabled = false; return; \}/);
    assert.match(navigation, /function chooseMemberRole\(member, roles\)/);
});
