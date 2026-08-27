import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { postgresConnection, run, sha256File } from "./database-backup.js";

const backup = process.argv.find(argument => argument.endsWith(".dump"));
const confirmed = process.argv.includes("--confirm-restore");
const target = String(process.env.RESTORE_DATABASE_URL || "").trim();

try {
    if (!backup || !confirmed) throw new Error("Utilisez : npm run db:restore -- chemin.dump --confirm-restore");
    if (!target) throw new Error("RESTORE_DATABASE_URL est obligatoire et doit désigner explicitement la base cible.");
    if (target === String(process.env.DATABASE_URL || "").trim()) throw new Error("La restauration directe sur DATABASE_URL est refusée. Utilisez une base cible distincte puis effectuez la bascule contrôlée.");
    const resolved = path.resolve(backup);
    const manifest = JSON.parse(await readFile(`${resolved}.json`, "utf8"));
    const checksum = await sha256File(resolved);
    if (checksum !== manifest.sha256) throw new Error("Le checksum SHA-256 ne correspond pas au manifeste.");
    const connection = postgresConnection(target);
    await run(process.env.PG_RESTORE_COMMAND || "pg_restore", [...connection.args, "--clean", "--if-exists", "--no-owner", "--no-privileges", "--exit-on-error", resolved], { env: connection.env });
    console.log(`Restauration terminée et checksum vérifié : ${resolved}`);
} catch (error) {
    console.error("Restauration impossible :", error.message);
    process.exitCode = 1;
}
