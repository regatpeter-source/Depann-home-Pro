import crypto from "node:crypto";
import { getPool } from "./database.js";
import { getAccountOwnerId } from "./auth.js";
import { executeConnectorRequest, isSafeExternalUrl, requestClientCredentialsToken } from "./connector-runtime.js";

const AUTH_TYPES = new Set(["apiKey", "oauth2", "jwt", "basic", "bearer", "custom"]);
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const CONNECTOR_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const MAX_ENDPOINTS = 50;
const MAX_LOGS = 100;

/**
 * Registre de plugins déclaratifs. Il ne charge jamais de JavaScript fourni par un client :
 * un connecteur est exécuté par ce runtime contrôlé, avec ses paramètres stockés par tenant.
 */
export async function initializeConnectors() {
    const database = getPool();
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_api_connectors (
            id BIGSERIAL PRIMARY KEY,
            owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            connector_key VARCHAR(64) NOT NULL,
            manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
            configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
            encrypted_credentials TEXT NOT NULL DEFAULT '',
            enabled BOOLEAN NOT NULL DEFAULT FALSE,
            created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT depannhome_api_connectors_owner_key_unique UNIQUE (owner_id, connector_key)
        )
    `);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_api_connectors_owner_updated_idx ON depannhome_api_connectors (owner_id, updated_at DESC)");
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_api_connector_logs (
            id BIGSERIAL PRIMARY KEY,
            owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            connector_id BIGINT NOT NULL REFERENCES depannhome_api_connectors(id) ON DELETE CASCADE,
            action VARCHAR(40) NOT NULL,
            status VARCHAR(20) NOT NULL,
            endpoint_name VARCHAR(160) NOT NULL DEFAULT '',
            request_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
            response_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
            message VARCHAR(1000) NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_api_connector_logs_owner_connector_idx ON depannhome_api_connector_logs (owner_id, connector_id, created_at DESC)");
}

export function registerConnectorRoutes(app, requireAuthentication, requireCreator) {
    app.use("/api/connectors", requireAuthentication, requireCreator);

    app.get("/api/connectors", asyncHandler(async (request, response) => {
        const ownerId = getAccountOwnerId(request);
        const [connectors, logs] = await Promise.all([loadConnectors(ownerId), loadLogs(ownerId)]);
        response.json({ connectors, logs, capabilities: { authTypes: [...AUTH_TYPES], methods: [...HTTP_METHODS], maxEndpoints: MAX_ENDPOINTS } });
    }));

    app.post("/api/connectors", asyncHandler(async (request, response) => {
        const connector = sanitizeConnector(request.body);
        if (!connector.ok) return response.status(400).json({ message: connector.message });
        const ownerId = getAccountOwnerId(request);
        const { rows } = await getPool().query(`
            INSERT INTO depannhome_api_connectors (owner_id, connector_key, manifest, configuration, encrypted_credentials, enabled, created_by)
            VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7) RETURNING id
        `, [ownerId, connector.key, JSON.stringify(connector.manifest), JSON.stringify(connector.configuration), encryptSecret(connector.credentials), connector.enabled, request.user.sub]);
        await writeLog(ownerId, rows[0].id, "install", "success", "", { connectorKey: connector.key }, {}, "Connecteur installé.");
        response.status(201).json({ id: rows[0].id, connectorKey: connector.key });
    }));

    app.put("/api/connectors/:connectorId", asyncHandler(async (request, response) => {
        const id = positiveId(request.params.connectorId);
        const connector = sanitizeConnector(request.body);
        if (!id || !connector.ok) return response.status(400).json({ message: connector.message || "Connecteur invalide." });
        const ownerId = getAccountOwnerId(request);
        const previous = await findConnector(ownerId, id, true);
        if (!previous) return response.status(404).json({ message: "Connecteur introuvable." });
        const credentials = Object.keys(connector.credentials).length ? encryptSecret(connector.credentials) : previous.encryptedCredentials;
        const result = await getPool().query(`
            UPDATE depannhome_api_connectors SET connector_key=$3, manifest=$4::jsonb, configuration=$5::jsonb, encrypted_credentials=$6, enabled=$7, updated_at=NOW()
            WHERE id=$1 AND owner_id=$2
        `, [id, ownerId, connector.key, JSON.stringify(connector.manifest), JSON.stringify(connector.configuration), credentials, connector.enabled]);
        if (!result.rowCount) return response.status(404).json({ message: "Connecteur introuvable." });
        await writeLog(ownerId, id, "update", "success", "", { connectorKey: connector.key }, {}, "Configuration mise à jour.");
        response.status(204).end();
    }));

    app.patch("/api/connectors/:connectorId/status", asyncHandler(async (request, response) => {
        const id = positiveId(request.params.connectorId);
        if (!id || typeof request.body?.enabled !== "boolean") return response.status(400).json({ message: "Statut de connecteur invalide." });
        const ownerId = getAccountOwnerId(request);
        const result = await getPool().query("UPDATE depannhome_api_connectors SET enabled=$3, updated_at=NOW() WHERE id=$1 AND owner_id=$2", [id, ownerId, request.body.enabled]);
        if (!result.rowCount) return response.status(404).json({ message: "Connecteur introuvable." });
        await writeLog(ownerId, id, request.body.enabled ? "enable" : "disable", "success", "", {}, {}, request.body.enabled ? "Connecteur activé." : "Connecteur désactivé.");
        response.status(204).end();
    }));

    app.delete("/api/connectors/:connectorId", asyncHandler(async (request, response) => {
        const result = await getPool().query("DELETE FROM depannhome_api_connectors WHERE id=$1 AND owner_id=$2", [positiveId(request.params.connectorId), getAccountOwnerId(request)]);
        if (!result.rowCount) return response.status(404).json({ message: "Connecteur introuvable." });
        response.status(204).end();
    }));

    app.post("/api/connectors/:connectorId/test", asyncHandler(async (request, response) => {
        const id = positiveId(request.params.connectorId);
        const ownerId = getAccountOwnerId(request);
        const connector = await findConnector(ownerId, id, true);
        if (!connector) return response.status(404).json({ message: "Connecteur introuvable." });
        const endpoint = endpointForTest(connector.manifest.endpoints, request.body?.endpointId);
        if (!endpoint) return response.status(400).json({ message: "Choisissez un endpoint configuré." });
        const result = await executeTest(connector, endpoint, request.body?.payload);
        await writeLog(ownerId, id, "test", result.ok ? "success" : "failed", endpoint.name, result.request, result.response, result.message);
        response.status(result.ok ? 200 : 502).json(result);
    }));

    app.get("/api/connectors/:connectorId/export", asyncHandler(async (request, response) => {
        const connector = await findConnector(getAccountOwnerId(request), positiveId(request.params.connectorId), false);
        if (!connector) return response.status(404).json({ message: "Connecteur introuvable." });
        const bundle = generateBundle(connector);
        response.set({ "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="${safeFileName(connector.connectorKey)}-connector.json"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
        response.json(bundle);
    }));

    app.post("/api/connectors/import", asyncHandler(async (request, response) => {
        const imported = sanitizeImportedBundle(request.body);
        if (!imported.ok) return response.status(400).json({ message: imported.message });
        const ownerId = getAccountOwnerId(request);
        const { rows } = await getPool().query(`
            INSERT INTO depannhome_api_connectors (owner_id, connector_key, manifest, configuration, enabled, created_by)
            VALUES ($1,$2,$3::jsonb,$4::jsonb,FALSE,$5)
            ON CONFLICT (owner_id, connector_key) DO UPDATE SET manifest=EXCLUDED.manifest, configuration=EXCLUDED.configuration, enabled=FALSE, updated_at=NOW()
            RETURNING id
        `, [ownerId, imported.connector.key, JSON.stringify(imported.connector.manifest), JSON.stringify(imported.connector.configuration), request.user.sub]);
        await writeLog(ownerId, rows[0].id, "import", "success", "", { connectorKey: imported.connector.key }, {}, "Paquet importé. Ajoutez les secrets puis activez le connecteur.");
        response.status(201).json({ id: rows[0].id });
    }));

    app.get("/api/connectors/:connectorId/documentation", asyncHandler(async (request, response) => {
        const connector = await findConnector(getAccountOwnerId(request), positiveId(request.params.connectorId), false);
        if (!connector) return response.status(404).json({ message: "Connecteur introuvable." });
        response.set({ "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="${safeFileName(connector.connectorKey)}-README.md"`, "Cache-Control": "private, no-store" });
        response.send(buildDocumentation(connector));
    }));
}

