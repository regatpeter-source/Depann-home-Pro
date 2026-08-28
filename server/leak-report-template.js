import PDFDocument from "pdfkit";

export const REPORT_STEPS = [
    ["general", "Informations générales"], ["presentation", "Rapport de recherche de fuite"], ["overview", "État des lieux"], ["visual", "Observations visuelles"], ["humidity", "Contrôle d’humidité"], ["pressure", "Contrôle des manomètres de pression"], ["methods", "Matériels techniques utilisés"], ["waterTest", "Test d’étanchéité à l’eau claire / colorant"], ["charging", "Mise en charge"], ["safety", "Mise en sécurité"], ["ventilation", "Contrôle de la ventilation"], ["conclusion", "Conclusion"], ["recommendations", "Préconisations"]
];
export const REPORT_STEP_KEYS = REPORT_STEPS.map(([key]) => key);
export const DEFAULT_MATERIALS = ["Gaz traceur", "Contrôle acoustique", "Caméra endoscopique", "Caméra thermique", "Traçage réseau", "Fumigation", "Colorant", "Détecteur d’humidité", "Thermomètre infrarouge", "Autre matériel"];
const CONCLUSION_INTRO = "Suite à notre investigation, nous pouvons mettre en évidence :";
const RECOMMENDATION_INTRO = "Nous préconisons :";
const DEFAULT_TEMPLATE = { primaryColor: "#003b73", secondaryColor: "#0a5c36", titleColor: "#003b73", separatorColor: "#0a5c36", font: "Helvetica", footerFields: ["address", "phone", "email", "website", "siret", "vat", "legalNotice"] };
const CONTENT_TOP = 126;
const CONTENT_BOTTOM = 748;
const PHOTO_LAYOUTS = Object.freeze({
    compact: { width: 300, maxHeight: 125 },
    medium: { width: 410, maxHeight: 180 },
    large: { width: 507, maxHeight: 235 }
});

export function createEmptyLeakContent(snapshot = {}) {
    return { schemaVersion: 8, activeStep: "overview", activeMaterialId: "", skippedSteps: [], sectionOrder: [...REPORT_STEP_KEYS], sectionTitles: {}, removedSections: [], customSections: [], snapshot, general: { observations: [] }, presentation: { observations: [] }, overview: { disorders: "", location: "", rooms: "", observations: [] }, visual: { defects: "", comments: "", observations: [] }, humidity: { readings: [], location: "", observations: [] }, pressure: { readings: [], holdingTime: "", variation: "", comments: "", observations: [] }, methods: { materials: [], items: [], observations: [] }, waterTest: { testType: "", result: "", comments: "", observations: [] }, charging: { pressure: "", duration: "", result: "", observations: [] }, safety: { actions: "", measures: "", observations: [] }, ventilation: { checks: "", comments: "", observations: [] }, conclusion: { diagnosis: "", probableOrigin: "", summary: "", finalObservations: "", observations: [{ id: "conclusion-intro", text: CONCLUSION_INTRO, createdAt: "", keepTogether: true, pageBreakBefore: false }] }, recommendations: { work: "", repairs: "", urgency: "", customerAdvice: "", technicianSignature: "", clientSignature: "", clientName: "", signedAt: "", observations: [{ id: "recommendations-intro", text: RECOMMENDATION_INTRO, createdAt: "", keepTogether: true, pageBreakBefore: false }] } };
}

