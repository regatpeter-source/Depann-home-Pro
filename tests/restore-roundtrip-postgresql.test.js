import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { createBackup, sha256File } from "../scripts/database-backup.js";

const enabled = process.env.TEST_RESTORE_ROUND_TRIP === "1";
const binDirectory = process.env.TEST_POSTGRES_BIN_DIRECTORY || "";
const execute = promisify(execFile);
const binary = name => path.join(binDirectory, `${name}${process.platform === "win32" ? ".exe" : ""}`);
const restoreScript = fileURLToPath(new URL("../scripts/restore.js", import.meta.url));

async function unusedPort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return port;
}

function controlCluster(arguments_, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(binary("pg_ctl"), arguments_, { env, stdio: "ignore", windowsHide: true });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            if (code === 0) resolve();
            else reject(Object.assign(new Error(`pg_ctl a échoué (${code ?? signal}).`), { code }));
        });
    });
}

test("sauvegarde et restauration réelles sur un serveur PostgreSQL temporaire isolé", { skip: !enabled, timeout: 90000 }, async () => {
    if (!binDirectory || !path.isAbsolute(binDirectory)) throw new Error("TEST_POSTGRES_BIN_DIRECTORY doit être un chemin absolu vers les exécutables PostgreSQL.");
    const directory = await mkdtemp(path.join(os.tmpdir(), "depannhome-restore-roundtrip-"));
    const dataDirectory = path.join(directory, "cluster");
    const logFile = path.join(directory, "postgres.log");
    const passwordFile = path.join(directory, "password");
    const password = randomBytes(32).toString("base64url");
    let port;
    const connection = name => `postgresql://restore_fixture:${encodeURIComponent(password)}@127.0.0.1:${port}/${name}?sslmode=disable`;
    const commandEnvironment = { ...process.env, PGOPTIONS: "", PGSSLMODE: "disable", PGPASSWORD: password, PGCONNECT_TIMEOUT: "5" };
    const previousDump = process.env.PG_DUMP_COMMAND;
    const previousRestore = process.env.PG_RESTORE_COMMAND;
    const previousOptions = process.env.PGOPTIONS;
    let startAttempted = false;
    try {
        process.env.PGOPTIONS = "";
        port = await unusedPort();
        await writeFile(passwordFile, password, { flag: "wx", mode: 0o600 });
        await execute(binary("initdb"), ["-D", dataDirectory, "-U", "restore_fixture", "--auth=scram-sha-256", `--pwfile=${passwordFile}`, "--encoding=UTF8", "--locale=C"], { env: commandEnvironment });
        startAttempted = true;
        await controlCluster(["-D", dataDirectory, "-l", logFile, "-o", `-h 127.0.0.1 -p ${port}`, "-t", "20", "-w", "start"], commandEnvironment);
        const admin = new pg.Client({ connectionString: connection("postgres") });
        await admin.connect();
        try {
            await admin.query("CREATE DATABASE restore_fixture_source");
            await admin.query("CREATE DATABASE restore_fixture_target");
            await admin.query("CREATE DATABASE restore_fixture_failure");
        } finally { await admin.end(); }

        const source = new pg.Client({ connectionString: connection("restore_fixture_source") });
        await source.connect();
        try {
            await source.query(`CREATE TABLE public.smoke(id INTEGER PRIMARY KEY, label TEXT NOT NULL);
                INSERT INTO public.smoke VALUES(1,'preuve de restauration'),(2,'données fictives');
                CREATE TABLE public.omitted(id INTEGER PRIMARY KEY);
                CREATE VIEW public.zzz_broken_without_omitted AS SELECT id FROM public.omitted`);
        } finally { await source.end(); }

        process.env.PG_DUMP_COMMAND = binary("pg_dump");
        process.env.PG_RESTORE_COMMAND = binary("pg_restore");
        const backup = await createBackup({ databaseUrl: connection("restore_fixture_source"), outputDirectory: directory });
        const manifest = JSON.parse(await readFile(`${backup.path}.json`, "utf8"));
        assert.equal(manifest.sha256, await sha256File(backup.path));

        const restoreEnvironment = {
            ...commandEnvironment,
            DATABASE_URL: connection("restore_fixture_source"),
            RESTORE_DATABASE_URL: connection("restore_fixture_target"),
            PG_RESTORE_COMMAND: binary("pg_restore")
        };
        await assert.rejects(execute(process.execPath, [restoreScript, backup.path], { env: restoreEnvironment }), error => error.code === 1 && /--confirm-restore/.test(error.stderr));
        await assert.rejects(execute(process.execPath, [restoreScript, backup.path, "--confirm-restore"], {
            env: { ...restoreEnvironment, RESTORE_DATABASE_URL: connection("restore_fixture_source") }
        }), error => error.code === 1 && /même nom de base/.test(error.stderr));
        const badDump = path.join(directory, "bad-checksum.dump");
        await copyFile(backup.path, badDump);
        await writeFile(`${badDump}.json`, JSON.stringify({ sha256: "0".repeat(64) }));
        await assert.rejects(execute(process.execPath, [restoreScript, badDump, "--confirm-restore"], { env: restoreEnvironment }), error => error.code === 1 && /checksum SHA-256/.test(error.stderr));
        const emptyTarget = new pg.Client({ connectionString: connection("restore_fixture_target") });
        await emptyTarget.connect();
        try {
            assert.equal((await emptyTarget.query("SELECT to_regclass('public.smoke') AS table_name")).rows[0].table_name, null);
        } finally { await emptyTarget.end(); }

        const result = await execute(process.execPath, [restoreScript, backup.path, "--confirm-restore"], { env: restoreEnvironment });
        assert.match(result.stdout, /Restauration terminée/);
        const target = new pg.Client({ connectionString: connection("restore_fixture_target") });
        await target.connect();
        try {
            const rows = await target.query("SELECT id,label FROM public.smoke ORDER BY id");
            assert.deepEqual(rows.rows, [{ id: 1, label: "preuve de restauration" }, { id: 2, label: "données fictives" }]);
            await assert.rejects(execute(process.execPath, [restoreScript, backup.path, "--confirm-restore"], { env: restoreEnvironment }), error => error.code === 1 && /cible n’est pas vide/.test(error.stderr));
            assert.equal((await target.query("SELECT COUNT(*)::int AS count FROM public.smoke")).rows[0].count, 2);
        } finally { await target.end(); }

        const partialDump = path.join(directory, "partial.dump");
        await execute(binary("pg_dump"), ["--host", "127.0.0.1", "--port", String(port), "--username", "restore_fixture", "--dbname", "restore_fixture_source", "--format=custom", "--no-owner", "--no-privileges", "--table=public.smoke", "--table=public.zzz_broken_without_omitted", "--file", partialDump], { env: commandEnvironment });
        const archiveList = (await execute(binary("pg_restore"), ["--list", partialDump], { env: commandEnvironment })).stdout;
        const tablePosition = archiveList.indexOf("TABLE public smoke");
        const viewPosition = archiveList.indexOf("VIEW public zzz_broken_without_omitted");
        assert.ok(tablePosition >= 0 && viewPosition > tablePosition, `L’archive doit tenter de créer la table avant la vue en échec : ${archiveList.split("\n").filter(line => /smoke|broken_without_omitted/.test(line)).join(" | ")}`);
        await writeFile(`${partialDump}.json`, JSON.stringify({ sha256: await sha256File(partialDump) }));
        await assert.rejects(execute(process.execPath, [restoreScript, partialDump, "--confirm-restore"], {
            env: { ...restoreEnvironment, RESTORE_DATABASE_URL: connection("restore_fixture_failure") }
        }), error => error.code === 1 && /omitted/i.test(error.stderr));
        const failureTarget = new pg.Client({ connectionString: connection("restore_fixture_failure") });
        await failureTarget.connect();
        try {
            const { rows } = await failureTarget.query("SELECT to_regclass('public.smoke') AS table_name");
            assert.equal(rows[0].table_name, null);
        } finally { await failureTarget.end(); }
    } finally {
        if (previousDump === undefined) delete process.env.PG_DUMP_COMMAND; else process.env.PG_DUMP_COMMAND = previousDump;
        if (previousRestore === undefined) delete process.env.PG_RESTORE_COMMAND; else process.env.PG_RESTORE_COMMAND = previousRestore;
        if (previousOptions === undefined) delete process.env.PGOPTIONS; else process.env.PGOPTIONS = previousOptions;
        if (startAttempted) {
            let running = true;
            try { await controlCluster(["-D", dataDirectory, "status"], commandEnvironment); }
            catch (error) { if (error.code !== 3) throw error; running = false; }
            if (running) await controlCluster(["-D", dataDirectory, "-m", "fast", "-t", "20", "-w", "stop"], commandEnvironment);
        }
        await rm(directory, { recursive: true, force: true });
    }
});
