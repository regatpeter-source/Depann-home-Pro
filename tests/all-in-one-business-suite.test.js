import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config({ path: fileURLToPath(new URL("../.env.test.local", import.meta.url)) });

const read = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("la migration tout-en-un couvre les six modules demandés et reste multi-tenant", async () => {
    const migration = await read("database/migrations/0038_all_in_one_business_suite.sql");
    const schema = await read("database/schema.sql");
    for (const table of [
        "depannhome_customer_portal_links", "depannhome_customer_portal_events", "depannhome_quote_decisions",
        "depannhome_client_sites", "depannhome_client_equipment", "depannhome_maintenance_contracts",
        "depannhome_inventory_locations", "depannhome_inventory_items", "depannhome_inventory_movements",
        "depannhome_labor_cost_settings", "depannhome_automation_rules", "depannhome_internal_reminders", "depannhome_automation_runs"
    ]) {
        assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
        assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    }
    assert.match(migration, /token_hash CHAR\(64\) NOT NULL UNIQUE/);
    assert.match(migration, /UNIQUE\(owner_id,document_id\)/);
    assert.match(migration, /quantity NUMERIC\(12,3\) NOT NULL CHECK\(quantity <> 0\)/);
    assert.match(migration, /UNIQUE\(owner_id,dedupe_key\)/);
});

test("le portail ne stocke jamais le jeton brut et protège la décision de devis", async () => {
    const [portal, migration] = await Promise.all([read("server/customer-portal.js"), read("database/migrations/0038_all_in_one_business_suite.sql")]);
    assert.match(portal, /randomBytes\(32\)\.toString\("base64url"\)/);
    assert.match(portal, /tokenHash\(token\)/);
    assert.match(portal, /\(id,owner_id,client_id,token_hash,label,document_ids/);
    assert.doesNotMatch(migration, /\btoken\s+(?:TEXT|VARCHAR|CHAR)/i);
    assert.match(portal, /FOR UPDATE/);
    assert.match(portal, /documentType !== "quote"/);
    assert.match(portal, /previous\.rows\[0\]\.decision !== decision/);
    assert.match(portal, /createHash\("sha256"\)\.update\(output\.buffer\)/);
    assert.match(portal, /owner_id=\$1 AND document_id=\$2/);
});

test("le stock est un journal audité avec contrôle anti-stock négatif et transfert atomique", async () => {
    const server = await read("server/business-suite.js");
    assert.match(server, /currentBalance/);
    assert.match(server, /newBalance < 0 && !override/);
    assert.match(server, /request\.user\?\.role === "admin"/);
    assert.match(server, /movement\.reason\.length >= 5/);
    assert.match(server, /'transfer_out'/);
    assert.match(server, /'transfer_in'/);
    assert.match(server, /BEGIN/);
    assert.match(server, /COMMIT/);
});

test("la rentabilité agrège facturation, temps, stock et achats par intervention", async () => {
    const server = await read("server/business-suite.js");
    assert.match(server, /depannhome_billing_documents/);
    assert.match(server, /depannhome_intervention_work_sessions/);
    assert.match(server, /depannhome_inventory_movements/);
    assert.match(server, /depannhome_purchases/);
    assert.match(server, /formulaVersion: 1/);
    assert.match(server, /appointment_id=\$2/);
});

test("les automatisations sont verrouillées, idempotentes et limitées à des rappels internes", async () => {
    const automation = await read("server/automation.js");
    assert.match(automation, /pg_try_advisory_lock/);
    assert.match(automation, /ON CONFLICT\(owner_id,dedupe_key\) DO NOTHING/);
    assert.match(automation, /depannhome_internal_reminders/);
    assert.match(automation, /quote_follow_up/);
    assert.match(automation, /contract_renewal/);
    assert.match(automation, /maintenance_due/);
    assert.match(automation, /low_stock/);
    assert.doesNotMatch(automation, /twilio|stripe|docusign|sendgrid/i);
});

test("l’interface tout-en-un est accessible, restaurable et mise en cache", async () => {
    const [index, config, navigation, module, worker, app] = await Promise.all([
        read("index.html"), read("js/config.js"), read("js/navigation.js"), read("js/business-suite.js"), read("service-worker.js"), read("app.js")
    ]);
    assert.match(index, /id="businessSuiteBtn"/);
    assert.match(index, /data-nav="business-suite"/);
    assert.match(config, /businessSuite: "business-suite"/);
    assert.match(navigation, /renderBusinessSuite/);
    assert.match(navigation, /businessSuiteTab/);
    for (const tab of ["portal", "assets", "inventory", "profitability", "automation"]) assert.match(module, new RegExp(`activeTab === "${tab}"`));
    assert.match(worker, /business-suite\.js\?v=1/);
    assert.match(app, /registerCustomerPortalRoutes/);
    assert.match(app, /registerBusinessSuiteRoutes/);
    assert.match(app, /registerAutomationRoutes/);
    assert.match(app, /startAutomationScheduler/);
});

test("PostgreSQL applique réellement la migration tout-en-un sur le schéma cœur", { skip: !process.env.TEST_DATABASE_URL }, async () => {
    const parsed = new URL(process.env.TEST_DATABASE_URL);
    assert.match(parsed.pathname, /test/i, "TEST_DATABASE_URL doit désigner une base de test");
    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schemaName = `test_business_suite_${process.pid}_${Date.now()}`;
    const client = await pool.connect();
    try {
        await client.query(`CREATE SCHEMA ${schemaName}`);
        await client.query(`SET search_path TO ${schemaName}`);
        await client.query("CREATE TABLE depannhome_users(id BIGINT PRIMARY KEY)");
        await client.query("CREATE TABLE depannhome_billing_documents(id BIGINT PRIMARY KEY)");
        await client.query("CREATE TABLE depannhome_calendar_events(id BIGINT PRIMARY KEY)");
        await client.query("CREATE TABLE depannhome_purchases(id BIGINT PRIMARY KEY,owner_id BIGINT,updated_at TIMESTAMPTZ)");
        await client.query(await read("database/migrations/0038_all_in_one_business_suite.sql"));
        const result = await client.query("SELECT to_regclass('depannhome_customer_portal_links') AS portal,to_regclass('depannhome_inventory_movements') AS inventory,to_regclass('depannhome_automation_rules') AS automation");
        assert.deepEqual(result.rows[0], { portal: "depannhome_customer_portal_links", inventory: "depannhome_inventory_movements", automation: "depannhome_automation_rules" });
    } finally {
        await client.query("SET search_path TO public").catch(() => {});
        await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => {});
        client.release();
        await pool.end();
    }
});
