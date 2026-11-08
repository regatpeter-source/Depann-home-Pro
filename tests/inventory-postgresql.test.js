import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import express from "express";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config({ path: fileURLToPath(new URL("../.env.test.local", import.meta.url)) });
const databaseUrl = String(process.env.TEST_DATABASE_URL || "");
const enabled = Boolean(databaseUrl);
const schema = `test_inventory_${process.pid}_${Date.now()}`;
let administration;
let database;
let server;
let baseUrl;

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
        CREATE TABLE depannhome_inventory_locations(
            id BIGINT PRIMARY KEY, owner_id BIGINT, name TEXT, location_type TEXT, vehicle_registration TEXT DEFAULT '',
            assigned_user_id BIGINT, is_active BOOLEAN DEFAULT TRUE
        );
        CREATE TABLE depannhome_inventory_items(
            id BIGINT PRIMARY KEY, owner_id BIGINT, sku TEXT, name TEXT, unit TEXT, default_unit_cost NUMERIC,
            reorder_level NUMERIC, is_active BOOLEAN DEFAULT TRUE
        );
        CREATE TABLE depannhome_inventory_movements(
            id BIGSERIAL PRIMARY KEY, owner_id BIGINT, item_id BIGINT, location_id BIGINT, movement_type TEXT,
            quantity NUMERIC, unit_cost NUMERIC, event_id BIGINT, transfer_reference UUID, reason TEXT DEFAULT '',
            created_by BIGINT, created_at TIMESTAMPTZ DEFAULT NOW()
        );
        INSERT INTO depannhome_inventory_locations(id,owner_id,name,location_type) VALUES
            (101,1,'Dépôt','warehouse'),(102,1,'Fourgon','vehicle'),(201,2,'Autre dépôt','warehouse');
        INSERT INTO depannhome_inventory_items(id,owner_id,sku,name,unit,default_unit_cost,reorder_level) VALUES
            (11,1,'ART-1','Pièce','unité',10,3),(22,2,'AUTRE','Article isolé','unité',1,0);
        INSERT INTO depannhome_inventory_movements(owner_id,item_id,location_id,movement_type,quantity,unit_cost) VALUES
            (1,11,101,'in',10,10),(1,11,102,'in',4,10),(2,22,201,'in',99,1)
    `);
    const { registerBusinessSuiteRoutes } = await import("../server/business-suite.js");
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        const owner = request.get("X-Test-Owner") || "1";
        request.user = { sub: owner, accountOwnerId: owner, role: request.get("X-Test-Role") || "admin" };
        next();
    });
    registerBusinessSuiteRoutes(app, (_request, _response, next) => next());
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

test("PostgreSQL et API : transferts atomiques, quantités par emplacement et isolation des entreprises", { skip: !enabled }, async () => {
    const transfer = (quantity, extra = {}) => fetch(`${baseUrl}/api/business-suite/inventory/transfers`, {
        method: "POST", headers: { "Content-Type": "application/json", ...extra },
        body: JSON.stringify({ itemId: 11, fromLocationId: 101, toLocationId: 102, quantity, reason: "Réapprovisionnement" })
    });
    const first = await transfer(3);
    assert.equal(first.status, 201);
    let response = await fetch(`${baseUrl}/api/business-suite/inventory`);
    let data = await response.json();
    assert.equal(data.items[0].quantity, 14);
    assert.deepEqual(data.balances.map(balance => [balance.locationName, balance.quantity]), [["Dépôt", 7], ["Fourgon", 7]]);
    assert.equal(data.movements.filter(movement => movement.movementType.startsWith("transfer_")).length, 2);

    const concurrent = await Promise.all([transfer(5), transfer(5)]);
    assert.deepEqual(concurrent.map(result => result.status).sort(), [201, 409]);
    response = await fetch(`${baseUrl}/api/business-suite/inventory`);
    data = await response.json();
    assert.equal(data.items[0].quantity, 14);
    assert.deepEqual(data.balances.map(balance => [balance.locationName, balance.quantity]), [["Dépôt", 2], ["Fourgon", 12]]);
    await database.query(`INSERT INTO depannhome_inventory_movements(owner_id,item_id,location_id,movement_type,quantity,unit_cost)
        SELECT 1,11,101,'in',0.001,10 FROM generate_series(1,205)`);
    response = await fetch(`${baseUrl}/api/business-suite/inventory`);
    data = await response.json();
    assert.equal(data.movements.length, 200);
    assert.equal(data.items[0].quantity, 14.205);
    assert.deepEqual(data.balances.map(balance => [balance.locationName, balance.quantity]), [["Dépôt", 2.205], ["Fourgon", 12]]);

    const foreign = await transfer(1, { "X-Test-Owner": "2" });
    assert.equal(foreign.status, 404);
    response = await fetch(`${baseUrl}/api/business-suite/inventory`, { headers: { "X-Test-Owner": "2" } });
    data = await response.json();
    assert.deepEqual(data.items.map(item => item.name), ["Article isolé"]);
    assert.deepEqual(data.balances.map(balance => [balance.locationName, balance.quantity]), [["Autre dépôt", 99]]);

    assert.equal((await transfer(1, { "X-Test-Role": "accountant" })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/business-suite/inventory`, { headers: { "X-Test-Role": "accountant" } })).status, 200);
});

