import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import { createDocumentAccountingEntry, createSettlementAccountingEntry } from "../server/accounting-ledger.js";

const testDatabaseUrl = String(process.env.TEST_DATABASE_URL || "");
const enabled = Boolean(testDatabaseUrl);
const schema = `test_accounting_${process.pid}_${Date.now()}`;
let administration;
let database;
let server;
let baseUrl;

before(async () => {
    if (!enabled) return;
    const parsed = new URL(testDatabaseUrl);
    if (!/test/i.test(parsed.pathname)) throw new Error("TEST_DATABASE_URL doit désigner une base dont le nom contient « test ».");
    administration = new pg.Pool({ connectionString: testDatabaseUrl });
    await administration.query(`CREATE SCHEMA ${schema}`);
    process.env.PGOPTIONS = `-c search_path=${schema}`;
    process.env.DATABASE_URL = testDatabaseUrl;
    const databaseModule = await import("../server/database.js");
    database = databaseModule.getPool();
    await database.query(`CREATE TABLE depannhome_users (id BIGINT PRIMARY KEY, account_owner_id BIGINT NOT NULL)`);
    await database.query(`CREATE TABLE depannhome_accounting_aids (
        id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id), name VARCHAR(160) NOT NULL,
        description VARCHAR(1000) NOT NULL DEFAULT '', aid_type VARCHAR(40) NOT NULL DEFAULT 'custom',
        calculation_mode VARCHAR(20) NOT NULL DEFAULT 'fixed', amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        auto_apply BOOLEAN NOT NULL DEFAULT FALSE, rules JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await database.query("INSERT INTO depannhome_users(id,account_owner_id) VALUES(1,1),(2,2)");
    await database.query("INSERT INTO depannhome_accounting_aids(owner_id,name,amount) VALUES(2,'Aide autre entreprise',999)");
    const { registerAccountingRoutes } = await import("../server/accounting.js");
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        const role = request.get("X-Test-Role") || "accountant";
        const owner = request.get("X-Test-Owner") || "1";
        request.user = { sub: owner, accountOwnerId: owner, role, subscriptionTier: "pro", canAccessAccounting: true, fullName: "Test" };
        next();
    });
    registerAccountingRoutes(app, (_request, _response, next) => next());
    server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    if (!enabled) return;
    if (server) await new Promise(resolve => server.close(resolve));
    if (database) await database.end();
    delete process.env.PGOPTIONS;
    if (administration) {
        await administration.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await administration.end();
    }
});

test("API PostgreSQL : le Comptable lit ses aides mais ne peut pas en créer", { skip: !enabled }, async () => {
    const blocked = await fetch(`${baseUrl}/api/accounting/aids`, { method: "POST", headers: { "Content-Type": "application/json", "X-Test-Role": "accountant" }, body: JSON.stringify({ name: "Franchise", amount: 200 }) });
    assert.equal(blocked.status, 403);
    const count = await database.query("SELECT COUNT(*)::int AS count FROM depannhome_accounting_aids WHERE owner_id=1");
    assert.equal(count.rows[0].count, 0);
    const visible = await fetch(`${baseUrl}/api/accounting/aids`, { headers: { "X-Test-Role": "accountant" } });
    assert.equal(visible.status, 200);
    assert.deepEqual((await visible.json()).aids, []);
});

test("API PostgreSQL : un Administrateur crée une aide isolée par entreprise", { skip: !enabled }, async () => {
    const created = await fetch(`${baseUrl}/api/accounting/aids`, { method: "POST", headers: { "Content-Type": "application/json", "X-Test-Role": "admin", "X-Test-Owner": "1" }, body: JSON.stringify({ name: "Franchise assurance", amount: 200, calculationMode: "fixed", aidType: "custom" }) });
    assert.equal(created.status, 201);
    const rows = await database.query("SELECT owner_id,name,amount::float AS amount FROM depannhome_accounting_aids ORDER BY owner_id");
    assert.deepEqual(rows.rows, [{ owner_id: "1", name: "Franchise assurance", amount: 200 }, { owner_id: "2", name: "Aide autre entreprise", amount: 999 }]);
});

test("PostgreSQL : aide et règlement soldent exactement la créance client", { skip: !enabled }, async () => {
    await database.query("CREATE TABLE ledger_lines(owner_id BIGINT, account_number VARCHAR(20), debit NUMERIC(14,2), credit NUMERIC(14,2))");
    const document = { id: 10, ownerId: 1, documentType: "invoice", documentNumber: "FAC-TEST-001", clientId: "client-1", customerName: "Client", issueDate: "2026-08-27", lines: [{ quantity: 1, unitPrice: 1000, vatRate: 20 }], financialData: { aids: [{ name: "Franchise", amount: 200, calculationMode: "fixed" }] } };
    const invoice = createDocumentAccountingEntry({ document, entryNumber: "VE000001", validDate: document.issueDate });
    const settlement = createSettlementAccountingEntry({ settlement: { id: 1, ownerId: 1, amount: 1000, date: "2026-08-27", method: "Virement" }, document, entryNumber: "BQ000001", validDate: "2026-08-27" });
    for (const line of [...invoice.lines, ...settlement.lines]) await database.query("INSERT INTO ledger_lines VALUES($1,$2,$3,$4)", [1, line.accountNumber, line.debit, line.credit]);
    const balances = await database.query("SELECT account_number,SUM(debit-credit)::float AS balance FROM ledger_lines GROUP BY account_number ORDER BY account_number");
    assert.deepEqual(balances.rows, [{ account_number: "411000", balance: 0 }, { account_number: "445710", balance: -200 }, { account_number: "467000", balance: 200 }, { account_number: "512000", balance: 1000 }, { account_number: "706000", balance: -1000 }]);
});

test("PostgreSQL : les migrations sont checksumées et idempotentes", { skip: !enabled }, async () => {
    const { migrationStatus, runMigrations } = await import("../server/database-migrations.js");
    const first = await runMigrations({ database, logger: { info() {} } });
    const second = await runMigrations({ database, logger: { info() {} } });
    assert.ok(first.applied.length >= 1);
    assert.equal(second.applied.length, 0);
    assert.equal((await migrationStatus(database)).every(item => item.status === "applied"), true);
});
