import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { postgresConnection, run, sha256File } from "./database-backup.js";
import { assertSafeRestoreTarget } from "./restore-safety.js";

const backup = process.argv.find(argument => argument.endsWith(".dump"));
const confirmed = process.argv.includes("--confirm-restore");
const target = String(process.env.RESTORE_DATABASE_URL || "").trim();

try {
    if (!backup || !confirmed) throw new Error("Utilisez : npm run db:restore -- chemin.dump --confirm-restore");
    const resolved = path.resolve(backup);
    const manifest = JSON.parse(await readFile(`${resolved}.json`, "utf8"));
    const checksum = await sha256File(resolved);
    if (checksum !== manifest.sha256) throw new Error("Le checksum SHA-256 ne correspond pas au manifeste.");
    await assertSafeRestoreTarget({ sourceUrl: String(process.env.DATABASE_URL || "").trim(), targetUrl: target });
    const connection = postgresConnection(target);
    await run(process.env.PG_RESTORE_COMMAND || "pg_restore", [...connection.args, "--single-transaction", "--no-owner", "--no-privileges", "--exit-on-error", resolved], { env: connection.env });
    console.log(`Restauration terminée et checksum vérifié : ${resolved}`);
} catch (error) {
    console.error("Restauration impossible :", error.message);
    process.exitCode = 1;
}
