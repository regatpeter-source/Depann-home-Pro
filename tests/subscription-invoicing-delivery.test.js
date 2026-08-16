import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const invoicingSource = readFileSync(new URL("../server/invoicing.js", import.meta.url), "utf8");
const creatorSource = readFileSync(new URL("../js/creator.js", import.meta.url), "utf8");
const emailSource = readFileSync(new URL("../server/email.js", import.meta.url), "utf8");

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
