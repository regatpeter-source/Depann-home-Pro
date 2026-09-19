import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const emailSource = readFileSync(new URL("../server/email.js", import.meta.url), "utf8");
const partnerRequestSource = readFileSync(new URL("../server/partner-requests.js", import.meta.url), "utf8");
const creatorSource = readFileSync(new URL("../server/creator.js", import.meta.url), "utf8");

test("toutes les demandes adressées à la plateforme utilisent la boîte Support configurée", () => {
    assert.match(emailSource, /function supportRecipient\(\)/);
    assert.match(emailSource, /process\.env\.SUPPORT_EMAIL/);
    for (const sender of ["sendSupportRequestEmail", "sendPartnershipRequestEmail", "sendSubscriptionChangeRequestEmail", "sendCommercialOfferRequestEmail"]) {
        const start = emailSource.indexOf(`export async function ${sender}`);
        const end = emailSource.indexOf("\nexport async function ", start + 1);
        const implementation = emailSource.slice(start, end < 0 ? emailSource.length : end);
        assert.match(implementation, /recipient: supportRecipient\(\)/, sender);
    }
});

test("une demande de partenariat déclenche un e-mail détaillé sans bloquer son enregistrement", () => {
    assert.match(partnerRequestSource, /sendPartnershipRequestEmail\(\{ requestId: rows\[0\]\.id, \.\.\.partnerRequest \}\)/);
    assert.match(partnerRequestSource, /\[partner-request\] email unavailable/);
    const template = emailSource.slice(emailSource.indexOf("export async function sendPartnershipRequestEmail"), emailSource.indexOf("export async function sendSubscriptionChangeRequestEmail"));
    for (const field of ["companyName", "organizationType", "contactName", "contactRole", "email", "phone", "website", "message"]) assert.match(template, new RegExp(field));
    assert.match(template, /replyTo: email/);
    assert.doesNotMatch(template, /Créateur|createur/i);
});

test("une demande d’offre ou de postes déclenche un e-mail détaillé sans bloquer son enregistrement", () => {
    assert.match(creatorSource, /sendSubscriptionChangeRequestEmail\(\{/);
    assert.match(creatorSource, /\[subscription-request\] email unavailable/);
    const template = emailSource.slice(emailSource.indexOf("export async function sendSubscriptionChangeRequestEmail"), emailSource.indexOf("export async function sendCommercialOfferRequestEmail"));
    for (const field of ["companyName", "contactName", "currentTier", "requestedTier", "requestedPcSeats", "requestedMobileSeats", "message"]) assert.match(template, new RegExp(field));
    assert.doesNotMatch(template, /Créateur|createur/i);
});

test("les e-mails de demandes utilisent des intitulés neutres", () => {
    const templates = emailSource.slice(emailSource.indexOf("export async function sendSupportRequestEmail"), emailSource.indexOf("export async function sendEmail"));
    assert.doesNotMatch(templates, /Créateur|createur/i);
});