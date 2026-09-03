const CLIENTS_KEY_PREFIX = "depannHomePro:clients:";
const QUEUE_KEY_PREFIX = "depannHomePro:clients-sync-queue:";
const CURSOR_KEY_PREFIX = "depannHomePro:clients-sync-cursor:";
const MAX_ACTIVITY_HISTORY = 150;
const SILENT_SYNCHRONIZATION_INTERVAL = 90_000;
const DESKTOP_SYNCHRONIZATION_DELAY = 1_500;
const FOCUS_SYNCHRONIZATION_DELAY = 3_000;

let onlineListenerRegistered = false;
let synchronizationPromise = null;
let synchronizationIsFull = false;
let silentSynchronizationTimer = null;
let scheduledSynchronizationTimer = null;

export async function initializeClientSynchronization() {
    if (isAccountant()) return { ok: true, skipped: true };
    if (!onlineListenerRegistered) {
        window.addEventListener("online", () => scheduleClientSynchronization(0));
        window.addEventListener("focus", () => scheduleClientSynchronization(FOCUS_SYNCHRONIZATION_DELAY));
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") scheduleClientSynchronization(FOCUS_SYNCHRONIZATION_DELAY);
        });
        onlineListenerRegistered = true;
    }
    if (!silentSynchronizationTimer) {
        silentSynchronizationTimer = window.setInterval(() => {
            if (document.visibilityState === "visible") scheduleClientSynchronization(0);
        }, SILENT_SYNCHRONIZATION_INTERVAL);
    }

    return synchronizeClients();
}

export function getLocalClients() {
    if (isAccountant()) return [];
    try {
        return (JSON.parse(localStorage.getItem(getClientsKey())) || []).map(normalizeClient);
    } catch {
        return [];
    }
}

export function saveLocalClient(client) {
    if (!canWriteClients()) return null;
    const clients = getLocalClients();
    const existing = clients.find(item => item.id === client.id);
    const nextClient = normalizeClient({
        ...client,
        createdAt: existing?.createdAt || client.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });
    const nextClients = existing
        ? clients.map(item => item.id === nextClient.id ? nextClient : item)
        : [...clients, nextClient];

    if (!writeClients(nextClients)) return null;
    enqueue({ type: "upsert", clientId: nextClient.id });
    scheduleClientSynchronization();
    return nextClient;
}

export function addClientActivity(clientId, activity) {
    if (!canWriteClients()) return false;
    const client = getLocalClients().find(item => item.id === String(clientId));
    if (!client) return false;
    saveLocalClient({
        ...client,
        activityHistory: mergeActivityHistory(client.activityHistory, [normalizeActivity({
            ...activity,
            actorName: activity?.actorName || document.body.dataset.userName || ""
        })])
    });
    return true;
}

export function addClientActivityByName(clientName, activity) {
    const normalizedName = normalizeName(clientName);
    const client = getLocalClients().find(item => normalizeName(item.name) === normalizedName);
    return client ? addClientActivity(client.id, activity) : false;
}

export function removeLocalClient(clientId) {
    if (!canWriteClients()) return false;
    return writeClients(getLocalClients().filter(client => client.id !== clientId));
}

export function scheduleClientSynchronization(delay = DESKTOP_SYNCHRONIZATION_DELAY) {
    if (isAccountant()) return;
    window.clearTimeout(scheduledSynchronizationTimer);
    const effectiveDelay = document.body.classList.contains("desktop-device") ? delay : 0;
    scheduledSynchronizationTimer = window.setTimeout(() => {
        scheduledSynchronizationTimer = null;
        synchronizeClients().catch(() => {});
    }, effectiveDelay);
}

export async function synchronizeClients(options = {}) {
    if (isAccountant()) return { ok: true, skipped: true };
    if (!navigator.onLine || !getAccountId()) return { ok: false, offline: true };
    const forceFull = options.forceFull === true;
    if (synchronizationPromise) {
        if (forceFull && !synchronizationIsFull) return synchronizationPromise.then(() => synchronizeClients({ forceFull: true }));
        return synchronizationPromise;
    }

    synchronizationIsFull = forceFull;
    synchronizationPromise = synchronize({ forceFull }).finally(() => {
        synchronizationPromise = null;
        synchronizationIsFull = false;
    });
    return synchronizationPromise;
}

