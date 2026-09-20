import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const connectionsServer = readFileSync(new URL("../server/partner-connections.js", import.meta.url), "utf8");
const missionsServer = readFileSync(new URL("../server/partner-missions.js", import.meta.url), "utf8");
const navigation = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
const connectionsClient = readFileSync(new URL("../js/partner-connections.js", import.meta.url), "utf8");
const missionsClient = readFileSync(new URL("../js/partner-missions.js", import.meta.url), "utf8");
const collaborationClient = readFileSync(new URL("../js/collaboration.js", import.meta.url), "utf8");
const serviceWorker = readFileSync(new URL("../service-worker.js", import.meta.url), "utf8");

function section(source, start, end) {
    return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}

test("une intervention interne crée une notification ciblant sa mission exacte", () => {
    const notify = section(connectionsServer, "async function notifyAdmins", "export async function creatorNetworkDirectory");
    assert.match(notify, /eventType === "partner_connection_intervention"/);
    assert.match(notify, /entityType = mission \? "partner_mission" : "partner_connection"/);
    assert.match(notify, /entityId = String\(mission \? payload\.missionId/);
    assert.match(notify, /destination: entityType, action/);
});

test("les notifications récentes et historiques ouvrent la mission et l’action attendues", () => {
    const destination = section(navigation, "function openNotificationDestination", "function notificationEntityId");
    assert.match(destination, /entityType === "partner_mission" \|\| eventType === "partner_connection_intervention"/);
    assert.match(destination, /renderPartnerMissions\(\{ missionId,[^}]+action:/);
    assert.match(destination, /\["partner_connection_intervention", "partner_mission_received"\]\.includes\(eventType\) \? "accept" : "view"/);
    assert.match(navigation, /return \/\^\[1-9\]\\d\*\$\/\.test\(id\) \? id : ""/);
});

test("une demande de connexion ouvre la demande exacte sans accepter côté serveur", () => {
    const destination = section(navigation, "function openNotificationDestination", "function notificationEntityId");
    assert.match(destination, /renderSettings\(\{ section: "network", connectionId, action:/);
    assert.match(destination, /eventType === "partner_connection_requested" \? "accept" : "view"/);
    assert.match(navigation, /renderPartnerConnections\(container, \{ connectionId: options\.connectionId, action: options\.action \}\)/);
    assert.match(connectionsClient, /data-connection-id=/);
    assert.match(connectionsClient, /focusRequestedConnection/);
    assert.match(connectionsClient, /button\?\.click\(\)/);
    assert.doesNotMatch(destination, /\/api\/partner-connections\/.*\/accept/);
});

test("le bouton Missions ouvre en priorité une demande de connexion non lue", () => {
    assert.match(navigation, /function openPartnerMissionsEntryPoint\(\)/);
    assert.match(navigation, /unread\.find\(item => item\.eventType === "partner_connection_requested"\) \|\| unread\[0\]/);
    assert.match(navigation, /await markPartnerNotificationRead\(notification\.id\)/);
    assert.match(navigation, /return openNotificationDestination\(notification\)/);
    assert.match(navigation, /nav === ROUTES\.partnerMissions\) openPartnerMissionsEntryPoint\(\)/);
});

test("les notifications affichées dans Missions possèdent une action Ouvrir ciblée", () => {
    assert.match(missionsClient, /data-open-partner-notification=/);
    assert.match(missionsClient, /await markPartnerNotificationRead\(notification\.id\)/);
    assert.match(missionsClient, /new CustomEvent\("depannhome:open-notification"/);
    assert.doesNotMatch(missionsClient, /await markPartnerNotificationsRead\(\)/);
    assert.match(collaborationClient, /export async function markPartnerNotificationRead\(id\)/);
});

test("une mission à accepter ouvre la planification mais ne déclenche pas directement l’API", () => {
    const rendering = section(missionsClient, "export async function renderPartnerMissions", "function openCompanyApiSandboxInbox");
    assert.match(rendering, /targetedMission\.sourceType === "depannhome_network" \? "network"/);
    assert.match(rendering, /targetedMission\.sourceType === "professional_email" \? "email" : "external"/);
    assert.match(rendering, /options\.action === "accept"/);
    assert.match(rendering, /\["received", "pending_validation"\]\.includes\(targetedMission\.status\)/);
    assert.match(rendering, /openPartnerMissionPlanning\(targetedMission\)/);
    assert.doesNotMatch(rendering, /\/api\/partner-missions\/\$\{.*\}\/accept/);
});

test("les autres notifications métier conservent leur cible précise", () => {
    const destination = section(navigation, "function openNotificationDestination", "function notificationEntityId");
    assert.match(destination, /renderTechnicalReports\(Number\(entityId\) \|\| 0\)/);
    assert.match(destination, /renderBilling\(\{ documentId: notificationEntityId\(entityId\) \}\)/);
    assert.match(destination, /openClients\(entityId \|\| String\(notification\?\.payload\?\.clientId/);
});

test("l’interface distingue confirmer un e-mail et accepter une mission", () => {
    assert.match(missionsClient, /email_candidate: "À confirmer"/);
    assert.match(missionsClient, /received: "À accepter", pending_validation: "À accepter"/);
    assert.match(missionsClient, /textContent = "À accepter"/);
    assert.match(missionsClient, /textContent = "À confirmer \/ accepter"/);
    assert.match(missionsServer, /pending_validation: "en attente d’acceptation"/);
});

test("les versions PWA chargent le nouveau routage partenaire", () => {
    assert.match(navigation, /partner-missions\.js\?v=90/);
    assert.match(navigation, /partner-connections\.js\?v=50/);
    assert.match(serviceWorker, /depann-home-pro-v591/);
    assert.match(serviceWorker, /partner-missions\.js\?v=90/);
    assert.match(serviceWorker, /partner-connections\.js\?v=50/);
    assert.match(serviceWorker, /navigation\.js\?v=495/);
});
