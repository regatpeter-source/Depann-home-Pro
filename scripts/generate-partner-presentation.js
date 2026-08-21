import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "docs", "PRESENTATION_COMMERCIALE_PARTENAIRES.md");
const outputPath = path.join(root, "docs", "PRESENTATION_COMMERCIALE_PARTENAIRES.pdf");
const desktopPath = path.join(os.homedir(), "Desktop", "DepannHome-Pro-Presentation-Entreprises-Partenaires.pdf");
const logoPath = path.join(root, "assets", "logo.png.png");
const illustrations = new Map([
    ["1. Gestion complète des clients", "client.png"],
    ["2. Planning et organisation des interventions", "planning.png"],
    ["4. Tableau de bord financier dans Facturation", "billing.png"],
    ["7. Rapports de recherche de fuite", "report.png"],
    ["11. Missions partenaires", "partner.png"]
]);
const markdown = fs.readFileSync(sourcePath, "utf8");

const colors = { primary: "#003B73", secondary: "#0A5C36", text: "#172033", muted: "#64748B", paleBlue: "#EEF6FF", paleGreen: "#EFFAF3", border: "#D7DDE3", white: "#FFFFFF" };
const document = new PDFDocument({ size: "A4", margins: { top: 52, right: 52, bottom: 58, left: 52 }, bufferPages: true, info: { Title: "Depann’Home Pro — Présentation aux entreprises partenaires", Author: "Depann’Home Pro", Subject: "Présentation commerciale de la plateforme Depann’Home Pro", Keywords: "dépannage, partenaires, interventions, facturation, rapports, planning" } });
const output = fs.createWriteStream(outputPath);
document.pipe(output);

let firstPage = true;
let sectionIndex = 0;

