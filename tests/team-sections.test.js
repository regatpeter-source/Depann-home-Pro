import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const database = readFileSync(new URL("../server/database.js", import.meta.url), "utf8");
const auth = readFileSync(new URL("../server/auth.js", import.meta.url), "utf8");
const navigation = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
const calendar = readFileSync(new URL("../js/calendar.js", import.meta.url), "utf8");

test("les anciens pôles sont migrés vers une liste de sections", () => {
    assert.match(database, /departments JSONB NOT NULL DEFAULT '\[\]'::jsonb/);
    assert.match(database, /SET departments = jsonb_build_array\(department\)/);
    assert.match(database, /JSON\.stringify\(departments\)/);
});

test("la création et la modification acceptent plusieurs sections métier", () => {
    assert.match(auth, /cleanDepartments\(request\.body\?\.departments, request\.body\?\.department\)/);
    assert.match(auth, /Choisissez au moins une section métier/);
    assert.match(auth, /departments = \$9::jsonb/);
    assert.match(navigation, /const TEAM_SECTION_OPTIONS = \["Dépannage", "Recherche de fuite", "Plomberie", "Électricité", "Menuiserie"/);
    assert.match(navigation, /input type="checkbox" name="departments"/);
    assert.match(navigation, /Modifier les sections/);
    assert.doesNotMatch(navigation, /window\.prompt\(`Pôle de/);
});

test("chaque section est affichée comme un badge et proposée dans le planning", () => {
    assert.match(navigation, /memberDepartments\(member\)\.map\(section => `<span class="team-department-badge"/);
    assert.match(calendar, /Array\.isArray\(technician\.departments\)/);
    assert.match(calendar, /departments\.length \? departments : \["Non classé"\]/);
    assert.match(calendar, /groups\.get\(department\)\.push\(technician\)/);
});