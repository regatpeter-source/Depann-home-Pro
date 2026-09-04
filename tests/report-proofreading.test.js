import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canConfirmReportProofreading, isReportProofreadingCurrent, reportProofreadingFingerprint } from "../server/report-proofreading.js";
import { normalizeLeakContent } from "../server/leak-report-template.js";

const serverSource = readFileSync(new URL("../server/technical-reports.js", import.meta.url), "utf8");
const schemaSource = readFileSync(new URL("../database/schema.sql", import.meta.url), "utf8");
const originalsMigrationSource = readFileSync(new URL("../database/migrations/0005_technical_report_originals.sql", import.meta.url), "utf8");
const editorSource = readFileSync(new URL("../js/leak-report-wizard.js", import.meta.url), "utf8");
const deliverySource = readFileSync(new URL("../js/document-delivery.js", import.meta.url), "utf8");
const clientsServerSource = readFileSync(new URL("../server/clients.js", import.meta.url), "utf8");
const clientsEditorSource = readFileSync(new URL("../js/clients.js", import.meta.url), "utf8");
const pdfPreviewSource = readFileSync(new URL("../js/pdf-live-preview.js", import.meta.url), "utf8");

function report() {
    return {
        title: "Rapport de recherche de fuite",
        reportDate: "2026-08-08",
        content: {
            schemaVersion: 8,
            activeStep: "overview",
            activeMaterialId: "",
            sectionOrder: ["overview"],
            overview: { observations: [{ id: "observation-1", text: "Aucune fuite visible." }] }
        },
        media: [{ id: "photo-1", caption: "Arrivée d’eau", pdfSize: "large", dataUrl: "data:image/png;base64,AA==" }]
    };
}

test("only authorized administrative roles can confirm report proofreading", () => {
    assert.equal(canConfirmReportProofreading("admin", "desktop"), true);
    assert.equal(canConfirmReportProofreading("pc_standard", "desktop"), true);
    assert.equal(canConfirmReportProofreading("commercial", "desktop"), true);
    assert.equal(canConfirmReportProofreading("commercial", "mobile"), false);
    assert.equal(canConfirmReportProofreading("technician", "desktop"), false);
    assert.equal(canConfirmReportProofreading("team_lead", "desktop"), false);
    assert.equal(canConfirmReportProofreading("admin", "mobile"), false);
});

test("an authorized PC can edit a reopened draft alongside its technician", () => {
    assert.match(serverSource, /isOwnerOrAdministration = \["admin", "mobile_admin"\]\.includes\(request\.user\.role\) \|\| canConfirmReportProofreading\(request\.user\?\.role, request\.user\?\.deviceType\) \|\| Number\(report\.createdBy\) === Number\(request\.user\.sub\)/);
    assert.match(serverSource, /\["draft", "in_correction"\]\.includes\(report\.status\)/);
});

test("proofreading remains current when only editor navigation changes", () => {
    const value = report();
    const fingerprint = reportProofreadingFingerprint(value);
    value.proofreadFingerprint = fingerprint;
    value.content.activeStep = "conclusion";
    value.content.activeMaterialId = "material-1";
    assert.equal(isReportProofreadingCurrent(value), true);
});

test("proofreading fingerprint is independent of object key order", () => {
    const value = report();
    const reordered = { media: value.media, content: { overview: value.content.overview, sectionOrder: value.content.sectionOrder, schemaVersion: 8, activeMaterialId: "", activeStep: "overview" }, reportDate: value.reportDate, title: value.title };
    assert.equal(reportProofreadingFingerprint(reordered), reportProofreadingFingerprint(value));
});

test("report text, media and PDF layout changes invalidate proofreading", () => {
    for (const mutate of [
        value => { value.content.overview.observations[0].text = "Fuite visible."; },
        value => { value.media[0].caption = "Nouvelle légende"; },
        value => { value.media[0].pdfSize = "compact"; },
        value => { value.media.push({ id: "photo-2", dataUrl: "data:image/png;base64,BB==" }); },
        value => { value.title = "Rapport modifié"; }
    ]) {
        const value = report();
        value.proofreadFingerprint = reportProofreadingFingerprint(value);
        mutate(value);
        assert.equal(isReportProofreadingCurrent(value), false);
    }
});

