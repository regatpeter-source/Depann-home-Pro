import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calculateSubscriptionProration } from "../server/invoicing.js";

const invoicingSource = readFileSync(new URL("../server/invoicing.js", import.meta.url), "utf8");
const creatorSource = readFileSync(new URL("../server/creator.js", import.meta.url), "utf8");
const creatorClientSource = readFileSync(new URL("../js/creator.js", import.meta.url), "utf8");
const schemaSource = readFileSync(new URL("../database/schema.sql", import.meta.url), "utf8");

test("le prorata utilise les jours calendaires et arrondit au centime", () => {
    assert.equal(calculateSubscriptionProration(7500, 4300, 31, 20), -2065);
    assert.equal(calculateSubscriptionProration(4300, 7500, 31, 20), 2065);
    assert.equal(calculateSubscriptionProration(2500, 4300, 28, 14), 900);
    assert.equal(calculateSubscriptionProration(2500, 4300, 29, 15), 931);
    assert.equal(calculateSubscriptionProration(2500, 4300, 30, 0), 0);
    assert.equal(calculateSubscriptionProration(100, 99, 2, 1), -1);
    assert.equal(calculateSubscriptionProration(99, 100, 2, 1), 1);
    assert.throws(() => calculateSubscriptionProration(2500, 4300, 30, 31), TypeError);
});

test("une modification effective du compte prépare puis envoie le prorata", () => {
    const accountPatch = creatorSource.slice(creatorSource.indexOf('app.patch("/api/creator/accounts/:accountId"'), creatorSource.indexOf('app.patch("/api/creator/accounts/:accountId/activation"'));
    assert.match(accountPatch, /FOR UPDATE/);
    assert.match(accountPatch, /prepareSubscriptionProration\(connection/);
    assert.match(accountPatch, /deliverSubscriptionProration\(proration/);
    const requestRoutes = creatorSource.slice(creatorSource.indexOf('app.post("/api/subscription-change-requests"'), creatorSource.indexOf('app.get("/api/creator/platform-announcement/current"'));
    assert.doesNotMatch(requestRoutes, /prepareSubscriptionProration/);
});

test("la baisse crée un avoir et la hausse une facture complémentaire", () => {
    assert.match(invoicingSource, /if \(prorataDeltaCents < 0\)/);
    assert.match(invoicingSource, /subscription_proration_credit_created/);
    assert.match(invoicingSource, /'proration_debit'/);
    assert.match(invoicingSource, /subscription_proration_invoice_created/);
    assert.match(invoicingSource, /Prorata du/);
    assert.match(creatorClientSource, /Complément prorata/);
});

test("les proratas sont idempotents et traçables", () => {
    for (const source of [schemaSource, invoicingSource]) {
        assert.match(source, /depannhome_subscription_proration_events/);
        assert.match(source, /change_fingerprint CHAR\(64\) NOT NULL UNIQUE/);
        assert.match(source, /generated_invoice_id/);
        assert.match(source, /generated_credit_note_id/);
    }
    assert.match(invoicingSource, /ON CONFLICT\(change_fingerprint\) DO NOTHING/);
});

test("une facture complémentaire ne déplace jamais l’échéance du cycle", () => {
    assert.match(invoicingSource, /invoice\.invoiceKind === "cycle"/);
    assert.match(invoicingSource, /invoice\.invoice_kind='cycle'/);
    assert.match(invoicingSource, /status<>'cancelled' AND invoice_kind='cycle'/);
    assert.match(invoicingSource, /deliverPendingInvoices\(proration\.invoiceId\)/);
    assert.match(invoicingSource, /invoice\.invoice_kind='proration_debit' OR/);
});

test("le cycle est déduit de la facture envoyée même sans date de renouvellement", () => {
    assert.match(invoicingSource, /TO_CHAR\(billing_period,'YYYY-MM-DD'\) AS "billingPeriod"/);
    assert.match(invoicingSource, /CURRENT_DATE<\(billing_period\+INTERVAL '1 month'\)::date/);
    assert.match(invoicingSource, /source\.billingPeriod/);
    assert.doesNotMatch(invoicingSource, /if \(!ownerBefore\?\.id \|\| !renewalValue\) return null/);
});