test("les mouvements fractionnaires conservent une quantité arrondie et refusent un stock négatif", { skip: !enabled }, async () => {
    await database.query(`INSERT INTO depannhome_inventory_items(id,owner_id,sku,name,unit,default_unit_cost,reorder_level)
        VALUES(12,1,'DECIMAL','Article fractionnaire','unité',1,0)`);
    await database.query(`INSERT INTO depannhome_inventory_movements(owner_id,item_id,location_id,movement_type,quantity,unit_cost)
        VALUES(1,12,101,'in',0.3,1)`);
    const withdraw = quantity => fetch(`${baseUrl}/api/business-suite/inventory/movements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: 12, locationId: 101, movementType: "out", quantity })
    });

    let response = await withdraw(0.1);
    assert.equal(response.status, 201);
    assert.equal((await response.json()).balance, 0.2);
    response = await withdraw(0.2);
    assert.equal(response.status, 201);
    assert.equal((await response.json()).balance, 0);
    assert.equal((await withdraw(0.001)).status, 409);
});

test("le total et les soldes utilisent le même instantané pendant une écriture concurrente", { skip: !enabled, timeout: 15000 }, async () => {
    const before = await (await fetch(`${baseUrl}/api/business-suite/inventory`)).json();
    const beforeItem = before.items.find(item => Number(item.id) === 11);
    const beforeBalances = before.balances.filter(balance => Number(balance.itemId) === 11);
    const blocker = await database.connect();
    let transactionOpen = false;
    let pendingResponse;
    try {
        const { rows } = await blocker.query("SELECT pg_backend_pid() AS pid");
        await blocker.query("BEGIN");
        transactionOpen = true;
        await blocker.query("LOCK TABLE depannhome_inventory_items IN ACCESS EXCLUSIVE MODE");
        pendingResponse = fetch(`${baseUrl}/api/business-suite/inventory`);

        let waiting = false;
        for (let attempt = 0; attempt < 80 && !waiting; attempt += 1) {
            const result = await database.query(`SELECT 1 FROM pg_stat_activity
                WHERE $1::integer = ANY(pg_blocking_pids(pid)) AND query LIKE 'SELECT item.id,item.sku,item.name%'`, [rows[0].pid]);
            waiting = result.rowCount > 0;
            if (!waiting) await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.ok(waiting, "La lecture du stock doit attendre le verrou après avoir établi son instantané.");
        await blocker.query(`INSERT INTO depannhome_inventory_movements(owner_id,item_id,location_id,movement_type,quantity,unit_cost)
            VALUES(1,11,101,'in',0.123,10)`);
        await blocker.query("COMMIT");
        transactionOpen = false;

        const response = await pendingResponse;
        assert.equal(response.status, 200);
        const during = await response.json();
        assert.equal(during.items.find(item => Number(item.id) === 11).quantity, beforeItem.quantity);
        assert.deepEqual(during.balances.filter(balance => Number(balance.itemId) === 11), beforeBalances);
        const after = await (await fetch(`${baseUrl}/api/business-suite/inventory`)).json();
        assert.equal(after.items.find(item => Number(item.id) === 11).quantity, beforeItem.quantity + 0.123);
    } finally {
        if (transactionOpen) await blocker.query("ROLLBACK");
        blocker.release();
        if (pendingResponse) await pendingResponse.catch(() => {});
    }
});

test("les soldes signalent un emplacement inactif sans effacer son stock", { skip: !enabled }, async () => {
    await database.query("UPDATE depannhome_inventory_locations SET is_active=FALSE WHERE id=102 AND owner_id=1");
    const response = await fetch(`${baseUrl}/api/business-suite/inventory`);
    const data = await response.json();
    const balance = data.balances.find(item => Number(item.locationId) === 102 && Number(item.itemId) === 11);
    assert.equal(balance.locationIsActive, false);
    assert.equal(balance.quantity, 12);
});
