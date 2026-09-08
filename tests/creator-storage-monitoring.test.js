import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadCompanyStorageUsage, normalizeStorageQuota, storageAlertLevel } from "../server/storage-monitoring.js";

const creatorServer = readFileSync(new URL("../server/creator.js", import.meta.url), "utf8");
const creatorClient = readFileSync(new URL("../js/creator.js", import.meta.url), "utf8");
const schema = readFileSync(new URL("../database/schema.sql", import.meta.url), "utf8");
const migration = readFileSync(new URL("../database/migrations/0012_company_storage_monitoring.sql", import.meta.url), "utf8");
const storageServer = readFileSync(new URL("../server/storage-monitoring.js", import.meta.url), "utf8");

test("storage alerts use the configured 80 and 95 percent thresholds", () => {
    assert.equal(storageAlertLevel(799, 1000), "normal");
    assert.equal(storageAlertLevel(800, 1000), "warning");
    assert.equal(storageAlertLevel(949, 1000), "warning");
    assert.equal(storageAlertLevel(950, 1000), "critical");
});

test("storage quotas reject unsafe or unreasonable values", () => {
    assert.equal(normalizeStorageQuota(9 * 1024 * 1024), 0);
    assert.equal(normalizeStorageQuota(2 * 1024 ** 3), 2 * 1024 ** 3);
    assert.equal(normalizeStorageQuota(11 * 1024 ** 4), 0);
    assert.equal(normalizeStorageQuota("not-a-number"), 0);
});

test("storage monitoring is creator-only and does not expose file contents", () => {
    assert.match(creatorServer, /app\.get\("\/api\/creator\/storage-usage", requireCreator/);
    assert.match(creatorServer, /app\.patch\("\/api\/creator\/accounts\/:accountId\/storage-quota", requireCreator/);
    assert.doesNotMatch(storageServer, /SELECT[^;]*(?:file_data|pdf_data|source_data)\s+AS/i);
    assert.match(storageServer, /octet_length\(pdf_data\)/);
});

test("company storage usage is filtered in SQL by the authenticated tenant", async () => {
    const calls = [];
    const database = { query: async (sql, parameters = []) => {
        calls.push({ sql, parameters });
        if (sql.includes("WITH storage_items")) return { rows: [{ accountId: "42", companyName: "Entreprise", ownerUsername: "owner", usageBytes: "800", quotaBytes: "1000", itemCount: 2, breakdown: {} }] };
        return { rows: [] };
    } };
    const storage = await loadCompanyStorageUsage(42, database);
    assert.equal(storage.accountId, "42");
    assert.equal(storage.ownerUsername, undefined);
    assert.equal(storage.alertLevel, "warning");
    assert.equal(calls[0].parameters[1], 42);
    assert.match(calls[0].sql, /\(\$2::bigint IS NULL OR owner\.id=\$2\)/);
    assert.equal(calls.some(call => call.sql.includes("pg_database_size")), false);
});

test("database schema stores quotas and one usage snapshot per company and day", () => {
    for (const source of [schema, migration]) {
        assert.match(source, /storage_quota_bytes BIGINT NOT NULL DEFAULT 2147483648/);
        assert.match(source, /CREATE TABLE IF NOT EXISTS depannhome_storage_snapshots/);
        assert.match(source, /PRIMARY KEY\(account_owner_id,captured_on\)/);
    }
});

test("creator console displays usage, database size, trends and editable quotas", () => {
    assert.match(creatorClient, /Stockage des entreprises/);
    assert.match(creatorClient, /Base PostgreSQL complète/);
    assert.match(creatorClient, /Historique 30 jours en cours de constitution/);
    assert.match(creatorClient, /data-storage-quota-form/);
});

test("company administrators have a read-only storage section in settings", () => {
    const navigation = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
    assert.match(creatorServer, /app\.get\("\/api\/company\/storage-usage", requireAuthentication/);
    assert.match(creatorServer, /request\.user\?\.role !== "admin"/);
    assert.match(navigation, /\["storage", "Stockage"/);
    assert.match(navigation, /fetch\("\/api\/company\/storage-usage"/);
    assert.doesNotMatch(navigation.slice(navigation.indexOf("async function renderCompanyStorage"), navigation.indexOf("async function renderSubscriptionSettings")), /storage-quota|method:\s*"PATCH"/);
});
