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
