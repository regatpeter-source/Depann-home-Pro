import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const navigation = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
const auth = readFileSync(new URL("../server/auth.js", import.meta.url), "utf8");
const database = readFileSync(new URL("../server/database.js", import.meta.url), "utf8");

test("la création d’un poste mobile propose explicitement le droit devis et factures", () => {
    assert.match(navigation, /<legend>Autorisation du poste mobile<\/legend>/);
    assert.match(navigation, /name="canCreateBilling"/);
    assert.match(navigation, /mobileBillingPermissionField\.hidden = !\["technician", "team_lead"\]\.includes\(roleInput\.value\)/);
    assert.match(navigation, /values\.canCreateBilling = \["technician", "team_lead"\]\.includes\(roleInput\.value\)/);
});

test("le serveur limite et persiste ce droit aux Techniciens et Chefs d’équipe", () => {
    assert.match(auth, /const canCreateBilling = \["technician", TEAM_LEAD_ROLE\]\.includes\(role\) && request\.body\?\.canCreateBilling === true/);
    assert.match(auth, /createUser\(\{[^}]*canCreateBilling/s);
    assert.match(auth, /member_created", \{ role, canCreateBilling,/);
    assert.match(database, /canCreateBilling = false/);
    assert.match(database, /can_create_billing, can_access_billing/);
    assert.match(database, /department = "", departments = \[\], canCreateBilling/);
});

test("la rétrogradation Poste Admin Mobile vers Technicien conserve un appareil mobile cohérent", () => {
    assert.match(database, /account\.role IN \('mobile_admin', 'team_lead', 'technician'\) AND device\.device_type <> 'mobile'/);
    assert.match(database, /account\.role IN \('pc_standard', 'accountant'\) AND device\.device_type <> 'desktop'/);
    assert.match(database, /account\.role IN \('mobile_admin', 'team_lead', 'technician'\)\)\s+AND device\.status <> 'rejected'/);
    assert.doesNotMatch(database, /SET device_type = '(?:mobile|desktop)'/);
    assert.match(auth, /SELECT id, username, full_name AS "fullName", role, is_active AS "isActive"[\s\S]*FOR UPDATE/);
    assert.match(auth, /can_create_billing = CASE WHEN \$3 IN \('technician', 'team_lead'\) THEN FALSE ELSE can_create_billing END/);
    assert.match(auth, /const incompatibleDeviceType = \[MOBILE_ADMIN_ROLE, TEAM_LEAD_ROLE, "technician"\]\.includes\(nextRole\)/);
    assert.match(auth, /SET status='rejected', session_id=NULL/);
    assert.match(auth, /deviceActivationRequired, rejectedDeviceIds/);
    assert.match(auth, /memberSeatError\(ownerId, nextRole, memberId, database, false\)/);
    assert.match(auth, /SAVEPOINT member_role_audit/);
    assert.match(auth, /ROLLBACK TO SAVEPOINT member_role_audit/);
    assert.match(auth, /response\.json\(\{ role: nextRole, deviceActivationRequired, auditRecorded \}\)/);
    assert.match(auth, /\[member-role-change\] failed/);
});

test("le Chef d’équipe utilise le même contrôle serveur que le Technicien", () => {
    const billing = readFileSync(new URL("../server/billing.js", import.meta.url), "utf8");
    assert.match(billing, /\["technician", "team_lead"\]\.includes\(request\.user\?\.role\).*requireTechnicianBillingAccess/);
    assert.match(billing, /if \(!\["technician", "team_lead"\]\.includes\(request\.user\?\.role\)\) return next\(\)/);
});

test("le changement de rôle filtre les choix par offre et ne recharge pas après un échec", () => {
    assert.match(navigation, /const availableRoles = tier === "basic"/);
    assert.match(navigation, /await chooseMemberRole\(member, availableRoles\)/);
    assert.match(navigation, /if \(!response\.ok\) \{[\s\S]*?changeRole\.disabled = false; return; \}/);
    assert.match(navigation, /function chooseMemberRole\(member, roles\)/);
});
