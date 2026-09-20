import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canManageCalendarSchedule } from "../server/calendar.js";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("le droit unique contrôle la création et la modification du planning", () => {
    assert.equal(canManageCalendarSchedule({ role: "team_lead", canManageCalendar: true }), true);
    assert.equal(canManageCalendarSchedule({ role: "team_lead", canManageCalendar: false }), false);
    assert.equal(canManageCalendarSchedule({ role: "team_lead" }), false);
    assert.equal(canManageCalendarSchedule({ role: "technician", canManageCalendar: true }), true);
    assert.equal(canManageCalendarSchedule({ role: "technician", canManageCalendar: false }), false);
    assert.equal(canManageCalendarSchedule({ role: "mobile_admin", canManageCalendar: true }), true);
    assert.equal(canManageCalendarSchedule({ role: "mobile_admin", canManageCalendar: false }), false);
    assert.equal(canManageCalendarSchedule({ role: "commercial", deviceType: "mobile", canManageCalendar: true }), false);
    assert.equal(canManageCalendarSchedule({ role: "commercial", deviceType: "desktop" }), true);
    assert.equal(canManageCalendarSchedule({ role: "admin" }), true);
    assert.equal(canManageCalendarSchedule({ role: "unknown" }), false);
});

test("les migrations conservent l’accès des responsables mobiles existants", () => {
    const migration = read("database/migrations/0011_team_lead_calendar_permission.sql");
    const mobileMigration = read("database/migrations/0027_mobile_calendar_permission.sql");
    const schema = read("database/schema.sql");
    assert.match(migration, /ADD COLUMN IF NOT EXISTS can_manage_calendar BOOLEAN NOT NULL DEFAULT FALSE/);
    assert.match(migration, /SET can_manage_calendar = TRUE\s+WHERE role = 'team_lead'/);
    assert.match(mobileMigration, /SET can_manage_calendar = TRUE, updated_at = NOW\(\)/);
    assert.match(mobileMigration, /WHERE role = 'mobile_admin'/);
    assert.match(schema, /can_manage_calendar BOOLEAN NOT NULL DEFAULT FALSE/);
});

test("les nouveaux postes mobiles démarrent sans droit sauf autorisation explicite", () => {
    const auth = read("server/auth.js");
    const database = read("server/database.js");
    assert.match(auth, /const MOBILE_CALENDAR_ROLES = new Set\(\[MOBILE_ADMIN_ROLE, TEAM_LEAD_ROLE, "technician"\]\)/);
    assert.match(auth, /const canManageCalendar = MOBILE_CALENDAR_ROLES\.has\(role\) && request\.body\?\.canManageCalendar === true/);
    assert.match(database, /canManageCalendar = false/);
    assert.match(auth, /can_manage_calendar = FALSE/);
});

test("le droit circule dans les sessions et l’administration des membres", () => {
    const auth = read("server/auth.js");
    const application = read("js/app.js");
    const navigation = read("js/navigation.js");
    assert.match(auth, /can_manage_calendar AS "canManageCalendar"/);
    assert.match(auth, /canManageCalendar: MOBILE_CALENDAR_ROLES\.has\(user\.role\)/);
    assert.match(auth, /can_manage_calendar = \$9/);
    assert.match(application, /dataset\.canManageCalendar = user\.canManageCalendar \? "true" : "false"/);
    assert.match(application, /canManageCalendar: user\?\.canManageCalendar === true/);
    assert.match(navigation, /name="canManageCalendar"/);
    assert.match(navigation, /\["mobile_admin", "technician", "team_lead"\]\.includes\(roleInput\.value\)/);
    assert.match(navigation, /Autoriser la gestion du planning/);
});

test("un poste mobile sans droit conserve la réalisation sans pouvoir replanifier", () => {
    const client = read("js/calendar.js");
    const server = read("server/calendar.js");
    assert.match(client, /\["mobile_admin", "team_lead", "technician"\]\.includes\(role\) && document\.body\.dataset\.canManageCalendar !== "true"/);
    assert.match(client, /!rescheduled && canEditCalendarEvent\(event\)/);
    assert.match(client, /isDedicatedMobileCalendar\(\).*!canEditCalendarEvent\(event\)/s);
    assert.match(server, /if \(!canManageCalendarSchedule\(request\.user\)\) return response\.status\(403\).*replanification/);
    assert.match(server, /EVENT_STATUS_MANAGER_ROLES/);
    assert.match(server, /"team_lead"/);
    assert.doesNotMatch(server, /EVENT_STATUS_MANAGER_ROLES = new Set\([^)]*team_lead/);
});

test("le Chef d’équipe sans droit conserve la vue et les filtres de son équipe", () => {
    const client = read("js/calendar.js");
    assert.match(client, /const technicianHome = usesPersonalCalendarView\(\)/);
    assert.match(client, /usesPersonalCalendarView\(\) \? Promise\.resolve\(\[\]\) : loadCalendarMembers\(\)/);
    assert.match(client, /function usesPersonalCalendarView\(\) \{\s*return document\.body\.dataset\.role === "accountant"/);
    assert.match(client, /\$\{renderTechnicianFilter\(\)\}/);
    assert.match(client, /function getVisibleEvents\(\) \{\s*if \(usesPersonalCalendarView\(\) \|\| showAllTechnicians\)/);
    assert.match(client, /const canCreate = canCreateCalendarEvents\(\);\s*if \(canCreate\)/);
});

test("un Technicien autorisé accède au planning général et à l’annuaire", () => {
    const auth = read("server/auth.js");
    const server = read("server/calendar.js");
    assert.match(auth, /request\.user\?\.role === "technician" && request\.user\?\.canManageCalendar === true/);
    assert.match(server, /user\?\.role === "technician" && user\?\.canManageCalendar !== true/);
});