async function loadConnectors(ownerId) {
    const { rows } = await getPool().query(`SELECT id, connector_key AS "connectorKey", manifest, configuration, encrypted_credentials AS "encryptedCredentials", enabled, created_at AS "createdAt", updated_at AS "updatedAt" FROM depannhome_api_connectors WHERE owner_id=$1 ORDER BY updated_at DESC`, [ownerId]);
    return rows.map(connector => publicConnector(connector));
}
export async function connectorCatalogOptions() {
    const { rows } = await getPool().query(`SELECT id,connector_key AS "connectorKey",manifest->'general'->>'name' AS name,enabled
        FROM depannhome_api_connectors ORDER BY LOWER(COALESCE(manifest->'general'->>'name',connector_key)),id`);
    return rows.map(row => ({ id: String(row.id), connectorKey: row.connectorKey, name: row.name || row.connectorKey, enabled: Boolean(row.enabled) }));
}
async function findConnector(ownerId, id, includeSecret) {
    const { rows } = await getPool().query(`SELECT id, connector_key AS "connectorKey", manifest, configuration, encrypted_credentials AS "encryptedCredentials", enabled, created_at AS "createdAt", updated_at AS "updatedAt" FROM depannhome_api_connectors WHERE owner_id=$1 AND id=$2`, [ownerId, id]);
    return rows[0] ? (includeSecret ? rows[0] : publicConnector(rows[0])) : null;
}
async function loadLogs(ownerId) {
    const { rows } = await getPool().query(`SELECT log.id, log.connector_id AS "connectorId", connector.connector_key AS "connectorKey", log.action, log.status, log.endpoint_name AS "endpointName", log.request_summary AS "request", log.response_summary AS "response", log.message, log.created_at AS "createdAt" FROM depannhome_api_connector_logs log JOIN depannhome_api_connectors connector ON connector.id=log.connector_id WHERE log.owner_id=$1 ORDER BY log.created_at DESC LIMIT $2`, [ownerId, MAX_LOGS]);
    return rows;
}
function publicConnector(connector) { return { id: connector.id, connectorKey: connector.connectorKey, manifest: connector.manifest, configuration: connector.configuration, enabled: Boolean(connector.enabled), hasCredentials: Boolean(connector.encryptedCredentials), createdAt: connector.createdAt, updatedAt: connector.updatedAt }; }
async function writeLog(ownerId, connectorId, action, status, endpointName, request, response, message) { await getPool().query(`INSERT INTO depannhome_api_connector_logs (owner_id, connector_id, action, status, endpoint_name, request_summary, response_summary, message) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`, [ownerId, connectorId, action, status, cleanText(endpointName, 160), JSON.stringify(redact(request)), JSON.stringify(redact(response)), cleanText(message, 1000)]); }

