import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { createQuitusPdf } from "../server/calendar.js";
import { buildQuitusCustomModel } from "../server/document-templates.js";

const schema = readFileSync(new URL("../database/schema.sql", import.meta.url), "utf8");
const server = readFileSync(new URL("../server/calendar.js", import.meta.url), "utf8");
const client = readFileSync(new URL("../js/calendar.js", import.meta.url), "utf8");
const templates = readFileSync(new URL("../server/document-templates.js", import.meta.url), "utf8");
const approval = "Lu et approuvé – Travaux réalisés et intervention acceptée";

const event = {
    id: 42,
    title: "Remplacement du chauffe-eau",
    clientName: "Sophie Martin",
    clientData: { name: "Sophie Martin", address: "20 rue B", postalCode: "75000", city: "Paris" },
    location: "20 rue B, 75000 Paris",
    date: "2026-08-22",
    startTime: "09:00",
    endTime: "11:00",
    notes: "Appareil remplacé et testé."
};
const quitus = { signedBy: "Sophie Martin", observations: "Réserve sur la peinture murale.", approved: true, signature: "" };
const profile = { companyName: "Société Test", city: "Nantes" };

test("quitus observations and explicit approval have dedicated persistent fields", () => {
    assert.match(schema, /quitus_observations VARCHAR\(2000\) NOT NULL DEFAULT ''/);
    assert.match(schema, /quitus_approved BOOLEAN NOT NULL DEFAULT FALSE/);
    assert.match(server, /value\?\.approved === true/);
    assert.match(server, /Le client doit cocher « Lu et approuvé » avant de signer/);
    assert.match(server, /quitus_observations = \$5, quitus_approved = \$6/);
});

test("the smartphone form previews the legal declaration and submits observations and approval", () => {
    assert.match(client, /quitus-legal-declaration/);
    assert.match(client, /textarea name="observations" maxlength="2000"/);
    assert.match(client, /input name="approved" type="checkbox" required/);
    assert.match(client, /Signature du client précédée de la mention/);
    assert.match(client, /observations: formData\.get\("observations"\), approved: true/);
    assert.ok(client.includes(approval));
});

test("custom quitus data keeps legal acceptance separate from internal notes", () => {
    const model = buildQuitusCustomModel(event, quitus, profile);
    assert.equal(model.document.observations, quitus.observations);
    assert.equal(model.document.approval, approval);
    assert.equal(model.document.approved, true);
    assert.match(model.document.legalText, /Je soussigné\(e\), Sophie Martin/);
    assert.match(model.document.legalText, /20 rue B, 75000 Paris/);
    assert.match(model.document.legalText, /Fait le 2026-08-22, à Paris/);
    assert.doesNotMatch(model.document.observations, /Appareil remplacé/);
    assert.match(templates, /"document\.legalText"/);
    assert.match(templates, /"document\.approval"/);
});

test("the integrated legal quitus remains a valid PDF", async () => {
    const buffer = await createQuitusPdf(event, quitus, profile);
    const pdf = await PDFDocument.load(buffer);
    assert.equal(buffer.subarray(0, 4).toString(), "%PDF");
    assert.ok(pdf.getPageCount() >= 1);
});