async function synchronize({ forceFull = false } = {}) {
    const remoteResult = await request(getClientSynchronizationUrl(forceFull));
    if (!remoteResult.ok) return { ok: false, message: remoteResult.data?.message || "Serveur indisponible." };

    const remoteClients = Array.isArray(remoteResult.data?.clients) ? remoteResult.data.clients.map(normalizeClient) : [];
    const deletedClientIds = Array.isArray(remoteResult.data?.deletedClientIds) ? remoteResult.data.deletedClientIds : [];
    const cursor = validDate(remoteResult.data?.cursor);
    const isInitialSynchronization = !getSynchronizationCursor() && !forceFull;
    if (!canWriteClients()) {
        const synchronizedClients = isInitialSynchronization
            ? remoteClients
            : forceFull ? mergeRemoteWithQueuedClients(remoteClients) : applyRemoteChanges(getLocalClients(), remoteClients, deletedClientIds);
        if (!writeClients(synchronizedClients)) {
            return { ok: false, message: "Espace de stockage local saturé. Supprimez ou compressez des fichiers clients." };
        }
        if (cursor) writeSynchronizationCursor(cursor);
        window.dispatchEvent(new CustomEvent("depannhome:clients-synchronized"));
        return { ok: true };
    }
    const localClients = forceFull ? mergeRemoteWithQueuedClients(remoteClients) : applyRemoteChanges(getLocalClients(), remoteClients, deletedClientIds);
    if (isInitialSynchronization) enqueueUnsyncedLocalClients(localClients, remoteClients);
    const merged = mergeClients(localClients, remoteClients);
    if (!writeClients(merged)) return { ok: false, message: "Espace de stockage local saturé. Supprimez ou compressez des fichiers clients." };
    if (cursor) writeSynchronizationCursor(cursor);

    const operations = getQueue();
    const clientsById = new Map(getLocalClients().map(client => [client.id, client]));
    for (const operation of operations) {
        const client = clientsById.get(operation.clientId);
        if (!client) {
            removeQueuedOperation(operation.id);
            continue;
        }
        const result = await request(`/api/clients/${encodeURIComponent(client.id)}`, {
                method: "PUT",
                body: JSON.stringify({ client })
            });
        if (result.status === 410 && operation.type === "upsert") {
            writeClients(getLocalClients().filter(item => item.id !== operation.clientId));
            removeQueuedOperation(operation.id);
            continue;
        }
        if (!result.ok) return { ok: false, message: result.data?.message || "Synchronisation interrompue." };
        removeQueuedOperation(operation.id);
    }

    if (operations.length) {
        const refreshed = await request(getClientSynchronizationUrl(forceFull));
        if (refreshed.ok) {
            const refreshedClients = Array.isArray(refreshed.data?.clients) ? refreshed.data.clients.map(normalizeClient) : [];
            const refreshedDeletedClientIds = Array.isArray(refreshed.data?.deletedClientIds) ? refreshed.data.deletedClientIds : [];
            const finalClients = forceFull ? mergeRemoteWithQueuedClients(refreshedClients) : applyRemoteChanges(getLocalClients(), refreshedClients, refreshedDeletedClientIds);
            if (!writeClients(finalClients)) {
                return { ok: false, message: "Espace de stockage local saturé. Supprimez ou compressez des fichiers clients." };
            }
            const refreshedCursor = validDate(refreshed.data?.cursor);
            if (refreshedCursor) writeSynchronizationCursor(refreshedCursor);
        }
    }
    window.dispatchEvent(new CustomEvent("depannhome:clients-synchronized"));
    return { ok: true };
}

