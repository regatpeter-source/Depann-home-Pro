import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyVatRegime, normalizeVatRegime, VAT_FRANCHISE_MENTION } from "../server/billing.js";

test("le régime de TVA conserve une valeur sûre et rétrocompatible", () => {
    assert.equal(normalizeVatRegime("standard"), "standard");
    assert.equal(normalizeVatRegime("franchise"), "franchise");
    assert.equal(normalizeVatRegime("valeur-inconnue"), "standard");
});

test("la franchise en base force toutes les lignes à zéro TVA", () => {
    const source = [{ description: "Prestation", quantity: 1, unitPrice: 100, vatRate: 20 }];
    const result = applyVatRegime(source, "franchise");
    assert.equal(result[0].vatRate, 0);
    assert.equal(source[0].vatRate, 20, "la normalisation ne doit pas modifier l’objet fourni");
});

test("le régime normal conserve les taux applicables par ligne", () => {
    assert.deepEqual(applyVatRegime([{ vatRate: 20 }, { vatRate: 10 }, { vatRate: 0 }], "standard").map(line => line.vatRate), [20, 10, 0]);
});

test("la mention légale de franchise est exacte et utilisée dans les PDF", () => {
    assert.equal(VAT_FRANCHISE_MENTION, "TVA non applicable, art. 293 B du CGI");
    const source = readFileSync(new URL("../server/billing.js", import.meta.url), "utf8");
    assert.match(source, /isVatFranchise \? VAT_FRANCHISE_MENTION/);
    assert.match(source, /grossVat = isVatFranchise \? 0/);
});

test("les devis et factures figent le régime fiscal de leur émission", () => {
    const source = readFileSync(new URL("../server/billing.js", import.meta.url), "utf8");
    assert.match(source, /vat_regime, issuer_tax_number, lines/);
    assert.match(source, /documentTaxIdentity/);
    assert.match(source, /applyVatRegime\(document\.lines, storedTaxIdentity\.vatRegime\)/);
});

test("les factures d’abonnement du Créateur neutralisent aussi la TVA en franchise", () => {
    const source = readFileSync(new URL("../server/invoicing.js", import.meta.url), "utf8");
    assert.match(source, /issuer\.vatRegime === "franchise" \? 0 : issuer\.vatRate/);
    assert.match(source, /vatRegime: normalizeVatRegime\(invoice\.issuerProfile\?\.vatRegime\)/);
});
