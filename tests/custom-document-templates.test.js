import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { buildBillingCustomModel, buildQuitusCustomModel, buildReportCustomModel, inheritQuoteTemplateForInvoice, renderCustomDocumentTemplate } from "../server/document-templates.js";

const schema = readFileSync(new URL("../database/schema.sql", import.meta.url), "utf8");
const server = readFileSync(new URL("../server/document-templates.js", import.meta.url), "utf8");
const billing = readFileSync(new URL("../server/billing.js", import.meta.url), "utf8");
const billingClient = readFileSync(new URL("../js/billing.js", import.meta.url), "utf8");
const calendar = readFileSync(new URL("../server/calendar.js", import.meta.url), "utf8");
const reports = readFileSync(new URL("../server/technical-reports.js", import.meta.url), "utf8");
const navigation = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
const editor = readFileSync(new URL("../js/document-template-editor.js", import.meta.url), "utf8");

async function basePdf() { const pdf = await PDFDocument.create(); pdf.addPage([595.28, 841.89]); return Buffer.from(await pdf.save()); }
function definition(zones) { return { schemaVersion: 1, page: { width: 595.28, height: 841.89, margins: { top: 30, right: 30, bottom: 30, left: 30 } }, colors: { primary: "#003b73", secondary: "#0a5c36" }, zones }; }
function zone(id, type, field, x, y, width, height, page = "first") { return { id, type, field, text: "", page, x, y, width, height, style: { fontSize: 9, color: "#172033", eraseSource: true, backgroundColor: "#ffffff", borderColor: "#d7dde3", borderWidth: 0, rowHeight: 22, rows: 2, gap: 8 } }; }

const profile = { companyName: "Société Test", address: "1 rue Test", postalCode: "44000", city: "Nantes", phone: "0102030405", email: "test@example.fr", registrationNumber: "123", taxNumber: "FR123" };
const quote = { id: 1, documentType: "quote", documentNumber: "DEV-42", customerName: "Camille", customerAddress: "2 rue Client", issueDate: "2026-08-17", lines: Array.from({ length: 30 }, (_, i) => ({ description: `Ligne ${i + 1}`, quantity: 1, unitPrice: 100 + i, vatRate: 20 })), financialData: {} };

test("templates are versioned, isolated by owner and uniquely active per document type", () => {
    assert.match(schema, /CREATE TABLE IF NOT EXISTS depannhome_document_templates/);
    assert.match(schema, /owner_id BIGINT NOT NULL REFERENCES depannhome_users/);
    assert.match(schema, /document_type IN \('quote','invoice','quitus','report'\)/);
    assert.match(schema, /WHERE status='active'/);
    assert.match(server, /WHERE owner_id=\$1 AND document_type=\$2/);
    assert.match(server, /\$1::bigint,\$2::varchar/);
    assert.match(server, /ON CONFLICT\(owner_id,document_type,version\) DO NOTHING/);
});

