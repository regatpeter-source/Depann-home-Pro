import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSubscriptionInvoiceSnapshot, subscriptionInvoiceMatchesCurrentSubscription } from "../server/invoicing.js";

const invoicingSource = readFileSync(new URL("../server/invoicing.js", import.meta.url), "utf8");
const creatorServerSource = readFileSync(new URL("../server/creator.js", import.meta.url), "utf8");
const creatorSource = readFileSync(new URL("../js/creator.js", import.meta.url), "utf8");
const emailSource = readFileSync(new URL("../server/email.js", import.meta.url), "utf8");
const databaseSource = readFileSync(new URL("../server/database.js", import.meta.url), "utf8");
const billingSource = readFileSync(new URL("../server/billing.js", import.meta.url), "utf8");
const schemaSource = readFileSync(new URL("../database/schema.sql", import.meta.url), "utf8");

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

test("la réception du paiement est historisée séparément de l’envoi initial", () => {
    for (const source of [schemaSource, invoicingSource]) {
        assert.match(source, /payment_status VARCHAR\(20\) NOT NULL DEFAULT 'unpaid'/);
        assert.match(source, /paid_date DATE/);
        assert.match(source, /paid_by BIGINT REFERENCES depannhome_users\(id\) ON DELETE SET NULL/);
        assert.match(source, /paid_amount_cents INTEGER NOT NULL DEFAULT 0/);
        assert.match(source, /payment_reference VARCHAR\(160\)/);
        assert.match(source, /receipt_delivery_status VARCHAR\(20\) NOT NULL DEFAULT 'not_sent'/);
        assert.match(source, /depannhome_subscription_invoice_audit/);
    }
});

