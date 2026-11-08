import "./offline-replay.js?v=1";

const DATABASE_NAME = "depannhome-mobile-offline";
const DATABASE_VERSION = 2;
const QUEUE_STORE = "operations";
const CACHE_STORE = "responses";
const MAPPING_STORE = "mappings";
const METADATA_STORE = "metadata";
const RETRY_DELAY = 30_000;
const replay = globalThis.DepannHomeOfflineReplay;

let networkFetch = null;
let replayHeadersProvider = null;
let flushPromise = null;
let initialized = false;
let queueSequence = 0;

export function initializeOfflineSync(fetchImplementation, headersProvider = null) {
    if (fetchImplementation) networkFetch = fetchImplementation;
    if (headersProvider) replayHeadersProvider = headersProvider;
    if (initialized || typeof window === "undefined") return;
    initialized = true;
    window.addEventListener("online", () => scheduleFlush(250));
    window.addEventListener("depannhome:offline-session-ready", () => { rememberActiveScope(); scheduleFlush(0); });
    window.addEventListener("depannhome:offline-session-ended", () => deleteRecord(METADATA_STORE, "activeScope").catch(error => {
        console.error("[offline] Fermeture du contexte impossible :", error.name || "ERROR");
        dispatchQueueState("error", { message: "Impossible de fermer le contexte hors ligne sur cet appareil." });
    }));
    window.addEventListener("focus", () => scheduleFlush(500));
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") scheduleFlush(500); });
    navigator.serviceWorker?.addEventListener("message", event => { if (event.data?.type === "depannhome:flush-offline-queue") scheduleFlush(0); });
    window.setInterval(() => { if (navigator.onLine && document.visibilityState === "visible") scheduleFlush(0); }, RETRY_DELAY);
    scheduleFlush(0);
}

