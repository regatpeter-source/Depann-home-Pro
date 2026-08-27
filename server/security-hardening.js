import { createHash, createHmac } from "node:crypto";
import { getPool } from "./database.js";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const EXTERNAL_WRITE_PREFIXES = [
    "/api/partner-intake/",
    "/api/partner-dialogue/external/",
    "/api/partner-sandbox/external-callback/",
    "/api/e-invoicing/webhooks/"
];

export function contentSecurityPolicy() {
    const directives = {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", "data:"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:", "blob:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        workerSrc: ["'self'", "blob:"]
    };
    if (process.env.NODE_ENV === "production") directives.upgradeInsecureRequests = [];
    return {
        directives
    };
}

export function validateSecurityConfiguration() {
    const secret = String(process.env.SESSION_SECRET || "");
    if (secret.length < 32 || /GENEREZ_UN_SECRET|CHANGE_ME|mot.de.passe|password/i.test(secret)) throw new Error("SESSION_SECRET doit être aléatoire et contenir au moins 32 caractères.");
    if (process.env.NODE_ENV === "production") {
        const publicUrl = String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "");
        if (!publicUrl.startsWith("https://")) throw new Error("PUBLIC_BASE_URL (ou RENDER_EXTERNAL_URL) HTTPS est obligatoire en production.");
    }
    return true;
}

export function createOriginProtection({ audit = recordSecurityEvent } = {}) {
    return (request, response, next) => {
        if (!UNSAFE_METHODS.has(request.method) || isExternalWrite(request.path)) return next();
        const fetchSite = String(request.get("Sec-Fetch-Site") || "").toLowerCase();
        const origin = String(request.get("Origin") || "");
        const allowed = allowedOrigins(request);
        const crossSite = fetchSite === "cross-site";
        const invalidOrigin = Boolean(origin) && !allowed.has(normalizeOrigin(origin));
        if (!crossSite && !invalidOrigin) return next();
        void audit({ request, eventType: "csrf_origin_blocked", outcome: "blocked", details: { path: normalizedPath(request.path), fetchSite: fetchSite || "missing" } });
        return response.status(403).json({ message: "Origine de requête non autorisée." });
    };
}

export async function recordSecurityEvent({ request, eventType, outcome, ownerId = null, userId = null, details = {} }) {
    try {
        const key = String(process.env.HEALTH_TELEMETRY_SECRET || process.env.SESSION_SECRET || "security-events");
        const hash = value => value ? createHmac("sha256", key).update(String(value)).digest("hex") : "";
        await getPool().query(`INSERT INTO depannhome_security_events(owner_id,user_id,event_type,outcome,ip_hash,user_agent_hash,details)
            VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`, [ownerId || request?.user?.accountOwnerId || null, userId || request?.user?.sub || null, clean(eventType, 80), outcome, hash(request?.ip), hash(request?.get?.("User-Agent")), JSON.stringify(safeDetails(details))]);
    } catch (error) {
        console.warn("[security] audit unavailable", clean(error?.code || error?.name || "ERROR", 80));
    }
}

export function securityConfigurationFingerprint() {
    return createHash("sha256").update(JSON.stringify(contentSecurityPolicy().directives)).digest("hex");
}

function allowedOrigins(request) {
    const origins = new Set();
    const configured = [process.env.PUBLIC_BASE_URL, process.env.RENDER_EXTERNAL_URL, process.env.APP_ORIGIN].filter(Boolean);
    for (const value of configured) {
        const normalized = normalizeOrigin(value);
        if (normalized) origins.add(normalized);
    }
    if (!origins.size) {
        const host = request.get("host");
        if (host) origins.add(`${request.protocol}://${host}`);
    }
    return origins;
}
function normalizeOrigin(value) { try { return new URL(String(value)).origin; } catch { return ""; } }
function isExternalWrite(path) { return EXTERNAL_WRITE_PREFIXES.some(prefix => String(path).startsWith(prefix)); }
function normalizedPath(value) { return String(value || "/").replace(/\/\d+(?=\/|$)/g, "/:id").slice(0, 240); }
function clean(value, maximum) { return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum); }
function safeDetails(details) { return Object.fromEntries(Object.entries(details || {}).filter(([key, value]) => !/secret|token|password|cookie|authorization/i.test(key) && ["string", "number", "boolean"].includes(typeof value)).map(([key, value]) => [clean(key, 80), typeof value === "string" ? clean(value, 240) : value])); }

export const securityTestHelpers = Object.freeze({ allowedOrigins, isExternalWrite, normalizeOrigin });
