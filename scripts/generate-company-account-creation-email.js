import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import PDFDocument from "pdfkit";
import PizZip from "pizzip";

const outputDirectory = resolve("assets/commercial");
const pdfPath = resolve(outputDirectory, "modele-email-creation-compte-entreprise-depannhome-pro.pdf");
const docxPath = resolve(outputDirectory, "modele-email-creation-compte-entreprise-depannhome-pro.docx");

const GREEN = "0A5C36";
const BLUE = "003B73";
const INK = "172033";

const field = label => ({ label });
const pair = (first, second) => ({ pair: [first, second] });
const choice = (label, ...choices) => ({ label, choices });

const title = "Depann’Home Pro";
const subtitle = "Informations nécessaires à la création de votre compte entreprise";

const sections = [
    ["Informations entreprise", [
        field("Raison sociale :"),
        field("Nom commercial (si différent) :"),
        field("SIRET (14 chiffres) :"),
        field("Adresse complète :"),
        pair("Code postal :", "Ville :"),
        pair("Pays :", "Site internet (facultatif) :"),
        field("Téléphone principal :"),
        field("Téléphone secondaire (facultatif) :"),
        field("E-mail professionnel :"),
        field("E-mail de facturation :")
    ]],
    ["Administrateur principal du compte", [
        field("Nom et prénom :"),
        field("Fonction :"),
        field("E-mail de connexion :"),
        field("Numéro de téléphone :")
    ]],
    ["Configuration souhaitée", [
        choice("Offre :", "Basic", "Basic+", "Pro"),
        pair("Nombre de postes administratifs :", "Nombre d’accès mobiles :"),
        choice("Type d’interface :", "Standard", "Groupe multi-entreprises", "Partenaire"),
        field("Date de début souhaitée :"),
        field("Référence de facturation / bon de commande (si applicable) :")
    ]],
    ["Informations Réseau Depann’Home Pro (facultatif)", [
        field("Domaines d’intervention :"),
        field("Départements / zones d’intervention :"),
        field("Rayon d’intervention (km) ou couverture nationale :"),
        field("Présentation courte de l’entreprise :"),
        field(""),
        choice("Recevoir des missions partenaires :", "Oui", "Non"),
        choice("Logo de l’entreprise joint :", "Oui", "Non")
    ]]
];

const introduction = [
    "Bonjour,",
    "Afin de créer votre espace entreprise Depann’Home Pro, merci de nous transmettre les informations suivantes :"
];
const closing = [
    "Dès réception de ces éléments, nous créerons votre espace et vous transmettrons les accès de l’administrateur principal.",
    "Cordialement,",
    "Depann’Home Pro"
];

function escapeXml(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
}

const DOCX_RIGHT_TAB = 10606;
const DOCX_MID_TAB = 5100;

function runProperties({ bold = false, size = 21, color = INK } = {}) {
    return `<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>${bold ? "<w:b/>" : ""}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:color w:val="${color}"/></w:rPr>`;
}

