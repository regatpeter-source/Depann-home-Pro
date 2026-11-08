import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import pg from "pg";

dotenv.config({ path: fileURLToPath(new URL("../.env.test.local", import.meta.url)) });
const databaseUrl = String(process.env.TEST_DATABASE_URL || "");
const enabled = Boolean(databaseUrl);
const schema = `test_automation_${process.pid}_${Date.now()}`;
let administration;
let database;
let server;
let baseUrl;
let executeAutomationCycle;

before(async () => {
    if (!enabled) return;
    if (!/test/i.test(new URL(databaseUrl).pathname)) throw new Error("TEST_DATABASE_URL doit désigner une base de test.");
    administration = new pg.Pool({ connectionString: databaseUrl });
    await administration.query(`CREATE SCHEMA ${schema}`);
    process.env.PGOPTIONS = `-c search_path=${schema}`;
    process.env.DATABASE_URL = databaseUrl;
    const { getPool } = await import("../server/database.js");
    database = getPool();
    await database.query(`
        CREATE TABLE depannhome_automation_rules (
            id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL, name VARCHAR(160) NOT NULL,
            rule_type VARCHAR(40) NOT NULL, is_active BOOLEAN NOT NULL DEFAULT TRUE, lead_days INTEGER NOT NULL DEFAULT 0,
            configuration JSONB NOT NULL DEFAULT '{}', created_by BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE depannhome_internal_reminders (
            id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL, rule_id BIGINT REFERENCES depannhome_automation_rules(id) ON DELETE SET NULL,
            reminder_type VARCHAR(40) NOT NULL, entity_type VARCHAR(40) NOT NULL, entity_id VARCHAR(100) NOT NULL,
            title VARCHAR(200) NOT NULL, details VARCHAR(1000) NOT NULL DEFAULT '', due_at TIMESTAMPTZ NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'open', dedupe_key VARCHAR(250) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ,
            UNIQUE(owner_id,dedupe_key)
        );
        CREATE TABLE depannhome_automation_runs (
            id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL, source VARCHAR(20) NOT NULL,
            status VARCHAR(20) NOT NULL, created_count INTEGER NOT NULL DEFAULT 0, error_code VARCHAR(100) NOT NULL DEFAULT '',
            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ
        );
        CREATE TABLE depannhome_maintenance_contracts (
            id BIGINT PRIMARY KEY, owner_id BIGINT NOT NULL, client_id VARCHAR(100) NOT NULL, reference VARCHAR(100) NOT NULL,
            title VARCHAR(160) NOT NULL, status VARCHAR(20) NOT NULL, ends_on DATE, next_service_on DATE,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE depannhome_inventory_items (
            id BIGINT PRIMARY KEY, owner_id BIGINT NOT NULL, sku VARCHAR(100) NOT NULL, name VARCHAR(200) NOT NULL,
            unit VARCHAR(30) NOT NULL, reorder_level NUMERIC(12,3) NOT NULL, is_active BOOLEAN NOT NULL DEFAULT TRUE,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE depannhome_inventory_movements (
            id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL, item_id BIGINT NOT NULL, quantity NUMERIC(12,3) NOT NULL
        );
        CREATE TABLE depannhome_billing_documents (
            id BIGINT PRIMARY KEY, owner_id BIGINT NOT NULL, document_number TEXT, customer_name TEXT,
            document_type TEXT, status TEXT, follow_up_date DATE, issue_date DATE
        );
        CREATE TABLE depannhome_quote_decisions (id BIGINT PRIMARY KEY, owner_id BIGINT, document_id BIGINT);
        CREATE TABLE depannhome_calendar_events (id BIGINT PRIMARY KEY, owner_id BIGINT NOT NULL, title TEXT NOT NULL);
        INSERT INTO depannhome_calendar_events VALUES (1,1,'Intervention inchangée');
        INSERT INTO depannhome_maintenance_contracts VALUES
            (101,1,'client-1','C-1','Contrat suivi','active',CURRENT_DATE+20,CURRENT_DATE+5,NOW()),
            (102,1,'client-1','C-2','Contrat suspendu','suspended',CURRENT_DATE,CURRENT_DATE,NOW()),
            (201,2,'client-2','C-3','Autre entreprise','active',CURRENT_DATE,CURRENT_DATE,NOW());
        INSERT INTO depannhome_inventory_items(id,owner_id,sku,name,unit,reorder_level,is_active) VALUES
            (11,1,'PIECE','Pièce','unité',3,TRUE),(12,1,'INACTIF','Ancienne pièce','unité',5,FALSE),
            (21,2,'AUTRE','Pièce étrangère','unité',0,TRUE);
        INSERT INTO depannhome_inventory_movements(owner_id,item_id,quantity) VALUES (1,11,4),(1,11,-1),(2,21,0.5)
    `);
    await database.query(await readFile(new URL("../database/migrations/0041_reminder_target_lookup.sql", import.meta.url), "utf8"));
    const automation = await import("../server/automation.js");
    executeAutomationCycle = automation.executeAutomationCycle;
    const { registerBusinessSuiteRoutes } = await import("../server/business-suite.js");
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        const owner = request.get("X-Test-Owner") || "1";
        request.user = {
            sub: owner, accountOwnerId: owner, role: request.get("X-Test-Role") || "admin",
            organization: { interfaceType: request.get("X-Test-Interface") || "standard" },
            isSupportControl: request.get("X-Test-Support") === "true"
        };
        next();
    });
    const authentication = (_request, _response, next) => next();
    automation.registerAutomationRoutes(app, authentication);
    registerBusinessSuiteRoutes(app, authentication);
    app.use((error, _request, response, _next) => response.status(error.status || 500).json({ message: error.message }));
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

