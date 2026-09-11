import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { companySeatState, groupSeatStatus } from "../server/seat-limits.js";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const migration = read("database/migrations/0015_group_seat_allocations.sql");
const billingLabelMigration = read("database/migrations/0016_group_billing_labels.sql");
const schema = read("database/schema.sql");
const groups = read("server/groups.js");
const auth = read("server/auth.js");
const creator = read("server/creator.js");
const creatorClient = read("js/creator.js");
const groupsClient = read("js/groups.js");
const invoicing = read("server/invoicing.js");

function result(rows) { return { rows, rowCount: rows.length }; }

test("les allocations de groupe sont séparées de l’enveloppe facturée", () => {
    for (const source of [migration, schema]) {
        assert.match(source, /depannhome_group_entitlements/);
        assert.match(source, /principal_company_owner_id/);
        assert.match(source, /max_companies/);
        assert.match(source, /depannhome_group_company_seat_allocations/);
        assert.match(source, /allocated_pc_seats/);
        assert.match(source, /allocated_mobile_seats/);
    }
    assert.match(migration, /CHECK\(max_group_companies BETWEEN 1 AND 100\)/);
    assert.match(migration, /La répartition dépasse l’enveloppe de postes du groupe/);
    assert.match(groups, /subscription_plan='free'.*monthly_price_cents=0/);
    assert.match(invoicing, /owner\.subscription_plan = 'paid'/);
    assert.match(invoicing, /entitlement\.principal_company_owner_id<>owner\.id/);
});

test("les contrôles de postes utilisent la limite effective de la société active", async () => {
    const database = {
        async query(sql, values) {
            assert.match(sql, /COALESCE\(allocation\.allocated_pc_seats,owner\.max_pc_users\)/);
            assert.match(sql, /COALESCE\(allocation\.allocated_mobile_seats,owner\.max_technicians\)/);
            assert.deepEqual(values, [42, 0, ""]);
            return result([{ maxPcUsers: 3, maxMobileUsers: 7, activePcUsers: 2, approvedPcDevices: 2, activeMobileUsers: 4 }]);
        }
    };
    assert.deepEqual(await companySeatState(database, 42), { maxPcUsers: 3, maxMobileUsers: 7, activePcUsers: 2, approvedPcDevices: 2, activeMobileUsers: 4 });
    assert.match(auth, /companySeatState\(database, ownerId, excludedMemberId\)/);
    assert.match(auth, /companySeatState\(getPool\(\), getAccountOwnerId\(request\), 0, deviceId\)/);
});

test("le statut de groupe calcule les quotas disponibles, entreprise principale incluse", async () => {
    let calls = 0;
    const database = {
        async query(sql) {
            calls += 1;
            if (sql.includes("FROM depannhome_group_entitlements entitlement")) return result([
                { principalCompanyId: 10, maxCompanies: 3, totalPcSeats: 8, totalMobileSeats: 12, companyId: 10, companyName: "Principale", isActive: true, allocatedPcSeats: 3, allocatedMobileSeats: 4 },
                { principalCompanyId: 10, maxCompanies: 3, totalPcSeats: 8, totalMobileSeats: 12, companyId: 11, companyName: "Agence", isActive: true, allocatedPcSeats: 2, allocatedMobileSeats: 5 }
            ]);
            return result([{ maxPcUsers: 3, maxMobileUsers: 5, activePcUsers: 1, approvedPcDevices: 1, activeMobileUsers: 1 }]);
        }
    };
    const seats = await groupSeatStatus(database, 5);
    assert.equal(calls, 3);
    assert.equal(seats.companyCount, 2);
    assert.equal(seats.availableCompanies, 1);
    assert.equal(seats.availablePcSeats, 3);
    assert.equal(seats.availableMobileSeats, 3);
    assert.equal(seats.companies[0].isPrincipal, true);
});

test("les routes refusent les dépassements et les réductions sous l’usage actif", () => {
    assert.match(groups, /seats\.companyCount >= seats\.maxCompanies/);
    assert.match(groups, /input\.allocatedPcSeats > seats\.availablePcSeats/);
    assert.match(groups, /allocatedPcSeats < requiredPcSeats/);
    assert.match(groups, /allocatedMobileSeats < Number\(usage\?\.activeMobileUsers/);
    assert.match(groups, /app\.get\("\/api\/groups\/seat-status"/);
});

test("le Créateur attribue le nombre de sociétés et les totaux du groupe principal", () => {
    assert.match(creator, /maxGroupCompanies/);
    assert.match(creator, /configurePrincipalGroup/);
    assert.match(creator, /grouped_entitlement\.principal_company_owner_id<>owner\.id/);
    assert.match(creatorClient, /Nombre maximum d’entreprises \(principale incluse\)/);
    assert.match(creatorClient, /Postes PC pour tout le groupe/);
    assert.match(creator, /Groupe — abonnement global facturé à l’entreprise principale/);
    assert.match(groups, /Groupe — abonnement global facturé à l’entreprise principale/);
    assert.match(billingLabelMigration, /Groupe — abonnement global facturé à l’entreprise principale/);
    assert.match(groupsClient, /Enveloppe attribuée par le Créateur/);
    assert.match(groupsClient, /group_seats_rebalanced/);
});
