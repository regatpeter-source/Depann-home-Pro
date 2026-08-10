import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createBillingPdf } from "../server/billing.js";
import { createQuitusPdf } from "../server/calendar.js";

const serverSource = readFileSync(new URL("../server/billing.js", import.meta.url), "utf8");
const calendarSource = readFileSync(new URL("../server/calendar.js", import.meta.url), "utf8");
const clientSource = readFileSync(new URL("../js/billing.js", import.meta.url), "utf8");
const schemaSource = readFileSync(new URL("../database/schema.sql", import.meta.url), "utf8");

const quote = {
    documentType: "quote",
    documentNumber: "APERÇU",
    customerName: "Client test",
    customerAddress: "1 rue du Test",
    issueDate: "2026-08-10",
    dueDate: "",
    lines: [{ description: "Prestation", quantity: 1, unit: "forfait", unitPrice: 100, vatRate: 20 }],
    notes: "Conditions de test"
};
const profile = { companyName: "Entreprise test", vatRegime: "standard" };
const event = { id: "APERÇU", title: "Intervention", clientName: "Client test", location: "1 rue du Test", date: "2026-08-10", startTime: "09:00", endTime: "10:00", notes: "RAS" };
const quitus = { signedBy: "Client test", signature: "" };

test("quote and quitus integrated templates have independent persistent settings", () => {
    assert.match(schemaSource, /quote_template_config JSONB NOT NULL DEFAULT '\{\}'::jsonb/);
    assert.match(schemaSource, /quitus_template JSONB NOT NULL DEFAULT '\{\}'::jsonb/);
    assert.match(serverSource, /profile\.quote_template_config AS "quoteTemplateConfig", profile\.quitus_template AS "quitusTemplate"/);
    assert.match(calendarSource, /quitus_template AS "quitusTemplate"/);
});

test("company settings retain external bases and provide previews for both documents", () => {
    assert.match(clientSource, /Base PDF \/ Word de l’entreprise/);
    assert.match(clientSource, /Base PDF \/ Word officielle de l’entreprise/);
    assert.match(clientSource, /previewQuoteTemplate/);
    assert.match(serverSource, /\/api\/billing\/quote-template\/preview/);
    assert.match(serverSource, /document-templates\/:templateType\/preview/);
    assert.match(serverSource, /sendExternalQuoteTemplate\(ownerId, response, true\)/);
});

test("quote and quitus settings expose report-like visual controls", () => {
    for (const field of ["primaryColor", "secondaryColor", "separatorColor", "font", "headerText", "footerText"]) assert.match(clientSource, new RegExp(`name="${field}"`));
    assert.match(clientSource, /integratedTemplateFields\(profile\.quoteTemplateConfig, "devis"\)/);
    assert.match(clientSource, /integratedTemplateFields\(profile\.quitusTemplate, "quitus"\)/);
});

test("integrated quote PDF changes with its own template", async () => {
    const first = await createBillingPdf(quote, { ...profile, quoteTemplateConfig: { primaryColor: "#172033", secondaryColor: "#0a5c36", font: "Helvetica", headerText: "Version A" } });
    const second = await createBillingPdf(quote, { ...profile, quoteTemplateConfig: { primaryColor: "#7c2d12", secondaryColor: "#1d4ed8", font: "Courier", headerText: "Version B" } });
    assert.equal(first.subarray(0, 4).toString(), "%PDF");
    assert.equal(second.subarray(0, 4).toString(), "%PDF");
    assert.notDeepEqual(first, second);
});

test("integrated quitus PDF changes with its own template", async () => {
    const first = await createQuitusPdf(event, quitus, { ...profile, quitusTemplate: { primaryColor: "#003b73", secondaryColor: "#0a5c36", font: "Helvetica", footerText: "Version A" } });
    const second = await createQuitusPdf(event, quitus, { ...profile, quitusTemplate: { primaryColor: "#7c2d12", secondaryColor: "#1d4ed8", font: "Times-Roman", footerText: "Version B" } });
    assert.equal(first.subarray(0, 4).toString(), "%PDF");
    assert.equal(second.subarray(0, 4).toString(), "%PDF");
    assert.notDeepEqual(first, second);
});
