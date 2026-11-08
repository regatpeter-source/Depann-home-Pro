import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import dotenv from "dotenv";
import pg from "pg";
import { offlineIdempotent } from "../server/offline-idempotency.js";

dotenv.config({ path: fileURLToPath(new URL("../.env.test.local", import.meta.url)) });
const databaseUrl = String(process.env.TEST_DATABASE_URL || "");
const enabled = Boolean(databaseUrl);
const schema = `test_offline_retry_${process.pid}_${Date.now()}`;
let administration;
let database;
let server;
let baseUrl;
let attempts = 0;
let effects = 0;

before(async () => {
    if (!enabled) return;
    if (!/test/i.test(new URL(databaseUrl).pathname)) throw new Error("TEST_DATABASE_URL doit désigner une base de test.");
    administration = new pg.Pool({ connectionString: databaseUrl });
    await administration.query(`CREATE SCHEMA ${schema}`);
    database = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await database.query(`SET search_path TO ${schema}`);
    await database.query(`CREATE TABLE depannhome_offline_operations (
        owner_id BIGINT NOT NULL, user_id BIGINT NOT NULL, operation_id UUID NOT NULL, method TEXT, path TEXT,
        response_status INTEGER, response_type TEXT, response_body TEXT, completed_at TIMESTAMPTZ,
        PRIMARY KEY(owner_id,user_id,operation_id)
    )`);
    const app = express();
    app.use((request, _response, next) => { request.user = { sub: "10", accountOwnerId: "1" }; next(); });
    app.post("/test", offlineIdempotent(async (_request, response) => {
        attempts += 1;
        if (attempts === 1) return response.status(409).json({ message: "Conflit temporaire." });
        effects += 1;
        return response.status(201).json({ id: 42 });
    }, { databaseProvider: () => database }));
    app.use((error, _request, response, _next) => response.status(500).json({ message: error.message }));
    server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    if (!enabled) return;
    if (server) await new Promise(resolve => server.close(resolve));
    if (database) await database.end();
    if (administration) {
        await administration.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await administration.end();
    }
});

test("PostgreSQL : un conflit corrigé peut être retenté puis le succès est dédupliqué", { skip: !enabled }, async () => {
    const headers = { "X-DepannHome-Offline-Operation": randomUUID(), "X-DepannHome-Offline-Scope": "1:mobile:10" };
    const first = await fetch(`${baseUrl}/test`, { method: "POST", headers });
    assert.equal(first.status, 409);
    const second = await fetch(`${baseUrl}/test`, { method: "POST", headers });
    assert.equal(second.status, 201);
    assert.deepEqual(await second.json(), { id: 42 });
    const third = await fetch(`${baseUrl}/test`, { method: "POST", headers });
    assert.equal(third.status, 201);
    assert.equal(third.headers.get("X-DepannHome-Offline-Replayed"), "true");
    assert.deepEqual(await third.json(), { id: 42 });
    assert.equal(attempts, 2);
    assert.equal(effects, 1);
});

test("PostgreSQL : une ancienne réponse de conflit ne peut être réinitialisée que par une reprise explicite", { skip: !enabled }, async () => {
    const operationId = randomUUID();
    await database.query(`INSERT INTO depannhome_offline_operations(owner_id,user_id,operation_id,method,path,response_status,response_type,response_body,completed_at)
        VALUES(1,10,$1,'POST','/test',409,'application/json','{"message":"Ancien conflit"}',NOW())`, [operationId]);
    const headers = { "X-DepannHome-Offline-Operation": operationId, "X-DepannHome-Offline-Scope": "1:mobile:10" };
    const automatic = await fetch(`${baseUrl}/test`, { method: "POST", headers });
    assert.equal(automatic.status, 409);
    assert.equal(automatic.headers.get("X-DepannHome-Offline-Replayed"), "true");
    const retried = await fetch(`${baseUrl}/test`, { method: "POST", headers: { ...headers, "X-DepannHome-Offline-Retry": "true" } });
    assert.equal(retried.status, 201);
    assert.deepEqual(await retried.json(), { id: 42 });
    assert.equal(attempts, 3);
    assert.equal(effects, 2);
});