test("final validation retains the private proofreading fingerprint for its server-side check", () => {
    assert.match(serverSource, /findReport\(ownerId, positiveId\(request\.params\.reportId\), request, false, true\)/);
    assert.match(serverSource, /if \(!includeProofreadingFingerprint\) delete value\.proofread_fingerprint/);
    assert.match(serverSource, /if \(!isReportProofreadingCurrent\(report\)\)/);
});

test("administrative proofreading overview includes every photo and all editing controls", () => {
    assert.match(editorSource, /Correction du rapport et aperçu PDF en direct/);
    assert.match(editorSource, /proofreadingAdditionalPhotoGroups\(entries\)/);
    assert.match(editorSource, /photosHtml\(entry\.sectionId, entry\.observation\.id, true/);
    assert.match(editorSource, /data-photo-caption/);
    assert.match(editorSource, /data-photo-pdf-size/);
    assert.match(editorSource, /data-replace-photo/);
    assert.match(editorSource, /data-move-photo/);
    assert.match(editorSource, /data-delete-photo/);
});

test("la photo de présentation reste contenue et centrée dans son cadre PDF", () => {
    const templateSource = readFileSync(new URL("../server/leak-report-template.js", import.meta.url), "utf8");
    const presentation = templateSource.slice(templateSource.indexOf("function addPresentationPhoto"), templateSource.indexOf("function addPhotoWithPage"));
    assert.match(templateSource, /addPresentationPhoto\(pdf, exterior/);
    assert.match(presentation, /roundedRect\(x, y, width, height/);
    assert.match(presentation, /fit: \[width - padding \* 2, height - padding \* 2\]/);
    assert.match(presentation, /align: "center", valign: "center"/);
});

test("proofreading waits for every photo mutation before saving its fingerprint", () => {
    assert.match(editorSource, /trackMediaSave\(deletePhoto/);
    assert.match(editorSource, /trackMediaSave\(movePhoto/);
    assert.match(editorSource, /trackMediaSave\(operation\)/);
    assert.match(editorSource, /await Promise\.all\(\[\.\.\.mediaSavePromises\]\)/);
});

test("administrative proofreading uses a split editor with a live draft PDF preview", () => {
    assert.match(editorSource, /report-proofreading-workspace/);
    assert.match(editorSource, /report-proofreading-live-preview/);
    assert.match(editorSource, /\/pdf-preview/);
    assert.match(editorSource, /queuePdfPreview/);
    assert.match(editorSource, /spellcheck="true"/);
    assert.match(serverSource, /app\.post\("\/api\/technical-reports\/:reportId\/pdf-preview", requireReportProofreadingAccess/);
    assert.match(serverSource, /createTechnicalReportOutput\(draft, profile\)/);
    assert.match(serverSource, /X-Report-Preview-Mode/);
});

test("l’aperçu général ne cadre jamais une réponse HTML ou une erreur 409", () => {
    assert.match(editorSource, /if \(editable\(\) && !await save\(shell, true\)\)/);
    assert.match(editorSource, /response\.headers\.get\("Content-Type"\)/);
    assert.match(editorSource, /contentType\.startsWith\("application\/pdf"\)/);
    assert.match(editorSource, /reportPreviewUrl = URL\.createObjectURL\(blob\)/);
    assert.match(editorSource, /frame\.src = reportPreviewUrl/);
    assert.doesNotMatch(editorSource, /<iframe[^>]+src="\/api\/technical-reports/);
});

test("live PDF refresh waits for photo saves and does not persist proofreading", () => {
    assert.match(editorSource, /await Promise\.all\(\[\.\.\.mediaSavePromises\]\);/);
    assert.match(editorSource, /response\.blob\(\)/);
    assert.match(editorSource, /renderLivePdfPreview\(blob, preview, previewRequest\.signal\)/);
    const previewRoute = serverSource.slice(serverSource.indexOf('app.post("/api/technical-reports/:reportId/pdf-preview"'), serverSource.indexOf('app.post("/api/technical-reports/:reportId/media"'));
    assert.doesNotMatch(previewRoute, /UPDATE depannhome_technical_reports/);
    assert.doesNotMatch(previewRoute, /proofread_fingerprint/);
});

test("live PDF updates preserve the visible page and relative scroll position", () => {
    assert.match(editorSource, /sans perdre la page consultée/);
    assert.match(pdfPreviewSource, /const position = capturePdfPosition\(container\)/);
    assert.match(pdfPreviewSource, /container\.replaceChildren\(documentNode\)/);
    assert.match(pdfPreviewSource, /restorePdfPosition\(container, position\)/);
    assert.match(pdfPreviewSource, /pageProgress/);
    assert.match(pdfPreviewSource, /container\.scrollTop = page\.offsetTop/);
});

test("cancelling live proofreading restores the original report texts", () => {
    assert.match(editorSource, /const cancel = async \(\) => \{ entries\.forEach\(\(entry, index\) => \{ entry\.observation\.text = originalTexts\[index\]; \}\); clearTimeout\(saveTimer\); close\(\); await save\(shell, true\); \}/);
    assert.match(editorSource, /data-close-proofreading[^\n]+cancel\(\)/);
});

test("proofreading preserves intentional line breaks in report observations", () => {
    const content = normalizeLeakContent({ schemaVersion: 8, overview: { observations: [{ id: "observation-1", text: "Première ligne\nDeuxième ligne\n\nConclusion" }] } });
    assert.equal(content.overview.observations[0].text, "Première ligne\nDeuxième ligne\n\nConclusion");
});

test("report directory identifies correction work by client, insurer and claim", () => {
    assert.match(serverSource, /AS "clientName"/);
    assert.match(serverSource, /AS "claimNumber"/);
    assert.match(serverSource, /AS insurance/);
    assert.match(editorSource, /report\.clientName/);
    assert.match(editorSource, /report\.claimNumber/);
    assert.match(editorSource, /report\.insurance/);
});

test("an old empty report snapshot is enriched from current insurer client references", () => {
    assert.match(serverSource, /insuranceDossier: snapshot\.insuranceDossier \|\| client\.insuranceDossier \|\| ""/);
    assert.match(serverSource, /mandateNumber: snapshot\.mandateNumber \|\| client\.mandateNumber \|\| client\.mandate \|\| ""/);
});

test("an administrative workstation can cancel only an unvalidated draft", () => {
    assert.match(serverSource, /app\.delete\("\/api\/technical-reports\/:reportId", requireReportCancellationAccess/);
    assert.match(serverSource, /report\.status !== "draft"/);
    assert.match(serverSource, /DELETE FROM depannhome_partner_mission_items WHERE owner_id=\$1 AND source_type='report'/);
    assert.match(serverSource, /UPDATE depannhome_partner_missions SET technical_report_id=NULL/);
    assert.match(serverSource, /DELETE FROM depannhome_collaboration_locks/);
    assert.match(serverSource, /request\.user\?\.deviceType === "desktop" && \["admin", "pc_standard", "commercial"\]/);
    assert.match(editorSource, /data-cancel-report/);
    assert.match(editorSource, /Annuler la création du rapport/);
    assert.match(editorSource, /method: "DELETE"/);
});

test("validated reports return their client archive and open the client delivery workflow", () => {
    assert.match(serverSource, /archivedAttachment = await archiveDocument/);
    assert.match(serverSource, /attachmentId: archivedAttachment\?\.id/);
    assert.match(serverSource, /return attachment/);
    assert.match(editorSource, /depannhome:open-client/);
    assert.match(editorSource, /attachments\/\$\{encodeURIComponent\(attachmentId\)\}\/email/);
    assert.match(deliverySource, /Envoyer par e-mail/);
    assert.match(deliverySource, /Imprimer \/ PDF/);
    assert.match(deliverySource, /Plus tard/);
});

test("validated report attachments reference the canonical PDF without duplicating base64 in the client", () => {
    const archiveSource = serverSource.slice(serverSource.indexOf("async function archiveDocument"), serverSource.indexOf("export async function createTechnicalReportOutput"));
    assert.match(archiveSource, /reportId: String\(report\.id\)/);
    assert.doesNotMatch(archiveSource, /output\.buffer\.toString\("base64"\)/);
    assert.doesNotMatch(archiveSource, /dossier client est trop volumineux/);
});

test("a validated report can be reopened for a complete correction and validation cycle", () => {
    assert.match(serverSource, /app\.post\("\/api\/technical-reports\/:reportId\/reopen", requireReportProofreadingAccess/);
    assert.match(serverSource, /report\.status !== "validated"/);
    assert.match(serverSource, /findReport\(ownerId, positiveId\(request\.params\.reportId\), request, true\)/);
    assert.match(serverSource, /INSERT INTO depannhome_technical_report_originals/);
    assert.ok(serverSource.indexOf("INSERT INTO depannhome_technical_report_originals") < serverSource.indexOf("SET status='draft', submitted_at=NULL"));
    assert.match(serverSource, /crypto\.createHash\("sha256"\)\.update\(report\.pdfData\)/);
    assert.match(serverSource, /SET status='draft', submitted_at=NULL, proofread_at=NULL, proofread_by=NULL, proofread_fingerprint='', pdf_data=NULL, pdf_filename='', validated_at=NULL, validated_by=NULL/);
    assert.match(serverSource, /preserveReopenedReportOriginalInClient\(connection, ownerId, report, original/);
    assert.match(serverSource, /String\(item\?\.reportId \|\| ""\) === String\(report\.id\)/);
    assert.match(serverSource, /reportOriginalId: String\(original\.id\)/);
    assert.match(serverSource, /type: "technical_report_reopened"/);
    assert.match(serverSource, /partner_visible=FALSE/);
    assert.match(editorSource, /canReopenReport\(\) && current\.status === "validated"/);
    assert.match(editorSource, /Remettre en brouillon/);
    assert.match(editorSource, /copie immuable du PDF original sera conservée/);
});

test("each reopened report keeps an immutable and accessible original copy", () => {
    for (const source of [schemaSource, originalsMigrationSource]) {
        assert.match(source, /CREATE TABLE IF NOT EXISTS depannhome_technical_report_originals/);
        assert.match(source, /UNIQUE \(owner_id, report_id, revision\)/);
        assert.match(source, /pdf_data BYTEA NOT NULL/);
        assert.match(source, /pdf_sha256 CHAR\(64\) NOT NULL/);
        assert.match(source, /CREATE TRIGGER depannhome_technical_report_original_immutable/);
        assert.match(source, /BEFORE UPDATE OR DELETE/);
    }
    assert.match(serverSource, /originals: await loadReportOriginals/);
    assert.match(serverSource, /\/originals\/:originalId\/pdf/);
    assert.match(serverSource, /Ce rapport possède une copie originale immuable et ne peut pas être annulé/);
    assert.match(editorSource, /Copies originales conservées/);
    assert.match(editorSource, /Ouvrir l’original v/);
    assert.match(editorSource, /originals\.length === 0/);
});

test("the client file keeps its original report attachment after reopening", () => {
    assert.match(clientsServerSource, /const reportOriginalId = positiveId\(attachment\?\.reportOriginalId\)/);
    assert.match(clientsServerSource, /FROM depannhome_technical_report_originals original/);
    assert.match(clientsServerSource, /report\.client_id=\$3/);
    assert.match(clientsEditorSource, /reportOriginalId: attachment\.reportOriginalId \|\| ""/);
    assert.match(clientsEditorSource, /reportRevision: Number\(attachment\.reportRevision\) \|\| 0/);
});

test("mobile report preview renders PDF pages without relying on iframe support", () => {
    assert.match(editorSource, /class="report-preview-pages" hidden/);
    assert.match(editorSource, /document\.body\.classList\.contains\("mobile-device"\)/);
    assert.match(editorSource, /await renderLivePdfPreview\(blob, pages\)/);
    assert.match(editorSource, /data-open-report-preview/);
});

test("client attachment delivery supports referenced reports and legacy embedded files", () => {
    assert.match(clientsServerSource, /const embedded = decodeAttachmentDataUrl\(attachment\?\.dataUrl\)/);
    assert.match(clientsServerSource, /client_id = \$3 AND status = 'validated'/);
    assert.match(clientsServerSource, /loadClientAttachmentContent/);
    assert.match(clientsEditorSource, /reportId: String\(attachment\.reportId \|\| ""\)/);
});
