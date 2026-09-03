import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const serverSource = readFileSync(new URL("../server/clients.js", import.meta.url), "utf8");
const clientsSource = readFileSync(new URL("../js/clients.js", import.meta.url), "utf8");
const syncSource = readFileSync(new URL("../js/client-sync.js", import.meta.url), "utf8");

test("client attachment deletion is rejected by the server for every file type", () => {
    const route = serverSource.slice(serverSource.indexOf('app.delete("/api/clients/:clientId/attachments/:attachmentId"'), serverSource.indexOf('app.get("/api/clients/:clientId/attachments/:attachmentId/open"'));
    assert.match(route, /status\(409\)/);
    assert.match(route, /ne peuvent pas être supprimés/);
    assert.doesNotMatch(route, /UPDATE depannhome_clients/);
});

test("client screens expose no attachment deletion action", () => {
    assert.doesNotMatch(clientsSource, /data-delete-attachment/);
    assert.doesNotMatch(clientsSource, /deleteClientAttachment/);
});

test("reports and quitus stay in history while generic files stay in the files section", () => {
    assert.match(clientsSource, /attachment\.type !== "Quitus" && !isLeakReportAttachment\(attachment\)/);
    assert.match(clientsSource, /!\["quote", "invoice", "attachment"\]\.includes\(entry\.type\)/);
    assert.match(clientsSource, /entry\.type !== "appointment" \|\| !appointments\.length/);
    assert.doesNotMatch(clientsSource, /const attachmentEntries =/);
});

test("validated reports deleted in older versions are restored from their canonical PDF", () => {
    assert.match(serverSource, /await reconcileValidatedReportAttachments\(database, ownerId\)/);
    assert.match(serverSource, /report\.status = 'validated' AND report\.pdf_data IS NOT NULL/);
    assert.match(serverSource, /reportId: String\(row\.id\)/);
    assert.match(serverSource, /deletedAttachmentIds.*filter\(id => id !== attachmentId\)/);
});

test("client synchronization unions attachments and ignores legacy deletion tombstones", () => {
    assert.match(syncSource, /const attachments = new Map/);
    assert.match(syncSource, /attachments: \[\.\.\.attachments\.values\(\)\]/);
    assert.match(syncSource, /deletedAttachmentIds: \[\]/);
    assert.doesNotMatch(syncSource, /mergeDeletedAttachmentIds/);
});

test("archived quitus can be opened, downloaded and emailed like other retained documents", () => {
    const openRoute = serverSource.slice(serverSource.indexOf('app.get("/api/clients/:clientId/attachments/:attachmentId/open"'), serverSource.indexOf('app.post("/api/clients/:clientId/attachments/:attachmentId/email"'));
    const emailRoute = serverSource.slice(serverSource.indexOf('app.post("/api/clients/:clientId/attachments/:attachmentId/email"'), serverSource.indexOf("async function analyzeClientLifecycle"));
    assert.match(openRoute, /loadClientAttachmentContent/);
    assert.match(openRoute, /Content-Disposition/);
    assert.match(emailRoute, /loadClientAttachmentContent/);
    assert.match(emailRoute, /sendDocumentEmail/);
    assert.doesNotMatch(`${openRoute}\n${emailRoute}`, /isCompletedInterventionQuitus|event_status IN \('completed','cancelled'\)/);
    assert.match(clientsSource, /const quitusActions = quitusAttachment \?/);
    assert.match(clientsSource, /data-view-quituses/);
    assert.match(clientsSource, /data-print-quituses/);
    assert.match(clientsSource, /data-email-quituses/);
});