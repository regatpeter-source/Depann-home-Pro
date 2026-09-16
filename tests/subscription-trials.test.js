import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { nextTrialEnd, SUBSCRIPTION_TRIAL_DAYS, trialDaysRemaining } from "../server/subscription-trials.js";

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

test("expired trials suspend access without automatically starting paid billing", () => {
    assert.match(trials, /subscription_status='suspended',is_active=FALSE/);
    assert.match(trials, /subscription_status='trial'/);
    assert.match(trials, /trial_ends_at<=NOW\(\)/);
    assert.match(invoicing, /const expiredTrialAccountIds = await expireSubscriptionTrials\(database\)/);
    assert.match(auth, /expireSubscriptionTrials\(getPool\(\), user\.account_owner_id\)/);
    assert.match(invoicing, /owner\.subscription_status = 'active'/);
    assert.doesNotMatch(trials, /subscription_status='active'/);
});

test("companies see the trial countdown and no-billing guarantee", () => {
    assert.match(creatorServer, /trial_ends_at AS "trialEndsAt"/);
    assert.match(navigation, /Essai actif/);
    assert.match(navigation, /Aucune facture d’abonnement n’est créée ni envoyée pendant cette période/);
    assert.match(navigation, /À la fin de l’essai, l’accès est suspendu sans conversion automatique/);
    assert.match(navigation, /Contactez le Support Depann’Home Pro/);
    assert.match(documentation, /Essai de 15 jours/);
    assert.match(documentation, /ne bascule jamais automatiquement vers une facturation payante/);
});
