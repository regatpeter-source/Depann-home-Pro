import { PDFDocument } from "pdf-lib";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";

export const PDF_MIME = "application/pdf";
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const SUPPORTED_TEMPLATE_MIMES = new Set([PDF_MIME, DOCX_MIME]);
const MAX_DOCX_ENTRIES = 750;
const MAX_DOCX_UNCOMPRESSED_BYTES = 35 * 1024 * 1024;

export function isMergeableCompanyTemplate(mimeType) {
    return SUPPORTED_TEMPLATE_MIMES.has(String(mimeType || ""));
}

export async function validateCompanyTemplate(buffer, mimeType) {
    if (!isMergeableCompanyTemplate(mimeType)) {
        throw templateError(400, "Pour une utilisation automatique, convertissez l’ancienne base DOC au format DOCX ou PDF.");
    }
    try {
        if (mimeType === PDF_MIME) {
            await PDFDocument.load(buffer);
            return;
        }
        renderDocxTemplate(buffer, {});
    } catch {
        throw templateError(400, "Le gabarit est illisible ou corrompu. Déposez un fichier PDF ou DOCX valide.");
    }
}

export async function renderCompanyTemplate({ buffer, filename, mimeType, values, generatedPdf }) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw templateError(409, "La base externe sélectionnée est introuvable.");
    try {
        if (mimeType === DOCX_MIME) {
            return { buffer: renderDocxTemplate(buffer, normalizeTemplateValues(values)), filename: outputFilename(filename, ".docx"), mimeType: DOCX_MIME };
        }
        if (mimeType === PDF_MIME) {
            if (!Buffer.isBuffer(generatedPdf) || !generatedPdf.length) throw templateError(409, "Le contenu métier à joindre à la base PDF est introuvable.");
            const companyBase = await PDFDocument.load(buffer);
            const basePageCount = companyBase.getPageCount();
            if (!basePageCount) throw templateError(409, "La base PDF de l’entreprise ne contient aucune page.");
            if (fillPdfForm(companyBase, values)) {
                return { buffer: Buffer.from(await companyBase.save()), filename: outputFilename(filename, ".pdf"), mimeType: PDF_MIME };
            }
            const businessDocument = await PDFDocument.load(generatedPdf);
            const output = await PDFDocument.create();
            const [basePages, businessPages] = await Promise.all([
                output.copyPages(companyBase, companyBase.getPageIndices()),
                output.copyPages(businessDocument, businessDocument.getPageIndices())
            ]);
            [...basePages, ...businessPages].forEach(page => output.addPage(page));
            return { buffer: Buffer.from(await output.save()), filename: outputFilename(filename, ".pdf"), mimeType: PDF_MIME };
        }
    } catch (error) {
        if (error?.status) throw error;
        throw templateError(409, "La base externe enregistrée ne peut pas être fusionnée. Remplacez-la par un PDF ou DOCX valide.");
    }
    throw templateError(409, "Cette ancienne base DOC est conservée, mais doit être convertie en DOCX ou PDF pour être utilisée automatiquement.");
}

function renderDocxTemplate(buffer, values) {
    const zip = new PizZip(buffer);
    const entries = Object.values(zip.files);
    const uncompressedBytes = entries.reduce((total, entry) => total + Number(entry?._data?.uncompressedSize || 0), 0);
    if (entries.length > MAX_DOCX_ENTRIES || uncompressedBytes > MAX_DOCX_UNCOMPRESSED_BYTES) throw templateError(400, "Le gabarit DOCX décompressé est trop volumineux.");
    const document = new Docxtemplater(zip, {
        paragraphLoop: true,
        linebreaks: true,
        delimiters: { start: "{{", end: "}}" },
        nullGetter: () => ""
    });
    document.render(values);
    return document.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" });
}

function fillPdfForm(document, values) {
    const form = document.getForm();
    const normalizedValues = normalizeTemplateValues(values);
    const fields = form.getFields();
    const fieldKeys = new Set(fields.map(field => String(field.getName() || "").trim().replace(/^\{\{\s*|\s*\}\}$/g, "")));
    const requiredFields = Object.hasOwn(normalizedValues, "type_document")
        ? ["type_document", "numero", "client_nom", "lignes", "total_ttc"]
        : Object.hasOwn(normalizedValues, "numero_intervention")
            ? ["numero_intervention", "client_nom", "signataire", "validation"]
            : Object.hasOwn(normalizedValues, "numero_rapport")
                ? ["numero_rapport", "titre", "client_nom", "contenu"]
                : [];
    if (!requiredFields.length || !requiredFields.every(key => fieldKeys.has(key))) return false;
    const filledFields = new Set();
    for (const field of fields) {
        const key = String(field.getName() || "").trim().replace(/^\{\{\s*|\s*\}\}$/g, "");
        if (!Object.hasOwn(normalizedValues, key)) continue;
        const value = normalizedValues[key];
        try {
            if (typeof field.setText === "function") field.setText(value);
            else if (typeof field.check === "function" && typeof field.uncheck === "function") isTruthyTemplateValue(value) ? field.check() : field.uncheck();
            else if (typeof field.select === "function") field.select(value);
            else continue;
            filledFields.add(key);
        } catch {
            // Un champ PDF incompatible reste intact ; les autres champs reconnus sont conservés.
        }
    }
    return requiredFields.every(key => filledFields.has(key));
}

function isTruthyTemplateValue(value) {
    return !["", "0", "false", "non", "no"].includes(String(value || "").trim().toLowerCase());
}

function normalizeTemplateValues(value) {
    return Object.fromEntries(Object.entries(value || {}).map(([key, entry]) => [key, scalar(entry)]));
}

function scalar(value) {
    if (Array.isArray(value)) return value.map(scalar).join("\n");
    if (value && typeof value === "object") return JSON.stringify(value);
    return value === null || value === undefined ? "" : String(value);
}

function outputFilename(filename, extension) {
    const base = String(filename || "document-entreprise").replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_").slice(0, 220) || "document-entreprise";
    return `${base}-complete${extension}`;
}

function templateError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}
