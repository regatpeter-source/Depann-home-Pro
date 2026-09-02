import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sessionDurationForDevice } from "../server/auth.js";

const authServer = readFileSync(new URL("../server/auth.js", import.meta.url), "utf8");
const DAY = 24 * 60 * 60 * 1000;

test("tous les postes mobiles conservent leur session pendant 90 jours", () => {
    assert.equal(sessionDurationForDevice("mobile"), 90 * DAY);
    assert.match(authServer, /const MOBILE_SESSION_DURATION = 90 \* 24 \* 60 \* 60 \* 1000/);
    assert.match(authServer, /setSessionCookie\(response, device, deviceId, device\.device_type/);
    assert.match(authServer, /setSessionCookie\(response, user, authDevice\.id, device\.type/);
    assert.match(authServer, /setSessionCookie\(response, user, authDevice\.id, authDevice\.device_type/);
});

test("ouvrir de nouveau l’application renouvelle silencieusement la session mobile", () => {
    assert.match(authServer, /if \(user\.deviceType === "mobile"\) \{\s*setSessionCookie\(response, user, user\.deviceId, user\.deviceType, accountOwnerId\)/);
    assert.match(authServer, /const userId = user\.id \|\| user\.user_id \|\| user\.sub/);
});

test("les postes PC conservent leur durée de session limitée à 12 heures", () => {
    assert.equal(sessionDurationForDevice("desktop"), 12 * 60 * 60 * 1000);
    assert.equal(sessionDurationForDevice(""), 12 * 60 * 60 * 1000);
    assert.match(authServer, /const duration = sessionDurationForDevice\(deviceType\)/);
});

test("la longue session mobile reste liée à un appareil approuvé", () => {
    assert.match(authServer, /device\?\.status !== "approved"/);
    assert.match(authServer, /currentDevice\.id !== device\.id \|\| currentDevice\.type !== device\.device_type/);
    assert.match(authServer, /response\.cookie\(COOKIE_NAME, token, \{[\s\S]*?\.\.\.cookieOptions\(\)[\s\S]*?maxAge: duration/);
    assert.match(authServer, /function cookieOptions\(\) \{[\s\S]*?httpOnly: true[\s\S]*?sameSite: "lax"/);
});