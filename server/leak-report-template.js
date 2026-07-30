import PDFDocument from "pdfkit";

export const REPORT_STEPS = [
    ["general", "Informations générales"], ["overview", "État des lieux"], ["visual", "Observations visuelles"], ["humidity", "Contrôle d’humidité"], ["pressure", "Contrôle des manomètres de pression"], ["methods", "Moyens techniques utilisés"], ["waterTest", "Test d’étanchéité à l’eau claire / colorant"], ["charging", "Mise en charge"], ["safety", "Mise en sécurité"], ["ventilation", "Contrôle de la ventilation"], ["conclusion", "Conclusion"], ["recommendations", "Préconisations et signatures"]
];
export const REPORT_STEP_KEYS = REPORT_STEPS.map(([key]) => key);
export const DEFAULT_MATERIALS = ["Gaz traceur", "Contrôle acoustique", "Caméra endoscopique", "Traçage de réseau", "Fumigation", "Caméra thermique", "Détecteur électronique", "Colorant fluorescent", "Inspection vidéo", "Autre matériel"];

export function createEmptyLeakContent(snapshot = {}) {
    return { schemaVersion: 2, activeStep: "overview", skippedSteps: [], snapshot, general: {}, overview: { disorders: "", location: "", rooms: "", observations: "" }, visual: { observations: "", defects: "", comments: "" }, humidity: { readings: [], location: "", observations: "" }, pressure: { readings: [], holdingTime: "", variation: "", comments: "" }, methods: { items: [] }, waterTest: { testType: "", result: "", observations: "", comments: "" }, charging: { pressure: "", duration: "", result: "", observations: "" }, safety: { actions: "", measures: "", observations: "" }, ventilation: { checks: "", observations: "", comments: "" }, conclusion: { diagnosis: "", probableOrigin: "", summary: "", finalObservations: "" }, recommendations: { work: "", repairs: "", urgency: "", customerAdvice: "", technicianSignature: "", clientSignature: "", clientName: "", signedAt: "" } };
}

export function normalizeLeakContent(value, snapshot = {}) {
    const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    if (!input.schemaVersion && (input.cover || input.leakSearch || input.measurements)) return normalizeLeakContent({ schemaVersion: 2, activeStep: "overview", snapshot: { insurance: input.cover?.insurance || "", claimNumber: input.cover?.claimNumber || "", interventionReference: input.cover?.interventionReference || "" }, overview: { disorders: input.overview?.generalDescription || "", location: input.location?.preciseLocation || "", rooms: "", observations: [input.overview?.customerHistory, input.overview?.context, input.overview?.interventionConditions].filter(Boolean).join("\n") }, visual: { observations: input.visual?.observations || "", defects: input.visual?.anomalies || "", comments: "" }, humidity: { readings: input.measurements?.rows || [], location: "", observations: "" }, pressure: { readings: input.finalControl?.rows || [], holdingTime: "", variation: "", comments: input.finalControl?.tightness || "" }, methods: { items: (input.leakSearch?.methods || []).map(item => ({ name: item.name, observations: item.observations, result: item.result, comments: item.comments })) }, waterTest: { testType: "", result: "", observations: "", comments: "" }, charging: { pressure: "", duration: "", result: "", observations: "" }, safety: { actions: "", measures: "", observations: "" }, ventilation: { checks: "", observations: "", comments: "" }, conclusion: { diagnosis: input.location?.description || "", probableOrigin: input.location?.comments || "", summary: input.work?.repair || "", finalObservations: input.work?.tests || "" }, recommendations: { work: input.conclusion?.recommendations || "", repairs: input.work?.replacement || "", urgency: "", customerAdvice: "", technicianSignature: input.signatures?.technician || "", clientSignature: input.signatures?.client || "", clientName: input.signatures?.clientName || "", signedAt: input.signatures?.signedAt || "" } }, snapshot);
    const content = createEmptyLeakContent(input.snapshot && typeof input.snapshot === "object" ? input.snapshot : snapshot);
    for (const key of REPORT_STEP_KEYS) if (input[key] && typeof input[key] === "object" && !Array.isArray(input[key])) content[key] = { ...content[key], ...input[key] };
    content.activeStep = REPORT_STEP_KEYS.includes(input.activeStep) ? input.activeStep : "overview";
    content.skippedSteps = [...new Set((Array.isArray(input.skippedSteps) ? input.skippedSteps : []).filter(key => REPORT_STEP_KEYS.includes(key) && key !== "general"))].slice(0, REPORT_STEP_KEYS.length);
    content.humidity.readings = sanitizeRows(content.humidity.readings, ["location", "value", "unit"]);
    content.pressure.readings = sanitizeRows(content.pressure.readings, ["label", "value", "unit"]);
    content.methods.items = (Array.isArray(content.methods.items) ? content.methods.items : []).slice(0, 40).map(item => ({ name: text(item?.name, 120), observations: text(item?.observations, 2000), result: text(item?.result, 2000), comments: text(item?.comments, 2000) }));
    for (const step of REPORT_STEP_KEYS) for (const [field, fieldValue] of Object.entries(content[step] || {})) if (typeof fieldValue === "string") content[step][field] = text(fieldValue, field.includes("Signature") ? 700000 : 5000);
    return JSON.parse(JSON.stringify(content).slice(0, 120000));
}

