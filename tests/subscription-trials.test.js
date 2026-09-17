import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { activateSubscriptionTrialInTransaction, convertTrialToPaidSubscription, nextTrialEnd, SUBSCRIPTION_TRIAL_DAYS, trialDaysRemaining } from "../server/subscription-trials.js";

const schema = readFileSync(new URL("../database/schema.sql", import.meta.url), "utf8");
const migration = readFileSync(new URL("../database/migrations/0019_subscription_trials.sql", import.meta.url), "utf8");
const database = readFileSync(new URL("../server/database.js", import.meta.url), "utf8");
const trials = readFileSync(new URL("../server/subscription-trials.js", import.meta.url), "utf8");
const creatorServer = readFileSync(new URL("../server/creator.js", import.meta.url), "utf8");
const invoicing = readFileSync(new URL("../server/invoicing.js", import.meta.url), "utf8");
const auth = readFileSync(new URL("../server/auth.js", import.meta.url), "utf8");
const creatorClient = readFileSync(new URL("../js/creator.js", import.meta.url), "utf8");
const navigation = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
const documentation = readFileSync(new URL("../docs/SUBSCRIPTION_OFFERS.md", import.meta.url), "utf8");

test("trial windows last 15 days and active renewals extend the existing end", () => {
    assert.equal(SUBSCRIPTION_TRIAL_DAYS, 15);
    const now = new Date("2026-01-01T10:00:00.000Z");
    assert.equal(nextTrialEnd(null, now).toISOString(), "2026-01-16T10:00:00.000Z");
    assert.equal(nextTrialEnd("2026-01-10T10:00:00.000Z", now).toISOString(), "2026-01-25T10:00:00.000Z");
    assert.equal(nextTrialEnd("2025-12-31T10:00:00.000Z", now).toISOString(), "2026-01-16T10:00:00.000Z");
    assert.equal(trialDaysRemaining("2026-01-01T10:00:01.000Z", now), 1);
    assert.equal(trialDaysRemaining("2026-01-16T10:00:00.000Z", now), 15);
    assert.equal(trialDaysRemaining("2025-12-31T10:00:00.000Z", now), 0);
});

test("trial state and its audit are durable in every database setup path", () => {
    for (const source of [schema, migration, database]) {
        assert.match(source, /trial_started_at TIMESTAMPTZ/);
        assert.match(source, /trial_ends_at TIMESTAMPTZ/);
        assert.match(source, /trial_renewal_count INTEGER NOT NULL DEFAULT 0/);
        assert.match(source, /CREATE TABLE IF NOT EXISTS depannhome_subscription_trial_audit/);
        assert.match(source, /'activated','renewed','expired','ended','converted'/);
    }
});

