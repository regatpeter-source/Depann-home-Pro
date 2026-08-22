import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const creatorServer = readFileSync(new URL("../server/creator.js", import.meta.url), "utf8");
const creatorClient = readFileSync(new URL("../js/creator.js", import.meta.url), "utf8");
const electronicServer = readFileSync(new URL("../server/electronic-invoicing.js", import.meta.url), "utf8");
const schema = readFileSync(new URL("../database/schema.sql", import.meta.url), "utf8");

test("la console Créateur gère un catalogue distinct des connexions d’entreprise", () => {
    assert.match(creatorClient, /id="creatorElectronicInvoicingPlatforms"/);
    assert.match(creatorClient, /Plateformes de facturation électronique/);
    assert.match(creatorClient, /Une fiche, une URL ou des identifiants ne génèrent jamais un connecteur/);
    assert.match(creatorServer, /app\.get\("\/api\/creator\/e-invoicing-platforms", requireCreator/);
    assert.match(creatorServer, /app\.post\("\/api\/creator\/e-invoicing-platforms", requireCreator/);
    assert.match(creatorServer, /app\.patch\("\/api\/creator\/e-invoicing-platforms\/:platformId", requireCreator/);
});

test("le catalogue persiste seulement des métadonnées d’intégration", () => {
    for (const source of [electronicServer, schema]) {
        assert.match(source, /CREATE TABLE IF NOT EXISTS depannhome_einvoice_platform_catalog/);
        assert.match(source, /documentation_url VARCHAR\(1000\)/);
        assert.match(source, /planned_capabilities JSONB/);
        assert.doesNotMatch(source.slice(source.indexOf("CREATE TABLE IF NOT EXISTS depannhome_einvoice_platform_catalog"), source.indexOf("CREATE TABLE IF NOT EXISTS depannhome_einvoice_connections")), /encrypted_credentials|client_secret|access_token/);
    }
});

test("une fiche ne peut pas déclarer un adaptateur absent comme déployé", () => {
    assert.match(creatorServer, /lifecycleStatus === "deployed" && !getElectronicInvoicingProvider\(platformCode\)/);
    assert.match(creatorServer, /aucun adaptateur serveur correspondant n’est enregistré/);
    const routes = creatorServer.slice(creatorServer.indexOf('app.get("/api/creator/e-invoicing-platforms"'), creatorServer.indexOf('app.get("/api/creator/network-directory"'));
    assert.doesNotMatch(routes, /fetch\(|testConnection|encrypted_credentials/);
});