import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const serverSource = readFileSync(new URL("../server/clients.js", import.meta.url), "utf8");
const clientsSource = readFileSync(new URL("../js/clients.js", import.meta.url), "utf8");
const syncSource = readFileSync(new URL("../js/client-sync.js", import.meta.url), "utf8");

test("only intervention JPEG/PDF attachments can be deleted", () => {
    const route = serverSource.slice(serverSource.indexOf('app.delete("/api/clients/:clientId/attachments/:attachmentId"'), serverSource.indexOf('app.get("/api/clients/:clientId/attachments/:attachmentId/open"'));
    assert.match(route, /status\(409\)/);
    assert.match(route, /isDeletableInterventionAttachment/);
    assert.match(route, /hasAccessibleAppointment/);
    assert.match(route, /UPDATE depannhome_clients/);
    assert.match(route, /deletedAttachmentIds: mergeDeletedAttachmentIds/);
    assert.match(route, /documents réglementaires restent conservés/);
});

test("intervention history exposes JPEG/PDF actions including deletion", () => {
    assert.match(clientsSource, /type: "intervention_attachment"/);
    assert.match(clientsSource, /data-delete-intervention-attachment/);
    assert.match(clientsSource, /data-email-intervention-attachment/);
    assert.match(clientsSource, /\?download=1/);
    assert.match(clientsSource, /deleteInterventionAttachment/);
});

test("reports and quitus stay in history while generic files stay in the files section", () => {
    assert.match(clientsSource, /attachment\.type !== "Quitus" && !isLeakReportAttachment\(attachment\)/);
    assert.match(clientsSource, /!\["quote", "invoice", "attachment"\]\.includes\(entry\.type\)/);
    assert.match(clientsSource, /entry\.type !== "appointment" \|\| !appointments\.length/);
    assert.match(clientsSource, /const attachmentEntries = client\.attachments\.filter\(isInterventionPhoto\)/);
});

test("validated reports deleted in older versions are restored from their canonical PDF", () => {
    assert.match(serverSource, /await reconcileValidatedReportAttachments\(database, ownerId\)/);
    assert.match(serverSource, /report\.status = 'validated' AND report\.pdf_data IS NOT NULL/);
    assert.match(serverSource, /reportId: String\(row\.id\)/);
    assert.match(serverSource, /deletedAttachmentIds.*filter\(id => id !== attachmentId\)/);
});

test("client synchronization keeps tombstones and cannot restore deleted intervention media", () => {
    assert.match(syncSource, /const attachments = new Map/);
    assert.match(syncSource, /attachments: \[\.\.\.attachments\.values\(\)\]/);
    assert.match(syncSource, /deletedAttachmentIds: mergeDeletedAttachmentIds/);
    assert.match(syncSource, /!deleted\.has\(String\(attachment\.id\)\)/);
    assert.match(syncSource, /function mergeDeletedAttachmentIds/);
});

test("the open route switches to attachment disposition for an explicit download", () => {
    const openRoute = serverSource.slice(serverSource.indexOf('app.get("/api/clients/:clientId/attachments/:attachmentId/open"'), serverSource.indexOf('app.post("/api/clients/:clientId/attachments/:attachmentId/email"'));
    assert.match(openRoute, /request\.query\?\.download === "1" \? "attachment" : "inline"/);
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