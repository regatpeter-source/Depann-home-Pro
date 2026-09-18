import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { groupActivationAccessError, validateGroupCompanyInput } from "../server/groups.js";
import { groupCompanyFormError } from "../js/groups.js";

const groups = readFileSync(new URL("../server/groups.js", import.meta.url), "utf8");
const context = readFileSync(new URL("../server/group-context.js", import.meta.url), "utf8");
const creator = readFileSync(new URL("../js/creator.js", import.meta.url), "utf8");
const groupsClient = readFileSync(new URL("../js/groups.js", import.meta.url), "utf8");
const appClient = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");

test("seule une entreprise Pro payante non partenaire peut activer le mode Groupe", () => {
    assert.equal(groupActivationAccessError({ subscription_plan: "paid", subscription_tier: "pro" }, { interfaceType: "standard" }), "");
    assert.match(groupActivationAccessError({ subscription_plan: "paid", subscription_tier: "basic_plus" }, { interfaceType: "standard" }), /offre Pro payante/);
    assert.match(groupActivationAccessError({ subscription_plan: "free", subscription_tier: "pro" }, { interfaceType: "partner" }), /Partenaire gratuit/);
});

test("l'activation et les sociétés rattachées enregistrent réellement l'interface Groupe", () => {
    assert.match(groups, /updateOrganization\(companyId, \{ interfaceType: "group", licenseType: "depannhome_group" \}/);
    assert.match(groups, /createOrganization\(user\.id, \{ interfaceType: "group", licenseType: "depannhome_group" \}/);
    assert.match(groups, /principal\.subscription_plan='paid' AND principal\.subscription_tier='pro'/);
    assert.match(groups, /organization\.interface_type<>'partner'/);
});

test("les routes multi-entreprises exigent une interface Groupe active", () => {
    assert.match(groups, /organization\.interfaceType === "group" && organization\.subscriptionTier === "pro"/);
    assert.match(context, /home_organization\.interface_type='group'/);
    assert.match(context, /active_organization\.interface_type='group'/);
});

test("la création distingue clairement Partenaire gratuit et Groupe inclus dans Pro", () => {
    assert.match(creator, /Compte Partenaire gratuit — sans abonnement/);
    assert.match(creator, /Groupe \/ Multi-entreprises — inclus dans Pro/);
    assert.match(groupsClient, /Option Pro · activation facultative/);
    assert.match(groupsClient, /Sans activation, votre interface reste Standard et limitée à une entreprise/);
});

test("la dissolution restaure l'interface Standard de chaque société", () => {
    assert.match(groups, /SET interface_type='standard',license_type='depannhome_standard'/);
    assert.match(groups, /SELECT company_owner_id FROM depannhome_group_companies WHERE group_id=\$1/);
});

test("un essai Groupe actif n'est pas exclu de la création d'entreprise", () => {
    const administratorGuard = groups.slice(groups.indexOf("async function requireGroupAdministrator"), groups.indexOf("async function requireGroupCompanySwitchAccess"));
    assert.match(administratorGuard, /organization\.interfaceType === "group"/);
    assert.match(administratorGuard, /organization\.subscriptionTier === "pro"/);
    assert.doesNotMatch(administratorGuard, /subscriptionStatus|subscription_status|trial/);
});

test("la création explique précisément les identifiants invalides", () => {
    const base = { companyName: "Agence Nord", fullName: "Jean Dupont", username: "agence.nord", password: "mot-de-passe-solide", email: "admin@example.test", allocatedPcSeats: 1, allocatedMobileSeats: 0 };
    assert.equal(validateGroupCompanyInput(base).ok, true);
    assert.match(validateGroupCompanyInput({ ...base, password: "admin" }).message, /au moins 12 caractères/);
    assert.match(validateGroupCompanyInput({ ...base, username: "a" }).message, /3 à 32 caractères/);
    assert.match(groupCompanyFormError({ ...base, password: "admin" }), /au moins 12 caractères/);
    assert.equal(groupCompanyFormError(base), "");
});

test("le formulaire affiche les blocages de quota et les erreurs serveur dans la page", () => {
    assert.match(groupsClient, /form\.dataset\.blockedReason/);
    assert.match(groupsClient, /Aucun poste PC n’est disponible/);
    assert.match(groupsClient, /companyFeedback\.textContent = result\.message/);
    assert.doesNotMatch(groupsClient, /return alert\(result\.message \|\| "Création impossible\."\)/);
    assert.match(groups, /Cet identifiant administrateur est déjà utilisé/);
});

test("le sélecteur supérieur recharge les entreprises après une modification du Groupe", () => {
    assert.match(groupsClient, /notifyGroupCompaniesChanged\(\);\s*renderGroupWorkspace\(\);/);
    assert.match(groupsClient, /depannhome:group-companies-changed/);
    assert.match(appClient, /addEventListener\("depannhome:group-companies-changed", \(\) => refreshGroupCompanySelector\(\)\)/);
    assert.match(appClient, /fetch\("\/api\/groups\/context", \{ credentials: "same-origin", cache: "no-store" \}\)/);
    assert.match(appClient, /select\.onchange = async/);
});