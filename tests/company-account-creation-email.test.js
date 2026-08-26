import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import PizZip from "pizzip";

const script = "scripts/generate-company-account-creation-email.js";
const pdf = "assets/commercial/modele-email-creation-compte-entreprise-depannhome-pro.pdf";
const docx = "assets/commercial/modele-email-creation-compte-entreprise-depannhome-pro.docx";

test("le modèle de création de compte entreprise est générable en PDF et Word modifiable", () => {
    execFileSync(process.execPath, [script], { stdio: "pipe" });
    assert.ok(existsSync(pdf));
    assert.ok(existsSync(docx));
    const pdfContent = readFileSync(pdf);
    assert.match(pdfContent.subarray(0, 8).toString("ascii"), /^%PDF-/);
    assert.equal((pdfContent.toString("latin1").match(/\/Type \/Page\b/g) || []).length, 1);
    assert.match(pdfContent.toString("latin1"), /\/AcroForm/);
    const document = new PizZip(readFileSync(docx)).file("word/document.xml")?.asText() || "";
    assert.match(document, /Informations nécessaires à la création de votre compte entreprise/);
    assert.match(document, /SIRET/);
    assert.match(document, /Administrateur principal du compte/);
    assert.match(document, /Configuration souhaitée/);
    assert.match(document, /w:ascii="Arial"/);
    assert.match(document, /w:pgMar w:top="600" w:right="650" w:bottom="600" w:left="650"/);
    const generator = readFileSync(script, "utf8");
    assert.match(generator, /function writePdfLine/);
    assert.match(generator, /\.rect\(x, y \+ 1, 6\.5, 6\.5\)\.stroke\(\)/);
    assert.match(generator, /document\.initForm\(\)/);
    assert.match(generator, /document\.formCheckbox\(/);
});
