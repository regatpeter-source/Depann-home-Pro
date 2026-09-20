import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canModifyCalendarEvent } from "../server/calendar.js";
import { canEditAssignedClients, hasAdministrativeClientAssignment, isDedicatedMobileSession } from "../server/mobile-client-access.js";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const authorizedTechnician = { sub: "42", role: "technician", deviceType: "mobile", canManageCalendar: true };

test("un poste mobile ne modifie que les rendez-vous qu’il a lui-même créés", () => {
    assert.equal(canModifyCalendarEvent(authorizedTechnician, { createdBy: "42", createdDeviceType: "mobile" }), true);
    assert.equal(canModifyCalendarEvent(authorizedTechnician, { createdBy: "7", createdDeviceType: "mobile" }), false);
    assert.equal(canModifyCalendarEvent(authorizedTechnician, { createdBy: "42", createdDeviceType: "desktop" }), false);
    assert.equal(canModifyCalendarEvent({ ...authorizedTechnician, deviceType: "desktop" }, { createdBy: "7", createdDeviceType: "desktop" }), true);
});

test("le droit Planning ouvre l’édition des clients attribués sans élargir les rôles mobiles", () => {
    assert.equal(isDedicatedMobileSession(authorizedTechnician), true);
    assert.equal(canEditAssignedClients(authorizedTechnician), true);
    assert.equal(canEditAssignedClients({ ...authorizedTechnician, canManageCalendar: false }), false);
    assert.equal(canEditAssignedClients({ role: "commercial", deviceType: "mobile", canManageCalendar: true }), false);
});

test("l’attribution client exige un rendez-vous créé depuis un poste administratif", async () => {
    let query = "";
    let parameters = [];
    const database = {
        async query(sql, values) {
            query = sql;
            parameters = values;
            return { rows: [{ allowed: true }] };
        }
    };
    assert.equal(await hasAdministrativeClientAssignment(database, "1", "client-a", "42"), true);
    assert.match(query, /event\.created_device_type = 'desktop'/);
    assert.match(query, /event\.assigned_technician_id = \$3::bigint/);
    assert.match(query, /depannhome_calendar_assignments/);
    assert.deepEqual(parameters, ["1", "client-a", "42"]);
});

test("les routes filtrent la base clients et refusent les écritures hors affectation", () => {
    const clients = read("server/clients.js");
    assert.match(clients, /completeSnapshot: restrictedMobile/);
    assert.match(clients, /event\.created_device_type = 'desktop'/);
    assert.match(clients, /app\.use\("\/api\/clients\/:clientId", asyncHandler\(requireAssignedMobileClientAccess\)\)/);
    assert.match(clients, /canEditAssignedClients\(request\.user\)/);
    assert.match(clients, /mergeAssignedMobileClient\(existingClient, submittedClient, request\.user, now\)/);
    assert.match(clients, /client\.attachments = Array\.isArray\(existing\.attachments\) \? existing\.attachments : \[\]/);
    assert.match(clients, /L’archivage et la suppression d’un client sont réservés à un poste administratif/);
});

test("les notes et notifications respectent la même affectation administrative", () => {
    const messages = read("server/messages.js");
    assert.match(messages, /hasAdministrativeClientAssignment\(getPool\(\), getAccountOwnerId\(request\), clientId, request\.user\.sub\)/);
    assert.match(messages, /event\.created_device_type='desktop'/);
    assert.match(messages, /account\.role NOT IN \('mobile_admin','team_lead','technician'\) OR EXISTS/);
    assert.match(messages, /UPDATE depannhome_messages[\s\S]*\$5::boolean = FALSE OR EXISTS/);
});

test("le cache mobile remplace son instantané et interdit la création locale de clients", () => {
    const synchronization = read("js/client-sync.js");
    const clients = read("js/clients.js");
    assert.match(synchronization, /if \(isDedicatedMobileClientSession\(\) && !existing\) return null/);
    assert.match(synchronization, /completeSnapshot = remoteResult\.data\?\.completeSnapshot === true/);
    assert.match(synchronization, /writeQueue\(getQueue\(\)\.filter\(operation => accessibleClientIds\.has\(operation\.clientId\)\)\)/);
    assert.match(synchronization, /`\$\{accountId\}:mobile:\$\{userId\}`/);
    assert.match(clients, /Modifier les coordonnées/);
    assert.match(clients, /return !isDedicatedMobileClientSession\(\) && !isClientReadOnly\(\)/);
});

test("la migration classe les rendez-vous historiques comme administratifs", () => {
    const migration = read("database/migrations/0028_mobile_appointment_origin.sql");
    const schema = read("database/schema.sql");
    assert.match(migration, /created_by BIGINT REFERENCES depannhome_users\(id\) ON DELETE SET NULL/);
    assert.match(migration, /created_device_type VARCHAR\(10\) NOT NULL DEFAULT 'desktop'/);
    assert.match(migration, /CHECK \(created_device_type IN \('desktop', 'mobile'\)\)/);
    assert.match(schema, /created_device_type VARCHAR\(10\) NOT NULL DEFAULT 'desktop'/);
});