function sanitizeConnector(value) {
    const key = slug(value?.connectorKey || value?.general?.name);
    const name = cleanText(value?.general?.name, 160);
    const authType = AUTH_TYPES.has(value?.connection?.authType) ? value.connection.authType : "";
    const baseUrl = cleanUrl(value?.connection?.baseUrl);
    if (!key || !name || !authType || !baseUrl) return { ok: false, message: "Nom, authentification et URL de base HTTPS sont obligatoires." };
    const endpoints = Array.isArray(value?.endpoints) ? value.endpoints.map(sanitizeEndpoint).filter(Boolean).slice(0, MAX_ENDPOINTS) : [];
    if (!endpoints.length) return { ok: false, message: "Ajoutez au moins un endpoint valide." };
    const timeout = boundedInteger(value?.connection?.timeout, 1000, 60000, 15000);
    const retries = boundedInteger(value?.connection?.maxRetries, 0, 5, 2);
    const syncMinutes = boundedInteger(value?.connection?.syncMinutes, 5, 10080, 60);
    const manifest = { schemaVersion: 2, general: { name, logoUrl: cleanUrl(value?.general?.logoUrl, true), description: cleanText(value?.general?.description, 2000), version: cleanText(value?.general?.version, 40) || "1.0.0", author: cleanText(value?.general?.author, 160), website: cleanUrl(value?.general?.website, true) }, connection: { authType, baseUrl, testUrl: cleanUrl(value?.connection?.testUrl, true), productionUrl: cleanUrl(value?.connection?.productionUrl, true), tokenUrl: cleanUrl(value?.connection?.tokenUrl, true), tokenAuthMethod: value?.connection?.tokenAuthMethod === "basic" ? "basic" : "body", scope: cleanText(value?.connection?.scope, 1000), audience: cleanText(value?.connection?.audience, 1000), tenantHeaderName: cleanHeaderName(value?.connection?.tenantHeaderName), timeout, maxRetries: retries, syncMinutes }, endpoints, mappings: sanitizeMappings(value?.mappings) };
    return { ok: true, key, manifest, configuration: { lastTestAt: "", lastTestStatus: "not_tested", notes: cleanText(value?.configuration?.notes, 1000) }, credentials: sanitizeCredentials(value?.credentials), enabled: Boolean(value?.enabled) };
}
function sanitizeEndpoint(value, index) {
    const name = cleanText(value?.name, 160);
    const path = cleanPath(value?.path);
    const method = HTTP_METHODS.has(String(value?.method || "").toUpperCase()) ? String(value.method).toUpperCase() : "";
    if (!name || !path || !method) return null;
    return { id: cleanText(value?.id, 80) || `endpoint-${index + 1}`, name, path, method, eventType: cleanEventType(value?.eventType), parameters: sanitizeObject(value?.parameters), headers: sanitizeObject(value?.headers), body: cleanJsonText(value?.body, 10000), expectedResponse: cleanJsonText(value?.expectedResponse, 10000), purpose: cleanText(value?.purpose, 300) };
}
function sanitizeMappings(value) { return (Array.isArray(value) ? value : []).map(item => ({ apiField: cleanText(item?.apiField, 160), depannhomeField: cleanText(item?.depannhomeField, 160), transform: cleanText(item?.transform, 300) })).filter(item => item.apiField && item.depannhomeField).slice(0, 100); }
function sanitizeCredentials(value) { const input = value && typeof value === "object" && !Array.isArray(value) ? value : {}; return Object.fromEntries(Object.entries(input).slice(0, 20).map(([key, item]) => [cleanText(key, 80), cleanText(item, 2000)]).filter(([key, item]) => key && item)); }
function sanitizeObject(value) { const input = value && typeof value === "object" && !Array.isArray(value) ? value : {}; return Object.fromEntries(Object.entries(input).slice(0, 40).map(([key, item]) => [cleanText(key, 80), cleanText(item, 1000)]).filter(([key]) => key)); }
function sanitizeImportedBundle(value) { const candidate = value?.manifest ? { connectorKey: value.connectorKey, general: value.manifest.general, connection: value.manifest.connection, endpoints: value.manifest.endpoints, mappings: value.manifest.mappings, configuration: value.configuration } : value; const connector = sanitizeConnector(candidate); return connector.ok ? { ok: true, connector } : connector; }

