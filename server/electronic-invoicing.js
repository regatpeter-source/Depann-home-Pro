import crypto from "node:crypto";
import { getPool } from "./database.js";
import { getAccountOwnerId } from "./auth.js";

const CONNECTION_STATUSES = new Set(["pending", "connected", "invalid", "expired", "disconnected", "action_required"]);
const TRANSMISSION_STATUSES = new Set(["queued", "sent", "accepted", "rejected", "failed", "cancelled"]);
const ENVIRONMENTS = new Set(["sandbox", "production"]);
const MANUAL_AUTHENTICATION_TYPES = new Set(["api_key", "oauth_client", "access_token", "identifier_secret", "custom_secret"]);
const providers = new Map();

export class ElectronicInvoicingProvider {
    constructor({ code, label, authenticationType, environments = ["production"], supports = {} }) {
        if (!/^[a-z0-9][a-z0-9_-]{1,59}$/.test(String(code || ""))) throw new TypeError("Code plateforme invalide.");
        this.code = code;
        this.label = String(label || code);
        this.authenticationType = String(authenticationType || "provider_specific");
        this.environments = environments.filter(item => ENVIRONMENTS.has(item));
        this.supports = { invoices: Boolean(supports.invoices), creditNotes: Boolean(supports.creditNotes), status: Boolean(supports.status), refresh: Boolean(supports.refresh), webhooks: Boolean(supports.webhooks) };
    }

    publicDefinition() {
        return { code: this.code, label: this.label, authenticationType: this.authenticationType, environments: this.environments, supports: this.supports, integrated: true };
    }

    async connect() { throw new Error("Connexion non implémentée par cet adaptateur."); }
    async disconnect() {}
    async testConnection() { throw new Error("Test de connexion non implémenté par cet adaptateur."); }
    async sendInvoice() { throw new Error("Envoi de facture non implémenté par cet adaptateur."); }
    async sendCreditNote() { throw new Error("Envoi d’avoir non implémenté par cet adaptateur."); }
    async getTransmissionStatus() { throw new Error("Lecture du statut non implémentée par cet adaptateur."); }
    async refreshAuthentication() { throw new Error("Renouvellement non implémenté par cet adaptateur."); }
    async getAccountInformation() { return {}; }
    async verifyWebhook() { throw new Error("Webhook non implémenté par cet adaptateur."); }
}

export function registerElectronicInvoicingProvider(provider) {
    if (!(provider instanceof ElectronicInvoicingProvider)) throw new TypeError("L’adaptateur doit étendre ElectronicInvoicingProvider.");
    if (providers.has(provider.code)) throw new Error(`La plateforme ${provider.code} est déjà enregistrée.`);
    providers.set(provider.code, provider);
    return provider;
}

export function listElectronicInvoicingProviders() {
    return [...providers.values()].map(provider => provider.publicDefinition());
}

export function getElectronicInvoicingProvider(code) {
    return providers.get(String(code || "")) || null;
}

