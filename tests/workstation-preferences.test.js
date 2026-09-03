import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { notificationPreferenceKey } from "../js/collaboration.js";

const config = readFileSync(new URL("../js/config.js", import.meta.url), "utf8");
const storage = readFileSync(new URL("../js/storage.js", import.meta.url), "utf8");
const navigation = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
const application = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
const collaboration = readFileSync(new URL("../js/collaboration.js", import.meta.url), "utf8");
const style = readFileSync(new URL("../css/style.css", import.meta.url), "utf8");

test("les notifications sont classées selon les choix du poste administratif", () => {
    assert.equal(notificationPreferenceKey({ eventType: "partner_mission_received", entityType: "partner_mission" }), "partnerNewMission");
    assert.equal(notificationPreferenceKey({ eventType: "partner_dialogue_updated", entityType: "partner_mission" }), "partnerMissionUpdates");
    assert.equal(notificationPreferenceKey({ eventType: "appointment_created", entityType: "calendar_event" }), "appointments");
    assert.equal(notificationPreferenceKey({ eventType: "report_validated", entityType: "technical_report" }), "reports");
    assert.equal(notificationPreferenceKey({ eventType: "billing_paid", entityType: "billing_document" }), "billing");
    assert.equal(notificationPreferenceKey({ eventType: "client_message_received", entityType: "client" }), "clientMessages");
    assert.equal(notificationPreferenceKey({ eventType: "partner_connection_requested", entityType: "partner_connection" }), "partnerNetwork");
    assert.equal(notificationPreferenceKey({ eventType: "security_information", entityType: "" }), "system");
});

test("les préférences manquantes restent activées pour les postes existants", () => {
    assert.match(config, /notifications:\s*\{[\s\S]*partnerNewMission: true[\s\S]*system: true/);
    assert.match(storage, /notifications: \{ \.\.\.DEFAULT_SETTINGS\.notifications, \.\.\.\(saved\.notifications \|\| \{\}\) \}/);
    assert.match(collaboration, /visibleNotifications\(notifications\)\.filter\(item => !item\.readAt\)/);
    assert.match(collaboration, /preferences\[notificationPreferenceKey\(item\)\] !== false/);
    assert.match(collaboration, /return visibleNotifications\(partnerNotifications\)/);
});

test("la personnalisation propose thème, densité, animations et filtres de notifications", () => {
    assert.match(navigation, /Standard \(clair\)/);
    assert.match(navigation, /Densité de l’interface/);
    assert.match(navigation, /Réduire les animations/);
    assert.match(navigation, /Notifications sur ce poste/);
    assert.match(navigation, /data-notification-preference/);
    assert.match(navigation, /themeSelect\.addEventListener\("change"/);
    assert.match(navigation, /saveSettings\(\{ \.\.\.getSettings\(\), theme:/);
    assert.match(navigation, /classList\.toggle\("dark-theme", updatedSettings\.theme === "dark"\)/);
    assert.match(application, /classList\.toggle\("compact-interface"/);
    assert.match(application, /classList\.toggle\("reduce-motion"/);
    assert.match(style, /body\.dark-theme\{/);
    assert.match(style, /body\.compact-interface/);
    assert.match(style, /body\.reduce-motion \*/);
});

test("une mise à jour du service worker recharge chaque nouvelle version une seule fois", () => {
    assert.match(application, /let reloadingForServiceWorkerUpdate = false/);
    assert.match(application, /if \(reloadingForServiceWorkerUpdate\) return/);
    assert.doesNotMatch(application, /sessionStorage\.getItem\("depannhome:service-worker-reloaded"\)/);
});