function endpointForTest(endpoints, id) { return (endpoints || []).find(endpoint => String(endpoint.id) === String(id)) || (endpoints || [])[0]; }
async function executeTest(connector, endpoint, suppliedPayload) {
    const connection = connector.manifest.connection;
    const credentials = decryptSecret(connector.encryptedCredentials);
    const payload = suppliedPayload && typeof suppliedPayload === "object" && !Array.isArray(suppliedPayload) ? suppliedPayload : parseJson(endpoint.body, {});
    const variables = { ...payload, payload, missionId: payload.missionId || payload.mission_order_id || payload.id || "TEST-MISSION", mission_order_id: payload.mission_order_id || payload.missionId || payload.id || "TEST-MISSION" };
    try {
        let result; let attempt = 0;
        while (attempt <= connection.maxRetries) { try { result = await executeConnectorRequest({ connector: { ...connector, credentials }, endpoint: { ...endpoint, body: suppliedPayload ? "" : endpoint.body }, payload, variables }); if (result.status < 500) break; } catch (error) { if (attempt >= connection.maxRetries) throw error; } attempt += 1; }
        const validation = validateResponse(result.body, endpoint.expectedResponse, connector.manifest.mappings);
        const summary = { status: result.status, ok: result.ok, body: redact(result.body), validation };
        return { ok: result.ok, message: result.ok ? (validation.valid ? "Test et mapping validés." : "La requête a réussi, mais le mapping ou la réponse attendue doit être ajusté.") : `Le partenaire a répondu HTTP ${result.status}.`, request: redact(result.request), response: summary };
    } catch (error) { return { ok: false, message: error.name === "TimeoutError" ? "Délai de connexion dépassé." : cleanText(error.message, 300) || "Connexion au partenaire impossible.", request: { method: endpoint.method }, response: { error: cleanText(error.message, 300) } }; }
}

