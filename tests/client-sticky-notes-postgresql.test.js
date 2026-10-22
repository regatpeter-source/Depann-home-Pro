import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import pg from "pg";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

dotenv.config({ path: fileURLToPath(new URL("../.env.test.local", import.meta.url)) });

const testDatabaseUrl = String(process.env.TEST_DATABASE_URL || "");
const enabled = Boolean(testDatabaseUrl);
const schema = `test_client_sticky_notes_${process.pid}_${Date.now()}`;
let administration;
let database;
let server;
let baseUrl;

before(async () => {
    if (!enabled) return;
    const parsed = new URL(testDatabaseUrl);
    if (!/test/i.test(parsed.pathname)) throw new Error("TEST_DATABASE_URL doit désigner une base dont le nom contient « test ». ");
    administration = new pg.Pool({ connectionString: testDatabaseUrl });
    await administration.query(`CREATE SCHEMA ${schema}`);
    process.env.PGOPTIONS = `-c search_path=${schema}`;
    process.env.DATABASE_URL = testDatabaseUrl;

    const databaseModule = await import("../server/database.js");
    const clientsModule = await import("../server/clients.js");
    database = databaseModule.getPool();
    await database.query("CREATE TABLE depannhome_users(id BIGINT PRIMARY KEY)");
    await database.query("INSERT INTO depannhome_users(id) VALUES(1),(2)");
    await clientsModule.initializeClients();
    await database.query(`
        INSERT INTO depannhome_clients(owner_id,client_id,client_data)
        VALUES
            (1,'client-refresh-test','{"id":"client-refresh-test","name":"Client actualisation"}'::jsonb),
            (2,'client-other-company','{"id":"client-other-company","name":"Autre entreprise"}'::jsonb)
    `);

    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        const ownerId = request.get("X-Test-Owner") || "1";
        request.user = { sub: ownerId, accountOwnerId: ownerId, role: "admin", deviceType: "desktop", fullName: "Test persistance" };
        next();
    });
    clientsModule.registerClientRoutes(app, (_request, _response, next) => next());
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

test("un post-it reste disponible après une nouvelle lecture HTTP", { skip: !enabled }, async () => {
    const created = await fetch(`${baseUrl}/api/clients/client-refresh-test/sticky-notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "Rappeler le client après actualisation", color: "red" })
    });
    assert.equal(created.status, 201);
    assert.match(created.headers.get("cache-control") || "", /no-store/);
    const createdPayload = await created.json();
    assert.ok(createdPayload.stickyNote?.id);

    const persisted = await database.query("SELECT body,color FROM depannhome_client_sticky_notes WHERE owner_id=1 AND client_id='client-refresh-test'");
    assert.deepEqual(persisted.rows, [{ body: "Rappeler le client après actualisation", color: "red" }]);

    const refreshed = await fetch(`${baseUrl}/api/clients/client-refresh-test/sticky-notes`, { cache: "no-store" });
    assert.equal(refreshed.status, 200);
    assert.match(refreshed.headers.get("cache-control") || "", /no-store/);
    assert.deepEqual((await refreshed.json()).stickyNotes.map(note => ({ body: note.body, color: note.color })), [
        { body: "Rappeler le client après actualisation", color: "red" }
    ]);
});

test("la relecture après actualisation reste isolée par entreprise", { skip: !enabled }, async () => {
    const response = await fetch(`${baseUrl}/api/clients/client-refresh-test/sticky-notes`, { headers: { "X-Test-Owner": "2" }, cache: "no-store" });
    assert.equal(response.status, 404);
});
