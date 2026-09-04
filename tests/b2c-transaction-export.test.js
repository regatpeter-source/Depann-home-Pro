import test from "node:test";
import assert from "node:assert/strict";
import { buildB2cReportCsv, buildB2cReportPayload } from "../server/b2c-transaction-export.js";

const invoice = (overrides = {}) => ({
    id: 1,
    issueDate: "2026-03-10",
    operationCategory: "services",
    lines: [{ quantity: 1, unitPrice: 100, vatRate: 20 }],
    financialData: {},
    ...overrides
});

test("B2C transactions are aggregated by day and VAT rate", () => {
    const payload = buildB2cReportPayload({
        documents: [invoice(), invoice({ id: 2, lines: [{ quantity: 2, unitPrice: 50, vatRate: 20 }] })],
        settlements: [],
        periodStart: "2026-03-01",
        periodEnd: "2026-03-31",
        generatedAt: "2026-04-01T00:00:00.000Z"
    });
    assert.equal(payload.status, "prepared_local");
    assert.equal(payload.transmissionStatus, "not_transmitted");
    assert.equal(payload.transactions.length, 1);
    assert.deepEqual(payload.transactions[0], { kind: "transaction", date: "2026-03-10", vatRate: 20, amountHt: 200, vatAmount: 40, amountTtc: 240, operationCount: 2, sourceCount: 2, sourceIds: [1, 2] });
});

test("B2C preparation allocates discounts and service collections by VAT rate", () => {
    const payload = buildB2cReportPayload({
        documents: [invoice({
            lines: [{ quantity: 1, unitPrice: 100, vatRate: 20 }, { quantity: 1, unitPrice: 50, vatRate: 10 }],
            financialData: { discountMode: "fixed", discountAmount: 15 }
        })],
        settlements: [{ id: 10, documentId: 1, date: "2026-03-12", amount: 162 }],
        vatOnDebits: false,
        periodStart: "2026-03-01",
        periodEnd: "2026-03-31"
    });
    assert.deepEqual(payload.transactions.map(row => [row.vatRate, row.amountHt, row.vatAmount, row.amountTtc]), [[10, 45, 4.5, 49.5], [20, 90, 18, 108]]);
    assert.deepEqual(payload.collections.map(row => [row.vatRate, row.amountHt, row.vatAmount, row.amountTtc]), [[10, 46.28, 4.63, 50.91], [20, 92.58, 18.51, 111.09]]);
});

test("collection rows are omitted when VAT is accounted for on debits", () => {
    const payload = buildB2cReportPayload({ documents: [invoice()], settlements: [{ id: 10, documentId: 1, date: "2026-03-12", amount: 120 }], vatOnDebits: true, periodStart: "2026-03-01", periodEnd: "2026-03-31" });
    assert.equal(payload.collections.length, 0);
});

test("an older service invoice contributes only its in-period collection", () => {
    const payload = buildB2cReportPayload({ documents: [invoice({ issueDate: "2026-02-20" })], settlements: [{ id: 11, documentId: 1, date: "2026-03-05", amount: 120 }], vatOnDebits: false, periodStart: "2026-03-01", periodEnd: "2026-03-31" });
    assert.equal(payload.transactions.length, 0);
    assert.deepEqual(payload.collections.map(row => [row.date, row.amountHt, row.vatAmount, row.amountTtc]), [["2026-03-05", 100, 20, 120]]);
});

test("CSV explicitly states that the local report was not transmitted", () => {
    const payload = buildB2cReportPayload({ documents: [invoice()], settlements: [], periodStart: "2026-03-01", periodEnd: "2026-03-31" });
    const csv = buildB2cReportCsv({ payload });
    assert.match(csv, /statut_transmission/);
    assert.match(csv, /non_transmis/);
});
