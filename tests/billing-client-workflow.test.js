import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const billingSource = readFileSync(new URL("../js/billing.js", import.meta.url), "utf8");
const calendarSource = readFileSync(new URL("../js/calendar.js", import.meta.url), "utf8");

test("selecting a known billing customer stores its client id", () => {
    assert.match(billingSource, /form\.querySelector\("\[name=clientId\]"\)\.value = client\?\.id \|\| ""/);
});

test("saved quotes and invoices open the client before offering email or print", () => {
    assert.match(billingSource, /const savedDocumentId = result\.data\?\.id \|\| document\.id/);
    assert.match(billingSource, /depannhome:open-client/);
    assert.match(billingSource, /openDocumentDeliveryChoice/);
    assert.match(billingSource, /\/api\/billing\/documents\/\$\{encodeURIComponent\(savedDocumentId\)\}\/email/);
});

test("appointment synchronization remains available without navigating back to calendar", () => {
    assert.match(billingSource, /suppressNavigation: true/);
    assert.match(calendarSource, /if \(event\.detail\?\.suppressNavigation\) return/);
});