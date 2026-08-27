import { createBackup } from "./database-backup.js";
import { getPool } from "../server/database.js";
import { runMigrations } from "../server/database-migrations.js";

let database;
try {
    const result = await createBackup();
    database = getPool();
    await runMigrations({ database });
    await database.query(`INSERT INTO depannhome_backup_history(backup_id,filename,file_size,sha256,database_name,status,details)
        VALUES($1,$2,$3,$4,$5,'verified',$6::jsonb)`, [result.metadata.backupId, result.metadata.filename, result.metadata.size, result.metadata.sha256, new URL(process.env.DATABASE_URL).pathname.slice(1), JSON.stringify({ format: result.metadata.format })]);
    console.log(`Sauvegarde vérifiée : ${result.path}`);
    console.log(`SHA-256 : ${result.metadata.sha256}`);
} catch (error) {
    console.error("Sauvegarde impossible :", error.message);
    process.exitCode = 1;
} finally {
    if (database) await database.end();
}
