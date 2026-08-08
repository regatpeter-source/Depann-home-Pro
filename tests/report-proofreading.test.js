import test from "node:test";
import assert from "node:assert/strict";
import { isReportProofreadingCurrent, reportProofreadingFingerprint } from "../server/report-proofreading.js";

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
