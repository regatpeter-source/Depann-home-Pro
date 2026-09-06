import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPool } from "./database.js";

const MIGRATION_PATTERN = /^(\d{4})_([a-z0-9_-]+)\.sql$/i;
const MIGRATION_LOCK = 734_290_117;
const defaultDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "database", "migrations");
const LEGACY_MIGRATION_CHECKSUMS = new Map([
    [2, new Set([
        "478913d3dc6bca68eff852079ccc0d80b49cdf2ee6e701a492e03da1bd2dc514",
        "5f741958ac796af6863d52488751a08129a8c6992ad73efd43a6af75ff2413dc"
    ])],
    [8, new Set(["fb7105c5ab03393502af36f1b8bc7d825273982330c56a81cf5a1c751348847f"])],
    [9, new Set(["bf4dc579523467f3ae3ad47d09ac757448e4232900befe6ab586b76534148872"])]
]);

export async function loadMigrations(directory = defaultDirectory) {
    const names = (await readdir(directory)).filter(name => MIGRATION_PATTERN.test(name)).sort();
    const migrations = await Promise.all(names.map(async file => {
        const match = MIGRATION_PATTERN.exec(file);
        const sql = await readFile(path.join(directory, file), "utf8");
        return { version: Number(match[1]), name: match[2], file, sql, checksum: createHash("sha256").update(sql).digest("hex") };
    }));
    const versions = new Set();
    for (const migration of migrations) {
        if (versions.has(migration.version)) throw new Error(`Version de migration dupliquée : ${migration.version}.`);
        versions.add(migration.version);
    }
    return migrations;
}

export async function ensureMigrationTable(database = getPool()) {
    await database.query(`CREATE TABLE IF NOT EXISTS depannhome_schema_migrations (
        version INTEGER PRIMARY KEY CHECK(version > 0),
        name VARCHAR(160) NOT NULL,
        checksum CHAR(64) NOT NULL,
        execution_ms INTEGER NOT NULL DEFAULT 0,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
}

export async function migrationStatus(database = getPool(), directory = defaultDirectory) {
    await ensureMigrationTable(database);
    const [available, applied] = await Promise.all([
        loadMigrations(directory),
        database.query("SELECT version,name,checksum,execution_ms AS \"executionMs\",applied_at AS \"appliedAt\" FROM depannhome_schema_migrations ORDER BY version")
    ]);
    const appliedByVersion = new Map(applied.rows.map(item => [Number(item.version), item]));
    return available.map(item => ({ ...item, sql: undefined, status: appliedByVersion.has(item.version) ? "applied" : "pending", applied: appliedByVersion.get(item.version) || null }));
}

export async function runMigrations({ database = getPool(), directory = defaultDirectory, logger = console } = {}) {
    const connection = await database.connect();
    const applied = [];
    try {
        await connection.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
        await ensureMigrationTable(connection);
        const migrations = await loadMigrations(directory);
        const existing = await connection.query("SELECT version,name,checksum FROM depannhome_schema_migrations ORDER BY version");
        const byVersion = new Map(existing.rows.map(item => [Number(item.version), item]));
        for (const migration of migrations) {
            const previous = byVersion.get(migration.version);
            if (previous) {
                const checksumAccepted = previous.checksum === migration.checksum || LEGACY_MIGRATION_CHECKSUMS.get(migration.version)?.has(previous.checksum);
                if (!checksumAccepted || previous.name !== migration.name) throw new Error(`La migration ${migration.file} a été modifiée après application.`);
                continue;
            }
            const started = performance.now();
            await connection.query("BEGIN");
            try {
                await connection.query(migration.sql);
                const executionMs = Math.max(0, Math.round(performance.now() - started));
                await connection.query("INSERT INTO depannhome_schema_migrations(version,name,checksum,execution_ms) VALUES($1,$2,$3,$4)", [migration.version, migration.name, migration.checksum, executionMs]);
                await connection.query("COMMIT");
                applied.push({ version: migration.version, name: migration.name, executionMs });
                logger.info?.(`[migration] ${migration.file} appliquée en ${executionMs} ms.`);
            } catch (error) {
                await connection.query("ROLLBACK");
                throw error;
            }
        }
        return { applied, currentVersion: migrations.at(-1)?.version || 0 };
    } finally {
        await connection.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => {});
        connection.release();
    }
}
