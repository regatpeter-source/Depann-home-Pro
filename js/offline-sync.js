const DATABASE_NAME = "depannhome-mobile-offline";
const DATABASE_VERSION = 2;
const QUEUE_STORE = "operations";
const CACHE_STORE = "responses";
const MAPPING_STORE = "mappings";
const METADATA_STORE = "metadata";
const RETRY_DELAY = 30_000;

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
    window.addEventListener("depannhome:offline-session-ended", () => deleteRecord(METADATA_STORE, "activeScope").catch(() => {}));
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

    if (method === "GET" && isCacheableGet(requestUrl.pathname)) {
        try {
            const response = await fetcher(input, init);
            if (response.ok && isJsonResponse(response)) await cacheResponse(requestUrl, response.clone());
            if (response.ok || response.status < 500) return response;
            return await cachedResponse(requestUrl) || response;
        } catch (error) {
            const cached = await cachedResponse(requestUrl);
            if (cached) return cached;
            throw error;
        }
    }

    if (!isQueueableMutation(method, requestUrl.pathname)) return fetcher(input, init);
    if (navigator.onLine !== false) {
        try { return await fetcher(input, init); }
        catch { /* La requête sera conservée ci-dessous. */ }
    }

    const operation = await createOperation(requestUrl, method, init);
    const stored = await enqueueOperation(operation);
    if (!stored) return jsonResponse({ message: "Le stockage hors ligne est saturé. Libérez de l’espace avant de continuer." }, 507);
    const synthetic = await syntheticPayload(operation);
    await applyOptimisticCache(operation, synthetic);
    if (operation.metadata.localReportId && synthetic.report) await cacheLocalReport(operation, synthetic.report);
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

function scheduleFlush(delay) {
    window.setTimeout(() => flushOfflineQueue().catch(() => {}), delay);
}

async function flushOperations() {
    dispatchQueueState("syncing");
    const scope = currentScope();
    const operations = (await getAll(QUEUE_STORE)).filter(item => item.scope === scope).sort((a, b) => a.createdAt - b.createdAt);
    let sent = 0;
    for (const operation of operations) {
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
        await recordResponseMappings(operation, response.clone());
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

async function createOperation(url, method, init) {
    const id = crypto.randomUUID();
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
    if (method === "POST" && url.pathname === "/api/calendar/events") operation.metadata.localEventId = `offline-event-${crypto.randomUUID()}`;
    if (method === "POST" && url.pathname === "/api/technical-reports") operation.metadata.localReportId = `offline-report-${crypto.randomUUID()}`;
    return operation;
}

async function enqueueOperation(operation) {
    try {
        const operations = await getAll(QUEUE_STORE);
        if (operation.method === "PUT" && /\/api\/technical-reports\/[^/]+$/.test(operation.url)) {
            const previous = operations.filter(item => item.scope === operation.scope && item.method === operation.method && item.url === operation.url && !item.blocked).at(-1);
            if (previous) operation.id = previous.id;
        }
        await putRecord(QUEUE_STORE, operation);
        return true;
    } catch {
        return false;
    }
}

async function prepareReplay(operation) {
    let url = operation.url;
    const mappings = await getAll(MAPPING_STORE);
    mappings.filter(item => item.scope === operation.scope).forEach(item => { url = url.replaceAll(encodeURIComponent(item.localId), encodeURIComponent(item.remoteId)).replaceAll(item.localId, item.remoteId); });
    const headers = new Headers(operation.headers || []);
    Object.entries(replayHeadersProvider?.() || {}).forEach(([name, value]) => headers.set(name, value));
    headers.set("X-DepannHome-Offline-Operation", operation.id);
    const body = deserializeBody(operation.body);
    if (operation.body?.type === "form-data") headers.delete("Content-Type");
    return { url, options: { method: operation.method, credentials: "same-origin", headers, ...(body === undefined ? {} : { body }) } };
}

async function recordResponseMappings(operation, response) {
    const data = await response.json().catch(() => null);
    const mappings = [];
    const media = Array.isArray(data?.media) ? data.media : [];
    (operation.metadata?.localMediaIds || []).forEach((localId, index) => { if (media[index]?.id) mappings.push([localId, String(media[index].id)]); });
    if (operation.metadata?.localEventId && data?.id) mappings.push([operation.metadata.localEventId, String(data.id)]);
    if (operation.metadata?.localReportId && data?.id) mappings.push([operation.metadata.localReportId, String(data.id)]);
    await Promise.all(mappings.map(([localId, remoteId]) => putRecord(MAPPING_STORE, { key: `${operation.scope}:${localId}`, scope: operation.scope, localId, remoteId })));
}

async function updateAttempt(operation, message, blocked = false) {
    await putRecord(QUEUE_STORE, { ...operation, attempts: Number(operation.attempts || 0) + 1, lastAttemptAt: Date.now(), lastError: message, blocked });
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
    if (operation.url === "/api/calendar/events" && operation.method === "POST") return { ...queued, id: operation.metadata.localEventId, ids: [operation.metadata.localEventId], count: 1 };
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
    if (record) return new Response(record.body, { status: record.status || 200, headers: record.headers });
    const appointmentId = url.pathname.match(/^\/api\/technical-reports\/appointments\/(\d+)$/)?.[1];
    if (!appointmentId) return null;
    const appointment = await findCachedAppointment(appointmentId);
    return appointment ? jsonResponse({ appointment, report: null }) : null;
}

async function cacheLocalReport(operation, report) {
    const url = new URL(`/api/technical-reports/${operation.metadata.localReportId}`, location.origin);
    await putRecord(CACHE_STORE, { key: cacheKey(url), scope: operation.scope, url: url.pathname, status: 200, headers: [["content-type", "application/json"]], body: JSON.stringify({ report, originals: [], corrections: [], lock: { lockedBy: document.body.dataset.userId || "", userName: document.body.dataset.userName || "Poste mobile" } }), updatedAt: Date.now() });
    const appointmentUrl = new URL(`/api/technical-reports/appointments/${encodeURIComponent(report.appointmentId)}`, location.origin);
    const appointmentRecord = await getRecord(CACHE_STORE, cacheKey(appointmentUrl));
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
        if (operation.url === "/api/calendar/events" && operation.method === "POST") { data.events.push({ ...payload, id: synthetic.id, createdBy: document.body.dataset.userId || "", createdDeviceType: "mobile", pending: true }); return true; }
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
function dispatchQueueState(state, detail = {}) { pendingOfflineOperationCount().then(pending => window.dispatchEvent(new CustomEvent("depannhome:offline-queue-state", { detail: { state, pending, ...detail } }))); }
function registerBackgroundSync() { navigator.serviceWorker?.ready.then(registration => registration.sync?.register("depannhome-offline-sync")).catch(() => {}); }
function rememberActiveScope() { const scope = currentScope(); if (scope) putRecord(METADATA_STORE, { key: "activeScope", value: scope }).catch(() => {}); }

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
        const transaction = database.transaction(storeName, mode);
        const request = operation(transaction.objectStore(storeName));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => database.close();
        transaction.onerror = () => { database.close(); reject(transaction.error); };
    });
}
function getAll(store) { return transact(store, "readonly", objectStore => objectStore.getAll()); }
function getRecord(store, key) { return transact(store, "readonly", objectStore => objectStore.get(key)); }
function putRecord(store, value) { return transact(store, "readwrite", objectStore => objectStore.put(value)); }
function deleteRecord(store, key) { return transact(store, "readwrite", objectStore => objectStore.delete(key)); }
