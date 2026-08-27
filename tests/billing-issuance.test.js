import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const billing = readFileSync(new URL("../server/billing.js", import.meta.url), "utf8");
const accounting = readFileSync(new URL("../server/accounting.js", import.meta.url), "utf8");
const electronicInvoicing = readFileSync(new URL("../server/electronic-invoicing.js", import.meta.url), "utf8");
const schema = readFileSync(new URL("../database/schema.sql", import.meta.url), "utf8");
const client = readFileSync(new URL("../js/billing.js", import.meta.url), "utf8");

test("les brouillons de facture reçoivent une référence interne contrôlée par le serveur", () => {
    assert.match(billing, /BROUILLON-FAC-\$\{crypto\.randomUUID\(\)\}/);
    assert.match(billing, /document\.documentType === "invoice" \? draftInvoiceReference\(\) : document\.documentNumber/);
    assert.match(billing, /RETURNING id, document_number AS "documentNumber"/);
    assert.match(billing, /const status = document\.documentType === "invoice" \? "draft" : document\.status/);
    assert.match(client, /Attribué automatiquement à l’émission/);
    assert.match(client, /result\.data\?\.documentNumber/);
});

test("l’émission est autorisée et contrôlée par intervention, transactionnelle, idempotente et archive UBL/PDF", () => {
    const route = billing.slice(billing.indexOf('app.post("/api/billing/documents/:documentId/issue"'), billing.indexOf('app.put("/api/billing/default-quote"'));
    assert.match(route, /requireBillingIssuanceAccess/);
    assert.match(route, /findAccessibleBillingDocument/);
    assert.match(billing, /export async function issueDocument/);
    assert.match(billing, /FOR UPDATE/);
    assert.match(billing, /if \(document\.issuedAt\)/);
    assert.match(billing, /allocateBillingNumber\(database, ownerId, "invoice", seriesYear\)/);
    assert.match(billing, /buildBillingLegalArchive\(finalDocument, \{ profile \}\)/);
    assert.match(billing, /export async function buildBillingLegalArchive/);
    assert.match(billing, /generateUblInvoice\(document, resolvedProfile\)/);
    assert.match(billing, /createBillingPdf\(document, resolvedProfile\)/);
    assert.match(billing, /legal_snapshot=\$5::jsonb/);
    assert.match(billing, /pdf_data=\$8, pdf_sha256=\$9/);
    assert.match(billing, /structured_sha256=\$7/);
});

test("un technicien autorisé facture et encaisse uniquement son intervention attribuée", () => {
    assert.match(billing, /Les techniciens peuvent créer un devis ou une facture uniquement depuis une intervention qui leur est attribuée/);
    assert.match(billing, /assignment\.technician_id=\$4::bigint/);
    assert.match(billing, /recordInvoiceSettlement/);
    assert.match(accounting, /INVOICE_PAYMENT_METHODS = new Set\(\["Chèque", "Espèces", "Virement", "Carte bancaire"\]\)/);
    assert.match(accounting, /payment_reconciled/);
    assert.match(client, /data-invoice-settlement/);
    assert.match(client, /Carte bancaire/);
    assert.match(client, /Facture réglée/);
});

test("une facture de particulier reste locale et ne part pas comme facture électronique B2B", () => {
    assert.match(electronicInvoicing, /document\.customerType === "Particulier"/);
    assert.match(electronicInvoicing, /\["Professionnel", "Magasin"\]\.includes\(document\.customerType\)/);
    assert.match(electronicInvoicing, /ne doit pas être transmise comme une facture électronique B2B/);
    assert.match(electronicInvoicing, /e-reporting/);
});

test("les documents émis sont protégés par SQL et les PUT restent limités aux brouillons", () => {
    for (const source of [billing, schema]) {
        assert.match(source, /depannhome_protect_issued_billing_document/);
        assert.match(source, /OLD\.issued_at IS NOT NULL/);
        assert.match(source, /Les données légales d’un document émis sont immuables/);
    }
    assert.match(billing, /WHERE id=\$1 AND owner_id=\$2 AND issued_at IS NULL AND is_accounted=FALSE/);
    assert.match(billing, /SELECT pdf_data AS data/);
    assert.match(billing, /L’archive UBL de ce document émis est indisponible/);
    assert.match(billing, /document\.documentType === "credit" \? "avoir"/);
});

test("la comptabilité exige l’émission et les avoirs utilisent la série légale", () => {
    assert.match(accounting, /allocateBillingNumber\(client, ownerId, "credit"/);
    assert.doesNotMatch(accounting, /Date\.now\(\).*AVO|AVO-.*Date\.now\(\)/);
    assert.match(accounting, /document_type='invoice' AND issued_at IS NOT NULL FOR UPDATE/);
    assert.match(accounting, /if \(!document\.issuedAt\) throw accountingError/);
    assert.match(accounting, /\(structured_data IS NOT NULL\) AS "hasStructuredData"/);
    assert.match(electronicInvoicing, /L’archive UBL de cette facture ou de cet avoir est indisponible/);
    assert.match(accounting, /finalized_by, legal_snapshot/);
    const creditRoute = accounting.slice(accounting.indexOf('app.post("/api/accounting/documents/:documentId/credits"'), accounting.indexOf('app.post("/api/accounting/settlements"'));
    assert.match(creditRoute, /buildBillingLegalArchive\(creditDocument, \{ ownerId, database: client \}\)/);
    assert.match(creditRoute, /structured_data, structured_mime_type, structured_sha256, pdf_data, pdf_sha256/);
    assert.match(creditRoute, /archive\.structuredData/);
    assert.match(creditRoute, /archive\.pdfData/);
});
