import test from "node:test";
import assert from "node:assert/strict";
import { requireCreator } from "../server/auth.js";

function responseRecorder() {
    return {
        statusCode: 200,
        headers: {},
        body: null,
        status(code) { this.statusCode = code; return this; },
        set(name, value) { this.headers[name] = value; return this; },
        json(body) { this.body = body; return this; }
    };
}

test("le contrôle Créateur distingue une session absente d’un rôle interdit", () => {
    const anonymousResponse = responseRecorder();
    requireCreator({}, anonymousResponse, () => assert.fail("une requête anonyme ne doit pas continuer"));
    assert.equal(anonymousResponse.statusCode, 401);
    assert.equal(anonymousResponse.body.message, "Connexion requise.");

    const companyResponse = responseRecorder();
    requireCreator({ user: { isCreator: false, deviceType: "desktop" } }, companyResponse, () => assert.fail("une entreprise ne doit pas continuer"));
    assert.equal(companyResponse.statusCode, 403);
    assert.match(companyResponse.body.message, /Créateur/);
});

test("le contrôle Créateur conserve les restrictions de session et d’appareil", () => {
    const replacedResponse = responseRecorder();
    requireCreator({ sessionWindowReplaced: true }, replacedResponse, () => assert.fail("une session remplacée ne doit pas continuer"));
    assert.equal(replacedResponse.statusCode, 401);
    assert.equal(replacedResponse.headers["X-DepannHome-Session-Replaced"], "true");
    assert.equal(replacedResponse.body.sessionReplaced, true);

    const mobileResponse = responseRecorder();
    requireCreator({ user: { isCreator: true, deviceType: "mobile" } }, mobileResponse, () => assert.fail("un mobile ne doit pas continuer"));
    assert.equal(mobileResponse.statusCode, 403);
    assert.match(mobileResponse.body.message, /poste administratif/);

    const desktopResponse = responseRecorder();
    let continued = false;
    requireCreator({ user: { isCreator: true, deviceType: "desktop" } }, desktopResponse, () => { continued = true; });
    assert.equal(continued, true);
    assert.equal(desktopResponse.statusCode, 200);
});