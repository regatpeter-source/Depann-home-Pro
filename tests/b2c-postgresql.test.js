import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import pg from "pg";
import { loadB2cReport, loadB2cReports, prepareB2cReport } from "../server/b2c-transaction-export.js";

dotenv.config({ path: fileURLToPath(new URL("../.env.test.local", import.meta.url)) });
const databaseUrl = String(process.env.TEST_DATABASE_URL || "");
const enabled = Boolean(databaseUrl);
const schema = `test_b2c_${process.pid}_${Date.now()}`;
let administration;
let database;

before(async () => {
    if (!enabled) return;
    if (!/test/i.test(new URL(databaseUrl).pathname)) throw new Error("TEST_DATABASE_URL doit désigner une base de test.");
    administration = new pg.Pool({ connectionString: databaseUrl });
    await administration.query(`CREATE SCHEMA ${schema}`);
    database = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await database.query(`SET search_path TO ${schema}`);
    await database.query(`
        CREATE TABLE depannhome_billing_profiles(owner_id BIGINT, vat_on_debits BOOLEAN);
        CREATE TABLE depannhome_billing_documents(
            id BIGSERIAL PRIMARY KEY, owner_id BIGINT, customer_type TEXT, document_type TEXT,
            issue_date DATE, issued_at TIMESTAMPTZ, status TEXT, lines JSONB DEFAULT '[]',
            financial_data JSONB DEFAULT '{}', legal_data JSONB DEFAULT '{}'
        );
        CREATE TABLE depannhome_accounting_settlements(
            id BIGSERIAL PRIMARY KEY, owner_id BIGINT, document_id BIGINT, settlement_date DATE, amount NUMERIC
        );
        CREATE TABLE depannhome_b2c_report_batches(
            id BIGSERIAL PRIMARY KEY, owner_id BIGINT, period_start DATE, period_end DATE, status TEXT,
            transaction_count INTEGER, collection_count INTEGER, payload JSONB, payload_sha256 TEXT,
            created_by BIGINT, created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE depannhome_b2c_report_events(
            owner_id BIGINT, batch_id BIGINT, actor_id BIGINT, event_type TEXT, details JSONB
        )
    `);
});

after(async () => {
    if (!enabled) return;
    if (database) await database.end();
    if (administration) {
        await administration.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await administration.end();
    }
});

test("PostgreSQL : les avoirs B2C bloquent les nouveaux lots et les anciens exports de leur entreprise", { skip: !enabled }, async () => {
    await database.query(`INSERT INTO depannhome_billing_documents(owner_id,customer_type,document_type,issue_date,issued_at,status,lines)
        VALUES (1,'Particulier','invoice','2026-03-10',NOW(),'issued','[{"quantity":1,"unitPrice":100,"vatRate":20}]'),
               (2,'Particulier','credit','2026-03-12',NOW(),'issued','[]'),
               (1,'Professionnel','credit','2026-03-15',NOW(),'issued','[]')`);
    const options = { ownerId: "1", actorId: "1", periodStart: "2026-03-01", periodEnd: "2026-03-31", database };
    const created = await prepareB2cReport(options);
    assert.equal(created.payload.transactions.length, 1);
    assert.equal((await loadB2cReport("1", created.id, database)).hasCreditNotes, false);

    const credit = await database.query(`INSERT INTO depannhome_billing_documents(owner_id,customer_type,document_type,issue_date,issued_at,status)
        VALUES(1,'Particulier','credit','2026-03-20',NOW(),'issued') RETURNING id`);
    await assert.rejects(prepareB2cReport(options), error => error.status === 409);
    assert.equal((await loadB2cReport("1", created.id, database)).hasCreditNotes, true);
    assert.equal((await loadB2cReports("1", database))[0].hasCreditNotes, true);
    assert.equal(await loadB2cReport("2", created.id, database), null);

    await database.query("INSERT INTO depannhome_accounting_settlements(owner_id,document_id,settlement_date,amount) VALUES(1,$1,'2026-04-04',10)", [credit.rows[0].id]);
    await assert.rejects(prepareB2cReport({ ...options, periodStart: "2026-04-01", periodEnd: "2026-04-30" }), error => error.status === 409);
    const batches = await database.query("SELECT COUNT(*)::int AS count FROM depannhome_b2c_report_batches WHERE owner_id=1");
    assert.equal(batches.rows[0].count, 1);
});

test("PostgreSQL : la préparation utilise un instantané cohérent pendant une facturation concurrente", { skip: !enabled, timeout: 15000 }, async () => {
    await database.query("INSERT INTO depannhome_billing_profiles(owner_id,vat_on_debits) VALUES(3,FALSE)");
    const blocker = await administration.connect();
    let transactionOpen = false;
    let pendingReport;
    try {
        await blocker.query(`SET search_path TO ${schema}`);
        const { rows } = await blocker.query("SELECT pg_backend_pid() AS pid");
        await blocker.query("BEGIN");
        transactionOpen = true;
        await blocker.query("LOCK TABLE depannhome_billing_documents IN ACCESS EXCLUSIVE MODE");
        pendingReport = prepareB2cReport({ ownerId: "3", actorId: "3", periodStart: "2026-03-01", periodEnd: "2026-03-31", database });

        let waiting = false;
        for (let attempt = 0; attempt < 80 && !waiting; attempt += 1) {
            const result = await administration.query(`SELECT 1 FROM pg_stat_activity
                WHERE $1::integer = ANY(pg_blocking_pids(pid)) AND query LIKE 'SELECT document.id,%'`, [rows[0].pid]);
            waiting = result.rowCount > 0;
            if (!waiting) await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.ok(waiting, "La lecture des factures doit attendre le verrou après lecture du profil.");
        const invoice = await blocker.query(`INSERT INTO depannhome_billing_documents(owner_id,customer_type,document_type,issue_date,issued_at,status,lines)
            VALUES(3,'Particulier','invoice','2026-03-10',NOW(),'issued','[{"quantity":1,"unitPrice":100,"vatRate":20}]') RETURNING id`);
        await blocker.query(`INSERT INTO depannhome_accounting_settlements(owner_id,document_id,settlement_date,amount)
            VALUES(3,$1,'2026-03-11',120)`, [invoice.rows[0].id]);
        await blocker.query("COMMIT");
        transactionOpen = false;

        const report = await pendingReport;
        assert.equal(report.payload.transactions.length, 0);
        assert.equal(report.payload.collections.length, 0);
        const laterReport = await prepareB2cReport({ ownerId: "3", actorId: "3", periodStart: "2026-03-01", periodEnd: "2026-03-31", database });
        assert.equal(laterReport.payload.transactions.length, 1);
        assert.equal(laterReport.payload.collections.length, 1);
    } finally {
        if (transactionOpen) await blocker.query("ROLLBACK");
        blocker.release();
        if (pendingReport) await pendingReport.catch(() => {});
    }
});
