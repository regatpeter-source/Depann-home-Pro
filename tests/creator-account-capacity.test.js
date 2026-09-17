import test from "node:test";
import assert from "node:assert/strict";
import { creatorCapacityForNewMember, ensureSeatAvailable, updateCreatorAccountCapacity } from "../server/creator.js";

test("le compte Créateur étend réellement sa capacité PC lorsque tous les postes sont occupés", () => {
    assert.deepEqual(creatorCapacityForNewMember({ maxPcUsers: 2, activePcUsers: 2 }, "admin"), { maxPcUsers: 3 });
    assert.deepEqual(creatorCapacityForNewMember({ maxPcUsers: 2, activePcUsers: 2 }, "pc_standard"), { maxPcUsers: 3 });
    assert.equal(creatorCapacityForNewMember({ maxPcUsers: 3, activePcUsers: 2 }, "admin"), null);
});

test("la capacité mobile gratuite du compte Créateur suit la même règle", () => {
    assert.deepEqual(creatorCapacityForNewMember({ maxMobileUsers: 0, activeMobileUsers: 0 }, "mobile_admin"), { maxMobileUsers: 1 });
    assert.deepEqual(creatorCapacityForNewMember({ maxMobileUsers: 1, activeMobileUsers: 1 }, "technician"), { maxMobileUsers: 2 });
    assert.equal(creatorCapacityForNewMember({ maxMobileUsers: 2, activeMobileUsers: 1 }, "technician"), null);
});

test("la création d'un poste Créateur plein augmente réellement max_pc_users dans la transaction", async () => {
    const updates = [];
    const database = {
        async query(sql, parameters) {
            if (sql.includes("SELECT max_pc_users")) return { rows: [{ maxPcUsers: 2, maxTechnicians: 0, subscriptionTier: "pro" }] };
            if (sql.includes("COUNT(DISTINCT member.id)")) return { rows: [{ maxPcUsers: 2, maxMobileUsers: 0, activePcUsers: 2, approvedPcDevices: 0, activeMobileUsers: 0 }] };
            if (sql.startsWith("UPDATE depannhome_users SET max_pc_users")) {
                updates.push({ sql, parameters });
                return { rows: [], rowCount: 1 };
            }
            throw new Error(`Requête inattendue: ${sql}`);
        }
    };

    await ensureSeatAvailable(database, 1, "pc_standard", { autoExpand: true });

    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].parameters, [1, 3]);
    assert.match(updates[0].sql, /max_pc_users=GREATEST\(max_pc_users,\$2\)/);
});

test("une entreprise cliente pleine conserve son erreur de limite", async () => {
    const database = {
        async query(sql) {
            if (sql.includes("SELECT max_pc_users")) return { rows: [{ maxPcUsers: 2, maxTechnicians: 0, subscriptionTier: "pro" }] };
            if (sql.includes("COUNT(DISTINCT member.id)")) return { rows: [{ maxPcUsers: 2, maxMobileUsers: 0, activePcUsers: 2, approvedPcDevices: 0, activeMobileUsers: 0 }] };
            throw new Error(`Requête inattendue: ${sql}`);
        }
    };

    await assert.rejects(() => ensureSeatAvailable(database, 7, "admin"), /LIMIT:La limite de postes administratifs est atteinte/);
});

test("la route dédiée enregistre les capacités Créateur sans valider la fiche entreprise", async () => {
    const calls = [];
    const connection = {
        async query(sql, parameters) {
            calls.push({ sql, parameters });
            if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
            if (sql.includes("SELECT id,max_pc_users")) return { rows: [{ id: 1, maxPcUsers: 2, maxTechnicians: 1 }] };
            if (sql.includes("COUNT(DISTINCT member.id)")) return { rows: [{ maxPcUsers: 2, maxMobileUsers: 1, activePcUsers: 3, approvedPcDevices: 0, activeMobileUsers: 2 }] };
            if (sql.startsWith("UPDATE depannhome_users SET max_pc_users")) return { rows: [{ maxPcUsers: 3, maxTechnicians: 2 }] };
            if (sql.startsWith("INSERT INTO depannhome_account_audit")) return { rows: [], rowCount: 1 };
            throw new Error(`Requête inattendue: ${sql}`);
        },
        release() { calls.push({ sql: "RELEASE" }); }
    };

    const capacity = await updateCreatorAccountCapacity({ async connect() { return connection; } }, 1, { maxPcUsers: 1, maxTechnicians: 0 });

    assert.deepEqual(capacity, { maxPcUsers: 3, maxTechnicians: 2 });
    const update = calls.find(call => call.sql.startsWith("UPDATE depannhome_users SET max_pc_users"));
    assert.deepEqual(update.parameters, [1, 3, 2]);
    const audit = calls.find(call => call.sql.startsWith("INSERT INTO depannhome_account_audit"));
    assert.equal(audit.parameters[2], "capacity_changed");
    assert.deepEqual(JSON.parse(audit.parameters[3]), { maxPcUsers: 2, maxTechnicians: 1 });
    assert.deepEqual(JSON.parse(audit.parameters[4]), { maxPcUsers: 3, maxTechnicians: 2 });
    assert.deepEqual(calls.slice(-2).map(call => call.sql), ["COMMIT", "RELEASE"]);
});
