import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const serverSource = readFileSync(new URL("../server/partner-dialogue.js", import.meta.url), "utf8");
const clientSource = readFileSync(new URL("../js/partner-dialogue.js", import.meta.url), "utf8");
const styleSource = readFileSync(new URL("../css/partner-dialogue.css", import.meta.url), "utf8");
const schemaSource = readFileSync(new URL("../database/schema.sql", import.meta.url), "utf8");

test("the journal scrolls inside its grid row without overlapping the composer", () => {
    assert.match(styleSource, /grid-template-rows:auto auto auto minmax\(0,1fr\) auto/);
    assert.match(styleSource, /\.partner-dialogue \.partner-dialogue-thread\{[\s\S]*?min-height:0;[\s\S]*?max-height:100%;[\s\S]*?overflow:auto;/);
    assert.match(styleSource, /\.partner-dialogue \.partner-dialogue-composer\{[\s\S]*?position:relative;[\s\S]*?z-index:2;/);
    assert.doesNotMatch(styleSource, /@media\(max-width:760px\)[\s\S]*?\.partner-dialogue \.partner-dialogue-composer\{\s*position:sticky/);
});

test("source and receiver visibility are stored independently", () => {
    assert.match(schemaSource, /depannhome_partner_dialogue_messages[\s\S]*?receiver_visible BOOLEAN NOT NULL DEFAULT TRUE/);
    assert.match(schemaSource, /depannhome_partner_dialogue_attachments[\s\S]*?receiver_visible BOOLEAN NOT NULL DEFAULT TRUE/);
    assert.match(serverSource, /sent-missions\/:missionId\/entries\/:messageId\/visibility/);
    assert.match(serverSource, /sent-missions\/:missionId\/attachments\/:attachmentId\/visibility/);
    assert.match(serverSource, /sender_type='partner'/);
    assert.match(serverSource, /sender_type<>'partner'/);
});

test("private source exchanges are filtered from receiver payloads and downloads", () => {
    assert.match(serverSource, /message\.sender_type<>'partner' OR message\.receiver_visible=TRUE/);
    assert.match(serverSource, /message\.receiver_visible=TRUE AND attachment\.receiver_visible=TRUE/);
    assert.match(serverSource, /receiverVisible = Boolean\(req\.body\?\.partnerVisible\)/);
});

test("each company receives visibility controls only for its own exchanges", () => {
    assert.match(clientSource, /const ownsMessage = sourceDialogue \? message\.senderType === "partner" : message\.senderType !== "partner"/);
    assert.match(clientSource, /data-source-visibility/);
    assert.match(clientSource, /data-source-attachment-visibility/);
    assert.doesNotMatch(clientSource, /if \(data\.sourceDialogue\) section\.querySelectorAll\("\.partner-visibility-toggle"\)/);
});

test("source-side shared files use authenticated sent-mission download routes", () => {
    assert.match(serverSource, /sent-missions\/:missionId\/attachments\/:attachmentId/);
    assert.match(serverSource, /sent-missions\/:missionId\/items\/:itemId\/download/);
    assert.match(serverSource, /const sourceBase = `\/api\/partner-dialogue\/sent-missions\/\$\{mission\.id\}`/);
});

test("the compact attachment area aligns attach, share and send controls", () => {
    assert.match(clientSource, /partner-composer-actions/);
    assert.match(clientSource, /<strong>Joindre des documents ou photos<\/strong><span>Glissez-déposez vos fichiers ici<\/span>/);
    assert.match(clientSource, /Glissez-déposez vos fichiers ici/);
    assert.match(clientSource, /Parcourir le PC/);
    assert.doesNotMatch(clientSource, /enregistrés dans la base sécurisée de la mission/);
    assert.match(clientSource, /setupAttachmentPicker\(form\)/);
    assert.match(clientSource, /event\.dataTransfer\?\.files/);
    assert.match(clientSource, /formData\.delete\("files"\)/);
    assert.match(clientSource, /attachmentFiles\(\)\.forEach\(file => formData\.append\("files", file, file\.name\)\)/);
    assert.match(clientSource, /const MAX_ATTACHMENT_FILES = 5/);
    assert.match(clientSource, /Les dossiers complets ne sont pas importés/);
    assert.match(styleSource, /\.partner-dialogue \.partner-composer-files\.drag-active/);
    assert.match(styleSource, /\.partner-dialogue \.partner-composer-actions\{[\s\S]*?display:grid;[\s\S]*?grid-template-columns:repeat\(3,minmax\(0,1fr\)\);[\s\S]*?align-items:stretch;/);
    assert.match(styleSource, /\.partner-dialogue \.partner-composer-files\{[\s\S]*?height:44px;/);
    assert.match(styleSource, /\.partner-dialogue \.journal-share-control\{[\s\S]*?height:44px;/);
    assert.match(styleSource, /\.partner-dialogue \.partner-dialogue-composer button\[type="submit"\]\{[\s\S]*?height:44px;/);
});
