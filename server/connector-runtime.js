import crypto from "node:crypto";

const tokenCache = new Map();
const TOKEN_SAFETY_MARGIN_MS = 60_000;

export async function executeConnectorRequest({ connector, endpoint, payload = {}, variables = {}, fetchImpl = fetch }) {
    const connection = connector?.manifest?.connection || {};
    const credentials = connector?.credentials || {};
    const base = connection.testUrl || connection.productionUrl || connection.baseUrl;
    const path = interpolateConnectorPath(endpoint.path, variables);
    if (/\{[a-zA-Z0-9_.-]+\}/.test(path)) throw connectorError("Un paramètre obligatoire du chemin de l’endpoint est manquant.");
    const url = new URL(path, String(base || "").endsWith("/") ? base : `${base}/`);
    for (const [key, value] of Object.entries(interpolateConnectorValue(endpoint.parameters || {}, variables))) url.searchParams.set(key, String(value));
    assertSafeExternalUrl(url);

    const headers = { Accept: "application/json", ...interpolateConnectorValue(endpoint.headers || {}, variables) };
    const bodyTemplate = endpoint.body ? parseJson(endpoint.body, {}) : payload;
    const requestPayload = interpolateConnectorValue(bodyTemplate, { ...variables, payload });
    const options = { method: endpoint.method, headers, redirect: "error", signal: AbortSignal.timeout(connection.timeout || 15_000) };
    if (!["GET", "DELETE"].includes(endpoint.method)) {
        headers["Content-Type"] ||= "application/json";
        options.body = JSON.stringify(requestPayload);
    }

    const cacheKey = connectorTokenCacheKey(connector, credentials);
    const perform = async forceToken => {
        await applyConnectorAuthentication(headers, connection, credentials, { cacheKey, fetchImpl, forceToken });
        return fetchImpl(url, options);
    };
    let response = await perform(false);
    if (connection.authType === "oauth2" && response.status === 401 && credentials.clientId && credentials.clientSecret) response = await perform(true);
    const text = await response.text();
    return { ok: response.ok, status: response.status, body: parseJson(text, text.slice(0, 10_000)), request: { url: url.toString(), method: endpoint.method, headers, payload: requestPayload } };
}

export async function requestClientCredentialsToken(connection, credentials, { cacheKey = "default", fetchImpl = fetch, force = false } = {}) {
    const cached = tokenCache.get(cacheKey);
    if (!force && cached && cached.expiresAt > Date.now() + TOKEN_SAFETY_MARGIN_MS) return cached.token;
    const tokenUrl = new URL(connection.tokenUrl || "");
    assertSafeExternalUrl(tokenUrl);
    if (!credentials.clientId || !credentials.clientSecret) throw connectorError("Les identifiants OAuth 2.0 client_credentials sont incomplets.");

    const form = new URLSearchParams({ grant_type: "client_credentials" });
    if (connection.scope) form.set("scope", connection.scope);
    if (connection.audience) form.set("audience", connection.audience);
    const headers = { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" };
    if (connection.tokenAuthMethod === "basic") headers.Authorization = `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64")}`;
    else {
        form.set("client_id", credentials.clientId);
        form.set("client_secret", credentials.clientSecret);
    }
    const response = await fetchImpl(tokenUrl, { method: "POST", headers, body: form.toString(), redirect: "error", signal: AbortSignal.timeout(connection.timeout || 15_000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) throw connectorError(`Le serveur OAuth a refusé la demande de jeton (HTTP ${response.status}).`);
    const expiresIn = Math.max(60, Math.min(Number(data.expires_in) || 3600, 86_400));
    const token = String(data.access_token);
    tokenCache.set(cacheKey, { token, expiresAt: Date.now() + expiresIn * 1000 });
    return token;
}

export async function applyConnectorAuthentication(headers, connection, credentials, options = {}) {
    if (connection.authType === "oauth2") {
        const token = credentials.clientId && credentials.clientSecret
            ? await requestClientCredentialsToken(connection, credentials, { ...options, force: options.forceToken })
            : credentials.accessToken || credentials.token || "";
        if (!token) throw connectorError("Aucun jeton OAuth 2.0 ou identifiant client n’est configuré.");
        headers.Authorization = `Bearer ${token}`;
        if (connection.tenantHeaderName && credentials.tenantId) headers[connection.tenantHeaderName] = credentials.tenantId;
        return;
    }
    const token = credentials.apiKey || credentials.token || credentials.accessToken || "";
    if (connection.authType === "apiKey" && token) headers[credentials.headerName || "X-API-Key"] = token;
    if (["bearer", "jwt"].includes(connection.authType) && token) headers.Authorization = `Bearer ${token}`;
    if (connection.authType === "basic" && credentials.username) headers.Authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password || ""}`).toString("base64")}`;
    if (connection.authType === "custom") Object.assign(headers, sanitizeHeaderObject(parseJson(credentials.headers, {})));
}

export function interpolateConnectorValue(value, variables) {
    if (Array.isArray(value)) return value.map(item => interpolateConnectorValue(item, variables));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolateConnectorValue(item, variables)]));
    if (typeof value !== "string") return value;
    return value.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (match, key) => {
        const replacement = readPath(variables, key);
        return replacement === undefined || replacement === null ? match : encodeTemplateValue(replacement);
    });
}

export function interpolateConnectorPath(value, variables) {
    return String(value || "").replace(/\{([a-zA-Z0-9_.-]+)\}/g, (match, key) => {
        const replacement = readPath(variables, key);
        return replacement === undefined || replacement === null ? match : encodeURIComponent(String(replacement));
    });
}

export function assertSafeExternalUrl(value) {
    const url = value instanceof URL ? value : new URL(value);
    if (!isSafeExternalUrl(url)) throw connectorError("L’URL cible n’est pas autorisée.");
    return url;
}

export function isSafeExternalUrl(url) {
    if (!url || !["https:", "http:"].includes(url.protocol)) return false;
    const host = url.hostname.toLowerCase();
    return !["localhost", "0.0.0.0", "::1"].includes(host) && !/^127\./.test(host) && !/^10\./.test(host) && !/^192\.168\./.test(host) && !/^169\.254\./.test(host) && !/^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

export function clearConnectorTokenCache() { tokenCache.clear(); }

function connectorTokenCacheKey(connector, credentials) {
    return crypto.createHash("sha256").update(JSON.stringify([connector.id || connector.connectorKey, connector.manifest?.connection?.tokenUrl, connector.manifest?.connection?.scope, connector.manifest?.connection?.audience, credentials.clientId])).digest("hex");
}
function readPath(value, path) { return String(path).split(".").reduce((current, key) => current && typeof current === "object" ? current[key] : undefined, value); }
function encodeTemplateValue(value) { return typeof value === "object" ? JSON.stringify(value) : String(value); }
function parseJson(value, fallback) { try { return typeof value === "string" ? JSON.parse(value) : value; } catch { return fallback; } }
function sanitizeHeaderObject(value) { const input = value && typeof value === "object" && !Array.isArray(value) ? value : {}; return Object.fromEntries(Object.entries(input).slice(0, 40).map(([key, item]) => [String(key).replace(/[\r\n:]/g, "").trim().slice(0, 80), String(item).replace(/[\r\n]/g, " ").trim().slice(0, 2000)]).filter(([key]) => key)); }
function connectorError(message) { const error = new Error(message); error.code = "CONNECTOR_ERROR"; return error; }