function applyRemoteChanges(localClients, remoteClients, deletedClientIds = []) {
    const deleted = new Set(deletedClientIds.map(clientId => String(clientId || "")).filter(Boolean));
    const remainingClients = localClients.filter(client => !deleted.has(client.id));
    if (deleted.size) writeQueue(getQueue().filter(operation => !deleted.has(operation.clientId)));
    return mergeClients(remainingClients, remoteClients);
}

function mergeRemoteWithQueuedClients(remoteClients) {
    const queuedClientIds = new Set(getQueue().map(operation => operation.clientId));
    const queuedLocalClients = getLocalClients().filter(client => queuedClientIds.has(client.id));
    return mergeClients(remoteClients, queuedLocalClients);
}

function mergeClients(firstClients, secondClients) {
    const merged = new Map();
    [...firstClients, ...secondClients].map(normalizeClient).forEach(client => {
        const existing = merged.get(client.id);
        if (!existing) {
            merged.set(client.id, client);
            return;
        }
        const newest = getTimestamp(client.updatedAt) > getTimestamp(existing.updatedAt) ? client : existing;
        const attachments = new Map([...(Array.isArray(existing.attachments) ? existing.attachments : []), ...(Array.isArray(client.attachments) ? client.attachments : [])].filter(attachment => attachment?.id).map(attachment => [String(attachment.id), attachment]));
        merged.set(client.id, {
            ...newest,
            attachments: [...attachments.values()],
            deletedAttachmentIds: [],
            activityHistory: mergeActivityHistory(existing.activityHistory, client.activityHistory)
        });
    });
    return [...merged.values()];
}

function enqueue(operation) {
    const compactOperation = normalizeQueueOperation(operation);
    if (!compactOperation) return false;
    const nextQueue = getQueue().filter(item => item.clientId !== compactOperation.clientId);
    nextQueue.push(compactOperation);
    return writeQueue(nextQueue);
}

function enqueueUnsyncedLocalClients(localClients, remoteClients) {
    const remoteById = new Map(remoteClients.map(client => [client.id, client]));
    localClients.forEach(client => {
        const remoteClient = remoteById.get(client.id);
        if (!remoteClient || getTimestamp(client.updatedAt) > getTimestamp(remoteClient.updatedAt)) {
            enqueue({ type: "upsert", clientId: client.id });
        }
    });
}

function getQueue() {
    try {
        return (JSON.parse(localStorage.getItem(getQueueKey())) || []).map(normalizeQueueOperation).filter(Boolean);
    } catch {
        return [];
    }
}

function removeQueuedOperation(operationId) {
    writeQueue(getQueue().filter(item => item.id !== operationId));
}

function writeClients(clients) {
    try {
        localStorage.setItem(getClientsKey(), JSON.stringify(clients.map(normalizeClient)));
        return true;
    } catch {
        try {
            const pendingClientIds = new Set(getQueue().map(operation => operation.clientId));
            const compacted = clients.map(client => {
                const normalized = normalizeClient(client);
                if (pendingClientIds.has(normalized.id)) return normalized;
                return {
                    ...normalized,
                    attachments: normalized.attachments.map(attachment => ({ ...attachment, dataUrl: "", cachedLocally: false }))
                };
            });
            localStorage.setItem(getClientsKey(), JSON.stringify(compacted));
            return true;
        } catch {
            return false;
        }
    }
}

function writeQueue(queue) {
    try {
        localStorage.setItem(getQueueKey(), JSON.stringify(queue.map(normalizeQueueOperation).filter(Boolean)));
        return true;
    } catch {
        try {
            localStorage.removeItem(getQueueKey());
            localStorage.setItem(getQueueKey(), JSON.stringify(queue.slice(-1).map(normalizeQueueOperation).filter(Boolean)));
            return true;
        } catch {
            return false;
        }
    }
}

function normalizeQueueOperation(operation) {
    const type = "upsert";
    const clientId = String(operation?.clientId || operation?.client?.id || "");
    if (!clientId) return null;
    return {
        id: String(operation?.id || `sync-${Date.now()}-${Math.random().toString(16).slice(2)}`),
        type,
        clientId
    };
}

