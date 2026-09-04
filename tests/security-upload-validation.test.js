import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isValidReportImageDataUrl, isValidReportImageFile } from "../server/technical-reports.js";

const authenticationSource = readFileSync(new URL("../server/auth.js", import.meta.url), "utf8");

test("les connexions refusées sont auditées sans exposer l'identifiant ni l'état du compte", () => {
    const rejectedLogin = authenticationSource.slice(authenticationSource.indexOf("if (!passwordMatches)"), authenticationSource.indexOf("if (isCreatorUsername"));
    assert.match(rejectedLogin, /recordSecurityEvent\(\{ request, eventType: "login", outcome: "failure" \}\)/);
    assert.doesNotMatch(rejectedLogin, /username|userFound|userActive|accountActive|passwordVerified|bcrypt\.compare/);
});

test("les médias de rapport valident la signature binaire correspondant au MIME", () => {
    assert.equal(isValidReportImageFile({ mimetype: "image/jpeg", buffer: Buffer.from([0xff, 0xd8, 0xff, 0x00]) }), true);
    assert.equal(isValidReportImageFile({ mimetype: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }), true);
    assert.equal(isValidReportImageFile({ mimetype: "image/webp", buffer: Buffer.from("RIFF0000WEBP", "ascii") }), true);
    assert.equal(isValidReportImageFile({ mimetype: "image/jpeg", buffer: Buffer.from("MZ executable", "ascii") }), false);
    assert.equal(isValidReportImageFile({ mimetype: "image/png", buffer: Buffer.from([0xff, 0xd8, 0xff]) }), false);
    assert.equal(isValidReportImageFile({ mimetype: "application/octet-stream", buffer: Buffer.from([0xff, 0xd8, 0xff]) }), false);
});

test("les images annotées en data URL valident aussi leur signature binaire", () => {
    assert.equal(isValidReportImageDataUrl(`data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64")}`), true);
    assert.equal(isValidReportImageDataUrl(`data:image/jpeg;base64,${Buffer.from("not an image").toString("base64")}`), false);
    assert.equal(isValidReportImageDataUrl(`data:image/png;base64,${Buffer.from([0xff, 0xd8, 0xff]).toString("base64")}`), false);
});