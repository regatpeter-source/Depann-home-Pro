import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deleteOperationalHistory, normalizeHistoryDeletion } from "../server/history.js";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const server = read("server/history.js");
const client = read("js/history.js");
const migration = read("database/migrations/0023_history_deletion_audit.sql");
const schema = read("database/schema.sql");

test("seuls les journaux opérationnels peuvent être supprimés", () => {
    for (const category of ["imports", "clients", "operations", "partners"]) {
        assert.equal(normalizeHistoryDeletion({ mode: "filtered", category, dateFrom: "2026-01-01", dateTo: "2026-01-31", reason: "Nettoyage périodique" }).ok, true);
    }
    for (const category of ["account", "subscription", "members", "accounting", "group"]) {
        const result = normalizeHistoryDeletion({ mode: "filtered", category, dateFrom: "2026-01-01", dateTo: "2026-01-31", reason: "Nettoyage périodique" });
        assert.equal(result.ok, false);
        assert.match(result.message, /légales|sécurité/);
    }
});

test("la suppression sélectionnée refuse les identifiants de sources protégées", () => {
    const deletion = normalizeHistoryDeletion({ mode: "selected", items: ["account:1", "member:2", "client:3", "collaboration:4"], reason: "Nettoyage demandé" });
    assert.equal(deletion.ok, true);
    assert.deepEqual(deletion.items, [{ source: "client", id: 3 }, { source: "collaboration", id: 4 }]);
    assert.equal(normalizeHistoryDeletion({ mode: "selected", items: ["account:1"], reason: "Nettoyage demandé" }).ok, false);
});

test("la suppression exige un motif et une période valides", () => {
    assert.equal(normalizeHistoryDeletion({ mode: "selected", items: ["client:1"], reason: "court" }).ok, false);
    assert.equal(normalizeHistoryDeletion({ mode: "filtered", category: "clients", dateFrom: "2026-02-10", dateTo: "2026-02-01", reason: "Nettoyage périodique" }).ok, false);
});

test("la suppression est isolée par entreprise, transactionnelle et laisse un reçu minimal", async () => {
    const calls = [];
    const connection = {
        async query(sql, parameters = []) {
            calls.push({ sql, parameters });
            if (sql.startsWith("DELETE FROM depannhome_client_lifecycle_audit")) return { rowCount: 2 };
            return { rowCount: 0 };
        },
        release() { calls.push({ sql: "RELEASE", parameters: [] }); }
    };
    const result = await deleteOperationalHistory(42, 7, { mode: "selected", items: [{ source: "client", id: 8 }, { source: "client", id: 9 }], reason: "Nettoyage périodique" }, { async connect() { return connection; } });
    assert.equal(result.deletedCount, 2);
    assert.equal(calls[0].sql, "BEGIN");
    assert.equal(calls[1].sql, "DELETE FROM depannhome_client_lifecycle_audit WHERE owner_id=$1 AND id=ANY($2::bigint[])");
    assert.match(calls[2].sql, /INSERT INTO depannhome_history_deletion_audit/);
    assert.deepEqual(calls.slice(3).map(call => call.sql), ["COMMIT", "RELEASE"]);
    assert.deepEqual(calls[1].parameters, [42, [8, 9]]);
    assert.doesNotMatch(calls[2].sql, /details|payload|deleted_ids/);
});

test("la route reste réservée à l’administration et l’interface avertit avant suppression", () => {
    assert.match(server, /app\.post\("\/api\/history\/delete", requireAuthentication/);
    assert.match(server, /if \(!isCompanyAdministrator\(request\)\)/);
    assert.match(client, /Supprimer la sélection/);
    assert.match(client, /Suppression définitive/);
    assert.match(client, /Cette action est irréversible/);
    assert.match(client, /10 caractères minimum/);
});

test("la migration et le schéma conservent le reçu sans contenu supprimé", () => {
    for (const source of [migration, schema]) {
        const definition = source.slice(source.indexOf("CREATE TABLE IF NOT EXISTS depannhome_history_deletion_audit"), source.indexOf(";", source.indexOf("CREATE TABLE IF NOT EXISTS depannhome_history_deletion_audit")));
        assert.match(definition, /CREATE TABLE IF NOT EXISTS depannhome_history_deletion_audit/);
        assert.match(definition, /deleted_count INTEGER/);
        assert.match(definition, /reason VARCHAR\(500\)/);
        assert.doesNotMatch(definition, /deleted_ids|deleted_content|payload/);
    }
});
