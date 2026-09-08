import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("le filtre technicien fusionne les affectations multiples et l’affectation principale historique", () => {
    const calendar = read("js/calendar.js");
    const helper = calendar.slice(calendar.indexOf("function getAssignedTechnicianIds"), calendar.indexOf("function assignedTechnicianNames"));
    assert.match(helper, /event\?\.assignedTechnicianIds/);
    assert.match(helper, /event\?\.assignedTechnicians/);
    assert.match(helper, /event\?\.assignedTechnicianId/);
    assert.match(helper, /const assigned = \[/);
    assert.match(helper, /new Set/);
});

test("les vues personnelles acceptent l’affectation principale lorsque la table multiple est vide", () => {
    const server = read("server/calendar.js");
    assert.match(server, /event\.assigned_technician_id = \$4::bigint/);
    assert.match(server, /event\.assigned_technician_id = \$5::bigint/);
    assert.match(server, /assigned_technician_id = \$4::bigint/);
});