export function sectionHasContent(content, media, key) {
    if (key === "general") return true;
    if ((media || []).some(item => item.section === key)) return true;
    const value = content?.[key] || {};
    return Object.entries(value).some(([field, item]) => field !== "technicianSignature" && field !== "clientSignature" && (Array.isArray(item) ? item.length : typeof item === "string" ? Boolean(item.trim()) : Boolean(item)));
}

export function createLeakReportPdf(report, profile) {
    return new Promise((resolve, reject) => {
        const pdf = new PDFDocument({ size: "A4", margin: 44, bufferPages: true, info: { Title: report.title, Author: profile.companyName || "Depann'Home Pro" } });
        const chunks = []; pdf.on("data", chunk => chunks.push(chunk)); pdf.on("end", () => resolve(Buffer.concat(chunks))); pdf.on("error", reject);
        const content = normalizeLeakContent(report.content); const media = report.media || []; const snapshot = content.snapshot || {};
        addGeneralPage(pdf, report, profile, snapshot);
        for (const [key, label] of REPORT_STEPS.slice(1)) if (sectionHasContent(content, media, key)) addStepPage(pdf, key, label, content[key], media.filter(photo => photo.section === key));
        addPageNumbers(pdf); pdf.end();
    });
}

function addGeneralPage(pdf, report, profile, snapshot) {
    const hasLogo = Boolean(profile.logoData && ["image/png", "image/jpeg"].includes(profile.logoMimeType));
    if (hasLogo) { try { pdf.image(profile.logoData, 44, 44, { fit: [56, 56] }); } catch {} }
    const companyX = hasLogo ? 112 : 44;
    pdf.fillColor("#172033").font("Helvetica").fontSize(9).text([snapshot.companyName || profile.companyName, snapshot.companyAddress || [profile.address, profile.postalCode, profile.city].filter(Boolean).join(" "), snapshot.companyPhone || profile.phone, snapshot.companyEmail || profile.email].filter(Boolean).join("\n"), companyX, 44, { width: 235, lineGap: 2 });
    title(pdf, "RAPPORT DE RECHERCHE DE FUITE", 300, 44, 251, 18); pdf.font("Helvetica").fontSize(9).fillColor("#475569").text(`Rapport n° ${report.id}`, 300, 68, { width: 251, align: "right" });
    pdf.moveTo(44, 120).lineTo(551, 120).strokeColor("#cbd5e1").stroke();
    block(pdf, "ENTREPRISE", [snapshot.companyName || profile.companyName, snapshot.companyAddress || [profile.address, profile.postalCode, profile.city].filter(Boolean).join(" "), snapshot.companyPhone || profile.phone, snapshot.companyEmail || profile.email].filter(Boolean), 44, 132, 225);
    block(pdf, "INTERVENTION", [`N° intervention : ${snapshot.interventionNumber || report.appointmentId || "—"}`, `Type : ${snapshot.interventionType || "Intervention"}`, `Date : ${snapshot.date || report.reportDate || "—"}${snapshot.time ? ` · ${snapshot.time}` : ""}`, snapshot.interventionReference ? `Référence : ${snapshot.interventionReference}` : "", snapshot.claimNumber ? `Sinistre : ${snapshot.claimNumber}` : "", snapshot.insurance ? `Assurance : ${snapshot.insurance}` : ""].filter(Boolean), 315, 132, 236);
    block(pdf, "CLIENT", [snapshot.clientName || report.clientName, snapshot.clientAddress || report.clientAddress || report.appointmentLocation, snapshot.clientPhone || report.clientPhone, snapshot.clientEmail, snapshot.expert ? `Expert : ${snapshot.expert}` : "", snapshot.manager ? `Gestionnaire : ${snapshot.manager}` : ""].filter(Boolean), 44, 290, 225);
    block(pdf, "TECHNICIEN", [snapshot.technicianName || report.technicianName || "Non renseigné", snapshot.technicianPhone || ""].filter(Boolean), 315, 290, 236);
    pdf.fillColor("#64748b").font("Helvetica").fontSize(9).text("Informations générées automatiquement à partir de l’intervention et du dossier client.", 44, 470, { width: 507, align: "center" });
}
function addStepPage(pdf, key, label, values, photos) {
    pdf.addPage(); title(pdf, label, 44, 45, 507, 19); let y = 82;
    if (key === "humidity" || key === "pressure") { y = addTable(pdf, values.readings, key === "humidity" ? ["Localisation", "Valeur", "Unité"] : ["Repère", "Valeur", "Unité"], y); for (const [labelText, value] of Object.entries(values).filter(([name]) => name !== "readings")) y = addField(pdf, pretty(labelText), value, y); }
    else if (key === "methods") { for (const item of values.items || []) { pdf.fillColor("#003b73").font("Helvetica-Bold").fontSize(11).text(item.name || "Matériel technique", 44, y); y += 18; for (const [name, value] of Object.entries(item).filter(([name]) => name !== "name")) y = addField(pdf, pretty(name), value, y); y += 6; } }
    else for (const [field, value] of Object.entries(values || {})) if (!field.toLowerCase().includes("signature") && field !== "clientName" && field !== "signedAt") y = addField(pdf, pretty(field), value, y);
    y = addPhotos(pdf, photos, y);
    if (key === "recommendations") addSignatures(pdf, values, y);
}
function addField(pdf, label, value, y) { if (!String(value || "").trim()) return y; if (y > 690) { pdf.addPage(); y = 52; } pdf.fillColor("#003b73").font("Helvetica-Bold").fontSize(9).text(label, 44, y); y += 14; pdf.fillColor("#172033").font("Helvetica").fontSize(10).text(String(value), 44, y, { width: 507, lineGap: 3 }); return pdf.y + 13; }
function addTable(pdf, rows, labels, y) { const valid = (rows || []).filter(row => Object.values(row || {}).some(value => String(value || "").trim())); if (!valid.length) return y; pdf.fillColor("#003b73").font("Helvetica-Bold").fontSize(9); labels.forEach((label, index) => pdf.text(label, 44 + index * 170, y, { width: 160 })); y += 18; valid.forEach(row => { if (y > 700) { pdf.addPage(); y = 52; } pdf.rect(44, y - 3, 507, 24).fill("#f1f5f9"); Object.values(row).slice(0, 3).forEach((value, index) => pdf.fillColor("#172033").font("Helvetica").fontSize(9).text(String(value || "—"), 50 + index * 170, y + 3, { width: 158 })); y += 28; }); return y + 10; }
function addPhotos(pdf, photos, y) { for (const photo of photos.slice(0, 20)) { if (y > 530) { pdf.addPage(); y = 48; } try { pdf.image(dataUrl(photo.dataUrl), 44, y, { fit: [507, 260] }); } catch { continue; } pdf.fillColor("#475569").font("Helvetica").fontSize(8).text([photo.caption, photo.annotation].filter(Boolean).join(" · ") || photo.name || "Photo", 44, y + 264, { width: 507 }); y += 288; } return y; }
function addSignatures(pdf, values, y) { y = Math.max(y + 12, 505); [["Signature du technicien", values.technicianSignature], ["Signature du client", values.clientSignature]].forEach(([label, signature], index) => { const x = 44 + index * 260; pdf.fillColor("#003b73").font("Helvetica-Bold").fontSize(9).text(label, x, y); pdf.rect(x, y + 18, 240, 105).strokeColor("#cbd5e1").stroke(); if (signature) try { pdf.image(dataUrl(signature), x + 8, y + 26, { fit: [220, 85] }); } catch {} }); }
function addPageNumbers(pdf) { const range = pdf.bufferedPageRange(); for (let index = 0; index < range.count; index += 1) { pdf.switchToPage(index); pdf.fillColor("#64748b").font("Helvetica").fontSize(8).text(`Page ${index + 1} / ${range.count}`, 44, 795, { width: 507, align: "center" }); } }
function block(pdf, heading, lines, x, y, width) { pdf.fillColor("#003b73").font("Helvetica-Bold").fontSize(9).text(heading, x, y); pdf.fillColor("#172033").font("Helvetica").fontSize(10).text(lines.join("\n"), x, y + 17, { width, lineGap: 4 }); }
function title(pdf, value, x, y, width, size) { pdf.fillColor("#003b73").font("Helvetica-Bold").fontSize(size).text(value, x, y, { width }); }
function pretty(value) { return ({ disorders: "Description des désordres", rooms: "Pièces concernées", checks: "Vérifications réalisées", probableOrigin: "Origine probable de la fuite", work: "Travaux recommandés", customerAdvice: "Conseils au client", holdingTime: "Temps de maintien", testType: "Type de test" })[value] || String(value).replace(/([A-Z])/g, " $1").replace(/^./, char => char.toUpperCase()); }
function sanitizeRows(rows, fields) { return (Array.isArray(rows) ? rows : []).slice(0, 100).map(row => Object.fromEntries(fields.map(field => [field, text(row?.[field], 500)]))); }
function text(value, max) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, max); }
function dataUrl(value) { const match = /^data:[^;,]+;base64,([a-zA-Z0-9+/=]+)$/.exec(String(value || "")); if (!match) throw new Error("Média invalide"); return Buffer.from(match[1], "base64"); }
