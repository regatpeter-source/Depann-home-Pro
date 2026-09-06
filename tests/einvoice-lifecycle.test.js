import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sanitizeInboundInvoice } from "../server/einvoice-lifecycle.js";

const lifecycleServer = readFileSync(new URL("../server/einvoice-lifecycle.js", import.meta.url), "utf8");
const electronicServer = readFileSync(new URL("../server/electronic-invoicing.js", import.meta.url), "utf8");
const accountingServer = readFileSync(new URL("../server/accounting.js", import.meta.url), "utf8");
const creatorServer = readFileSync(new URL("../server/creator.js", import.meta.url), "utf8");
const companyClient = readFileSync(new URL("../js/accounting.js", import.meta.url), "utf8");
const creatorClient = readFileSync(new URL("../js/creator.js", import.meta.url), "utf8");
const schema = readFileSync(new URL("../database/schema.sql", import.meta.url), "utf8");

test("un import fournisseur valide normalise les montants et les références", () => {
    assert.deepEqual(sanitizeInboundInvoice({ invoiceNumber: " F-42 ", supplierName: " Fournisseur Test ", issueDate: "2026-08-27", dueDate: "2026-09-27", amountHt: "100", vatAmount: "20", amountTtc: "120", currencyCode: "EUR", externalId: " ext-1 " }), {
        ok: true, invoiceNumber: "F-42", supplierName: "Fournisseur Test", issueDate: "2026-08-27", dueDate: "2026-09-27", amountHt: 100, vatAmount: 20, amountTtc: 120, provider: "Import manuel", externalId: "ext-1", supplierIdentifier: "", currencyCode: "EUR", importNote: ""
    });
});

test("un import fournisseur incomplet ou financièrement invalide est refusé", () => {
    assert.equal(sanitizeInboundInvoice({}).ok, false);
    assert.equal(sanitizeInboundInvoice({ invoiceNumber: "F", supplierName: "S", issueDate: "2026-08-27", amountHt: -1, vatAmount: 0, amountTtc: 0 }).ok, false);
    assert.equal(sanitizeInboundInvoice({ invoiceNumber: "F", supplierName: "S", issueDate: "invalid", amountHt: 1, vatAmount: 0, amountTtc: 1 }).ok, false);
});

test("les factures reçues et leurs événements sont toujours cloisonnés par entreprise", () => {
    for (const source of [lifecycleServer, creatorServer, schema]) assert.match(source, /depannhome_einvoice_inbound_invoices/);
    assert.match(lifecycleServer, /WHERE id=\$1 AND owner_id=\$2/);
    assert.match(lifecycleServer, /WHERE invoice\.owner_id=\$1/);
    assert.match(schema, /UNIQUE INDEX IF NOT EXISTS depannhome_einvoice_inbound_external_unique ON depannhome_einvoice_inbound_invoices\(owner_id,provider,external_id\)/);
    assert.doesNotMatch(creatorServer.slice(creatorServer.indexOf('app.get("/api/creator/accounts/:accountId/e-invoicing"'), creatorServer.indexOf('app.post("/api/creator/accounts"')), /encrypted_credentials|refresh_metadata|webhook_token_hash/);
});

test("le parcours entrant exige contrôle, décision et rapprochement traçables", () => {
    assert.match(lifecycleServer, /app\.post\("\/api\/accounting\/e-invoicing\/inbound"/);
    for (const action of ["validate", "decision", "purchase", "payment"]) assert.match(lifecycleServer, new RegExp(`/api/accounting/e-invoicing/inbound/:invoiceId/${action}`));
    assert.match(lifecycleServer, /app\.get\("\/api\/accounting\/e-invoicing\/inbound\/:invoiceId\/events"/);
    assert.match(lifecycleServer, /Facture fournisseur acceptée/);
    assert.match(lifecycleServer, /Achat #\$\{rows\[0\]\.id\} créé et rapproché/);
    assert.match(lifecycleServer, /payment_reconciled/);
    assert.match(companyClient, /Factures électroniques reçues/);
    assert.match(companyClient, /Importer la facture reçue/);
    assert.match(companyClient, /Où effectuer chaque opération/);
    assert.match(companyClient, /Dans SUPER PDP/);
    assert.match(companyClient, /Cet enregistrement manuel ne télécharge pas le document original/);
});

test("le cycle fournisseur verrouille les transitions et la création d’achat", () => {
    assert.match(lifecycleServer, /requireInboundInvoice\(ownerId, request\.params\.invoiceId, client, true\)/);
    assert.match(lifecycleServer, /status !== "validated"/);
    assert.match(lifecycleServer, /status !== "accepted"/);
    assert.match(lifecycleServer, /FOR UPDATE/);
    assert.match(lifecycleServer, /Une facture déjà décidée ou archivée ne peut plus être revalidée/);
});

test("le parcours sortant conserve étape réglementaire, paiement et chronologie", () => {
    assert.match(electronicServer, /lifecycle_status/);
    assert.match(accountingServer, /payment_reconciled/);
    assert.match(companyClient, /Parcours des factures et avoirs transmis/);
    assert.match(companyClient, /Voir la chronologie/);
    assert.match(creatorClient, /Factures fournisseurs reçues/);
    assert.match(creatorServer, /lifecycle_status AS "lifecycleStatus"/);
});
