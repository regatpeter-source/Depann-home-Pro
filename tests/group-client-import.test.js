import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createGroupClientCopy, isSameGroupClientIdentity } from "../server/clients.js";

const server = readFileSync(new URL("../server/clients.js", import.meta.url), "utf8");
const client = readFileSync(new URL("../js/clients.js", import.meta.url), "utf8");

test("la reprise crée une fiche indépendante sans documents de l’entreprise source", () => {
    const copy = createGroupClientCopy({
        id: "client-source",
        type: "Professionnel",
        name: "Atelier Martin",
        phone: "01 02 03 04 05",
        email: "contact@example.fr",
        address: "1 rue du Test",
        city: "Lyon",
        equipment: "Portail",
        notes: "Accès cour",
        attachments: [{ id: "file-secret", type: "Facture" }],
        activityHistory: [{ id: "activity-secret", label: "Facture créée" }]
    }, {
        sourceCompanyId: "12",
        sourceClientId: "client-source",
        sourceCompanyName: "Entreprise Source",
        actorName: "Admin Groupe"
    }, { clientId: "client-copy", now: "2026-08-22T10:00:00.000Z" });
    assert.equal(copy.id, "client-copy");
    assert.equal(copy.name, "Atelier Martin");
    assert.deepEqual(copy.attachments, []);
    assert.equal(copy.activityHistory.length, 1);
    assert.match(copy.activityHistory[0].label, /Entreprise Source/);
    assert.match(copy.activityHistory[0].detail, /sans les documents ni l’historique/);
    assert.deepEqual(copy.groupImport, { sourceCompanyId: "12", sourceCompanyName: "Entreprise Source", sourceClientId: "client-source", importedAt: "2026-08-22T10:00:00.000Z" });
});

test("les doublons sont reconnus par origine, e-mail, téléphone ou identité postale", () => {
    assert.equal(isSameGroupClientIdentity({ groupImport: { sourceCompanyId: "12", sourceClientId: "client-source" } }, {}, { sourceCompanyId: 12, sourceClientId: "client-source" }), true);
    assert.equal(isSameGroupClientIdentity({ email: "CLIENT@EXAMPLE.FR" }, { email: "client@example.fr" }), true);
    assert.equal(isSameGroupClientIdentity({ phone: "06 12 34 56 78" }, { phone: "+33 6 12 34 56 78" }), true);
    assert.equal(isSameGroupClientIdentity({ name: "M. Durand", address: "2 rue A", city: "Paris" }, { name: "M. Durand", address: "2 RUE A", city: "PARIS" }), true);
    assert.equal(isSameGroupClientIdentity({ name: "M. Durand" }, { name: "M. Durand" }), false);
});

test("l’API valide le groupe, exclut l’entreprise active et audite chaque reprise", () => {
    assert.match(server, /app\.get\("\/api\/clients\/group-import"[^\n]*requireGroupClientImportAccess/);
    assert.match(server, /app\.post\("\/api\/clients\/group-import"[^\n]*requireClientWriteAccess, requireGroupClientImportAccess/);
    assert.match(server, /company\.group_id=\$1 AND company\.is_active=TRUE AND company\.company_owner_id<>\$2/);
    assert.match(server, /company\.group_id=\$3 AND company\.is_active=TRUE/);
    assert.match(server, /source_client\.owner_id=\$1 AND source_client\.client_id=\$2 AND source_client\.client_status='active'/);
    assert.match(server, /pg_advisory_xact_lock/);
    assert.match(server, /'client_imported'/);
    assert.match(server, /request\.user\?\.role !== "admin" \|\| !request\.user\?\.isGroupAdministrator \|\| !request\.user\?\.groupId/);
});

test("l’option Clients apparaît uniquement dans un contexte Groupe administré", () => {
    assert.match(client, /document\.body\.dataset\.groupAdmin === "true" && Boolean\(document\.body\.dataset\.groupId\)/);
    assert.match(client, /Prendre un client du groupe/);
    assert.match(client, /Entreprise source/);
    assert.match(client, /Client à reprendre/);
    assert.match(client, /Les devis, factures, rapports, rendez-vous, messages, historiques et fichiers resteront uniquement dans l’entreprise source/);
});