export async function offlineAwareFetch(fetchImplementation, input, init = {}) {
    const fetcher = fetchImplementation || networkFetch;
    if (!fetcher) throw new Error("Transport réseau non initialisé.");
    const requestUrl = new URL(typeof input === "string" ? input : input.url, window.location.href);
    const method = String(init.method || (typeof input !== "string" ? input.method : "GET") || "GET").toUpperCase();
    if (!isDedicatedMobileSession() || requestUrl.origin !== window.location.origin || !requestUrl.pathname.startsWith("/api/")) {
        return fetcher(input, init);
    }
    if (!currentScope()) {
        if (isQueueableMutation(method, requestUrl.pathname)) return jsonResponse({ message: "Contexte mobile indisponible. Reconnectez-vous avant d’enregistrer cette opération." }, 503);
        return fetcher(input, init);
    }

    if (method === "GET" && isCacheableGet(requestUrl.pathname)) {
        if (await pendingOfflineOperationCount()) {
            const cached = await cachedResponse(requestUrl);
            if (cached) return cached;
        }
        const hasLocalId = /offline-(event|report|media)-/.test(requestUrl.pathname);
        let target = input;
        if (hasLocalId) {
            const mappings = (await getAll(MAPPING_STORE)).filter(item => item.scope === currentScope());
            const original = `${requestUrl.pathname}${requestUrl.search}`;
            const mapped = replay.remapUrl(original, mappings);
            if (mapped !== original) target = typeof input === "string" ? mapped : new Request(new URL(mapped, requestUrl.origin), input);
        }
        try {
            const response = await fetcher(target, init);
            if (response.ok && isJsonResponse(response)) {
                if (await pendingOfflineOperationCount()) {
                    const cached = await cachedResponse(requestUrl);
                    if (cached) return cached;
                }
                await cacheResponse(requestUrl, response.clone());
            }
            if (hasLocalId && target === input && response.status === 404) return await cachedResponse(requestUrl) || response;
            if (response.ok || response.status < 500) return response;
            return await cachedResponse(requestUrl) || response;
        } catch (error) {
            const cached = await cachedResponse(requestUrl);
            if (cached) return cached;
            throw error;
        }
    }

    if (!isQueueableMutation(method, requestUrl.pathname)) return fetcher(input, init);
    const operationId = crypto.randomUUID();
    const operationHeaders = new Headers(init.headers || (typeof input !== "string" ? input.headers : undefined));
    operationHeaders.set("X-DepannHome-Offline-Operation", operationId);
    if (navigator.onLine !== false && await pendingOfflineOperationCount() === 0) {
        let target = input;
        let body = init.body;
        if (/offline-(event|report|media)-/.test(`${requestUrl.pathname}${typeof body === "string" ? body : ""}`) || body instanceof FormData) {
            const mappings = (await getAll(MAPPING_STORE)).filter(item => item.scope === currentScope());
            const original = `${requestUrl.pathname}${requestUrl.search}`;
            const mapped = replay.remapUrl(original, mappings);
            if (mapped !== original) target = typeof input === "string" ? mapped : new Request(new URL(mapped, requestUrl.origin), input);
            if (body != null) body = deserializeBody(replay.remapBody(await serializeBody(body), mappings));
            if (body instanceof FormData) operationHeaders.delete("Content-Type");
        }
        try { return await fetcher(target, { ...init, headers: operationHeaders, ...(body === undefined ? {} : { body }) }); }
        catch { /* La requête sera conservée ci-dessous. */ }
    }

    const operation = await createOperation(requestUrl, method, { ...init, headers: operationHeaders }, operationId);
    const synthetic = await syntheticPayload(operation);
    const stored = await enqueueOperation(operation);
    if (!stored.ok) return jsonResponse({ message: stored.message }, 507);
    try {
        await applyOptimisticCache(operation, synthetic);
        if (operation.metadata.localReportId && synthetic.report) await cacheLocalReport(operation, synthetic.report);
    } catch (error) {
        console.error("[offline] Mise à jour locale indisponible :", error.name || "ERROR");
        synthetic.warning = "L’envoi est conservé, mais l’affichage local n’a pas pu être actualisé. Ne supprimez pas les données de l’application.";
        window.dispatchEvent(new CustomEvent("depannhome:offline-cache-error", { detail: { message: synthetic.warning } }));
    }
    registerBackgroundSync();
    dispatchQueueState("queued");
    return jsonResponse(synthetic, 202);
}

export async function flushOfflineQueue() {
    if (flushPromise || !networkFetch || !navigator.onLine || !currentScope()) return flushPromise || { ok: false, offline: true };
    flushPromise = flushOperations().finally(() => { flushPromise = null; });
    return flushPromise;
}

export async function pendingOfflineOperationCount() {
    const scope = currentScope();
    if (!scope) return 0;
    const operations = await getAll(QUEUE_STORE);
    return operations.filter(item => item.scope === scope).length;
}

export async function getOfflineQueueStatus() {
    const scope = currentScope();
    if (!scope) return { pending: 0, blocked: null };
    const operations = (await getAll(QUEUE_STORE)).filter(item => item.scope === scope).sort((a, b) => a.createdAt - b.createdAt);
    const blocked = operations.find(item => item.blocked);
    return { pending: operations.length, blocked: blocked ? { message: blocked.lastError || "Une opération doit être contrôlée.", attempts: Number(blocked.attempts || 0) } : null };
}

export async function retryOfflineQueue() {
    if (!navigator.onLine || !currentScope()) return { ok: false, offline: true };
    if (flushPromise) await flushPromise;
    const scope = currentScope();
    const operations = (await getAll(QUEUE_STORE)).filter(item => item.scope === scope).sort((a, b) => a.createdAt - b.createdAt);
    const blocked = operations.find(item => item.blocked);
    if (blocked) {
        const database = await openDatabase();
        try { await replay.unblock(database, blocked.id); }
        finally { database.close(); }
    }
    return flushOfflineQueue();
}

