import crypto from "node:crypto";

export function reportProofreadingFingerprint(report) {
    const content = report?.content && typeof report.content === "object" && !Array.isArray(report.content) ? structuredClone(report.content) : {};
    delete content.activeStep;
    delete content.activeMaterialId;
    const document = {
        title: String(report?.title || ""),
        reportDate: String(report?.reportDate || ""),
        content,
        media: Array.isArray(report?.media) ? report.media : []
    };
    const hash = crypto.createHash("sha256");
    updateStableHash(hash, document);
    return hash.digest("hex");
}

export function isReportProofreadingCurrent(report) {
    const fingerprint = String(report?.proofreadFingerprint || report?.proofread_fingerprint || "");
    return /^[a-f0-9]{64}$/.test(fingerprint) && fingerprint === reportProofreadingFingerprint(report);
}

function updateStableHash(hash, value) {
    if (Array.isArray(value)) {
        hash.update("[");
        value.forEach((item, index) => { if (index) hash.update(","); updateStableHash(hash, item); });
        hash.update("]");
        return;
    }
    if (value && typeof value === "object") {
        hash.update("{");
        Object.keys(value).sort().forEach((key, index) => { if (index) hash.update(","); hash.update(JSON.stringify(key)); hash.update(":"); updateStableHash(hash, value[key]); });
        hash.update("}");
        return;
    }
    hash.update(JSON.stringify(value) ?? "null");
}
