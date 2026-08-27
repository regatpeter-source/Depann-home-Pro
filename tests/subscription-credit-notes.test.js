import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calculateSubscriptionCreditTotals, subscriptionCreditRefundDue, subscriptionInvoiceBalances } from "../server/invoicing.js";
import { createBillingPdf } from "../server/billing.js";

const invoicingSource = readFileSync(new URL("../server/invoicing.js", import.meta.url), "utf8");
const schemaSource = readFileSync(new URL("../database/schema.sql", import.meta.url), "utf8");
const creatorSource = readFileSync(new URL("../js/creator.js", import.meta.url), "utf8");
const creatorServerSource = readFileSync(new URL("../server/creator.js", import.meta.url), "utf8");
const navigationSource = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
const billingSource = readFileSync(new URL("../server/billing.js", import.meta.url), "utf8");

test("les montants d’avoir sont ventilés en centimes sans dérive", () => {
    assert.deepEqual(calculateSubscriptionCreditTotals(7500, 20), { amountCents: 7500, taxBaseCents: 6250, vatAmountCents: 1250 });
    assert.deepEqual(calculateSubscriptionCreditTotals(1000, 5.5), { amountCents: 1000, taxBaseCents: 948, vatAmountCents: 52 });
    assert.throws(() => calculateSubscriptionCreditTotals(0, 20), TypeError);
});

test("les soldes distinguent encaissement, reste dû et remboursement", () => {
    assert.deepEqual(subscriptionInvoiceBalances(7500, 2000, 0), { outstandingAmountCents: 5500, refundDueCents: 0 });
    assert.deepEqual(subscriptionInvoiceBalances(7500, 2000, 7500), { outstandingAmountCents: 0, refundDueCents: 2000 });
    assert.deepEqual(subscriptionInvoiceBalances(7500, 7500, 0), { outstandingAmountCents: 0, refundDueCents: 0 });
});

test("un avoir postérieur au paiement calcule exactement le remboursement créé", () => {
    assert.equal(subscriptionCreditRefundDue(7500, 0, 7500, 3200), 3200);
    assert.equal(subscriptionCreditRefundDue(7500, 0, 0, 3200), 0);
    assert.equal(subscriptionCreditRefundDue(7500, 3200, 4300, 1000), 1000);
    assert.match(invoicingSource, /const refundDueCents = subscriptionCreditRefundDue/);
    assert.match(creatorSource, /Remboursement à effectuer :/);
    assert.match(creatorSource, /cet avoir a été imputé avant l’encaissement du solde/);
});

