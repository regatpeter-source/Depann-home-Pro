import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const serverSource = readFileSync(new URL("../server/billing.js", import.meta.url), "utf8");
const schemaSource = readFileSync(new URL("../database/schema.sql", import.meta.url), "utf8");
const clientSource = readFileSync(new URL("../js/billing.js", import.meta.url), "utf8");
const accountingSource = readFileSync(new URL("../server/accounting.js", import.meta.url), "utf8");
const templateSource = readFileSync(new URL("../server/document-templates.js", import.meta.url), "utf8");

test("les migrations de conformité restent additives et dotées de valeurs sûres", () => {
    for (const source of [serverSource, schemaSource]) {
        assert.match(source, /early_payment_discount_terms VARCHAR\(500\) NOT NULL DEFAULT 'Aucun escompte pour paiement anticipé\.'/);
        assert.match(source, /late_payment_penalty_terms VARCHAR\(1000\) NOT NULL DEFAULT 'Pénalités de retard exigibles au taux de trois fois le taux d’intérêt légal/);
        assert.match(source, /recovery_indemnity_cents INTEGER NOT NULL DEFAULT 4000/);
        assert.match(source, /vat_on_debits BOOLEAN NOT NULL DEFAULT FALSE/);
        assert.match(source, /legal_data JSONB NOT NULL DEFAULT '\{\}'::jsonb/);
        assert.match(source, /issued_at TIMESTAMPTZ/);
        assert.match(source, /structured_data BYTEA/);
        assert.match(source, /structured_mime_type VARCHAR\(150\) NOT NULL DEFAULT ''/);
        assert.match(source, /structured_sha256 CHAR\(64\)/);
    }
});

test("les listes et détails exposent les métadonnées structurées sans octets", () => {
    const listRoute = serverSource.slice(serverSource.indexOf('app.get("/api/billing"'), serverSource.indexOf('app.put("/api/billing/profile"'));
    const detailRoute = serverSource.slice(serverSource.indexOf('app.get("/api/billing/documents/:documentId"'), serverSource.indexOf('app.get("/api/billing/documents/:documentId/pdf"'));
    for (const source of [listRoute, detailRoute]) {
        assert.match(source, /legal_data AS "legalData"/);
        assert.match(source, /issued_at AS "issuedAt"/);
        assert.match(source, /\(structured_data IS NOT NULL\) AS "hasStructuredData"/);
        assert.doesNotMatch(source, /structured_data AS "structuredData"/);
    }
});

test("l’éditeur envoie un legalData nettoyé et conserve les valeurs du client", () => {
    for (const name of ["customerSiren", "customerVatNumber", "deliveryAddress", "serviceDate", "purchaseOrderReference", "operationCategory"]) assert.match(clientSource, new RegExp(`name="${name}"`));
    assert.match(clientSource, /billingDocumentPayload\(form, document\)/);
    assert.match(clientSource, /billingDocumentPayload\(form, billingDocument\)/);
    assert.match(clientSource, /legalData: normalizeLegalData\(quote\.legalData/);
    assert.match(clientSource, /client\.siren \|\| client\.companySiren/);
    assert.match(serverSource, /function sanitizeLegalData/);
    assert.match(serverSource, /OPERATION_CATEGORIES\.has\(input\.operationCategory\)/);
    assert.match(serverSource, /cleanIdentifier\(input\.customerSiren, 20, true\)/);
});

test("les insertions et mises à jour persistent l’instantané légal et l’émission", () => {
    const createRoute = serverSource.slice(serverSource.indexOf('app.post("/api/billing/documents"'), serverSource.indexOf('app.put("/api/billing/documents/:documentId"'));
    const updateRoute = serverSource.slice(serverSource.indexOf('app.put("/api/billing/documents/:documentId"'), serverSource.indexOf('app.post("/api/billing/documents/:documentId/corrections"'));
    assert.match(createRoute, /legal_data, issued_at/);
    assert.match(createRoute, /JSON\.stringify\(document\.legalData\)/);
    assert.match(updateRoute, /legal_data=\$15::jsonb/);
    assert.match(updateRoute, /issued_at IS NULL/);
    assert.doesNotMatch(updateRoute, /issued_at\s*=/);
    assert.match(serverSource, /document_number=\$3, status='issued', issued_at=NOW\(\)/);
    assert.match(accountingSource, /invoice\.legal_data \|\| \{\}/);
});

test("la sortie PDF intégrée contient les mentions B2B et conserve la franchise 293 B", () => {
    for (const mention of ["Date de livraison / prestation", "Bon de commande", "Adresse de livraison", "SIREN", "TVA intracom.", "Aucun escompte pour paiement anticipé", "trois fois le taux d’intérêt légal", "Indemnité forfaitaire pour frais de recouvrement", "TVA acquittée sur les débits"]) assert.match(serverSource, new RegExp(mention));
    assert.match(serverSource, /TVA non applicable, art\. 293 B du CGI/);
    assert.match(serverSource, /normalizeAddress\(legalData\.deliveryAddress\) !== normalizeAddress/);
});

test("les profils et modèles personnalisés proposent les mentions légales", () => {
    for (const name of ["earlyPaymentDiscountTerms", "latePaymentPenaltyTerms", "recoveryIndemnityCents", "vatOnDebits"]) assert.match(clientSource, new RegExp(`name="${name}"`));
    for (const field of ["client.siren", "client.vat", "client.deliveryAddress", "document.serviceDate", "document.purchaseOrderReference", "document.operationCategory"]) assert.match(templateSource, new RegExp(field.replaceAll(".", "\\.")));
});

test("la route UBL sert uniquement les factures et avoirs émis et réutilise l’archive", () => {
    const route = serverSource.slice(serverSource.indexOf('app.get("/api/billing/documents/:documentId/ubl"'), serverSource.indexOf('app.post("/api/billing/documents/preview"'));
    assert.match(route, /\["invoice", "credit"\]\.includes\(document\.documentType\)/);
    assert.match(route, /!document\.issuedAt/);
    assert.match(route, /SELECT structured_data AS data/);
    assert.match(route, /L’archive UBL de ce document émis est indisponible/);
    assert.doesNotMatch(route, /generateUblInvoice/);
    assert.match(route, /application\/xml; charset=utf-8/);
    assert.match(route, /X-Structured-Invoice-Source/);
    assert.doesNotMatch(route, /validé|certifié|certification/i);
});
