import crypto from "node:crypto";
import { ElectronicInvoicingProvider, registerElectronicInvoicingProvider } from "../electronic-invoicing.js";

const API_ORIGIN = "https://api.superpdp.tech";
const API_VERSION = "v1.beta";
const FAILURE_STATUSES = new Set([
    "api:invalid", "api:rejected", "fr:210", "fr:213", "fr:501",
    "ppf:validated-ack-error", "ppf:validated-rejected", "ppf:refused-ack-error", "ppf:refused-rejected",
    "ppf:payment-received-ack-error", "ppf:payment-received-rejected", "ppf:rejected-ack-error", "ppf:rejected-rejected",
    "ppf:flow-1-ack-error", "ppf:flow-1-rejected"
]);
const ACCEPTED_STATUSES = new Set(["api:accepted", "fr:205", "fr:209", "fr:212", "ppf:flow-1-response-ok"]);

export class SuperPdpProvider extends ElectronicInvoicingProvider {
    constructor({ fetchImplementation = globalThis.fetch } = {}) {
        super({
            code: "super_pdp",
            label: "SUPER PDP",
            authenticationType: "oauth2_authorization_code",
            environments: ["sandbox", "production"],
            supports: { invoices: true, creditNotes: true, status: true, refresh: true, webhooks: false }
        });
        this.fetchImplementation = fetchImplementation;
    }

    publicDefinition() {
        return { ...super.publicDefinition(), authorizationRequired: true, documentationUrl: "https://www.superpdp.tech/documentation" };
    }

    authorizationUrl({ state, codeChallenge, redirectUri, loginHint = "", companyNumber = "" }) {
        const { clientId } = oauthConfiguration(redirectUri);
        const url = new URL("/oauth2/authorize", API_ORIGIN);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", clientId);
        url.searchParams.set("redirect_uri", redirectUri);
        url.searchParams.set("state", state);
        url.searchParams.set("code_challenge", codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
        if (loginHint) url.searchParams.set("login_hint", loginHint);
        if (/^\d{9}$/.test(companyNumber)) {
            url.searchParams.set("superpdp_company_number", companyNumber);
            url.searchParams.set("superpdp_company_number_scheme", "fr_siren");
        }
        return url.toString();
    }

    async exchangeAuthorizationCode({ code, codeVerifier, redirectUri }) {
        const tokens = await this.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: codeVerifier }, redirectUri);
        const credentials = tokenCredentials(tokens, true);
        const account = await this.accountState(credentials.accessToken);
        return connectionResult(credentials, account);
    }

    async connect() {
        throw providerError(409, "Utilisez le parcours d’autorisation SUPER PDP.");
    }

    async refreshAuthentication({ credentials }) {
        if (!credentials?.refreshToken) throw providerError(401, "Le jeton de renouvellement SUPER PDP est absent.");
        const tokens = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: credentials.refreshToken });
        const refreshed = tokenCredentials(tokens, true);
        return { credentials: refreshed, tokenExpiresAt: refreshed.expiresAt };
    }

    async disconnect({ credentials }) {
        const token = credentials?.refreshToken || credentials?.accessToken;
        if (!token) return;
        const { clientId, clientSecret } = oauthConfiguration();
        await this.request("/oauth2/revoke", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token, token_type_hint: credentials.refreshToken ? "refresh_token" : "access_token", client_id: clientId, client_secret: clientSecret }).toString()
        }, { authenticated: false, allowEmpty: true });
    }

    async testConnection({ credentials }) {
        const account = await this.accountState(credentials?.accessToken);
        return {
            status: account.connectionStatus,
            message: account.message,
            externalAccountId: account.company?.id ? String(account.company.id) : "",
            externalAccountLabel: account.company?.formal_name || "",
            metadata: account.metadata
        };
    }

    async getAccountInformation({ credentials }) {
        return this.accountState(credentials?.accessToken);
    }

    async sendInvoice(context) {
        return this.sendDocument(context);
    }

    async sendCreditNote(context) {
        return this.sendDocument(context);
    }

    async sendDocument({ document, credentials }) {
        const xml = Buffer.isBuffer(document.structuredData) ? document.structuredData : Buffer.from(document.structuredData);
        if (!xml.length) throw providerError(400, "L’archive UBL est vide.");
        const externalId = `depannhome-${document.id}`.slice(0, 36);
        const invoice = await this.request(`/v1.beta/invoices?external_id=${encodeURIComponent(externalId)}`, {
            method: "POST",
            headers: bearerHeaders(credentials?.accessToken, { "Content-Type": "application/xml" }),
            body: xml
        });
        if (!invoice?.id) throw providerError(502, "SUPER PDP n’a pas retourné de référence de facture.");
        return { externalId: String(invoice.id), status: "sent", externalStatus: "api:uploaded", message: "Document déposé chez SUPER PDP ; traitement asynchrone en cours." };
    }

    async getTransmissionStatus({ externalId, credentials }) {
        const invoice = await this.request(`/v1.beta/invoices/${encodeURIComponent(externalId)}`, { headers: bearerHeaders(credentials?.accessToken) });
        return mapInvoiceStatus(invoice);
    }

    async tokenRequest(parameters, redirectUri) {
        const { clientId, clientSecret } = oauthConfiguration(redirectUri);
        const body = new URLSearchParams({ ...parameters, client_id: clientId, client_secret: clientSecret });
        return this.request("/oauth2/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString()
        }, { authenticated: false });
    }

    async accountState(accessToken) {
        const session = await this.request("/v1.beta/oauth2_sessions/me", { headers: bearerHeaders(accessToken) });
        const verification = session?.company_verification_status || "needs_review";
        const metadata = {
            authenticationType: "oauth2_authorization_code",
            companyVerificationStatus: verification,
            userIdentityVerificationStatus: session?.user_identity_verification_status || ""
        };
        if (verification === "failed") return { connectionStatus: "invalid", message: "SUPER PDP a refusé l’autorisation de cette entreprise.", metadata, session };
        if (verification !== "verified") return { connectionStatus: "action_required", message: "SUPER PDP vérifie encore l’autorisation de l’entreprise.", metadata, session };
        const company = await this.request("/v1.beta/companies/me", { headers: bearerHeaders(accessToken) });
        return { connectionStatus: "connected", message: "Connexion SUPER PDP vérifiée.", metadata: { ...metadata, companyEnvironment: company?.env || "" }, session, company };
    }

    async request(path, options = {}, { authenticated = true, allowEmpty = false } = {}) {
        if (authenticated && !String(options.headers?.Authorization || "").startsWith("Bearer ")) throw providerError(401, "Le jeton d’accès SUPER PDP est absent.");
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);
        let response;
        try {
            response = await this.fetchImplementation(new URL(path, API_ORIGIN), { ...options, signal: controller.signal });
        } catch (error) {
            if (error?.name === "AbortError") throw providerError(408, "SUPER PDP n’a pas répondu dans le délai prévu.");
            throw providerError(502, "Communication impossible avec SUPER PDP.");
        } finally {
            clearTimeout(timeout);
        }
        const text = await response.text();
        const payload = text ? parseJson(text) : null;
        if (!response.ok) {
            const message = payload?.message || payload?.error_description || payload?.error || `Erreur HTTP ${response.status}`;
            throw providerError(response.status, `SUPER PDP : ${String(message).slice(0, 400)}`);
        }
        if (!text && allowEmpty) return null;
        if (payload === null) throw providerError(502, "Réponse SUPER PDP illisible.");
        return payload;
    }
}

