import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    hasAccountingWorkspaceAccess,
    hasBillingWorkspaceAccess,
    hasGroupCompanySwitchAccess,
    isAdvancedWorkstationTier,
    supportsConfigurablePcPermissions
} from "../server/workstation-permissions.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = relativePath => fs.readFileSync(path.join(root, relativePath), "utf8");
const user = (role, tier, permissions = {}) => ({ role, organization: { subscriptionTier: tier }, ...permissions });

test("les autorisations configurables sont limitées aux postes PC Basic+ et Pro", () => {
    assert.equal(isAdvancedWorkstationTier("basic"), false);
    assert.equal(isAdvancedWorkstationTier("basic_plus"), true);
    assert.equal(isAdvancedWorkstationTier("pro"), true);
    assert.equal(supportsConfigurablePcPermissions("pc_standard"), true);
    assert.equal(supportsConfigurablePcPermissions("accountant"), true);
    assert.equal(supportsConfigurablePcPermissions("technician"), false);
});

test("un Administrateur PC conserve tous les accès sans dépendre des cases", () => {
    const basicAdministrator = user("admin", "basic", { deviceType: "desktop", canAccessBilling: false, canAccessAccounting: false, groupId: "7", canSwitchGroupCompanies: false });
    const proAdministrator = user("admin", "pro", { deviceType: "desktop", canAccessBilling: false, canAccessAccounting: false, groupId: "7", canSwitchGroupCompanies: false });
    assert.equal(hasBillingWorkspaceAccess(basicAdministrator), true);
    assert.equal(hasAccountingWorkspaceAccess(basicAdministrator), true);
    assert.equal(hasGroupCompanySwitchAccess(basicAdministrator), false);
    assert.equal(hasGroupCompanySwitchAccess(proAdministrator), true);
});

test("un poste PC Basic ne peut pas activer les droits avancés", () => {
    const basic = user("pc_standard", "basic", { canAccessBilling: true, canAccessAccounting: true, groupId: "7", canSwitchGroupCompanies: true });
    assert.equal(hasBillingWorkspaceAccess(basic), false);
    assert.equal(hasAccountingWorkspaceAccess(basic), false);
    assert.equal(hasGroupCompanySwitchAccess(basic), false);
});

test("les cases contrôlent séparément Facturation et Comptabilité en Basic+ et Pro", () => {
    const billingOnly = user("pc_standard", "basic_plus", { canAccessBilling: true, canAccessAccounting: false });
    assert.equal(hasBillingWorkspaceAccess(billingOnly), true);
    assert.equal(hasAccountingWorkspaceAccess(billingOnly), false);
    const accountingOnly = user("accountant", "pro", { canAccessBilling: false, canAccessAccounting: true });
    assert.equal(hasBillingWorkspaceAccess(accountingOnly), false);
    assert.equal(hasAccountingWorkspaceAccess(accountingOnly), true);
});

test("l’accès Groupe exige la case, un groupe actif et une offre compatible", () => {
    assert.equal(hasGroupCompanySwitchAccess(user("pc_standard", "pro", { deviceType: "desktop", groupId: "", canSwitchGroupCompanies: true })), false);
    assert.equal(hasGroupCompanySwitchAccess(user("pc_standard", "pro", { deviceType: "desktop", groupId: "3", canSwitchGroupCompanies: false })), false);
    assert.equal(hasGroupCompanySwitchAccess(user("pc_standard", "basic_plus", { deviceType: "desktop", groupId: "3", canSwitchGroupCompanies: true })), false);
    assert.equal(hasGroupCompanySwitchAccess(user("pc_standard", "pro", { deviceType: "desktop", groupId: "3", canSwitchGroupCompanies: true })), true);
    assert.equal(hasGroupCompanySwitchAccess(user("admin", "pro", { deviceType: "mobile", groupId: "3", canSwitchGroupCompanies: true })), false);
});

test("la bascule Groupe conserve le rôle réel et sépare administration et sélection", () => {
    const auth = read("server/auth.js");
    const groups = read("server/groups.js");
    const context = read("server/group-context.js");
    assert.match(auth, /role: user\.role/);
    assert.doesNotMatch(auth, /role: groupCompany \? "admin"/);
    assert.match(auth, /isGroupAdministrator: Boolean\(groupCompany\?\.isGroupAdministrator\)/);
    assert.match(groups, /active-company", requireGroupCompanySwitchAccess/);
    assert.match(groups, /dashboard", requireGroupAdministrator/);
    assert.match(context, /principal\.role IN \('pc_standard', 'accountant'\)/);
    assert.match(context, /home_owner\.subscription_tier = 'pro'/);
    assert.match(context, /owner\.subscription_tier = 'pro'/);
});

test("le stockage et l’interface déclarent les trois permissions", () => {
    const database = read("server/database.js");
    const auth = read("server/auth.js");
    const navigation = read("js/navigation.js");
    for (const column of ["can_access_billing", "can_access_accounting", "can_switch_group_companies"]) assert.match(database, new RegExp(column));
    for (const field of ["canAccessBilling", "canAccessAccounting", "canSwitchGroupCompanies"]) assert.match(navigation, new RegExp(field));
    assert.match(navigation, /groupCompanyPermissionAvailable = tier === "pro"/);
    assert.match(auth, /organization\.subscriptionTier === "pro"/);
    assert.match(navigation, /L’Administrateur \(PC\) dispose automatiquement de tous les accès/);
});
