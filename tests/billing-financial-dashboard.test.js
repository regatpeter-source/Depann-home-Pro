import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildBillingFinancialDashboard } from "../server/billing.js";

const clientSource = readFileSync(new URL("../js/billing.js", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../server/billing.js", import.meta.url), "utf8");

test("billing dashboard calculates turnover, credits, purchases, margin and outstanding", () => {
    const documents = [
        { id: 1, documentType: "invoice", status: "sent", lines: [{ description: "Intervention", quantity: 1, unitPrice: 100, vatRate: 20 }], financialData: {} },
        { id: 2, documentType: "credit", status: "sent", lines: [{ description: "Avoir", quantity: 1, unitPrice: 20, vatRate: 20 }], financialData: {} },
        { id: 3, documentType: "invoice", status: "draft", lines: [{ description: "Brouillon", quantity: 1, unitPrice: 999, vatRate: 20 }], financialData: {} }
    ];
    const dashboard = buildBillingFinancialDashboard(documents, [{ documentId: 1, amount: 60 }], 30);
    assert.deepEqual(dashboard, {
        invoicesHt: 100,
        invoicesTtc: 120,
        turnoverHt: 80,
        creditsHt: 20,
        creditsTtc: 24,
        purchasesHt: 30,
        grossProfitEstimateHt: 50,
        collected: 60,
        outstanding: 60,
        invoicesCount: 1,
        creditsCount: 1
    });
});

test("billing dashboard exposes a negative estimated margin without hiding it", () => {
    const dashboard = buildBillingFinancialDashboard([
        { id: 1, documentType: "invoice", status: "sent", lines: [{ quantity: 1, unitPrice: 50, vatRate: 0 }], financialData: {} }
    ], [], 80);
    assert.equal(dashboard.turnoverHt, 50);
    assert.equal(dashboard.grossProfitEstimateHt, -30);
});

test("billing menu renders the financial pie chart from owner-scoped aggregates", () => {
    assert.match(clientSource, /billing-financial-dashboard/);
    assert.match(clientSource, /conic-gradient/);
    assert.match(clientSource, /Marge brute estimée HT/);
    assert.match(clientSource, /Reste à encaisser TTC/);
    assert.match(serverSource, /depannhome_accounting_settlements/);
    assert.match(serverSource, /depannhome_purchases/);
    assert.match(serverSource, /WHERE owner_id = \$1/);
});
