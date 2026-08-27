import "dotenv/config";
import { getPool } from "../server/database.js";
import { migrationStatus, runMigrations } from "../server/database-migrations.js";

const command = process.argv[2] || "up";
const database = getPool();
try {
    if (command === "up") {
        const result = await runMigrations({ database });
        console.log(result.applied.length ? `${result.applied.length} migration(s) appliquée(s). Version ${result.currentVersion}.` : `Base à jour. Version ${result.currentVersion}.`);
    } else if (command === "status") {
        const status = await migrationStatus(database);
        console.table(status.map(item => ({ version: item.version, name: item.name, status: item.status, appliedAt: item.applied?.appliedAt || "" })));
        if (status.some(item => item.status === "pending")) process.exitCode = 2;
    } else {
        throw new Error("Commande inconnue. Utilisez « up » ou « status ». Les migrations sont irréversibles et forward-only.");
    }
} catch (error) {
    console.error("Migration impossible :", error.message);
    process.exitCode = 1;
} finally {
    await database.end();
}
