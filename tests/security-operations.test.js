import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contentSecurityPolicy, createOriginProtection, securityConfigurationFingerprint } from "../server/security-hardening.js";
import { loadMigrations } from "../server/database-migrations.js";
import { postgresConnection } from "../scripts/database-backup.js";

function request({ method = "POST", path = "/api/accounting/aids", origin = "https://evil.example", fetchSite = "cross-site" } = {}) {
    const headers = { origin, "sec-fetch-site": fetchSite, host: "app.example" };
    return { method, path, protocol: "https", get: name => headers[String(name).toLowerCase()] || "" };
}
function response() {
    return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

test("la CSP autorise les aperçus PDF blob sans autoriser l’encapsulation de l’application", () => {
    const directives = contentSecurityPolicy().directives;
    assert.deepEqual(directives.scriptSrc, ["'self'"]);
    assert.deepEqual(directives.scriptSrcAttr, ["'none'"]);
    assert.deepEqual(directives.objectSrc, ["'none'"]);
    assert.deepEqual(directives.frameAncestors, ["'none'"]);
    assert.deepEqual(directives.frameSrc, ["'self'", "blob:"]);
    assert.match(securityConfigurationFingerprint(), /^[a-f0-9]{64}$/);
});

test("les pages de callback utilisent un script externe compatible avec la CSP", () => {
    const sources = ["partner-email.js", "electronic-invoicing.js", "partner-requests.js"].map(filename => readFileSync(new URL(`../server/${filename}`, import.meta.url), "utf8"));
    const callbackScript = readFileSync(new URL("../public/oauth-callback.js", import.meta.url), "utf8");
    for (const source of sources) {
        assert.doesNotMatch(source, /<script(?![^>]*\bsrc=)[^>]*>/i);
        assert.match(source, /<script src=["']\/site-assets\/oauth-callback\.js(?:\?v=\d+)?["'] defer><\/script>/);
    }
    assert.match(sources[0], /data-oauth-payload=/);
    assert.match(sources[1], /data-oauth-payload=/);
    assert.match(callbackScript, /window\.opener\?\.postMessage\(payload, window\.location\.origin\)/);
    assert.match(callbackScript, /window\.close\(\)/);
});

test("la protection CSRF bloque une écriture navigateur intersite", () => {
    const middleware = createOriginProtection({ audit: async () => {} });
    const result = response(); let continued = false;
    middleware(request(), result, () => { continued = true; });
    assert.equal(result.statusCode, 403);
    assert.equal(continued, false);
});

test("la protection CSRF accepte la même origine et exempte les API partenaires", () => {
    const middleware = createOriginProtection(); let continued = 0;
    middleware(request({ origin: "https://app.example", fetchSite: "same-origin" }), response(), () => { continued += 1; });
    middleware(request({ path: "/api/partner-intake/assureur", origin: "https://partner.example", fetchSite: "cross-site" }), response(), () => { continued += 1; });
    assert.equal(continued, 2);
});

test("la protection CSRF accepte l’origine exacte réellement servie à une PWA mobile", () => {
    const previousPublicUrl = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = "https://app.depannhome.fr";
    try {
        const middleware = createOriginProtection({ audit: async () => {} }); let continued = 0;
        middleware(request({ path: "/api/auth/login", origin: "https://app.example", fetchSite: "cross-site" }), response(), () => { continued += 1; });
        assert.equal(continued, 1);
        const rejected = response();
        middleware(request({ path: "/api/auth/login", origin: "https://evil.example", fetchSite: "cross-site" }), rejected, () => { continued += 1; });
        assert.equal(rejected.statusCode, 403);
    } finally {
        if (previousPublicUrl === undefined) delete process.env.PUBLIC_BASE_URL;
        else process.env.PUBLIC_BASE_URL = previousPublicUrl;
    }
});

test("les migrations sont ordonnées, uniques et checksumées", async () => {
    const migrations = await loadMigrations();
    assert.ok(migrations.length >= 1);
    assert.deepEqual(migrations.map(item => item.version), [...migrations.map(item => item.version)].sort((a, b) => a - b));
    assert.equal(new Set(migrations.map(item => item.version)).size, migrations.length);
    assert.equal(migrations.every(item => /^[a-f0-9]{64}$/.test(item.checksum)), true);
});

test("la migration e-mail reste applicable avant la création optionnelle de sa table", async () => {
    const migration = readFileSync(new URL("../database/migrations/0002_email_mission_document_detection.sql", import.meta.url), "utf8");
    const runner = readFileSync(new URL("../server/database-migrations.js", import.meta.url), "utf8");
    assert.match(migration, /to_regclass\('depannhome_partner_email_messages'\) IS NOT NULL/);
    assert.match(runner, /LEGACY_MIGRATION_CHECKSUMS/);
    assert.match(runner, /478913d3dc6bca68eff852079ccc0d80b49cdf2ee6e701a492e03da1bd2dc514/);
    assert.match(runner, /5f741958ac796af6863d52488751a08129a8c6992ad73efd43a6af75ff2413dc/);
});

test("les migrations de modules restent applicables avant la création de leurs tables", () => {
    const calendarMigration = readFileSync(new URL("../database/migrations/0008_calendar_planning_batches.sql", import.meta.url), "utf8");
    const outboxMigration = readFileSync(new URL("../database/migrations/0009_partner_outbox_claiming.sql", import.meta.url), "utf8");
    const runner = readFileSync(new URL("../server/database-migrations.js", import.meta.url), "utf8");
    assert.match(calendarMigration, /to_regclass\('depannhome_calendar_events'\) IS NOT NULL/);
    assert.match(outboxMigration, /to_regclass\('depannhome_partner_mission_outbox'\) IS NOT NULL/);
    assert.match(runner, /5212e9b7728de6e2cf1dbce829092cdc26ece4a2c27e9d98ddb0ab60f9849ed1/);
    assert.match(runner, /fb7105c5ab03393502af36f1b8bc7d825273982330c56a81cf5a1c751348847f/);
    assert.match(runner, /af7bb2089f5084f806597c7ca5d1c229c2476c66ec7533fa43617f6f1af2fcda/);
    assert.match(runner, /bf4dc579523467f3ae3ad47d09ac757448e4232900befe6ab586b76534148872/);
});

test("la migration de conservation restaure les missions masquées et interdit une nouvelle suppression logique", () => {
    const migration = readFileSync(new URL("../database/migrations/0003_retain_partner_missions.sql", import.meta.url), "utf8");
    assert.match(migration, /UPDATE depannhome_partner_missions[\s\S]*SET deleted_at = NULL/);
    assert.match(migration, /depannhome_partner_missions_retained_check/);
    assert.match(migration, /CHECK \(deleted_at IS NULL\)/);
});

test("le défi TOTP Créateur est limité, persisté et consommé une seule fois", () => {
    const authentication = readFileSync(new URL("../server/auth.js", import.meta.url), "utf8");
    const migration = readFileSync(new URL("../database/migrations/0001_security_operations.sql", import.meta.url), "utf8");
    assert.match(migration, /depannhome_creator_totp_challenges/);
    assert.match(authentication, /attempts<\$3/);
    assert.match(authentication, /SET consumed_at=NOW\(\).*consumed_at IS NULL/);
    assert.match(authentication, /challenge: await createCreatorTotpChallenge/);
});

test("sauvegarde et restauration n’utilisent pas de shell et exigent une cible séparée", () => {
    const backup = readFileSync(new URL("../scripts/database-backup.js", import.meta.url), "utf8");
    const restore = readFileSync(new URL("../scripts/restore.js", import.meta.url), "utf8");
    assert.match(backup, /spawn\(command, args/);
    assert.doesNotMatch(backup, /exec\(|shell:\s*true/);
    assert.match(backup, /--format=custom/);
    assert.match(restore, /RESTORE_DATABASE_URL/);
    assert.match(restore, /--confirm-restore/);
    assert.match(restore, /checksum SHA-256/i);
    const connection = postgresConnection("postgresql://backup-user:tres-secret@db.example:5433/depannhome?sslmode=require");
    assert.doesNotMatch(connection.args.join(" "), /tres-secret/);
    assert.equal(connection.env.PGPASSWORD, "tres-secret");
});