function scheduleFlush(delay) {
    window.setTimeout(() => flushOfflineQueue().catch(error => {
        console.error("[offline] Synchronisation indisponible :", error.name || "ERROR");
        dispatchQueueState("error", { message: "La synchronisation hors ligne est indisponible. Les données restent sur cet appareil." });
    }), delay);
}

async function flushOperations() {
    dispatchQueueState("syncing");
    const scope = currentScope();
    const operations = (await getAll(QUEUE_STORE)).filter(item => item.scope === scope).sort((a, b) => a.createdAt - b.createdAt);
    let sent = 0;
    for (const operation of operations) {
        if (operation.blocked) {
            const message = operation.lastError || "Une opération hors ligne doit être contrôlée.";
            dispatchQueueState("conflict", { operation, message });
            return { ok: false, conflict: true, sent, message };
        }
        const prepared = await prepareReplay(operation);
        let response;
        try {
            response = await networkFetch(prepared.url, prepared.options);
        } catch {
            await updateAttempt(operation, "Réseau indisponible");
            dispatchQueueState("offline");
            return { ok: false, sent, pending: operations.length - sent };
        }
        if (response.status === 401) {
            await updateAttempt(operation, "Session expirée");
            window.dispatchEvent(new CustomEvent("depannhome:authentication-required"));
            dispatchQueueState("authentication-required");
            return { ok: false, authenticationRequired: true, sent };
        }
        if (response.status >= 500 || response.status === 408 || response.status === 425 || response.status === 429) {
            await updateAttempt(operation, `Erreur ${response.status}`);
            dispatchQueueState("waiting");
            return { ok: false, sent, pending: operations.length - sent };
        }
        if (!response.ok) {
            const details = await response.clone().json().catch(() => null);
            await updateAttempt(operation, details?.message || `Conflit ${response.status}`, true);
            dispatchQueueState("conflict", { operation, status: response.status, message: details?.message || "Une opération hors ligne doit être contrôlée." });
            return { ok: false, conflict: true, sent };
        }
        try {
            await recordResponseMappings(operation, response.clone());
        } catch (error) {
            const message = error.message || "La réponse de synchronisation doit être contrôlée.";
            await updateAttempt(operation, message, true);
            dispatchQueueState("conflict", { operation, status: response.status, message });
            return { ok: false, conflict: true, sent, message };
        }
        await deleteRecord(QUEUE_STORE, operation.id);
        sent += 1;
        window.dispatchEvent(new CustomEvent("depannhome:offline-operation-synchronized", { detail: { operation } }));
    }
    dispatchQueueState("synced", { sent });
    if (sent) {
        window.dispatchEvent(new CustomEvent("depannhome:offline-synchronized", { detail: { sent } }));
        window.dispatchEvent(new CustomEvent("depannhome:clients-synchronized"));
    }
    return { ok: true, sent, pending: 0 };
}

async function createOperation(url, method, init, id = crypto.randomUUID()) {
    const body = await serializeBody(init.body);
    const operation = {
        id,
        scope: currentScope(),
        url: `${url.pathname}${url.search}`,
        method,
        headers: [...new Headers(init.headers || {}).entries()].filter(([name]) => !["content-length", "host"].includes(name.toLowerCase())),
        body,
        createdAt: Date.now() * 1000 + queueSequence++ % 1000,
        attempts: 0,
        blocked: false,
        metadata: {}
    };
    if (method === "POST" && /\/technical-reports\/[^/]+\/media$/.test(url.pathname) && body.type === "form-data") {
        operation.metadata.localMediaIds = body.entries.filter(entry => entry.kind === "blob" && entry.name === "files").map(() => `offline-media-${crypto.randomUUID()}`);
    }
    if (method === "POST" && url.pathname === "/api/calendar/events") {
        const payload = parseJsonBody(body);
        const dates = Array.isArray(payload.dates) && payload.dates.length ? [...new Set(payload.dates)] : [payload.date];
        operation.metadata.localEventId = `offline-event-${crypto.randomUUID()}`;
        if (dates.length > 1) {
            operation.metadata.localEventDates = dates;
            operation.metadata.localEventIds = dates.map((_, index) => index ? `offline-event-${crypto.randomUUID()}` : operation.metadata.localEventId);
        }
    }
    if (method === "POST" && url.pathname === "/api/technical-reports") operation.metadata.localReportId = `offline-report-${crypto.randomUUID()}`;
    return operation;
}

