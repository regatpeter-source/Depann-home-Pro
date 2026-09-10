import test from "node:test";
import assert from "node:assert/strict";
import { isFutureDateOnly, strictDateOnly } from "../server/date-validation.js";

test("la validation accepte uniquement des dates calendaires réelles", () => {
    assert.equal(strictDateOnly("2024-02-29"), "2024-02-29");
    assert.equal(strictDateOnly("2026-02-28"), "2026-02-28");
    for (const invalid of ["2026-02-29", "2026-02-30", "2026-02-31", "2026-04-31", "2026-13-01", "2026-00-10", "2026-01-00", "26-01-01", "2026-1-1"]) {
        assert.equal(strictDateOnly(invalid), "", invalid);
    }
});

test("la validation peut extraire explicitement la date d’un horodatage", () => {
    assert.equal(strictDateOnly("2024-02-29T18:45:00.000Z", { allowTimestamp: true }), "2024-02-29");
    assert.equal(strictDateOnly("2026-02-30T18:45:00.000Z", { allowTimestamp: true }), "");
    assert.equal(strictDateOnly("2024-02-29T18:45:00.000Z"), "");
});

test("la détection d’une date future utilise le jour civil local", () => {
    const today = new Date("2026-03-15T22:30:00.000Z");
    assert.equal(isFutureDateOnly("2026-03-15", today), false);
    assert.equal(isFutureDateOnly("2026-03-16", today), true);
    assert.equal(isFutureDateOnly("date invalide", today), false);
});

test("le jour civil français ne dépend pas du fuseau du serveur", () => {
    const afterFrenchMidnight = new Date("2026-03-15T23:30:00.000Z");
    assert.equal(isFutureDateOnly("2026-03-16", afterFrenchMidnight), false);
    assert.equal(isFutureDateOnly("2026-03-16", afterFrenchMidnight, "UTC"), true);
});
