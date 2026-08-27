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

test("la CSP interdit scripts inline, objets et intégration en iframe", () => {
    const directives = contentSecurityPolicy().directives;
    assert.deepEqual(directives.scriptSrc, ["'self'"]);
    assert.deepEqual(directives.scriptSrcAttr, ["'none'"]);
    assert.deepEqual(directives.objectSrc, ["'none'"]);
    assert.deepEqual(directives.frameAncestors, ["'none'"]);
    assert.match(securityConfigurationFingerprint(), /^[a-f0-9]{64}$/);
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

test("les migrations sont ordonnées, uniques et checksumées", async () => {
    const migrations = await loadMigrations();
    assert.ok(migrations.length >= 1);
    assert.deepEqual(migrations.map(item => item.version), [...migrations.map(item => item.version)].sort((a, b) => a - b));
    assert.equal(new Set(migrations.map(item => item.version)).size, migrations.length);
    assert.equal(migrations.every(item => /^[a-f0-9]{64}$/.test(item.checksum)), true);
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
