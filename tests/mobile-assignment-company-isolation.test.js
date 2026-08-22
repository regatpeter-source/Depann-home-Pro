import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    PARTNER_MISSION_ASSIGNMENT_ROLES,
    validateAssignedCompanyMembers
} from "../server/member-assignment.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = relativePath => fs.readFileSync(path.join(root, relativePath), "utf8");

function databaseWithMembers(members) {
    return {
        async query(_sql, [ids, ownerId, roles]) {
            const selected = members.filter(member => ids.includes(member.id)
                && member.ownerId === Number(ownerId)
                && member.active
                && (!roles.length || roles.includes(member.role)));
            return { rowCount: selected.length, rows: selected };
        }
    };
}

const members = [
    { id: 11, ownerId: 1, role: "technician", active: true },
    { id: 12, ownerId: 1, role: "mobile_admin", active: true },
    { id: 13, ownerId: 1, role: "admin", active: true },
    { id: 14, ownerId: 1, role: "pc_standard", active: true },
    { id: 21, ownerId: 2, role: "technician", active: true },
    { id: 22, ownerId: 2, role: "team_lead", active: false }
];

test("une affectation accepte uniquement un membre actif de l’entreprise de l’intervention", async () => {
    const database = databaseWithMembers(members);
    assert.equal(await validateAssignedCompanyMembers(database, 1, [11, 12, 13, 14]), "");
    assert.match(await validateAssignedCompanyMembers(database, 1, [21]), /autre entreprise/);
    assert.match(await validateAssignedCompanyMembers(database, 2, [22]), /inactif/);
});

test("une mission partenaire refuse un administrateur et tout technicien d’une autre société", async () => {
    const database = databaseWithMembers(members);
    assert.equal(await validateAssignedCompanyMembers(database, 1, [11, 12], PARTNER_MISSION_ASSIGNMENT_ROLES), "");
    assert.notEqual(await validateAssignedCompanyMembers(database, 1, [13], PARTNER_MISSION_ASSIGNMENT_ROLES), "");
    assert.notEqual(await validateAssignedCompanyMembers(database, 1, [21], PARTNER_MISSION_ASSIGNMENT_ROLES), "");
});

test("le serveur revalide toutes les affectations et les protège aussi par déclencheur SQL", () => {
    const calendar = read("server/calendar.js");
    const missions = read("server/partner-missions.js");
    const auth = read("server/auth.js");
    assert.match(calendar, /validateAssignedCompanyMembers\(getPool\(\), accountOwnerId, memberIds\)/);
    assert.match(calendar, /depannhome_calendar_event_assignment_company/);
    assert.match(calendar, /depannhome_calendar_assignment_company/);
    assert.match(missions, /validateAssignedCompanyMembers\(connection, ownerId, technicianId \? \[technicianId\] : \[\], PARTNER_MISSION_ASSIGNMENT_ROLES\)/);
    assert.match(missions, /depannhome_partner_mission_assignment_company/);
    assert.match(auth, /WHERE account_owner_id = \$1 AND is_active = TRUE/);
    assert.equal(missions.match(/async function acceptMission\(/g)?.length, 1);
    const calendarMembersSql = auth.match(/app\.get\("\/api\/auth\/calendar-members"[\s\S]*?response\.json\(\{ members: rows \}\);/u)?.[0] || "";
    assert.doesNotMatch(calendarMembersSql, /const groupCompany/);
});

test("même un Administrateur mobile ne reçoit jamais le contexte multi-entreprises", () => {
    const auth = read("server/auth.js");
    const permissions = read("server/workstation-permissions.js");
    assert.match(auth, /device\.device_type === "desktop" \? await resolveGroupCompany/);
    assert.match(auth, /authDevice\.device_type === "desktop" \? await resolveGroupCompany/);
    assert.match(permissions, /user\.deviceType !== "desktop"/);
});
