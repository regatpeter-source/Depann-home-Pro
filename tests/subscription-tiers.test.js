import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calculateSubscriptionPriceCents, isRoleAllowedForSubscription, subscriptionRoleAccessMessage, subscriptionTierConfig } from "../server/subscription-tiers.js";
import { isFeatureEnabled, isFeatureEnabledForRole, publicOrganization } from "../server/organizations.js";
import { MENU_ACCESS, ROUTES } from "../js/config.js";
import { buildSubscriptionInvoiceSnapshot } from "../server/invoicing.js";
import { memberRoleAccessError, memberSeatError, memberSeatFamily, mobileAdministratorSeatError } from "../server/auth.js";

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
const purchasesServer = readFileSync(new URL("../server/purchases.js", import.meta.url), "utf8");
const supportServer = readFileSync(new URL("../server/support.js", import.meta.url), "utf8");
const partnerRequestsServer = readFileSync(new URL("../server/partner-requests.js", import.meta.url), "utf8");
const style = readFileSync(new URL("../css/style.css", import.meta.url), "utf8");

test("Basic, Basic+ and Pro prices are calculated per PC and mobile seat", () => {
    assert.equal(calculateSubscriptionPriceCents("basic", 1, 1), 2500);
    assert.equal(calculateSubscriptionPriceCents("basic_plus", 2, 3), 9400);
    assert.equal(calculateSubscriptionPriceCents("pro", 2, 4), 20000);
    assert.deepEqual([subscriptionTierConfig("basic").pcRateCents, subscriptionTierConfig("basic_plus").pcRateCents, subscriptionTierConfig("pro").pcRateCents], [2000, 3500, 7000]);
    assert.deepEqual([subscriptionTierConfig("basic").mobileRateCents, subscriptionTierConfig("basic_plus").mobileRateCents, subscriptionTierConfig("pro").mobileRateCents], [500, 800, 1500]);
});

test("subscription tiers restrict mobile post roles as specified", () => {
    for (const role of ["admin", "pc_standard", "accountant", "mobile_admin"]) assert.equal(isRoleAllowedForSubscription("basic", role), true, `basic:${role}`);
    for (const role of ["team_lead", "technician"]) assert.equal(isRoleAllowedForSubscription("basic", role), false, `basic:${role}`);
    for (const tier of ["basic_plus", "pro"]) {
        for (const role of ["admin", "pc_standard", "accountant", "mobile_admin", "team_lead", "technician"]) assert.equal(isRoleAllowedForSubscription(tier, role), true, `${tier}:${role}`);
    }
    assert.match(subscriptionRoleAccessMessage("basic", "technician"), /Basic\+/);
    assert.equal(memberSeatFamily("admin"), "pc");
    assert.equal(memberSeatFamily("mobile_admin"), "mobile");
    assert.equal(typeof memberSeatError, "function");
    assert.equal(typeof memberRoleAccessError, "function");
    assert.equal(typeof mobileAdministratorSeatError, "function");
});

test("Basic exposes clients, billing and accounting while Basic+ adds planning", () => {
    const basic = publicOrganization({ interfaceType: "standard", licenseType: "depannhome_standard", subscriptionTier: "basic" });
    assert.equal(isFeatureEnabled(basic, "clients"), true);
    assert.equal(isFeatureEnabled(basic, "billing"), true);
    assert.equal(isFeatureEnabled(basic, "accounting"), true);
    assert.equal(isFeatureEnabled(basic, "purchases"), true);
    assert.equal(isFeatureEnabled(basic, "quitus"), false);
    assert.equal(isFeatureEnabled(basic, "calendar"), false);
    assert.equal(isFeatureEnabled(basic, "technicalReports"), false);
    assert.equal(isFeatureEnabled(basic, "partnerConnections"), false);
    const plus = publicOrganization({ interfaceType: "standard", licenseType: "depannhome_standard", subscriptionTier: "basic_plus" });
    assert.equal(isFeatureEnabled(plus, "clients"), true);
    assert.equal(isFeatureEnabled(plus, "billing"), true);
    assert.equal(isFeatureEnabled(plus, "accounting"), true);
    assert.equal(isFeatureEnabled(plus, "purchases"), true);
    assert.equal(isFeatureEnabled(plus, "calendar"), true);
    assert.equal(isFeatureEnabled(plus, "quitus"), false);
    assert.equal(isFeatureEnabled(plus, "technicalReports"), false);
});

