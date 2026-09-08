import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const missions = readFileSync(new URL("../server/partner-missions.js", import.meta.url), "utf8");
const serverClients = readFileSync(new URL("../server/clients.js", import.meta.url), "utf8");
const clients = readFileSync(new URL("../js/clients.js", import.meta.url), "utf8");
const calendar = readFileSync(new URL("../js/calendar.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../css/style.css", import.meta.url), "utf8");

test("email extraction marks automatically populated client instructions", () => {
    assert.match(missions, /automaticNotes: true/);
    assert.match(missions, /notesSource: notesRemainAutomatic \? "email_extractor" : ""/);
    assert.match(serverClients, /startsWith\("email-"\) \? "email_extractor" : ""/);
});

test("automatic instructions are visually limited to five lines", () => {
    assert.match(styles, /\.client-notes-auto\{[\s\S]*?-webkit-line-clamp:5;[\s\S]*?line-clamp:5;[\s\S]*?overflow:hidden/);
    assert.match(clients, /automaticClientNotesClass\(client\)/);
    assert.match(calendar, /automaticClientNotesClass\(client\)/);
});

test("a human client save removes the automatic limit without limiting entered text", () => {
    const formReader = clients.slice(clients.indexOf("async function readClientForm"), clients.indexOf("function saveClient"));
    assert.match(formReader, /notes: String\(formData\.get\("notes"\) \|\| ""\)\.trim\(\)/);
    assert.match(formReader, /notesSource: ""/);
    assert.doesNotMatch(formReader, /notes[\s\S]{0,100}slice\(|notes[\s\S]{0,100}maxlength/);
    assert.match(serverClients, /submittedClient\.notes === existing\.rows\[0\]\?\.client\?\.notes \? "email_extractor" : ""/);
});