async function enqueueOperation(operation) {
    try {
        await putRecord(QUEUE_STORE, operation);
        return { ok: true };
    } catch (error) {
        console.error("[offline] Enregistrement impossible :", error.name || "ERROR");
        return { ok: false, message: error.name === "QuotaExceededError" ? "Le stockage hors ligne est saturé. Libérez de l’espace avant de continuer." : "Le stockage hors ligne est indisponible. Vérifiez les autorisations du navigateur avant de continuer." };
    }
}

async function prepareReplay(operation) {
    const mappings = (await getAll(MAPPING_STORE)).filter(item => item.scope === operation.scope);
    const url = replay.remapUrl(operation.url, mappings);
    const headers = new Headers(operation.headers || []);
    Object.entries(replayHeadersProvider?.() || {}).forEach(([name, value]) => headers.set(name, value));
    headers.set("X-DepannHome-Offline-Operation", operation.id);
    headers.set("X-DepannHome-Offline-Scope", operation.scope);
    if (operation.retryAfterConflict) headers.set("X-DepannHome-Offline-Retry", "true");
    const body = deserializeBody(replay.remapBody(operation.body, mappings));
    if (operation.body?.type === "form-data") headers.delete("Content-Type");
    return { url, options: { method: operation.method, credentials: "same-origin", headers, ...(body === undefined ? {} : { body }) } };
}

async function recordResponseMappings(operation, response) {
    if (!replay.hasExpectedMappings(operation)) return;
    const data = await response.json().catch(() => null);
    const mappings = replay.responseMappings(operation, data);
    await Promise.all(mappings.map(([localId, remoteId]) => putRecord(MAPPING_STORE, { key: `${operation.scope}:${localId}`, scope: operation.scope, localId, remoteId })));
}

async function updateAttempt(operation, message, blocked = false) {
    const database = await openDatabase();
    try { await replay.recordAttempt(database, operation.id, message, blocked); }
    finally { database.close(); }
}

async function serializeBody(body) {
    if (body == null) return { type: "none" };
    if (typeof body === "string") return { type: "text", value: body };
    if (body instanceof FormData) {
        const entries = [];
        for (const [name, value] of body.entries()) entries.push(value instanceof Blob ? { name, kind: "blob", value, filename: value.name || "fichier" } : { name, kind: "text", value: String(value) });
        return { type: "form-data", entries };
    }
    if (body instanceof Blob) return { type: "blob", value: body };
    throw new Error("Ce format ne peut pas être conservé hors ligne.");
}

function deserializeBody(body) {
    if (!body || body.type === "none") return undefined;
    if (body.type === "text") return body.value;
    if (body.type === "blob") return body.value;
    if (body.type === "form-data") {
        const form = new FormData();
        body.entries.forEach(entry => entry.kind === "blob" ? form.append(entry.name, entry.value, entry.filename) : form.append(entry.name, entry.value));
        return form;
    }
    return undefined;
}

