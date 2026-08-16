import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSubscriptionInvoiceSnapshot } from "../server/invoicing.js";

const invoicingSource = readFileSync(new URL("../server/invoicing.js", import.meta.url), "utf8");
const creatorSource = readFileSync(new URL("../js/creator.js", import.meta.url), "utf8");
const emailSource = readFileSync(new URL("../server/email.js", import.meta.url), "utf8");
const databaseSource = readFileSync(new URL("../server/database.js", import.meta.url), "utf8");
const billingSource = readFileSync(new URL("../server/billing.js", import.meta.url), "utf8");

test("le verrou de facturation est détenu et libéré par la même connexion PostgreSQL", () => {
    assert.match(invoicingSource, /const lockConnection = await database\.connect\(\)/);
    assert.match(invoicingSource, /lockConnection\.query\("SELECT pg_try_advisory_lock\(842301\) AS acquired"\)/);
    assert.match(invoicingSource, /lockConnection\.query\("SELECT pg_advisory_unlock\(842301\)"\)/);
    assert.match(invoicingSource, /lockConnection\.release\(\)/);
    assert.doesNotMatch(invoicingSource, /database\.query\("SELECT pg_(?:try_)?advisory_(?:un)?lock\(842301\)/);
});

test("Render contrôle les factures au démarrage puis reprogramme chaque passage civil", () => {
    assert.match(invoicingSource, /void check\("startup"\)/);
    assert.match(invoicingSource, /await check\("scheduled"\); schedulerTimer = null; scheduleNext\(\)/);
    assert.doesNotMatch(invoicingSource, /setInterval\(check, 24 \* 60 \* 60 \* 1000\)/);
});

test("les envois interrompus sont récupérés et les entreprises archivées restent exclues", () => {
    assert.match(invoicingSource, /status='sending'.+INTERVAL '15 minutes'/);
    assert.match(invoicingSource, /owner\.is_archived = FALSE/);
});

test("la reprise des factures qualifie les colonnes communes de la jointure", () => {
    const deliveryQuery = invoicingSource.match(/const \{ rows: invoices \} = await database\.query\(`([\s\S]*?)`\);/)?.[1] || "";
    assert.match(deliveryQuery, /invoice\.subscription_label AS "subscriptionLabel"/);
    assert.doesNotMatch(deliveryQuery, /(?:SELECT|,)\s*subscription_label AS "subscriptionLabel"/);
});

test("la Console Créateur permet un traitement immédiat avec un délai SMTP adapté", () => {
    assert.match(invoicingSource, /post\("\/api\/creator\/subscription-invoices\/process"/);
    assert.match(creatorSource, /Créer et envoyer maintenant/);
    assert.match(creatorSource, /timeoutMs: 60_000/);
});

test("Brevo dispose de délais bornés et retourne l’identifiant SMTP", () => {
    assert.match(emailSource, /connectionTimeout: 15_000/);
    assert.match(emailSource, /socketTimeout: 30_000/);
    assert.match(emailSource, /return transporter\.sendMail/);
});

test("la facture détaille la formule et les postes PC et mobiles inclus", () => {
    const snapshot = buildSubscriptionInvoiceSnapshot({
        subscriptionLabel: "Pro Standard",
        monthlyPriceCents: 12000,
        maxPcUsers: 3,
        maxTechnicians: 15,
        discountLabel: "Offre d’essai",
        discountMode: "percentage",
        discountValue: 25
    }, 20);
    assert.deepEqual(snapshot.lines.map(line => [line.description, line.quantity, line.unitPrice]), [
        ["Pro Standard — abonnement mensuel", 1, 100],
        ["Postes PC inclus", 3, 0],
        ["Postes mobiles inclus", 15, 0]
    ]);
    assert.deepEqual(snapshot.financialData, { discountLabel: "Offre d’essai", discountMode: "percentage", discountAmount: 25 });
    assert.equal(snapshot.netAmountCents, 9000);
});

test("une remise fixe TTC est convertie en HT et soustraite du net à payer", () => {
    const snapshot = buildSubscriptionInvoiceSnapshot({ monthlyPriceCents: 10000, discountMode: "fixed", discountValue: 10 }, 20);
    assert.equal(snapshot.financialData.discountAmount, 8.33);
    assert.equal(snapshot.netAmountCents, 9000);
});

test("les paramètres commerciaux et l’instantané détaillé sont migrés en base", () => {
    assert.match(databaseSource, /subscription_discount_label VARCHAR\(160\)/);
    assert.match(databaseSource, /subscription_discount_mode VARCHAR\(20\)/);
    assert.match(invoicingSource, /net_amount_cents INTEGER/);
    assert.match(invoicingSource, /lines JSONB/);
    assert.match(invoicingSource, /financial_data JSONB/);
});

test("le PDF utilise le libellé personnalisé de la réduction", () => {
    assert.match(billingSource, /financialData\.discountLabel \|\| "Remise"/);
});
