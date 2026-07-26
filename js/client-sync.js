const CLIENTS_KEY_PREFIX = "depannHomePro:clients:";
const QUEUE_KEY_PREFIX = "depannHomePro:clients-sync-queue:";
const MAX_ACTIVITY_HISTORY = 150;
const MAX_DELETED_ATTACHMENT_IDS = 500;

let onlineListenerRegistered = false;
let synchronizationPromise = null;
let silentSynchronizationTimer = null;

export async function initializeClientSynchronization() {
    if (!onlineListenerRegistered) {
        window.addEventListener("online", () => synchronizeClients().catch(() => {}));
        window.addEventListener("focus", () => synchronizeClients().catch(() => {}));
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") synchronizeClients().catch(() => {});
        });
        onlineListenerRegistered = true;
    }
    if (!silentSynchronizationTimer) {
        silentSynchronizationTimer = window.setInterval(() => {
            if (document.visibilityState === "visible") synchronizeClients().catch(() => {});
        }, 90_000);
    }

    return synchronizeClients();
}

export function getLocalClients() {
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
    synchronizeClients().catch(() => {});
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

export function deleteLocalClient(clientId) {
    if (!canWriteClients()) return false;
    if (!writeClients(getLocalClients().filter(client => client.id !== clientId))) return false;
    enqueue({ type: "delete", clientId });
    synchronizeClients().catch(() => {});
}

export async function synchronizeClients() {
    if (!navigator.onLine || !getAccountId()) return { ok: false, offline: true };
    if (synchronizationPromise) return synchronizationPromise;

    synchronizationPromise = synchronize().finally(() => {
        synchronizationPromise = null;
    });
    return synchronizationPromise;
}

async function synchronize() {
    const remoteResult = await request("/api/clients");
    if (!remoteResult.ok) return { ok: false, message: remoteResult.data?.message || "Serveur indisponible." };

    const remoteClients = Array.isArray(remoteResult.data?.clients) ? remoteResult.data.clients.map(normalizeClient) : [];
    if (!canWriteClients()) {
        writeClients(remoteClients);
        window.dispatchEvent(new CustomEvent("depannhome:clients-synchronized"));
        return { ok: true };
    }
    const localClients = getLocalClients();
    enqueueUnsyncedLocalClients(localClients, remoteClients);
    const merged = mergeClients(localClients, remoteClients);
    if (!writeClients(merged)) return { ok: false, message: "Espace de stockage local saturé. Supprimez ou compressez des fichiers clients." };

    const operations = getQueue();
    const clientsById = new Map(getLocalClients().map(client => [client.id, client]));
    for (const operation of operations) {
        const client = clientsById.get(operation.clientId);
        if (operation.type !== "delete" && !client) {
            removeQueuedOperation(operation.id);
            continue;
        }
        const result = operation.type === "delete"
            ? await request(`/api/clients/${encodeURIComponent(operation.clientId)}`, { method: "DELETE" })
            : await request(`/api/clients/${encodeURIComponent(client.id)}`, {
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

    const refreshed = await request("/api/clients");
    if (refreshed.ok) writeClients(mergeClients(getLocalClients(), refreshed.data.clients || []));
    window.dispatchEvent(new CustomEvent("depannhome:clients-synchronized"));
    return { ok: true };
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
        const deletedAttachmentIds = mergeDeletedAttachmentIds(existing.deletedAttachmentIds, client.deletedAttachmentIds);
        const deletedAttachments = new Set(deletedAttachmentIds);
        merged.set(client.id, {
            ...newest,
            attachments: (Array.isArray(newest.attachments) ? newest.attachments : [])
                .filter(attachment => attachment && !deletedAttachments.has(String(attachment.id || ""))),
            deletedAttachmentIds,
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
        return false;
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
    const type = operation?.type === "delete" ? "delete" : "upsert";
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
        attachments: Array.isArray(client?.attachments) ? client.attachments : [],
        deletedAttachmentIds: mergeDeletedAttachmentIds(client?.deletedAttachmentIds),
        activityHistory: mergeActivityHistory(client?.activityHistory),
        createdAt: validDate(client?.createdAt) || now,
        updatedAt: validDate(client?.updatedAt) || now
    };
}

function mergeDeletedAttachmentIds(...collections) {
    return [...new Set(collections.flatMap(collection => Array.isArray(collection) ? collection : [])
        .map(id => String(id || "").slice(0, 100))
        .filter(Boolean))].slice(-MAX_DELETED_ATTACHMENT_IDS);
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
    return document.body.dataset.role !== "technician";
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
