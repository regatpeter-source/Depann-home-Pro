import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = path => readFileSync(new URL(path, import.meta.url), "utf8");
const templates = source("../server/document-templates.js");
const collaboration = source("../server/collaboration.js");
const clientSync = source("../js/client-sync.js");
const localLibrary = source("../js/local-library.js");
const messages = source("../js/messages.js");
const navigation = source("../js/navigation.js");

test("un modèle de devis est créé, lu, modifié, activé et rendu uniquement pour son entreprise", () => {
    assert.match(templates, /UNIQUE\(owner_id, document_type, version\)/);
    assert.match(templates, /depannhome_document_templates_active_idx ON depannhome_document_templates\(owner_id, document_type\)/);
    assert.match(templates, /WHERE owner_id=\$1 AND document_type=\$2 ORDER BY version DESC/);
    assert.match(templates, /SELECT COALESCE\(MAX\(version\),0\)\+1 AS version FROM depannhome_document_templates WHERE owner_id=\$1 AND document_type=\$2/);
    assert.match(templates, /WHERE id=\$1 AND owner_id=\$2 AND document_type=\$3 AND status<>'archived'/);
    assert.match(templates, /SET status='active'.*WHERE id=\$1 AND owner_id=\$2 AND document_type=\$3/);
    assert.match(templates, /template\.owner_id=\$1 AND template\.document_type IN/);
});

test("une facture hérite seulement du modèle de devis de la même entreprise", () => {
    assert.match(templates, /WHERE owner_id=\$1 AND document_type='quote' AND status='active' LIMIT 1/);
    assert.match(templates, /renderActiveCustomTemplate\(ownerId, documentTypeValue, model\)/);
    assert.match(templates, /template\.owner_id=\$1/);
});

test("clients et bibliothèque locale utilisent l’identifiant de l’entreprise active", () => {
    assert.match(clientSync, /document\.body\.dataset\.accountId/);
    assert.match(clientSync, /`\$\{CLIENTS_KEY_PREFIX\}\$\{accountId\}`/);
    assert.match(clientSync, /`\$\{QUEUE_KEY_PREFIX\}\$\{accountId\}`/);
    assert.match(localLibrary, /index\("accountId"\)\.getAll\(String\(accountId\)\)/);
    assert.match(localLibrary, /index\("accountIdSectionId"\)\.getAll\(\[String\(accountId\), String\(sectionId\)\]\)/);
});

test("notifications, messages lus et alertes planning restent dans l’entreprise active", () => {
    assert.match(collaboration, /WHERE recipient_id=\$1 AND owner_id=\$2 AND event_type/);
    assert.match(collaboration, /SET read_at=NOW\(\) WHERE recipient_id=\$1 AND owner_id=\$2/);
    assert.match(collaboration, /DELETE FROM depannhome_collaboration_notifications WHERE recipient_id=\$1 AND owner_id=\$2/);
    assert.match(messages, /CLIENT_LAST_READ_KEY_PREFIX\}\$\{document\.body\.dataset\.accountId/);
    assert.match(navigation, /TECHNICIAN_CALENDAR_ALERT_KEY_PREFIX\}\$\{document\.body\.dataset\.accountId/);
});

test("les autres sections métier conservent un owner_id explicite", () => {
    for (const file of [
        "../server/accounting.js",
        "../server/billing.js",
        "../server/calendar.js",
        "../server/clients.js",
        "../server/connectors.js",
        "../server/data-imports.js",
        "../server/electronic-invoicing.js",
        "../server/library.js",
        "../server/purchases.js",
        "../server/technical-reports.js"
    ]) {
        const contents = source(file);
        assert.match(contents, /owner_id/);
        assert.match(contents, /getAccountOwnerId\(request\)|getAccountOwnerId\(req\)/);
    }
});