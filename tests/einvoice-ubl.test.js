import test from "node:test";
import assert from "node:assert/strict";
import { generateUblInvoice } from "../server/einvoice-ubl.js";

const profile = {
    companyName: "Dépann & Fils <Pro>",
    siren: "123 456 789",
    registrationNumber: "12345678900012",
    taxNumber: "FR00123456789",
    address: "1 rue du Test",
    postalCode: "44000",
    city: "Nantes",
    paymentTerms: "Paiement à 30 jours",
    bankIban: "FR7612345678901234567890123",
    bankBic: "TESTFRPP"
};

const invoice = {
    documentType: "invoice",
    documentNumber: "FAC-2026-001",
    issueDate: "2026-08-22",
    issuedAt: "2026-08-22T10:30:00.000Z",
    dueDate: "2026-09-21",
    clientId: "client-acme",
    customerName: "ACME & Associés",
    customerAddress: "2 rue du Client, 75001 Paris",
    vatRegime: "standard",
    issuerTaxNumber: "FR00123456789",
    legalData: {
        customerSiren: "987654321",
        customerVatNumber: "FR00987654321",
        billingAddress: "2 rue du Client, 75001 Paris",
        deliveryAddress: "3 quai de Livraison, 75002 Paris",
        serviceDate: "2026-08-20",
        purchaseOrderReference: "BC-<&>-42",
        operationCategory: "mixed"
    },
    lines: [
        { description: "Pièce <A> & pose", quantity: 2, unit: "pièce", unitPrice: 50, vatRate: 20 },
        { description: "Diagnostic", quantity: 1, unit: "forfait", unitPrice: 25, vatRate: 10 }
    ],
    financialData: { discountMode: "fixed", discountAmount: 5, discountLabel: "Remise fidélité", depositAmount: 20, aids: [] }
};

test("UBL Invoice échappe le XML et expose les identifiants structurés", () => {
    const xml = generateUblInvoice(invoice, profile).toString("utf8");
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?><Invoice /);
    assert.match(xml, /<cbc:ID schemeID="0002">123456789<\/cbc:ID>/);
    assert.match(xml, /<cbc:CompanyID>FR00987654321<\/cbc:CompanyID>/);
    assert.match(xml, /ACME &amp; Associés/);
    assert.match(xml, /Pièce &lt;A&gt; &amp; pose/);
    assert.match(xml, /BC-&lt;&amp;&gt;-42/);
    assert.doesNotMatch(xml, /BC-<&>-42/);
});

test("UBL Invoice calcule des totaux déterministes en EUR", () => {
    const first = generateUblInvoice(invoice, profile);
    const second = generateUblInvoice(structuredClone(invoice), structuredClone(profile));
    const xml = first.toString("utf8");
    assert.deepEqual(first, second);
    assert.match(xml, /<cbc:LineExtensionAmount currencyID="EUR">125\.00<\/cbc:LineExtensionAmount>/);
    assert.match(xml, /<cbc:AllowanceTotalAmount currencyID="EUR">5\.00<\/cbc:AllowanceTotalAmount>/);
    assert.match(xml, /<cbc:TaxExclusiveAmount currencyID="EUR">120\.00<\/cbc:TaxExclusiveAmount>/);
    assert.match(xml, /<cbc:TaxAmount currencyID="EUR">21\.60<\/cbc:TaxAmount>/);
    assert.match(xml, /<cbc:TaxInclusiveAmount currencyID="EUR">141\.60<\/cbc:TaxInclusiveAmount>/);
    assert.match(xml, /<cbc:PrepaidAmount currencyID="EUR">20\.00<\/cbc:PrepaidAmount>/);
    assert.match(xml, /<cbc:PayableAmount currencyID="EUR">121\.60<\/cbc:PayableAmount>/);
});

test("UBL déduit et trace la franchise assurance comme montant prépayé", () => {
    const xml = generateUblInvoice({ ...invoice, financialData: { aids: [{ name: "Franchise client encaissée", amount: 75, calculationMode: "fixed", aidType: "insurance_deductible", sourceAppointmentId: 42, description: "Assurance Exemple · Sinistre SIN-9 · Intervention n°42" }] } }, profile).toString("utf8");
    assert.match(xml, /<cbc:PrepaidAmount currencyID="EUR">75\.00<\/cbc:PrepaidAmount>/);
    assert.match(xml, /<cbc:PayableAmount currencyID="EUR">72\.50<\/cbc:PayableAmount>/);
    assert.match(xml, /<cbc:ID>INTERVENTION-42<\/cbc:ID>/);
    assert.match(xml, /Franchise client encaissée — Assurance Exemple · Sinistre SIN-9 · Intervention n°42/);
});

test("UBL CreditNote utilise les balises d’avoir et des montants positifs", () => {
    const credit = { ...invoice, documentType: "credit", documentNumber: "AVO-2026-001", dueDate: "", lines: [{ description: "Avoir sur facture", quantity: 1, unit: "forfait", unitPrice: -50, vatRate: 20 }], financialData: {} };
    const xml = generateUblInvoice(credit, profile).toString("utf8");
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?><CreditNote /);
    assert.match(xml, /<cbc:CreditNoteTypeCode>381<\/cbc:CreditNoteTypeCode>/);
    assert.match(xml, /<cac:CreditNoteLine>/);
    assert.match(xml, /<cbc:CreditedQuantity unitCode="C62">1<\/cbc:CreditedQuantity>/);
    assert.match(xml, /<cbc:PayableAmount currencyID="EUR">60\.00<\/cbc:PayableAmount>/);
});

test("UBL conserve la franchise 293 B dans les totaux et chaque ligne", () => {
    const xml = generateUblInvoice({ ...invoice, vatRegime: "franchise", lines: [{ description: "Intervention", quantity: 1, unit: "forfait", unitPrice: 100, vatRate: 20 }], financialData: {} }, { ...profile, vatRegime: "franchise" }).toString("utf8");
    assert.match(xml, /<cbc:TaxAmount currencyID="EUR">0\.00<\/cbc:TaxAmount>/);
    assert.match(xml, /<cbc:ID>E<\/cbc:ID><cbc:Percent>0\.00<\/cbc:Percent><cbc:TaxExemptionReason>TVA non applicable, art\. 293 B du CGI<\/cbc:TaxExemptionReason>/);
    assert.match(xml, /<cbc:PayableAmount currencyID="EUR">100\.00<\/cbc:PayableAmount>/);
});

test("UBL refuse les documents sans identifiants essentiels", () => {
    assert.throws(() => generateUblInvoice({ ...invoice, documentNumber: "" }, profile), /identifiants fournisseur\/client/);
    assert.throws(() => generateUblInvoice({ ...invoice, legalData: {}, clientId: "", customerName: "" }, profile), /identifiants fournisseur\/client/);
});