export function normalizeLeakContent(value, snapshot = {}) {
    const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    if (!input.schemaVersion && (input.cover || input.leakSearch || input.measurements)) return normalizeLeakContent({ schemaVersion: 2, activeStep: "overview", snapshot: { insurance: input.cover?.insurance || "", claimNumber: input.cover?.claimNumber || "", interventionReference: input.cover?.interventionReference || "" }, overview: { disorders: input.overview?.generalDescription || "", location: input.location?.preciseLocation || "", observations: [input.overview?.customerHistory, input.overview?.context, input.overview?.interventionConditions].filter(Boolean).join("\n") }, visual: { observations: input.visual?.observations || "", defects: input.visual?.anomalies || "" }, humidity: { readings: input.measurements?.rows || [] }, pressure: { readings: input.finalControl?.rows || [], comments: input.finalControl?.tightness || "" }, methods: { items: input.leakSearch?.methods || [] }, conclusion: { diagnosis: input.location?.description || "", probableOrigin: input.location?.comments || "", summary: input.work?.repair || "", finalObservations: input.work?.tests || "" }, recommendations: { work: input.conclusion?.recommendations || "", repairs: input.work?.replacement || "", technicianSignature: input.signatures?.technician || "", clientSignature: input.signatures?.client || "", clientName: input.signatures?.clientName || "", signedAt: input.signatures?.signedAt || "" } }, snapshot);
    const content = createEmptyLeakContent(input.snapshot && typeof input.snapshot === "object" ? input.snapshot : snapshot);
    for (const key of REPORT_STEP_KEYS) if (input[key] && typeof input[key] === "object" && !Array.isArray(input[key])) content[key] = { ...content[key], ...input[key] };
    content.schemaVersion = 8;
    content.customSections = normalizeCustomSections(input.customSections);
    const customIds = content.customSections.map(section => section.id);
    const knownSectionIds = [...REPORT_STEP_KEYS, ...customIds];
    content.sectionTitles = Object.fromEntries(REPORT_STEPS.map(([key]) => [key, text(input.sectionTitles?.[key], 160)]).filter(([, title]) => title));
    delete content.sectionTitles.presentation;
    content.removedSections = [...new Set((Array.isArray(input.removedSections) ? input.removedSections : []).filter(key => knownSectionIds.includes(key) && !["general", "presentation"].includes(key)))].slice(0, knownSectionIds.length);
    content.sectionOrder = orderedSectionIds(input.sectionOrder, knownSectionIds);
    content.activeStep = knownSectionIds.includes(input.activeStep) && !content.removedSections.includes(input.activeStep) ? input.activeStep : content.sectionOrder.find(key => !content.removedSections.includes(key) && key !== "general") || "general";
    content.skippedSteps = [...new Set((Array.isArray(input.skippedSteps) ? input.skippedSteps : []).filter(key => REPORT_STEP_KEYS.includes(key) && key !== "general" && key !== "conclusion" && key !== "recommendations"))].slice(0, REPORT_STEP_KEYS.length);
    content.humidity.readings = sanitizeRows(content.humidity.readings, ["location", "value", "unit"]);
    content.pressure.readings = sanitizeRows(content.pressure.readings, ["label", "value", "unit"]);
    content.methods.items = (Array.isArray(content.methods.items) ? content.methods.items : []).slice(0, 40).map(item => ({ name: text(item?.name, 120), observations: text(item?.observations, 2000), result: text(item?.result, 2000), comments: text(item?.comments, 2000) }));
    const legacy = Number(input.schemaVersion || 2) < 3;
    for (const step of REPORT_STEP_KEYS) content[step].observations = normalizeObservations(legacy ? legacyObservation(content[step]) : content[step].observations);
    delete content.presentation.introText;
    content.methods.materials = normalizeMaterials(input.methods?.materials, content.methods);
    content.activeMaterialId = content.methods.materials.some(item => item.id === input.activeMaterialId) ? input.activeMaterialId : "";
    ensureIntro(content.conclusion, "conclusion-intro", CONCLUSION_INTRO);
    ensureIntro(content.recommendations, "recommendations-intro", RECOMMENDATION_INTRO);
    for (const step of REPORT_STEP_KEYS) for (const [field, fieldValue] of Object.entries(content[step] || {})) if (typeof fieldValue === "string") content[step][field] = text(fieldValue, field.includes("Signature") ? 700000 : 5000);
    return JSON.parse(JSON.stringify(content));
}

export function reportSections(content, includeRemoved = false) {
    const normalized = normalizeLeakContent(content);
    const custom = new Map(normalized.customSections.map(section => [section.id, section]));
    return normalized.sectionOrder.map(id => {
        const definition = REPORT_STEPS.find(([key]) => key === id);
        const duplicate = custom.get(id);
        const sourceKey = duplicate?.sourceKey || id;
        const defaultTitle = duplicate?.title || definition?.[1] || "Section";
        return { id, sourceKey, title: normalized.sectionTitles[id] || defaultTitle, custom: Boolean(duplicate), content: duplicate?.content || normalized[id], removed: normalized.removedSections.includes(id) };
    }).filter(section => includeRemoved || !section.removed);
}