test("document settings expose quote, quitus and report while invoice inherits quote", () => {
    assert.doesNotMatch(navigation, /Identité et modèles intégrés/);
    assert.doesNotMatch(navigation, /createSettingsNavigationCard\("Modèle de facture"/);
    assert.match(navigation, /Modèle de devis et facture/);
    assert.match(navigation, /openIntegratedDocumentSettings\(type\)/);
    assert.match(navigation, /Modèle de quitus/);
    assert.match(navigation, /Modèle de rapport/);
    assert.match(server, /new Set\(\["quote", "invoice", "quitus", "report"\]\)/);
});

test("an invoice inherits quote structure while its dynamic fields become invoice fields", () => {
    const inherited = inheritQuoteTemplateForInvoice({ document_type: "quote", definition: definition([
        zone("type", "text", "document.type", 20, 20, 100, 20),
        zone("number", "text", "QUOTE_NUMBER", 20, 50, 100, 20),
        zone("validity", "text", "document.validUntil", 20, 80, 100, 20),
        zone("conditions", "text", "document.conditions", 20, 110, 100, 20)
    ]) });
    assert.equal(inherited.document_type, "invoice");
    assert.deepEqual(inherited.definition.zones.map(item => item.field), ["document.type", "INVOICE_NUMBER", "document.dueDate", "document.payment"]);
});

test("regeneration rebuilds numbers, dates and current client data without mutating the source model", () => {
    const source = structuredClone(quote);
    const first = buildBillingCustomModel(source, profile);
    const second = buildBillingCustomModel({ ...source, documentNumber: "DEV-99", issueDate: "2026-09-01", clientData: { name: "Sophie Martin", address: "20 rue B", postalCode: "75000", city: "Paris", phone: "0600000000" } }, profile);
    assert.equal(first.QUOTE_NUMBER, "DEV-42");
    assert.equal(second.QUOTE_NUMBER, "DEV-99");
    assert.equal(second.document.date, "2026-09-01");
    assert.equal(second.client.name, "Sophie Martin");
    assert.equal(second.client.address, "20 rue B, 75000, Paris");
    assert.equal(source.documentNumber, "DEV-42");
});

test("les modèles personnalisés conservent toutes les références assurance", () => {
    const references = { interventionReference: "INT-P-1", insuranceDossier: "DOS-42", mandateNumber: "MDT-9", claimNumber: "SIN-8", insuredNumber: "SOC-7", principal: "Assureur", manager: "Gestionnaire", expert: "Expert" };
    const billingModel = buildBillingCustomModel({ ...quote, legalData: references }, profile);
    assert.equal(billingModel.document.insuranceDossier, "DOS-42");
    assert.equal(billingModel.document.mandateNumber, "MDT-9");
    for (const [field, value] of Object.entries(references)) assert.equal(billingModel.document[field], value);
    const reportModel = buildReportCustomModel({ id: 8, content: { snapshot: { insuranceDossier: "DOS-42", mandateNumber: "MDT-9", insuredNumber: "SOC-7", principal: "Assureur", manager: "Gestionnaire", expert: "Expert" } } }, profile);
    assert.equal(reportModel.document.insuranceDossier, "DOS-42");
    assert.equal(reportModel.document.mandateNumber, "MDT-9");
    assert.equal(reportModel.document.insuredNumber, "SOC-7");
    const quitusModel = buildQuitusCustomModel({ id: 4, clientData: references, date: "2026-08-17" }, {}, profile);
    assert.equal(quitusModel.document.insuranceDossier, "DOS-42");
    assert.equal(quitusModel.document.mandateNumber, "MDT-9");
    for (const [field, value] of Object.entries(references)) assert.equal(quitusModel.document[field], value);
});

test("invoice data never inherits the quote number", () => {
    const invoice = buildBillingCustomModel({ ...quote, documentType: "invoice", documentNumber: "F-2026-001", dueDate: "2026-09-17" }, profile);
    assert.equal(invoice.INVOICE_NUMBER, "F-2026-001");
    assert.equal(invoice.QUOTE_NUMBER, "");
    assert.equal(invoice.document.number, "F-2026-001");
    assert.equal(invoice.document.type, "FACTURE");
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
    const quitus = buildQuitusCustomModel({ id: 4, clientName: "Client", clientData: { name: "Sophie Martin", phone: "0611223344", address: "20 rue B" }, title: "Intervention", date: "2026-08-17", notes: "RAS" }, { signature: "data:image/png;base64,AAAA" }, profile);
    assert.equal(quitus.document.signature, "data:image/png;base64,AAAA");
    assert.equal(quitus.QUITUS_NUMBER, "4");
    assert.equal(quitus.client.name, "Sophie Martin");
    assert.equal(quitus.client.phone, "0611223344");
    const report = buildReportCustomModel({ id: 8, reportDate: "2026-08-17", content: { snapshot: { insurance: "Assureur", claimNumber: "SIN-1" }, overview: { observations: [{ text: "Observation" }] }, conclusion: { diagnosis: "Diagnostic" }, recommendations: { work: "Réparer", clientSignature: "signature" } }, media: [{ dataUrl: "photo" }] }, profile);
    assert.equal(report.document.observations[0].text, "Observation");
    assert.equal(report.document.photos.length, 1);
    assert.equal(report.document.signature, "signature");
    assert.equal(report.REPORT_NUMBER, "8");
});

test("dynamic zones erase example content before drawing real values", async () => {
    const source = await basePdf();
    const template = { document_type: "quote", source_data: source, source_mime_type: "application/pdf", definition: definition([zone("number", "text", "document.number", 40, 40, 180, 30)]) };
    const output = await renderCustomDocumentTemplate(template, buildBillingCustomModel(quote, profile));
    assert.equal(source.subarray(0, 4).toString(), "%PDF");
    assert.notDeepEqual(output.buffer, source);
    assert.match(server, /if \(zone\.style\.eraseSource\) drawEraseBox\(page, zone, size\)/);
    assert.match(editor, /Masquer l’exemple du PDF dans cette zone/);
});

test("flowing totals erase their original template position before moving", () => {
    assert.match(server, /effectiveZone\.y !== zone\.y && zone\.style\.eraseSource/);
    assert.match(server, /drawEraseBox\(page, zone, pageSize\)/);
    assert.match(editor, /Marge d’effacement/);
});

test("the visual editor supports import, drag, resize, preview, stress test and activation", () => {
    assert.match(editor, /pointerdown/);
    assert.match(editor, /data-add-field/);
    assert.match(editor, /data-add-fixed/);
    assert.match(editor, /data-preview/);
    assert.match(editor, /data-test/);
    assert.match(editor, /Activer comme modèle par défaut/);
    assert.match(editor, /application\/pdf,image\/png,image\/jpeg/);
    assert.match(editor, /Héritage automatique/);
    assert.match(editor, /Modifier le modèle intégré/);
    assert.match(billingClient, /Utiliser ce modèle intégré/);
});
