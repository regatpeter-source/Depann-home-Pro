import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calendarEventOrigin, canManageCalendarSchedule, canModifyCalendarEvent } from "../server/calendar.js";
import { canEditAssignedClients, hasAdministrativeClientAssignment, hasAssignedClientScope, isDedicatedMobileSession } from "../server/mobile-client-access.js";
import { getLocalClients, saveLocalClient, synchronizeClients } from "../js/client-sync.js";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const authorizedTechnician = { sub: "42", role: "technician", deviceType: "mobile", canManageCalendar: true };

test("un poste mobile ne modifie que les rendez-vous qu’il a lui-même créés", () => {
    assert.equal(canModifyCalendarEvent(authorizedTechnician, { createdBy: "42", createdDeviceType: "mobile" }), true);
    assert.equal(canModifyCalendarEvent(authorizedTechnician, { createdBy: "7", createdDeviceType: "mobile" }), false);
    assert.equal(canModifyCalendarEvent(authorizedTechnician, { createdBy: "42", createdDeviceType: "desktop" }), false);
    assert.equal(canModifyCalendarEvent({ ...authorizedTechnician, deviceType: "desktop" }, { createdBy: "7", createdDeviceType: "desktop" }), true);
});

test("le Poste Admin Mobile planifie comme un poste PC et crée des rendez-vous administratifs", () => {
    const mobileAdministrator = { sub: "9", role: "mobile_admin", deviceType: "mobile", canManageCalendar: false };
    assert.equal(canManageCalendarSchedule(mobileAdministrator), true);
    assert.equal(canModifyCalendarEvent(mobileAdministrator, { createdBy: "7", createdDeviceType: "desktop" }), true);
    assert.equal(canModifyCalendarEvent(mobileAdministrator, { createdBy: "42", createdDeviceType: "mobile" }), true);
    assert.equal(calendarEventOrigin(mobileAdministrator), "desktop");
    assert.equal(calendarEventOrigin({ sub: "1", role: "admin", deviceType: "mobile" }), "desktop");
    assert.equal(calendarEventOrigin(authorizedTechnician), "mobile");
    assert.equal(calendarEventOrigin({ ...authorizedTechnician, role: "team_lead" }), "mobile");

    const server = read("server/calendar.js");
    assert.match(server, /request\.user\.sub, calendarEventOrigin\(request\.user\)/);
    assert.doesNotMatch(server, /request\.user\.sub, request\.user\.deviceType/);

    const client = read("js/calendar.js");
    assert.match(client, /function hasRestrictedMobileCalendar\(\) \{\s*return isDedicatedMobileCalendar\(\) && !isMobileAdministrator\(\)/);
    assert.match(client, /data-calendar-mobile-date="\$\{date\}"/);
    assert.match(client, /closest\("\[data-calendar-event\], \[data-calendar-mobile-add\]"\)\) return;\s*selectedEvent = newEventForDate\(day\.dataset\.calendarMobileDate\)/);

    const migration = read("database/migrations/0045_mobile_admin_appointment_origin.sql");
    assert.match(migration, /SET created_device_type = 'desktop'/);
    assert.match(migration, /role IN \('admin', 'mobile_admin'\)/);
});

test("le droit Planning ouvre l’édition des clients attribués sans élargir les rôles mobiles", () => {
    assert.equal(isDedicatedMobileSession(authorizedTechnician), true);
    assert.equal(canEditAssignedClients(authorizedTechnician), true);
    assert.equal(canEditAssignedClients({ ...authorizedTechnician, canManageCalendar: false }), false);
    assert.equal(canEditAssignedClients({ role: "commercial", deviceType: "mobile", canManageCalendar: true }), false);
});