export function sectionHasContent(content, media, key) {
    const section = reportSections(content, true).find(item => item.id === key);
    if (section?.custom) return (media || []).some(item => item.section === key) || section.content.observations.some(item => item.text);
    if (["general", "presentation", "conclusion", "recommendations"].includes(key)) return true;
    if (key === "methods") return Array.isArray(content?.methods?.materials) && content.methods.materials.length > 0;
    if ((media || []).some(item => item.section === key)) return true;
    const value = content?.[key] || {};
    return Object.entries(value).some(([field, item]) => field !== "technicianSignature" && field !== "clientSignature" && (Array.isArray(item) ? item.some(entry => entry?.text && entry.text !== CONCLUSION_INTRO && entry.text !== RECOMMENDATION_INTRO) : typeof item === "string" ? Boolean(item.trim()) : Boolean(item)));
}

export function createLeakReportPdf(report, profile = {}) {
    return new Promise((resolve, reject) => {
        const pdf = new PDFDocument({ size: "A4", margin: 44, bufferPages: true, info: { Title: report.title || "Rapport de recherche de fuite", Author: profile.companyName || "Depann'Home Pro" } });
        const chunks = []; pdf.on("data", chunk => chunks.push(chunk)); pdf.on("end", () => resolve(Buffer.concat(chunks))); pdf.on("error", reject);
        const content = normalizeLeakContent(report.content); const media = Array.isArray(report.media) ? report.media : []; const template = reportTemplate(profile); const snapshot = content.snapshot || {};
        const coverPhotos = [
            ...orderedPhotos(media.filter(photo => photo.section === "presentation")),
            ...orderedPhotos(media.filter(photo => photo.section === "general"))
        ];
        addCover(pdf, report, profile, template, snapshot, coverPhotos);
        for (const section of reportSections(content).filter(item => !["general", "presentation"].includes(item.id))) {
            if (section.id === "methods" && !section.custom) {
                for (const material of content.methods.materials || []) addSection(pdf, materialLabel(material), { observations: material.observations }, media.filter(photo => photo.section === "methods" && photo.materialId === material.id), profile, template);
            } else if (sectionHasContent(content, media, section.id) || ["conclusion", "recommendations"].includes(section.id)) {
                addSection(pdf, section.title, section.content, media.filter(photo => photo.section === section.id), profile, template, section.id === "recommendations", report.createdByName || snapshot.technicianName || report.technicianName || "");
            }
        }
        decoratePages(pdf, profile, template); pdf.end();
    });
}

function addCover(pdf, report, profile, template, snapshot, photos) {
    addCompanyHeader(pdf, profile, template, 44);
    pdf.moveTo(44, 104).lineTo(551, 104).lineWidth(1.5).strokeColor(template.separatorColor).stroke();
    const clientName = snapshot.clientName || report.clientName || "Non renseigné";
    const location = snapshot.clientAddress || report.clientAddress || report.appointmentLocation || "Non renseigné";
    const interventionDate = `${snapshot.date || report.reportDate || "—"}${snapshot.time ? ` · ${snapshot.time}` : ""}`;
    const facts = [
        ["Référence intervention", snapshot.interventionReference || snapshot.interventionType || "Non renseignée"],
        ["N° de service", snapshot.interventionNumber || report.appointmentId || "—"],
        ["Bénéficiaire", clientName],
        ["Lieu d’intervention", location],
        ["Dossier assurance", snapshot.insuranceDossier || "Non renseigné"],
        ["Mandat", snapshot.mandateNumber || "Non renseigné"],
        ["Sinistre / assurance", [snapshot.claimNumber, snapshot.insurance].filter(Boolean).join(" · ") || "Non renseigné"],
        ["N° sociétaire / assuré", snapshot.insuredNumber || "Non renseigné"],
        ["Mandant / donneur d’ordre", snapshot.principal || "Non renseigné"],
        ["Gestionnaire / Expert", [snapshot.manager, snapshot.expert].filter(Boolean).join(" · ") || "Non renseigné"],
        ["Le", interventionDate],
        ["Réalisé par", report.createdByName || snapshot.technicianName || report.technicianName || "Non renseigné"]
    ];
    const factsBottom = addCoverFacts(pdf, facts, 118, template);
    const titleY = factsBottom + 18;
    centeredTitle(pdf, "RAPPORT DE RECHERCHE DE FUITE", titleY, template, 20);
    const exterior = photos[0];
    if (exterior) {
        const photoY = titleY + 46;
        const captionHeight = photoCaptionHeight(pdf, exterior, 507, template);
        const availableHeight = Math.max(80, 748 - photoY - captionHeight);
        addPhoto(pdf, exterior, photoY, 320, Math.min(275, availableHeight), template);
    }
}

