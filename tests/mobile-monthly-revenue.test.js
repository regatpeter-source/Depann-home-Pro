import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildMobileRevenueDashboard } from "../server/billing.js";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const serverSource = read("../server/billing.js");
const accountingSource = read("../server/accounting.js");
const billingClientSource = read("../js/billing.js");
const navigationSource = read("../js/navigation.js");
const schemaSource = read("../database/schema.sql");
const migrationSource = read("../database/migrations/0036_mobile_monthly_revenue.sql");
const migrationRunnerSource = read("../server/database-migrations.js");

const line = amount => [{ description: "Intervention", quantity: 1, unitPrice: amount, vatRate: 20 }];

test("monthly mobile revenue counts each issued document once for its assignee", () => {
    const members = [
        { id: 11, name: "Alice Mobile", role: "technician" },
        { id: 12, name: "Benoît Mobile", role: "team_lead" }
    ];
    const documents = [
        { revenueAssigneeId: 11, createdBy: 11, issueDate: "2026-03-02", issuedAt: "2026-03-02T10:00:00Z", documentType: "invoice", status: "issued", lines: line(100), financialData: {} },
        { revenueAssigneeId: 11, createdBy: 99, issueDate: "2026-03-05", issuedAt: "2026-03-05T10:00:00Z", documentType: "credit", status: "issued", lines: line(-25), financialData: {} },
        { revenueAssigneeId: 12, createdBy: 99, issueDate: "2026-03-08", issuedAt: "2026-03-08T10:00:00Z", documentType: "invoice", status: "issued", lines: line(60), financialData: {} },
        { revenueAssigneeId: 11, issueDate: "2026-03-10", issuedAt: null, documentType: "invoice", status: "draft", lines: line(999), financialData: {} },
        { revenueAssigneeId: 11, issueDate: "2026-02-28", issuedAt: "2026-02-28T10:00:00Z", documentType: "invoice", status: "issued", lines: line(500), financialData: {} },
        { revenueAssigneeId: 11, issueDate: "2026-03-11", issuedAt: "2026-03-11T10:00:00Z", documentType: "invoice", status: "cancelled", lines: line(700), financialData: {} }
    ];
    const result = buildMobileRevenueDashboard(documents, members, { year: 2026, month: "03" });
    assert.deepEqual(result, [
        { id: 11, name: "Alice Mobile", role: "technician", invoicesCount: 1, creditsCount: 1, invoicesHt: 100, creditsHt: 25, turnoverHt: 75 },
        { id: 12, name: "Benoît Mobile", role: "team_lead", invoicesCount: 1, creditsCount: 0, invoicesHt: 60, creditsHt: 0, turnoverHt: 60 }
    ]);
});

test("credits can make an individual monthly turnover negative", () => {
    const result = buildMobileRevenueDashboard([
        { revenueAssigneeId: 7, issueDate: "2026-04-01", issuedAt: "2026-04-01T10:00:00Z", documentType: "credit", status: "issued", lines: line(80), financialData: {} }
    ], [{ id: 7, name: "Mobile 7", role: "mobile_admin" }], { year: 2026, month: "04" });
    assert.equal(result[0].turnoverHt, -80);
});

test("mobile revenue is tenant-scoped, own-only on mobile and immutable after issue", () => {
    assert.match(serverSource, /GET \/api\/billing\/mobile-revenue|app\.get\("\/api\/billing\/mobile-revenue"/);
    assert.match(serverSource, /const ownOnly = MOBILE_REVENUE_ROLES\.has/);
    assert.match(serverSource, /originalUrl.*\/api\/billing\/mobile-revenue/);
    assert.match(serverSource, /revenue_assignee_id=\$3/);
    assert.match(serverSource, /owner_id=\$1/);
    assert.match(serverSource, /NEW\.revenue_assignee_id/);
    assert.match(schemaSource, /revenue_assignee_id BIGINT REFERENCES depannhome_users/);
    assert.match(migrationSource, /depannhome_billing_documents_revenue_assignee_idx/);
    assert.match(migrationSource, /mobile_creator\.role IN \('mobile_admin','team_lead','technician'\)/);
    assert.match(migrationSource, /ORDER BY assignment\.is_primary DESC,assignment\.technician_id/);
    assert.match(serverSource, /ORDER BY assignment\.is_primary DESC,assignment\.technician_id LIMIT 1/);
    assert.doesNotMatch(migrationSource, /assignment\.id/);
    assert.doesNotMatch(serverSource, /assignment\.id/);
    assert.match(migrationRunnerSource, /\[36, new Set\(\[/);
    assert.match(migrationRunnerSource, /c9c2f8a1d08aa9c962e717c5ebdf301835040f2ce84a4621e24ab3e103cd8b0f/);
});

test("administrative assignment, credit inheritance and mobile and PC dashboards are wired", () => {
    assert.match(billingClientSource, /CA attribué à<select name="revenueAssigneeId"/);
    assert.match(billingClientSource, /Attribué automatiquement à/);
    assert.match(accountingSource, /invoice\.revenue_assignee_id, invoice\.revenue_assignee_name/);
    assert.match(navigationSource, /Mon chiffre d’affaires mensuel/);
    assert.match(navigationSource, /\/api\/billing\/mobile-revenue\?year=/);
    assert.match(navigationSource, /Factures émises moins avoirs émis/);
    assert.match(billingClientSource, /CA mensuel par poste mobile/);
    assert.match(billingClientSource, /data-billing-mobile-revenue/);
    assert.match(billingClientSource, /\/api\/billing\/mobile-revenue\?year=/);
    assert.match(billingClientSource, /document\.body\.classList\.contains\("desktop-device"\)/);
    assert.match(billingClientSource, /members\.reduce\(\(sum, member\) => sum \+ \(Number\(member\.turnoverHt\)/);
});
