import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const billingSource = readFileSync(new URL("../js/billing.js", import.meta.url), "utf8");
const calendarSource = readFileSync(new URL("../js/calendar.js", import.meta.url), "utf8");
const billingServerSource = readFileSync(new URL("../server/billing.js", import.meta.url), "utf8");
const accountingSource = readFileSync(new URL("../js/accounting.js", import.meta.url), "utf8");

test("selecting a known billing customer stores its client id", () => {
    assert.match(billingSource, /form\.querySelector\("\[name=clientId\]"\)\.value = client\?\.id \|\| ""/);
});

test("administrators can open and close the saved billing line manager", () => {
    assert.match(billingSource, /data-billing-action="manage-line-templates"/);
    assert.match(billingSource, /renderBilling\(\{ templates: true \}\)/);
    assert.match(billingSource, /if \(options\.templates && isFullAdministrator\(\)\)/);
    assert.match(billingSource, /id="closeBillingTemplates"/);
    assert.match(billingSource, /id="billingAidForm"/);
    assert.match(billingSource, /\/api\/accounting\/aids/);
    assert.match(billingSource, /Gérer les lignes et aides/);
    assert.doesNotMatch(accountingSource, /\["aids", "Aides financières"\]/);
});

test("saved quotes and invoices open the client before offering email or print", () => {
    assert.match(billingSource, /const savedDocumentId = result\.data\?\.id \|\| document\.id/);
    assert.match(billingSource, /depannhome:open-client/);
    assert.match(billingSource, /openDocumentDeliveryChoice/);
    assert.match(billingSource, /\/api\/billing\/documents\/\$\{encodeURIComponent\(savedDocumentId\)\}\/email/);
});

test("appointment synchronization remains available without navigating back to calendar", () => {
    assert.match(billingSource, /suppressNavigation: true/);
    assert.match(calendarSource, /if \(event\.detail\?\.suppressNavigation\) return/);
});

test("quotes, invoices and credits cannot be deleted from the UI or API", () => {
    assert.doesNotMatch(billingSource, /deleteBillingDocument/);
    assert.doesNotMatch(billingSource, /api\/billing\/documents\/[^\n]+method: "DELETE"/);
    const deleteRoute = billingServerSource.slice(billingServerSource.indexOf('app.delete("/api/billing/documents/:documentId"'), billingServerSource.indexOf("function requireBillingAdministration"));
    assert.match(deleteRoute, /status\(409\)/);
    assert.match(deleteRoute, /devis, factures et avoirs sont conservés/);
    assert.doesNotMatch(deleteRoute, /DELETE FROM depannhome_billing_documents/);
});

test("emailing an invoice persists its sent state and makes later updates immutable", () => {
    assert.match(billingServerSource, /SET is_email_sent=TRUE, sent_at=COALESCE\(sent_at,NOW\(\)\)/);
    assert.match(billingServerSource, /NOT \(document_type='invoice' AND is_email_sent=TRUE\)/);
    assert.match(billingSource, /document\.documentType === "invoice" && document\.isEmailSent/);
    assert.match(billingSource, /enregistrement immuable/);
});

test("sent invoices expose linked corrective invoice and amendment workflows", () => {
    const correctionRoute = billingServerSource.slice(billingServerSource.indexOf('app.post("/api/billing/documents/:documentId/corrections"'), billingServerSource.indexOf('app.patch("/api/billing/documents/:documentId/accounting"'));
    assert.match(correctionRoute, /correction_source_id/);
    assert.match(correctionRoute, /correction_kind/);
    assert.match(correctionRoute, /status='cancelled'/);
    assert.match(correctionRoute, /has_entry/);
    assert.match(correctionRoute, /has_settlement/);
    assert.match(correctionRoute, /Créez obligatoirement un avoir comptable/);
    assert.match(billingSource, /Créer une facture rectificative/);
    assert.match(billingSource, /Créer un avenant/);
});