function availableBottom() { return document.page.height - 104; }
function ensureSpace(height) { if (document.y + height > availableBottom()) document.addPage(); }
function addRule(color = colors.border) { ensureSpace(14); const y = document.y + 5; document.moveTo(52, y).lineTo(document.page.width - 52, y).lineWidth(1).strokeColor(color).stroke(); document.y = y + 10; }
function cleanInline(value) { return String(value || "").replace(/\*\*/g, "").replace(/`/g, "").replace(/^>\s*/, "").trim(); }
function isContactPlaceholder(value) { return /^(Contact commercial|Téléphone|E-mail|Site internet)\s*:\s*à compléter/i.test(cleanInline(value)); }

function addCover() {
    if (fs.existsSync(logoPath)) document.image(logoPath, 52, 46, { fit: [210, 88], align: "left" });
    document.roundedRect(52, 164, document.page.width - 104, 210, 18).fill(colors.primary);
    document.fillColor(colors.white).font("Helvetica-Bold").fontSize(29).text("DEPANN’HOME PRO", 78, 198, { width: document.page.width - 156 });
    document.font("Helvetica").fontSize(17).text("La plateforme métier qui relie entreprises, équipes terrain et partenaires", 78, 250, { width: document.page.width - 156, lineGap: 6 });
    document.fontSize(10.5).fillColor("#DDEEFF").text("Clients · Planning · Terrain · Rapports · Facturation · Collaboration partenaire", 78, 323, { width: document.page.width - 156 });
    document.fillColor(colors.secondary).font("Helvetica-Bold").fontSize(16).text("Organisez chaque intervention. Partagez uniquement ce qui doit l’être.", 52, 414, { width: document.page.width - 104, align: "center" });
    document.fillColor(colors.text).font("Helvetica").fontSize(11).text("Présentation destinée aux entreprises partenaires et futures entreprises utilisatrices.", 74, 466, { width: document.page.width - 148, align: "center", lineGap: 4 });
    document.roundedRect(94, 545, document.page.width - 188, 104, 14).fill(colors.paleGreen);
    document.fillColor(colors.secondary).font("Helvetica-Bold").fontSize(13).text("Un écosystème professionnel centralisé", 112, 566, { width: document.page.width - 224, align: "center" });
    document.fillColor(colors.text).font("Helvetica").fontSize(9.7).text("De la réception du besoin client jusqu’au rapport, au devis, à la facture et aux échanges partenaires.", 116, 598, { width: document.page.width - 232, align: "center", lineGap: 3 });
    document.fillColor(colors.muted).fontSize(8.5).text("Août 2026", 52, 746, { width: document.page.width - 104, align: "center" });
    document.addPage();
    firstPage = false;
}

function addHeading(value, level) {
    const text = cleanInline(value);
    if (level === 1) {
        document.addPage(); sectionIndex += 1;
        document.fillColor(colors.secondary).font("Helvetica-Bold").fontSize(9).text(`FONCTIONNALITÉ ${String(sectionIndex).padStart(2, "0")}`);
        document.moveDown(.25);
        document.fillColor(colors.primary).fontSize(22).text(text, { lineGap: 2 });
        addRule(colors.secondary);
        if (text === "Les forfaits Depann’Home Pro") addPricingPanel();
        addIllustration(text);
        return;
    }
    if (level === 2) {
        ensureSpace(62); document.moveDown(.35);
        document.fillColor(colors.primary).font("Helvetica-Bold").fontSize(15).text(text, { lineGap: 2 });
        document.moveDown(.25); return;
    }
    ensureSpace(40); document.moveDown(.2);
    document.fillColor(colors.secondary).font("Helvetica-Bold").fontSize(11).text(text);
    document.moveDown(.18);
}

function addPricingPanel() {
    ensureSpace(245);
    const offers = [
        { name: "BASIC", pc: "20 € / PC", mobile: "5 € / mobile", detail: "PC + Admin Mobile · bibliothèque mobile · achats tous PC", color: "#2563EB", pale: "#EFF6FF" },
        { name: "BASIC+", pc: "35 € / PC", mobile: "8 € / mobile", detail: "Planning · imports · missions et dossiers Réseau · sans API externe", color: colors.secondary, pale: colors.paleGreen },
        { name: "PRO", pc: "70 € / PC", mobile: "15 € / mobile", detail: "Accès complet · licences Groupe d’entreprise incluses sans supplément", color: "#7C3AED", pale: "#F5F3FF" }
    ];
    const gap = 10; const totalWidth = document.page.width - 104; const cardWidth = (totalWidth - gap * 2) / 3; const y = document.y;
    offers.forEach((offer, index) => {
        const x = 52 + index * (cardWidth + gap);
        document.roundedRect(x, y, cardWidth, 205, 12).fillAndStroke(offer.pale, offer.color);
        document.roundedRect(x, y, cardWidth, 42, 12).fill(offer.color);
        document.fillColor(colors.white).font("Helvetica-Bold").fontSize(13).text(offer.name, x + 10, y + 14, { width: cardWidth - 20, align: "center", lineBreak: false });
        document.fillColor(offer.color).font("Helvetica-Bold").fontSize(12).text(offer.pc, x + 10, y + 61, { width: cardWidth - 20, align: "center" });
        document.fontSize(10).text("+", x + 10, y + 88, { width: cardWidth - 20, align: "center" });
        document.fontSize(12).text(offer.mobile, x + 10, y + 105, { width: cardWidth - 20, align: "center" });
        document.fillColor(colors.text).font("Helvetica").fontSize(8.2).text(offer.detail, x + 13, y + 145, { width: cardWidth - 26, align: "center", lineGap: 3 });
    });
    document.y = y + 220;
}

function addIllustration(heading) {
    const filename = illustrations.get(heading); if (!filename) return;
    const imagePath = path.join(root, "assets", "commercial", filename); if (!fs.existsSync(imagePath)) return;
    ensureSpace(315);
    const width = document.page.width - 104;
    const height = width * 720 / 1280;
    document.roundedRect(52, document.y, width, height, 9).fill(colors.white);
    document.image(imagePath, 52, document.y, { fit: [width, height], align: "center", valign: "center" });
    document.y += height + 7;
    document.fillColor(colors.muted).font("Helvetica-Oblique").fontSize(7.8).text("Illustration de l’interface Depann’Home Pro — données de démonstration fictives.", 52, document.y, { width, align: "center" });
    document.moveDown(.7);
}

function addBullet(value) {
    const text = cleanInline(value);
    ensureSpace(28);
    const y = document.y + 2;
    document.circle(59, y + 4, 2.5).fill(colors.secondary);
    document.fillColor(colors.text).font("Helvetica").fontSize(9.4).text(text, 70, y, { width: document.page.width - 122, lineGap: 2.5 });
    document.moveDown(.28);
}

function addQuote(value) {
    const text = cleanInline(value);
    ensureSpace(72);
    const y = document.y;
    const height = document.heightOfString(text, { width: document.page.width - 148, lineGap: 4 }) + 30;
    document.roundedRect(66, y, document.page.width - 132, height, 10).fill(colors.paleBlue);
    document.fillColor(colors.primary).font("Helvetica-Bold").fontSize(11).text(text, 84, y + 15, { width: document.page.width - 168, align: "center", lineGap: 4 });
    document.y = y + height + 12;
}

function addParagraph(value) {
    const text = cleanInline(value);
    if (!text || isContactPlaceholder(text)) return;
    ensureSpace(38);
    document.fillColor(colors.text).font("Helvetica").fontSize(9.5).text(text, { lineGap: 3, paragraphGap: 5 });
    document.moveDown(.25);
}

function addClosingPanel() {
    document.addPage();
    if (fs.existsSync(logoPath)) document.image(logoPath, 157, 65, { fit: [280, 110], align: "center" });
    document.fillColor(colors.primary).font("Helvetica-Bold").fontSize(24).text("Construisons ensemble une collaboration plus fluide", 66, 225, { width: document.page.width - 132, align: "center", lineGap: 4 });
    document.fillColor(colors.text).font("Helvetica").fontSize(11).text("Une démonstration personnalisée peut être organisée selon votre métier, vos équipes et vos besoins d’échange.", 86, 322, { width: document.page.width - 172, align: "center", lineGap: 5 });
    document.roundedRect(98, 430, document.page.width - 196, 150, 14).fill(colors.paleGreen);
    document.fillColor(colors.secondary).font("Helvetica-Bold").fontSize(14).text("Vos coordonnées commerciales", 118, 454, { width: document.page.width - 236, align: "center" });
    document.fillColor(colors.text).font("Helvetica").fontSize(10).text("Contact : ______________________________\nTéléphone : ____________________________\nE-mail : _______________________________\nSite internet : _________________________", 150, 493, { width: document.page.width - 300, lineGap: 7 });
    document.fillColor(colors.muted).fontSize(8.5).text("Depann’Home Pro — Plateforme professionnelle de gestion et de collaboration", 52, 735, { width: document.page.width - 104, align: "center" });
}

addCover();
const lines = markdown.split(/\r?\n/);
let skipTitleBlock = true;
for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "---") continue;
    if (skipTitleBlock && (/^#\s+DEPANN/.test(trimmed) || /^##\s+La plateforme/.test(trimmed))) continue;
    if (skipTitleBlock && trimmed.startsWith("Depann’Home Pro centralise")) { skipTitleBlock = false; addParagraph(trimmed); continue; }
    if (/^#\s+Démo/i.test(trimmed) || /^#\s+Une plateforme/i.test(trimmed)) { addHeading(trimmed.replace(/^#\s+/, ""), 1); continue; }
    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (heading) { addHeading(heading[2], heading[1].length); continue; }
    if (/^-\s+/.test(trimmed)) { addBullet(trimmed.replace(/^-\s+/, "")); continue; }
    if (/^>\s+/.test(trimmed)) { addQuote(trimmed); continue; }
    if (/^\*Document de présentation|^\*Les fonctionnalités/.test(trimmed)) continue;
    addParagraph(trimmed);
}
addClosingPanel();

const range = document.bufferedPageRange();
for (let index = 0; index < range.count; index += 1) {
    document.switchToPage(index);
    if (index === 0 || index === range.count - 1) continue;
    document.moveTo(52, 752).lineTo(document.page.width - 52, 752).lineWidth(.7).strokeColor(colors.border).stroke();
    document.fillColor(colors.muted).font("Helvetica").fontSize(7.5).text("Depann’Home Pro · Présentation entreprises partenaires", 52, 761, { width: 360, lineBreak: false });
    document.text(`Page ${index + 1} / ${range.count}`, document.page.width - 142, 761, { width: 90, align: "right", lineBreak: false });
}

document.end();
output.on("finish", () => {
    fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
    fs.copyFileSync(outputPath, desktopPath);
    console.log(JSON.stringify({ source: sourcePath, pdf: outputPath, desktop: desktopPath, pages: range.count }));
});
