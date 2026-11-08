import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import dotenv from "dotenv";
import pg from "pg";
import { assertSafeRestoreTarget } from "../scripts/restore-safety.js";

const sourceUrl = "postgresql://test:password@source.test/original?sslmode=disable";
const targetUrl = "postgresql://test:password@target.test/recovery?sslmode=disable";

function fakeClients({ sourceName = "original", targetName = "recovery", occupied = false, failTarget = false } = {}) {
    const calls = [];
    return {
        calls,
        createClient(_config, role) {
            return {
                async connect() { calls.push(`${role}:connect`); if (role === "target" && failTarget) throw new Error("Connexion refusée"); },
                async query(sql) {
                    calls.push(`${role}:${sql.includes("current_database()") ? "identity" : "objects"}`);
                    return { rows: [sql.includes("current_database()") ? { name: role === "source" ? sourceName : targetName } : { occupied }] };
                },
                async end() { calls.push(`${role}:end`); }
            };
        }
    };
}

test("la restauration exige une source, une cible différente et une cible vide", async () => {
    const safe = fakeClients();
    await assertSafeRestoreTarget({ sourceUrl, targetUrl, createClient: safe.createClient });
    assert.ok(safe.calls.includes("target:objects"));
    assert.ok(safe.calls.includes("source:end"));
    assert.ok(safe.calls.includes("target:end"));

    await assert.rejects(assertSafeRestoreTarget({ sourceUrl: "", targetUrl, createClient: safe.createClient }), /DATABASE_URL est obligatoire/);
    await assert.rejects(assertSafeRestoreTarget({ sourceUrl, targetUrl: "", createClient: safe.createClient }), /RESTORE_DATABASE_URL est obligatoire/);
    const nonempty = fakeClients({ occupied: true });
    await assert.rejects(assertSafeRestoreTarget({ sourceUrl, targetUrl, createClient: nonempty.createClient }), /cible n’est pas vide/);
    assert.ok(nonempty.calls.includes("target:end"));
});

test("deux URL différentes désignant le même nom réel de base sont refusées", async () => {
    const clients = fakeClients({ targetName: "original" });
    await assert.rejects(assertSafeRestoreTarget({ sourceUrl, targetUrl, createClient: clients.createClient }), /même nom de base/);
    assert.equal(clients.calls.includes("target:objects"), false);
    assert.ok(clients.calls.includes("source:end"));
    assert.ok(clients.calls.includes("target:end"));
});

test("un échec de connexion ferme la source et empêche la restauration", async () => {
    const clients = fakeClients({ failTarget: true });
    await assert.rejects(assertSafeRestoreTarget({ sourceUrl, targetUrl, createClient: clients.createClient }), /Connexion refusée/);
    assert.ok(clients.calls.includes("source:end"));
    assert.equal(clients.calls.includes("target:objects"), false);
});

test("les paramètres de connexion non pris en charge sont refusés avant toute connexion", async () => {
    const clients = fakeClients();
    await assert.rejects(assertSafeRestoreTarget({ sourceUrl, targetUrl: `${targetUrl}&host=other.test`, createClient: clients.createClient }), /que le paramètre sslmode/);
    assert.deepEqual(clients.calls, []);
});

test("sslmode=prefer reprend sans TLS uniquement si le serveur ne prend pas SSL en charge", async () => {
    const modes = [];
    const createClient = (config, role) => {
        const mode = new URL(config.connectionString).searchParams.get("sslmode");
        modes.push(`${role}:${mode}`);
        return {
            async connect() { if (role === "source" && mode === "prefer") throw new Error("The server does not support SSL connections"); },
            async query(sql) { return { rows: [sql.includes("current_database()") ? { name: role === "source" ? "original" : "recovery" } : { occupied: false }] }; },
            async end() {}
        };
    };
    await assertSafeRestoreTarget({ sourceUrl: sourceUrl.replace("sslmode=disable", "sslmode=prefer"), targetUrl, createClient });
    assert.deepEqual(modes, ["source:prefer", "source:disable", "target:disable"]);
});

dotenv.config({ path: fileURLToPath(new URL("../.env.test.local", import.meta.url)) });
const configuredTestUrl = String(process.env.TEST_DATABASE_URL || "");
const databaseUrl = configuredTestUrl ? (() => {
    const url = new URL(configuredTestUrl);
    if (!url.searchParams.has("sslmode")) url.searchParams.set("sslmode", "disable");
    return url.toString();
})() : "";
const enabled = Boolean(databaseUrl);

test("PostgreSQL : le contrôle détecte une base source et cible identique", { skip: !enabled }, async () => {
    if (!/test/i.test(new URL(databaseUrl).pathname)) throw new Error("TEST_DATABASE_URL doit désigner une base de test.");
    await assert.rejects(assertSafeRestoreTarget({ sourceUrl: databaseUrl, targetUrl: databaseUrl }), /même nom de base/);
});

test("PostgreSQL : un schéma utilisateur rend la cible non vide", { skip: !enabled }, async () => {
    if (!/test/i.test(new URL(databaseUrl).pathname)) throw new Error("TEST_DATABASE_URL doit désigner une base de test.");
    const admin = new pg.Client({ connectionString: databaseUrl });
    const schema = `test_restore_safety_${process.pid}_${Date.now()}`;
    await admin.connect();
    try {
        await admin.query(`CREATE SCHEMA ${schema}`);
        const createClient = (config, role) => role === "target" ? new pg.Client(config) : {
            async connect() {},
            async query() { return { rows: [{ name: "other_database" }] }; },
            async end() {}
        };
        await assert.rejects(assertSafeRestoreTarget({ sourceUrl: databaseUrl, targetUrl: databaseUrl, createClient }), /cible n’est pas vide/);
    } finally {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema}`);
        await admin.end();
    }
});

test("la commande de restauration s’arrête avant pg_restore si la cible est la source", { skip: !enabled }, async () => {
    if (!/test/i.test(new URL(databaseUrl).pathname)) throw new Error("TEST_DATABASE_URL doit désigner une base de test.");
    const directory = await mkdtemp(path.join(os.tmpdir(), "depannhome-restore-test-"));
    const dump = path.join(directory, "fixture.dump");
    const manifest = `${dump}.json`;
    try {
        const content = Buffer.from("archive de test non restaurable");
        await writeFile(dump, content);
        await writeFile(manifest, JSON.stringify({ sha256: createHash("sha256").update(content).digest("hex") }));
        const execute = promisify(execFile);
        await assert.rejects(execute(process.execPath, [fileURLToPath(new URL("../scripts/restore.js", import.meta.url)), dump, "--confirm-restore"], {
            env: { ...process.env, DATABASE_URL: databaseUrl, RESTORE_DATABASE_URL: databaseUrl, PG_RESTORE_COMMAND: process.execPath }
        }), error => error.code === 1 && /même nom de base/.test(error.stderr));
    } finally {
        await rm(dump, { force: true });
        await rm(manifest, { force: true });
        await rmdir(directory);
    }
});
