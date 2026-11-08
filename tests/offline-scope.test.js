import test from "node:test";
import assert from "node:assert/strict";
import { offlineIdempotent } from "../server/offline-idempotency.js";

test("le serveur refuse une opération hors ligne liée à une autre entreprise ou un autre utilisateur", async () => {
    for (const scope of ["2:mobile:10", "1:mobile:11"]) {
        let called = false;
        const request = {
            user: { sub: "10", accountOwnerId: "1" },
            get: name => name === "X-DepannHome-Offline-Scope" ? scope : ""
        };
        const response = {
            status(value) { this.statusCode = value; return this; },
            json(value) { this.body = value; return this; }
        };
        await offlineIdempotent(() => { called = true; })(request, response, error => { throw error; });
        assert.equal(called, false);
        assert.equal(response.statusCode, 409);
        assert.match(response.body.message, /autre compte ou utilisateur/);
    }
});

test("une requête ordinaire sans contexte hors ligne conserve son comportement", async () => {
    let called = false;
    const request = { user: { sub: "10", accountOwnerId: "1" }, get: () => "" };
    await offlineIdempotent(() => { called = true; })(request, {}, error => { throw error; });
    assert.equal(called, true);
});
