import test from "node:test";
import assert from "node:assert/strict";
import { clientIsSelectable, clientLifecycleDecision, normalizeClientStatus } from "../server/client-lifecycle.js";

const emptyClient = () => ({ attachments: [], activityHistory: [{ type: "client", label: "Fiche créée" }] });

test("1 - client without history can be permanently deleted", () => {
    const decision = clientLifecycleDecision({}, emptyClient());
    assert.equal(decision.canDeletePermanently, true);
    assert.equal(decision.mustArchive, false);
});

test("2 - an appointment protects the client record", () => {
    const decision = clientLifecycleDecision({ appointments: 1 }, emptyClient());
    assert.equal(decision.canDeletePermanently, false);
    assert.equal(decision.dependencies.appointments, 1);
});

test("3 - a quote protects the client record", () => {
    assert.equal(clientLifecycleDecision({ billingDocuments: 1 }, emptyClient()).mustArchive, true);
});

test("4 - an invoice remains protected while archival stays non-destructive", () => {
    const dependencies = { billingDocuments: 1 };
    const decision = clientLifecycleDecision(dependencies, emptyClient());
    assert.equal(decision.canDeletePermanently, false);
    assert.deepEqual(dependencies, { billingDocuments: 1 });
});

test("5 - invoice, report and photos all protect the client record", () => {
    const client = { attachments: [{ type: "Photo" }], activityHistory: [] };
    const decision = clientLifecycleDecision({ billingDocuments: 1, reports: 1 }, client);
    assert.equal(decision.mustArchive, true);
    assert.equal(decision.totalDependencies, 3);
});

test("6 - archived clients are searchable by status but excluded from business selectors until reactivated", () => {
    const client = { clientStatus: "archived" };
    assert.equal(normalizeClientStatus(client.clientStatus), "archived");
    assert.equal(clientIsSelectable(client), false);
    client.clientStatus = "active";
    assert.equal(clientIsSelectable(client), true);
});

test("7 - a partner mission protects the client and its mission history", () => {
    const decision = clientLifecycleDecision({ partnerMissions: 1 }, emptyClient());
    assert.equal(decision.canDeletePermanently, false);
    assert.equal(decision.dependencies.partnerMissions, 1);
});

test("attachments and significant activity history independently prevent deletion", () => {
    assert.equal(clientLifecycleDecision({}, { attachments: [{}], activityHistory: [] }).mustArchive, true);
    assert.equal(clientLifecycleDecision({}, { attachments: [], activityHistory: [{ type: "quitus" }] }).mustArchive, true);
});