async function syntheticPayload(operation) {
    const queued = { queued: true, operationId: operation.id, message: "Enregistré hors ligne. Envoi automatique dès le retour du réseau." };
    const json = parseJsonBody(operation.body);
    if (/\/pause$/.test(operation.url)) return { ...queued, pause: { pausedAt: new Date().toISOString(), pauseReason: json.reason || "other", pauseNote: json.note || "", status: "paused" } };
    if (/\/quitus$/.test(operation.url)) return { ...queued, quitus: { quitusStatus: "validated", quitusSignedBy: json.signedBy || "", quitusObservations: json.observations || "", quitusValidatedAt: new Date().toISOString(), quitusSignature: json.signature || "" } };
    if (/\/deductible$/.test(operation.url)) {
        const form = formValues(operation.body);
        return { ...queued, deductible: { deductibleStatus: "pending", deductibleAmountCents: Number(form.amountCents || 0), deductiblePaymentMethod: form.paymentMethod || "" } };
    }
    if (/\/technical-reports\/[^/]+\/media$/.test(operation.url)) return { ...queued, media: await localMedia(operation) };
    if (operation.url === "/api/technical-reports" && operation.method === "POST") {
        const report = await buildLocalReport(parseJsonBody(operation.body).appointmentId, operation.metadata.localReportId);
        return { ...queued, id: operation.metadata.localReportId, report };
    }
    if (operation.url === "/api/calendar/events" && operation.method === "POST") {
        const ids = operation.metadata.localEventIds || [operation.metadata.localEventId];
        return { ...queued, id: ids[0], ids, count: ids.length };
    }
    if (operation.url === "/api/messages" && operation.method === "POST") return { ...queued, message: { id: `offline-message-${operation.id}`, body: json.body || "", clientId: json.clientId || "", senderId: document.body.dataset.userId || "", senderName: document.body.dataset.userName || "", createdAt: new Date().toISOString(), pending: true } };
    return queued;
}

async function localMedia(operation) {
    const values = formValues(operation.body);
    const files = operation.body.entries.filter(entry => entry.kind === "blob" && entry.name === "files");
    return Promise.all(files.map(async (entry, index) => ({
        id: operation.metadata.localMediaIds[index], section: values.section || "", observationId: values.observationId || "", materialId: values.materialId || "", sortOrder: Date.now() + index,
        pdfSize: "large", name: entry.filename, mime: entry.value.type, size: entry.value.size, caption: "", annotation: "", dataUrl: await blobDataUrl(entry.value), createdAt: new Date().toISOString(), pending: true
    })));
}

function parseJsonBody(body) { try { return body?.type === "text" ? JSON.parse(body.value) : {}; } catch { return {}; } }
function formValues(body) { return Object.fromEntries((body?.entries || []).filter(entry => entry.kind === "text").map(entry => [entry.name, entry.value])); }
function blobDataUrl(blob) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result || "")); reader.onerror = reject; reader.readAsDataURL(blob); }); }

async function cacheResponse(url, response) {
    const body = await response.text();
    await putRecord(CACHE_STORE, { key: cacheKey(url), scope: currentScope(), url: `${url.pathname}${url.search}`, status: response.status, headers: [...response.headers.entries()], body, updatedAt: Date.now() });
}

async function cachedResponse(url) {
    const record = await getRecord(CACHE_STORE, cacheKey(url));
    if (record) {
        const headers = new Headers(record.headers);
        headers.set("X-DepannHome-Offline", "true");
        return new Response(record.body, { status: record.status || 200, headers });
    }
    const appointmentId = url.pathname.match(/^\/api\/technical-reports\/appointments\/(\d+|offline-event-[0-9a-f-]{36})$/i)?.[1];
    if (!appointmentId) return null;
    const appointment = await findCachedAppointment(appointmentId);
    return appointment ? jsonResponse({ appointment, report: null }) : null;
}

