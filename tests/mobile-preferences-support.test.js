import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import express from "express";
import nodemailer from "nodemailer";
import { MENU_ACCESS, ROUTES } from "../js/config.js";
import { getPool } from "../server/database.js";
import { initializeSupport, registerSupportRoutes } from "../server/support.js";

const navigation = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
const schema = readFileSync(new URL("../database/schema.sql", import.meta.url), "utf8");
const migration = readFileSync(new URL("../database/migrations/0043_support_assistance_preference.sql", import.meta.url), "utf8");
const creator = readFileSync(new URL("../js/creator.js", import.meta.url), "utf8");

function sourceFunction(name) {
    const start = navigation.indexOf(`function ${name}(`);
    assert.ok(start >= 0);
    const end = navigation.indexOf("\nfunction ", start + 1);
    return navigation.slice(start, end < 0 ? undefined : end);
}

test("les préférences mobiles sont accessibles sans ouvrir les paramètres administratifs", () => {
    for (const role of ["admin", "pc_standard", "commercial", "mobile_admin", "team_lead", "technician"]) {
        const dataset = { role, deviceType: "mobile", creator: "true", localCompanyAdmin: "true" };
        const context = {
            ROUTES, MENU_ACCESS, document: { body: { dataset, classList: { contains: () => false } } },
            isCommercialMobile: () => role === "commercial", organizationFeatureEnabled: () => false
        };
        const access = runInNewContext(
            `${["isMenuAllowed", "isDesktopDevice", "canAccessSettingsSection", "isOrganizationRouteEnabled", "canAccessRoute"].map(sourceFunction).join("\n")}
            ({ route: canAccessRoute(ROUTES.settings), sections: ["personalization","users","company","security","storage","imports","groups","network","subscription","history"].map(section => [section,canAccessSettingsSection(section)]) })`, context
        );
        assert.equal(access.route, true, role);
        for (const [section, allowed] of access.sections) assert.equal(allowed, section === "personalization", `${role}: ${section}`);
    }
    assert.equal(MENU_ACCESS.navigation[ROUTES.settings].includes("accountant"), false, "pas de nouveau droit PC");
    const renderer = sourceFunction("renderSettings");
    assert.ok(renderer.indexOf("personalizationOnly: true") < renderer.indexOf("renderSettingsWorkspace"));
    assert.match(renderer, /!mobilePreferences && isLocalCompanyAdministrator\(\)/);
    assert.match(renderer, /saveSettings/);
    assert.match(renderer, /depannhome:settings-changed/);
});

test("les tickets PC et mobile partagent un choix facultatif sans consentement implicite", () => {
    const html = runInNewContext(`${sourceFunction("supportAssistanceFields")}\nsupportAssistanceFields()`);
    assert.match(html, /<option value="">Ticket uniquement/);
    assert.match(html, /value="diagnostic"/);
    assert.match(html, /value="control"/);
    assert.match(html, /Ce choix n’autorise aucun accès/);
    assert.equal((navigation.match(/\$\{supportAssistanceFields\(\)\}/g) || []).length, 2);
    assert.equal((navigation.match(/assistancePreference: form\.elements\.assistancePreference\.value/g) || []).length, 2);
    assert.match(creator, /assistancePreference: supportRequest\.assistancePreference/);
    assert.match(creator, /startForm\.elements\.accessScope\.checked = prefill\.assistancePreference === "control"/);
    assert.doesNotMatch(creator, /consentConfirmed\.checked = .*assistancePreference/);
    for (const sql of [schema, migration]) assert.match(sql, /assistance_preference VARCHAR\(20\) NOT NULL DEFAULT '' CHECK \(assistance_preference IN \('','diagnostic','control'\)\)|assistance_preference VARCHAR\(20\) NOT NULL DEFAULT ''\s+CHECK \(assistance_preference IN \('','diagnostic','control'\)\)/);
});

