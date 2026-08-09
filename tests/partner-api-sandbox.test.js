import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
    decryptSandboxSecret, encryptSandboxSecret, redactSandboxValue, SANDBOX_FAULTS,
    SANDBOX_PARTNER, sandboxHash, sandboxMissionPayload, sandboxStatus
} from "../server/partner-api-sandbox-policy.js";

test("sandbox partner has a stable and unmistakable fictional identity", () => {
    assert.equal(SANDBOX_PARTNER.name, "Dépann'Home Test Services");
    assert.match(SANDBOX_PARTNER.label, /SANDBOX/);
    assert.match(SANDBOX_PARTNER.email, /\.invalid$/);
});

test("sandbox mission payload uses the production external contract", () => {
    const payload = sandboxMissionPayload(12345);
    assert.equal(payload.missionNumber, "DHTS-12345");
    assert.equal(payload.client.name, "Camille Test");
    assert.ok(payload.interventionType);
});

test("sandbox mission references remain stable for duplicate testing", () => {
    assert.deepEqual(sandboxMissionPayload(9876), sandboxMissionPayload(9876));
});

test("API credentials are encrypted at rest and can be recovered by the server", () => {
    const secret = "session-secret-that-is-long-enough-for-tests";
    const encrypted = encryptSandboxSecret("api-key-value", secret);
    assert.notEqual(encrypted, "api-key-value");
    assert.equal(decryptSandboxSecret(encrypted, secret), "api-key-value");
});

test("encrypted credentials cannot be opened with another master secret", () => {
    const encrypted = encryptSandboxSecret("api-key-value", "first-session-secret-that-is-long-enough");
    assert.throws(() => decryptSandboxSecret(encrypted, "other-session-secret-that-is-long-enough"));
});

test("hashes are deterministic without exposing their input", () => {
    assert.equal(sandboxHash("same"), sandboxHash("same"));
    assert.notEqual(sandboxHash("same"), "same");
});

test("logs redact credentials recursively", () => {
    const value = redactSandboxValue({ headers: { authorization: "Bearer abc", xApiKey: "secret" }, token: "token" });
    assert.equal(value.headers.authorization, "[REDACTED]");
    assert.equal(value.headers.xApiKey, "[REDACTED]");
    assert.equal(value.token, "[REDACTED]");
});

test("logs mask customer contact details", () => {
    const value = redactSandboxValue({ email: "camille@example.invalid", phone: "0601020304", address: "1 rue Test" });
    assert.equal(value.email, "c•••@example.invalid");
    assert.notEqual(value.phone, "0601020304");
    assert.equal(value.address, "[ADRESSE TEST MASQUÉE]");
});

test("external statuses map to real mission workflow statuses", () => {
    assert.equal(sandboxStatus("accepted"), "accepted");
    assert.equal(sandboxStatus("in_progress"), "report_in_progress");
    assert.equal(sandboxStatus("completed"), "work_completed");
    assert.equal(sandboxStatus("unknown"), "");
});

test("all required fault scenarios are available", () => {
    for (const scenario of ["400", "401", "403", "404", "500", "timeout", "unavailable", "invalid_json", "duplicate", "missing_mission"]) {
        assert.equal(SANDBOX_FAULTS.has(scenario), true, scenario);
    }
});

test("sandbox sender targets the real external partner intake endpoint", () => {
    const source = readFileSync(new URL("../server/partner-api-sandbox.js", import.meta.url), "utf8");
    assert.match(source, /`\/api\/partner-intake\/\$\{intake\.partner_key\}`/);
    assert.match(source, /"X-API-Key"/);
    assert.doesNotMatch(source, /contourner_api|bypass/i);
});

test("production and sandbox callback retries are separated by the intake flag", () => {
    const missionsSource = readFileSync(new URL("../server/partner-missions.js", import.meta.url), "utf8");
    const sandboxSource = readFileSync(new URL("../server/partner-api-sandbox.js", import.meta.url), "utf8");
    assert.match(missionsSource, /intake\.is_sandbox=\$2/);
    assert.match(sandboxSource, /sandboxOnly: true/);
});

test("sandbox reset protects clients referenced by production business records", () => {
    const source = readFileSync(new URL("../server/partner-api-sandbox.js", import.meta.url), "utf8");
    assert.match(source, /NOT EXISTS\(SELECT 1 FROM depannhome_calendar_events/);
    assert.match(source, /NOT EXISTS\(SELECT 1 FROM depannhome_billing_documents/);
    assert.match(source, /NOT EXISTS\(SELECT 1 FROM depannhome_technical_reports/);
});
