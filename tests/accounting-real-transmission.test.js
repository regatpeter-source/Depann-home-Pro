import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
    ElectronicInvoicingProvider,
    decryptElectronicInvoicingCredentials,
    encryptElectronicInvoicingCredentials,
    getElectronicInvoicingProvider,
    listElectronicInvoicingProviders,
    registerElectronicInvoicingProvider
} from "../server/electronic-invoicing.js";

const accountingServer = readFileSync(new URL("../server/accounting.js", import.meta.url), "utf8");
const electronicServer = readFileSync(new URL("../server/electronic-invoicing.js", import.meta.url), "utf8");
const accountingClient = readFileSync(new URL("../js/accounting.js", import.meta.url), "utf8");
const navigationClient = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const schema = readFileSync(new URL("../database/schema.sql", import.meta.url), "utf8");
const serviceWorker = readFileSync(new URL("../service-worker.js", import.meta.url), "utf8");

test("la Sandbox comptable et son connecteur fictif sont retirés du produit", () => {
    assert.doesNotMatch(app, /accounting-sandbox|AccountingSandbox/);
    assert.doesNotMatch(serviceWorker, /accounting-sandbox/);
    assert.doesNotMatch(accountingClient.slice(0, accountingClient.indexOf("function renderLegacyElectronic")), /accounting-sandbox|Sandbox comptable/);
    assert.doesNotMatch(accountingServer.slice(0, accountingServer.indexOf("export async function initializeAccounting")), /remoteId: `sandbox-|Transmission de test/);
});

test("aucun protocole universel ni fournisseur non documenté n’est déclaré", () => {
    assert.deepEqual(listElectronicInvoicingProviders(), []);
    assert.equal(getElectronicInvoicingProvider("ubl_api"), null);
    assert.doesNotMatch(electronicServer, /Authorization.*Bearer|Idempotency-Key|fetch\(/);
    assert.match(accountingClient, /Cette plateforme n\\'est pas encore intégrée à Depan’Home Pro/);
    assert.doesNotMatch(accountingClient.slice(accountingClient.indexOf("function renderSettings"), accountingClient.indexOf("function renderPaymentRows")), /apiUrl|apiKey|Bearer|endpoint/);
});

test("le contrat d’adaptateur couvre connexion, envoi, statut et renouvellement", () => {
    class DocumentedProvider extends ElectronicInvoicingProvider {}
    const provider = new DocumentedProvider({ code: "documented_test", label: "Fournisseur documenté", authenticationType: "oauth2", environments: ["production"], supports: { invoices: true, creditNotes: true, status: true, refresh: true } });
    registerElectronicInvoicingProvider(provider);
    assert.equal(getElectronicInvoicingProvider("documented_test"), provider);
    for (const operation of ["connect", "disconnect", "testConnection", "sendInvoice", "sendCreditNote", "getTransmissionStatus", "refreshAuthentication", "getAccountInformation", "verifyWebhook"]) assert.equal(typeof provider[operation], "function");
    assert.equal(provider.publicDefinition().supports.creditNotes, true);
});

test("les credentials sont chiffrés et ne figurent pas dans la vue publique", () => {
    const credentials = { accessToken: "secret-token", clientSecret: "another-secret" };
    const encrypted = encryptElectronicInvoicingCredentials(credentials, "test-session-secret");
    assert.doesNotMatch(encrypted, /secret-token|another-secret/);
    assert.deepEqual(decryptElectronicInvoicingCredentials(encrypted, "test-session-secret"), credentials);
    assert.doesNotMatch(electronicServer.slice(electronicServer.indexOf("function publicConnection"), electronicServer.indexOf("function connectionContext")), /encrypted_credentials\s*:/);
});

test("les connexions et transmissions sont isolées par owner_id", () => {
    assert.match(electronicServer, /WHERE id=\$1 AND owner_id=\$2/);
    assert.match(electronicServer, /WHERE owner_id=\$1 AND active=TRUE AND status='connected'/);
    assert.match(electronicServer, /document_id=\$2/);
    assert.doesNotMatch(electronicServer, /request\.body\?\.ownerId|request\.body\.owner_id/);
    assert.match(accountingServer, /document\.owner_id=transmission\.owner_id/);
});

test("la migration préserve l’ancienne configuration sans l’activer", () => {
    for (const source of [electronicServer, schema]) {
        assert.match(source, /legacy_ubl_api/);
        assert.match(source, /action_required/);
        assert.match(source, /settings\.pdp_api_secret/);
        assert.match(source, /NOT EXISTS/);
    }
    assert.match(schema, /connection_id BIGINT REFERENCES depannhome_einvoice_connections\(id\) ON DELETE SET NULL/);
});

test("les webhooks résolvent le tenant depuis un jeton opaque et une référence externe", () => {
    assert.match(electronicServer, /webhook_token_hash=\$2 AND active=TRUE/);
    assert.match(electronicServer, /connection\.owner_id, platform\.code/);
    assert.doesNotMatch(electronicServer, /webhooks[^\n]*ownerId/);
});

test("la comptabilité et le FEC restent indépendants des connexions", () => {
    assert.doesNotMatch(accountingServer.slice(accountingServer.indexOf('app.post("\/api\/accounting\/export\/control'), accountingServer.indexOf('app.get("\/api\/accounting\/export"')), /einvoice_connections|activeConnection|platform_code/);
    assert.match(app, /initializeAccounting\(\);[\s\S]*initializeElectronicInvoicing\(\)/);
});

test("Paramètres expose la configuration manuelle propre à l’entreprise", () => {
    assert.match(navigationClient, /\["electronicInvoicing", "Facturation électronique"/);
    assert.match(navigationClient, /section === "electronicInvoicing"\) return renderElectronicInvoicingConfiguration\(container\)/);
    assert.match(accountingClient, /export async function renderElectronicInvoicingConfiguration/);
    assert.match(accountingClient, /Choisir une plateforme/);
    assert.match(accountingClient, /Enregistrer les identifiants/);
    assert.match(accountingClient, /Plateforme non intégrée/);
    assert.match(accountingClient, /aucun échange automatique/);
    assert.match(accountingClient, /data-edit-configuration/);
    assert.match(accountingClient, /data-disconnect-configuration/);
});

test("le bouton d’enregistrement de la plateforme est un submit explicite et protégé", () => {
    const configuration = accountingClient.slice(accountingClient.indexOf("export async function renderElectronicInvoicingConfiguration"), accountingClient.indexOf("function renderLegacyElectronic"));
    assert.match(configuration, /<button type="submit" class="secondary-button">Enregistrer les identifiants<\/button>/);
    assert.match(configuration, /if \(submit\) submit\.disabled = true/);
    assert.match(configuration, /if \(submit\) submit\.disabled = false/);
});

test("la configuration manuelle chiffre les secrets sans test de connexion", () => {
    const route = electronicServer.slice(electronicServer.indexOf('app.put("/api/accounting/e-invoicing/configuration"'), electronicServer.indexOf('app.post("/api/accounting/e-invoicing/connections/:platformCode"'));
    assert.match(route, /const ownerId = getAccountOwnerId\(request\)/);
    assert.match(route, /WHERE owner_id=\$1 AND active=TRUE/);
    assert.match(route, /encryptCredentials\(configuration.credentials\)/);
    assert.match(route, /'manual_configuration'/);
    assert.doesNotMatch(route, /testConnection|fetch\(|request\.body.*ownerId/);
    assert.doesNotMatch(accountingClient.slice(accountingClient.indexOf("export async function renderElectronicInvoicingConfiguration"), accountingClient.indexOf("function renderLegacyElectronic")), /\/test|Tester la connexion/);
});

test("la restauration ne lie jamais la plateforme à la numérotation", () => {
    assert.doesNotMatch(electronicServer, /billing_sequences|allocateBillingNumber|document_number\s*=/);
    assert.doesNotMatch(navigationClient, /billing_sequences|allocateBillingNumber/);
});