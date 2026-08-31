import test from "node:test";
import assert from "node:assert/strict";
import { decodeBase64Url, encodeBase64Url, gmailDownloadAttachment, gmailListMessages, gmailMessageDetails, gmailMessageRaw, gmailMessageUid, gmailSearchQuery, gmailSendMessage } from "../server/gmail-api-client.js";

function response(status, payload, headers = {}) {
    return new Response(payload === undefined ? null : JSON.stringify(payload), { status, headers: { "Content-Type": "application/json", ...headers } });
}

test("le client Gmail liste uniquement la boîte de réception avec pagination bornée", async () => {
    const calls = [];
    const fetchImpl = async (url, options) => { calls.push({ url: String(url), options }); return response(200, { messages: [{ id: "a" }, { id: "b" }], nextPageToken: "next" }); };
    const result = await gmailListMessages("token-secret", { query: "in:inbox after:123", limit: 1 }, fetchImpl);
    assert.deepEqual(result.messages, [{ id: "a" }]);
    assert.equal(result.hasMore, true);
    assert.match(calls[0].url, /gmail\/v1\/users\/me\/messages\?/);
    assert.equal(new URL(calls[0].url).searchParams.get("q"), "in:inbox after:123");
    assert.equal(calls[0].options.headers.Authorization, "Bearer token-secret");
    assert.equal(calls[0].options.method, undefined);
});

test("le client Gmail restitue le MIME brut sans altération", async () => {
    const mime = Buffer.from("From: sender@example.test\r\nSubject: Mission\r\n\r\nBonjour");
    const result = await gmailMessageRaw("token", "gmail-id", async url => {
        assert.match(String(url), /messages\/gmail-id\?format=raw$/);
        return response(200, { id: "gmail-id", threadId: "thread-1", raw: encodeBase64Url(mime) });
    });
    assert.equal(result.threadId, "thread-1");
    assert.deepEqual(result.source, mime);
});

test("les métadonnées Gmail restent en lecture seule et exposent corps et pièces", async () => {
    const result = await gmailMessageDetails("token", "gmail-id", async (url, options) => {
        assert.match(String(url), /format=full$/);
        assert.equal(options.method, undefined);
        return response(200, { id: "gmail-id", threadId: "thread-1", internalDate: "1700000000000", labelIds: ["INBOX", "UNREAD"], snippet: "Aperçu", payload: { headers: [
            { name: "Subject", value: "Ordre de mission" }, { name: "From", value: "Assureur <mission@assureur.test>" }, { name: "To", value: "pro@example.test" }, { name: "Message-ID", value: "<source@example.test>" }
        ], parts: [
            { partId: "1", mimeType: "text/plain", body: { data: encodeBase64Url("Client : Alice") } },
            { partId: "2", mimeType: "application/pdf", filename: "mission.pdf", body: { attachmentId: "attachment-1", size: 123 } }
        ] } });
    });
    assert.equal(result.subject, "Ordre de mission");
    assert.equal(result.from.address, "mission@assureur.test");
    assert.equal(result.bodyText, "Client : Alice");
    assert.equal(result.isRead, false);
    assert.deepEqual(result.attachments, [{ id: "2", name: "mission.pdf", contentType: "application/pdf", size: 123 }]);
});

test("les métadonnées Gmail acceptent un expéditeur sans nom d’affichage", async () => {
    const result = await gmailMessageDetails("token", "gmail-id", async () => response(200, {
        id: "gmail-id", payload: { headers: [{ name: "From", value: "<vhrdashboard@gmail.com>" }] }
    }));
    assert.deepEqual(result.from, { name: "", address: "vhrdashboard@gmail.com" });
    assert.deepEqual(result.replyTo, { name: "", address: "vhrdashboard@gmail.com" });
});

test("une pièce Gmail est téléchargée par son endpoint dédié", async () => {
    const calls = [];
    const fetchImpl = async url => {
        calls.push(String(url));
        if (calls.length === 1) return response(200, { payload: { parts: [{ partId: "2", mimeType: "application/pdf", filename: "mission.pdf", body: { attachmentId: "attachment-1", size: 3 } }] } });
        return response(200, { data: encodeBase64Url(Buffer.from([1, 2, 3])) });
    };
    const file = await gmailDownloadAttachment("token", "gmail-id", "2", fetchImpl);
    assert.match(calls[1], /messages\/gmail-id\/attachments\/attachment-1$/);
    assert.deepEqual(file.content, Buffer.from([1, 2, 3]));
    assert.equal(file.size, 3);
});

test("l’envoi Gmail utilise exclusivement messages.send et conserve le thread", async () => {
    let request;
    await gmailSendMessage("token", Buffer.from("Subject: Re: Mission\r\n\r\nMerci"), "thread-1", async (url, options) => { request = { url: String(url), options }; return response(200, { id: "sent" }); });
    assert.match(request.url, /users\/me\/messages\/send$/);
    assert.equal(request.options.method, "POST");
    const payload = JSON.parse(request.options.body);
    assert.equal(payload.threadId, "thread-1");
    assert.match(decodeBase64Url(payload.raw).toString(), /Subject: Re: Mission/);
});

test("les recherches et identifiants Gmail sont stables", () => {
    assert.equal(gmailSearchQuery({ since: new Date(123000), before: new Date(456000) }), "in:inbox after:123 before:456");
    assert.equal(gmailMessageUid("18fabc123"), gmailMessageUid("18fabc123"));
    assert.notEqual(gmailMessageUid("18fabc123"), gmailMessageUid("18fabc124"));
    assert.ok(Number.isSafeInteger(gmailMessageUid("18fabc123")));
});

test("les erreurs Gmail normalisent les refus OAuth sans exposer le jeton", async () => {
    await assert.rejects(
        gmailMessageRaw("secret-token", "gmail-id", async () => response(401, { error: { status: "UNAUTHENTICATED" } })),
        error => error.authenticationFailed === true && error.statusCode === 401 && !error.message.includes("secret-token")
    );
});

test("les erreurs Gmail modernes conservent le motif ErrorInfo", async () => {
    await assert.rejects(
        gmailListMessages("token", {}, async () => response(403, { error: { status: "PERMISSION_DENIED", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED", domain: "googleapis.com" }] } })),
        error => error.code === "SERVICE_DISABLED" && error.statusCode === 403 && error.authenticationFailed === false
    );
    await assert.rejects(
        gmailListMessages("token", {}, async () => response(403, { error: { errors: [{ reason: "insufficientPermissions" }] } })),
        error => error.code === "insufficientPermissions" && error.authenticationFailed === false
    );
});
