import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canManageCalendarSchedule } from "../server/calendar.js";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("le droit unique contrôle la création et la modification du planning", () => {
    assert.equal(canManageCalendarSchedule({ role: "team_lead", canManageCalendar: true }), true);
    assert.equal(canManageCalendarSchedule({ role: "team_lead", canManageCalendar: false }), false);
    assert.equal(canManageCalendarSchedule({ role: "team_lead" }), false);
    assert.equal(canManageCalendarSchedule({ role: "technician", canManageCalendar: true }), false);
    assert.equal(canManageCalendarSchedule({ role: "commercial", deviceType: "mobile", canManageCalendar: true }), false);
    assert.equal(canManageCalendarSchedule({ role: "commercial", deviceType: "desktop" }), true);
    assert.equal(canManageCalendarSchedule({ role: "admin" }), true);
    assert.equal(canManageCalendarSchedule({ role: "unknown" }), false);
});

test("la migration conserve l’accès des Chefs d’équipe existants", () => {
    const migration = read("database/migrations/0011_team_lead_calendar_permission.sql");
    const schema = read("database/schema.sql");
    assert.match(migration, /ADD COLUMN IF NOT EXISTS can_manage_calendar BOOLEAN NOT NULL DEFAULT FALSE/);
    assert.match(migration, /SET can_manage_calendar = TRUE\s+WHERE role = 'team_lead'/);
    assert.match(schema, /can_manage_calendar BOOLEAN NOT NULL DEFAULT FALSE/);
});

test("les nouveaux Chefs d’équipe démarrent sans droit sauf autorisation explicite", () => {
    const auth = read("server/auth.js");
    const database = read("server/database.js");
    assert.match(auth, /const canManageCalendar = role === TEAM_LEAD_ROLE && request\.body\?\.canManageCalendar === true/);
    assert.match(database, /canManageCalendar = false/);
    assert.match(auth, /can_manage_calendar = FALSE/);
});

test("le droit circule dans les sessions et l’administration des membres", () => {
    const auth = read("server/auth.js");
    const application = read("js/app.js");
    const navigation = read("js/navigation.js");
    assert.match(auth, /can_manage_calendar AS "canManageCalendar"/);
    assert.match(auth, /canManageCalendar: user\.role === TEAM_LEAD_ROLE/);
    assert.match(auth, /can_manage_calendar = \$9/);
    assert.match(application, /dataset\.canManageCalendar = user\.canManageCalendar \? "true" : "false"/);
    assert.match(application, /canManageCalendar: user\?\.canManageCalendar === true/);
    assert.match(navigation, /name="canManageCalendar"/);
    assert.match(navigation, /Autoriser la gestion du planning/);
});

test("le Chef d’équipe sans droit conserve la réalisation des interventions", () => {
    const client = read("js/calendar.js");
    const server = read("server/calendar.js");
    assert.match(client, /document\.body\.dataset\.role === "team_lead" && document\.body\.dataset\.canManageCalendar !== "true"/);
    assert.match(client, /\(isMobileAdministrator\(\) \|\| isTeamLead\(\)\).*event\.eventType === "appointment"/);
    assert.match(server, /EVENT_STATUS_MANAGER_ROLES/);
    assert.match(server, /"team_lead"/);
    assert.doesNotMatch(server, /EVENT_STATUS_MANAGER_ROLES = new Set\([^)]*team_lead/);
});