import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export function run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...options });
        let stderr = "";
        child.stderr.on("data", chunk => { stderr += chunk.toString(); });
        child.on("error", error => reject(new Error(`${command} indisponible : ${error.message}`)));
        child.on("close", code => code === 0 ? resolve() : reject(new Error(`${command} a échoué (${code}) : ${stderr.trim().slice(0, 1000)}`)));
    });
}

export async function sha256File(file) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest("hex");
}

export function postgresConnection(databaseUrl) {
    const url = new URL(databaseUrl);
    if (!/^postgres(?:ql)?:$/.test(url.protocol)) throw new Error("URL PostgreSQL invalide.");
    return {
        args: ["--host", url.hostname, "--port", url.port || "5432", "--username", decodeURIComponent(url.username), "--dbname", decodeURIComponent(url.pathname.slice(1))],
        env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password), PGSSLMODE: url.searchParams.get("sslmode") || (process.env.NODE_ENV === "production" ? "require" : "prefer") }
    };
}

export async function createBackup({ databaseUrl = process.env.DATABASE_URL, outputDirectory = process.env.DATABASE_BACKUP_PATH || "backups" } = {}) {
    if (!databaseUrl) throw new Error("DATABASE_URL est requise.");
    const directory = path.resolve(outputDirectory);
    await mkdir(directory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupId = randomUUID();
    const filename = `depannhome-${stamp}-${backupId.slice(0, 8)}.dump`;
    const target = path.join(directory, filename);
    const temporary = `${target}.partial`;
    try {
        const connection = postgresConnection(databaseUrl);
        await run(process.env.PG_DUMP_COMMAND || "pg_dump", [...connection.args, "--format=custom", "--compress=9", "--no-owner", "--no-privileges", "--file", temporary], { env: connection.env });
        await run(process.env.PG_RESTORE_COMMAND || "pg_restore", ["--list", temporary]);
        await rename(temporary, target);
        const metadata = { backupId, filename, createdAt: new Date().toISOString(), size: (await stat(target)).size, sha256: await sha256File(target), format: "postgresql-custom", verified: true };
        await writeFile(`${target}.json`, `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx" });
        return { path: target, metadata };
    } catch (error) {
        await rm(temporary, { force: true });
        throw error;
    }
}
