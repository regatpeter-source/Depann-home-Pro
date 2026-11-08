import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import nodemailer from "nodemailer";
import QRCode from "qrcode";
import { buildMobileWelcomeEmail } from "../server/email.js";
import { getPool } from "../server/database.js";
import { registerAuthRoutes } from "../server/auth.js";

function configureEnvironment(t) {
    const values = {
        NODE_ENV: "test", DATABASE_URL: "postgresql://localhost/mobile_onboarding_test",
        PUBLIC_BASE_URL: "https://application.example.test", RENDER_EXTERNAL_URL: "",
        BREVO_SMTP_HOST: "smtp.example.test", BREVO_SMTP_USER: "fixture-user",
        BREVO_SMTP_PASSWORD: "fixture-only", BREVO_SMTP_FROM: "application@example.test"
    };
    const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    Object.assign(process.env, values);
    t.after(() => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
}

test("l’e-mail mobile utilise une origine configurée et échappe les informations du compte", t => {
    configureEnvironment(t);
    const mail = buildMobileWelcomeEmail({ recipient: "member@example.test", name: "<img src=x>", username: "test.member" });
    assert.equal(mail.recipient, "member@example.test");
    assert.match(mail.html, /&lt;img src=x&gt;/);
    assert.doesNotMatch(mail.html, /<img src=x>/);
    assert.match(mail.text, /https:\/\/application\.example\.test\/installer-mobile/);
    assert.match(mail.html, /href="https:\/\/application\.example\.test\/connexion"/);
    assert.match(mail.text, /test\.member/);
    assert.match(mail.text, /canal sécurisé distinct/);
    for (const url of ["", "javascript:alert(1)", "https://user:fixture@example.test", "http://application.example.test"]) {
        process.env.PUBLIC_BASE_URL = url;
        assert.throws(() => buildMobileWelcomeEmail({}), { code: "PUBLIC_BASE_URL_INVALID" });
    }
    process.env.PUBLIC_BASE_URL = "http://127.0.0.1:3000";
    assert.match(buildMobileWelcomeEmail({}).text, /http:\/\/127\.0\.0\.1:3000\/installer-mobile/);
    process.env.NODE_ENV = "production";
    assert.throws(() => buildMobileWelcomeEmail({}), { code: "PUBLIC_BASE_URL_INVALID" });
    process.env.PUBLIC_BASE_URL = "";
    process.env.RENDER_EXTERNAL_URL = "https://service.example.test";
    assert.match(buildMobileWelcomeEmail({}).text, /https:\/\/service\.example\.test\/installer-mobile/);
});

test("création et renvoi du guide mobile préservent le compte, les droits et l’isolation entreprise", async t => {
    configureEnvironment(t);
    const state = { members: new Map(), events: [], mails: [], warnings: [], failInsert: false, failEmail: false, rejectEmail: false };
    let nextId = 10;
    const database = getPool();
    const query = async (sql, values = []) => {
        const text = sql.trim();
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text)) {
            state.events.push(text);
            return { rows: [] };
        }
        if (text.includes("FROM depannhome_organizations")) return { rows: [{ accountOwnerId: "1", interfaceType: "standard", subscriptionTier: "pro" }] };
        if (text.includes('AS "maxPcUsers"')) return { rows: [{ maxPcUsers: 20, maxMobileUsers: 20, activePcUsers: 1, activeMobileUsers: 0 }] };
        if (text.startsWith("INSERT INTO depannhome_users")) {
            if (state.failInsert) throw Object.assign(new Error("Fixture duplicate"), { code: "23505" });
            const member = {
                id: nextId++, username: values[0], role: values[2], account_owner_id: values[3],
                full_name: values[4], phone: values[5], email: values[6], departments: JSON.parse(values[8]),
                is_active: true
            };
            state.members.set(member.id, member);
            return { rows: [member] };
        }
        if (text.startsWith("SELECT role FROM depannhome_users")) return { rows: [state.members.get(Number(values[0]))] };
        if (text.startsWith("DELETE FROM depannhome_team_memberships") || text.startsWith("INSERT INTO depannhome_member_audit")) return { rows: [] };
        if (text.startsWith("SELECT id, username, role, full_name, email, is_active")) {
            assert.match(text, /account_owner_id=\$2 AND id<>\$2/);
            const member = state.members.get(Number(values[0]));
            return { rows: member && String(member.account_owner_id) === String(values[1]) ? [member] : [] };
        }
        throw new Error("Unexpected fixture database query");
    };
    t.mock.method(database, "query", query);
    t.mock.method(database, "connect", async () => ({ query, release() { state.events.push("RELEASE"); } }));
    t.mock.method(console, "warn", (...values) => state.warnings.push(values));
    t.mock.method(nodemailer, "createTransport", () => ({
        async sendMail(mail) {
            if (state.events.includes("BEGIN")) {
                assert.ok(state.events.indexOf("COMMIT") > state.events.indexOf("BEGIN"));
                assert.equal(state.events.at(-1), "RELEASE", "L’envoi doit commencer après libération de la transaction.");
            }
            state.mails.push(mail);
            if (state.failEmail) throw Object.assign(new Error("Fixture SMTP failure"), { code: "ESOCKET" });
            return { accepted: state.rejectEmail ? [] : [mail.to] };
        }
    }));
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
        if (request.get("X-Test-No-User") !== "true") {
            request.user = {
                sub: "1", accountOwnerId: request.get("X-Test-Owner") || "1",
                role: request.get("X-Test-Role") || "admin", deviceType: request.get("X-Test-Device") || "desktop"
            };
        }
        next();
    });
    registerAuthRoutes(app);
    app.use((error, _request, response, _next) => response.status(500).json({ message: error.message }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    t.after(async () => {
        await new Promise(resolve => server.close(resolve));
        await database.end();
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const send = async (path, body, headers = {}) => {
        const response = await fetch(`${base}${path}`, {
            method: "POST", headers: { "Content-Type": "application/json", ...headers },
            body: JSON.stringify(body || {})
        });
        return { status: response.status, body: await response.json() };
    };
    const memberInput = role => ({
        role, username: `fixture.${role}`, password: "Temporary-Fixture-123!",
        fullName: "Membre fictif", phone: "0102030405", email: "member@example.test", departments: ["Plomberie"]
    });
    await t.test("le QR code contient exactement le guide public et fonctionne sans SMTP pour les rôles PC", async () => {
        delete process.env.BREVO_SMTP_HOST;
        const expectedUrl = "https://application.example.test/installer-mobile";
        const expectedQr = await QRCode.toDataURL(expectedUrl, { width: 260, margin: 4, errorCorrectionLevel: "M" });
        for (const role of ["admin", "pc_standard", "commercial", "accountant"]) {
            const response = await fetch(`${base}/api/auth/mobile-installation`, { headers: { "X-Test-Role": role, Host: "untrusted.example.test" } });
            assert.equal(response.status, 200);
            assert.equal(response.headers.get("Cache-Control"), "no-store");
            const payload = await response.json();
            assert.deepEqual(Object.keys(payload).sort(), ["installationUrl", "qrCodeDataUrl"]);
            assert.equal(payload.installationUrl, expectedUrl);
            assert.equal(payload.qrCodeDataUrl, expectedQr);
            const png = Buffer.from(payload.qrCodeDataUrl.split(",")[1], "base64");
            assert.equal(png.subarray(1, 4).toString(), "PNG");
            assert.equal(png.readUInt32BE(16), 260);
            assert.equal(png.readUInt32BE(20), 260);
        }
        assert.equal(state.mails.length, 0);
        process.env.BREVO_SMTP_HOST = "smtp.example.test";
    });
    await t.test("le QR code refuse les sessions mobiles, non authentifiées et les origines mal configurées", async () => {
        for (const [headers, status] of [
            [{ "X-Test-No-User": "true" }, 401],
            [{ "X-Test-Device": "mobile" }, 403],
            [{ "X-Test-Role": "technician" }, 403]
        ]) {
            const response = await fetch(`${base}/api/auth/mobile-installation`, { headers });
            assert.equal(response.status, status);
        }
        process.env.PUBLIC_BASE_URL = "";
        const response = await fetch(`${base}/api/auth/mobile-installation`);
        assert.equal(response.status, 503);
        assert.match((await response.json()).message, /PUBLIC_BASE_URL/);
        process.env.PUBLIC_BASE_URL = "https://application.example.test";
    });
    let mobileId;
    await t.test("chaque rôle mobile reçoit le guide après commit, sans mot de passe ni autorisation", async () => {
        for (const role of ["mobile_admin", "team_lead", "technician", "commercial"]) {
            state.events = [];
            const result = await send("/api/auth/members", memberInput(role));
            assert.equal(result.status, 201);
            assert.equal(result.body.mobileOnboarding.emailSent, true);
            assert.equal(result.body.mobileOnboarding.installationUrl, "/installer-mobile");
            assert.match(state.mails.at(-1).text, /autoriser votre appareil/);
            assert.doesNotMatch(JSON.stringify(state.mails.at(-1)), /Temporary-Fixture-123/);
            mobileId = result.body.member.id;
        }
        assert.equal(state.mails.length, 4);
    });
    await t.test("les postes uniquement PC ne reçoivent pas d’e-mail mobile", async () => {
        for (const role of ["admin", "pc_standard"]) {
            state.events = [];
            const result = await send("/api/auth/members", memberInput(role));
            assert.equal(result.status, 201);
            assert.equal(result.body.mobileOnboarding, undefined);
        }
        assert.equal(state.mails.length, 4);
    });
    await t.test("une création refusée ou annulée n’envoie aucun e-mail", async () => {
        const invalid = await send("/api/auth/members", { ...memberInput("technician"), email: "invalid" });
        assert.equal(invalid.status, 400);
        const missingEmail = await send("/api/auth/members", { ...memberInput("technician"), email: "" });
        assert.equal(missingEmail.status, 400);
        state.failInsert = true;
        state.events = [];
        const duplicate = await send("/api/auth/members", memberInput("technician"));
        state.failInsert = false;
        assert.equal(duplicate.status, 409);
        assert.ok(state.events.includes("ROLLBACK"));
        assert.equal(state.mails.length, 4);
    });
    await t.test("un échec SMTP est visible mais conserve la création validée", async () => {
        state.failEmail = true;
        state.events = [];
        const result = await send("/api/auth/members", memberInput("mobile_admin"));
        state.failEmail = false;
        assert.equal(result.status, 201);
        assert.equal(result.body.mobileOnboarding.emailSent, false);
        assert.ok(state.members.has(Number(result.body.member.id)));
        assert.ok(state.events.includes("COMMIT"));
        assert.ok(!state.events.includes("ROLLBACK"));
        assert.ok(state.warnings.some(values => values.includes("ESOCKET")));
    });
    await t.test("une configuration absente ou un refus SMTP n’est pas présenté comme un envoi réussi", async () => {
        delete process.env.BREVO_SMTP_HOST;
        state.events = [];
        let result = await send("/api/auth/members", memberInput("mobile_admin"));
        assert.equal(result.status, 201);
        assert.equal(result.body.mobileOnboarding.emailSent, false);
        assert.match(result.body.mobileOnboarding.message, /Brevo SMTP/);
        process.env.BREVO_SMTP_HOST = "smtp.example.test";
        state.rejectEmail = true;
        state.events = [];
        result = await send("/api/auth/members", memberInput("mobile_admin"));
        state.rejectEmail = false;
        assert.equal(result.body.mobileOnboarding.emailSent, false);
        assert.ok(state.warnings.some(values => values.includes("SMTP_RECIPIENT_REJECTED")));
    });
    await t.test("le renvoi reste réservé à l’administrateur et à son entreprise", async () => {
        const count = state.mails.length;
        const path = `/api/auth/members/${mobileId}/mobile-welcome`;
        assert.equal((await send(path, {}, { "X-Test-Role": "technician" })).status, 403);
        assert.equal((await send(path, {}, { "X-Test-Owner": "2" })).status, 404);
        assert.equal((await send("/api/auth/members/invalid/mobile-welcome")).status, 400);
        assert.equal(state.mails.length, count);
        state.events = [];
        assert.equal((await send(path)).status, 200);
        state.failEmail = true;
        const failed = await send(path);
        state.failEmail = false;
        assert.equal(failed.status, 503);
        assert.equal(failed.body.mobileOnboarding.emailSent, false);
        state.members.get(Number(mobileId)).is_active = false;
        assert.equal((await send(path)).status, 400);
        assert.equal(state.mails.length, count + 2);
    });
});
