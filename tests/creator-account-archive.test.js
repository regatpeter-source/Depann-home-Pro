import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const creatorServer = readFileSync(new URL("../server/creator.js", import.meta.url), "utf8");
const creatorClient = readFileSync(new URL("../js/creator.js", import.meta.url), "utf8");
const databaseSource = readFileSync(new URL("../server/database.js", import.meta.url), "utf8");
const schemaSource = readFileSync(new URL("../database/schema.sql", import.meta.url), "utf8");
const networkSource = readFileSync(new URL("../server/partner-connections.js", import.meta.url), "utf8");
const missionSource = readFileSync(new URL("../server/partner-missions.js", import.meta.url), "utf8");

test("creator account removal archives the company instead of deleting its data", () => {
    assert.match(creatorServer, /app\.delete\("\/api\/creator\/accounts\/:accountId"[\s\S]*?SET is_archived=TRUE,is_active=FALSE,archived_at=NOW\(\),archived_by=\$2/);
    assert.doesNotMatch(creatorServer, /DELETE FROM depannhome_users WHERE id = \$1 AND account_owner_id = id/);
    assert.match(creatorServer, /depannhome_account_lifecycle_audit\(account_owner_id,actor_id,action,reason\)/);
});

test("archived companies can be restored with their retained access state and data", () => {
    assert.match(creatorServer, /\/api\/creator\/accounts\/:accountId\/restore/);
    assert.match(creatorServer, /SET is_archived=FALSE,is_active=TRUE,archived_at=NULL,archived_by=NULL/);
    assert.match(creatorClient, /data-account-mode="archived"/);
    assert.match(creatorClient, /id="creatorRestoreAccount"/);
    assert.match(creatorClient, /Toutes ses données sont conservées/);
});

test("the database migration stores archive state and lifecycle history", () => {
    for (const source of [databaseSource, schemaSource]) {
        assert.match(source, /is_archived BOOLEAN NOT NULL DEFAULT FALSE/);
        assert.match(source, /archived_at TIMESTAMPTZ/);
        assert.match(source, /archived_by BIGINT REFERENCES depannhome_users\(id\) ON DELETE SET NULL/);
        assert.match(source, /CREATE TABLE IF NOT EXISTS depannhome_account_lifecycle_audit/);
    }
});

test("network removal preserves the directory and archived accounts stop partner traffic", () => {
    assert.match(creatorServer, /UPDATE depannhome_partner_directory SET is_listed=FALSE, creator_suspended=TRUE/);
    assert.match(creatorServer, /network-directory\/:accountId\/restore/);
    assert.match(creatorServer, /SET is_listed=TRUE, creator_suspended=FALSE/);
    assert.doesNotMatch(creatorServer, /DELETE FROM depannhome_partner_directory WHERE owner_id/);
    assert.match(networkSource, /owner\.is_archived AS "isArchived"/);
    assert.match(missionSource, /owner\.is_active=TRUE AND owner\.is_archived=FALSE/);
    assert.match(creatorClient, /data-network-restore/);
});
