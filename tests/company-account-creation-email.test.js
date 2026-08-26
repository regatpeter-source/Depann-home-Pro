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
    assert.match(readFileSync(pdf).subarray(0, 8).toString("ascii"), /^%PDF-/);
    const document = new PizZip(readFileSync(docx)).file("word/document.xml")?.asText() || "";
    assert.match(document, /Informations nécessaires à la création de votre compte entreprise/);
    assert.match(document, /SIRET/);
    assert.match(document, /Administrateur principal du compte/);
    assert.match(document, /Configuration souhaitée/);
    const generator = readFileSync(script, "utf8");
    assert.match(generator, /function writePdfLine/);
    assert.match(generator, /\.rect\(x, y \+ 1, 8, 8\)\.stroke\(\)/);
});
