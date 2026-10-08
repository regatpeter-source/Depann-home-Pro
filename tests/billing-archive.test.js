import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { buildBillingLegalArchive } from "../server/billing.js";

const profile = {
    ownerId: 1, companyName: "Entreprise Test", legalForm: "SAS", address: "1 rue du Test", postalCode: "75001", city: "Paris", country: "France",
    registrationNumber: "12345678900012", siren: "123456789", taxNumber: "FR00123456789", vatRegime: "standard", bankIban: "FR761234",
    paymentTerms: "Paiement à réception", earlyPaymentDiscountTerms: "Aucun escompte pour paiement anticipé.",
    latePaymentPenaltyTerms: "Pénalités de retard exigibles.", recoveryIndemnityCents: 4000, quoteTemplateConfig: {}
};

test("une archive légale d’avoir contient un PDF, un UBL CreditNote et leurs empreintes", async () => {
    const document = {
        documentType: "credit", documentNumber: "AVO-2026-000001", sourceInvoiceId: 7, sourceInvoiceNumber: "FAC-2026-000001",
        sourceInvoiceDate: "2026-01-10", clientId: "client-1", customerType: "Professionnel", customerName: "Client Test",
        customerAddress: "2 rue du Client, 69001 Lyon", issueDate: "2026-01-15", vatRegime: "standard", issuerTaxNumber: profile.taxNumber,
        legalData: { billingAddress: "2 rue du Client, 69001 Lyon", customerSiren: "987654321", serviceDate: "2026-01-10", operationCategory: "services" },
        lines: [{ description: "Avoir sur facture", quantity: 1, unit: "forfait", unitPrice: -100, vatRate: 20 }], notes: "Correction", financialData: {}
    };
    const archive = await buildBillingLegalArchive(document, { profile });
    assert.equal(archive.structuredMimeType, "application/xml; charset=utf-8");
    assert.match(archive.structuredData.toString("utf8"), /<CreditNote /);
    assert.equal(archive.pdfData.subarray(0, 4).toString("ascii"), "%PDF");
    assert.equal(archive.structuredSha256, crypto.createHash("sha256").update(archive.structuredData).digest("hex"));
    assert.equal(archive.pdfSha256, crypto.createHash("sha256").update(archive.pdfData).digest("hex"));
    assert.equal(archive.legalSnapshot.document.sourceInvoiceNumber, "FAC-2026-000001");
});

test("une date de facture native PostgreSQL reste imprimable dans l’avoir", async () => {
    const document = {
        documentType: "credit", documentNumber: "AVO-2026-000002", sourceInvoiceId: 8, sourceInvoiceNumber: "FAC-2026-000002",
        sourceInvoiceDate: new Date("2026-01-10T00:00:00.000Z"), clientId: "client-1", customerType: "Professionnel", customerName: "Client Test",
        customerAddress: "2 rue du Client, 69001 Lyon", issueDate: "2026-01-15", vatRegime: "standard",
        issuerTaxNumber: profile.taxNumber, legalData: { billingAddress: "2 rue du Client, 69001 Lyon" },
        lines: [{ description: "Avoir sur facture", quantity: 1, unit: "forfait", unitPrice: -10, vatRate: 20 }], notes: "Correction", financialData: {}
    };
    const archive = await buildBillingLegalArchive(document, { profile });
    assert.equal(archive.pdfData.subarray(0, 4).toString("ascii"), "%PDF");
});