function addSection(pdf, title, values, photos, profile, template, isRecommendations = false, technicianName = "") {
    pdf.addPage(); addCompanyHeader(pdf, profile, template, 44); centeredTitle(pdf, title, 104, template, 20); pdf.moveTo(44, 136).lineTo(551, 136).lineWidth(2).strokeColor(template.separatorColor).stroke();
    let y = 160; const observations = Array.isArray(values?.observations) ? values.observations : [];
    for (const [index, observation] of observations.entries()) {
        const displayText = text(observation.text, 5000); if (!displayText) continue;
        const observationPhotos = orderedPhotos(photos.filter(photo => photo.observationId === observation.id));
        if (observation.pageBreakBefore && index > 0) y = addContentPage(pdf, profile, template);
        const textHeight = observationTextHeight(pdf, displayText, observations.length > 1, template);
        const photoHeights = observationPhotos.map(photo => photoBlockHeight(pdf, photo, template));
        const completeHeight = textHeight + photoHeights.reduce((total, height) => total + height, 0) + 10;
        const firstPhotoHeight = photoHeights[0] || 0;
        const minimumGroupedHeight = Math.min(CONTENT_BOTTOM - CONTENT_TOP, textHeight + firstPhotoHeight);
        const requestedHeight = observation.keepTogether && completeHeight <= CONTENT_BOTTOM - CONTENT_TOP ? completeHeight : minimumGroupedHeight;
        y = ensureSpace(pdf, y, Math.max(70, requestedHeight), profile, template);
        if (observations.length > 1) { pdf.font(template.font).fillColor(template.titleColor).fontSize(10).text(`Observation ${index + 1}`, 44, y); y += 18; }
        pdf.font(template.font).fillColor("#172033").fontSize(10.5).text(displayText, 44, y, { width: 507, lineGap: 4 }); y = pdf.y + 16;
        for (const photo of observationPhotos) y = addPhotoWithPage(pdf, photo, y, profile, template);
        y += 10;
    }
    y = addStructuredFields(pdf, values, y, profile, template);
    if (!observations.length) for (const photo of orderedPhotos(photos)) y = addPhotoWithPage(pdf, photo, y, profile, template);
    else for (const photo of orderedPhotos(photos.filter(photo => !photo.observationId))) y = addPhotoWithPage(pdf, photo, y, profile, template);
    y = addSignatures(pdf, values, y, profile, template);
    if (isRecommendations) addCourtesy(pdf, y, technicianName, template, profile);
}

