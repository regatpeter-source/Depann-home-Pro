import test from "node:test";
import assert from "node:assert/strict";
import { createOrganization, normalizeOrganizationHistory, updateOrganization } from "../server/organizations.js";

function organizationRow(overrides = {}) {
    return { id: 8, accountOwnerId: 24, interfaceType: "standard", organizationType: "troubleshooting_company", licenseType: "depannhome_standard", licenseFeatures: {}, subscriptionTier: "pro", ...overrides };
}

test("un upsert sur une organisation existante est audité comme mise à jour", async () => {
    const audits = [];
    let organizationReads = 0;
    const database = {
        async query(sql, parameters) {
            if (sql.includes("FROM depannhome_organizations organization JOIN")) {
                organizationReads += 1;
                return { rows: [organizationRow()] };
            }
            if (sql.startsWith("INSERT INTO depannhome_organizations")) return { rows: [organizationRow({ interfaceType: "group", licenseType: "depannhome_group" })] };
            if (sql.startsWith("SELECT subscription_tier")) return { rows: [{ subscriptionTier: "pro" }] };
            if (sql.startsWith("INSERT INTO depannhome_organization_audit")) { audits.push(parameters); return { rows: [] }; }
            throw new Error(`Requête inattendue: ${sql}`);
        }
    };

    await createOrganization(24, { interfaceType: "group", licenseType: "depannhome_group" }, 1, database);

    assert.equal(organizationReads, 1);
    assert.equal(audits.length, 1);
    assert.equal(audits[0][2], "updated");
    assert.equal(JSON.parse(audits[0][3]).interfaceType, "standard");
    assert.equal(JSON.parse(audits[0][4]).interfaceType, "group");
});

test("un enregistrement explicite d'une fiche existante écrit Organisation mise à jour", async () => {
    const audits = [];
    let reads = 0;
    const database = {
        async query(sql, parameters) {
            if (sql.includes("FROM depannhome_organizations organization JOIN")) { reads += 1; return { rows: [organizationRow()] }; }
            if (sql.startsWith("INSERT INTO depannhome_organizations")) return { rows: [organizationRow()] };
            if (sql.startsWith("SELECT subscription_tier")) return { rows: [{ subscriptionTier: "pro" }] };
            if (sql.startsWith("INSERT INTO depannhome_organization_audit")) { audits.push(parameters); return { rows: [] }; }
            throw new Error(`Requête inattendue: ${sql}`);
        }
    };

    await updateOrganization(24, { interfaceType: "standard", organizationType: "troubleshooting_company", licenseType: "depannhome_standard" }, 1, database);

    assert.equal(reads, 1);
    assert.equal(audits.length, 1);
    assert.equal(audits[0][2], "updated");
});

test("les anciens doublons created sont affichés comme updated sauf la création initiale", () => {
    const history = normalizeOrganizationHistory([
        { id: 3, action: "created" },
        { id: 2, action: "created" },
        { id: 1, action: "created" }
    ]);
    assert.deepEqual(history.map(entry => entry.action), ["updated", "updated", "created"]);
});