test("Creator controls trials through a dedicated audited no-billing action", () => {
    assert.match(creatorServer, /app\.post\("\/api\/creator\/accounts\/:accountId\/trial"/);
    assert.match(creatorServer, /activateOrRenewSubscriptionTrial\(accountId, request\.user\.sub\)/);
    assert.match(creatorServer, /Utilisez le bouton dédié pour démarrer un essai de 15 jours/);
    assert.match(trials, /subscription_status='trial',is_active=TRUE/);
    assert.match(trials, /account_owner_id=\$1 AND status IN \('pending','failed'\)/);
    assert.match(trials, /status='cancelled'/);
    assert.match(trials, /depannhome_subscription_trial_audit/);
    assert.match(creatorServer, /ownerBefore\.subscriptionStatus === "trial" \|\| account\.subscriptionStatus === "trial" \? null : await prepareSubscriptionProration/);
    assert.match(creatorClient, /id="creatorStartOrRenewTrial"/);
    assert.match(creatorClient, /Renouveler de 15 jours/);
    assert.doesNotMatch(creatorClient, /\["active", "trial", "past_due"\]\.includes\(account\.subscriptionStatus\)/);
});

test("a company can be created directly in trial inside the existing transaction", async () => {
    const queries = [];
    const connection = {
        async query(sql, parameters = []) {
            queries.push({ sql, parameters });
            if (/SELECT id,username,is_archived/.test(sql)) return { rows: [{ id: 84, is_archived: false, subscription_plan: "paid", subscription_status: "active", trial_started_at: null, trial_ends_at: null, trial_renewal_count: 0 }] };
            if (/UPDATE depannhome_users/.test(sql)) return { rows: [{ trialStartedAt: "2026-09-17T00:00:00.000Z", trialEndsAt: "2026-10-02T00:00:00.000Z", trialRenewalCount: 0, subscriptionStatus: "trial", isActive: true }] };
            if (/UPDATE depannhome_subscription_invoices/.test(sql)) return { rows: [], rowCount: 0 };
            return { rows: [], rowCount: 0 };
        }
    };

    const trial = await activateSubscriptionTrialInTransaction(connection, 84, 1);

    assert.equal(trial.subscriptionStatus, "trial");
    assert.equal(trial.action, "activated");
    assert.ok(queries.some(query => /subscription_status='trial',is_active=TRUE/.test(query.sql)));
    assert.ok(queries.some(query => /depannhome_subscription_trial_audit/.test(query.sql)));
    assert.equal(queries.some(query => query.sql === "BEGIN" || query.sql === "COMMIT"), false);
    const creation = creatorServer.slice(creatorServer.indexOf('app.post("/api/creator/accounts"'), creatorServer.indexOf('app.patch("/api/creator/accounts/:accountId"'));
    assert.match(creation, /activateSubscriptionTrialInTransaction\(connection, id, request\.user\.sub\)/);
    assert.ok(creation.indexOf("activateSubscriptionTrialInTransaction") < creation.indexOf('connection.query("COMMIT")'));
    assert.match(creatorClient, /name="startWithTrial"/);
    assert.match(creatorClient, /Aucune facture d’abonnement ne sera créée ou envoyée pendant ces 15 jours/);
    assert.match(creatorClient, /L’essai de 15 jours est actif, sans facturation pendant cette période/);
});

test("expired trials suspend access without automatically starting paid billing", () => {
    const expirationImplementation = trials.slice(trials.indexOf("export async function expireSubscriptionTrials"), trials.indexOf("export async function convertTrialToPaidSubscription"));
    assert.match(expirationImplementation, /subscription_status='suspended',is_active=FALSE/);
    assert.match(expirationImplementation, /subscription_status='trial'/);
    assert.match(expirationImplementation, /trial_ends_at<=NOW\(\)/);
    assert.match(invoicing, /const expiredTrialAccountIds = await expireSubscriptionTrials\(database\)/);
    assert.match(auth, /expireSubscriptionTrials\(getPool\(\), user\.account_owner_id\)/);
    assert.match(invoicing, /owner\.subscription_status = 'active'/);
    assert.doesNotMatch(expirationImplementation, /subscription_status='active'/);
});

test("valid credentials receive an explicit expired-trial message", () => {
    const passwordCheck = auth.indexOf("const passwordMatches = user && await bcrypt.compare");
    const expiredMessage = auth.indexOf("Votre période d’essai de 15 jours est terminée");
    assert.ok(passwordCheck >= 0 && expiredMessage > passwordCheck);
    assert.match(auth, /subscription_trial_expired/);
    assert.match(auth, /sans démarrage automatique d’un abonnement payant/);
    assert.match(database, /owner\.subscription_status, owner\.trial_ends_at/);
});

test("Creator can convert a completed trial into paid billing starting today", async () => {
    const queries = [];
    const databaseMock = {
        async query(sql, parameters = []) {
            queries.push({ sql, parameters });
            if (/SELECT id,is_archived/.test(sql)) return { rows: [{ id: 42, is_archived: false, subscription_plan: "paid", subscription_status: "suspended", trial_started_at: new Date("2026-01-01T00:00:00Z"), trial_ends_at: new Date("2026-01-16T00:00:00Z"), trial_renewal_count: 1 }] };
            if (/UPDATE depannhome_users/.test(sql)) return { rows: [{ subscriptionStatus: "active", isActive: true, subscriptionRenewalDate: "2026-09-16" }] };
            return { rows: [], rowCount: 0 };
        }
    };
    const result = await convertTrialToPaidSubscription(42, 7, databaseMock);
    assert.deepEqual(result, { subscriptionStatus: "active", isActive: true, subscriptionRenewalDate: "2026-09-16" });
    assert.ok(queries.some(query => /subscription_status='active',is_active=TRUE,subscription_renewal_date=CURRENT_DATE/.test(query.sql)));
    assert.ok(queries.some(query => /'converted'/.test(query.sql)));
    assert.match(creatorServer, /app\.post\("\/api\/creator\/accounts\/:accountId\/paid-subscription"/);
    assert.match(creatorClient, /id="creatorConvertTrialToPaid"/);
    assert.match(creatorClient, /Démarrer l’abonnement payant/);
    assert.match(creatorClient, /Aucun jour d’essai ne sera facturé rétroactivement/);
    assert.match(invoicing, /void check\("startup"\)/);
    assert.match(invoicing, /SUBSCRIPTION_INVOICING_HOUR/);
});

test("companies see the trial countdown and no-billing guarantee", () => {
    assert.match(creatorServer, /trial_ends_at AS "trialEndsAt"/);
    assert.match(navigation, /Essai actif/);
    assert.match(navigation, /Aucune facture d’abonnement n’est créée ni envoyée pendant cette période/);
    assert.match(navigation, /À la fin de l’essai, l’accès est suspendu sans conversion automatique/);
    assert.match(navigation, /Contactez le Support Depann’Home Pro/);
    assert.match(documentation, /Essai de 15 jours/);
    assert.match(documentation, /ne bascule jamais automatiquement vers une facturation payante/);
    assert.match(documentation, /facturation des abonnements est déjà automatique côté serveur/);
});
