import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createBillingDocumentOutput, createBillingPdf } from "../server/billing.js";
import { createQuitusPdf } from "../server/calendar.js";
import { PDFDocument } from "pdf-lib";
import PizZip from "pizzip";
import { DOCX_MIME, PDF_MIME, renderCompanyTemplate, validateCompanyTemplate } from "../server/company-document-template.js";

const serverSource = readFileSync(new URL("../server/billing.js", import.meta.url), "utf8");
const calendarSource = readFileSync(new URL("../server/calendar.js", import.meta.url), "utf8");
const clientSource = readFileSync(new URL("../js/billing.js", import.meta.url), "utf8");
const schemaSource = readFileSync(new URL("../database/schema.sql", import.meta.url), "utf8");
const technicalReportSource = readFileSync(new URL("../server/technical-reports.js", import.meta.url), "utf8");
const partnerDialogueSource = readFileSync(new URL("../server/partner-dialogue.js", import.meta.url), "utf8");
const partnerConnectionsSource = readFileSync(new URL("../server/partner-connections.js", import.meta.url), "utf8");

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
const invoice = { ...quote, documentType: "invoice", documentNumber: "FAC-42", dueDate: "2026-09-10", quoteReference: "DEV-42" };
const event = { id: "APERÇU", title: "Intervention", clientName: "Client test", location: "1 rue du Test", date: "2026-08-10", startTime: "09:00", endTime: "10:00", notes: "RAS" };
const quitus = { signedBy: "Client test", signature: "" };

test("quote and quitus integrated templates have independent persistent settings", () => {
    assert.match(schemaSource, /quote_template_config JSONB NOT NULL DEFAULT '\{\}'::jsonb/);
    assert.match(schemaSource, /quitus_template JSONB NOT NULL DEFAULT '\{\}'::jsonb/);
    assert.match(serverSource, /profile\.quote_template_config AS "quoteTemplateConfig", profile\.quitus_template AS "quitusTemplate"/);
    assert.match(calendarSource, /quitus_template AS "quitusTemplate"/);
});

test("company settings retain external bases and provide previews for both documents", () => {
    assert.match(clientSource, /Gabarit PDF \/ DOCX de l’entreprise/);
    assert.match(clientSource, /Gabarit PDF \/ DOCX officiel de l’entreprise/);
    assert.match(clientSource, /previewQuoteTemplate/);
    assert.match(serverSource, /\/api\/billing\/quote-template\/preview/);
    assert.match(serverSource, /document-templates\/:templateType\/preview/);
    assert.match(serverSource, /createBillingDocumentOutput\(document, profile\)/);
});

test("quote and quitus settings expose report-like visual controls", () => {
    for (const field of ["primaryColor", "secondaryColor", "separatorColor", "font", "headerText", "footerText"]) assert.match(clientSource, new RegExp(`name="${field}"`));
    assert.match(clientSource, /integratedTemplateFields\(profile\.quoteTemplateConfig, "devis et facture"\)/);
    assert.match(clientSource, /integratedTemplateFields\(profile\.quitusTemplate, "quitus"\)/);
});

test("integrated quote PDF changes with its own template", async () => {
    const first = await createBillingPdf(quote, { ...profile, quoteTemplateConfig: { primaryColor: "#172033", secondaryColor: "#0a5c36", font: "Helvetica", headerText: "Version A" } });
    const second = await createBillingPdf(quote, { ...profile, quoteTemplateConfig: { primaryColor: "#7c2d12", secondaryColor: "#1d4ed8", font: "Courier", headerText: "Version B" } });
    assert.equal(first.subarray(0, 4).toString(), "%PDF");
    assert.equal(second.subarray(0, 4).toString(), "%PDF");
    assert.notDeepEqual(first, second);
});

test("an integrated invoice automatically inherits the quote presentation", async () => {
    const first = await createBillingPdf(invoice, { ...profile, quoteTemplateConfig: { primaryColor: "#172033", headerText: "Présentation commune A" } });
    const second = await createBillingPdf(invoice, { ...profile, quoteTemplateConfig: { primaryColor: "#7c2d12", headerText: "Présentation commune B" } });
    assert.equal(first.subarray(0, 4).toString(), "%PDF");
    assert.equal(second.subarray(0, 4).toString(), "%PDF");
    assert.notDeepEqual(first, second);
});

