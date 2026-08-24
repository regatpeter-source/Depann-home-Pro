import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyPartnerEmail } from "../server/partner-email.js";

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
