import test from "node:test";
import assert from "node:assert/strict";
import { SuperPdpProvider, mapInvoiceStatus } from "../server/einvoice-providers/super-pdp.js";

function response(body = {}, status = 200) {
    return { ok: status >= 200 && status < 300, status, text: async () => body === null ? "" : JSON.stringify(body) };
}

function withConfiguration(callback) {
    const previous = { id: process.env.SUPERPDP_CLIENT_ID, secret: process.env.SUPERPDP_CLIENT_SECRET, redirect: process.env.SUPERPDP_REDIRECT_URI };
    process.env.SUPERPDP_CLIENT_ID = "client-test";
    process.env.SUPERPDP_CLIENT_SECRET = "secret-test";
    process.env.SUPERPDP_REDIRECT_URI = "https://erp.example/api/accounting/e-invoicing/oauth/callback";
    return Promise.resolve(callback()).finally(() => {
        for (const [key, value] of [["SUPERPDP_CLIENT_ID", previous.id], ["SUPERPDP_CLIENT_SECRET", previous.secret], ["SUPERPDP_REDIRECT_URI", previous.redirect]]) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    });
}

test("l’URL d’autorisation SUPER PDP contient state, PKCE S256 et le callback exact", () => withConfiguration(() => {
    const provider = new SuperPdpProvider();
    const url = new URL(provider.authorizationUrl({ state: "state-opaque", codeChallenge: "challenge", redirectUri: process.env.SUPERPDP_REDIRECT_URI, loginHint: "admin@example.test", companyNumber: "123456789" }));
    assert.equal(url.origin, "https://api.superpdp.tech");
    assert.equal(url.pathname, "/oauth2/authorize");
    assert.equal(url.searchParams.get("state"), "state-opaque");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("code_challenge"), "challenge");
    assert.equal(url.searchParams.get("redirect_uri"), process.env.SUPERPDP_REDIRECT_URI);
    assert.equal(url.searchParams.get("superpdp_company_number_scheme"), "fr_siren");
}));

test("l’autorisation est bloquée si le callback exact est absent", () => withConfiguration(() => {
    const provider = new SuperPdpProvider();
    assert.throws(() => provider.authorizationUrl({ state: "state", codeChallenge: "challenge", redirectUri: "" }), /URL de retour SUPER PDP/);
}));

test("la rotation OAuth exige et conserve le nouveau refresh token", () => withConfiguration(async () => {
    let request;
    const provider = new SuperPdpProvider({ fetchImplementation: async (url, options) => {
        request = { url: String(url), options };
        return response({ access_token: "new-access", refresh_token: "new-refresh", token_type: "Bearer", expires_in: 1800 });
    } });
    const result = await provider.refreshAuthentication({ credentials: { refreshToken: "old-refresh" } });
    assert.equal(result.credentials.refreshToken, "new-refresh");
    assert.equal(request.url, "https://api.superpdp.tech/oauth2/token");
    const body = new URLSearchParams(request.options.body);
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), "old-refresh");
    assert.equal(body.get("client_id"), "client-test");
}));

test("les archives UBL sont envoyées brutes et la référence distante est contrôlée", async () => {
    let request;
    const provider = new SuperPdpProvider({ fetchImplementation: async (url, options) => { request = { url: String(url), options }; return response({ id: 42, events: [] }); } });
    const result = await provider.sendInvoice({ document: { id: 7, structuredData: Buffer.from("<Invoice/>") }, credentials: { accessToken: "access" } });
    assert.equal(result.externalId, "42");
    assert.equal(result.externalStatus, "api:uploaded");
    assert.equal(request.options.headers["Content-Type"], "application/xml");
    assert.equal(request.options.body.toString(), "<Invoice/>");
    assert.match(request.url, /external_id=depannhome-7/);
});

test("les événements cumulés SUPER PDP sont traduits avec priorité aux rejets", () => {
    assert.deepEqual(mapInvoiceStatus({ events: [{ id: 1, status_code: "api:uploaded" }, { id: 2, status_code: "fr:205", status_text: "Acceptée" }] }), { status: "accepted", externalStatus: "fr:205", message: "Acceptée" });
    const rejected = mapInvoiceStatus({ events: [{ id: 1, status_code: "fr:205" }, { id: 2, status_code: "fr:213", status_text: "Rejetée", details: [{ reason: "Donnée invalide" }] }] });
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.externalStatus, "fr:213");
    assert.match(rejected.message, /Donnée invalide/);
});
