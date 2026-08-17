import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { buildBillingCustomModel, buildQuitusCustomModel, buildReportCustomModel, renderCustomDocumentTemplate } from "../server/document-templates.js";

const schema = readFileSync(new URL("../database/schema.sql", import.meta.url), "utf8");
const server = readFileSync(new URL("../server/document-templates.js", import.meta.url), "utf8");
const billing = readFileSync(new URL("../server/billing.js", import.meta.url), "utf8");
const calendar = readFileSync(new URL("../server/calendar.js", import.meta.url), "utf8");
const reports = readFileSync(new URL("../server/technical-reports.js", import.meta.url), "utf8");
const navigation = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
const editor = readFileSync(new URL("../js/document-template-editor.js", import.meta.url), "utf8");

async function basePdf() { const pdf = await PDFDocument.create(); pdf.addPage([595.28, 841.89]); return Buffer.from(await pdf.save()); }
function definition(zones) { return { schemaVersion: 1, page: { width: 595.28, height: 841.89, margins: { top: 30, right: 30, bottom: 30, left: 30 } }, colors: { primary: "#003b73", secondary: "#0a5c36" }, zones }; }
function zone(id, type, field, x, y, width, height, page = "first") { return { id, type, field, text: "", page, x, y, width, height, style: { fontSize: 9, color: "#172033", borderColor: "#d7dde3", borderWidth: 0, rowHeight: 22, rows: 2, gap: 8 } }; }

const profile = { companyName: "Société Test", address: "1 rue Test", postalCode: "44000", city: "Nantes", phone: "0102030405", email: "test@example.fr", registrationNumber: "123", taxNumber: "FR123" };
const quote = { id: 1, documentType: "quote", documentNumber: "DEV-42", customerName: "Camille", customerAddress: "2 rue Client", issueDate: "2026-08-17", lines: Array.from({ length: 30 }, (_, i) => ({ description: `Ligne ${i + 1}`, quantity: 1, unitPrice: 100 + i, vatRate: 20 })), financialData: {} };

test("templates are versioned, isolated by owner and uniquely active per document type", () => {
    assert.match(schema, /CREATE TABLE IF NOT EXISTS depannhome_document_templates/);
    assert.match(schema, /owner_id BIGINT NOT NULL REFERENCES depannhome_users/);
    assert.match(schema, /document_type IN \('quote','invoice','quitus','report'\)/);
    assert.match(schema, /WHERE status='active'/);
    assert.match(server, /WHERE owner_id=\$1 AND document_type=\$2/);
});

test("quote and invoice have independent settings cards and API types", () => {
    assert.match(navigation, /Modèle de devis/);
    assert.match(navigation, /Modèle de facture/);
    assert.match(server, /new Set\(\["quote", "invoice", "quitus", "report"\]\)/);
});

test("custom outputs are selected before native renderers", () => {
    const billingOutput = billing.slice(billing.indexOf("export async function createBillingDocumentOutput"), billing.indexOf("function billingTemplateValues"));
    assert.ok(billingOutput.indexOf("renderActiveCustomTemplate") < billingOutput.indexOf("createBillingPdf"));
    const quitusOutput = calendar.slice(calendar.indexOf("export async function createQuitusDocumentOutput"), calendar.indexOf("function quitusTemplateValues"));
    assert.ok(quitusOutput.indexOf("renderActiveCustomTemplate") < quitusOutput.indexOf("createQuitusPdf"));
    const reportOutput = reports.slice(reports.indexOf("export async function createTechnicalReportOutput"), reports.indexOf("export function createLeakReportPdf"));
    assert.ok(reportOutput.indexOf("renderActiveCustomTemplate") < reportOutput.indexOf("createWizardLeakReportPdf"));
});

test("custom billing renderer paginates dynamic lines without a native PDF", async () => {
    const template = { document_type: "quote", source_data: await basePdf(), source_mime_type: "application/pdf", definition: definition([
        zone("number", "text", "document.number", 40, 40, 180, 30),
        zone("client", "text", "client.name", 300, 80, 220, 40),
        zone("lines", "table", "document.lines", 40, 150, 515, 210, "all"),
        zone("total", "text", "document.total", 380, 650, 170, 30, "final")
    ]) };
    const output = await renderCustomDocumentTemplate(template, buildBillingCustomModel(quote, profile));
    const pdf = await PDFDocument.load(output.buffer);
    assert.ok(pdf.getPageCount() >= 3);
    assert.equal(output.buffer.subarray(0, 4).toString(), "%PDF");
});

test("quitus and report models preserve signatures, observations and photos", () => {
    const quitus = buildQuitusCustomModel({ id: 4, clientName: "Client", title: "Intervention", date: "2026-08-17", notes: "RAS" }, { signature: "data:image/png;base64,AAAA" }, profile);
    assert.equal(quitus.document.signature, "data:image/png;base64,AAAA");
    const report = buildReportCustomModel({ id: 8, reportDate: "2026-08-17", content: { snapshot: { insurance: "Assureur", claimNumber: "SIN-1" }, overview: { observations: [{ text: "Observation" }] }, conclusion: { diagnosis: "Diagnostic" }, recommendations: { work: "Réparer", clientSignature: "signature" } }, media: [{ dataUrl: "photo" }] }, profile);
    assert.equal(report.document.observations[0].text, "Observation");
    assert.equal(report.document.photos.length, 1);
    assert.equal(report.document.signature, "signature");
});

test("the visual editor supports import, drag, resize, preview, stress test and activation", () => {
    assert.match(editor, /pointerdown/);
    assert.match(editor, /data-add-field/);
    assert.match(editor, /data-add-fixed/);
    assert.match(editor, /data-preview/);
    assert.match(editor, /data-test/);
    assert.match(editor, /Activer comme modèle par défaut/);
    assert.match(editor, /application\/pdf,image\/png,image\/jpeg/);
});