export async function testConnectorCredentials(connectorId, credentials, fetchImpl = fetch) {
    const connector = await centralConnector(connectorId);
    if (!connector || !connector.enabled) throw connectorClientError(409, "Le connecteur technique associé est introuvable ou désactivé.");
    const sanitizedCredentials = sanitizeCredentials(credentials);
    const endpoint = (connector.manifest?.endpoints || []).find(item => !item.eventType);
    try {
        if (!endpoint && connector.manifest?.connection?.authType === "oauth2" && sanitizedCredentials.clientId && sanitizedCredentials.clientSecret) {
            await requestClientCredentialsToken(connector.manifest.connection, sanitizedCredentials, { cacheKey: `company-connection-test:${connector.id}:${crypto.createHash("sha256").update(sanitizedCredentials.clientId).digest("hex")}`, fetchImpl, force: true });
            return { ok: true };
        }
        if (!endpoint) throw connectorClientError(409, "Ajoutez un endpoint de test sans événement à ce connecteur.");
        const payload = parseJson(endpoint.body, {});
        const variables = { ...payload, payload, missionId: "TEST-MISSION", mission_order_id: "TEST-MISSION", externalMissionId: "TEST-MISSION" };
        const result = await executeConnectorRequest({ connector: { ...connector, credentials: sanitizedCredentials }, endpoint, payload, variables, fetchImpl });
        if (!result.ok) throw connectorClientError(502, `Le partenaire a refusé la connexion (HTTP ${result.status}).`);
        return { ok: true };
    } catch (error) {
        if (error.status) throw error;
        throw connectorClientError(502, cleanText(error.message, 300) || "Le test de connexion au partenaire a échoué.");
    }
}

