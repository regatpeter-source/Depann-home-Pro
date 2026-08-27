import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const creatorServer = readFileSync(new URL("../server/creator.js", import.meta.url), "utf8");
const creatorClient = readFileSync(new URL("../js/creator.js", import.meta.url), "utf8");
const electronicServer = readFileSync(new URL("../server/electronic-invoicing.js", import.meta.url), "utf8");
const schema = readFileSync(new URL("../database/schema.sql", import.meta.url), "utf8");
const appServer = readFileSync(new URL("../app.js", import.meta.url), "utf8");

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
    const routes = creatorServer.slice(creatorServer.indexOf('app.get("/api/creator/e-invoicing-platforms"'), creatorServer.indexOf('app.get("/api/creator/e-invoicing-monitoring"'));
    assert.doesNotMatch(routes, /fetch\(|testConnection|encrypted_credentials/);
});

test("le Créateur consulte la même intégration par entreprise sans recevoir les secrets", () => {
    const route = creatorServer.slice(creatorServer.indexOf('app.get("/api/creator/accounts/:accountId/e-invoicing"'), creatorServer.indexOf('app.post("/api/creator/accounts"'));
    assert.match(route, /requireCreator/);
    assert.match(route, /WHERE owner_id=\$1/);
    assert.match(route, /depannhome_einvoice_connections/);
    assert.match(route, /depannhome_einvoice_transmissions/);
    assert.doesNotMatch(route, /encrypted_credentials|refresh_metadata|webhook_token_hash/);
    assert.match(creatorClient, /Configurer et utiliser SUPER PDP/);
    assert.match(creatorClient, /data-open-own-super-pdp/);
    assert.match(creatorClient, /data-open-own-super-pdp[^\n]*addEventListener\("click", renderCreatorPlatformSuperPdp\)/);
    assert.doesNotMatch(creatorClient, /renderAccounting\("electronic"\)/);
});

test("SUPER PDP production est directement visible dans l’en-tête Créateur", () => {
    assert.match(creatorClient, /class="secondary-button auth-outline-button" id="creatorSuperPdpProduction">SUPER PDP<\/button>/);
    assert.match(creatorClient, /#creatorSuperPdpProduction"\)\.addEventListener\("click", renderCreatorPlatformSuperPdp\)/);
    assert.doesNotMatch(creatorClient, /import \{ renderAccounting \}/);
});

test("l’espace SUPER PDP Créateur possède un coffre et un OAuth distincts des entreprises", () => {
    for (const source of [electronicServer, schema]) {
        assert.match(source, /CREATE TABLE IF NOT EXISTS depannhome_creator_super_pdp_connection/);
        assert.match(source, /CREATE TABLE IF NOT EXISTS depannhome_creator_super_pdp_oauth_states/);
    }
    for (const route of [/app\.get\("\/api\/creator\/super-pdp-platform", requireCreator/, /app\.post\("\/api\/creator\/super-pdp-platform\/authorize", requireCreator/, /app\.post\("\/api\/creator\/super-pdp-platform\/test", requireCreator/, /app\.delete\("\/api\/creator\/super-pdp-platform", requireCreator/]) assert.match(creatorServer, route);
    const creatorPdpRoutes = creatorServer.slice(creatorServer.indexOf('app.get("/api/creator/super-pdp-platform"'), creatorServer.indexOf('app.post("/api/creator/e-invoicing-platforms"'));
    assert.doesNotMatch(creatorPdpRoutes, /depannhome_einvoice_connections/);
    assert.match(creatorServer, /const state = `creator\.\$\{crypto\.randomBytes/);
    assert.match(electronicServer, /const state = `company\.\$\{crypto\.randomBytes/);
    assert.match(electronicServer, /if \(!creatorFlow && !companyFlow\)/);
    assert.match(electronicServer, /if \(creatorFlow\)[\s\S]*pending\.created_by/);
    assert.match(creatorClient, /espace indépendant/);
    assert.match(creatorClient, /totalement séparé du compte administrateur/);
});

test("le callback SUPER PDP survit au retour sans cookie grâce à l’état serveur", () => {
    assert.match(appServer, /if \(isElectronicInvoicingOAuthCallback\(request\)\) return next\(\)/);
    assert.match(electronicServer, /if \(isOAuthCallback\(request\)\) return next\(\)/);
    const callback = electronicServer.slice(electronicServer.indexOf('app.get("/api/accounting/e-invoicing/oauth/callback"'), electronicServer.indexOf('app.put("/api/accounting/e-invoicing/configuration"'));
    assert.match(callback, /DELETE FROM depannhome_creator_super_pdp_oauth_states WHERE state_hash=\$1 AND expires_at>NOW\(\) RETURNING/);
    assert.match(callback, /DELETE FROM depannhome_einvoice_oauth_states WHERE state_hash=\$1 AND expires_at>NOW\(\) RETURNING/);
    assert.match(callback, /const ownerId = pending\.owner_id/);
    assert.match(callback, /const actorId = pending\.created_by/);
    assert.doesNotMatch(callback, /request\.user/);
});