test("seul le Créateur peut accuser réception une fois sur une facture envoyée", () => {
    assert.match(invoicingSource, /app\.post\("\/api\/creator\/subscription-invoices\/:invoiceId\/payment", requireCreator/);
    assert.match(invoicingSource, /SELECT id,account_owner_id[\s\S]*FROM depannhome_subscription_invoices WHERE id=\$1 FOR UPDATE/);
    assert.match(invoicingSource, /if \(invoice\.status !== "sent"\)/);
    assert.match(invoicingSource, /if \(invoice\.paymentStatus === "paid"\)/);
    assert.match(invoicingSource, /if \(paidDate < invoice\.issueDate\)/);
    assert.match(invoicingSource, /dateString\(parsed\) !== date/);
    assert.match(invoicingSource, /payment_status='paid',paid_amount_cents=\$2,paid_date=\$3::date,paid_at=NOW\(\),paid_by=\$4/);
    assert.match(invoicingSource, /'payment_acknowledged'/);
});

test("la facture acquittée porte la date de règlement et son envoi peut être relancé", () => {
    assert.match(invoicingSource, /app\.post\("\/api\/creator\/subscription-invoices\/:invoiceId\/payment-receipt\/send", requireCreator/);
    assert.match(invoicingSource, /receipt_delivery_status IN \('pending','failed'\)/);
    assert.match(invoicingSource, /Facture d’abonnement acquittée/);
    assert.match(invoicingSource, /paidDate: invoice\.paidDate \? dateString\(invoice\.paidDate\) : ""/);
    assert.match(billingSource, /RÉGLÉE LE \$\{formatDate\(document\.paidDate\)\.toUpperCase\(\)\}/);
    assert.match(creatorSource, /Accuser réception du paiement/);
    assert.match(creatorSource, /Renvoyer la facture acquittée/);
    assert.match(creatorSource, /data-subscription-payment-form/);
});

test("les nouvelles factures utilisent une série annuelle continue et transactionnelle", () => {
    for (const source of [schemaSource, invoicingSource]) {
        assert.match(source, /depannhome_subscription_invoice_sequences/);
        assert.match(source, /series_year INTEGER PRIMARY KEY/);
        assert.match(source, /last_number BIGINT NOT NULL DEFAULT 0/);
    }
    assert.match(invoicingSource, /INSERT INTO depannhome_subscription_invoice_sequences \(series_year,last_number\) VALUES \(\$1,1\)/);
    assert.match(invoicingSource, /last_number=depannhome_subscription_invoice_sequences\.last_number\+1/);
    assert.match(invoicingSource, /regexp_matches\(invoice_number,'\^DHP-\(\[0-9\]\{4\}\)-\(\[0-9\]\{6\}\)\$'\)/);
    assert.doesNotMatch(invoicingSource, /regexp_match\(invoice_number/);
    assert.match(invoicingSource, /DHP-\$\{seriesYear\}-\$\{String\(sequences\[0\]\.lastNumber\)\.padStart\(6, "0"\)\}/);
    assert.match(invoicingSource, /SELECT TO_CHAR\(CURRENT_DATE,'YYYY-MM-DD'\) AS "issueDate"/);
    assert.doesNotMatch(invoicingSource, /DHP-\$\{billingPeriod\.slice/);
});

test("la référence demandée dans la Console est explicitement celle du paiement", () => {
    assert.match(creatorSource, /Référence du paiement \(facultative\)/);
    assert.match(creatorSource, /N° de virement, transaction ou chèque/);
});

test("les portails Partenaire gratuits sont exclus de toute facturation d’abonnement", () => {
    assert.match(invoicingSource, /LEFT JOIN depannhome_organizations organization ON organization\.account_owner_id = owner\.id/);
    assert.match(invoicingSource, /COALESCE\(organization\.interface_type, 'standard'\) <> 'partner'/);
    assert.match(invoicingSource, /invoice_owner\.subscription_plan='paid'/);
    assert.match(invoicingSource, /COALESCE\(invoice_organization\.interface_type,'standard'\)<>'partner'/);
});

test("une facture non envoyée devenue obsolète est annulée avant toute livraison", () => {
    const current = { subscriptionPlan: "paid", interfaceType: "standard", subscriptionTier: "basic_plus", subscriptionLabel: "Basic+", monthlyPriceCents: 4300, maxPcUsers: 1, maxTechnicians: 1, discountMode: "fixed", discountValue: 0 };
    assert.equal(subscriptionInvoiceMatchesCurrentSubscription({ subscriptionLabel: "Pro Standard", baseAmountCents: 7500, amountCents: 7500, vatRate: 20 }, current), false);
    assert.equal(subscriptionInvoiceMatchesCurrentSubscription({ subscriptionLabel: "Basic+", baseAmountCents: 4300, amountCents: 4300, vatRate: 20 }, current), true);
    assert.equal(subscriptionInvoiceMatchesCurrentSubscription({ subscriptionLabel: "Basic+", baseAmountCents: 4300, amountCents: 4300, vatRate: 20 }, { ...current, interfaceType: "partner", subscriptionPlan: "free" }), false);
    assert.equal(subscriptionInvoiceMatchesCurrentSubscription({ subscriptionSnapshot: { netAmountCents: 4300, amountCents: 4300, maxTechnicians: 1, maxPcUsers: 1, subscriptionLabel: "Basic+", subscriptionTier: "basic_plus", interfaceType: "standard", subscriptionPlan: "paid", discountValue: 0, discountMode: "fixed", discountLabel: "" }, vatRate: 20 }, current), true);
    assert.match(invoicingSource, /status='cancelled',last_error='Annulée automatiquement : l’abonnement a changé avant l’envoi\.'/);
    assert.match(invoicingSource, /'superseded_before_sending'/);
    assert.match(invoicingSource, /WHERE status<>'cancelled'/);
    assert.match(schemaSource, /status IN \('pending','sending','sent','failed','cancelled'\)/);
    assert.match(creatorSource, /Facture historique : l’abonnement actuel est désormais de/);
    assert.match(creatorServerSource, /FROM depannhome_subscription_invoices invoice LEFT JOIN LATERAL/);
    assert.match(creatorServerSource, /WHERE invoice\.account_owner_id=\$1 AND invoice\.status<>'cancelled'/);
});