function request(path, { method = "GET", body, owner = "1", role = "admin", interfaceType = "standard", supportControl = false } = {}) {
    return fetch(`${baseUrl}${path}`, {
        method,
        headers: {
            "Content-Type": "application/json", "X-Test-Owner": owner, "X-Test-Role": role,
            "X-Test-Interface": interfaceType, "X-Test-Support": String(supportControl)
        },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
}

test("PostgreSQL : activation manuelle, échéances, seuils, états, permissions et isolation", { skip: !enabled }, async () => {
    let response = await request("/api/automation/rules");
    assert.deepEqual((await response.json()).rules, []);
    response = await request("/api/automation/run", { method: "POST" });
    assert.equal((await response.json()).createdCount, 0);

    const definitions = [
        { name: "Maintenance", ruleType: "maintenance_due", isActive: true, leadDays: 7, configuration: {} },
        { name: "Renouvellement", ruleType: "contract_renewal", isActive: true, leadDays: 30, configuration: {} },
        { name: "Stock faible", ruleType: "low_stock", isActive: true, leadDays: 0, configuration: { preventOpenDuplicates: true } }
    ];
    const ids = [];
    for (const body of definitions) {
        response = await request("/api/automation/rules", { method: "POST", body });
        assert.equal(response.status, 201);
        ids.push((await response.json()).id);
    }
    response = await request("/api/automation/rules");
    assert.equal((await response.json()).reminders.length, 0, "Aucune règle ne s’exécute lors de sa création.");
    assert.equal((await request("/api/automation/rules", { method: "POST", body: { ...definitions[0], leadDays: 366 } })).status, 400);
    assert.equal((await request("/api/automation/rules", { method: "POST", body: { ...definitions[0], isActive: "false" } })).status, 400);

    response = await request("/api/automation/run", { method: "POST" });
    assert.equal((await response.json()).createdCount, 3);
    const initial = await (await request("/api/automation/rules")).json();
    assert.deepEqual(initial.reminders.map(item => item.reminderType).sort(), ["contract_renewal", "low_stock", "maintenance_due"]);
    assert.equal(initial.reminders.filter(item => item.clientId === "client-1").length, 2);
    const keys = await database.query("SELECT dedupe_key FROM depannhome_internal_reminders WHERE owner_id=1");
    assert.ok(keys.rows.every(row => /:\d{4}-\d{2}-\d{2}$/.test(row.dedupe_key)));
    const results = await Promise.all([request("/api/automation/run", { method: "POST" }), request("/api/automation/run", { method: "POST" })]);
    const concurrent = await Promise.all(results.map(result => result.json()));
    assert.equal(concurrent.reduce((sum, item) => sum + (item.createdCount || 0), 0), 0);

    const maintenance = initial.reminders.find(item => item.reminderType === "maintenance_due");
    const stock = initial.reminders.find(item => item.reminderType === "low_stock");
    assert.equal((await request(`/api/automation/reminders/${maintenance.id}`, { method: "PATCH", body: { status: "done" } })).status, 204);
    assert.equal((await (await request("/api/automation/run", { method: "POST" })).json()).createdCount, 0);
    assert.equal((await request(`/api/automation/reminders/${maintenance.id}`, { method: "PATCH", body: { status: "open" } })).status, 204);
    assert.equal((await database.query("SELECT completed_at FROM depannhome_internal_reminders WHERE id=$1", [maintenance.id])).rows[0].completed_at, null);

    await database.query(`UPDATE depannhome_internal_reminders SET due_at=NOW()-INTERVAL '1 day',
        dedupe_key=LEFT(dedupe_key,LENGTH(dedupe_key)-10)||TO_CHAR(CURRENT_DATE-1,'YYYY-MM-DD') WHERE id=$1`, [stock.id]);
    assert.equal((await (await request("/api/automation/run", { method: "POST" })).json()).createdCount, 0, "Un stock faible déjà ouvert ne multiplie pas les rappels.");
    assert.equal((await request(`/api/automation/reminders/${stock.id}`, { method: "PATCH", body: { status: "done" } })).status, 204);
    assert.equal((await (await request("/api/automation/run", { method: "POST" })).json()).createdCount, 1, "Un stock toujours faible peut revenir le jour suivant son traitement.");

    assert.equal((await request(`/api/automation/rules/${ids[0]}`, { method: "PATCH", body: { ...definitions[0], isActive: false } })).status, 204);
    assert.equal((await request("/api/business-suite/clients/client-1/contracts/101/schedule", {
        method: "PATCH", body: { status: "active", endsOn: "2020-12-01", nextServiceOn: "2020-11-01" }
    })).status, 204);
    assert.equal((await (await request("/api/automation/run", { method: "POST" })).json()).createdCount, 1, "Seul le renouvellement actif détecte sa nouvelle date.");
    assert.equal((await request(`/api/automation/rules/${ids[0]}`, { method: "PATCH", body: definitions[0] })).status, 204);
    assert.equal((await (await request("/api/automation/run", { method: "POST" })).json()).createdCount, 1);
    assert.equal((await database.query("SELECT COUNT(*)::int AS count FROM depannhome_calendar_events WHERE owner_id=1")).rows[0].count, 1);

    assert.equal((await request("/api/business-suite/clients/client-1/contracts/101/schedule", { method: "PATCH", body: { status: "active", endsOn: "2026-02-30", nextServiceOn: "" } })).status, 400);
    assert.equal((await request("/api/business-suite/clients/client-1/contracts/101/schedule", { method: "PATCH", owner: "2", body: { status: "active", endsOn: "", nextServiceOn: "" } })).status, 404);
    assert.equal((await request("/api/business-suite/clients/client-1/contracts/101/schedule", { method: "PATCH", role: "technician", body: { status: "active", endsOn: "", nextServiceOn: "" } })).status, 403);
    assert.equal((await request("/api/business-suite/inventory/items/11/threshold", { method: "PATCH", body: { reorderLevel: "1.2345" } })).status, 400);
    assert.equal((await request("/api/business-suite/inventory/items/11/threshold", { method: "PATCH", role: "commercial", body: { reorderLevel: 1 } })).status, 403);
    assert.equal((await request("/api/business-suite/inventory/items/11/threshold", { method: "PATCH", owner: "2", body: { reorderLevel: 1 } })).status, 404);
    assert.equal((await request("/api/business-suite/inventory/items/11/threshold", { method: "PATCH", role: "pc_standard", body: { reorderLevel: "2.125" } })).status, 204);
    assert.equal((await database.query("SELECT reorder_level::text FROM depannhome_inventory_items WHERE id=11")).rows[0].reorder_level, "2.125");

    for (const role of ["admin", "pc_standard", "mobile_admin"]) assert.equal((await request("/api/automation/rules", { role })).status, 200);
    assert.equal((await request("/api/automation/dashboard", { interfaceType: "group" })).status, 200);
    for (const role of ["commercial", "accountant", "team_lead", "technician"]) {
        assert.equal((await request("/api/automation/rules", { role })).status, 403);
        assert.equal((await request("/api/automation/run", { method: "POST", role })).status, 403);
        assert.equal((await request("/api/automation/dashboard", { role })).status, 403);
        assert.equal((await request("/api/automation/dashboard/run", { method: "POST", role })).status, 403);
    }
    for (const context of [{ interfaceType: "partner" }, { supportControl: true }]) {
        const blocked = [
            ["/api/automation/dashboard", {}],
            ["/api/automation/rules", {}],
            ["/api/automation/dashboard/run", { method: "POST" }],
            ["/api/automation/rules", { method: "POST", body: definitions[0] }],
            [`/api/automation/rules/${ids[0]}`, { method: "PATCH", body: definitions[0] }],
            [`/api/automation/reminders/${maintenance.id}`, { method: "PATCH", body: { status: "done" } }],
            ["/api/business-suite/clients/client-1/contracts/101/schedule", { method: "PATCH", body: { status: "active", endsOn: "", nextServiceOn: "" } }],
            ["/api/business-suite/inventory/items/11/threshold", { method: "PATCH", body: { reorderLevel: 1 } }]
        ];
        for (const [path, options] of blocked) {
            assert.equal((await request(path, { ...options, ...context })).status, 403, `${path} doit être interdit dans ${JSON.stringify(context)}`);
        }
    }
    assert.equal((await request(`/api/automation/rules/${ids[0]}`, { method: "PATCH", owner: "2", body: definitions[0] })).status, 404);
    assert.equal((await request(`/api/automation/reminders/${maintenance.id}`, { method: "PATCH", owner: "2", body: { status: "dismissed" } })).status, 404);
    const foreign = await (await request("/api/automation/rules", { owner: "2" })).json();
    assert.deepEqual(foreign.rules, []);
    assert.deepEqual(foreign.reminders, []);
});

test("PostgreSQL : le tableau de bord exclut les devis préexistants sans les modifier ni les exécuter manuellement", { skip: !enabled }, async () => {
    await database.query(`INSERT INTO depannhome_billing_documents(id,owner_id,document_number,customer_name,document_type,status,follow_up_date,issue_date)
        VALUES(401,4,'D-1','Client existant','quote','issued',CURRENT_DATE,CURRENT_DATE);
        INSERT INTO depannhome_automation_rules(owner_id,name,rule_type,is_active,lead_days)
        VALUES(4,'Relance préexistante','quote_follow_up',TRUE,0)`);
    const dashboard = await (await request("/api/automation/dashboard", { owner: "4" })).json();
    assert.deepEqual(dashboard.rules, []);
    assert.equal((await (await request("/api/automation/dashboard/run", { method: "POST", owner: "4" })).json()).createdCount, 0);
    assert.equal((await (await request("/api/automation/run", { method: "POST", owner: "4" })).json()).createdCount, 1);
    const legacy = await (await request("/api/automation/rules", { owner: "4" })).json();
    assert.equal(legacy.rules[0].isActive, true);
    assert.equal(legacy.reminders[0].reminderType, "quote_follow_up");
    const filtered = await (await request("/api/automation/dashboard", { owner: "4" })).json();
    assert.deepEqual(filtered.rules, []);
    assert.deepEqual(filtered.reminders, []);
});

test("PostgreSQL : compatibilité des anciennes clés et dates séparées par plusieurs années", { skip: !enabled }, async () => {
    await database.query(`INSERT INTO depannhome_maintenance_contracts(id,owner_id,client_id,reference,title,status,next_service_on)
        VALUES(301,3,'client-3','ANCIEN','Contrat historique','active','2009-11-08')`);
    const rule = await database.query(`INSERT INTO depannhome_automation_rules(owner_id,name,rule_type,is_active,lead_days)
        VALUES(3,'Ancienne maintenance','maintenance_due',TRUE,0) RETURNING id`);
    const day = await database.query("SELECT '2009-11-08'::date AS value");
    const legacyKey = `${rule.rows[0].id}:maintenance_due:maintenance_contract:301:${String(day.rows[0].value).slice(0, 10)}`;
    await database.query(`INSERT INTO depannhome_internal_reminders(owner_id,rule_id,reminder_type,entity_type,entity_id,title,details,due_at,status,dedupe_key)
        VALUES(3,$1,'maintenance_due','maintenance_contract','301','Ancien rappel','','2009-11-08'::date::timestamptz,'done',$2)`, [rule.rows[0].id, legacyKey]);
    assert.equal((await (await request("/api/automation/run", { method: "POST", owner: "3" })).json()).createdCount, 0);
    await database.query("UPDATE depannhome_maintenance_contracts SET next_service_on='2015-11-08' WHERE id=301");
    assert.equal((await (await request("/api/automation/run", { method: "POST", owner: "3" })).json()).createdCount, 1);
    const keys = await database.query("SELECT dedupe_key FROM depannhome_internal_reminders WHERE owner_id=3 ORDER BY id");
    assert.equal(keys.rows.length, 2);
    assert.match(keys.rows[1].dedupe_key, /:2015-11-08$/);
});

test("PostgreSQL : le tableau de bord lit règles, rappels et exécutions dans un instantané cohérent", { skip: !enabled, timeout: 15000 }, async () => {
    const blocker = await database.connect();
    let transactionOpen = false;
    let pendingResponse;
    try {
        const { rows } = await blocker.query("SELECT pg_backend_pid() AS pid");
        await blocker.query("BEGIN");
        transactionOpen = true;
        await blocker.query("LOCK TABLE depannhome_internal_reminders IN ACCESS EXCLUSIVE MODE");
        pendingResponse = request("/api/automation/dashboard", { owner: "6" });
        let waiting = false;
        for (let attempt = 0; attempt < 80 && !waiting; attempt += 1) {
            const result = await administration.query(`SELECT 1 FROM pg_stat_activity
                WHERE $1::integer = ANY(pg_blocking_pids(pid)) AND query LIKE 'SELECT reminder.id,%'`, [rows[0].pid]);
            waiting = result.rowCount > 0;
            if (!waiting) await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.ok(waiting, "La lecture des rappels doit attendre le verrou après lecture des règles.");
        const rule = await blocker.query(`INSERT INTO depannhome_automation_rules(owner_id,name,rule_type,is_active,lead_days)
            VALUES(6,'Stock','low_stock',TRUE,0) RETURNING id`);
        await blocker.query(`INSERT INTO depannhome_internal_reminders(owner_id,rule_id,reminder_type,entity_type,entity_id,title,details,due_at,dedupe_key)
            VALUES(6,$1,'low_stock','inventory_item','6','Stock','','2020-01-01','snapshot-test')`, [rule.rows[0].id]);
        await blocker.query("INSERT INTO depannhome_automation_runs(owner_id,source,status,created_count) VALUES(6,'manual','completed',1)");
        await blocker.query("COMMIT");
        transactionOpen = false;
        const snapshot = await (await pendingResponse).json();
        assert.deepEqual(snapshot, { rules: [], reminders: [], runs: [] });
        const later = await (await request("/api/automation/dashboard", { owner: "6" })).json();
        assert.equal(later.rules.length, 1);
        assert.equal(later.reminders.length, 1);
        assert.equal(later.runs.length, 1);
    } finally {
        if (transactionOpen) await blocker.query("ROLLBACK");
        blocker.release();
        if (pendingResponse) await pendingResponse.catch(() => {});
    }
});

test("PostgreSQL : un échec d’une entreprise ne bloque pas les autres et les longs noms restent valides", { skip: !enabled }, async () => {
    await database.query(`INSERT INTO depannhome_inventory_items(id,owner_id,sku,name,unit,reorder_level) VALUES
        (700,70,'VALIDE','Article avant erreur','u',0),(701,70,'ERREUR','Article en erreur','u',0),(711,71,'LONG',REPEAT('a',200),'u',0);
        INSERT INTO depannhome_automation_rules(owner_id,name,rule_type,is_active,lead_days) VALUES
        (70,'Stock en erreur','low_stock',TRUE,0),(71,'Stock valide','low_stock',TRUE,0);
        CREATE FUNCTION reject_test_reminder() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.owner_id=70 AND NEW.entity_id='701' THEN RAISE EXCEPTION 'échec simulé'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_test_reminder BEFORE INSERT ON depannhome_internal_reminders FOR EACH ROW EXECUTE FUNCTION reject_test_reminder()`);
    await executeAutomationCycle();
    const failed = await database.query("SELECT status,error_code FROM depannhome_automation_runs WHERE owner_id=70 ORDER BY id DESC LIMIT 1");
    assert.deepEqual(failed.rows[0], { status: "failed", error_code: "P0001" });
    assert.equal((await database.query("SELECT COUNT(*)::int AS count FROM depannhome_internal_reminders WHERE owner_id=70")).rows[0].count, 0, "Les rappels créés avant l’échec sont annulés.");
    const created = await database.query("SELECT LENGTH(title)::int AS length FROM depannhome_internal_reminders WHERE owner_id=71");
    assert.deepEqual(created.rows, [{ length: 200 }]);
});
