import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const authServer = readFileSync(new URL("../server/auth.js", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
const clientSessionSource = readFileSync(new URL("../js/client-session.js", import.meta.url), "utf8");
const authClient = readFileSync(new URL("../js/auth.js", import.meta.url), "utf8");

test("chaque fenêtre Web ou PWA possède une session cliente distincte", () => {
    assert.match(clientSessionSource, /sessionStorage\.getItem\(STORAGE_KEY\)/);
    assert.match(clientSessionSource, /crypto\.randomUUID\(\)/);
    assert.match(clientSessionSource, /X-DepannHome-Client-Session/);
    assert.doesNotMatch(clientSessionSource, /localStorage\.getItem\(STORAGE_KEY\)/);
});

test("la session Administrateur PC est liée à la fenêtre la plus récemment connectée", () => {
    assert.match(authServer, /clientWindowSessionId\(request\)/);
    assert.match(authServer, /session\.sessionId !== clientWindowSessionId\(request\)/);
    assert.match(authServer, /throw new Error\("Fenêtre PC remplacée"\)/);
    assert.match(authServer, /const sessionId = clientSessionId \|\| crypto\.randomUUID\(\)/);
    assert.doesNotMatch(authServer, /`window:\$\{value\}`|`legacy:\$\{crypto\.randomUUID\(\)\}`/);
});

test("la vérification TOTP conserve le formulaire après une attente asynchrone", () => {
    assert.match(authServer, /response\.status\(202\)\.json\(\{\s*totpRequired: true/);
    assert.match(authClient, /const submittedForm = event\.currentTarget/);
    assert.match(authClient, /submittedForm\.elements\.code\.select\(\)/);
    assert.doesNotMatch(authClient, /event\.currentTarget\.elements\.code/);
});

test("la sonde de session non connectée ne génère pas de faux 401", () => {
    assert.match(authServer, /if \(!user\) \{[\s\S]*?return response\.json\(\{\s*authenticated: false/);
});

test("l’ancienne fenêtre est avertie sans supprimer le cookie partagé de la nouvelle", () => {
    assert.match(authServer, /X-DepannHome-Session-Replaced/);
    assert.match(authServer, /error\.message !== "Fenêtre PC remplacée"/);
    assert.match(clientSessionSource, /depannhome:session-replaced/);
    assert.match(appSource, /window\.location\.replace\("\/\?session=replaced"\)/);
    assert.match(authClient, /Cette session Administrateur PC a été fermée car une connexion plus récente a été ouverte/);
});

test("un contrôle périodique ferme rapidement une ancienne session inactive", () => {
    assert.match(appSource, /fetch\("\/api\/auth\/session"/);
    assert.match(appSource, /window\.setInterval\(check, 3_000\)/);
    assert.match(appSource, /user\.role !== "admin" \|\| user\.deviceType === "mobile"/);
});