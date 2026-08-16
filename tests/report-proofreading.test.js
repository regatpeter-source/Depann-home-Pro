import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canConfirmReportProofreading, isReportProofreadingCurrent, reportProofreadingFingerprint } from "../server/report-proofreading.js";
import { normalizeLeakContent } from "../server/leak-report-template.js";

const serverSource = readFileSync(new URL("../server/technical-reports.js", import.meta.url), "utf8");
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

test("only authorized PC roles can confirm report proofreading", () => {
    assert.equal(canConfirmReportProofreading("admin", "desktop"), true);
    assert.equal(canConfirmReportProofreading("pc_standard", "desktop"), true);
    assert.equal(canConfirmReportProofreading("technician", "desktop"), false);
    assert.equal(canConfirmReportProofreading("team_lead", "desktop"), false);
    assert.equal(canConfirmReportProofreading("admin", "mobile"), false);
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

test("PC proofreading overview includes every photo and all editing controls", () => {
    assert.match(editorSource, /Correction du rapport et aperçu PDF en direct/);
    assert.match(editorSource, /proofreadingAdditionalPhotoGroups\(entries\)/);
    assert.match(editorSource, /photosHtml\(entry\.sectionId, entry\.observation\.id, true/);
    assert.match(editorSource, /data-photo-caption/);
    assert.match(editorSource, /data-photo-pdf-size/);
    assert.match(editorSource, /data-replace-photo/);
    assert.match(editorSource, /data-move-photo/);
    assert.match(editorSource, /data-delete-photo/);
});

test("proofreading waits for every photo mutation before saving its fingerprint", () => {
    assert.match(editorSource, /trackMediaSave\(deletePhoto/);
    assert.match(editorSource, /trackMediaSave\(movePhoto/);
    assert.match(editorSource, /trackMediaSave\(operation\)/);
    assert.match(editorSource, /await Promise\.all\(\[\.\.\.mediaSavePromises\]\)/);
});

test("PC proofreading uses a split editor with a live draft PDF preview", () => {
    assert.match(editorSource, /report-proofreading-workspace/);
    assert.match(editorSource, /report-proofreading-live-preview/);
    assert.match(editorSource, /\/pdf-preview/);
    assert.match(editorSource, /queuePdfPreview/);
    assert.match(editorSource, /spellcheck="true"/);
    assert.match(serverSource, /app\.post\("\/api\/technical-reports\/:reportId\/pdf-preview", requireReportProofreadingAccess/);
    assert.match(serverSource, /createWizardLeakReportPdf\(\{ \.\.\.report, title: input\.title, reportDate: input\.reportDate, content: input\.content \}/);
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

test("client attachment delivery supports referenced reports and legacy embedded files", () => {
    assert.match(clientsServerSource, /const embedded = decodeAttachmentDataUrl\(attachment\?\.dataUrl\)/);
    assert.match(clientsServerSource, /client_id = \$3 AND status = 'validated'/);
    assert.match(clientsServerSource, /loadClientAttachmentContent/);
    assert.match(clientsEditorSource, /reportId: String\(attachment\.reportId \|\| ""\)/);
});
