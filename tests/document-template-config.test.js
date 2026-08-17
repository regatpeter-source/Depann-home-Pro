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

test("a visual PDF company base is preserved before business pages without overlap", async () => {
    const base = await PDFDocument.create(); base.addPage();
    const generated = await PDFDocument.create(); generated.addPage().drawText("Page métier 1"); generated.addPage().drawText("Page métier 2");
    const output = await renderCompanyTemplate({ buffer: Buffer.from(await base.save()), filename: "base.pdf", mimeType: PDF_MIME, values: {}, generatedPdf: Buffer.from(await generated.save()) });
    const merged = await PDFDocument.load(output.buffer);
    assert.equal(output.mimeType, PDF_MIME);
    assert.equal(merged.getPageCount(), 3);
});

test("a multi-page visual PDF company base and business pages retain their architecture", async () => {
    const base = await PDFDocument.create(); base.addPage([400, 500]); base.addPage([420, 520]);
    const generated = await PDFDocument.create(); generated.addPage().drawText("Page métier 1"); generated.addPage().drawText("Page métier 2"); generated.addPage().drawText("Page métier 3");
    const output = await renderCompanyTemplate({ buffer: Buffer.from(await base.save()), filename: "base.pdf", mimeType: PDF_MIME, values: {}, generatedPdf: Buffer.from(await generated.save()) });
    const merged = await PDFDocument.load(output.buffer);
    assert.equal(merged.getPageCount(), 5);
    assert.deepEqual(merged.getPage(0).getSize(), { width: 400, height: 500 });
    assert.deepEqual(merged.getPage(1).getSize(), { width: 420, height: 520 });
});

test("a fillable PDF company base receives automatic values without DepannHome overlap", async () => {
    const base = await PDFDocument.create();
    const page = base.addPage();
    const form = base.getForm();
    form.createTextField("type_document").addToPage(page, { x: 40, y: 740, width: 180, height: 24 });
    form.createTextField("numero").addToPage(page, { x: 40, y: 700, width: 180, height: 24 });
    form.createTextField("{{client_nom}}").addToPage(page, { x: 40, y: 660, width: 240, height: 24 });
    form.createTextField("lignes").addToPage(page, { x: 40, y: 580, width: 400, height: 60 });
    form.createTextField("total_ttc").addToPage(page, { x: 300, y: 540, width: 140, height: 24 });
    const generated = await PDFDocument.create(); generated.addPage().drawText("Modèle métier qui ne doit pas être superposé");
    const output = await renderCompanyTemplate({ buffer: Buffer.from(await base.save()), filename: "base-remplissable.pdf", mimeType: PDF_MIME, values: { type_document: "Devis", numero: "DEV-42", client_nom: "Camille Martin", lignes: "Diagnostic | 1 forfait | 120 €", total_ttc: "144 €" }, generatedPdf: Buffer.from(await generated.save()) });
    const merged = await PDFDocument.load(output.buffer);
    assert.equal(merged.getPageCount(), 1);
    assert.equal(merged.getForm().getTextField("numero").getText(), "DEV-42");
    assert.equal(merged.getForm().getTextField("{{client_nom}}").getText(), "Camille Martin");
});

test("an incomplete fillable PDF keeps colored business pages so no content is lost", async () => {
    const base = await PDFDocument.create();
    const page = base.addPage();
    base.getForm().createTextField("numero").addToPage(page, { x: 40, y: 700, width: 180, height: 24 });
    const generated = await PDFDocument.create(); generated.addPage().drawText("Toutes les données métier");
    const output = await renderCompanyTemplate({ buffer: Buffer.from(await base.save()), filename: "base-partielle.pdf", mimeType: PDF_MIME, values: { type_document: "Devis", numero: "DEV-43", client_nom: "Client", lignes: "Prestation", total_ttc: "120 €" }, generatedPdf: Buffer.from(await generated.save()) });
    const merged = await PDFDocument.load(output.buffer);
    assert.equal(merged.getPageCount(), 2);
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

test("desktop quote and invoice editing uses a split form with live final PDF preview", () => {
    assert.match(clientSource, /globalThis\.document\.body\.classList\.contains\("desktop-device"\)/);
    assert.match(clientSource, /billing-document-workspace/);
    assert.match(clientSource, /billing-document-live-preview/);
    assert.match(clientSource, /bindBillingDocumentPreview/);
    assert.match(clientSource, /\/api\/billing\/documents\/preview/);
    assert.match(serverSource, /app\.post\("\/api\/billing\/documents\/preview", requireAuthentication, requireTechnicianBillingAccess, requireDesktopBillingPreview/);
    assert.match(serverSource, /createBillingDocumentOutput\(document, profile\)/);
});

test("technical report proofreading previews the selected official company output", () => {
    const previewRoute = technicalReportSource.slice(technicalReportSource.indexOf('app.post("/api/technical-reports/:reportId/pdf-preview"'), technicalReportSource.indexOf('app.post("/api/technical-reports/:reportId/media"'));
    assert.match(previewRoute, /createTechnicalReportOutput\(draft, profile\)/);
    assert.match(previewRoute, /X-Report-Preview-Mode/);
});

test("billing live preview is desktop-only, accepts incomplete drafts and never stores them", () => {
    assert.match(serverSource, /request\.user\?\.deviceType === "desktop"/);
    assert.match(serverSource, /function sanitizeDocumentPreview/);
    assert.match(serverSource, /"Client à renseigner"/);
    const previewRoute = serverSource.slice(serverSource.indexOf('app.post("/api/billing/documents/preview"'), serverSource.indexOf('app.post("/api/billing/documents/:documentId/email"'));
    assert.doesNotMatch(previewRoute, /INSERT INTO depannhome_billing_documents|UPDATE depannhome_billing_documents/);
    assert.match(previewRoute, /profile\.quoteTemplateMimeType === DOCX_MIME/);
});

test("billing live preview revokes old PDF blobs and cancels stale generations", () => {
    assert.match(clientSource, /request\?\.abort\(\)/);
    assert.match(clientSource, /URL\.revokeObjectURL\(previousUrl\)/);
    assert.match(clientSource, /MutationObserver/);
});
