import test from "node:test";
import assert from "node:assert/strict";
import { allocateBillingNumber, formatBillingNumber } from "../server/billing-numbering.js";

test("formate les séries légales annuelles indépendantes", () => {
    assert.equal(formatBillingNumber("invoice", 2026, 1), "FAC-2026-000001");
    assert.equal(formatBillingNumber("invoice", 2027, 42), "FAC-2027-000042");
    assert.equal(formatBillingNumber("credit", 2026, 1), "AVO-2026-000001");
    assert.throws(() => formatBillingNumber("quote", 2026, 1), /invalide/);
    assert.throws(() => formatBillingNumber("invoice", 2026, 0), /invalide/);
});

test("alloue atomiquement par propriétaire, type et année", async () => {
    const calls = [];
    const database = {
        async query(sql, parameters) {
            calls.push({ sql, parameters });
            return { rows: [{ number: "7" }] };
        }
    };
    assert.equal(await allocateBillingNumber(database, 19, "credit", 2026), "AVO-2026-000007");
    assert.deepEqual(calls[0].parameters, [19, "credit", 2026]);
    assert.match(calls[0].sql, /INSERT INTO depannhome_billing_sequences/);
    assert.match(calls[0].sql, /ON CONFLICT \(owner_id, series_type, series_year\) DO UPDATE/);
    assert.match(calls[0].sql, /RETURNING last_number AS number/);
});