async function cacheLocalReport(operation, report) {
    const url = new URL(`/api/technical-reports/${operation.metadata.localReportId}`, location.origin);
    await putRecord(CACHE_STORE, { key: cacheKey(url), scope: operation.scope, url: url.pathname, status: 200, headers: [["content-type", "application/json"]], body: JSON.stringify({ report, originals: [], corrections: [], lock: { lockedBy: document.body.dataset.userId || "", userName: document.body.dataset.userName || "Poste mobile" } }), updatedAt: Date.now() });
    const appointmentUrl = new URL(`/api/technical-reports/appointments/${encodeURIComponent(report.appointmentId)}`, location.origin);
    let appointmentRecord = await getRecord(CACHE_STORE, cacheKey(appointmentUrl));
    if (!appointmentRecord) {
        const appointment = await findCachedAppointment(report.appointmentId);
        if (appointment) appointmentRecord = { key: cacheKey(appointmentUrl), scope: operation.scope, url: appointmentUrl.pathname, status: 200, headers: [["content-type", "application/json"]], body: JSON.stringify({ appointment }), updatedAt: Date.now() };
    }
    if (appointmentRecord) { const data = JSON.parse(appointmentRecord.body); data.report = report; appointmentRecord.body = JSON.stringify(data); await putRecord(CACHE_STORE, appointmentRecord); }
    const directoryUrl = new URL("/api/technical-reports", location.origin);
    const directoryRecord = await getRecord(CACHE_STORE, cacheKey(directoryUrl));
    if (directoryRecord) { const data = JSON.parse(directoryRecord.body); data.reports = [report, ...(data.reports || []).filter(item => String(item.id) !== String(report.id))]; directoryRecord.body = JSON.stringify(data); await putRecord(CACHE_STORE, directoryRecord); }
}

