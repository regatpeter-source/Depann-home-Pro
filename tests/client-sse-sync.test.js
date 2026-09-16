import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { openClientEventStream, publishClientChange } from "../server/client-events.js";

const clientsServer = readFileSync(new URL("../server/clients.js", import.meta.url), "utf8");
const calendarServer = readFileSync(new URL("../server/calendar.js", import.meta.url), "utf8");
const reportsServer = readFileSync(new URL("../server/technical-reports.js", import.meta.url), "utf8");
const clientSync = readFileSync(new URL("../js/client-sync.js", import.meta.url), "utf8");

function createStream() {
    const request = new EventEmitter();
    const response = new EventEmitter();
    response.headers = {};
    response.chunks = [];
    response.status = status => { response.statusCode = status; return response; };
    response.set = headers => { Object.assign(response.headers, headers); return response; };
    response.flushHeaders = () => { response.flushed = true; };
    response.write = chunk => { response.chunks.push(String(chunk)); return true; };
    response.end = () => { response.writableEnded = true; };
    openClientEventStream(request, response, 42);
    return { request, response };
}

test("le flux client SSE utilise des en-têtes adaptés et reste isolé par entreprise", () => {
    const first = createStream();
    const second = createStream();
    const otherRequest = new EventEmitter();
    const otherResponse = createStreamResponse();
    openClientEventStream(otherRequest, otherResponse, 84);

    assert.equal(first.response.statusCode, 200);
    assert.equal(first.response.headers["Content-Type"], "text/event-stream; charset=utf-8");
    assert.equal(first.response.headers["Cache-Control"], "no-cache, no-transform");
    assert.equal(first.response.headers["X-Accel-Buffering"], "no");
    assert.equal(first.response.flushed, true);

    assert.equal(publishClientChange(42, "client-photo", "attachment-added"), 2);
    assert.match(first.response.chunks.join(""), /event: client-changed/);
    assert.match(first.response.chunks.join(""), /"clientId":"client-photo"/);
    assert.doesNotMatch(otherResponse.chunks.join(""), /client-photo/);

    first.request.emit("close");
    second.request.emit("close");
    otherRequest.emit("close");
    assert.equal(publishClientChange(42, "client-after-close"), 0);
});

test("les routes publient les changements client après validation transactionnelle", () => {
    assert.match(clientsServer, /app\.get\("\/api\/clients\/events"[\s\S]*openClientEventStream\(request, response, getAccountOwnerId\(request\)\)/);
    assert.match(clientsServer, /attachment-added/);
    assert.match(clientsServer, /query\("COMMIT"\);\s*publishClientChange\(getAccountOwnerId\(request\), clientId, "attachment-added"\)/);
    assert.match(calendarServer, /query\("COMMIT"\);\s*publishClientChange\(ownerId, appointment\.clientId, "attachment-added"\)/);
    assert.match(reportsServer, /query\("COMMIT"\);[^\n]*\n\s*if \(report\.clientId\) publishClientChange\(ownerId, report\.clientId, "attachment-added"\)/);
});

test("le navigateur écoute les événements et conserve seulement un contrôle lent de secours", () => {
    assert.match(clientSync, /import \{ clientSessionUrl \} from "\.\/client-session\.js\?v=6"/);
    assert.match(clientSync, /new EventSource\(clientSessionUrl\("\/api\/clients\/events"\), \{ withCredentials: true \}\)/);
    assert.match(clientSync, /addEventListener\("client-changed", \(\) => scheduleClientSynchronization\(0\)\)/);
    assert.match(clientSync, /FALLBACK_SYNCHRONIZATION_INTERVAL = 5 \* 60_000/);
    assert.match(clientSync, /window\.addEventListener\("offline", closeClientEventStream\)/);
    assert.doesNotMatch(clientSync, /15_000/);
});

test("la synchronisation ne retransmet pas les fichiers encodés déjà stockés sur le serveur", () => {
    assert.match(clientsServer, /function compactClientPayload\(client\)/);
    assert.match(clientsServer, /delete compactAttachment\.dataUrl/);
    assert.match(clientsServer, /cachedLocally: false/);
    assert.match(clientsServer, /\.\.\.compactClientPayload\(row\.client\)/);
    assert.match(clientsServer, /client: compactClientPayload\(updatedClient\)/);
});

function createStreamResponse() {
    const response = new EventEmitter();
    response.headers = {};
    response.chunks = [];
    response.status = status => { response.statusCode = status; return response; };
    response.set = headers => { Object.assign(response.headers, headers); return response; };
    response.flushHeaders = () => {};
    response.write = chunk => { response.chunks.push(String(chunk)); return true; };
    response.end = () => { response.writableEnded = true; };
    return response;
}