function normalizeClient(client) {
    const now = new Date().toISOString();
    return {
        ...client,
        id: String(client?.id || `client-${Date.now()}-${Math.random().toString(16).slice(2)}`),
        name: client?.name || "Client sans nom",
        clientStatus: client?.clientStatus === "archived" ? "archived" : "active",
        archivedAt: client?.archivedAt || null,
        attachments: Array.isArray(client?.attachments) ? client.attachments.map(attachment => ({ ...attachment, cachedLocally: attachment?.cachedLocally !== false })) : [],
        deletedAttachmentIds: [],
        activityHistory: mergeActivityHistory(client?.activityHistory),
        createdAt: validDate(client?.createdAt) || now,
        updatedAt: validDate(client?.updatedAt) || now
    };
}

function mergeActivityHistory(...histories) {
    const entries = new Map();
    histories.flat().filter(Boolean).map(normalizeActivity).forEach(entry => entries.set(entry.id, entry));
    return [...entries.values()]
        .sort((first, second) => getTimestamp(second.createdAt) - getTimestamp(first.createdAt))
        .slice(0, MAX_ACTIVITY_HISTORY);
}

function normalizeActivity(activity) {
    const createdAt = validDate(activity?.createdAt) || new Date().toISOString();
    return {
        id: String(activity?.id || `activity-${Date.now()}-${Math.random().toString(16).slice(2)}`).slice(0, 100),
        type: String(activity?.type || "other").slice(0, 40),
        label: String(activity?.label || "Activité du dossier").slice(0, 200),
        detail: String(activity?.detail || "").slice(0, 500),
        documentId: String(activity?.documentId || "").slice(0, 30),
        attachmentId: String(activity?.attachmentId || "").slice(0, 100),
        appointmentId: String(activity?.appointmentId || "").replace(/[^0-9]/g, "").slice(0, 30),
        actorName: String(activity?.actorName || "").slice(0, 100),
        createdAt
    };
}

function normalizeName(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

function validDate(value) {
    const date = new Date(value || "");
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function getTimestamp(value) {
    return new Date(value || 0).getTime() || 0;
}

function getAccountId() {
    return String(document.body.dataset.accountId || document.body.dataset.userId || "").replace(/[^a-zA-Z0-9_-]/g, "");
}

function canWriteClients() {
    return ["admin", "mobile_admin"].includes(document.body.dataset.role);
}

function isAccountant() {
    return document.body.dataset.role === "accountant";
}

function getClientsKey() {
    const accountId = getAccountId();
    if (!accountId) throw new Error("Compte non initialisé.");
    return `${CLIENTS_KEY_PREFIX}${accountId}`;
}

function getQueueKey() {
    const accountId = getAccountId();
    if (!accountId) throw new Error("Compte non initialisé.");
    return `${QUEUE_KEY_PREFIX}${accountId}`;
}

function getSynchronizationCursor() {
    try {
        return validDate(localStorage.getItem(getSynchronizationCursorKey()));
    } catch {
        return "";
    }
}

function writeSynchronizationCursor(cursor) {
    try {
        localStorage.setItem(getSynchronizationCursorKey(), cursor);
    } catch {
        // Sans espace pour le curseur, la prochaine synchronisation sera complète mais reste fonctionnelle.
    }
}

function getSynchronizationCursorKey() {
    const accountId = getAccountId();
    if (!accountId) throw new Error("Compte non initialisé.");
    return `${CURSOR_KEY_PREFIX}${accountId}`;
}

function getClientSynchronizationUrl(forceFull = false) {
    if (forceFull) return "/api/clients";
    const cursor = getSynchronizationCursor();
    return cursor ? `/api/clients?since=${encodeURIComponent(cursor)}` : "/api/clients";
}

async function request(url, options = {}) {
    try {
        const response = await fetch(url, {
            credentials: "same-origin",
            headers: { "Content-Type": "application/json", ...(options.headers || {}) },
            ...options
        });
        const data = response.status === 204 ? null : await response.json().catch(() => null);
        return { ok: response.ok, data, status: response.status };
    } catch {
        return { ok: false, data: null, status: 0 };
    }
}
