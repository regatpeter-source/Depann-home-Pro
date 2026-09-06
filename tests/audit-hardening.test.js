import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("la lecture du planning qualifie l’affectation malgré la jointure des missions", () => {
    const calendar = source("server/calendar.js");
    assert.match(calendar, /event\.assigned_technician_id AS "assignedTechnicianId"/);
    assert.doesNotMatch(calendar, /\n\s+assigned_technician_id AS "assignedTechnicianId"/);
});

test("l’envoi d’une facture valide sa transaction après la mise à jour", () => {
    const billing = source("server/billing.js");
    const route = billing.slice(billing.indexOf('app.post("/api/billing/documents/:documentId/email"'), billing.indexOf('app.get("/api/billing/documents/:documentId/export"'));
    assert.ok(route.indexOf('query("BEGIN")') < route.indexOf("sendDocumentEmail"));
    assert.ok(route.indexOf("sendDocumentEmail") < route.indexOf('query("COMMIT")'));
    assert.match(route, /query\("ROLLBACK"\)/);
});

test("le Comptable reste en consultation sur la comptabilité et les achats", () => {
    const accounting = source("server/accounting.js");
    const electronicInvoicing = source("server/electronic-invoicing.js");
    const purchases = source("server/purchases.js");
    for (const route of ["aids", "financial-data", "post", "credits", "settlements", "settings"]) {
        assert.match(accounting, new RegExp(`api/accounting[^\\n]*${route}[^\\n]*requireAccountingWriteAccess`));
    }
    assert.match(electronicInvoicing, /app\.use\("\/api\/accounting\/e-invoicing"[\s\S]*requireCompanyAdministrator/);
    assert.match(electronicInvoicing, /documents\/:documentId\/transmit/);
    assert.match(accounting, /request\.user\?\.role !== "accountant"/);
    assert.match(purchases, /\["admin", "pc_standard", "commercial", "mobile_admin"\]/);
    assert.match(purchases, /\["admin", "pc_standard", "commercial", "accountant", "mobile_admin"\]/);
});

test("les missions archivées sont exclues des accès internes et externes", () => {
    const missions = source("server/partner-missions.js");
    const dialogue = source("server/partner-dialogue.js");
    assert.match(missions, /findMission[\s\S]*?mission\.deleted_at IS NULL/);
    assert.match(missions, /lockMission[\s\S]*?mission\.deleted_at IS NULL/);
    assert.match(dialogue, /externalMission[\s\S]*?mission\.deleted_at IS NULL/);
});

test("les transitions et planifications de missions sont verrouillées", () => {
    const missions = source("server/partner-missions.js");
    assert.match(missions, /STATUS_TRANSITIONS/);
    assert.match(missions, /FOR UPDATE/);
    assert.match(missions, /Transition impossible/);
    assert.match(missions, /pg_advisory_xact_lock/);
    assert.match(missions, /assertAvailableSchedule/);
    assert.match(missions, /partner_mission_assigned/);
});

test("l’interface Comptable masque les commandes d’écriture", () => {
    const accounting = source("js/accounting.js");
    const purchases = source("js/purchases.js");
    assert.match(accounting, /Consultation comptable/);
    assert.match(accounting, /isAccountingReadOnly\(\)/);
    assert.match(accounting, /aidReceivableAccount/);
    assert.match(purchases, /presentation\.readOnly/);
});

test("les groupes et administrateurs résistent aux mises à jour partielles ou concurrentes", () => {
    const auth = source("server/auth.js");
    const database = source("server/database.js");
    const groups = source("server/groups.js");
    assert.match(database, /createUser\([\s\S]*database = getPool\(\)/);
    assert.match(groups, /app\.post\("\/api\/groups\/companies"[\s\S]*client\.query\("BEGIN"\)[\s\S]*createUser\([\s\S]*client\)[\s\S]*client\.query\("COMMIT"\)/);
    assert.match(groups, /app\.patch\("\/api\/groups\/companies\/:companyId"[\s\S]*groupCompany\(groupId, companyId, true, client\)/);
    assert.match(auth, /lockAccountOwner\(database, ownerId\)[\s\S]*ensureActiveAdministratorRemains\(ownerId, memberId, database\)/);
    assert.match(auth, /reset-password[\s\S]*depannhome_auth_devices SET status='rejected',session_id=NULL/);
});