test("API tickets : choix validé, enregistré et transmis, sans ouvrir de session", async t => {
    const values = {
        DATABASE_URL: "postgresql://localhost/support_fixture_test", NODE_ENV: "test",
        CREATOR_USERNAMES: "fixture.creator", SUPPORT_EMAIL: "support@example.test",
        BREVO_SMTP_HOST: "smtp.example.test", BREVO_SMTP_USER: "fixture",
        BREVO_SMTP_PASSWORD: "fixture-only", BREVO_SMTP_FROM: "app@example.test"
    };
    const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    Object.assign(process.env, values);
    t.after(() => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
    const database = getPool();
    const statements = [], tickets = [], notifications = [], mails = [], warnings = [];
    let emailFails = false, insertFails = false;
    t.mock.method(database, "query", async (sql, parameters = []) => {
        statements.push(sql);
        if (/CREATE TABLE|ALTER TABLE|CREATE INDEX/.test(sql)) return { rows: [] };
        if (sql.startsWith("INSERT INTO depannhome_support_requests")) {
            if (insertFails) throw new Error("Fixture insert failure");
            tickets.push(parameters);
            return { rows: [{ id: tickets.length }] };
        }
        if (sql.startsWith("SELECT id,account_owner_id")) return { rows: [{ id: "99", ownerId: "99", username: "fixture.creator" }] };
        if (sql.startsWith("INSERT INTO depannhome_collaboration_notifications")) {
            notifications.push(parameters);
            return { rows: [{ id: notifications.length, createdAt: new Date().toISOString() }] };
        }
        if (sql.startsWith("SELECT support.id")) return { rows: tickets.map((parameters, index) => ({ id: index + 1, assistancePreference: parameters[9] })) };
        throw new Error(`Unexpected fixture query: ${sql.slice(0, 80)}`);
    });
    t.mock.method(nodemailer, "createTransport", () => ({
        async sendMail(mail) {
            if (emailFails) throw Object.assign(new Error("Fixture SMTP failure"), { code: "ESOCKET" });
            mails.push(mail);
            return { accepted: [mail.to] };
        }
    }));
    t.mock.method(console, "warn", (...args) => warnings.push(args));
    await initializeSupport();
    assert.ok(statements.some(sql => /ADD COLUMN IF NOT EXISTS assistance_preference/.test(sql)));
    const app = express();
    app.use(express.json());
    const authenticate = (request, response, next) => {
        if (request.get("X-Fixture-Auth") === "false") return response.status(401).json({ message: "Connexion requise." });
        request.user = { sub: "12", accountOwnerId: "7", username: "fixture.member", fullName: "Test <member>", email: "member@example.test" };
        next();
    };
    const requireCreator = (request, response, next) => request.get("X-Fixture-Creator") === "true" ? next() : response.status(403).json({ message: "Accès réservé." });
    registerSupportRoutes(app, authenticate, requireCreator);
    app.use((error, _request, response, _next) => response.status(500).json({ message: error.message }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    t.after(async () => { await new Promise(resolve => server.close(resolve)); await database.end(); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const send = (body, headers = {}) => fetch(`${base}/api/support/requests`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    for (const preference of [undefined, "", "diagnostic", "control"]) {
        const body = { message: "Description de mon problème.", assistancePreference: preference };
        const response = await send(body);
        assert.equal(response.status, 202);
        const expected = preference || "";
        assert.equal(tickets.at(-1)[9], expected);
        assert.equal(tickets.at(-1)[0], "7", "entreprise dérivée de la session");
        assert.equal(JSON.parse(notifications.at(-1)[7]).assistancePreference, expected);
        assert.match(mails.at(-1).html, /Test &lt;member&gt;/);
        if (preference) {
            assert.match(mails.at(-1).text, /acceptation séparée/);
            assert.match(notifications.at(-1)[6], preference === "control" ? /Prise en main souhaitée/ : /Diagnostic souhaité/);
        }
    }
    const count = tickets.length;
    for (const preference of [null, "admin", "CONTROL", 1, true, {}, []]) {
        const response = await send({ message: "Description de mon problème.", assistancePreference: preference });
        assert.equal(response.status, 400);
        assert.match((await response.json()).message, /mode d’assistance valide/);
    }
    assert.equal(tickets.length, count);
    assert.equal((await send({ message: "trop court", assistancePreference: "control" }, { "X-Fixture-Auth": "false" })).status, 401);
    assert.equal((await send({ category: "Autre", subject: "Test", technicalContext: { Version: "fixture" }, message: "Ticket depuis le mobile.", assistancePreference: "control" })).status, 202);
    assert.equal((await fetch(`${base}/api/creator/support-requests`)).status, 403);
    const list = await fetch(`${base}/api/creator/support-requests`, { headers: { "X-Fixture-Creator": "true" } });
    assert.equal((await list.json()).requests.at(-1).assistancePreference, "control");
    assert.doesNotMatch(statements.join("\n"), /INSERT INTO depannhome_creator_support_sessions|accepted_at|access_scope/);
    emailFails = true;
    assert.equal((await send({ message: "Conserver le ticket même sans SMTP.", assistancePreference: "diagnostic" })).status, 202);
    assert.equal(warnings.at(-1)[1].code, "ESOCKET");
    insertFails = true;
    assert.equal((await send({ message: "Refuser le succès si la base échoue." })).status, 500);
});