function textRun(text, style) {
    return `<w:r>${runProperties(style)}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

function leaderRun() {
    return `<w:r>${runProperties()}<w:tab/></w:r>`;
}

// Wingdings F0A8 est la case vide rendue de façon fiable par Word et LibreOffice.
function checkboxRun() {
    return `<w:r>${runProperties()}<w:sym w:font="Wingdings" w:char="F0A8"/></w:r>`;
}

function paragraph(runs, { tabs = [], before = 0, after = 130 } = {}) {
    const tabStops = tabs.length
        ? `<w:tabs>${tabs.map(position => `<w:tab w:val="right" w:leader="underscore" w:pos="${position}"/>`).join("")}</w:tabs>`
        : "";
    return `<w:p><w:pPr>${tabStops}<w:spacing w:before="${before}" w:after="${after}" w:line="240" w:lineRule="auto"/></w:pPr>${runs}</w:p>`;
}

function docxRow(row) {
    if (row.choices) {
        const runs = [textRun(`${row.label} `)];
        row.choices.forEach(option => runs.push(checkboxRun(), textRun(` ${option}     `)));
        return paragraph(runs.join(""));
    }
    if (row.pair) {
        return paragraph(textRun(row.pair[0]) + leaderRun() + textRun(`     ${row.pair[1]}`) + leaderRun(), { tabs: [DOCX_MID_TAB, DOCX_RIGHT_TAB] });
    }
    return paragraph(textRun(row.label) + leaderRun(), { tabs: [DOCX_RIGHT_TAB] });
}

function createDocx() {
    const body = [
        paragraph(textRun(title, { bold: true, size: 34, color: GREEN }), { after: 40 }),
        paragraph(textRun(subtitle, { bold: true, size: 24, color: BLUE }), { after: 220 }),
        ...introduction.map(line => paragraph(textRun(line), { after: 150 })),
        ...sections.flatMap(([heading, rows]) => [
            paragraph(textRun(heading, { bold: true, size: 24, color: GREEN }), { before: 180, after: 130 }),
            ...rows.map(docxRow)
        ]),
        ...closing.map((line, index) => paragraph(textRun(line), { before: index ? 0 : 180, after: 140 })),
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="700" w:right="650" w:bottom="700" w:left="650"/></w:sectPr>'
    ].join("");
    const zip = new PizZip();
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
    zip.folder("_rels").file(".rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
    zip.folder("word").file("document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
    return zip.generate({ type: "nodebuffer", compression: "DEFLATE" });
}

const PDF_MARGIN = 42;
const PDF_ROW_HEIGHT = 18;
const PDF_BODY_SIZE = 10;

function drawRule(document, from, to, baseline) {
    if (to - from < 12) return;
    document.save().lineWidth(0.5).strokeColor("#9AA6B5").moveTo(from, baseline).lineTo(to, baseline).stroke().restore();
}

function drawRow(document, row, left, right, y, nextCheckboxName) {
    const baseline = y + PDF_BODY_SIZE + 2;
    if (row.choices) {
        document.text(row.label, left, y, { lineBreak: false });
        let x = left + document.widthOfString(row.label) + 12;
        row.choices.forEach(option => {
            document.save().lineWidth(0.7).strokeColor(`#${INK}`).rect(x, y + 1, 8.5, 8.5).stroke().restore();
            document.formCheckbox(nextCheckboxName(), x, y + 1, 8.5, 8.5, { borderColor: `#${INK}` });
            x += 13;
            document.text(option, x, y, { lineBreak: false });
            x += document.widthOfString(option) + 20;
        });
        return;
    }
    if (row.pair) {
        const middle = left + (right - left) / 2;
        document.text(row.pair[0], left, y, { lineBreak: false });
        drawRule(document, left + document.widthOfString(row.pair[0]) + 5, middle - 14, baseline);
        document.text(row.pair[1], middle, y, { lineBreak: false });
        drawRule(document, middle + document.widthOfString(row.pair[1]) + 5, right, baseline);
        return;
    }
    if (row.label) document.text(row.label, left, y, { lineBreak: false });
    drawRule(document, left + (row.label ? document.widthOfString(row.label) + 5 : 0), right, baseline);
}

async function createPdf() {
    await new Promise((resolveDocument, rejectDocument) => {
        const document = new PDFDocument({ size: "A4", margin: PDF_MARGIN, info: { Title: "Création de compte entreprise — Depann’Home Pro" } });
        const chunks = [];
        document.on("data", chunk => chunks.push(chunk));
        document.on("end", () => writeFile(pdfPath, Buffer.concat(chunks)).then(resolveDocument, rejectDocument));
        document.on("error", rejectDocument);

        const left = PDF_MARGIN;
        const right = document.page.width - PDF_MARGIN;
        const width = right - left;

        document.font("Helvetica-Bold");
        document.initForm();
        let checkboxNumber = 0;
        const nextCheckboxName = () => `creation_compte_option_${++checkboxNumber}`;

        document.fillColor(`#${GREEN}`).fontSize(19).text(title, left, PDF_MARGIN, { width });
        document.fillColor(`#${BLUE}`).fontSize(12.5).text(subtitle, { width, paragraphGap: 14 });
        document.font("Helvetica").fillColor(`#${INK}`).fontSize(PDF_BODY_SIZE);
        introduction.forEach(line => document.text(line, { width, paragraphGap: 7 }));

        let y = document.y + 10;
        sections.forEach(([heading, rows]) => {
            document.font("Helvetica-Bold").fillColor(`#${GREEN}`).fontSize(12).text(heading, left, y, { width, lineBreak: false });
            y += 20;
            document.font("Helvetica").fillColor(`#${INK}`).fontSize(PDF_BODY_SIZE);
            rows.forEach(row => {
                drawRow(document, row, left, right, y, nextCheckboxName);
                y += PDF_ROW_HEIGHT;
            });
            y += 8;
        });

        document.font("Helvetica").fillColor(`#${INK}`).fontSize(PDF_BODY_SIZE);
        document.text(closing[0], left, y + 8, { width, paragraphGap: 7 });
        closing.slice(1).forEach(line => document.text(line, { width, paragraphGap: 7 }));
        document.end();
    });
}

await mkdir(outputDirectory, { recursive: true });
await writeFile(docxPath, createDocx());
await createPdf();
console.log(`Documents générés :\n- ${pdfPath}\n- ${docxPath}`);
