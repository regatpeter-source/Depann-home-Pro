import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canAccessReminderDashboard, reminderDashboardMarkup } from "../js/reminder-dashboard.js";
import { hasInternalBusinessWorkspaceAccess } from "../server/workstation-permissions.js";

test("les rappels du tableau de bord respectent les rôles et les interfaces autorisées", () => {
    for (const role of ["admin", "pc_standard", "mobile_admin"]) {
        assert.equal(canAccessReminderDashboard({ role, organizationInterface: "standard", supportControl: "false" }), true);
        assert.equal(canAccessReminderDashboard({ role, organizationInterface: "group", supportControl: "false" }), true);
        assert.equal(canAccessReminderDashboard({ role, organizationInterface: "partner", supportControl: "false" }), false);
        assert.equal(canAccessReminderDashboard({ role, organizationInterface: "standard", supportControl: "true" }), false);
    }
    for (const role of ["commercial", "accountant", "team_lead", "technician", "anonymous"]) {
        assert.equal(canAccessReminderDashboard({ role, organizationInterface: "standard", supportControl: "false" }), false);
    }
});

test("les nouvelles actions métier refusent aussi côté serveur les interfaces et prises en main exclues", () => {
    for (const interfaceType of ["standard", "group"]) {
        assert.equal(hasInternalBusinessWorkspaceAccess({ organization: { interfaceType }, isSupportControl: false }), true);
        assert.equal(hasInternalBusinessWorkspaceAccess({ organization: { interfaceType }, isSupportControl: true }), false);
    }
    assert.equal(hasInternalBusinessWorkspaceAccess({ organization: { interfaceType: "partner" } }), false);
    assert.equal(hasInternalBusinessWorkspaceAccess({}), false);
});

test("l’activation manuelle propose uniquement les trois catégories choisies", () => {
    const markup = reminderDashboardMarkup();
    assert.match(markup, /value="maintenance_due"/);
    assert.match(markup, /value="contract_renewal"/);
    assert.match(markup, /value="low_stock"/);
    assert.doesNotMatch(markup, /<option value="quote_follow_up"/);
    assert.match(markup, /Aucune règle n’est créée automatiquement/);
    assert.match(markup, /Aucun e-mail n’est envoyé/);
    assert.match(markup, /aucune intervention n’est créée ou modifiée automatiquement/);
});

test("les rappels quittent l’Accueil mobile et restent accessibles depuis le menu mobile", () => {
    const navigation = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
    const worker = readFileSync(new URL("../service-worker.js", import.meta.url), "utf8");
    const resources = readFileSync(new URL("../js/business-suite.js", import.meta.url), "utf8");
    const renderHome = navigation.slice(navigation.indexOf("async function renderHome()"), navigation.indexOf("function renderDashboardStickyNotes()"));
    const reminderView = navigation.slice(navigation.indexOf("function renderMobileReminders()"), navigation.indexOf("function renderMobileSupportTicket()"));
    assert.match(renderHome, /const remindersEnabled = !isMobileDeviceContext\(\) && canAccessReminderDashboard\(document\.body\.dataset\)/);
    assert.match(reminderView, /setPage\("Rappels internes", ROUTES\.calendar, "detail"\)/);
    assert.match(reminderView, /reminderDashboardMarkup\(\)/);
    assert.match(reminderView, /mountReminderDashboard/);
    assert.match(reminderView, /openPlanning: calendarEnabled/);
    assert.match(navigation, /title === "Interventions" && canAccessReminderDashboard\(document\.body\.dataset\)/);
    assert.match(navigation, /data-mobile-reminders>Rappels internes/);
    assert.match(navigation, /\[data-mobile-reminders\]"\)\) \{\s*close\(\);\s*renderMobileReminders\(\);/);
    assert.match(navigation, /view\.workspace === "reminders"\) return renderMobileReminders\(\)/);
    assert.match(worker, /reminder-dashboard\.js\?v=2/);
    assert.match(resources, /data-contract-schedule/);
    assert.match(resources, /data-item-threshold/);
    assert.doesNotMatch(resources, /data-run-automation|data-rule-form|Automatisations/);
});
