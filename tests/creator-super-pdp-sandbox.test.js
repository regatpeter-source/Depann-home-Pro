import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SuperPdpProvider } from "../server/einvoice-providers/super-pdp.js";

const creatorServer = readFileSync(new URL("../server/creator.js", import.meta.url), "utf8");
const creatorClient = readFileSync(new URL("../js/creator.js", import.meta.url), "utf8");
const electronicServer = readFileSync(new URL("../server/electronic-invoicing.js", import.meta.url), "utf8");
const schema = readFileSync(new URL("../database/schema.sql", import.meta.url), "utf8");

function response(body, status = 200) {
    return { ok: status >= 200 && status < 300, status, text: async () => typeof body === "string" ? body : JSON.stringify(body) };
}

test("le sandbox SUPER PDP est exclusivement protégé par le rôle Créateur", () => {
    for (const route of [
        /app\.get\("\/api\/creator\/super-pdp-sandbox", requireCreator/,
        /app\.put\("\/api\/creator\/super-pdp-sandbox", requireCreator/,
        /app\.post\("\/api\/creator\/super-pdp-sandbox\/test", requireCreator/,
        /app\.delete\("\/api\/creator\/super-pdp-sandbox", requireCreator/
    ]) assert.match(creatorServer, route);
    assert.match(creatorClient, /id="creatorSuperPdpSandbox"/);
    assert.match(creatorClient, /Réservé au compte Créateur/);
});

test("les identifiants fictifs utilisent un coffre distinct et ne sont jamais renvoyés", () => {
    for (const source of [electronicServer, schema]) assert.match(source, /CREATE TABLE IF NOT EXISTS depannhome_creator_super_pdp_sandbox/);
    const routes = creatorServer.slice(creatorServer.indexOf('app.get("/api/creator/super-pdp-sandbox"'), creatorServer.indexOf('app.get("/api/creator/network-directory"'));
    assert.match(routes, /encryptElectronicInvoicingCredentials\(credentials\.value\)/);
    assert.match(routes, /decryptElectronicInvoicingCredentials/);
    assert.doesNotMatch(routes, /depannhome_einvoice_connections/);
    assert.doesNotMatch(routes, /response\.json\([^\n]*(?:clientSecret|encrypted_credentials)/);
});

test("le scénario Client Credentials reproduit le quick-start officiel sans statut de paiement", async () => {
    const calls = [];
    let uploaded = false;
    const provider = new SuperPdpProvider({ fetchImplementation: async (url, options = {}) => {
        const path = `${url.pathname}${url.search}`;
        const authorization = options.headers?.Authorization || "";
        calls.push({ path, method: options.method || "GET", authorization, body: options.body });
        if (path === "/oauth2/token") return response({ access_token: String(options.body).includes("seller-id") ? "seller-token" : "buyer-token" });
        if (path === "/v1.beta/companies/me") return response(authorization.includes("seller")
            ? { id: 10, formal_name: "Burger Queen", number: "seller", env: "sandbox" }
            : { id: 20, formal_name: "Tricatel", number: "buyer", env: "sandbox" });
        if (path === "/v1.beta/invoices?order=desc&limit=1") return response({ data: [] });
        if (path === "/v1.beta/invoices/generate_test_invoice?format=ubl") return response("<Invoice>test</Invoice>");
        if (path === "/v1.beta/validation_reports") return response({ data: [{ is_valid: true }] });
        if (path.startsWith("/v1.beta/invoices?external_id=")) { uploaded = true; return response({ id: 42, events: [] }); }
        if (path === "/v1.beta/invoices/42") return response({ id: 42, en_invoice: {}, events: [{ id: 1, status_code: "api:accepted", status_text: "Acceptée" }] });
        if (path === "/v1.beta/invoices?limit=100") return response({ data: uploaded ? [{ id: 84 }] : [] });
        throw new Error(`Appel inattendu ${path}`);
    } });

    const result = await provider.runClientCredentialsSandboxTest({ seller: { clientId: "seller-id", clientSecret: "seller-secret" }, buyer: { clientId: "buyer-id", clientSecret: "buyer-secret" } });
    assert.equal(result.seller.formalName, "Burger Queen");
    assert.equal(result.buyer.formalName, "Tricatel");
    assert.equal(result.validationPassed, true);
    assert.equal(result.received, true);
    assert.equal(result.transmission.status, "accepted");
    assert.equal(calls.filter(call => call.path === "/oauth2/token").length, 2);
    assert.ok(calls.some(call => call.path === "/v1.beta/validation_reports" && call.body instanceof FormData));
    assert.ok(calls.some(call => call.path.startsWith("/v1.beta/invoices?external_id=") && call.method === "POST"));
    assert.ok(!calls.some(call => call.path === "/v1.beta/invoice_events"));
});

test("le scénario refuse un compte qui n’est pas déclaré sandbox", async () => {
    const paths = [];
    const provider = new SuperPdpProvider({ fetchImplementation: async (url, options = {}) => {
        paths.push(url.pathname);
        if (url.pathname === "/oauth2/token") return response({ access_token: String(options.body).includes("seller-id") ? "seller-token" : "buyer-token" });
        if (url.pathname === "/v1.beta/companies/me") return response({ id: options.headers.Authorization.includes("seller") ? 10 : 20, env: "production" });
        throw new Error(`Appel interdit ${url.pathname}`);
    } });
    await assert.rejects(() => provider.runClientCredentialsSandboxTest({ seller: { clientId: "seller-id", clientSecret: "secret" }, buyer: { clientId: "buyer-id", clientSecret: "secret" } }), /refuse tout compte SUPER PDP/);
    assert.ok(!paths.includes("/v1.beta/invoices/generate_test_invoice"));
});
