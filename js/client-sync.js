const LEGACY_CLIENTS_KEY = "depannHomePro:clients";
const CLIENTS_KEY_PREFIX = "depannHomePro:clients:";
const QUEUE_KEY_PREFIX = "depannHomePro:clients-sync-queue:";

let onlineListenerRegistered = false;
let synchronizationPromise = null;
let refreshTimerStarted = false;

export async function initializeClientSynchronization() {
    migrateLegacyClients();

    if (!onlineListenerRegistered) {
        window.addEventListener("online", () => synchronizeClients().catch(() => {}));
        window.addEventListener("focus", () => synchronizeClients().catch(() => {}));
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") synchronizeClients().catch(() => {});
        });
        onlineListenerRegistered = true;
    }

    if (!refreshTimerStarted) {
        window.setInterval(() => synchronizeClients().catch(() => {}), 30_000);
        refreshTimerStarted = true;
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

    localStorage.setItem(getClientsKey(), JSON.stringify(nextClients));
    enqueue({ type: "upsert", client: nextClient });
    synchronizeClients().catch(() => {});
    return nextClient;
}

export function deleteLocalClient(clientId) {
    localStorage.setItem(getClientsKey(), JSON.stringify(getLocalClients().filter(client => client.id !== clientId)));
    enqueue({ type: "delete", clientId });
    synchronizeClients().catch(() => {});
}

export async function synchronizeClients() {
    if (!navigator.onLine || !getUserId()) return { ok: false, offline: true };
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
    const localClients = getLocalClients();
    const merged = mergeClients(localClients, remoteClients);
    writeClients(merged);

    const operations = getQueue();
    for (const operation of operations) {
        const result = operation.type === "delete"
            ? await request(`/api/clients/${encodeURIComponent(operation.clientId)}`, { method: "DELETE" })
            : await request(`/api/clients/${encodeURIComponent(operation.client.id)}`, {
                method: "PUT",
                body: JSON.stringify({ client: operation.client })
            });
        if (!result.ok) return { ok: false, message: result.data?.message || "Synchronisation interrompue." };
        removeQueuedOperation(operation.id);
    }

    const refreshed = await request("/api/clients");
    if (refreshed.ok) writeClients(mergeClients(getLocalClients(), refreshed.data.clients || []));
    return { ok: true };
}

function mergeClients(firstClients, secondClients) {
    const merged = new Map();
    [...firstClients, ...secondClients].map(normalizeClient).forEach(client => {
        const existing = merged.get(client.id);
        if (!existing || getTimestamp(client.updatedAt) >= getTimestamp(existing.updatedAt)) merged.set(client.id, client);
    });
    return [...merged.values()];
}

function enqueue(operation) {
    const queue = getQueue();
    const key = operation.type === "delete" ? operation.clientId : operation.client.id;
    const nextQueue = queue.filter(item => (item.type === "delete" ? item.clientId : item.client.id) !== key);
    nextQueue.push({ ...operation, id: `sync-${Date.now()}-${Math.random().toString(16).slice(2)}` });
    localStorage.setItem(getQueueKey(), JSON.stringify(nextQueue));
}

function getQueue() {
    try {
        return JSON.parse(localStorage.getItem(getQueueKey())) || [];
    } catch {
        return [];
    }
}

function removeQueuedOperation(operationId) {
    localStorage.setItem(getQueueKey(), JSON.stringify(getQueue().filter(item => item.id !== operationId)));
}

function writeClients(clients) {
    localStorage.setItem(getClientsKey(), JSON.stringify(clients.map(normalizeClient)));
}

function migrateLegacyClients() {
    const key = getClientsKey();
    if (localStorage.getItem(key) || !getUserId()) return;
    try {
        const legacy = JSON.parse(localStorage.getItem(LEGACY_CLIENTS_KEY)) || [];
        if (!Array.isArray(legacy) || !legacy.length) return;
        const clients = legacy.map(normalizeClient);
        writeClients(clients);
        clients.forEach(client => enqueue({ type: "upsert", client }));
    } catch {
        // Ignore unreadable legacy data.
    }
}

function normalizeClient(client) {
    const now = new Date().toISOString();
    return {
        ...client,
        id: String(client?.id || `client-${Date.now()}-${Math.random().toString(16).slice(2)}`),
        name: client?.name || "Client sans nom",
        attachments: Array.isArray(client?.attachments) ? client.attachments : [],
        createdAt: validDate(client?.createdAt) || now,
        updatedAt: validDate(client?.updatedAt) || now
    };
}

function validDate(value) {
    const date = new Date(value || "");
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function getTimestamp(value) {
    return new Date(value || 0).getTime() || 0;
}

function getUserId() {
    return String(document.body.dataset.userId || "").replace(/[^a-zA-Z0-9_-]/g, "");
}

function getClientsKey() {
    return `${CLIENTS_KEY_PREFIX}${getUserId() || "anonymous"}`;
}

function getQueueKey() {
    return `${QUEUE_KEY_PREFIX}${getUserId() || "anonymous"}`;
}

async function request(url, options = {}) {
    try {
        const response = await fetch(url, {
            credentials: "same-origin",
            headers: { "Content-Type": "application/json", ...(options.headers || {}) },
            ...options
        });
        const data = response.status === 204 ? null : await response.json().catch(() => null);
        return { ok: response.ok, data };
    } catch {
        return { ok: false, data: null };
    }
}