test("le Poste Admin Mobile accède à tous les clients, sans archivage ni suppression", () => {
    const mobileAdministrator = { sub: "9", role: "mobile_admin", deviceType: "mobile", canManageCalendar: false };
    assert.equal(isDedicatedMobileSession(mobileAdministrator), true);
    assert.equal(hasAssignedClientScope(mobileAdministrator), false);
    assert.equal(hasAssignedClientScope(authorizedTechnician), true);
    assert.equal(hasAssignedClientScope({ ...authorizedTechnician, role: "team_lead" }), true);
    assert.equal(hasAssignedClientScope({ ...authorizedTechnician, deviceType: "desktop" }), false);

    const serverClients = read("server/clients.js");
    assert.match(serverClients, /const restrictedMobile = hasAssignedClientScope\(user\)/);
    assert.match(serverClients, /function requireClientLifecycleAccess\(request, response, next\) \{\s+if \(isDedicatedMobileSession\(request\.user\)\)/);
    assert.match(read("server/messages.js"), /account\.role NOT IN \('team_lead','technician'\) OR EXISTS/);

    const synchronization = read("js/client-sync.js");
    assert.match(synchronization, /if \(hasAssignedClientScope\(\) && !existing\) return null/);
    assert.match(synchronization, /isDedicatedMobileClientSession\(\) && !hasAssignedClientScope\(\) \? ":all-clients" : ""/);

    const clients = read("js/clients.js");
    assert.match(clients, /return !hasAssignedClientScope\(\) && !isClientReadOnly\(\)/);
    assert.match(clients, /function canManageClientLifecycle\(\) \{\s+return !isDedicatedMobileClientSession\(\) && !isClientReadOnly\(\)/);
    assert.match(clients, /id="createClientQuote"[\s\S]*id="createClientInvoice"[\s\S]*\$\{canManageClientLifecycle\(\) \? '<button[^']*id="deleteSelectedClient"/);
});

test("le cache du Poste Admin Mobile crée des clients et reprend tout le portefeuille malgré l’ancien curseur", async () => {
    const storage = new Map([
        ["depannHomePro:clients:1:mobile:9", JSON.stringify([{ id: "client-assigned", name: "Client attribué", updatedAt: "2026-01-01T00:00:00.000Z" }])],
        ["depannHomePro:clients-sync-cursor:1:mobile:9", "2026-01-02T00:00:00.000Z"]
    ]);
    const requests = [];
    const remoteClients = [
        { id: "client-assigned", name: "Client attribué", updatedAt: "2026-01-01T00:00:00.000Z" },
        { id: "client-other", name: "Autre client", updatedAt: "2025-12-01T00:00:00.000Z" }
    ];
    globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
    globalThis.document = { body: { dataset: { deviceType: "mobile", role: "mobile_admin", accountId: "1", userId: "9", canManageCalendar: "false" }, classList: { contains: () => false } } };
    globalThis.window = { setTimeout: () => 0, clearTimeout: () => {}, dispatchEvent: () => true };
    Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });
    globalThis.fetch = async (url, options = {}) => {
        requests.push(`${options.method || "GET"} ${url}`);
        const data = options.method === "PUT" ? { client: JSON.parse(options.body).client } : { clients: url.includes("since=") ? [] : remoteClients, deletedClientIds: [], cursor: "2026-02-01T00:00:00.000Z", completeSnapshot: false };
        return { ok: true, status: 200, json: async () => data };
    };

    assert.ok(saveLocalClient({ id: "client-new", name: "Nouveau client mobile" }));
    assert.deepEqual(await synchronizeClients(), { ok: true });
    assert.equal(requests[0], "GET /api/clients");
    assert.ok(requests.includes("PUT /api/clients/client-new"));
    assert.deepEqual(getLocalClients().map(client => client.id).sort(), ["client-assigned", "client-new", "client-other"]);
    assert.equal(storage.get("depannHomePro:clients-sync-cursor:1:mobile:9:all-clients"), "2026-02-01T00:00:00.000Z");

    document.body.dataset = { deviceType: "mobile", role: "technician", accountId: "1", userId: "10", canManageCalendar: "true" };
    assert.equal(saveLocalClient({ id: "client-technician", name: "Client technicien" }), null);
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
    assert.match(messages, /account\.role NOT IN \('team_lead','technician'\) OR EXISTS/);
    assert.match(messages, /UPDATE depannhome_messages[\s\S]*\$5::boolean = FALSE OR EXISTS/);
});

test("le cache mobile remplace son instantané et interdit la création locale de clients", () => {
    const synchronization = read("js/client-sync.js");
    const clients = read("js/clients.js");
    assert.match(synchronization, /if \(hasAssignedClientScope\(\) && !existing\) return null/);
    assert.match(synchronization, /completeSnapshot = remoteResult\.data\?\.completeSnapshot === true/);
    assert.match(synchronization, /writeQueue\(getQueue\(\)\.filter\(operation => accessibleClientIds\.has\(operation\.clientId\)\)\)/);
    assert.match(synchronization, /`\$\{accountId\}:mobile:\$\{userId\}`/);
    assert.match(clients, /Modifier les coordonnées/);
    assert.match(clients, /return !hasAssignedClientScope\(\) && !isClientReadOnly\(\)/);
});

test("la migration classe les rendez-vous historiques comme administratifs", () => {
    const migration = read("database/migrations/0028_mobile_appointment_origin.sql");
    const schema = read("database/schema.sql");
    assert.match(migration, /created_by BIGINT REFERENCES depannhome_users\(id\) ON DELETE SET NULL/);
    assert.match(migration, /created_device_type VARCHAR\(10\) NOT NULL DEFAULT 'desktop'/);
    assert.match(migration, /CHECK \(created_device_type IN \('desktop', 'mobile'\)\)/);
    assert.match(schema, /created_device_type VARCHAR\(10\) NOT NULL DEFAULT 'desktop'/);
});