function addCompanyHeader(pdf, profile, template, y) {
    const company = companyLines(profile, template); const hasLogo = imageBuffer(profile.logoData); if (hasLogo) try { pdf.image(hasLogo, 44, y, { fit: [72, 48] }); } catch {}
    pdf.font(template.font).fillColor("#334155").fontSize(8.5).text(company.join("\n"), hasLogo ? 128 : 44, y + 2, { width: 260, lineGap: 2 });
    if (template.headerText) pdf.fillColor(template.secondaryColor).fontSize(8).text(template.headerText, 360, y + 12, { width: 191, align: "right" });
}
function centeredTitle(pdf, value, y, template, size) { pdf.font(template.font).fillColor(template.titleColor).fontSize(size).text(value, 44, y, { width: 507, align: "center" }); }
function addCoverFacts(pdf, facts, y, template) { let cursor = y; for (const [label, value] of facts) { const textValue = text(value, 500); pdf.font(template.font).fillColor("#334155").fontSize(9.5).text(`${label} :`, 44, cursor, { width: 132, continued: true }); pdf.fillColor("#172033").text(` ${textValue}`, { width: 375 }); cursor = Math.max(cursor + 15, pdf.y + 4); } return cursor; }
function addInfoGrid(pdf, entries, y, template) { let cursor = y; for (let index = 0; index < entries.length; index += 2) { const row = entries.slice(index, index + 2); row.forEach(([label, value], column) => { const x = 44 + column * 258; pdf.roundedRect(x, cursor, 249, 43, 5).fillAndStroke("#f8fafc", "#dbe4ee"); pdf.font(template.font).fillColor(template.titleColor).fontSize(7.5).text(label, x + 10, cursor + 7); pdf.fillColor("#172033").fontSize(9).text(value, x + 10, cursor + 19, { width: 229, height: 16, ellipsis: true }); }); cursor += 51; } }
function addPhotoWithPage(pdf, photo, y, profile, template) { const layout = photoLayout(photo); const blockHeight = photoBlockHeight(pdf, photo, template); y = ensureSpace(pdf, y, blockHeight, profile, template); return addPhoto(pdf, photo, y, layout.width, layout.maxHeight, template) + 18; }
function addPhoto(pdf, photo, y, width, maxHeight, template) { try { const buffer = dataUrl(photo.dataUrl); const dimensions = pdf.openImage(buffer); const ratio = Math.min(width / dimensions.width, maxHeight / dimensions.height); const renderedWidth = dimensions.width * ratio; const renderedHeight = dimensions.height * ratio; const x = 44 + (507 - renderedWidth) / 2; pdf.image(buffer, x, y, { width: renderedWidth, height: renderedHeight }); const caption = photoCaption(photo); if (!caption) return y + renderedHeight; const captionY = y + renderedHeight + 7; pdf.font(template.font).fillColor("#475569").fontSize(8.5).text(caption, 44, captionY, { width: 507, align: "center", lineGap: 2 }); return pdf.y; } catch { return y; } }
function photoCaptionHeight(pdf, photo, width, template) { const caption = photoCaption(photo); if (!caption) return 0; return pdf.font(template.font).fontSize(8.5).heightOfString(caption, { width, lineGap: 2 }) + 7; }
function photoCaption(photo) { return [text(photo?.caption, 500), text(photo?.annotation, 1000)].filter(Boolean).join(" · "); }
function photoLayout(photo) { return PHOTO_LAYOUTS[String(photo?.pdfSize || "")] || PHOTO_LAYOUTS.large; }
function photoBlockHeight(pdf, photo, template) { const layout = photoLayout(photo); let renderedHeight = layout.maxHeight; try { const dimensions = pdf.openImage(dataUrl(photo.dataUrl)); renderedHeight = dimensions.height * Math.min(layout.width / dimensions.width, layout.maxHeight / dimensions.height); } catch {} return renderedHeight + photoCaptionHeight(pdf, photo, 507, template) + 18; }
function observationTextHeight(pdf, value, numbered, template) { return (numbered ? 18 : 0) + pdf.font(template.font).fontSize(10.5).heightOfString(value, { width: 507, lineGap: 4 }) + 16; }
function addContentPage(pdf, profile, template) { pdf.addPage(); addCompanyHeader(pdf, profile, template, 44); return CONTENT_TOP; }
function ensureSpace(pdf, y, height, profile, template) { return y + height <= CONTENT_BOTTOM ? y : addContentPage(pdf, profile, template); }
function addCourtesy(pdf, y, technicianName, template, profile) { y = ensureSpace(pdf, y + 16, 105, profile, template); pdf.moveTo(44, y).lineTo(551, y).lineWidth(1).strokeColor("#dbe4ee").stroke(); pdf.font(template.font).fillColor("#334155").fontSize(10).text("Vous en souhaitant bonne réception, nous vous prions d’agréer, Madame, Monsieur, l’expression de nos salutations distinguées.", 44, y + 18, { width: 507, lineGap: 4, align: "justify" }); pdf.font(template.font).fillColor(template.titleColor).fontSize(10).text(technicianName, 44, pdf.y + 15, { width: 507, align: "right" }); }
function addStructuredFields(pdf, values, y, profile, template) { for (const [field, value] of Object.entries(values || {})) { if (field.toLowerCase().includes("signature") || ["clientName", "signedAt", "observations", "materials", "items", "readings"].includes(field)) continue; const line = text(value, 5000); if (!line) continue; y = ensureSpace(pdf, y, 55, profile, template); pdf.font(template.font).fillColor(template.titleColor).fontSize(9).text(pretty(field), 44, y); y += 14; pdf.fillColor("#172033").fontSize(10).text(line, 44, y, { width: 507, lineGap: 3 }); y = pdf.y + 14; }
    const rows = Array.isArray(values?.readings) ? values.readings : []; if (rows.length) { y = ensureSpace(pdf, y, Math.min(190, 30 + rows.length * 20), profile, template); pdf.font(template.font).fillColor(template.titleColor).fontSize(9).text("Relevés", 44, y); y += 16; for (const row of rows) { const line = Object.values(row || {}).map(item => text(item, 500)).filter(Boolean).join(" · "); if (!line) continue; y = ensureSpace(pdf, y, 24, profile, template); pdf.fillColor("#172033").fontSize(9.5).text(`• ${line}`, 52, y, { width: 499 }); y = pdf.y + 5; } } return y; }
