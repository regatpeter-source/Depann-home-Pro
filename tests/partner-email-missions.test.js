import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import PizZip from "pizzip";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { classifyPartnerEmail, extractMissionPayload } from "../server/partner-email.js";
import { extractPartnerDocumentText } from "../server/partner-email-document-extractor.js";

const serverSource = readFileSync(new URL("../server/partner-email.js", import.meta.url), "utf8");
const missionSource = readFileSync(new URL("../server/partner-missions.js", import.meta.url), "utf8");
const schemaSource = readFileSync(new URL("../database/schema.sql", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");

const pdf = [{ contentType: "application/pdf", size: 1200 }];

test("une demande opérationnelle d’un expéditeur autorisé dépasse le seuil strict", () => {
    const result = classifyPartnerEmail({
        subject: "Nouvelle mission urgente – dossier SIN-2026-42",
        text: "Client : Marie Martin\nAdresse : 2 rue des Lilas\nTéléphone : 0600000000",
        from: "missions@assureur.test",
        allowedSenders: ["assureur.test"],
        attachments: pdf
    });
    assert.equal(result.trustedSender, true);
    assert.equal(result.likelyMission, true);
    assert.ok(result.score >= 80);
    assert.ok(result.reasons.some(reason => /Expéditeur autorisé/.test(reason)));
});

test("un expéditeur inconnu reste en validation humaine même avec de forts indices", () => {
    const result = classifyPartnerEmail({
        subject: "Mission urgente d’intervention sinistre",
        text: "Client : Marie Martin\nAdresse : 2 rue des Lilas\nRéférence : ABC-42",
        from: "inconnu@example.test",
        attachments: pdf
    });
    assert.equal(result.trustedSender, false);
    assert.equal(result.likelyMission, false);
    assert.ok(result.score < 80);
    assert.ok(result.reasons.some(reason => /Validation humaine/.test(reason)));
});

test("les relances et réponses automatiques ne deviennent pas des missions", () => {
    const reminder = classifyPartnerEmail({ subject: "Relance facture impayée", text: "Merci de procéder au règlement", from: "missions@assureur.test", allowedSenders: ["assureur.test"] });
    const automatic = classifyPartnerEmail({ subject: "Automatic reply: mission reçue", text: "Out of office", from: "missions@assureur.test", allowedSenders: ["assureur.test"], automatic: true, attachments: pdf });
    assert.equal(reminder.likelyMission, false);
    assert.equal(automatic.likelyMission, false);
    assert.ok(automatic.reasons.some(reason => /automatique/.test(reason)));
});

test("les secrets, dédoublonnages et pièces privées sont définis côté serveur", () => {
    assert.match(serverSource, /encryptElectronicInvoicingCredentials/);
    assert.match(serverSource, /UNIQUE\(owner_id,connection_id,message_id\)/);
    assert.match(serverSource, /partnerVisible: false/);
    assert.match(serverSource, /MAX_ATTACHMENT_BYTES = 5 \* 1024 \* 1024/);
    assert.doesNotMatch(serverSource, /encrypted_credentials AS/);
    assert.match(schemaSource, /depannhome_partner_email_messages[\s\S]*?status IN \('candidate','processing','imported','ignored','rejected'\)/);
});

test("la boîte mail dépend de Missions partenaires et non des connecteurs Pro", () => {
    assert.match(appSource, /app\.use\("\/api\/partner-email", requireAuthentication, requireOrganizationFeature\("partnerMissions"\)\)/);
    assert.match(missionSource, /intake\.partner_key LIKE 'email-%'/);
    assert.match(missionSource, /sourceType: partnerKey\.startsWith\("connection-"\) \? "depannhome_network" : partnerKey\.startsWith\("email-"\) \? "professional_email"/);
});

test("les coordonnées client sont extraites des pièces TXT, PDF, DOCX et XLSX", async () => {
    const pdfDocument = await PDFDocument.create();
    const page = pdfDocument.addPage();
    const font = await pdfDocument.embedFont(StandardFonts.Helvetica);
    page.drawText("Client : Alice PDF", { x: 40, y: 780, font, size: 12 });
    page.drawText("Adresse : 4 rue du PDF", { x: 40, y: 760, font, size: 12 });
    const pdfBuffer = Buffer.from(await pdfDocument.save());

    const docx = new PizZip();
    docx.file("word/document.xml", "<w:document xmlns:w=\"x\"><w:body><w:p><w:r><w:t>Client : Alice DOCX</w:t></w:r></w:p><w:p><w:r><w:t>Ville : Nantes</w:t></w:r></w:p></w:body></w:document>");
    const docxBuffer = docx.generate({ type: "nodebuffer" });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Mission");
    sheet.addRow(["Client", "Alice XLSX"]);
    sheet.addRow(["Téléphone", "06 11 22 33 44"]);
    const xlsxBuffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const fixtures = [
        { mime: "text/plain", buffer: Buffer.from("Client : Alice TXT\nE-mail : alice@example.test") },
        { mime: "application/pdf", buffer: pdfBuffer },
        { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: docxBuffer },
        { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: xlsxBuffer }
    ];
    const texts = await Promise.all(fixtures.map(attachment => extractPartnerDocumentText([attachment])));
    assert.match(texts[0], /Alice TXT/);
    assert.match(texts[1], /Alice PDF/);
    assert.match(texts[2], /Alice DOCX/);
    assert.match(texts[3], /Alice XLSX/);
});

test("le mail garde la priorité et les documents complètent les champs manquants", () => {
    const payload = extractMissionPayload({ id: 42, subject: "Mission", body_text: "Client : Camille Mail\nTéléphone : 0600000000", sender_name: "Assureur", message_id: "mail-42" }, "Client : Alice Document\nTéléphone : 0711111111\nE-mail : alice@example.test\nAdresse : 12 rue des Lilas\nCode postal : 44000\nVille : Nantes\nSinistre : SIN-42\nAssureur : Exemple Assurance");
    assert.equal(payload.client.name, "Camille Mail");
    assert.equal(payload.client.phone, "0600000000");
    assert.equal(payload.client.email, "alice@example.test");
    assert.equal(payload.client.address, "12 rue des Lilas, 44000");
    assert.equal(payload.client.city, "Nantes");
    assert.equal(payload.claimNumber, "SIN-42");
    assert.equal(payload.insurance, "Exemple Assurance");
});

test("une pièce illisible ou une image sans OCR ne bloque pas l’import", async () => {
    const text = await extractPartnerDocumentText([
        { mime: "application/pdf", buffer: Buffer.from("PDF corrompu") },
        { mime: "image/png", buffer: Buffer.from("image non OCRisée") },
        { mime: "text/plain", buffer: Buffer.from("Client : Client Valide") }
    ]);
    assert.match(text, /Client Valide/);
});
