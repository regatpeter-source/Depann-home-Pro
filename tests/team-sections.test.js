import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const database = readFileSync(new URL("../server/database.js", import.meta.url), "utf8");
const auth = readFileSync(new URL("../server/auth.js", import.meta.url), "utf8");
const navigation = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
const calendar = readFileSync(new URL("../js/calendar.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const schema = readFileSync(new URL("../database/schema.sql", import.meta.url), "utf8");
const migration = readFileSync(new URL("../database/migrations/0014_company_teams.sql", import.meta.url), "utf8");

test("les anciens pôles sont migrés vers une liste de sections", () => {
    assert.match(database, /departments JSONB NOT NULL DEFAULT '\[\]'::jsonb/);
    assert.match(database, /SET departments = jsonb_build_array\(department\)/);
    assert.match(database, /JSON\.stringify\(departments\)/);
});

test("la création et la modification acceptent plusieurs sections métier", () => {
    assert.match(auth, /cleanDepartments\(request\.body\?\.departments, request\.body\?\.department\)/);
    assert.match(auth, /Choisissez au moins une section métier/);
    assert.match(auth, /departments = \$11::jsonb/);
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

test("les sections du technicien sont affichées sur son poste mobile", () => {
    assert.match(database, /user_account\.department, user_account\.departments/);
    assert.match(auth, /departments: cleanDepartments\(user\.departments, user\.department\)/);
    assert.match(index, /id="mobileUserSections"/);
    assert.match(app, /mobileUserSections\.hidden = user\.deviceType !== "mobile"/);
    assert.match(app, /dataset\.userDepartments = JSON\.stringify\(sections\)/);
    assert.match(navigation, /<strong>Sections métier<\/strong>/);
});

test("les équipes personnalisées sont isolées par entreprise et leurs adhésions sont contrôlées", () => {
    for (const sql of [schema, migration]) {
        assert.match(sql, /CREATE TABLE IF NOT EXISTS depannhome_teams/);
        assert.match(sql, /owner_id BIGINT NOT NULL REFERENCES depannhome_users\(id\) ON DELETE CASCADE/);
        assert.match(sql, /CREATE TABLE IF NOT EXISTS depannhome_team_memberships/);
        assert.match(sql, /team\.owner_id=member\.account_owner_id/);
        assert.match(sql, /member\.role IN \('technician','team_lead'\)/);
    }
});

test("une équipe peut être créée pendant ou après l’enregistrement d’un technicien", () => {
    assert.match(auth, /app\.post\("\/api\/auth\/teams", requireAccountAdministrator/);
    assert.match(auth, /prepareMemberTeamIds\(connection, ownerId, request\.body\?\.teamIds, request\.body\?\.newTeam\)/);
    assert.match(auth, /replaceMemberTeams\(connection, ownerId, member\.id, teamIds\)/);
    assert.match(navigation, /name="newTeamName"/);
    assert.match(navigation, /Modifier les équipes/);
});

test("le planning permet de choisir une équipe complète puis d’affiner les techniciens", () => {
    assert.match(calendar, /data-calendar-team-assignment/);
    assert.match(calendar, /teamAssignmentInputs\.forEach/);
    assert.match(calendar, /if \(memberIds\.has\(String\(memberInput\.value\)\)\) memberInput\.checked = input\.checked/);
    assert.match(calendar, /assignedTechnicianIds: form\.getAll\("assignedTechnicianIds"\)/);
});