function addSignatures(pdf, values, y, profile, template) { const technician = text(values?.technicianSignature, 700000); const client = text(values?.clientSignature, 700000); if (!technician && !client) return y; y = ensureSpace(pdf, y + 8, 120, profile, template); pdf.moveTo(44, y).lineTo(551, y).lineWidth(1).strokeColor("#dbe4ee").stroke(); y += 12; const signatures = [["Signature du technicien", technician], [text(values?.clientName, 160) ? `Signature client — ${text(values.clientName, 160)}` : "Signature client", client]]; signatures.forEach(([label, signature], index) => { const x = 44 + index * 258; pdf.font(template.font).fillColor(template.titleColor).fontSize(8.5).text(label, x, y); if (signature && /^data:image\//.test(signature)) { try { pdf.image(dataUrl(signature), x, y + 15, { fit: [220, 65] }); } catch {} } }); return y + 88; }
function decoratePages(pdf, profile, template) { const range = pdf.bufferedPageRange(); for (let index = 0; index < range.count; index += 1) { pdf.switchToPage(index); const footer = footerLines(profile, template); const hasSecondary = imageBuffer(profile.secondaryLogoData); if (hasSecondary) try { pdf.image(hasSecondary, 44, 773, { fit: [42, 18] }); } catch {} pdf.font(template.font).fillColor("#64748b").fontSize(7.2).text(footer.join(" · "), hasSecondary ? 94 : 44, 778, { width: hasSecondary ? 370 : 420, align: "center", ellipsis: true }); pdf.fillColor(template.secondaryColor).fontSize(7.5).text(`Page ${index + 1} / ${range.count}`, 470, 778, { width: 81, align: "right" }); } }
function orderedPhotos(photos) { return [...(photos || [])].sort((left, right) => Number(left.sortOrder || 0) - Number(right.sortOrder || 0) || String(left.createdAt || "").localeCompare(String(right.createdAt || ""))); }
function reportTemplate(profile) { return { ...DEFAULT_TEMPLATE, ...(profile.reportTemplate || {}), footerFields: Array.isArray(profile.reportTemplate?.footerFields) ? profile.reportTemplate.footerFields : DEFAULT_TEMPLATE.footerFields }; }
function companyLines(profile, template) { const name = template.companyName || profile.companyName || "Depann’Home Pro"; const address = template.address || [profile.address, profile.postalCode, profile.city].filter(Boolean).join(" "); return [name, address, template.phone || profile.phone, template.email || profile.email].filter(Boolean); }
function footerLines(profile, template) { const values = { address: template.address || [profile.address, profile.postalCode, profile.city].filter(Boolean).join(" "), phone: template.phone || profile.phone, email: template.email || profile.email, website: template.website, siret: template.siret || profile.registrationNumber, vat: template.vat || profile.taxNumber, legalNotice: template.legalNotice, footerText: template.footerText }; return [...(template.footerFields || []).map(field => values[field]).filter(Boolean), values.footerText].filter(Boolean); }
function normalizeObservations(value) { const entries = Array.isArray(value) ? value : typeof value === "string" && value.trim() ? [{ text: value }] : []; return entries.slice(0, 100).map((item, index) => ({ id: text(item?.id, 100) || `observation-${index + 1}`, text: multilineText(item?.text, 5000), createdAt: text(item?.createdAt, 40), keepTogether: item?.keepTogether !== false, pageBreakBefore: Boolean(item?.pageBreakBefore) })).filter(item => item.text); }
function normalizeCustomSections(value) { const ids = new Set(); return (Array.isArray(value) ? value : []).slice(0, 100).map((section, index) => { const id = uniqueId(text(section?.id, 100) || `section-${index + 1}`, ids); const sourceKey = REPORT_STEP_KEYS.includes(section?.sourceKey) ? section.sourceKey : "overview"; return { id, sourceKey, title: text(section?.title, 160) || `${REPORT_STEPS.find(([key]) => key === sourceKey)?.[1] || "Section"} (${index + 2})`, content: { observations: normalizeObservations(section?.content?.observations) } }; }).filter(section => section.id); }
function orderedSectionIds(value, knownIds) { const requested = Array.isArray(value) ? value : []; const ordered = [...new Set(requested.filter(id => knownIds.includes(id)))]; for (const id of knownIds) if (!ordered.includes(id)) ordered.push(id); ["general", "presentation"].reverse().forEach(id => { const index = ordered.indexOf(id); if (index >= 0) ordered.splice(index, 1); ordered.unshift(id); }); return ordered; }
function normalizeMaterials(value, legacyMethods) { const listed = Array.isArray(value) ? value : legacyMaterials(legacyMethods); const ids = new Set(); return listed.slice(0, 40).map((item, index) => ({ id: uniqueId(text(item?.id, 100) || `material-${index + 1}`, ids), name: text(item?.name, 120), customName: text(item?.customName, 120), observations: normalizeObservations(item?.observations) })).filter(item => item.name); }
function legacyMaterials(methods) { const materials = new Map(); const add = (name, observation) => { const label = text(name, 120) || "Matériel technique"; const current = materials.get(label) || { id: `legacy-material-${materials.size + 1}`, name: label, observations: [] }; if (observation?.text) current.observations.push(observation); materials.set(label, current); }; for (const item of Array.isArray(methods?.items) ? methods.items : []) add(item.name, { text: [item.observations, item.result, item.comments].filter(Boolean).join("\n") }); for (const observation of Array.isArray(methods?.observations) ? methods.observations : []) add(observation.method, observation); return [...materials.values()]; }
function ensureIntro(section, id, intro) { const observations = Array.isArray(section.observations) ? section.observations : []; if (!observations.length) section.observations = [{ id, text: intro, createdAt: "", keepTogether: true, pageBreakBefore: false }]; }
function legacyObservation(values) { const lines = []; for (const [field, value] of Object.entries(values || {})) { if (["technicianSignature", "clientSignature", "clientName", "signedAt", "observations", "items", "materials", "readings"].includes(field) || !value) continue; if (typeof value === "string") lines.push(`${pretty(field)} : ${value}`); } const observation = typeof values?.observations === "string" ? values.observations : ""; return [observation, ...lines].filter(Boolean).join("\n"); }
function sanitizeRows(rows, fields) { return (Array.isArray(rows) ? rows : []).slice(0, 100).map(row => Object.fromEntries(fields.map(field => [field, text(row?.[field], 500)]))); }
function uniqueId(value, used) { const base = value.replace(/[^a-zA-Z0-9_-]/g, "-") || "material"; let id = base; let index = 2; while (used.has(id)) id = `${base}-${index++}`; used.add(id); return id; }
function materialLabel(material) { return material?.name === "Autre matériel" ? material.customName || material.name : material?.name || "Matériel technique"; }
function pretty(value) { return ({ disorders: "Description des désordres", rooms: "Pièces concernées", checks: "Vérifications réalisées", probableOrigin: "Origine probable", work: "Travaux recommandés", customerAdvice: "Conseils au client", holdingTime: "Temps de maintien", testType: "Type de test" })[value] || String(value).replace(/([A-Z])/g, " $1").replace(/^./, char => char.toUpperCase()); }
function multilineText(value, max) { return String(value || "").replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, max); }
function text(value, max) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, max); }
function imageBuffer(value) { return Buffer.isBuffer(value) ? value : value ? Buffer.from(value) : null; }
function dataUrl(value) { const match = /^data:[^;,]+;base64,([a-zA-Z0-9+/=]+)$/.exec(String(value || "")); if (!match) throw new Error("Média invalide"); return Buffer.from(match[1], "base64"); }
