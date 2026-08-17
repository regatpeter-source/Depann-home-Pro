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
            const businessDocument = await PDFDocument.load(generatedPdf);
            const output = await PDFDocument.create();
            const basePageCount = companyBase.getPageCount();
            if (!basePageCount) throw templateError(409, "La base PDF de l’entreprise ne contient aucune page.");
            const businessPages = businessDocument.getPages();
            const basePages = await output.copyPages(companyBase, businessPages.map((page, index) => Math.min(index, basePageCount - 1)));
            for (const [index, businessPage] of businessPages.entries()) {
                const page = output.addPage(basePages[index]);
                const { width, height } = page.getSize();
                const embeddedBusiness = await output.embedPage(businessPage);
                page.drawPage(embeddedBusiness, { x: 0, y: 0, width, height });
            }
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
