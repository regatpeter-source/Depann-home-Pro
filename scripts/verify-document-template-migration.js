import "dotenv/config";
import { getPool, initializeDatabase } from "../server/database.js";
import { initializeBilling } from "../server/billing.js";
import { initializeDocumentTemplates } from "../server/document-templates.js";

try {
    await initializeDatabase();
    await initializeBilling();
    await initializeDocumentTemplates();
    const table = await getPool().query("SELECT to_regclass('public.depannhome_document_templates') AS name");
    const indexes = await getPool().query("SELECT indexname FROM pg_indexes WHERE tablename='depannhome_document_templates' ORDER BY indexname");
    if (!table.rows[0]?.name) throw new Error("La table des modèles personnalisés est absente.");
    if (!indexes.rows.some(row => row.indexname === "depannhome_document_templates_active_idx")) throw new Error("L’index d’unicité du modèle actif est absent.");
    console.log(JSON.stringify({ table: table.rows[0].name, indexes: indexes.rows.map(row => row.indexname) }));
} finally {
    await getPool().end();
}
