import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const navigation = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
const clients = readFileSync(new URL("../js/clients.js", import.meta.url), "utf8");
const clientSync = readFileSync(new URL("../js/client-sync.js", import.meta.url), "utf8");

test("l'ouverture Clients charge les messages et les dossiers en parallèle sans changer la vue finale", () => {
    const openClients = navigation.slice(navigation.indexOf("async function openClients"), navigation.indexOf("function openNotificationDestination"));
    assert.match(openClients, /Promise\.all\(\[\s*selectedClientPromise,\s*synchronizeClients\(\{ forceFull: true \}\)/);
    assert.match(openClients, /renderClients\(\{[^}]*skipClientSynchronization: true/);
    assert.match(openClients, /selectedId, focusMessages: true/);
    assert.match(clients, /else if \(!skipClientSynchronization\) scheduleClientSynchronization\(\)/);
});

test("la seconde lecture serveur est réservée aux modifications locales envoyées", () => {
    const synchronization = clientSync.slice(clientSync.indexOf("async function synchronize"), clientSync.indexOf("function applyRemoteChanges"));
    assert.match(synchronization, /if \(operations\.length\) \{\s*const refreshed = await request/);
});