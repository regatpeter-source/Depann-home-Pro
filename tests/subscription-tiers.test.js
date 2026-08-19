import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calculateSubscriptionPriceCents, subscriptionTierConfig } from "../server/subscription-tiers.js";
import { isFeatureEnabled, publicOrganization } from "../server/organizations.js";
import { buildSubscriptionInvoiceSnapshot } from "../server/invoicing.js";

const schema = readFileSync(new URL("../database/schema.sql", import.meta.url), "utf8");
const database = readFileSync(new URL("../server/database.js", import.meta.url), "utf8");
const creatorServer = readFileSync(new URL("../server/creator.js", import.meta.url), "utf8");
const creatorClient = readFileSync(new URL("../js/creator.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const navigation = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
const billing = readFileSync(new URL("../js/billing.js", import.meta.url), "utf8");
const calendar = readFileSync(new URL("../js/calendar.js", import.meta.url), "utf8");
const auth = readFileSync(new URL("../server/auth.js", import.meta.url), "utf8");
const partnerConnections = readFileSync(new URL("../server/partner-connections.js", import.meta.url), "utf8");
const partnerDialogue = readFileSync(new URL("../server/partner-dialogue.js", import.meta.url), "utf8");

test("Basic, Basic+ and Pro prices are calculated per PC and mobile seat", () => {
    assert.equal(calculateSubscriptionPriceCents("basic", 1, 1), 2500);
    assert.equal(calculateSubscriptionPriceCents("basic_plus", 2, 3), 9400);
    assert.equal(calculateSubscriptionPriceCents("pro", 2, 4), 20000);
    assert.deepEqual([subscriptionTierConfig("basic").pcRateCents, subscriptionTierConfig("basic_plus").pcRateCents, subscriptionTierConfig("pro").pcRateCents], [2000, 3500, 7000]);
    assert.deepEqual([subscriptionTierConfig("basic").mobileRateCents, subscriptionTierConfig("basic_plus").mobileRateCents, subscriptionTierConfig("pro").mobileRateCents], [500, 800, 1500]);
});

test("Basic exposes clients, billing and accounting while Basic+ adds planning", () => {
    const basic = publicOrganization({ interfaceType: "standard", licenseType: "depannhome_standard", subscriptionTier: "basic" });
    assert.equal(isFeatureEnabled(basic, "clients"), true);
    assert.equal(isFeatureEnabled(basic, "billing"), true);
    assert.equal(isFeatureEnabled(basic, "accounting"), true);
    assert.equal(isFeatureEnabled(basic, "calendar"), false);
    assert.equal(isFeatureEnabled(basic, "technicalReports"), false);
    assert.equal(isFeatureEnabled(basic, "partnerConnections"), false);
    const plus = publicOrganization({ interfaceType: "standard", licenseType: "depannhome_standard", subscriptionTier: "basic_plus" });
    assert.equal(isFeatureEnabled(plus, "clients"), true);
    assert.equal(isFeatureEnabled(plus, "billing"), true);
    assert.equal(isFeatureEnabled(plus, "accounting"), true);
    assert.equal(isFeatureEnabled(plus, "calendar"), true);
    assert.equal(isFeatureEnabled(plus, "technicalReports"), false);
});

test("Pro enables every product feature", () => {
    const pro = publicOrganization({ interfaceType: "standard", licenseType: "depannhome_standard", subscriptionTier: "pro" });
    for (const feature of ["clients", "calendar", "library", "billing", "accounting", "technicalReports", "partnerMissions", "partnerConnections", "messages", "settings", "imports", "groups", "purchases", "connectors", "photo", "favorites"]) assert.equal(isFeatureEnabled(pro, feature), true, feature);
});

test("a Standard license override cannot unlock a feature outside its tier", () => {
    const basic = publicOrganization({ interfaceType: "standard", licenseType: "depannhome_standard", subscriptionTier: "basic", licenseFeatures: { technicalReports: true } });
    assert.equal(isFeatureEnabled(basic, "technicalReports"), false);
});

test("subscription invoices detail charged PC and mobile seats", () => {
    const snapshot = buildSubscriptionInvoiceSnapshot({ subscriptionTier: "basic_plus", monthlyPriceCents: 7800, maxPcUsers: 2, maxTechnicians: 1, discountMode: "fixed", discountValue: 0 }, 20);
    assert.equal(snapshot.lines.length, 2);
    assert.match(snapshot.lines[0].description, /Basic\+ — poste PC/);
    assert.equal(snapshot.lines[0].quantity, 2);
    assert.match(snapshot.lines[1].description, /Basic\+ — poste mobile/);
    assert.equal(snapshot.lines[1].quantity, 1);
    assert.equal(snapshot.netAmountCents, 7800);
});

test("migration preserves existing accounts as Pro and creator defaults new accounts to Basic", () => {
    assert.match(schema, /subscription_tier VARCHAR\(20\) NOT NULL DEFAULT 'pro'/);
    assert.match(database, /subscription_tier VARCHAR\(20\) NOT NULL DEFAULT 'pro'/);
    assert.match(creatorClient, /subscriptionTier: "basic"/);
    assert.match(creatorServer, /calculateSubscriptionPriceCents\(subscriptionTier, maxPcUsers, maxTechnicians\)/);
});

test("tier features are protected on both API and navigation layers", () => {
    for (const feature of ["clients", "calendar", "billing", "accounting", "purchases", "messages", "partnerConnections", "connectors", "imports", "groups"]) assert.match(app, new RegExp(`requireOrganizationFeature\\("${feature}"\\)`));
    assert.match(navigation, /\[ROUTES\.clients\]: "clients"/);
    assert.match(navigation, /\[ROUTES\.calendar\]: "calendar"/);
    assert.match(navigation, /\[ROUTES\.purchases\]: "purchases"/);
    assert.match(app, /app\.use\("\/api\/billing\/document-templates\/report", requireAuthentication, requireOrganizationFeature\("technicalReports"\)\)/);
    assert.match(app, /app\.use\("\/api\/document-templates\/report", requireAuthentication, requireOrganizationFeature\("technicalReports"\)\)/);
    assert.match(billing, /isAccountant\(\) \|\| !canAccessTechnicalReports\(\)/);
    assert.match(calendar, /canAccessTechnicalReports\(\) \? `<section class="calendar-billing-actions report-entry-point">/);
    assert.match(navigation, /isTechnician\(\) && organizationFeatureEnabled\("technicalReports"\)/);
    assert.match(auth, /memberSeatFamily/);
    assert.match(auth, /La limite de postes mobiles/);
    assert.match(auth, /'admin','pc_standard','accountant'/);
    assert.match(auth, /'mobile_admin','team_lead','technician'/);
    assert.match(partnerConnections, /isFeatureEnabled\(await getOrganization\(ownerId\), "partnerConnections"\)/);
    assert.match(partnerDialogue, /isFeatureEnabled\(await getOrganization\(ownerId\), "partnerMissions"\)/);
    assert.match(creatorServer, /const networkEnabled = subscriptionTier === "pro"/);
    assert.match(creatorServer, /Les interfaces Partenaire et Groupe nécessitent l’abonnement Pro/);
    assert.match(creatorClient, /option\.disabled = !isPro/);
});
