import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isPrivateIp, sanitizePdpApiUrl } from "../server/accounting.js";

const accountingServer = readFileSync(new URL("../server/accounting.js", import.meta.url), "utf8");
const accountingClient = readFileSync(new URL("../js/accounting.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const serviceWorker = readFileSync(new URL("../service-worker.js", import.meta.url), "utf8");

test("la Sandbox comptable et son connecteur fictif sont retirés du produit", () => {
    assert.doesNotMatch(app, /accounting-sandbox|AccountingSandbox/);
    assert.doesNotMatch(serviceWorker, /accounting-sandbox/);
    assert.doesNotMatch(accountingClient.slice(0, accountingClient.indexOf("function renderLegacyElectronic")), /accounting-sandbox|Sandbox comptable/);
    assert.doesNotMatch(accountingServer.slice(0, accountingServer.indexOf("export async function initializeAccounting")), /remoteId: `sandbox-|bac à sable PDP|Transmission de test/);
});

test("chaque entreprise configure une plateforme réelle et son endpoint UBL", () => {
    for (const field of ["pdp_platform_name", "pdp_api_url", "pdp_identifier", "pdp_api_secret"]) assert.match(accountingServer, new RegExp(field));
    assert.match(accountingServer, /body: document\.structuredData/);
    assert.match(accountingServer, /"Idempotency-Key": document\.structuredSha256/);
    assert.match(accountingServer, /Authorization = `Bearer \$\{apiKey\}`/);
    assert.match(accountingServer, /\["invoice", "credit"\]\.includes\(document\.documentType\)/);
    assert.match(accountingClient, /\["invoice", "credit"\]\.includes\(item\.documentType\)/);
    assert.match(accountingClient, /Chaque entreprise choisit librement sa plateforme/);
});

test("seules les URL HTTPS publiques peuvent être enregistrées", () => {
    assert.equal(sanitizePdpApiUrl("https://api.example.com/v1/invoices"), "https://api.example.com/v1/invoices");
    for (const url of ["http://api.example.com", "https://localhost/invoices", "https://127.0.0.1/invoices", "https://192.168.1.10/invoices", "https://user:pass@example.com"]) assert.equal(sanitizePdpApiUrl(url), "");
    for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.1.1", "172.16.0.1", "192.168.1.1", "::1", "fd00::1"]) assert.equal(isPrivateIp(ip), true);
    assert.equal(isPrivateIp("8.8.8.8"), false);
});