async function buildLocalReport(appointmentId, reportId) {
    const appointment = await findCachedAppointment(String(appointmentId || "")) || {};
    const date = appointment.date || new Date().toISOString().slice(0, 10);
    const content = { sectionOrder: ["general", "presentation", "overview", "visual", "humidity", "pressure", "methods", "waterTest", "charging", "safety", "ventilation", "conclusion", "recommendations"], customSections: [], sectionTitles: {}, removedSections: [], activeStep: "general", skippedSteps: [], snapshot: { clientName: appointment.clientName || "", clientAddress: appointment.location || "", interventionNumber: appointment.id || appointmentId, interventionType: appointment.title || "", date, time: appointment.startTime || "", technicianName: document.body.dataset.userName || "" } };
    content.sectionOrder.forEach(section => { content[section] = { observations: [], ...(section === "methods" ? { materials: [] } : {}) }; });
    return { id: reportId, appointmentId: appointment.id || appointmentId, clientId: appointment.clientId || "", clientName: appointment.clientName || "", title: `Rapport de recherche de fuite${appointment.clientName ? ` · ${appointment.clientName}` : ""}`, reportDate: date, status: "draft", content, media: [], pending: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

async function findCachedAppointment(appointmentId) {
    const records = (await getAll(CACHE_STORE)).filter(item => item.scope === currentScope());
    for (const record of records) {
        let data;
        try { data = JSON.parse(record.body); } catch { continue; }
        if (String(data?.appointment?.id || "") === String(appointmentId)) return data.appointment;
        const event = (data?.events || []).find(item => String(item.id) === String(appointmentId));
        if (event) return event;
    }
    return null;
}

async function applyOptimisticCache(operation, synthetic) {
    const records = (await getAll(CACHE_STORE)).filter(item => item.scope === operation.scope);
    await Promise.all(records.map(async record => {
        let data;
        try { data = JSON.parse(record.body); } catch { return; }
        if (!applyOptimisticMutation(data, record.url, operation, synthetic)) return;
        record.body = JSON.stringify(data);
        record.updatedAt = Date.now();
        await putRecord(CACHE_STORE, record);
    }));
}

function applyOptimisticMutation(data, cachedUrl, operation, synthetic) {
    const payload = parseJsonBody(operation.body);
    const calendarMatch = operation.url.match(/^\/api\/calendar\/events\/([^/]+)(?:\/(pause|resume|quitus|deductible))?/);
    if (cachedUrl.startsWith("/api/calendar/events?") && Array.isArray(data.events)) {
        if (operation.url === "/api/calendar/events" && operation.method === "POST") {
            const dates = operation.metadata.localEventDates || [payload.date];
            const ids = operation.metadata.localEventIds || [synthetic.id];
            const query = new URL(cachedUrl, location.origin).searchParams;
            const matching = dates.map((date, index) => ({ date, id: ids[index] })).filter(item => item.date >= query.get("start") && item.date <= query.get("end"));
            matching.forEach(item => data.events.push({ ...payload, ...item, createdBy: document.body.dataset.userId || "", createdDeviceType: "mobile", pending: true }));
            return matching.length > 0;
        }
        if (!calendarMatch) return false;
        const event = data.events.find(item => String(item.id) === calendarMatch[1]);
        if (!event) return false;
        if (operation.method === "DELETE") data.events = data.events.filter(item => String(item.id) !== calendarMatch[1]);
        else if (calendarMatch[2] === "pause") Object.assign(event, { pausedAt: new Date().toISOString(), pauseReason: payload.reason, pauseNote: payload.note, status: "paused", pending: true });
        else if (calendarMatch[2] === "resume") Object.assign(event, { date: payload.date, status: "planned", pausedAt: null, pauseReason: "", pauseNote: "", pausedByName: "", pending: true });
        else if (calendarMatch[2] === "quitus") Object.assign(event, { quitusStatus: "validated", quitusSignedBy: payload.signedBy, quitusObservations: payload.observations, quitusSignature: payload.signature, quitusValidatedAt: new Date().toISOString(), pending: true });
        else if (calendarMatch[2] === "deductible") { const values = formValues(operation.body); Object.assign(event, { deductibleStatus: "pending", deductibleAmountCents: Number(values.amountCents || 0), deductiblePaymentMethod: values.paymentMethod || "", pending: true }); }
        else if (!calendarMatch[2] && operation.method === "PUT") Object.assign(event, payload, { pending: true });
        return true;
    }
    if (cachedUrl.startsWith("/api/messages") && Array.isArray(data.messages)) {
        if (operation.url === "/api/messages" && operation.method === "POST") {
            if (new URL(cachedUrl, location.origin).searchParams.get("clientId") !== String(payload.clientId || "")) return false;
            data.messages.unshift(synthetic.message);
            return true;
        }
        const messageId = operation.url.match(/^\/api\/messages\/([^/?]+)/)?.[1];
        const message = data.messages.find(item => String(item.id) === String(messageId || ""));
        if (message && operation.method === "PATCH") { Object.assign(message, { body: payload.body, updatedAt: new Date().toISOString(), pending: true }); return true; }
    }
    const reportId = operation.url.match(/^\/api\/technical-reports\/([^/]+)/)?.[1];
    if (reportId && cachedUrl === `/api/technical-reports/${reportId}` && data.report) {
        if (operation.method === "PUT" && operation.url === cachedUrl) Object.assign(data.report, payload, { pending: true, updatedAt: new Date().toISOString() });
        if (/\/submit$/.test(operation.url)) Object.assign(data.report, { status: "submitted", pending: true });
        if (/\/media$/.test(operation.url) && operation.method === "POST") data.report.media = [...(data.report.media || []), ...(synthetic.media || [])];
        const mediaId = operation.url.match(/\/media\/([^/?]+)$/)?.[1];
        if (mediaId && operation.method === "PATCH") data.report.media = (data.report.media || []).map(item => item.id === mediaId ? { ...item, ...payload, pending: true } : item);
        if (mediaId && operation.method === "DELETE") data.report.media = (data.report.media || []).filter(item => item.id !== mediaId);
        return true;
    }
    return false;
}

function isCacheableGet(pathname) { return pathname.startsWith("/api/calendar/") || pathname === "/api/technical-reports" || pathname.startsWith("/api/technical-reports/") && !pathname.endsWith("/pdf") || pathname.startsWith("/api/messages"); }
function isQueueableMutation(method, pathname) {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return false;
    if (pathname.startsWith("/api/messages")) return true;
    if (pathname.startsWith("/api/calendar/events")) return !pathname.endsWith("/deductible/review");
    if (pathname === "/api/technical-reports") return method === "POST";
    if (!pathname.startsWith("/api/technical-reports/")) return false;
    return !pathname.includes("/pdf-preview") && !pathname.endsWith("/validate") && !pathname.endsWith("/proofread") && !pathname.includes("/corrections") && !pathname.endsWith("/reopen") && !pathname.includes("/originals/");
}
function isJsonResponse(response) { return String(response.headers.get("Content-Type") || "").toLowerCase().includes("json"); }
function isDedicatedMobileSession() { return document.body.dataset.deviceType === "mobile" && ["mobile_admin", "team_lead", "technician"].includes(document.body.dataset.role); }
function currentScope() { const owner = String(document.body.dataset.accountId || ""); const user = String(document.body.dataset.userId || ""); return owner && user ? `${owner}:mobile:${user}` : ""; }
function cacheKey(url) { return `${currentScope()}:${url.pathname}${url.search}`; }
function jsonResponse(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "X-DepannHome-Offline": "true" } }); }
function dispatchQueueState(state, detail = {}) {
    pendingOfflineOperationCount()
        .then(pending => window.dispatchEvent(new CustomEvent("depannhome:offline-queue-state", { detail: { state, pending, ...detail } })))
        .catch(error => {
            console.error("[offline] Lecture de la file impossible :", error.name || "ERROR");
            window.dispatchEvent(new CustomEvent("depannhome:offline-queue-state", { detail: { state: "error", pending: null, message: "Impossible de lire la file hors ligne." } }));
        });
}
function registerBackgroundSync() {
    navigator.serviceWorker?.ready.then(registration => registration.sync?.register("depannhome-offline-sync")).catch(error => {
        console.error("[offline] Synchronisation en arrière-plan indisponible :", error.name || "ERROR");
        dispatchQueueState("error", { message: "L’envoi en arrière-plan est indisponible. Gardez l’application ouverte pour synchroniser." });
    });
}
function rememberActiveScope() {
    const scope = currentScope();
    if (scope) putRecord(METADATA_STORE, { key: "activeScope", value: scope }).catch(error => {
        console.error("[offline] Contexte de synchronisation indisponible :", error.name || "ERROR");
        dispatchQueueState("error", { message: "Le contexte de synchronisation en arrière-plan est indisponible." });
    });
}

