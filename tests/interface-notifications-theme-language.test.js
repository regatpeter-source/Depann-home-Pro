import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { translateInterfaceText } from "../js/i18n.js";

const serverCollaboration = readFileSync(new URL("../server/collaboration.js", import.meta.url), "utf8");
const clientCollaboration = readFileSync(new URL("../js/collaboration.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
const style = readFileSync(new URL("../css/style.css", import.meta.url), "utf8");
const partnerDialogueStyle = readFileSync(new URL("../css/partner-dialogue.css", import.meta.url), "utf8");
const reportEditorStyle = readFileSync(new URL("../css/report-editor.css", import.meta.url), "utf8");


test("une mission partenaire conserve une seule notification non lue par destinataire", () => {
    assert.match(serverCollaboration, /target\?\.entityType === "partner_mission"/);
    assert.match(serverCollaboration, /entity_type=\$4 AND entity_id=\$5 AND read_at IS NULL/);
    assert.match(serverCollaboration, /SET event_type=\$3,title=\$6,body=\$7,payload=\$8::jsonb,created_at=NOW\(\)/);
    assert.match(serverCollaboration, /previous\.id<latest\.id/);
    assert.match(serverCollaboration, /read_at IS NULL AND id<>\$5/);
    assert.match(clientCollaboration, /`partner_mission\\u0000\$\{String\(missionId\)\}`/);
});


test("le thème sombre couvre les écrans et les principaux espaces de travail", () => {
    assert.match(style, /body\.dark-theme #authRoot,[\s\S]*body\.dark-theme #app\{[\s\S]*background:transparent/);
    assert.match(style, /body\.dark-theme :is\(\.client-panel,[^}]+background:var\(--surface\)/);
    assert.match(partnerDialogueStyle, /body\.dark-theme \.partner-dialogue-modal>\.partner-dialogue/);
    assert.match(partnerDialogueStyle, /background:var\(--surface-alt\)/);
    assert.match(reportEditorStyle, /body\.dark-theme\.report-writing-active \.report-editor-fullscreen/);
    assert.match(reportEditorStyle, /background:var\(--surface\)!important/);
});


test("la langue anglaise traduit le shell, les paramètres et les écrans dynamiques", () => {
    assert.equal(translateInterfaceText("Paramètres"), "Settings");
    assert.equal(translateInterfaceText("Missions partenaires"), "Partner missions");
    assert.equal(translateInterfaceText("Chargement des missions…"), "Loading missions…");
    assert.equal(translateInterfaceText("Dupont SARL"), "Dupont SARL");
    assert.match(app, /initializeInterfaceLanguage\(\)/);
    const i18n = readFileSync(new URL("../js/i18n.js", import.meta.url), "utf8");
    assert.match(i18n, /new MutationObserver/);
    assert.match(i18n, /depannhome:settings-changed/);
    assert.match(i18n, /language === "en" \? translateInterfaceText\(source\) : source/);
    assert.match(i18n, /SKIPPED_TAGS = new Set\(\["SCRIPT", "STYLE", "CODE", "PRE", "TEXTAREA"\]\)/);
});
