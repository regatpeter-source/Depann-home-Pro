import ExcelJS from "exceljs";
import PizZip from "pizzip";
import { createRequire } from "node:module";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createWorker, OEM } from "tesseract.js";

const PDF_MIME = "application/pdf";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const TEXT_MIME = "text/plain";
const IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const MIME_BY_EXTENSION = new Map([
    [".pdf", PDF_MIME], [".docx", DOCX_MIME], [".xlsx", XLSX_MIME], [".txt", TEXT_MIME],
    [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".png", "image/png"], [".webp", "image/webp"]
]);
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_EXTRACTED_CHARACTERS = 50_000;
const MAX_PDF_PAGES = 50;
const MAX_OCR_PAGES = 5;
const MAX_OCR_IMAGES = 5;
const MAX_OCR_PIXELS = 4_000_000;
const MIN_USEFUL_PDF_TEXT = 30;
const MAX_ZIP_ENTRIES = 2_000;
const MAX_UNCOMPRESSED_BYTES = 40 * 1024 * 1024;
const MAX_SPREADSHEET_CELLS = 20_000;
const require = createRequire(import.meta.url);
const FRENCH_OCR_DATA = require("@tesseract.js-data/fra");

export async function extractPartnerDocumentText(attachments) {
    let output = "";
    for (const attachment of Array.isArray(attachments) ? attachments : []) {
        if (output.length >= MAX_EXTRACTED_CHARACTERS) break;
        try {
            const buffer = attachmentBuffer(attachment);
            if (!buffer.length || buffer.length > MAX_SOURCE_BYTES) continue;
            const text = await extractText(buffer, normalizePartnerDocumentMime(attachment));
            if (text) output += `${output ? "\n" : ""}${text}`;
        } catch (error) {
            console.warn("[partner-email-document] Pièce jointe non lisible :", error?.message || "erreur d’extraction");
            // Une pièce illisible ou non textuelle ne doit jamais empêcher l’import de la mission.
        }
    }
    return normalizeText(output).slice(0, MAX_EXTRACTED_CHARACTERS);
}

export function normalizePartnerDocumentMime(attachment) {
    const supplied = String(attachment?.mime || attachment?.mimeType || attachment?.contentType || "").toLowerCase().split(";", 1)[0].trim();
    const extension = /(?:\.[a-z0-9]+)$/i.exec(String(attachment?.name || attachment?.filename || "").trim())?.[0]?.toLowerCase() || "";
    const inferred = MIME_BY_EXTENSION.get(extension) || "";
    if (!supplied || supplied === "application/octet-stream" || supplied === "binary/octet-stream") return inferred || supplied;
    if (supplied === "image/jpg") return "image/jpeg";
    return supplied;
}

async function extractText(buffer, mimeType) {
    if (mimeType === TEXT_MIME) return decodePlainText(buffer);
    if (mimeType === PDF_MIME) return extractPdfText(buffer);
    if (mimeType === DOCX_MIME) return extractDocxText(buffer);
    if (mimeType === XLSX_MIME) return extractXlsxText(buffer);
    if (IMAGE_MIME.has(mimeType)) return extractImageText(buffer);
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
        if (normalizeText(output).replace(/[^\p{L}\p{N}]/gu, "").length < MIN_USEFUL_PDF_TEXT) output = await extractScannedPdfText(document);
    } finally {
        await document.destroy();
    }
    return output;
}

async function extractScannedPdfText(document) {
    let worker;
    try {
        worker = await createFrenchOcrWorker();
        let output = "";
        const pageCount = Math.min(document.numPages, MAX_OCR_PAGES);
        let imageCount = 0;
        for (let pageNumber = 1; pageNumber <= pageCount && output.length < MAX_EXTRACTED_CHARACTERS && imageCount < MAX_OCR_IMAGES; pageNumber += 1) {
            const page = await document.getPage(pageNumber);
            const images = await embeddedPdfImages(page, MAX_OCR_IMAGES - imageCount); imageCount += images.length;
            for (const image of images) {
                const result = await worker.recognize(image);
                if (result.data?.text) output += `${output ? "\n" : ""}${result.data.text}`;
                if (output.length >= MAX_EXTRACTED_CHARACTERS) break;
            }
            page.cleanup();
        }
        return output;
    } catch (error) {
        console.warn("[partner-email-ocr] PDF scanné non lisible :", error?.message || "erreur OCR");
        return "";
    } finally {
        await worker?.terminate().catch(() => {});
    }
}

async function extractImageText(buffer) {
    let worker;
    try {
        const image = await loadImage(buffer);
        if (!image.width || !image.height) return "";
        const scale = Math.min(1, Math.sqrt(MAX_OCR_PIXELS / (image.width * image.height)));
        const width = Math.max(1, Math.round(image.width * scale));
        const height = Math.max(1, Math.round(image.height * scale));
        const canvas = createCanvas(width, height);
        canvas.getContext("2d").drawImage(image, 0, 0, width, height);
        worker = await createFrenchOcrWorker();
        return (await worker.recognize(canvas.toBuffer("image/png"))).data?.text || "";
    } catch (error) {
        console.warn("[partner-email-ocr] Image jointe non lisible :", error?.message || "erreur OCR");
        return "";
    } finally {
        await worker?.terminate().catch(() => {});
    }
}

async function createFrenchOcrWorker() {
    const worker = await createWorker(FRENCH_OCR_DATA.code, OEM.LSTM_ONLY, { langPath: FRENCH_OCR_DATA.langPath, gzip: FRENCH_OCR_DATA.gzip, cacheMethod: "none", logger: () => {} });
    await worker.setParameters({ preserve_interword_spaces: "1" });
    return worker;
}

async function embeddedPdfImages(page, limit) {
    const operators = await page.getOperatorList();
    const images = [];
    for (let index = 0; index < operators.fnArray.length && images.length < limit; index += 1) {
        if (![OPS.paintImageXObject, OPS.paintInlineImageXObject].includes(operators.fnArray[index])) continue;
        const reference = operators.argsArray[index]?.[0];
        const image = typeof reference === "string" ? await new Promise(resolve => page.objs.get(reference, resolve)) : reference;
        if (!image?.data || !image.width || !image.height || image.width * image.height > MAX_OCR_PIXELS) continue;
        const canvas = createCanvas(image.width, image.height); const context = canvas.getContext("2d");
        const pixels = context.createImageData(image.width, image.height); const source = image.data;
        if (image.kind === 3 || source.length === pixels.data.length) pixels.data.set(source);
        else if (image.kind === 2 || source.length === image.width * image.height * 3) for (let sourceIndex = 0, targetIndex = 0; sourceIndex < source.length; sourceIndex += 3, targetIndex += 4) { pixels.data[targetIndex] = source[sourceIndex]; pixels.data[targetIndex + 1] = source[sourceIndex + 1]; pixels.data[targetIndex + 2] = source[sourceIndex + 2]; pixels.data[targetIndex + 3] = 255; }
        else if (image.kind === 1 || source.length === image.width * image.height) for (let sourceIndex = 0, targetIndex = 0; sourceIndex < source.length; sourceIndex += 1, targetIndex += 4) { pixels.data[targetIndex] = source[sourceIndex]; pixels.data[targetIndex + 1] = source[sourceIndex]; pixels.data[targetIndex + 2] = source[sourceIndex]; pixels.data[targetIndex + 3] = 255; }
        else continue;
        context.putImageData(pixels, 0, 0); images.push(canvas.toBuffer("image/png"));
    }
    return images;
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
