import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildBillingCustomModel, buildQuitusCustomModel, buildReportCustomModel, DOCUMENT_TEMPLATE_FIELDS } from "../server/document-templates.js";

const source = relative => readFileSync(new URL(relative, import.meta.url), "utf8");
const billing = source("../server/billing.js");
const accounting = source("../server/accounting.js");
const calendar = source("../server/calendar.js");
const reports = source("../server/technical-reports.js");
const reportPdf = source("../server/leak-report-template.js");
const templates = source("../server/document-templates.js");
const schema = source("../database/schema.sql");
const partnerDialogue = source("../server/partner-dialogue.js");
const partnerConnections = source("../server/partner-connections.js");

test("billing documents persist and freeze the individual author name", () => {
    assert.match(schema, /created_by_name VARCHAR\(160\) NOT NULL DEFAULT ''/);
    assert.match(billing, /created_by_name AS "creatorName"/);
    assert.match(billing, /created_by_name\)\s*VALUES[\s\S]*cleanText\(request\.user\.fullName \|\| request\.user\.username, 160\)/);
    assert.match(billing, /OLD\.created_by_name/);
    assert.match(billing, /creatorName: document\.creatorName/);
    assert.match(billing, /Établi par : \$\{document\.creatorName\}/);
});

test("quotes, invoices and credits carry the frozen author through every output path", () => {
    assert.match(accounting, /const creatorName = cleanText\(request\.user\.fullName \|\| request\.user\.username, 160\)/);
    assert.match(accounting, /financial_data, created_by_name\)/);
    assert.match(partnerDialogue, /created_by_name AS "creatorName"/);
    assert.match(partnerConnections, /creatorName: document\.created_by_name \|\| ""/);
    const model = buildBillingCustomModel({ documentType: "invoice", documentNumber: "FAC-1", creatorName: "Camille Durand", lines: [] });
    assert.equal(model.document.author, "Camille Durand");
    assert.ok(DOCUMENT_TEMPLATE_FIELDS.quote.includes("document.author"));
    assert.ok(DOCUMENT_TEMPLATE_FIELDS.invoice.includes("document.author"));
});

test("quitus keeps the client signer separate from the professional performer", () => {
    assert.match(schema, /quitus_performed_by BIGINT/);
    assert.match(schema, /quitus_performed_by_name VARCHAR\(160\) NOT NULL DEFAULT ''/);
    assert.match(calendar, /quitus_signed_by = \$3[\s\S]*quitus_performed_by = \$7, quitus_performed_by_name = \$8/);
    assert.match(calendar, /depannhome_protect_validated_quitus/);
    assert.match(calendar, /Intervention réalisée par : \$\{quitus\.performedByName/);
    const model = buildQuitusCustomModel({ id: 9, clientName: "Client Signataire", date: "2026-03-01" }, { signedBy: "Client Signataire", performedByName: "Alex Martin", approved: true }, {});
    assert.equal(model.client.name, "Client Signataire");
    assert.equal(model.document.technician, "Alex Martin");
    assert.ok(DOCUMENT_TEMPLATE_FIELDS.quitus.includes("document.technician"));
});

test("technical reports retain and render their creator snapshot", () => {
    assert.match(reports, /created_by_name VARCHAR\(160\) NOT NULL DEFAULT ''/);
    assert.match(reports, /INSERT INTO depannhome_technical_reports \(owner_id, created_by, created_by_name/);
    assert.match(reportPdf, /\["Réalisé par", report\.createdByName/);
    const model = buildReportCustomModel({ id: 7, createdByName: "Nora Petit", technicianName: "Profil modifié", content: { snapshot: { technicianName: "Nom historique" } } });
    assert.equal(model.document.technician, "Nora Petit");
    assert.ok(DOCUMENT_TEMPLATE_FIELDS.report.includes("document.technician"));
});

test("legacy custom templates receive a labelled attribution fallback", () => {
    assert.match(templates, /const hasAttributionZone =/);
    assert.match(templates, /stampDocumentAttribution\(output\.buffer, documentTypeValue, attribution\)/);
    assert.match(templates, /\? "Établi par" : "Réalisé par"/);
});