function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains(QUEUE_STORE)) database.createObjectStore(QUEUE_STORE, { keyPath: "id" });
            if (!database.objectStoreNames.contains(CACHE_STORE)) database.createObjectStore(CACHE_STORE, { keyPath: "key" });
            if (!database.objectStoreNames.contains(MAPPING_STORE)) database.createObjectStore(MAPPING_STORE, { keyPath: "key" });
            if (!database.objectStoreNames.contains(METADATA_STORE)) database.createObjectStore(METADATA_STORE, { keyPath: "key" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function transact(storeName, mode, operation) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
        try {
            const transaction = database.transaction(storeName, mode);
            const request = operation(transaction.objectStore(storeName));
            let result;
            request.onsuccess = () => { result = request.result; };
            transaction.oncomplete = () => { database.close(); resolve(result); };
            transaction.onabort = transaction.onerror = () => { database.close(); reject(transaction.error || request.error || new Error("Transaction hors ligne impossible.")); };
        } catch (error) {
            database.close();
            reject(error);
        }
    });
}
function getAll(store) { return transact(store, "readonly", objectStore => objectStore.getAll()); }
function getRecord(store, key) { return transact(store, "readonly", objectStore => objectStore.get(key)); }
function putRecord(store, value) { return transact(store, "readwrite", objectStore => objectStore.put(value)); }
function deleteRecord(store, key) { return transact(store, "readwrite", objectStore => objectStore.delete(key)); }
