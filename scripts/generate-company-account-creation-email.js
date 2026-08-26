import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import PDFDocument from "pdfkit";
import PizZip from "pizzip";

const outputDirectory = resolve("assets/commercial");
const pdfPath = resolve(outputDirectory, "modele-email-creation-compte-entreprise-depannhome-pro.pdf");
const docxPath = resolve(outputDirectory, "modele-email-creation-compte-entreprise-depannhome-pro.docx");

const sections = [
    ["Informations entreprise", [
        "Raison sociale : ________________________________________________",
        "Nom commercial (si différent) : _________________________________",
        "SIRET (14 chiffres) : ____________________________________________",
        "Adresse complète : ______________________________________________",
        "Code postal : __________________  Ville : ________________________",
        "Pays : _________________________",
        "Téléphone principal : ____________________________________________",
        "Téléphone secondaire (facultatif) : _____________________________",
        "E-mail professionnel : __________________________________________",
        "E-mail de facturation : _________________________________________",
        "Site internet (facultatif) : ____________________________________"
    ]],
    ["Administrateur principal du compte", [
        "Nom et prénom : ________________________________________________",
        "Fonction : ______________________________________________________",
        "E-mail de connexion : ___________________________________________",
        "Numéro de téléphone : ___________________________________________"
    ]],
    ["Configuration souhaitée", [
        "Offre : ☐ Basic     ☐ Basic+     ☐ Pro",
        "Nombre de postes PC : __________  Nombre d’accès mobiles : ______",
        "Type d’interface : ☐ Standard  ☐ Groupe multi-entreprises  ☐ Partenaire",
        "Date de début souhaitée : ______________________________________",
        "Référence de facturation / bon de commande (si applicable) :",
        "_________________________________________________________________"
    ]],
    ["Informations Réseau Depann’Home Pro (facultatif)", [
        "Domaines d’intervention : ______________________________________",
        "Départements / zones d’intervention : __________________________",
        "Rayon d’intervention (km) ou couverture nationale : ____________",
        "Présentation courte de l’entreprise : __________________________",
        "_________________________________________________________________",
        "Recevoir des missions partenaires : ☐ Oui     ☐ Non",
        "Logo de l’entreprise joint : ☐ Oui     ☐ Non"
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

function wordParagraph(text, { bold = false, size = 22, spacingAfter = 120 } = {}) {
    const properties = `<w:pPr><w:spacing w:after="${spacingAfter}"/></w:pPr>`;
    const runProperties = `<w:rPr>${bold ? "<w:b/>" : ""}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>`;
    return `<w:p>${properties}<w:r>${runProperties}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function createDocx() {
    const body = [
        wordParagraph("Depann’Home Pro", { bold: true, size: 34, spacingAfter: 70 }),
        wordParagraph("Informations nécessaires à la création de votre compte entreprise", { bold: true, size: 28, spacingAfter: 280 }),
        ...introduction.map(line => wordParagraph(line, { spacingAfter: 150 })),
        ...sections.flatMap(([heading, lines]) => [
            wordParagraph(heading, { bold: true, size: 25, spacingAfter: 150 }),
            ...lines.map(line => wordParagraph(line, { spacingAfter: 100 })),
            wordParagraph("", { spacingAfter: 80 })
        ]),
        ...closing.map(line => wordParagraph(line, { spacingAfter: 150 })),
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1000" w:right="1100" w:bottom="1000" w:left="1100"/></w:sectPr>'
    ].join("");
    const zip = new PizZip();
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
    zip.folder("_rels").file(".rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
    zip.folder("word").file("document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
    return zip.generate({ type: "nodebuffer", compression: "DEFLATE" });
}

async function createPdf() {
    await new Promise((resolveDocument, rejectDocument) => {
        const document = new PDFDocument({ size: "A4", margin: 50, info: { Title: "Création de compte entreprise — Depann’Home Pro" } });
        const chunks = [];
        document.on("data", chunk => chunks.push(chunk));
        document.on("end", () => writeFile(pdfPath, Buffer.concat(chunks)).then(resolveDocument, rejectDocument));
        document.on("error", rejectDocument);
        document.fillColor("#0A5C36").font("Helvetica-Bold").fontSize(20).text("Depann’Home Pro");
        document.fillColor("#003B73").fontSize(15).text("Informations nécessaires à la création de votre compte entreprise", { paragraphGap: 18 });
        document.fillColor("#172033").font("Helvetica").fontSize(10.5);
        introduction.forEach(line => document.text(line, { paragraphGap: 8 }));
        sections.forEach(([heading, lines]) => {
            document.moveDown(0.7).fillColor("#0A5C36").font("Helvetica-Bold").fontSize(12).text(heading);
            document.fillColor("#172033").font("Helvetica").fontSize(10);
            lines.forEach(line => document.text(line, { indent: 8, paragraphGap: 4 }));
        });
        document.moveDown(1);
        closing.forEach(line => document.text(line, { paragraphGap: 7 }));
        document.end();
    });
}

await mkdir(outputDirectory, { recursive: true });
await writeFile(docxPath, createDocx());
await createPdf();
console.log(`Documents générés :\n- ${pdfPath}\n- ${docxPath}`);