export function mapInvoiceStatus(invoice) {
    const events = Array.isArray(invoice?.events) ? [...invoice.events].sort((left, right) => Number(left?.id || 0) - Number(right?.id || 0)) : [];
    const codes = events.map(event => String(event?.status_code || "")).filter(Boolean);
    const latest = events.at(-1);
    const externalStatus = String(latest?.status_code || "api:uploaded").slice(0, 80);
    const details = Array.isArray(latest?.details) ? latest.details : [];
    const reasons = details.flatMap(detail => [detail?.reason, ...(Array.isArray(detail?.notes) ? detail.notes.flatMap(note => Array.isArray(note?.contents) ? note.contents.map(content => content?.content) : []) : [])]).filter(Boolean);
    const status = codes.some(code => FAILURE_STATUSES.has(code) || code.endsWith("-ack-error") || code.endsWith("-rejected")) ? "rejected"
        : codes.some(code => ACCEPTED_STATUSES.has(code)) ? "accepted" : "sent";
    const message = [latest?.status_text, ...reasons].filter(Boolean).join(" · ").slice(0, 1000)
        || (status === "accepted" ? "Facture acceptée par SUPER PDP." : status === "rejected" ? "Facture rejetée pendant son traitement." : "Traitement asynchrone en cours chez SUPER PDP.");
    return { status, externalStatus, message };
}

function connectionResult(credentials, account) {
    return {
        credentials,
        tokenExpiresAt: credentials.expiresAt,
        status: account.connectionStatus,
        message: account.message,
        externalAccountId: account.company?.id ? String(account.company.id) : "",
        externalAccountLabel: account.company?.formal_name || "",
        metadata: account.metadata,
        refreshMetadata: { rotatedAt: new Date().toISOString() }
    };
}

function tokenCredentials(tokens, requireRefreshToken) {
    const accessToken = String(tokens?.access_token || "");
    const refreshToken = String(tokens?.refresh_token || "");
    if (!accessToken || (requireRefreshToken && !refreshToken)) throw providerError(502, "La réponse OAuth SUPER PDP ne contient pas les jetons attendus.");
    const expiresIn = Math.max(1, Number(tokens?.expires_in) || 1800);
    return { accessToken, refreshToken, tokenType: String(tokens?.token_type || "Bearer"), expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() };
}

function oauthConfiguration(redirectUri) {
    const clientId = String(process.env.SUPERPDP_CLIENT_ID || "").trim();
    const clientSecret = String(process.env.SUPERPDP_CLIENT_SECRET || "").trim();
    if (!clientId || !clientSecret) throw providerError(503, "L’application OAuth SUPER PDP n’est pas configurée sur le serveur.");
    if (redirectUri !== undefined) {
        const configured = String(process.env.SUPERPDP_REDIRECT_URI || "").trim();
        if (!configured || configured !== redirectUri) throw providerError(503, "L’URL de retour SUPER PDP n’est pas configurée exactement.");
        let url;
        try { url = new URL(configured); } catch { throw providerError(503, "L’URL de retour SUPER PDP est invalide."); }
        if (process.env.NODE_ENV === "production" && url.protocol !== "https:") throw providerError(503, "Le callback SUPER PDP doit utiliser HTTPS en production.");
    }
    return { clientId, clientSecret };
}

function bearerHeaders(accessToken, headers = {}) {
    if (!accessToken) return headers;
    return { ...headers, Authorization: `Bearer ${accessToken}` };
}
function parseJson(value) { try { return JSON.parse(value); } catch { return null; } }
function providerError(status, publicMessage) { const error = new Error(publicMessage); error.status = status; error.publicMessage = publicMessage; return error; }
export function createPkceChallenge(verifier) { return crypto.createHash("sha256").update(verifier).digest("base64url"); }

export const superPdpProvider = registerElectronicInvoicingProvider(new SuperPdpProvider());
