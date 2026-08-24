import ExcelJS from "exceljs";
import PizZip from "pizzip";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const PDF_MIME = "application/pdf";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const TEXT_MIME = "text/plain";
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_EXTRACTED_CHARACTERS = 50_000;
const MAX_PDF_PAGES = 50;
const MAX_ZIP_ENTRIES = 2_000;
const MAX_UNCOMPRESSED_BYTES = 40 * 1024 * 1024;
const MAX_SPREADSHEET_CELLS = 20_000;

export async function extractPartnerDocumentText(attachments) {
    let output = "";
    for (const attachment of Array.isArray(attachments) ? attachments : []) {
        if (output.length >= MAX_EXTRACTED_CHARACTERS) break;
        try {
            const buffer = attachmentBuffer(attachment);
            if (!buffer.length || buffer.length > MAX_SOURCE_BYTES) continue;
            const text = await extractText(buffer, String(attachment.mime || attachment.mimeType || "").toLowerCase());
            if (text) output += `${output ? "\n" : ""}${text}`;
        } catch {
            // Une pièce illisible ou non textuelle ne doit jamais empêcher l’import de la mission.
        }
    }
    return normalizeText(output).slice(0, MAX_EXTRACTED_CHARACTERS);
}

async function extractText(buffer, mimeType) {
    if (mimeType === TEXT_MIME) return decodePlainText(buffer);
    if (mimeType === PDF_MIME) return extractPdfText(buffer);
    if (mimeType === DOCX_MIME) return extractDocxText(buffer);
    if (mimeType === XLSX_MIME) return extractXlsxText(buffer);
    return "";
}

function attachmentBuffer(attachment) {
    if (Buffer.isBuffer(attachment?.buffer)) return attachment.buffer;
    const match = /^data:[^;]+;base64,([A-Za-z0-9+/=]+)$/.exec(String(attachment?.dataUrl || ""));
    return match ? Buffer.from(match[1], "base64") : Buffer.alloc(0);
}

function decodePlainText(buffer) {
    let text = buffer.toString("utf8");
    if (text.includes("\uFFFD")) text = new TextDecoder("windows-1252").decode(buffer);
    return text;
}

async function extractPdfText(buffer) {
    const loadingTask = getDocument({ data: new Uint8Array(buffer), disableFontFace: true, isEvalSupported: false, useSystemFonts: false });
    const document = await loadingTask.promise;
    let output = "";
    try {
        const pageCount = Math.min(document.numPages, MAX_PDF_PAGES);
        for (let pageNumber = 1; pageNumber <= pageCount && output.length < MAX_EXTRACTED_CHARACTERS; pageNumber += 1) {
            const page = await document.getPage(pageNumber);
            const content = await page.getTextContent();
            for (const item of content.items) {
                if (typeof item?.str !== "string") continue;
                output += item.str;
                output += item.hasEOL ? "\n" : " ";
                if (output.length >= MAX_EXTRACTED_CHARACTERS) break;
            }
            page.cleanup();
            output += "\n";
        }
    } finally {
        await document.destroy();
    }
    return output;
}

function extractDocxText(buffer) {
    const zip = safeZip(buffer);
    const document = zip.file("word/document.xml")?.asText();
    if (!document) return "";
    return decodeXml(document
        .replace(/<w:tab\b[^>]*\/>/gi, "\t")
        .replace(/<w:br\b[^>]*\/>/gi, "\n")
        .replace(/<\/w:p>/gi, "\n")
        .replace(/<[^>]+>/g, ""));
}

async function extractXlsxText(buffer) {
    safeZip(buffer);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const lines = [];
    let cellCount = 0;
    for (const worksheet of workbook.worksheets) {
        worksheet.eachRow(row => {
            if (cellCount >= MAX_SPREADSHEET_CELLS) return;
            const values = [];
            row.eachCell({ includeEmpty: false }, cell => {
                if (cellCount >= MAX_SPREADSHEET_CELLS) return;
                cellCount += 1;
                const value = String(cell.text || "").trim();
                if (value) values.push(value);
            });
            if (values.length) lines.push(values.join(" : "));
        });
        if (cellCount >= MAX_SPREADSHEET_CELLS || lines.join("\n").length >= MAX_EXTRACTED_CHARACTERS) break;
    }
    return lines.join("\n");
}

function safeZip(buffer) {
    const zip = new PizZip(buffer);
    const entries = Object.values(zip.files);
    const uncompressedBytes = entries.reduce((total, entry) => total + Number(entry?._data?.uncompressedSize || 0), 0);
    if (entries.length > MAX_ZIP_ENTRIES || uncompressedBytes > MAX_UNCOMPRESSED_BYTES) throw new Error("Archive bureautique trop volumineuse.");
    return zip;
}

function decodeXml(value) {
    return value.replace(/&#(x?[0-9a-f]+);|&(amp|lt|gt|quot|apos);/gi, (match, numeric, named) => {
        if (numeric) {
            const radix = numeric[0].toLowerCase() === "x" ? 16 : 10;
            return String.fromCodePoint(Number.parseInt(radix === 16 ? numeric.slice(1) : numeric, radix));
        }
        return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[named.toLowerCase()];
    });
}

function normalizeText(value) {
    return String(value || "")
        .replace(/\u0000/g, "")
        .replace(/[\t ]+/g, " ")
        .replace(/ *\n */g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
