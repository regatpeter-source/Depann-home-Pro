import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canCreateBillingTemplates } from "../server/billing.js";

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

test("only administrative and Mobile Administrator workstations can save reusable billing lines", () => {
    assert.match(billingSource, /data-save-billing-template>Préenregistrer/);
    assert.match(billingSource, /document\.body\.dataset\.deviceType === "desktop" \|\| \["admin", "mobile_admin"\]\.includes\(role\)/);
    assert.match(billingSource, /apiRequest\("\/api\/billing\/templates", \{ method: "POST"/);
    assert.match(billingSource, /billingData\.templates = \[\.\.\.billingData\.templates, result\.data\.template\]/);
    assert.match(billingServerSource, /app\.post\("\/api\/billing\/templates", requireAuthentication, requireBillingTemplateCreation/);
    assert.match(billingServerSource, /app\.delete\("\/api\/billing\/templates\/:templateId", requireAuthentication, requireBillingAdministration/);
    assert.equal(canCreateBillingTemplates({ role: "pc_standard", deviceType: "desktop" }), true);
    assert.equal(canCreateBillingTemplates({ role: "admin", deviceType: "mobile" }), true);
    assert.equal(canCreateBillingTemplates({ role: "mobile_admin", deviceType: "mobile" }), true);
    assert.equal(canCreateBillingTemplates({ role: "technician", deviceType: "mobile" }), false);
    assert.equal(canCreateBillingTemplates({ role: "team_lead", deviceType: "mobile" }), false);
    assert.equal(canCreateBillingTemplates({ role: "accountant", deviceType: "desktop" }), false);
    assert.match(billingSource, /<select aria-label="Ligne préenregistrée"/);
    assert.match(billingSource, /id="addBillingLine">\+ Ligne libre/);
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

test("issuing an invoice makes legal data immutable while email remains operational", () => {
    assert.match(billingServerSource, /SET is_email_sent=TRUE, sent_at=COALESCE\(sent_at,NOW\(\)\)/);
    assert.match(billingServerSource, /issued_at IS NULL AND is_accounted=FALSE/);
    assert.match(billingServerSource, /depannhome_protect_issued_billing_document/);
    assert.match(billingSource, /document\.documentType === "invoice" && document\.issuedAt/);
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
