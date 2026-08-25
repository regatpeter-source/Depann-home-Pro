import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sanitizeOfferRequest } from "../server/public-offers.js";

const emailSource = readFileSync(new URL("../server/email.js", import.meta.url), "utf8");

const validRequest = {
    companyName: "Entreprise Exemple",
    contactName: "Camille Martin",
    email: "Camille.Martin@example.fr",
    phone: "02 00 00 00 00",
    teamSize: "2-5",
    offer: "basic-plus",
    message: "Nous souhaitons équiper deux postes PC et trois mobiles.",
    privacyConsent: true
};

test("une demande d’offre publique valide est nettoyée", () => {
    const result = sanitizeOfferRequest(validRequest);
    assert.equal(result.ok, true);
    assert.equal(result.email, "camille.martin@example.fr");
    assert.equal(result.offer, "basic-plus");
});

test("une demande d’offre exige des coordonnées, un besoin et le consentement", () => {
    assert.equal(sanitizeOfferRequest({ ...validRequest, email: "invalide" }).ok, false);
    assert.equal(sanitizeOfferRequest({ ...validRequest, message: "Court" }).ok, false);
    assert.equal(sanitizeOfferRequest({ ...validRequest, privacyConsent: false }).ok, false);
    assert.equal(sanitizeOfferRequest({ ...validRequest, offer: "enterprise" }).ok, false);
});

test("les demandes commerciales sont envoyées à l’adresse support officielle", () => {
    assert.match(emailSource, /sendCommercialOfferRequestEmail/);
    assert.match(emailSource, /recipient: "support@depannhomepro\.com"/);
    assert.match(emailSource, /replyTo: email/);
});