export async function executeCentralConnectorEvent(connectorId, credentials, eventType, payload, variables = {}) {
    const connector = await centralConnector(connectorId);
    if (!connector || !connector.enabled) return { handled: false };
    const endpoint = (connector.manifest?.endpoints || []).find(item => item.eventType === eventType);
    if (!endpoint) return { handled: false };
    try {
        const result = await executeConnectorRequest({ connector: { ...connector, credentials: sanitizeCredentials(credentials) }, endpoint, payload, variables: { ...variables, payload } });
        await writeLog(connector.ownerId, connector.id, eventType, result.ok ? "success" : "failed", endpoint.name, result.request, result, result.ok ? "Événement transmis avec la connexion de l’entreprise." : `Le partenaire a répondu HTTP ${result.status}.`);
        return { handled: true, ...result };
    } catch (error) {
        await writeLog(connector.ownerId, connector.id, eventType, "failed", endpoint.name, { method: endpoint.method }, {}, cleanText(error.message, 1000));
        throw error;
    }
}

async function centralConnector(id) {
    const { rows } = await getPool().query(`SELECT id,owner_id AS "ownerId",connector_key AS "connectorKey",manifest,enabled
        FROM depannhome_api_connectors WHERE id=$1`, [positiveId(id)]);
    return rows[0] || null;
}

