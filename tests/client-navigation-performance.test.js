import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const navigation = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
const clients = readFileSync(new URL("../js/clients.js", import.meta.url), "utf8");
const clientSync = readFileSync(new URL("../js/client-sync.js", import.meta.url), "utf8");

test("l'ouverture Clients affiche immédiatement les dossiers locaux avant la synchronisation réseau", () => {
    const openClients = navigation.slice(navigation.indexOf("async function openClients"), navigation.indexOf("function openNotificationDestination"));
    const firstRender = openClients.indexOf("await renderClients");
    const synchronization = openClients.indexOf("await Promise.all");
    assert.ok(firstRender >= 0 && firstRender < synchronization);
    assert.match(openClients, /Promise\.all\(\[\s*selectedClientPromise,\s*synchronizeClients\(\{ forceFull: true \}\)/);
    assert.match(openClients, /renderClients\(\{[^}]*skipClientSynchronization: true/);
    assert.match(openClients, /activeSelectedId, focusMessages: true/);
    assert.match(openClients, /nav-button\.active\[data-nav="clients"\]/);
    assert.match(clients, /else if \(!skipClientSynchronization\) scheduleClientSynchronization\(\)/);
});

test("la seconde lecture serveur est réservée aux modifications locales envoyées", () => {
    const synchronization = clientSync.slice(clientSync.indexOf("async function synchronize"), clientSync.indexOf("function applyRemoteChanges"));
    assert.match(synchronization, /if \(operations\.length\) \{\s*const refreshed = await request/);
});

test("une synchronisation reçue rafraîchit automatiquement la fiche client ouverte sur PC", () => {
    assert.match(navigation, /depannhome:clients-synchronized/);
    assert.match(navigation, /const currentView = getCurrentClientView\(\)/);
    assert.match(navigation, /skipClientSynchronization: true/);
    assert.match(clients, /panel\.dataset\.clientDetailId = client\.id/);
    assert.match(clientSync, /new EventSource\("\/api\/clients\/events", \{ withCredentials: true \}\)/);
    assert.match(clientSync, /client-changed/);
    assert.match(clientSync, /FALLBACK_SYNCHRONIZATION_INTERVAL = 5 \* 60_000/);
    assert.doesNotMatch(clientSync, /SILENT_SYNCHRONIZATION_INTERVAL = 15_000/);
});

test("une synchronisation en arrière-plan conserve l’écran Nouveau client", () => {
    const openClients = navigation.slice(navigation.indexOf("async function openClients"), navigation.indexOf("function openNotificationDestination"));
    assert.match(openClients, /if \(isClientFormView\(currentView\)\) return/);
    assert.match(navigation, /if \(editId\) return \{ editId, clientWorkspace: "create" \}/);
    assert.match(navigation, /return clientWorkspace \? \{ clientWorkspace \} : \{\}/);
    assert.match(navigation, /if \(isClientFormView\(currentView\)\) return;\s*renderClients\(/);
    assert.match(navigation, /return Boolean\(view\?\.editId \|\| view\?\.clientWorkspace === "create"\)/);
});