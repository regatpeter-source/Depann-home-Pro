import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import PizZip from "pizzip";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

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
    assert.match(document, /Logo de l’entreprise joint/);
    assert.match(document, /nous créerons votre espace/);
    assert.match(document, /w:ascii="Arial"/);
    assert.match(document, /<w:sym w:font="Wingdings" w:char="F0A8"\/>/);
    assert.match(document, /<w:tab w:val="right" w:leader="underscore" w:pos="10606"\/>/);
});

test("le PDF tient sur une page, remplit sa surface et propose des cases à cocher", async () => {
    const file = await getDocument({ url: pdf, useSystemFonts: true }).promise;
    assert.equal(file.numPages, 1);
    const page = await file.getPage(1);
    const [, , pageWidth, pageHeight] = page.view;
    const items = (await page.getTextContent()).items.filter(item => item.str.trim());
    const xs = items.map(item => item.transform[4]);
    const ys = items.map(item => item.transform[5]);
    assert.ok(Math.min(...xs) < 50, "le contenu doit commencer à la marge gauche");
    assert.ok(Math.max(...xs) > pageWidth * 0.5, "le contenu doit occuper la largeur de la page");
    assert.ok(Math.max(...ys) > pageHeight - 70, "le contenu doit démarrer en haut de page");
    assert.ok(Math.min(...ys) < pageHeight * 0.14, "le contenu doit descendre jusqu’au bas de page");
    assert.equal((await page.getAnnotations()).filter(annotation => annotation.fieldType === "Btn").length, 10);
});