export async function initializeElectronicInvoicing(database = getPool()) {
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_einvoice_platform_catalog (
            id BIGSERIAL PRIMARY KEY,
            platform_code VARCHAR(60) NOT NULL UNIQUE,
            platform_label VARCHAR(160) NOT NULL,
            documentation_url VARCHAR(1000) NOT NULL DEFAULT '',
            authentication_type VARCHAR(40) NOT NULL DEFAULT 'provider_specific',
            lifecycle_status VARCHAR(40) NOT NULL DEFAULT 'documentation_required' CHECK (lifecycle_status IN ('documentation_required','specification_review','development','validation','deployed','suspended')),
            planned_capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
            notes VARCHAR(4000) NOT NULL DEFAULT '',
            created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
            updated_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_einvoice_platform_catalog_status_idx ON depannhome_einvoice_platform_catalog(lifecycle_status,platform_label)");
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_einvoice_connections (
            id BIGSERIAL PRIMARY KEY,
            owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            platform_code VARCHAR(60) NOT NULL,
            platform_label VARCHAR(160) NOT NULL,
            environment VARCHAR(20) NOT NULL DEFAULT 'production' CHECK (environment IN ('sandbox','production')),
            status VARCHAR(30) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','connected','invalid','expired','disconnected','action_required')),
            active BOOLEAN NOT NULL DEFAULT FALSE,
            encrypted_credentials TEXT NOT NULL DEFAULT '',
            connection_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            external_account_id VARCHAR(200) NOT NULL DEFAULT '',
            external_account_label VARCHAR(200) NOT NULL DEFAULT '',
            token_expires_at TIMESTAMPTZ,
            refresh_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            webhook_token_hash CHAR(64),
            last_connected_at TIMESTAMPTZ,
            last_checked_at TIMESTAMPTZ,
            disconnected_at TIMESTAMPTZ,
            created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_einvoice_connections_owner_idx ON depannhome_einvoice_connections(owner_id,updated_at DESC)");
    await database.query("CREATE UNIQUE INDEX IF NOT EXISTS depannhome_einvoice_connections_owner_active_unique ON depannhome_einvoice_connections(owner_id) WHERE active=TRUE");
    await database.query("CREATE UNIQUE INDEX IF NOT EXISTS depannhome_einvoice_connections_webhook_unique ON depannhome_einvoice_connections(webhook_token_hash) WHERE webhook_token_hash IS NOT NULL");
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_einvoice_oauth_states (
            id BIGSERIAL PRIMARY KEY,
            owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            created_by BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            platform_code VARCHAR(60) NOT NULL,
            state_hash CHAR(64) NOT NULL UNIQUE,
            encrypted_context TEXT NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_einvoice_oauth_states_owner_idx ON depannhome_einvoice_oauth_states(owner_id,platform_code,expires_at)");
    await database.query("DELETE FROM depannhome_einvoice_oauth_states WHERE expires_at<=NOW()");
    await database.query(`
        ALTER TABLE depannhome_einvoice_transmissions
        ADD COLUMN IF NOT EXISTS connection_id BIGINT REFERENCES depannhome_einvoice_connections(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS platform_code VARCHAR(60) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS document_type VARCHAR(20) NOT NULL DEFAULT 'invoice',
        ADD COLUMN IF NOT EXISTS external_status VARCHAR(80) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS transmitted_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS status_checked_at TIMESTAMPTZ
    `);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_einvoice_transmissions_owner_document_idx ON depannhome_einvoice_transmissions(owner_id,document_id,updated_at DESC)");
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_einvoice_transmissions_external_idx ON depannhome_einvoice_transmissions(platform_code,remote_id) WHERE remote_id<>''");
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_einvoice_events (
            id BIGSERIAL PRIMARY KEY,
            owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            connection_id BIGINT REFERENCES depannhome_einvoice_connections(id) ON DELETE SET NULL,
            transmission_id BIGINT REFERENCES depannhome_einvoice_transmissions(id) ON DELETE SET NULL,
            actor_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
            event_type VARCHAR(60) NOT NULL,
            status VARCHAR(30) NOT NULL DEFAULT '',
            message VARCHAR(1000) NOT NULL DEFAULT '',
            details JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_einvoice_events_owner_idx ON depannhome_einvoice_events(owner_id,created_at DESC)");
    await migrateLegacyConnection(database);
}

async function migrateLegacyConnection(database) {
    await database.query(`
        INSERT INTO depannhome_einvoice_connections
            (owner_id,platform_code,platform_label,environment,status,active,encrypted_credentials,connection_metadata,external_account_id,created_at,updated_at)
        SELECT settings.owner_id,'legacy_ubl_api',COALESCE(NULLIF(settings.pdp_platform_name,''),'Ancienne configuration UBL'),'production',
            'action_required',FALSE,settings.pdp_api_secret,
            jsonb_build_object('legacyApiUrl',settings.pdp_api_url,'migration','depannhome_accounting_settings'),settings.pdp_identifier,NOW(),NOW()
        FROM depannhome_accounting_settings settings
        WHERE (settings.pdp_platform_name<>'' OR settings.pdp_api_url<>'' OR settings.pdp_identifier<>'' OR settings.pdp_api_secret<>'')
          AND NOT EXISTS (SELECT 1 FROM depannhome_einvoice_connections connection WHERE connection.owner_id=settings.owner_id AND connection.platform_code='legacy_ubl_api')
    `);
    await database.query(`
        UPDATE depannhome_accounting_settings settings SET pdp_provider='',pdp_platform_name='',pdp_api_url='',pdp_identifier='',pdp_api_secret='',pdp_enabled=FALSE
        WHERE EXISTS (SELECT 1 FROM depannhome_einvoice_connections connection WHERE connection.owner_id=settings.owner_id AND connection.platform_code='legacy_ubl_api')
    `);
}

export function registerElectronicInvoicingRoutes(app, requireAuthentication) {
    app.post("/api/e-invoicing/webhooks/:platformCode/:token", asyncHandler(async (request, response) => {
        const platform = getElectronicInvoicingProvider(request.params.platformCode);
        if (!platform?.supports.webhooks) return response.status(404).json({ message: "Webhook indisponible." });
        const tokenHash = sha256(request.params.token);
        const { rows } = await getPool().query("SELECT * FROM depannhome_einvoice_connections WHERE platform_code=$1 AND webhook_token_hash=$2 AND active=TRUE", [platform.code, tokenHash]);
        const connection = rows[0];
        if (!connection) return response.status(404).json({ message: "Connexion introuvable." });
        const credentials = decryptCredentials(connection.encrypted_credentials);
        const event = await platform.verifyWebhook({ headers: request.headers, body: request.body, credentials, connection: connectionContext(connection) });
        if (!event?.externalId || !TRANSMISSION_STATUSES.has(event.status)) return response.status(400).json({ message: "Notification invalide." });
        const updated = await getPool().query(`UPDATE depannhome_einvoice_transmissions SET status=$4,external_status=$5,message=$6,status_checked_at=NOW(),updated_at=NOW() WHERE owner_id=$1 AND platform_code=$2 AND remote_id=$3 RETURNING id`, [connection.owner_id, platform.code, clean(event.externalId, 160), event.status, clean(event.externalStatus, 80), clean(event.message, 1000)]);
        if (!updated.rows[0]) return response.status(404).json({ message: "Transmission introuvable." });
        await recordEvent(getPool(), connection.owner_id, connection.id, updated.rows[0].id, null, "status_received", event.status, event.message);
        response.status(204).end();
    }));

    app.use("/api/accounting/e-invoicing", requireAuthentication, requireCompanyAdministrator);
    app.get("/api/accounting/e-invoicing", asyncHandler(async (request, response) => {
        const ownerId = getAccountOwnerId(request);
        response.json({ providers: listElectronicInvoicingProviders(), connections: await loadPublicConnections(ownerId), activeConnection: await loadPublicActiveConnection(ownerId) });
    }));
    app.post("/api/accounting/e-invoicing/connections/:platformCode/authorize", asyncHandler(async (request, response) => {
        const ownerId = getAccountOwnerId(request);
        const platform = getElectronicInvoicingProvider(request.params.platformCode);
        if (!platform || typeof platform.authorizationUrl !== "function" || typeof platform.exchangeAuthorizationCode !== "function") return response.status(409).json({ message: "Cette plateforme ne propose pas de parcours d’autorisation intégré." });
        const redirectUri = String(process.env.SUPERPDP_REDIRECT_URI || "").trim();
        const state = crypto.randomBytes(32).toString("base64url");
        const codeVerifier = crypto.randomBytes(64).toString("base64url");
        const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
        const { rows } = await getPool().query(`SELECT profile.email,REGEXP_REPLACE(COALESCE(profile.siren,''),'[^0-9]','','g') AS siren FROM depannhome_users owner LEFT JOIN depannhome_billing_profiles profile ON profile.owner_id=owner.id WHERE owner.id=$1`, [ownerId]);
        const profile = rows[0] || {};
        let authorizationUrl;
        try {
            authorizationUrl = platform.authorizationUrl({ state, codeChallenge, redirectUri, loginHint: clean(profile.email, 160), companyNumber: clean(profile.siren, 9) });
        } catch (error) {
            if (Number(error?.status) === 503) return response.status(503).json({ message: safeError(error) });
            throw error;
        }
        await getPool().query("DELETE FROM depannhome_einvoice_oauth_states WHERE expires_at<=NOW() OR (owner_id=$1 AND created_by=$2 AND platform_code=$3)", [ownerId, request.user.sub, platform.code]);
        await getPool().query("INSERT INTO depannhome_einvoice_oauth_states(owner_id,created_by,platform_code,state_hash,encrypted_context,expires_at) VALUES($1,$2,$3,$4,$5,NOW()+INTERVAL '10 minutes')", [ownerId, request.user.sub, platform.code, sha256(state), encryptCredentials({ codeVerifier, redirectUri })]);
        response.json({ authorizationUrl });
    }));
    app.get("/api/accounting/e-invoicing/oauth/callback", asyncHandler(async (request, response) => {
        const ownerId = getAccountOwnerId(request);
        const state = secret(request.query?.state, 500);
        const { rows } = await getPool().query("DELETE FROM depannhome_einvoice_oauth_states WHERE state_hash=$1 AND owner_id=$2 AND created_by=$3 AND expires_at>NOW() RETURNING *", [sha256(state), ownerId, request.user.sub]);
        const pending = state && rows[0];
        if (!pending) return response.status(400).send(oauthCallbackPage(false, "Autorisation expirée ou déjà utilisée."));
        if (request.query?.error) return response.status(400).send(oauthCallbackPage(false, clean(request.query.error_description || request.query.error, 400)));
        const platform = getElectronicInvoicingProvider(pending.platform_code);
        const code = secret(request.query?.code, 4000);
        if (!platform || typeof platform.exchangeAuthorizationCode !== "function" || !code) return response.status(400).send(oauthCallbackPage(false, "Réponse d’autorisation incomplète."));
        try {
            const context = decryptCredentials(pending.encrypted_context);
            const result = await platform.exchangeAuthorizationCode({ code, codeVerifier: context.codeVerifier, redirectUri: context.redirectUri });
            if (!result?.credentials || typeof result.credentials !== "object") throw new Error("Jetons OAuth absents.");
            const status = CONNECTION_STATUSES.has(result.status) ? result.status : "connected";
            const client = await getPool().connect();
            try {
                await client.query("BEGIN");
                await client.query("UPDATE depannhome_einvoice_connections SET active=FALSE,status=CASE WHEN status='connected' THEN 'disconnected' ELSE status END,disconnected_at=CASE WHEN active THEN NOW() ELSE disconnected_at END,updated_at=NOW() WHERE owner_id=$1 AND active=TRUE", [ownerId]);
                const { rows: saved } = await client.query(`INSERT INTO depannhome_einvoice_connections(owner_id,platform_code,platform_label,environment,status,active,encrypted_credentials,connection_metadata,external_account_id,external_account_label,token_expires_at,refresh_metadata,last_connected_at,last_checked_at,created_by) VALUES($1,$2,$3,$4,$5,TRUE,$6,$7::jsonb,$8,$9,$10,$11::jsonb,NOW(),NOW(),$12) RETURNING *`, [ownerId, platform.code, platform.label, safeObject(result.metadata).companyEnvironment === "production" ? "production" : "sandbox", status, encryptCredentials(result.credentials), JSON.stringify(safeObject(result.metadata)), clean(result.externalAccountId, 200), clean(result.externalAccountLabel, 200), result.tokenExpiresAt || null, JSON.stringify(safeObject(result.refreshMetadata)), request.user.sub]);
                await recordEvent(client, ownerId, saved[0].id, null, request.user.sub, "oauth_authorized", status, result.message || "Autorisation SUPER PDP enregistrée.");
                await client.query("COMMIT");
            } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
            response.send(oauthCallbackPage(true, result.message || "SUPER PDP est connecté."));
        } catch (error) {
            response.status(502).send(oauthCallbackPage(false, safeError(error)));
        }
    }));
    app.put("/api/accounting/e-invoicing/configuration", asyncHandler(async (request, response) => {
        const ownerId = getAccountOwnerId(request);
        const configuration = sanitizeManualConfiguration(request.body);
        if (!configuration.ok) return response.status(400).json({ message: configuration.message });
        const { rows: currentRows } = await getPool().query("SELECT * FROM depannhome_einvoice_connections WHERE owner_id=$1 AND active=TRUE ORDER BY updated_at DESC LIMIT 1", [ownerId]);
        const current = currentRows[0];
        const credentials = configuration.credentialsComplete
            ? encryptCredentials(configuration.credentials)
            : current?.platform_code === "manual_configuration" && current.encrypted_credentials && safeObject(current.connection_metadata).authenticationType === configuration.authenticationType
                ? current.encrypted_credentials
                : "";
        if (!credentials) return response.status(400).json({ message: "Renseignez les informations sensibles requises par le mode d’authentification sélectionné." });
        const metadata = { authenticationType: configuration.authenticationType };
        const client = await getPool().connect();
        try {
            await client.query("BEGIN");
            let saved;
            if (current?.platform_code === "manual_configuration") {
                const { rows } = await client.query(`UPDATE depannhome_einvoice_connections SET platform_label=$3,status='pending',active=TRUE,encrypted_credentials=$4,connection_metadata=$5::jsonb,external_account_id=$6,external_account_label=$6,disconnected_at=NULL,updated_at=NOW() WHERE id=$1 AND owner_id=$2 RETURNING *`, [current.id, ownerId, configuration.platformName, credentials, JSON.stringify(metadata), configuration.accountIdentifier]);
                saved = rows[0];
            } else {
                await client.query("UPDATE depannhome_einvoice_connections SET active=FALSE,status=CASE WHEN status='connected' THEN 'disconnected' ELSE status END,disconnected_at=CASE WHEN active THEN NOW() ELSE disconnected_at END,updated_at=NOW() WHERE owner_id=$1 AND active=TRUE", [ownerId]);
                const { rows } = await client.query(`INSERT INTO depannhome_einvoice_connections(owner_id,platform_code,platform_label,environment,status,active,encrypted_credentials,connection_metadata,external_account_id,external_account_label,created_by) VALUES($1,'manual_configuration',$2,'production','pending',TRUE,$3,$4::jsonb,$5,$5,$6) RETURNING *`, [ownerId, configuration.platformName, credentials, JSON.stringify(metadata), configuration.accountIdentifier, request.user.sub]);
                saved = rows[0];
            }
            await recordEvent(client, ownerId, saved.id, null, request.user.sub, "configuration_saved", "pending", "Configuration de plateforme enregistrée.");
            await client.query("COMMIT");
            response.json({ message: "Configuration enregistrée.", connection: publicConnection(saved) });
        } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }));
    app.post("/api/accounting/e-invoicing/connections/:platformCode", asyncHandler(async (request, response) => {
        const ownerId = getAccountOwnerId(request);
        const platform = getElectronicInvoicingProvider(request.params.platformCode);
        if (!platform) return response.status(409).json({ message: "Cette plateforme n'est pas encore intégrée à Depan’Home Pro." });
        const environment = ENVIRONMENTS.has(request.body?.environment) && platform.environments.includes(request.body.environment) ? request.body.environment : platform.environments[0];
        const result = await platform.connect({ input: request.body || {}, environment, ownerId });
        if (!result?.credentials || typeof result.credentials !== "object") return response.status(502).json({ message: "La plateforme n’a pas fourni une connexion exploitable." });
        const client = await getPool().connect();
        try {
            await client.query("BEGIN");
            await client.query("UPDATE depannhome_einvoice_connections SET active=FALSE,status=CASE WHEN status='connected' THEN 'disconnected' ELSE status END,disconnected_at=CASE WHEN active THEN NOW() ELSE disconnected_at END,updated_at=NOW() WHERE owner_id=$1 AND active=TRUE", [ownerId]);
            const webhookToken = crypto.randomBytes(32).toString("base64url");
            const { rows } = await client.query(`INSERT INTO depannhome_einvoice_connections(owner_id,platform_code,platform_label,environment,status,active,encrypted_credentials,connection_metadata,external_account_id,external_account_label,token_expires_at,refresh_metadata,webhook_token_hash,last_connected_at,last_checked_at,created_by) VALUES($1,$2,$3,$4,'connected',TRUE,$5,$6::jsonb,$7,$8,$9,$10::jsonb,$11,NOW(),NOW(),$12) RETURNING *`, [ownerId, platform.code, platform.label, environment, encryptCredentials(result.credentials), JSON.stringify(safeObject(result.metadata)), clean(result.externalAccountId, 200), clean(result.externalAccountLabel, 200), result.tokenExpiresAt || null, JSON.stringify(safeObject(result.refreshMetadata)), sha256(webhookToken), request.user.sub]);
            await recordEvent(client, ownerId, rows[0].id, null, request.user.sub, "connection_created", "connected", "Plateforme connectée.");
            await client.query("COMMIT");
            response.status(201).json({ connection: publicConnection(rows[0]), webhookPath: platform.supports.webhooks ? `/api/e-invoicing/webhooks/${platform.code}/${webhookToken}` : "" });
        } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }));
    app.post("/api/accounting/e-invoicing/connections/:connectionId/test", asyncHandler(async (request, response) => {
        const ownerId = getAccountOwnerId(request); const connection = await requireOwnerConnection(ownerId, request.params.connectionId);
        const platform = getElectronicInvoicingProvider(connection.platform_code);
        if (!platform) return response.status(409).json({ message: "Cette plateforme n'est pas encore intégrée à Depan’Home Pro. Reconnectez-la lorsqu’un adaptateur officiel sera disponible." });
        try {
            const credentials = await usableCredentials(ownerId, connection, platform);
            const result = await platform.testConnection({ credentials, connection: connectionContext(connection) });
            const status = CONNECTION_STATUSES.has(result?.status) ? result.status : "connected";
            const message = clean(result?.message, 1000) || (status === "connected" ? "Connexion réussie." : "Une action est requise sur la plateforme.");
            const environment = ["sandbox", "production"].includes(result?.metadata?.companyEnvironment) ? result.metadata.companyEnvironment : connection.environment;
            await getPool().query("UPDATE depannhome_einvoice_connections SET status=$3,last_checked_at=NOW(),last_connected_at=COALESCE(last_connected_at,NOW()),external_account_id=COALESCE(NULLIF($4,''),external_account_id),external_account_label=COALESCE(NULLIF($5,''),external_account_label),connection_metadata=connection_metadata || $6::jsonb,environment=$7,updated_at=NOW() WHERE id=$1 AND owner_id=$2", [connection.id, ownerId, status, clean(result?.externalAccountId, 200), clean(result?.externalAccountLabel, 200), JSON.stringify(safeObject(result?.metadata)), environment]);
            await recordEvent(getPool(), ownerId, connection.id, null, request.user.sub, "connection_tested", status, message);
            response.json({ message, status });
        } catch (error) {
            await getPool().query("UPDATE depannhome_einvoice_connections SET status='invalid',last_checked_at=NOW(),updated_at=NOW() WHERE id=$1 AND owner_id=$2", [connection.id, ownerId]);
            await recordEvent(getPool(), ownerId, connection.id, null, request.user.sub, "connection_test_failed", "invalid", safeError(error));
            response.status(502).json({ message: `Connexion impossible : ${safeError(error)}` });
        }
    }));
    app.post("/api/accounting/e-invoicing/connections/:connectionId/refresh", asyncHandler(async (request, response) => {
        const ownerId = getAccountOwnerId(request); const connection = await requireOwnerConnection(ownerId, request.params.connectionId);
        const platform = getElectronicInvoicingProvider(connection.platform_code);
        if (!platform?.supports.refresh) return response.status(409).json({ message: "Le renouvellement automatique n’est pas disponible pour cette plateforme." });
        await rotateCredentials(ownerId, connection.id, platform, true);
        await recordEvent(getPool(), ownerId, connection.id, null, request.user.sub, "authentication_refreshed", "connected", "Authentification renouvelée.");
        response.json({ message: "Authentification renouvelée." });
    }));
    app.delete("/api/accounting/e-invoicing/connections/:connectionId", asyncHandler(async (request, response) => {
        const ownerId = getAccountOwnerId(request); const connection = await requireOwnerConnection(ownerId, request.params.connectionId);
        const platform = getElectronicInvoicingProvider(connection.platform_code);
        if (platform) await platform.disconnect({ credentials: decryptCredentials(connection.encrypted_credentials), connection: connectionContext(connection) }).catch(() => {});
        await getPool().query("UPDATE depannhome_einvoice_connections SET active=FALSE,status='disconnected',encrypted_credentials='',refresh_metadata='{}'::jsonb,webhook_token_hash=NULL,disconnected_at=NOW(),updated_at=NOW() WHERE id=$1 AND owner_id=$2", [connection.id, ownerId]);
        await recordEvent(getPool(), ownerId, connection.id, null, request.user.sub, "connection_disconnected", "disconnected", "Plateforme déconnectée.");
        response.status(204).end();
    }));
    app.post("/api/accounting/e-invoicing/documents/:documentId/transmit", asyncHandler(async (request, response) => {
        const result = await transmitElectronicDocument({ ownerId: getAccountOwnerId(request), documentId: request.params.documentId, actorId: request.user.sub });
        response.status(201).json(result);
    }));
    app.get("/api/accounting/e-invoicing/documents/:documentId/history", asyncHandler(async (request, response) => {
        const ownerId = getAccountOwnerId(request); const documentId = positiveId(request.params.documentId);
        if (!documentId) return response.status(400).json({ message: "Document invalide." });
        const exists = await getPool().query("SELECT 1 FROM depannhome_billing_documents WHERE id=$1 AND owner_id=$2", [documentId, ownerId]);
        if (!exists.rowCount) return response.status(404).json({ message: "Document introuvable." });
        response.json({ transmissions: await loadDocumentHistory(ownerId, documentId) });
    }));
    app.post("/api/accounting/e-invoicing/transmissions/:transmissionId/status", asyncHandler(async (request, response) => {
        const ownerId = getAccountOwnerId(request); const transmission = await requireOwnerTransmission(ownerId, request.params.transmissionId);
        const connection = transmission.connection_id ? await requireOwnerConnection(ownerId, transmission.connection_id) : null;
        const platform = connection && getElectronicInvoicingProvider(connection.platform_code);
        if (!platform?.supports.status || !transmission.remote_id) return response.status(409).json({ message: "Le suivi distant n’est pas disponible pour cette transmission." });
        const credentials = await usableCredentials(ownerId, connection, platform);
        const result = await platform.getTransmissionStatus({ externalId: transmission.remote_id, credentials, connection: connectionContext(connection) });
        const status = TRANSMISSION_STATUSES.has(result?.status) ? result.status : transmission.status;
        await getPool().query("UPDATE depannhome_einvoice_transmissions SET status=$3,external_status=$4,message=$5,status_checked_at=NOW(),updated_at=NOW() WHERE id=$1 AND owner_id=$2", [transmission.id, ownerId, status, clean(result?.externalStatus, 80), clean(result?.message, 1000)]);
        await recordEvent(getPool(), ownerId, connection.id, transmission.id, request.user.sub, "status_checked", status, result?.message);
        response.json({ status, message: clean(result?.message, 1000) });
    }));
}

export async function transmitElectronicDocument({ ownerId, documentId, actorId, database = getPool() }) {
    const id = positiveId(documentId);
    if (!id) throw httpError(400, "Document invalide.");
    const { rows } = await database.query(`SELECT id,owner_id AS "ownerId",document_type AS "documentType",document_number AS "documentNumber",customer_name AS "customerName",structured_data AS "structuredData",structured_mime_type AS "structuredMimeType",structured_sha256 AS "structuredSha256" FROM depannhome_billing_documents WHERE id=$1 AND owner_id=$2 AND issued_at IS NOT NULL`, [id, ownerId]);
    const document = rows[0];
    if (!document || !["invoice", "credit"].includes(document.documentType)) throw httpError(404, "Facture ou avoir introuvable.");
    if (!document.structuredData) throw httpError(409, "L’archive UBL de cette facture ou de cet avoir est indisponible. La transmission est bloquée.");
    const { rows: connections } = await database.query("SELECT * FROM depannhome_einvoice_connections WHERE owner_id=$1 AND active=TRUE AND status='connected' ORDER BY updated_at DESC LIMIT 1", [ownerId]);
    const connection = connections[0];
    if (!connection) throw httpError(409, "Connectez d’abord la plateforme de facturation électronique de votre entreprise.");
    const platform = getElectronicInvoicingProvider(connection.platform_code);
    if (!platform) throw httpError(409, "Cette plateforme n'est pas encore intégrée à Depan’Home Pro.");
    if (document.documentType === "invoice" && !platform.supports.invoices) throw httpError(409, "Cette plateforme ne permet pas l’envoi de factures avec l’intégration actuelle.");
    if (document.documentType === "credit" && !platform.supports.creditNotes) throw httpError(409, "Cette plateforme ne permet pas l’envoi d’avoirs avec l’intégration actuelle.");
    const { rows: created } = await database.query(`INSERT INTO depannhome_einvoice_transmissions(owner_id,document_id,connection_id,provider,platform_code,document_type,status,attempts,last_attempt_at) VALUES($1,$2,$3,$4,$5,$6,'queued',1,NOW()) RETURNING *`, [ownerId, document.id, connection.id, connection.platform_label, platform.code, document.documentType]);
    const transmission = created[0];
    await recordEvent(database, ownerId, connection.id, transmission.id, actorId, "transmission_queued", "queued", "Transmission préparée.");
    try {
        const credentials = await usableCredentials(ownerId, connection, platform);
        const sender = document.documentType === "credit" ? platform.sendCreditNote.bind(platform) : platform.sendInvoice.bind(platform);
        const result = await sender({ document, credentials, connection: connectionContext(connection) });
        const status = TRANSMISSION_STATUSES.has(result?.status) ? result.status : "sent";
        await database.query("UPDATE depannhome_einvoice_transmissions SET remote_id=$3,status=$4,external_status=$5,message=$6,transmitted_at=NOW(),updated_at=NOW() WHERE id=$1 AND owner_id=$2", [transmission.id, ownerId, clean(result?.externalId, 160), status, clean(result?.externalStatus, 80), clean(result?.message, 1000)]);
        await recordEvent(database, ownerId, connection.id, transmission.id, actorId, "document_transmitted", status, result?.message);
        return { message: clean(result?.message, 1000) || "Document transmis.", transmission: { id: transmission.id, status, externalId: clean(result?.externalId, 160) } };
    } catch (error) {
        const message = safeError(error);
        await database.query("UPDATE depannhome_einvoice_transmissions SET status='failed',message=$3,updated_at=NOW() WHERE id=$1 AND owner_id=$2", [transmission.id, ownerId, message]);
        await recordEvent(database, ownerId, connection.id, transmission.id, actorId, "transmission_failed", "failed", message);
        throw httpError(502, `Transmission impossible : ${message}`);
    }
}

async function loadPublicConnections(ownerId) {
    const { rows } = await getPool().query("SELECT * FROM depannhome_einvoice_connections WHERE owner_id=$1 ORDER BY active DESC,updated_at DESC", [ownerId]);
    return rows.map(publicConnection);
}
async function loadPublicActiveConnection(ownerId) { const connections = await loadPublicConnections(ownerId); return connections.find(item => item.active) || null; }
async function loadDocumentHistory(ownerId, documentId) {
    const { rows } = await getPool().query(`SELECT id,document_id AS "documentId",provider,platform_code AS "platformCode",document_type AS "documentType",remote_id AS "externalId",status,external_status AS "externalStatus",message,attempts,last_attempt_at AS "lastAttemptAt",transmitted_at AS "transmittedAt",status_checked_at AS "statusCheckedAt",created_at AS "createdAt",updated_at AS "updatedAt" FROM depannhome_einvoice_transmissions WHERE owner_id=$1 AND document_id=$2 ORDER BY created_at DESC`, [ownerId, documentId]);
    return rows;
}
function publicConnection(row) {
    return { id: row.id, platformCode: row.platform_code, platformLabel: row.platform_label, environment: row.environment, status: row.status, active: row.active, authenticationType: clean(safeObject(row.connection_metadata).authenticationType, 40), externalAccountId: row.external_account_id, externalAccountLabel: row.external_account_label, tokenExpiresAt: row.token_expires_at, lastConnectedAt: row.last_connected_at, lastCheckedAt: row.last_checked_at, disconnectedAt: row.disconnected_at, createdAt: row.created_at, updatedAt: row.updated_at, integrated: providers.has(row.platform_code), hasCredentials: Boolean(row.encrypted_credentials) };
}
function connectionContext(row) { return { id: row.id, ownerId: row.owner_id, platformCode: row.platform_code, environment: row.environment, metadata: safeObject(row.connection_metadata), externalAccountId: row.external_account_id }; }
async function requireOwnerConnection(ownerId, value) { const id = positiveId(value); const { rows } = await getPool().query("SELECT * FROM depannhome_einvoice_connections WHERE id=$1 AND owner_id=$2", [id, ownerId]); if (!rows[0]) throw httpError(404, "Connexion introuvable."); return rows[0]; }
async function requireOwnerTransmission(ownerId, value) { const id = positiveId(value); const { rows } = await getPool().query("SELECT * FROM depannhome_einvoice_transmissions WHERE id=$1 AND owner_id=$2", [id, ownerId]); if (!rows[0]) throw httpError(404, "Transmission introuvable."); return rows[0]; }
async function usableCredentials(ownerId, connection, platform) {
    if (!platform?.supports.refresh || !connection.token_expires_at || new Date(connection.token_expires_at).getTime() > Date.now() + 60_000) return decryptCredentials(connection.encrypted_credentials);
    return rotateCredentials(ownerId, connection.id, platform);
}
async function rotateCredentials(ownerId, connectionId, platform, force = false) {
    const client = await getPool().connect();
    try {
        await client.query("BEGIN");
        const { rows } = await client.query("SELECT * FROM depannhome_einvoice_connections WHERE id=$1 AND owner_id=$2 FOR UPDATE", [connectionId, ownerId]);
        const current = rows[0];
        if (!current) throw httpError(404, "Connexion introuvable.");
        if (!force && current.token_expires_at && new Date(current.token_expires_at).getTime() > Date.now() + 60_000) {
            await client.query("COMMIT");
            return decryptCredentials(current.encrypted_credentials);
        }
        const result = await platform.refreshAuthentication({ credentials: decryptCredentials(current.encrypted_credentials), connection: connectionContext(current) });
        if (!result?.credentials) throw new Error("La plateforme n’a pas retourné de nouveaux jetons.");
        await client.query("UPDATE depannhome_einvoice_connections SET encrypted_credentials=$3,token_expires_at=$4,status='connected',last_checked_at=NOW(),refresh_metadata=refresh_metadata || $5::jsonb,updated_at=NOW() WHERE id=$1 AND owner_id=$2", [current.id, ownerId, encryptCredentials(result.credentials), result.tokenExpiresAt || null, JSON.stringify({ rotatedAt: new Date().toISOString() })]);
        await client.query("COMMIT");
        return result.credentials;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
async function recordEvent(database, ownerId, connectionId, transmissionId, actorId, eventType, status, message, details = {}) { await database.query("INSERT INTO depannhome_einvoice_events(owner_id,connection_id,transmission_id,actor_id,event_type,status,message,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)", [ownerId, connectionId || null, transmissionId || null, actorId || null, eventType, clean(status, 30), clean(message, 1000), JSON.stringify(safeObject(details))]); }
function requireCompanyAdministrator(request, response, next) { if (request.user?.role !== "admin") return response.status(403).json({ message: "La facturation électronique est réservée à l’administrateur de l’entreprise." }); return next(); }
function encryptionKey() { const secret = String(process.env.SESSION_SECRET || ""); if (process.env.NODE_ENV === "production" && secret.length < 32) throw new Error("SESSION_SECRET doit protéger les connexions de facturation électronique."); return crypto.createHash("sha256").update(secret || "development-electronic-invoicing-key").digest(); }
export function encryptElectronicInvoicingCredentials(value, secretOverride = "") { const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv("aes-256-gcm", secretOverride ? crypto.createHash("sha256").update(secretOverride).digest() : encryptionKey(), iv); const encrypted = Buffer.concat([cipher.update(JSON.stringify(safeObject(value)), "utf8"), cipher.final()]); return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`; }
export function decryptElectronicInvoicingCredentials(value, secretOverride = "") { const [iv, tag, encrypted] = String(value || "").split(".").map(item => Buffer.from(item, "base64url")); if (!iv?.length || !tag?.length || !encrypted?.length) throw new Error("Credentials absents ou illisibles."); const decipher = crypto.createDecipheriv("aes-256-gcm", secretOverride ? crypto.createHash("sha256").update(secretOverride).digest() : encryptionKey(), iv); decipher.setAuthTag(tag); return safeObject(JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8"))); }
const encryptCredentials = encryptElectronicInvoicingCredentials;
const decryptCredentials = decryptElectronicInvoicingCredentials;
function sha256(value) { return crypto.createHash("sha256").update(String(value || "")).digest("hex"); }
function safeObject(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function sanitizeManualConfiguration(value) {
    const platformName = clean(value?.platformName, 160);
    const accountIdentifier = clean(value?.accountIdentifier, 200);
    const authenticationType = MANUAL_AUTHENTICATION_TYPES.has(value?.authenticationType) ? value.authenticationType : "";
    if (!platformName || !accountIdentifier || !authenticationType) return { ok: false, message: "La plateforme, le compte et le mode d’authentification sont obligatoires." };
    const credentials = authenticationType === "api_key" ? { apiKey: secret(value?.apiKey, 4000) }
        : authenticationType === "oauth_client" ? { clientId: clean(value?.clientId, 500), clientSecret: secret(value?.clientSecret, 4000) }
            : authenticationType === "access_token" ? { accessToken: secret(value?.accessToken, 8000) }
                : authenticationType === "identifier_secret" ? { identifier: clean(value?.identifier, 500), secret: secret(value?.secret, 4000) }
                    : { credentialName: clean(value?.credentialName, 160), credentialValue: secret(value?.credentialValue, 8000) };
    return { ok: true, platformName, accountIdentifier, authenticationType, credentials, credentialsComplete: Object.values(credentials).every(Boolean) };
}
function clean(value, max) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, max); }
function secret(value, max) { return String(value || "").trim().slice(0, max); }
function positiveId(value) { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : 0; }
function safeError(error) { const status = Number(error?.status); if (status === 401 || status === 403) return "Authentification refusée par la plateforme."; if (status === 408 || error?.name === "AbortError" || error?.name === "TimeoutError") return "La plateforme n’a pas répondu dans le délai prévu."; return clean(error?.publicMessage || error?.message || "Erreur de communication avec la plateforme.", 500).replace(/(?:bearer|token|secret|api[_ -]?key|password)\s*[:=]\s*\S+/gi, "Identifiant sensible [masqué]"); }
function httpError(status, message) { const error = new Error(message); error.status = status; return error; }
function oauthCallbackPage(success, message) {
    const payload = JSON.stringify({ type: "depannhome:einvoice-oauth", success: Boolean(success), message: clean(message, 500) }).replace(/</g, "\\u003c");
    const title = success ? "Connexion enregistrée" : "Connexion impossible";
    return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title></head><body><main><h1>${title}</h1><p>${escapeHtml(message)}</p><p>Vous pouvez fermer cette fenêtre.</p></main><script>if(window.opener){window.opener.postMessage(${payload},window.location.origin);window.close();}</script></body></html>`;
}
function escapeHtml(value) { return String(value || "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }
function asyncHandler(handler) { return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next); }
