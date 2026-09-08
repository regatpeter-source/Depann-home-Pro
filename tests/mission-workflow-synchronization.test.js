import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findPartnerMissionClientRow, restoredPartnerMissionStatus, shouldAdvancePartnerMissionStatus } from "../server/partner-missions.js";

const read = relativePath => readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");

test("la progression métier avance sans régresser ni rouvrir une mission terminale", () => {
    assert.equal(shouldAdvancePartnerMissionStatus("scheduled", "report_in_progress"), true);
    assert.equal(shouldAdvancePartnerMissionStatus("scheduled", "report_validated"), true);
    assert.equal(shouldAdvancePartnerMissionStatus("report_validated", "work_completed"), true);
    assert.equal(shouldAdvancePartnerMissionStatus("work_completed", "invoice_sent"), true);
    assert.equal(shouldAdvancePartnerMissionStatus("invoice_sent", "report_validated"), false);
    assert.equal(shouldAdvancePartnerMissionStatus("closed", "invoice_sent"), false);
    assert.equal(shouldAdvancePartnerMissionStatus("cancelled", "work_completed"), false);
    assert.equal(shouldAdvancePartnerMissionStatus("scheduled", "invoice_created"), false);
});

test("la réactivation retrouve les actions durables déjà réalisées par l’entreprise", () => {
    assert.equal(restoredPartnerMissionStatus({ status: "rejected", calendar_event_id: 42 }), "scheduled");
    assert.equal(restoredPartnerMissionStatus({ status: "cancelled", assigned_technician_id: 7 }), "assigned");
    assert.equal(restoredPartnerMissionStatus({ status: "rejected", scheduled_date: "2026-04-10" }), "pending_validation");
    assert.equal(restoredPartnerMissionStatus({ status: "closed" }), "accepted");
});

test("une autre intervention ou un SAV crée une mission distincte sur la même fiche client", () => {
    const clients = [
        { client_id: "client-existing", client_data: { name: "Mme Martin", email: "martin@example.fr", phone: "06 12 34 56 78", address: "1 rue de Paris", city: "Lyon" } },
        { client_id: "client-other", client_data: { name: "M. Dupont", email: "dupont@example.fr", phone: "06 98 76 54 32", address: "2 rue des Lilas", city: "Lyon" } }
    ];
    assert.equal(findPartnerMissionClientRow(clients, { clientName: "Mme Martin", email: "MARTIN@example.fr", interventionType: "SAV" })?.client_id, "client-existing");
    assert.equal(findPartnerMissionClientRow(clients, { clientName: "Mme Martin", phone: "+33 6 12 34 56 78", interventionType: "Nouvelle intervention" })?.client_id, "client-existing");
    assert.equal(findPartnerMissionClientRow(clients, { clientName: "Mme Martin", address: "1 rue de Paris", city: "Lyon" })?.client_id, "client-existing");
    assert.equal(findPartnerMissionClientRow(clients, { clientName: "Nouveau client", email: "nouveau@example.fr" }), null);
    const missionServer = read("server/partner-missions.js");
    assert.match(missionServer, /options\.reactivateArchived === true/);
    assert.match(missionServer, /'partner_mission_reactivated'/);
});

test("les événements rapport, planning et facturation synchronisent le statut réel de mission", () => {
    const dialogue = read("server/partner-dialogue.js");
    const reports = read("server/technical-reports.js");
    const calendar = read("server/calendar.js");
    const billing = read("server/billing.js");
    assert.match(dialogue, /synchronizePartnerMissionStatusForSource/);
    assert.match(reports, /status: "report_in_progress"/);
    assert.match(reports, /status: "report_validated"/);
    assert.match(calendar, /event\.status === "completed" \? "work_completed" : "on_site"/);
    assert.match(billing, /billing_document_emailed/);
    assert.match(billing, /documentType === "invoice" \? "invoice_sent" : "quote_sent"/);
});

test("un devis modifié ne devient envoyé que lorsque son état le confirme", () => {
    const billing = read("server/billing.js");
    const updateRoute = billing.slice(billing.indexOf('app.put("/api/billing/documents/:documentId"'), billing.indexOf('app.post("/api/billing/documents/:documentId/corrections"'));
    assert.match(updateRoute, /status === "accepted" \? "quote_accepted" : status === "sent" \? "quote_sent" : "quote_created"/);
});

test("tous les techniciens affectés reçoivent les notifications de mission", () => {
    const missions = read("server/partner-missions.js");
    const notifier = missions.slice(missions.indexOf("async function notifyAssignedUsers"), missions.indexOf("async function notifyManagedMissionSource"));
    assert.match(notifier, /depannhome_calendar_assignments/);
    assert.match(notifier, /assignment\.technician_id=member\.id/);
    assert.match(notifier, /'technician','team_lead'/);
    assert.doesNotMatch(missions, /async function notifyUsers/);
});