export async function executeConnectorEvent(ownerId, connectorKey, eventType, payload, variables = {}) {
    const { rows } = await getPool().query(`SELECT id,connector_key AS "connectorKey",manifest,encrypted_credentials AS "encryptedCredentials" FROM depannhome_api_connectors WHERE owner_id=$1 AND connector_key=$2 AND enabled=TRUE`, [ownerId, connectorKey]);
    const connector = rows[0];
    if (!connector) return { handled: false };
    const endpoint = (connector.manifest?.endpoints || []).find(item => item.eventType === eventType);
    if (!endpoint) return { handled: false };
    try {
        const result = await executeConnectorRequest({ connector: { ...connector, credentials: decryptSecret(connector.encryptedCredentials) }, endpoint, payload, variables: { ...variables, payload } });
        await writeLog(ownerId, connector.id, eventType, result.ok ? "success" : "failed", endpoint.name, result.request, result, result.ok ? "Événement transmis au partenaire." : `Le partenaire a répondu HTTP ${result.status}.`);
        return { handled: true, ...result };
    } catch (error) {
        await writeLog(ownerId, connector.id, eventType, "failed", endpoint.name, { method: endpoint.method }, {}, cleanText(error.message, 1000));
        throw error;
    }
}
function generateBundle(connector) { const manifest = connector.manifest; const documentation = buildDocumentation(connector); return { format: "depannhome-api-connector", formatVersion: 1, connectorKey: connector.connectorKey, manifest, configuration: connector.configuration, files: { "manifest.json": JSON.stringify({ connectorKey: connector.connectorKey, manifest }, null, 2), "config.json": JSON.stringify({ ...connector.configuration, credentials: "Configurez les secrets après import." }, null, 2), "connector.js": generatedConnectorSource(connector), "sync.js": generatedSyncSource(connector), "README.md": documentation, "logs/README.md": "Les journaux d’exécution sont conservés dans Depann’Home Pro et ne sont pas exportés avec les secrets." } }; }
function generatedConnectorSource(connector) { return `// Connecteur déclaratif généré par Depann’Home Pro\nexport const manifest = ${JSON.stringify(connector.manifest, null, 2)};\nexport default manifest;\n`; }
function generatedSyncSource(connector) { return `// Modèle de synchronisation pour ${connector.manifest.general.name}\n// L’exécution est assurée par le runtime sécurisé Depann’Home Pro.\nexport const mappings = ${JSON.stringify(connector.manifest.mappings, null, 2)};\n`; }
function buildDocumentation(connector) { const { general, connection, endpoints, mappings } = connector.manifest; return `# ${general.name}\n\n- **Version :** ${general.version}\n- **Auteur :** ${general.author || "Non renseigné"}\n- **Authentification :** ${connection.authType}\n- **Synchronisation :** toutes les ${connection.syncMinutes} minute(s)\n- **Limitation :** les secrets ne sont jamais inclus dans les exports. Les appels sont exécutés par le runtime Depann’Home Pro.\n\n## Endpoints\n\n${endpoints.map(endpoint => `- **${endpoint.name}** — \`${endpoint.method} ${endpoint.path}\`${endpoint.purpose ? ` : ${endpoint.purpose}` : ""}`).join("\n")}\n\n## Mapping des données\n\n${mappings.length ? "| Champ API | Champ Depann’Home Pro | Transformation |\n|---|---|---|\n" + mappings.map(item => `| ${item.apiField} | ${item.depannhomeField} | ${item.transform || "—"} |`).join("\n") : "Aucun mapping configuré."}\n\n## Historique\n\n- ${new Date().toISOString().slice(0, 10)} — Paquet généré depuis la configuration ${general.version}.\n`; }
function cleanUrl(value, optional = false) { const raw = cleanText(value, 1000); if (!raw && optional) return ""; try { const url = new URL(raw); return isSafeExternalUrl(url) ? url.toString().replace(/\/$/, "") : ""; } catch { return ""; } }
function cleanPath(value) { const path = cleanText(value, 1000); return path && path.startsWith("/") && !path.startsWith("//") ? path : ""; }
function cleanJsonText(value, max) { const text = String(value || "").trim().slice(0, max); if (!text) return ""; try { JSON.parse(text); return text; } catch { return ""; } }
function parseJson(value, fallback) { try { return typeof value === "string" ? JSON.parse(value) : value; } catch { return fallback; } }
function validateResponse(body, expectedResponse, mappings) {
    const expected = expectedResponse ? parseJson(expectedResponse, null) : null;
    const expectedMissing = expected && typeof expected === "object" && !Array.isArray(expected)
        ? Object.keys(expected).filter(key => !Object.prototype.hasOwnProperty.call(body && typeof body === "object" ? body : {}, key)) : [];
    const source = Array.isArray(body) ? body[0] : body;
    const missingApiFields = (mappings || []).map(item => item.apiField).filter(field => field && readJsonPath(source, field) === undefined);
    return { valid: expectedMissing.length === 0 && missingApiFields.length === 0, expectedMissing, missingApiFields, checkedMappings: (mappings || []).length };
}
function readJsonPath(value, path) { return String(path).replace(/^\$\.?/, "").split(".").filter(Boolean).reduce((current, key) => current && typeof current === "object" ? current[key] : undefined, value); }
function redact(value) { if (Array.isArray(value)) return value.map(redact); if (!value || typeof value !== "object") return value; return Object.fromEntries(Object.entries(value).map(([key, item]) => /authorization|token|secret|password|api.?key|tenant/i.test(key) ? [key, "[masqué]"] : [key, redact(item)])); }
function slug(value) { const key = String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64); return CONNECTOR_ID.test(key) ? key : ""; }
function safeFileName(value) { return String(value || "connecteur").replace(/[^a-z0-9_-]/gi, "-"); }
function cleanText(value, max) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, max); }
function cleanHeaderName(value) { const name = cleanText(value, 100); return /^[A-Za-z0-9-]+$/.test(name) ? name : ""; }
function cleanEventType(value) { const event = cleanText(value, 80); return /^[a-z][a-z0-9_:-]*$/.test(event) ? event : ""; }
function positiveId(value) { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : 0; }
function boundedInteger(value, min, max, fallback) { const number = Number(value); return Number.isSafeInteger(number) && number >= min && number <= max ? number : fallback; }
function connectorClientError(status, message) { const error = new Error(message); error.status = status; return error; }
function encryptionKey() { return crypto.createHash("sha256").update(String(process.env.SESSION_SECRET || "development-connector-key")).digest(); }
function encryptSecret(value) { if (!Object.keys(value).length) return ""; const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv); const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]); return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`; }
function decryptSecret(value) { try { if (!value) return {}; const [iv, tag, encrypted] = String(value).split(".").map(item => Buffer.from(item, "base64url")); const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), iv); decipher.setAuthTag(tag); return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8")); } catch { return {}; } }
function asyncHandler(handler) { return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next); }
