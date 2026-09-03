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
    assert.match(openClients, /selectedId, focusMessages: true/);
    assert.match(openClients, /nav-button\.active\[data-nav="clients"\]/);
    assert.match(clients, /else if \(!skipClientSynchronization\) scheduleClientSynchronization\(\)/);
});

test("la seconde lecture serveur est réservée aux modifications locales envoyées", () => {
    const synchronization = clientSync.slice(clientSync.indexOf("async function synchronize"), clientSync.indexOf("function applyRemoteChanges"));
    assert.match(synchronization, /if \(operations\.length\) \{\s*const refreshed = await request/);
});