test("every mobile post keeps Home and Library access regardless of subscription tier", () => {
    const mobileRoles = ["mobile_admin", "team_lead", "technician"];
    for (const subscriptionTier of ["basic", "basic_plus", "pro"]) {
        const organization = publicOrganization({ interfaceType: "standard", licenseType: "depannhome_standard", subscriptionTier });
        for (const role of mobileRoles) assert.equal(isFeatureEnabledForRole(organization, "library", role), true, `${subscriptionTier}:${role}:library`);
    }
    for (const role of mobileRoles) {
        assert.equal(MENU_ACCESS.navigation[ROUTES.home].includes(role), true, `${role}:home`);
        assert.equal(MENU_ACCESS.navigation[ROUTES.library].includes(role), true, `${role}:library-route`);
        assert.equal(MENU_ACCESS.quick.library.includes(role), true, `${role}:library-button`);
    }
    assert.match(style, /mobile-device\[data-role="technician"\] \.nav-button:not\(\[data-nav="home"\]\):not\(\[data-nav="calendar"\]\):not\(\[data-nav="library"\]\)/);
    assert.match(style, /desktop-device\[data-role="technician"\] \.nav-button:not\(\[data-nav="home"\]\):not\(\[data-nav="calendar"\]\):not\(\[data-nav="library"\]\)/);
    assert.match(navigation, /ensureMobileHomeNavigationButton\(\)/);
    assert.match(navigation, /button\.dataset\.nav === ROUTES\.home && isMobileDeviceContext\(\)/);
    assert.match(navigation, /matchMedia\("\(max-width: 700px\), \(pointer: coarse\)"\)\.matches/);
    assert.match(style, /mobile-device:not\(\.report-writing-active\) #authRoot > footer/);
    assert.match(style, /@media\(max-width:700px\), \(pointer:coarse\)/);
    assert.match(style, /footer \.nav-button\[data-nav="home"\]/);
    assert.match(navigation, /else if \(isMobileDeviceContext\(\)\) openHome\(\)/);
    assert.match(navigation, /if \(activeSubscriptionTier\(\) === "basic"\) renderHome\(\)/);
    assert.match(navigation, /else if \(canAccessRoute\(ROUTES\.calendar\)\) openCalendar\(\)/);
    assert.match(navigation, /if \(!canAccessRoute\(ROUTES\.calendar\)\) \{\s*document\.body\.dataset\.pageMode = "basic-home"/);
    assert.doesNotMatch(navigation, /container\.removeChild\(panel\)/);
    assert.match(style, /body\[data-page-mode="basic-home"\] #pageTitle/);
    assert.match(navigation, /if \(document\.body\.classList\.contains\("desktop-device"\) \|\| isMobileAdministrator\(\)\)/);
    assert.doesNotMatch(navigation, /data-basic-home=/);
});

test("Library is mobile-only and Purchases are available on every PC plus Mobile Administrator", () => {
    for (const subscriptionTier of ["basic", "basic_plus", "pro"]) {
        const organization = publicOrganization({ interfaceType: "standard", licenseType: "depannhome_standard", subscriptionTier });
        for (const role of ["mobile_admin", "team_lead", "technician"]) assert.equal(isFeatureEnabledForRole(organization, "library", role), true, `${subscriptionTier}:${role}:library`);
        for (const role of ["admin", "pc_standard", "accountant"]) assert.equal(isFeatureEnabledForRole(organization, "library", role), false, `${subscriptionTier}:${role}:library-pc`);
        for (const role of ["admin", "pc_standard", "accountant", "mobile_admin"]) assert.equal(isFeatureEnabledForRole(organization, "purchases", role), true, `${subscriptionTier}:${role}:purchases`);
        for (const role of ["team_lead", "technician"]) assert.equal(isFeatureEnabledForRole(organization, "purchases", role), false, `${subscriptionTier}:${role}:purchases`);
    }
    assert.deepEqual(MENU_ACCESS.quick.purchases, ["admin", "pc_standard", "accountant", "mobile_admin"]);
    assert.deepEqual(MENU_ACCESS.navigation[ROUTES.purchases], ["admin", "pc_standard", "accountant", "mobile_admin"]);
    assert.match(purchasesServer, /\["admin", "pc_standard", "accountant", "mobile_admin"\]\.includes\(request\.user\?\.role\)/);
    assert.match(billing, /data-billing-action="open-purchases"/);
});

test("Pro enables every product feature", () => {
    const pro = publicOrganization({ interfaceType: "standard", licenseType: "depannhome_standard", subscriptionTier: "pro" });
    for (const feature of ["clients", "calendar", "library", "billing", "accounting", "quitus", "technicalReports", "partnerMissions", "partnerConnections", "messages", "settings", "imports", "groups", "purchases", "connectors", "photo", "favorites"]) assert.equal(isFeatureEnabled(pro, feature), true, feature);
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
    for (const source of [schema, database]) {
        assert.match(source, /CREATE TABLE IF NOT EXISTS depannhome_subscription_change_requests/);
        assert.match(source, /requested_pc_seats INTEGER/);
        assert.match(source, /requested_mobile_seats INTEGER/);
    }
});

test("companies request offer changes from Settings without changing the active tier", () => {
    assert.doesNotMatch(navigation, /Depann’Home Pro Basic/);
    assert.doesNotMatch(navigation, /data-basic-home=/);
    assert.match(navigation, /\["subscription", "Offre & abonnement"/);
    assert.match(navigation, /\/api\/subscription-change-requests/);
    assert.match(navigation, /Postes PC autorisés/);
    assert.match(navigation, /Postes mobiles autorisés/);
    assert.match(navigation, /Tarif total actuel/);
    assert.match(navigation, /data-seat-request/);
    const subscriptionSettings = navigation.slice(navigation.indexOf("async function renderSubscriptionSettings"), navigation.indexOf("function subscriptionRequestStatusLabel"));
    assert.doesNotMatch(subscriptionSettings, /Créateur/);
    assert.match(subscriptionSettings, /Support/);
    assert.match(style, /\.subscription-offers-grid\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
    assert.match(style, /@media\(max-width:1000px\)\{\.subscription-offers-grid\{grid-template-columns:1fr\}/);
    assert.match(style, /\.subscription-offer-card>\.secondary-button\{width:100%;margin-top:auto/);
    assert.match(creatorServer, /app\.post\("\/api\/subscription-change-requests"/);
    assert.match(creatorServer, /transmise au Support/);
    assert.match(creatorServer, /app\.get\("\/api\/creator\/subscription-change-requests"/);
    assert.match(creatorServer, /app\.patch\("\/api\/creator\/subscription-change-requests\/:requestId"/);
    assert.match(creatorServer, /resolved_by=CASE WHEN \$4::boolean THEN \$5::bigint ELSE NULL::bigint END/);
    assert.match(creatorServer, /resolved_at=CASE WHEN \$4::boolean THEN NOW\(\) ELSE NULL::timestamptz END/);
    const requestRoutes = creatorServer.slice(creatorServer.indexOf('app.get("/api/subscription-change-requests"'), creatorServer.indexOf('app.get("/api/creator/platform-announcement/current"'));
    assert.doesNotMatch(requestRoutes, /UPDATE depannhome_users/);
    assert.match(requestRoutes, /requested_pc_seats/);
    assert.match(requestRoutes, /requested_mobile_seats/);
    assert.match(creatorClient, /id="creatorSubscriptionRequests"/);
    assert.match(creatorClient, /renderSubscriptionChangeRequests/);
    assert.match(creatorClient, /requestedPcSeats/);
    assert.match(creatorClient, /requestedMobileSeats/);
});

test("Creator console notifies every internal and external request", () => {
    assert.match(app, /initializeSupport\(\)/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS depannhome_support_requests/);
    assert.match(supportServer, /INSERT INTO depannhome_support_requests/);
    assert.match(supportServer, /support_request_received/);
    assert.match(creatorServer, /subscription_request_received/);
    assert.match(partnerRequestsServer, /partner_request_received/);
    assert.match(creatorServer, /app\.get\("\/api\/creator\/request-notifications"/);
    for (const table of ["depannhome_subscription_change_requests", "depannhome_support_requests", "depannhome_partner_requests"]) assert.match(creatorServer, new RegExp(table));
    assert.match(creatorClient, /id = "creatorRequestNotifications"/);
    assert.match(creatorClient, /creator-request-alert/);
    assert.match(creatorClient, /renderCreatorRequestNotifications/);
    assert.match(creatorClient, /renderCreatorSupportRequests/);
    assert.match(style, /\.creator-request-alert/);
    assert.match(navigation, /openCreatorRequestNotification\("subscription"\)/);
    assert.match(navigation, /openCreatorRequestNotification\("support"\)/);
});

test("tier features are protected on both API and navigation layers", () => {
    for (const feature of ["clients", "calendar", "billing", "accounting", "purchases", "messages", "partnerConnections", "connectors", "imports", "groups"]) assert.match(app, new RegExp(`requireOrganizationFeature\\("${feature}"\\)`));
    assert.match(navigation, /\[ROUTES\.clients\]: "clients"/);
    assert.match(navigation, /\[ROUTES\.calendar\]: "calendar"/);
    assert.match(navigation, /\[ROUTES\.purchases\]: "purchases"/);
    assert.match(app, /app\.use\("\/api\/billing\/document-templates\/report", requireAuthentication, requireOrganizationFeature\("technicalReports"\)\)/);
    assert.match(app, /app\.use\("\/api\/calendar\/events\/:eventId\/quitus", requireAuthentication, requireOrganizationFeature\("quitus"\)\)/);
    assert.match(app, /app\.use\("\/api\/billing\/document-templates\/quitus", requireAuthentication, requireOrganizationFeature\("quitus"\)\)/);
    assert.match(app, /app\.use\("\/api\/document-templates\/quitus", requireAuthentication, requireOrganizationFeature\("quitus"\)\)/);
    assert.match(app, /app\.use\("\/api\/document-templates\/report", requireAuthentication, requireOrganizationFeature\("technicalReports"\)\)/);
    assert.match(app, /app\.use\("\/api\/purchases", requireAuthentication, requireOrganizationFeature\("purchases"\)\)/);
    assert.match(billing, /isAccountant\(\) \|\| !canAccessTechnicalReports\(\)/);
    assert.match(billing, /canAccessQuitus\(\) && usesExternalDocumentTemplate\("quitus"\)/);
    assert.match(billing, /if \(canAccessQuitus\(\)\) renderAdditionalDocumentTemplateSettings\(panel, profile, "quitus"\)/);
    assert.match(billing, /data-billing-action="open-purchases"/);
    assert.match(calendar, /canAccessTechnicalReports\(\) \? `<section class="calendar-billing-actions report-entry-point">/);
    assert.match(navigation, /isTechnician\(\) && organizationFeatureEnabled\("technicalReports"\)/);
    assert.match(auth, /memberSeatFamily/);
    assert.match(auth, /La limite de postes mobiles/);
    assert.match(auth, /mobileAdministratorSeatError\(getAccountOwnerId\(request\), deviceId\)/);
    assert.match(auth, /mobileAdministratorSeatError\(user\.account_owner_id \|\| user\.id, authDevice\?\.id \|\| device\.id\)/);
    assert.match(auth, /COUNT\(DISTINCT admin_mobile\.id\) FILTER \(WHERE admin_mobile\.status='approved'\)/);
    assert.match(navigation, /Consomme un poste mobile/);
    assert.match(auth, /'admin','pc_standard','accountant'/);
    assert.match(auth, /'mobile_admin','team_lead','technician'/);
    assert.match(auth, /subscriptionRoleAccessMessage\(organization\.subscriptionTier, role\)/);
    assert.match(auth, /const targetUserId = action\.endsWith\("_deleted"\) \? null/);
    assert.match(auth, /isRoleAllowedForSubscription\(organization\.subscriptionTier, user\.role\)/);
    assert.match(auth, /subscriptionRoleAccessMessage\(organization\.subscriptionTier, user\.role\)/);
    assert.match(partnerConnections, /isFeatureEnabled\(await getOrganization\(ownerId\), "partnerConnections"\)/);
    assert.match(partnerDialogue, /isFeatureEnabled\(await getOrganization\(ownerId\), "partnerMissions"\)/);
    const companyProfileSync = creatorServer.slice(creatorServer.indexOf("async function synchronizeCompanyProfile"), creatorServer.indexOf("function cleanList"));
    assert.doesNotMatch(companyProfileSync, /DO UPDATE SET is_listed=/);
    assert.doesNotMatch(companyProfileSync, /DO UPDATE SET[^`]*accepts_partner_missions=/);
    assert.doesNotMatch(companyProfileSync, /DO UPDATE SET[^`]*availability_status=/);
    assert.match(creatorServer, /Les interfaces Partenaire et Groupe nécessitent l’abonnement Pro/);
    assert.doesNotMatch(creatorServer, /Désactivez les comptes Technicien et Chef d’équipe avant de passer/);
    assert.match(creatorServer, /subscriptionRoleAccessMessage\(owners\[0\]\.subscriptionTier, role\)/);
    assert.match(partnerConnections, /owner\.subscription_tier='pro'/);
    assert.match(creatorClient, /option\.disabled = !isPro/);
});
