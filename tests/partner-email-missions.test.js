import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import PizZip from "pizzip";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { classifyPartnerEmail, extractMissionPayload, oauthErrorMessage, parseMailboxSyncPeriod, publicMailError } from "../server/partner-email.js";
import { extractPartnerDocumentText } from "../server/partner-email-document-extractor.js";

const serverSource = readFileSync(new URL("../server/partner-email.js", import.meta.url), "utf8");
const missionSource = readFileSync(new URL("../server/partner-missions.js", import.meta.url), "utf8");
const missionClientSource = readFileSync(new URL("../js/partner-missions.js", import.meta.url), "utf8");
const emailSettingsSource = readFileSync(new URL("../js/partner-email-settings.js", import.meta.url), "utf8");
const navigationSource = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
const schemaSource = readFileSync(new URL("../database/schema.sql", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const appClientSource = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");

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
    assert.match(appSource, /const requirePartnerEmailFeature = requireOrganizationFeature\("partnerMissions"\)/);
    assert.match(appSource, /if \(isPartnerEmailOAuthCallback\(request\)\) return next\(\)/);
    assert.match(missionSource, /intake\.partner_key LIKE 'email-%'/);
    assert.match(missionSource, /sourceType: partnerKey\.startsWith\("connection-"\) \? "depannhome_network" : partnerKey\.startsWith\("email-"\) \? "professional_email"/);
});

test("les callbacks OAuth mail utilisent l’état temporaire sans exiger le cookie de session", () => {
    const callback = serverSource.indexOf('app.get("/api/partner-email/oauth/:provider/callback"');
    const protection = serverSource.indexOf('app.use("/api/partner-email", requireAuthentication');
    assert.ok(callback >= 0 && callback < protection);
    assert.match(serverSource, /RETURNING owner_id,actor_id,encrypted_context/);
    assert.match(serverSource, /\[pending\.owner_id, provider,[\s\S]*?pending\.actor_id\]/);
    assert.doesNotMatch(serverSource.slice(callback, protection), /req\.user|getAccountOwnerId\(req\)/);
    assert.match(appSource, /function isPartnerEmailOAuthCallback\(request\)[\s\S]*?request\.method === "GET"[\s\S]*?google\|microsoft/);
});

