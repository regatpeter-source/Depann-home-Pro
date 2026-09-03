import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const server = readFileSync(new URL("../server/creator-assistance.js", import.meta.url), "utf8");
const application = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const migration = readFileSync(new URL("../database/migrations/0006_creator_assistance.sql", import.meta.url), "utf8");
const schema = readFileSync(new URL("../database/schema.sql", import.meta.url), "utf8");
const client = readFileSync(new URL("../js/creator.js", import.meta.url), "utf8");
const navigation = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const serviceWorker = readFileSync(new URL("../service-worker.js", import.meta.url), "utf8");

const tableDefinitions = [migration, schema, server];

test("creator assistance routes remain creator-only and never replace request.user", () => {
    assert.match(server, /\/api\/creator\/assistance\/sessions[^\n]+requireCreator/g);
    assert.doesNotMatch(server, /request\.user\s*=/);
    assert.doesNotMatch(server, /password_hash|secret_ciphertext\s+AS|verification_code_hash\s+AS/);
});

test("support sessions require consent context and have bounded lifetimes", () => {
    assert.match(server, /NORMAL_SESSION_MINUTES = 30/);
    assert.match(server, /EMERGENCY_SESSION_MINUTES = 10/);
    assert.match(server, /consentConfirmed/);
    assert.match(server, /supportRequestId/);
    assert.match(server, /session\.expires_at>NOW\(\)/);
    assert.match(server, /session\.revoked_at IS NULL/);
});

test("recovery actions are constrained, audited and notify company administrators", () => {
    for (const action of ["restore_company", "reactivate_company", "reactivate_administrator", "reset_administrator_2fa", "revoke_company_sessions", "reject_device", "release_company_locks"]) {
        assert.match(server, new RegExp(action));
    }
    assert.match(server, /previous_state/);
    assert.match(server, /new_state/);
    assert.match(server, /insertCompanyNotifications/);
    assert.match(server, /company_notified_at/);
    assert.doesNotMatch(server, /approve_device/);
});

test("session lifecycle and recovery notifications are committed atomically", () => {
    assert.match(server, /creator_support_session_started[\s\S]+COMMIT/);
    assert.match(server, /creator_support_session_closed[\s\S]+COMMIT/);
    assert.match(server, /creator_recovery_action[\s\S]+COMMIT/);
    assert.match(server, /safelyBroadcastCompanyNotifications/);
});

test("session revocation preserves administrator desktop approval while invalidating current sessions", () => {
    assert.match(server, /member\.role='admin' AND device\.device_type='desktop'/);
    assert.match(server, /session_id=NULL/);
    assert.match(server, /administratorDesktopApprovalPreserved: true/);
    assert.match(server, /Utilisez l’action de réactivation de l’entreprise/);
});

test("assistance tables are durable and migration is idempotent", () => {
    for (const source of tableDefinitions) {
        assert.match(source, /CREATE TABLE IF NOT EXISTS depannhome_creator_support_sessions/);
        assert.match(source, /CREATE TABLE IF NOT EXISTS depannhome_creator_recovery_actions/);
    }
    assert.match(application, /registerCreatorAssistanceRoutes\(app, requireCreator\)/);
    assert.match(application, /await initializeCreatorAssistance\(\)/);
});

test("creator console exposes an explicit assistance workflow and warning banner", () => {
    assert.match(client, /id="creatorAssistance"/);
    assert.match(client, /renderCreatorAssistance/);
    assert.match(client, /creator-assistance-banner/);
    assert.match(client, /Vue sans usurpation/);
    assert.match(client, /l’entreprise sera notifiée/);
});

test("PWA versions are synchronized for creator assistance assets", () => {
    assert.match(navigation, /creator\.js\?v=155/);
    assert.match(index, /css\/style\.css\?v=251/);
    assert.match(index, /js\/app\.js\?v=405/);
    assert.match(serviceWorker, /depann-home-pro-v508/);
    assert.match(serviceWorker, /css\/style\.css\?v=251/);
    assert.match(serviceWorker, /js\/app\.js\?v=405/);
    assert.match(serviceWorker, /js\/navigation\.js\?v=436/);
    assert.match(serviceWorker, /js\/creator\.js\?v=155/);
    assert.match(serviceWorker, /js\/connectors\.js\?v=3/);
});