test("la création verrouille la facture et plafonne le cumul des avoirs", () => {
    assert.match(invoicingSource, /subscription-invoices\/:invoiceId\/credit-notes", requireCreator/);
    assert.match(invoicingSource, /FROM depannhome_subscription_invoices WHERE id=\$1 FOR UPDATE/);
    assert.match(invoicingSource, /COALESCE\(SUM\(amount_cents\),0\)::integer AS total FROM depannhome_subscription_credit_notes/);
    assert.match(invoicingSource, /amountCents > creditableAmountCents/);
    assert.match(invoicingSource, /Cette facture est déjà intégralement créditée/);
    assert.match(invoicingSource, /invoice\.status !== "sent"/);
});

test("les avoirs ont une séquence transactionnelle et des PDF légalement figés", () => {
    for (const source of [schemaSource, invoicingSource]) {
        assert.match(source, /depannhome_subscription_credit_note_sequences/);
        assert.match(source, /AVO-DHP-/);
        assert.match(source, /pdf_data BYTEA NOT NULL/);
        assert.match(source, /pdf_sha256 CHAR\(64\) NOT NULL/);
        assert.match(source, /depannhome_subscription_credit_note_immutable/);
        assert.match(source, /Les données légales d’un avoir émis sont immuables/);
        assert.match(source, /Un avoir émis ne peut pas être supprimé/);
    }
    assert.match(invoicingSource, /createHash\("sha256"\)\.update\(pdf\)\.digest\("hex"\)/);
});

test("l’envoi et le remboursement disposent d’états et d’un audit séparés", () => {
    assert.match(invoicingSource, /credit_note_delivery_started/);
    assert.match(invoicingSource, /credit_note_sent/);
    assert.match(invoicingSource, /credit_note_delivery_failed/);
    assert.match(invoicingSource, /credit_note_refund_acknowledged/);
    assert.match(invoicingSource, /refund_status='refunded'/);
    assert.match(creatorSource, /Remboursement à effectuer/);
    assert.match(creatorSource, /Renvoyer l’avoir/);
});

test("la console distingue le suivi électronique des abonnements du catalogue technique", () => {
    assert.match(creatorServerSource, /app\.get\("\/api\/creator\/e-invoicing-monitoring", requireCreator/);
    assert.match(creatorServerSource, /subscriptionChannel: "email_pdf"/);
    assert.match(creatorServerSource, /elles ne sont pas encore transmises par une plateforme agréée/);
    assert.match(creatorSource, /id="creatorElectronicInvoicingMonitoring"/);
    assert.match(creatorSource, /Transmissions électroniques abonnements/);
    assert.match(creatorSource, /E-mail seulement/);
});

test("un paiement après avoir porte uniquement sur le net restant", () => {
    assert.match(invoicingSource, /paidAmountCents = Math\.max\(0, Number\(invoice\.netAmountCents\) - Number\(creditResult\.rows\[0\]\.total\)\)/);
    assert.match(invoicingSource, /paid_amount_cents=\$2/);
    assert.match(invoicingSource, /intégralement créditée et ne peut plus être marquée comme réglée/);
    assert.match(creatorSource, /Montant attendu/);
});

test("l’entreprise voit le solde de sa facture après déduction des avoirs", () => {
    assert.match(creatorServerSource, /COALESCE\(credits\.total,0\)::integer AS "creditedAmountCents"/);
    assert.match(creatorServerSource, /COALESCE\(credits\.pending_refund,0\)::integer AS "pendingRefundCents"/);
    assert.match(creatorServerSource, /GREATEST\(invoice\.net_amount_cents-COALESCE\(credits\.total,0\)-invoice\.paid_amount_cents,0\)::integer AS "outstandingAmountCents"/);
    assert.match(navigationSource, /outstandingAmountCents/);
    assert.match(navigationSource, /restant à payer · avoir de/);
    assert.match(navigationSource, /facture couverte par un avoir de/);
    assert.match(navigationSource, /remboursement de.*à recevoir/);
    assert.doesNotMatch(navigationSource, /TTC après remise éventuelle/);
});

test("le PDF d’avoir est généré avec son identité et ses totaux exacts", async () => {
    assert.match(billingSource, /isCredit \? "AVOIR"/);
    assert.match(billingSource, /À déduire \/ rembourser/);
    assert.match(billingSource, /Avoir relatif à la facture/);
    const pdf = await createBillingPdf({
        documentType: "credit", documentNumber: "AVO-DHP-2026-000001", sourceInvoiceNumber: "DHP-2026-000001",
        customerName: "Entreprise Test", customerAddress: "1 rue du Test", sourceInvoiceDate: "2026-02-01", issueDate: "2026-03-01", reason: "Correction du forfait facturé",
        vatRegime: "standard", issuerTaxNumber: "FR00000000000", lines: [{ description: "Avoir sur abonnement", quantity: 1, unit: "avoir", unitPrice: 62.5, vatRate: 20 }],
        financialData: {}, exactTotals: { amountCents: 7500, taxBaseCents: 6250, vatAmountCents: 1250 }
    }, { companyName: "Depann'Home Pro", address: "1 rue Plateforme", postalCode: "75000", city: "Paris", registrationNumber: "00000000000000", vatRegime: "standard", paymentTerms: "Virement" });
    assert.ok(Buffer.isBuffer(pdf));
    assert.ok(pdf.length > 1000);
});