test("an invoice automatically uses the external DOCX base selected for quotes", async () => {
    const zip = new PizZip();
    zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.folder("_rels").file(".rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.folder("word").file("document.xml", '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{{type_document}} — {{numero}} — {{client_nom}}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>');
    const output = await createBillingDocumentOutput(invoice, { ...profile, quoteTemplatePolicy: "company_choice", quoteTemplateMode: "external", quoteTemplateData: zip.generate({ type: "nodebuffer" }), quoteTemplateFilename: "base-commune.docx", quoteTemplateMimeType: DOCX_MIME });
    const xml = new PizZip(output.buffer).file("word/document.xml").asText();
    assert.equal(output.mimeType, DOCX_MIME);
    assert.match(xml, /Facture — FAC-42 — Client test/);
});

test("an invoice automatically preserves the external PDF base selected for quotes", async () => {
    const base = await PDFDocument.create(); base.addPage();
    const output = await createBillingDocumentOutput(invoice, { ...profile, quoteTemplatePolicy: "company_choice", quoteTemplateMode: "external", quoteTemplateData: Buffer.from(await base.save()), quoteTemplateFilename: "base-commune.pdf", quoteTemplateMimeType: PDF_MIME });
    const merged = await PDFDocument.load(output.buffer);
    assert.equal(output.mimeType, PDF_MIME);
    assert.ok(merged.getPageCount() >= 2);
});

test("integrated quitus PDF changes with its own template", async () => {
    const first = await createQuitusPdf(event, quitus, { ...profile, quitusTemplate: { primaryColor: "#003b73", secondaryColor: "#0a5c36", font: "Helvetica", footerText: "Version A" } });
    const second = await createQuitusPdf(event, quitus, { ...profile, quitusTemplate: { primaryColor: "#7c2d12", secondaryColor: "#1d4ed8", font: "Times-Roman", footerText: "Version B" } });
    assert.equal(first.subarray(0, 4).toString(), "%PDF");
    assert.equal(second.subarray(0, 4).toString(), "%PDF");
    assert.notDeepEqual(first, second);
});

test("a DOCX company template replaces automatic fields without losing the original document", async () => {
    const zip = new PizZip();
    zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.folder("_rels").file(".rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.folder("word").file("document.xml", '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Base entreprise — {{client_nom}} — {{numero}}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>');
    const template = zip.generate({ type: "nodebuffer" });
    const output = await renderCompanyTemplate({ buffer: template, filename: "devis.docx", mimeType: DOCX_MIME, values: { client_nom: "Camille Martin", numero: "DEV-42" }, generatedPdf: Buffer.alloc(0) });
    const xml = new PizZip(output.buffer).file("word/document.xml").asText();
    assert.equal(output.mimeType, DOCX_MIME);
    assert.match(xml, /Base entreprise/);
    assert.match(xml, /Camille Martin/);
    assert.match(xml, /DEV-42/);
    assert.doesNotMatch(xml, /client_nom|\{\{/);
});

test("a PDF company base is preserved before the generated business pages", async () => {
    const base = await PDFDocument.create(); base.addPage();
    const generated = await PDFDocument.create(); generated.addPage(); generated.addPage();
    const output = await renderCompanyTemplate({ buffer: Buffer.from(await base.save()), filename: "base.pdf", mimeType: PDF_MIME, values: {}, generatedPdf: Buffer.from(await generated.save()) });
    const merged = await PDFDocument.load(output.buffer);
    assert.equal(output.mimeType, PDF_MIME);
    assert.equal(merged.getPageCount(), 3);
});

test("official company outputs are retained across archives, emails, downloads and partner sharing", () => {
    assert.match(serverSource, /createBillingDocumentOutput\(billingExport\.document, billingExport\.profile\)/);
    assert.match(serverSource, /contentType: output\.mimeType/);
    assert.match(calendarSource, /createQuitusDocumentOutput/);
    assert.match(calendarSource, /data:\$\{output\.mimeType\}/);
    assert.match(technicalReportSource, /createTechnicalReportOutput/);
    assert.match(technicalReportSource, /document_mime_type/);
    assert.match(partnerDialogueSource, /createBillingDocumentOutput/);
    assert.match(partnerConnectionsSource, /mimeType: report\.document_mime_type/);
    assert.match(serverSource, /\["quote", "invoice"\]\.includes\(document\.documentType\)/);
    assert.match(clientSource, /Toute facture reprend automatiquement cette présentation et cette base/);
});

test("template failures are actionable and quitus custom text is available to external templates", async () => {
    await assert.rejects(() => renderCompanyTemplate({ buffer: null, mimeType: PDF_MIME }), error => error.status === 409 && /introuvable/.test(error.message));
    await assert.rejects(() => validateCompanyTemplate(Buffer.from("not-a-pdf"), PDF_MIME), error => error.status === 400 && /illisible ou corrompu/.test(error.message));
    assert.match(calendarSource, /texte_entete: template\.headerText/);
    assert.match(calendarSource, /texte_pied_page: template\.footerText/);
    assert.match(clientSource, /"texte_entete", "texte_pied_page"/);
});
