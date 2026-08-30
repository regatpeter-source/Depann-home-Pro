import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
    assertSafeExternalUrl,
    clearConnectorTokenCache,
    executeConnectorRequest,
    interpolateConnectorPath,
    interpolateConnectorValue,
    requestClientCredentialsToken
} from "../server/connector-runtime.js";

const connection = {
    authType: "oauth2",
    baseUrl: "https://sandbox.insurer.example",
    tokenUrl: "https://auth.insurer.example/oauth/token",
    tokenAuthMethod: "body",
    scope: "missions.write",
    audience: "missions-api",
    tenantHeaderName: "x-tenant-id",
    timeout: 5000
};
const credentials = { clientId: "client-id", clientSecret: "client-secret", tenantId: "tenant-id" };
const connector = { id: 42, connectorKey: "assureur-test", manifest: { connection }, credentials };

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test.beforeEach(() => clearConnectorTokenCache());

test("OAuth client_credentials sends the documented form and caches the access token", async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url: String(url), options });
        return jsonResponse({ access_token: "first-token", expires_in: 3600 });
    };
    const first = await requestClientCredentialsToken(connection, credentials, { cacheKey: "cache-test", fetchImpl });
    const second = await requestClientCredentialsToken(connection, credentials, { cacheKey: "cache-test", fetchImpl });
    assert.equal(first, "first-token");
    assert.equal(second, "first-token");
    assert.equal(calls.length, 1);
    const form = new URLSearchParams(calls[0].options.body);
    assert.equal(form.get("grant_type"), "client_credentials");
    assert.equal(form.get("client_id"), credentials.clientId);
    assert.equal(form.get("client_secret"), credentials.clientSecret);
    assert.equal(form.get("scope"), connection.scope);
    assert.equal(form.get("audience"), connection.audience);
    assert.equal(calls[0].options.redirect, "error");
});

test("connector request interpolates the external mission id and sends bearer plus tenant headers", async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url: String(url), options });
        return String(url).includes("/oauth/token") ? jsonResponse({ access_token: "access-token", expires_in: 3600 }) : jsonResponse({ accepted: true });
    };
    const endpoint = { method: "POST", path: "/service/v3/mission_orders/{mission_order_id}/accept", parameters: { source: "{event}" }, headers: {}, body: '{"status":"{status}"}' };
    const result = await executeConnectorRequest({ connector, endpoint, payload: {}, variables: { mission_order_id: "DOSSIER/123", event: "mission_accepted", status: "accepted" }, fetchImpl });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, "https://sandbox.insurer.example/service/v3/mission_orders/DOSSIER%2F123/accept?source=mission_accepted");
    assert.equal(calls[1].options.headers.Authorization, "Bearer access-token");
    assert.equal(calls[1].options.headers["x-tenant-id"], credentials.tenantId);
    assert.deepEqual(JSON.parse(calls[1].options.body), { status: "accepted" });
});

test("a 401 invalidates the OAuth token and retries once with a fresh token", async () => {
    let tokenCalls = 0;
    let apiCalls = 0;
    const fetchImpl = async (url, options) => {
        if (String(url).includes("/oauth/token")) return jsonResponse({ access_token: `token-${++tokenCalls}`, expires_in: 3600 });
        apiCalls += 1;
        return options.headers.Authorization === "Bearer token-1" ? jsonResponse({ message: "expired" }, 401) : jsonResponse({ accepted: true });
    };
    const result = await executeConnectorRequest({ connector, endpoint: { method: "POST", path: "/missions/{missionId}", parameters: {}, headers: {}, body: "" }, payload: { status: "accepted" }, variables: { missionId: "123" }, fetchImpl });
    assert.equal(result.ok, true);
    assert.equal(tokenCalls, 2);
    assert.equal(apiCalls, 2);
});

test("template interpolation is recursive and leaves missing values visible", () => {
    assert.equal(interpolateConnectorPath("/missions/{id}", { id: "A/B" }), "/missions/A%2FB");
    assert.deepEqual(interpolateConnectorValue({ status: "{status}", nested: ["{missing}"] }, { status: "accepted" }), { status: "accepted", nested: ["{missing}"] });
});

test("OAuth and API endpoints reject private network targets", () => {
    assert.throws(() => assertSafeExternalUrl("http://127.0.0.1/token"), /pas autorisée/);
    assert.throws(() => assertSafeExternalUrl("http://192.168.1.2/api"), /pas autorisée/);
});

test("mission outbox selects an insurer connector and preserves callback fallback", () => {
    const source = readFileSync(new URL("../server/partner-missions.js", import.meta.url), "utf8");
    assert.match(source, /rules\?\.outboundConnectorKey/);
    assert.match(source, /executeConnectorEvent\(ownerId, connectorKey, item\.event_type/);
    assert.match(source, /else \{ if \(!item\.callbackUrl\)/);
});

test("official partners reuse one central connector with isolated company credentials", () => {
    const schema = readFileSync(new URL("../database/schema.sql", import.meta.url), "utf8");
    const requests = readFileSync(new URL("../server/partner-requests.js", import.meta.url), "utf8");
    assert.match(schema, /api_connector_id BIGINT REFERENCES depannhome_api_connectors/);
    assert.match(schema, /UNIQUE\(owner_id, official_partner_id\)/);
    assert.match(schema, /credentials_ciphertext TEXT NOT NULL/);
    assert.match(requests, /testConnectorCredentials\(partner\.apiConnectorId, credentials\.values\)/);
    assert.match(requests, /encryptSecret\(credentials\)/);
    assert.doesNotMatch(requests, /response\.json\([^\n]*credentials_ciphertext/);
});

test("each official company connection owns one revocable incoming mission endpoint", () => {
    const requests = readFileSync(new URL("../server/partner-requests.js", import.meta.url), "utf8");
    assert.match(requests, /intake_id BIGINT UNIQUE REFERENCES depannhome_partner_intakes/);
    assert.match(requests, /crypto\.randomBytes\(32\)\.toString\("base64url"\)/);
    assert.match(requests, /secretHash\(apiKey\)/);
    assert.match(requests, /UPDATE depannhome_partner_intakes SET enabled=FALSE/);
    assert.match(requests, /WHERE connection\.owner_id=\$1 AND connection\.intake_id=\$2/);
    const missions = readFileSync(new URL("../server/partner-missions.js", import.meta.url), "utf8");
    assert.match(missions, /intake\.partner_key=\$1 AND intake\.api_key_hash=\$2/);
});

test("official mission events use company credentials while manual callbacks stay supported", () => {
    const missions = readFileSync(new URL("../server/partner-missions.js", import.meta.url), "utf8");
    assert.match(missions, /officialConnectorConnection\(ownerId, intakeId\)/);
    assert.match(missions, /executeCentralConnectorEvent\(official\.connectorId, official\.credentials/);
    assert.match(missions, /NOT EXISTS\(SELECT 1 FROM depannhome_official_partner_connections/);
    assert.match(missions, /executeConnectorEvent\(ownerId, connectorKey/);
    assert.match(missions, /fetch\(item\.callbackUrl/);
});

test("companies receive only the declarative credential form, never central connector setup", () => {
    const requests = readFileSync(new URL("../server/partner-requests.js", import.meta.url), "utf8");
    const client = readFileSync(new URL("../js/partner-connections.js", import.meta.url), "utf8");
    assert.match(requests, /\.\.\.\(includeSetup \? \{ apiConnectorId:/);
    assert.match(client, /partner\.connectorConfig\?\.credentialFields/);
    assert.doesNotMatch(client, /partner\.apiConnectorId/);
    assert.match(client, /Vérification de la connexion/);
});