test("Microsoft utilise Graph pour les comptes personnels et explique les refus sans exposer les secrets", () => {
    assert.match(serverSource, /MICROSOFT_IDENTITY_SCOPES/);
    assert.match(serverSource, /MICROSOFT_MAIL_SCOPES = "Mail\.Read Mail\.Send"/);
    assert.match(serverSource, /graph\.microsoft\.com\/v1\.0\/me\/mailFolders\/inbox\/messages/);
    assert.match(serverSource, /graph\.microsoft\.com\/v1\.0\/me\/messages\/\$\{encodeURIComponent\(messageId\)\}\/\$value/);
    assert.match(serverSource, /graph\.microsoft\.com\/v1\.0\/me\/sendMail/);
    assert.doesNotMatch(serverSource, /outlook\.office365\.com|smtp\.office365\.com|IMAP\.AccessAsUser\.All|SMTP\.Send/);
    assert.match(serverSource, /console\.warn\("\[partner-email-oauth\] authorization rejected", oauthErrorLog/);
    assert.doesNotMatch(serverSource, /console\.(?:warn|error)\([^\n]*clientSecret/);
    assert.match(oauthErrorMessage({ oauthCode: "invalid_client", oauthErrorCodes: [7000215] }, "microsoft"), /valeur du secret client/);
    assert.match(oauthErrorMessage({ oauthCode: "invalid_grant" }, "microsoft"), /expiré/);
    assert.match(oauthErrorMessage({ oauthErrorCodes: [50011] }, "microsoft"), /redirection/);
});

test("la synchronisation distingue un refus OAuth d’un accès Microsoft Graph refusé", () => {
    const mailErrorLogSource = serverSource.slice(serverSource.indexOf("function mailErrorLog"), serverSource.indexOf("function oauthPopup"));
    assert.match(publicMailError({ oauthProvider: "microsoft", oauthCode: "consent_required" }, { provider: "microsoft" }), /Mail\.Read et Mail\.Send/);
    assert.match(publicMailError({ authenticationFailed: true }, { provider: "microsoft" }), /Connecter Microsoft/);
    assert.match(publicMailError(new Error("Authentication failed"), { provider: "google" }), /refusé l’authentification/);
    assert.match(serverSource, /mailbox synchronization rejected/);
    assert.doesNotMatch(mailErrorLogSource, /accessToken|refreshToken|clientSecret/);
});

test("les missions e-mail utilisent la même interface que les missions internes et externes", () => {
    assert.match(missionClientSource, /shell\.querySelectorAll\('\.partner-mission-tabs'\)\[1\]\.innerHTML = externalTabs/);
    assert.match(missionClientSource, /emailCandidates[\s\S]*\.map\(emailCandidateMission\)/);
    assert.match(missionClientSource, /class="partner-mission-card priority-/);
    assert.match(missionClientSource, /status: "email_candidate"/);
    assert.match(missionClientSource, /id="syncPartnerEmail"/);
    assert.match(missionClientSource, /id="partnerEmailSyncFrom"/);
    assert.match(missionClientSource, /id="partnerEmailSyncTo"/);
    assert.match(missionClientSource, /JSON\.stringify\(\{ from, to \}\)/);
    assert.doesNotMatch(missionClientSource, /data-mission-tab="email-inbox"/);
    assert.doesNotMatch(missionClientSource, /partner-email-candidate(?:-heading|-select)?/);
});

test("la recherche manuelle accepte une période inclusive de 31 jours sans déplacer le curseur automatique", () => {
    const period = parseMailboxSyncPeriod({ from: "2026-08-01", to: "2026-08-31" });
    assert.equal(period.from, "2026-08-01");
    assert.equal(period.to, "2026-08-31");
    assert.equal(period.since.toISOString(), "2026-08-01T00:00:00.000Z");
    assert.equal(period.before.toISOString(), "2026-09-01T00:00:00.000Z");
    assert.throws(() => parseMailboxSyncPeriod({ from: "2026-08-01", to: "2026-09-01" }), /31 jours/);
    assert.throws(() => parseMailboxSyncPeriod({ from: "2026-08-31", to: "2026-08-01" }), /postérieure/);
    assert.throws(() => parseMailboxSyncPeriod({ from: "2026-02-30", to: "2026-02-30" }), /valides/);
    assert.match(serverSource, /periodUids\(client, syncPeriod\)/);
    assert.match(serverSource, /advanceCursor: !syncPeriod/);
    assert.match(serverSource, /PERIOD_FETCH_LIMIT = 500/);
});

test("la boîte professionnelle se configure dans Paramètres Réseau", () => {
    assert.match(navigationSource, /renderPartnerEmailSettings\(container\)/);
    assert.match(navigationSource, /depannhome:open-partner-email-settings/);
    assert.match(navigationSource, /ROUTES\.settings && organizationFeatureEnabled\("partnerMissions"\)/);
    assert.match(navigationSource, /organizationFeatureEnabled\("partnerConnections"\)\) renderPartnerConnections\(container\)/);
    assert.match(emailSettingsSource, /id="partnerEmailImapForm"/);
    assert.match(emailSettingsSource, /\/api\/partner-email\/configuration/);
    assert.match(emailSettingsSource, /data-email-oauth="microsoft"/);
    assert.match(emailSettingsSource, /emailPasswordToggle/);
    assert.match(emailSettingsSource, /password\.type = visible \? "text" : "password"/);
    assert.match(emailSettingsSource, /aria-pressed/);
    assert.doesNotMatch(missionClientSource, /id="partnerEmailImapForm"/);
    assert.doesNotMatch(missionClientSource, /activeMissionTab === "email-settings"/);
    assert.doesNotMatch(missionClientSource, /id="configurePartnerEmail"/);
});

test("les erreurs IMAP et SMTP attendues ne remontent pas en erreur serveur 500", () => {
    const configurationRoute = serverSource.slice(serverSource.indexOf('app.put("/api/partner-email/configuration"'), serverSource.indexOf('app.post("/api/partner-email/oauth/:provider/authorize"'));
    assert.match(configurationRoute, /throw httpError\(422, publicMailError\(error, \{ configuration: true \}\)\)/);
    assert.match(configurationRoute, /L’ancien mot de passe enregistré n’est plus lisible/);
    assert.match(serverSource, /connectionTimeout: 15000/);
    assert.match(serverSource, /Le serveur de messagerie ne répond pas/);
});

test("les comptes Microsoft personnels sont orientés vers OAuth et non vers le mot de passe IMAP", () => {
    assert.match(serverSource, /isMicrosoftMailbox\(input\.emailAddress\)/);
    assert.match(serverSource, /Outlook, Hotmail, Live et MSN exigent la connexion OAuth Microsoft/);
    assert.match(emailSettingsSource, /Connecter Microsoft \(Outlook, Hotmail, Microsoft 365\)/);
    assert.match(emailSettingsSource, /Microsoft refuse l’authentification IMAP classique/);
});

test("Gmail personnel dispose d’un parcours par mot de passe d’application sans OAuth obligatoire", () => {
    assert.match(emailSettingsSource, /isGmailMailbox/);
    assert.match(emailSettingsSource, /imap\.gmail\.com/);
    assert.match(emailSettingsSource, /smtp\.gmail\.com/);
    assert.match(emailSettingsSource, /myaccount\.google\.com\/apppasswords/);
    assert.match(emailSettingsSource, /jamais votre mot de passe Gmail habituel/);
    assert.match(serverSource, /normalizeMailboxPassword/);
    assert.match(serverSource, /password\.replace\(\/\\s\+\/g, ""\)/);
});

test("un timeout ImapFlow ne peut pas arrêter le processus Node", () => {
    assert.equal((serverSource.match(/new ImapFlow/g) || []).length, 1);
    assert.match(serverSource, /function createImapClient\(options\)/);
    assert.match(serverSource, /client\.on\("error", error => console\.warn/);
    assert.equal((serverSource.match(/createImapClient\(/g) || []).length, 3);
});

test("Missions partenaires rappelle la configuration uniquement sans boîte connectée", () => {
    assert.match(missionClientSource, /!dashboard\.partnerEmail\.connections\.length/);
    assert.match(missionClientSource, /Aucune boîte mail professionnelle n’est configurée/);
    assert.match(missionClientSource, /id="openPartnerEmailSettings"/);
    assert.match(missionClientSource, /new CustomEvent\("depannhome:open-partner-email-settings"\)/);
});

test("la détection Sandbox ne provoque pas de 403 sans connecteurs", () => {
    assert.match(appClientSource, /features\.connectors !== true\) return/);
    assert.match(appSource, /request\.method === "GET" && request\.path === "\/"/);
    assert.match(appSource, /return requirePartnerSandboxFeature\(request, response, next\)/);
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

test("l’assuré est toujours l’identité de la fiche client", () => {
    const payload = extractMissionPayload(
        { id: 43, subject: "Mission", body_text: "Client : Plateforme prestataire", sender_name: "Cabinet Dupont", message_id: "mail-43" },
        "Nom et prénom de l’assurée : Marie Martin\nAdresse : 8 rue des Assurés\nTéléphone : 0612345678"
    );
    assert.equal(payload.client.name, "Marie Martin");
    assert.notEqual(payload.client.name, "Plateforme prestataire");

    const unidentified = extractMissionPayload({ id: 44, subject: "Mission", body_text: "", sender_name: "Cabinet Dupont", message_id: "mail-44" });
    assert.equal(unidentified.client.name, "Client à identifier");
});

test("une pièce illisible ou une image sans OCR ne bloque pas l’import", async () => {
    const text = await extractPartnerDocumentText([
        { mime: "application/pdf", buffer: Buffer.from("PDF corrompu") },
        { mime: "image/png", buffer: Buffer.from("image non OCRisée") },
        { mime: "text/plain", buffer: Buffer.from("Client : Client Valide") }
    ]);
    assert.match(text, /Client Valide/);
});
