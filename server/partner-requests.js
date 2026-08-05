import { getPool } from "./database.js";
import crypto from "node:crypto";
import { getAccountOwnerId } from "./auth.js";

const ORGANIZATION_TYPES = new Set([
    "insurance",
    "assistance_company",
    "expert",
    "claims_manager",
    "local_authority",
    "landlord",
    "franchise_network",
    "private_company",
    "other"
]);
const REQUEST_STATUSES = new Set(["new", "under_review", "contacted", "accepted", "refused"]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PARTNER_TYPES = new Set(["depannhome_company", "credentials", "oauth"]);
const CONNECTOR_STATUSES = new Set(["development", "beta", "available", "disabled"]);
export async function initializePartnerRequests() {
    const database = getPool();
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_official_partners (
            id BIGSERIAL PRIMARY KEY,
            request_id BIGINT UNIQUE,
            company_name VARCHAR(160) NOT NULL,
            organization_type VARCHAR(40) NOT NULL,
            contact_name VARCHAR(100) NOT NULL DEFAULT '',
            contact_role VARCHAR(100) NOT NULL DEFAULT '',
            email VARCHAR(160) NOT NULL DEFAULT '',
            phone VARCHAR(50) NOT NULL DEFAULT '',
            website VARCHAR(500) NOT NULL DEFAULT '',
            status VARCHAR(30) NOT NULL DEFAULT 'pending_setup',
            permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
            connector_config JSONB NOT NULL DEFAULT '{}'::jsonb,
            partner_account_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT depannhome_official_partners_status_check CHECK (status IN ('pending_setup', 'active', 'inactive'))
        )
    `);
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_partner_requests (
            id BIGSERIAL PRIMARY KEY,
            company_name VARCHAR(160) NOT NULL,
            organization_type VARCHAR(40) NOT NULL,
            contact_name VARCHAR(100) NOT NULL,
            contact_role VARCHAR(100) NOT NULL,
            email VARCHAR(160) NOT NULL,
            phone VARCHAR(50) NOT NULL,
            website VARCHAR(500) NOT NULL DEFAULT '',
            message VARCHAR(4000) NOT NULL,
            status VARCHAR(30) NOT NULL DEFAULT 'new',
            administrative_notes VARCHAR(4000) NOT NULL DEFAULT '',
            official_partner_id BIGINT REFERENCES depannhome_official_partners(id) ON DELETE SET NULL,
            submitted_ip VARCHAR(100) NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT depannhome_partner_requests_status_check CHECK (status IN ('new', 'under_review', 'contacted', 'accepted', 'refused'))
        )
    `);
    await database.query("ALTER TABLE depannhome_official_partners ADD COLUMN IF NOT EXISTS request_id BIGINT UNIQUE");
    await database.query(`ALTER TABLE depannhome_official_partners
        ADD COLUMN IF NOT EXISTS partner_type VARCHAR(30) NOT NULL DEFAULT 'credentials',
        ADD COLUMN IF NOT EXISTS logo_url VARCHAR(1000) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS description VARCHAR(2000) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS activity_category VARCHAR(160) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS api_url VARCHAR(1000) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS documentation_url VARCHAR(1000) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS sandbox_url VARCHAR(1000) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS connector_state VARCHAR(30) NOT NULL DEFAULT 'development',
        ADD COLUMN IF NOT EXISTS connector_secret_ciphertext TEXT NOT NULL DEFAULT ''`);
    await database.query("ALTER TABLE depannhome_official_partners DROP CONSTRAINT IF EXISTS depannhome_official_partners_partner_type_check");
    await database.query("ALTER TABLE depannhome_official_partners ADD CONSTRAINT depannhome_official_partners_partner_type_check CHECK (partner_type IN ('depannhome_company','credentials','oauth'))");
    await database.query("ALTER TABLE depannhome_official_partners DROP CONSTRAINT IF EXISTS depannhome_official_partners_connector_state_check");
    await database.query("ALTER TABLE depannhome_official_partners ADD CONSTRAINT depannhome_official_partners_connector_state_check CHECK (connector_state IN ('development','beta','available','disabled'))");
    await database.query(`CREATE TABLE IF NOT EXISTS depannhome_official_partner_connections (
        id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
        official_partner_id BIGINT NOT NULL REFERENCES depannhome_official_partners(id) ON DELETE CASCADE,
        status VARCHAR(30) NOT NULL DEFAULT 'connected', credentials_ciphertext TEXT NOT NULL DEFAULT '',
        connected_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
        connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT depannhome_official_partner_connections_unique UNIQUE(owner_id, official_partner_id),
        CONSTRAINT depannhome_official_partner_connections_status_check CHECK (status IN ('connected', 'disconnected'))
    )`);
    await database.query(`CREATE TABLE IF NOT EXISTS depannhome_official_partner_oauth_states (
        state VARCHAR(128) PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
        official_partner_id BIGINT NOT NULL REFERENCES depannhome_official_partners(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await database.query("ALTER TABLE depannhome_partner_requests ADD COLUMN IF NOT EXISTS official_partner_id BIGINT REFERENCES depannhome_official_partners(id) ON DELETE SET NULL");
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_partner_requests_status_created_idx ON depannhome_partner_requests(status, created_at DESC)");
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_official_partners_status_idx ON depannhome_official_partners(status, created_at DESC)");
}

export function registerPartnerRequestRoutes(app, requireCreator, requireAuthentication) {
    app.post("/api/partner-requests", asyncHandler(async (request, response) => {
        const partnerRequest = sanitizeRequest(request.body);
        if (!partnerRequest.ok) return response.status(400).json({ message: partnerRequest.message });
        const { rows } = await getPool().query(`
            INSERT INTO depannhome_partner_requests (company_name, organization_type, contact_name, contact_role, email, phone, website, message, submitted_ip)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            RETURNING id
        `, [partnerRequest.companyName, partnerRequest.organizationType, partnerRequest.contactName, partnerRequest.contactRole, partnerRequest.email, partnerRequest.phone, partnerRequest.website, partnerRequest.message, clientIp(request)]);
        response.status(201).json({ id: String(rows[0].id), message: "Merci pour votre demande de partenariat. Notre équipe va étudier votre demande et vous recontactera dans les meilleurs délais." });
    }));

    app.use("/api/creator/partner-requests", requireCreator);
    app.get("/api/creator/partner-requests", asyncHandler(async (_request, response) => {
        const { rows } = await getPool().query(`
            SELECT id, company_name AS "companyName", organization_type AS "organizationType", contact_name AS "contactName",
                contact_role AS "contactRole", email, phone, website, message, status,
                administrative_notes AS "administrativeNotes", official_partner_id AS "officialPartnerId",
                created_at AS "createdAt", updated_at AS "updatedAt"
            FROM depannhome_partner_requests
            ORDER BY created_at DESC, id DESC
        `);
        response.json({ requests: rows });
    }));
    app.get("/api/creator/partner-requests/:requestId", asyncHandler(async (request, response) => {
        const partnerRequest = await findRequest(positiveId(request.params.requestId));
        if (!partnerRequest) return response.status(404).json({ message: "Demande de partenariat introuvable." });
        response.json({ request: partnerRequest });
    }));
    app.patch("/api/creator/partner-requests/:requestId", asyncHandler(async (request, response) => {
        const id = positiveId(request.params.requestId);
        const existing = id && await findRequest(id);
        if (!existing) return response.status(404).json({ message: "Demande de partenariat introuvable." });
        const status = REQUEST_STATUSES.has(request.body?.status) ? request.body.status : existing.status;
        const notes = cleanText(request.body?.administrativeNotes, 4000);
        const database = getPool();
        const connection = await database.connect();
        try {
            await connection.query("BEGIN");
            let officialPartnerId = existing.officialPartnerId;
            if (status === "accepted" && !officialPartnerId) {
                const { rows } = await connection.query(`
                    INSERT INTO depannhome_official_partners (request_id, company_name, organization_type, contact_name, contact_role, email, phone, website)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                    RETURNING id
                `, [existing.id, existing.companyName, existing.organizationType, existing.contactName, existing.contactRole, existing.email, existing.phone, existing.website]);
                officialPartnerId = rows[0].id;
            }
            const { rows } = await connection.query(`
                UPDATE depannhome_partner_requests
                SET status=$2, administrative_notes=$3, official_partner_id=$4, updated_at=NOW()
                WHERE id=$1
                RETURNING id, company_name AS "companyName", organization_type AS "organizationType", contact_name AS "contactName",
                    contact_role AS "contactRole", email, phone, website, message, status,
                    administrative_notes AS "administrativeNotes", official_partner_id AS "officialPartnerId", created_at AS "createdAt", updated_at AS "updatedAt"
            `, [id, status, notes, officialPartnerId]);
            await connection.query("COMMIT");
            response.json({ request: rows[0] });
        } catch (error) {
            await connection.query("ROLLBACK");
            throw error;
        } finally {
            connection.release();
        }
    }));
    app.delete("/api/creator/partner-requests/:requestId", asyncHandler(async (request, response) => {
        const result = await getPool().query("DELETE FROM depannhome_partner_requests WHERE id=$1", [positiveId(request.params.requestId)]);
        if (!result.rowCount) return response.status(404).json({ message: "Demande de partenariat introuvable." });
        response.status(204).end();
    }));

    app.get("/api/creator/official-partners", requireCreator, asyncHandler(async (_request, response) => {
        response.json({ partners: await officialPartners(true) });
    }));
    app.post("/api/creator/official-partners", requireCreator, asyncHandler(async (request, response) => {
        const partner = sanitizeOfficialPartner(request.body);
        if (!partner.ok) return response.status(400).json({ message: partner.message });
        const { rows } = await getPool().query(`INSERT INTO depannhome_official_partners
            (company_name,organization_type,website,partner_type,logo_url,description,activity_category,api_url,documentation_url,sandbox_url,connector_state,connector_config,connector_secret_ciphertext,status)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,'active') RETURNING id`,
        [partner.name, partner.organizationType, partner.website, partner.type, partner.logoUrl, partner.description, partner.activityCategory, partner.apiUrl, partner.documentationUrl, partner.sandboxUrl, partner.connectorState, JSON.stringify(partner.config), encryptSecret(partner.secret)]);
        response.status(201).json({ id: String(rows[0].id) });
    }));
    app.patch("/api/creator/official-partners/:partnerId", requireCreator, asyncHandler(async (request, response) => {
        const id = positiveId(request.params.partnerId); const existing = id && await officialPartner(id, true);
        if (!existing) return response.status(404).json({ message: "Partenaire officiel introuvable." });
        const partner = sanitizeOfficialPartner(request.body, existing);
        if (!partner.ok) return response.status(400).json({ message: partner.message });
        await getPool().query(`UPDATE depannhome_official_partners SET company_name=$2,organization_type=$3,website=$4,partner_type=$5,logo_url=$6,description=$7,activity_category=$8,api_url=$9,documentation_url=$10,sandbox_url=$11,connector_state=$12,connector_config=$13::jsonb,connector_secret_ciphertext=$14,status=$15,updated_at=NOW() WHERE id=$1`,
            [id, partner.name, partner.organizationType, partner.website, partner.type, partner.logoUrl, partner.description, partner.activityCategory, partner.apiUrl, partner.documentationUrl, partner.sandboxUrl, partner.connectorState, JSON.stringify(partner.config), partner.secret ? encryptSecret(partner.secret) : existing.connectorSecretCiphertext, partner.connectorState === "disabled" ? "inactive" : "active"]);
        response.status(204).end();
    }));
    app.delete("/api/creator/official-partners/:partnerId", requireCreator, asyncHandler(async (request, response) => {
        const result = await getPool().query("DELETE FROM depannhome_official_partners WHERE id=$1 AND request_id IS NULL", [positiveId(request.params.partnerId)]);
        if (!result.rowCount) return response.status(404).json({ message: "Partenaire officiel introuvable ou issu d’une demande à conserver." });
        response.status(204).end();
    }));

    app.use("/api/official-partners", requireAuthentication, requireAdministration);
    app.get("/api/official-partners", asyncHandler(async (request, response) => {
        response.json({ partners: (await officialPartners()).filter(partner => partner.connectorState !== "disabled" && partner.partnerType !== "depannhome_company"), connections: await companyConnections(getAccountOwnerId(request)) });
    }));
    app.post("/api/official-partners/:partnerId/connect", asyncHandler(async (request, response) => {
        const partner = await officialPartner(positiveId(request.params.partnerId), true);
        if (!partner || partner.status !== "active" || partner.connectorState !== "available") return response.status(409).json({ message: "Ce connecteur n’est pas disponible." });
        if (partner.partnerType !== "credentials") return response.status(400).json({ message: "Utilisez l’autorisation sécurisée proposée pour ce partenaire." });
        const credentials = sanitizeCredentials(request.body?.credentials, partner.connectorConfig?.credentialFields || []);
        if (!credentials.ok) return response.status(400).json({ message: credentials.message });
        await saveCompanyConnection(getAccountOwnerId(request), partner.id, credentials.values, request.user.sub);
        response.json({ message: `Connexion avec ${partner.companyName} établie.` });
    }));
    app.post("/api/official-partners/:partnerId/oauth/start", asyncHandler(async (request, response) => {
        const partner = await officialPartner(positiveId(request.params.partnerId), true);
        if (!partner || partner.partnerType !== "oauth" || partner.status !== "active" || partner.connectorState !== "available") return response.status(409).json({ message: "Cette autorisation sécurisée n’est pas disponible." });
        const authorizationUrl = safeUrl(partner.connectorConfig?.authorizationUrl);
        if (!authorizationUrl) return response.status(409).json({ message: "L’autorisation officielle de ce partenaire n’est pas encore configurée." });
        const state = crypto.randomBytes(32).toString("base64url"); const ownerId = getAccountOwnerId(request);
        await getPool().query("DELETE FROM depannhome_official_partner_oauth_states WHERE expires_at<NOW() OR (owner_id=$1 AND official_partner_id=$2)", [ownerId, partner.id]);
        await getPool().query("INSERT INTO depannhome_official_partner_oauth_states(state,owner_id,official_partner_id,expires_at) VALUES($1,$2,$3,NOW()+INTERVAL '10 minutes')", [state, ownerId, partner.id]);
        const url = new URL(authorizationUrl); url.searchParams.set("response_type", "code"); url.searchParams.set("client_id", String(partner.connectorConfig?.clientId || "")); url.searchParams.set("redirect_uri", `${request.protocol}://${request.get("host")}/api/official-partners/oauth/callback`); url.searchParams.set("state", state); if (partner.connectorConfig?.scope) url.searchParams.set("scope", partner.connectorConfig.scope);
        response.json({ authorizationUrl: url.toString() });
    }));
    app.get("/api/official-partners/oauth/callback", asyncHandler(async (request, response) => {
        const state = cleanText(request.query?.state, 128); const code = cleanText(request.query?.code, 4000);
        const { rows } = await getPool().query(`SELECT oauth.*,partner.company_name AS "companyName",partner.connector_config AS "connectorConfig",partner.connector_secret_ciphertext AS "connectorSecretCiphertext" FROM depannhome_official_partner_oauth_states oauth JOIN depannhome_official_partners partner ON partner.id=oauth.official_partner_id WHERE oauth.state=$1 AND oauth.expires_at>NOW()`, [state]);
        const pending = rows[0]; if (!pending || !code) return response.status(400).send("Autorisation partenaire invalide ou expirée. Vous pouvez fermer cette fenêtre.");
        const tokens = await exchangeAuthorizationCode(pending, code, `${request.protocol}://${request.get("host")}/api/official-partners/oauth/callback`);
        await saveCompanyConnection(pending.owner_id, pending.official_partner_id, tokens, request.user?.sub || null);
        await getPool().query("DELETE FROM depannhome_official_partner_oauth_states WHERE state=$1", [state]);
        response.type("html").send("<!doctype html><title>Connexion établie</title><p>La connexion partenaire est établie. Vous pouvez fermer cette fenêtre et revenir à Depann’Home Pro.</p><script>window.close()</script>");
    }));
    app.post("/api/official-partners/:partnerId/disconnect", asyncHandler(async (request, response) => {
        const result = await getPool().query("UPDATE depannhome_official_partner_connections SET status='disconnected',updated_at=NOW() WHERE owner_id=$1 AND official_partner_id=$2", [getAccountOwnerId(request), positiveId(request.params.partnerId)]);
        if (!result.rowCount) return response.status(404).json({ message: "Connexion partenaire introuvable." });
        response.status(204).end();
    }));
}

async function findRequest(id) {
    if (!id) return null;
    const { rows } = await getPool().query(`
        SELECT id, company_name AS "companyName", organization_type AS "organizationType", contact_name AS "contactName",
            contact_role AS "contactRole", email, phone, website, message, status,
            administrative_notes AS "administrativeNotes", official_partner_id AS "officialPartnerId",
            created_at AS "createdAt", updated_at AS "updatedAt"
        FROM depannhome_partner_requests WHERE id=$1
    `, [id]);
    return rows[0] || null;
}

function sanitizeRequest(value) {
    const companyName = cleanText(value?.companyName, 160);
    const organizationType = ORGANIZATION_TYPES.has(value?.organizationType) ? value.organizationType : "";
    const contactName = cleanText(value?.contactName, 100);
    const contactRole = cleanText(value?.contactRole, 100);
    const email = cleanText(value?.email, 160).toLowerCase();
    const phone = cleanText(value?.phone, 50);
    const website = cleanWebsite(value?.website);
    const message = cleanText(value?.message, 4000);
    if (!companyName || !organizationType || !contactName || !contactRole || !phone) return { ok: false, message: "Renseignez toutes les informations obligatoires." };
    if (!EMAIL_PATTERN.test(email)) return { ok: false, message: "Saisissez une adresse e-mail valide." };
    if (message.length < 10) return { ok: false, message: "Décrivez votre projet ou besoin en au moins 10 caractères." };
    if (value?.website && !website) return { ok: false, message: "Le site internet doit être une adresse web valide." };
    return { ok: true, companyName, organizationType, contactName, contactRole, email, phone, website, message };
}

async function officialPartners(includeSetup = false) {
    const { rows } = await getPool().query(`SELECT id,company_name AS "companyName",organization_type AS "organizationType",website,status,
        partner_type AS "partnerType",logo_url AS "logoUrl",description,activity_category AS "activityCategory",api_url AS "apiUrl",
        documentation_url AS "documentationUrl",sandbox_url AS "sandboxUrl",connector_state AS "connectorState",connector_config AS "connectorConfig",
        connector_secret_ciphertext AS "connectorSecretCiphertext",created_at AS "createdAt",updated_at AS "updatedAt"
        FROM depannhome_official_partners ORDER BY CASE connector_state WHEN 'available' THEN 0 WHEN 'beta' THEN 1 ELSE 2 END,LOWER(company_name)`);
    return rows.map(row => publicOfficialPartner(row, includeSetup));
}

async function officialPartner(id, includeSecret = false) {
    if (!id) return null;
    const { rows } = await getPool().query(`SELECT id,company_name AS "companyName",organization_type AS "organizationType",website,status,
        partner_type AS "partnerType",logo_url AS "logoUrl",description,activity_category AS "activityCategory",api_url AS "apiUrl",
        documentation_url AS "documentationUrl",sandbox_url AS "sandboxUrl",connector_state AS "connectorState",connector_config AS "connectorConfig",
        connector_secret_ciphertext AS "connectorSecretCiphertext",created_at AS "createdAt",updated_at AS "updatedAt"
        FROM depannhome_official_partners WHERE id=$1`, [id]);
    return rows[0] ? (includeSecret ? rows[0] : publicOfficialPartner(rows[0])) : null;
}

async function companyConnections(ownerId) {
    const { rows } = await getPool().query("SELECT official_partner_id AS \"partnerId\",status,connected_at AS \"connectedAt\",updated_at AS \"updatedAt\" FROM depannhome_official_partner_connections WHERE owner_id=$1", [ownerId]);
    return rows;
}

async function saveCompanyConnection(ownerId, partnerId, credentials, connectedBy) {
    await getPool().query(`INSERT INTO depannhome_official_partner_connections(owner_id,official_partner_id,status,credentials_ciphertext,connected_by,connected_at,updated_at)
        VALUES($1,$2,'connected',$3,$4,NOW(),NOW()) ON CONFLICT(owner_id,official_partner_id) DO UPDATE
        SET status='connected',credentials_ciphertext=EXCLUDED.credentials_ciphertext,connected_by=EXCLUDED.connected_by,connected_at=NOW(),updated_at=NOW()`,
    [ownerId, partnerId, encryptSecret(credentials), connectedBy || null]);
}

function publicOfficialPartner(partner, includeSetup = false) {
    const config = partner.connectorConfig && typeof partner.connectorConfig === "object" ? partner.connectorConfig : {};
    return { id: String(partner.id), companyName: partner.companyName, organizationType: partner.organizationType, website: partner.website || "", status: partner.status,
        partnerType: PARTNER_TYPES.has(partner.partnerType) ? partner.partnerType : "credentials", logoUrl: partner.logoUrl || "", description: partner.description || "",
        activityCategory: partner.activityCategory || "", apiUrl: partner.apiUrl || "", documentationUrl: partner.documentationUrl || "", sandboxUrl: partner.sandboxUrl || "",
        connectorState: CONNECTOR_STATUSES.has(partner.connectorState) ? partner.connectorState : "development", connectorConfig: { credentialFields: credentialFields(config.credentialFields), scope: cleanText(config.scope, 500), ...(includeSetup ? { authorizationUrl: safeUrl(config.authorizationUrl), tokenUrl: safeUrl(config.tokenUrl), clientId: cleanText(config.clientId, 500) } : {}) },
        hasConnectorSecret: Boolean(partner.connectorSecretCiphertext), createdAt: partner.createdAt, updatedAt: partner.updatedAt };
}

function sanitizeOfficialPartner(value, existing = null) {
    const type = PARTNER_TYPES.has(value?.partnerType) ? value.partnerType : existing?.partnerType || "credentials";
    const connectorState = CONNECTOR_STATUSES.has(value?.connectorState) ? value.connectorState : existing?.connectorState || "development";
    const name = cleanText(value?.companyName, 160); const organizationType = ORGANIZATION_TYPES.has(value?.organizationType) ? value.organizationType : "other";
    const website = cleanWebsite(value?.website); const logoUrl = safeUrl(value?.logoUrl); const apiUrl = safeUrl(value?.apiUrl); const documentationUrl = safeUrl(value?.documentationUrl); const sandboxUrl = safeUrl(value?.sandboxUrl);
    const existingConfig = existing?.connectorConfig && typeof existing.connectorConfig === "object" ? existing.connectorConfig : {};
    const config = { credentialFields: credentialFields(value?.credentialFields ?? existingConfig.credentialFields), authorizationUrl: safeUrl(value?.authorizationUrl ?? existingConfig.authorizationUrl), tokenUrl: safeUrl(value?.tokenUrl ?? existingConfig.tokenUrl), clientId: cleanText(value?.clientId ?? existingConfig.clientId, 500), scope: cleanText(value?.scope ?? existingConfig.scope, 500) };
    const secret = cleanText(value?.clientSecret, 2000);
    if (!name) return { ok: false, message: "Le nom du partenaire est obligatoire." };
    if ((value?.website && !website) || (value?.logoUrl && !logoUrl) || (value?.apiUrl && !apiUrl) || (value?.documentationUrl && !documentationUrl) || (value?.sandboxUrl && !sandboxUrl)) return { ok: false, message: "Les URL doivent commencer par http:// ou https://." };
    if (type === "credentials" && !config.credentialFields.length) return { ok: false, message: "Indiquez au moins une information de connexion à demander." };
    if (type === "oauth" && connectorState === "available" && (!config.authorizationUrl || !config.tokenUrl || !config.clientId || (!secret && !existing?.connectorSecretCiphertext))) return { ok: false, message: "Une autorisation OAuth disponible requiert les URL d’autorisation et de jeton, ainsi que l’identifiant et le secret client." };
    return { ok: true, name, organizationType, website, type, logoUrl, description: cleanText(value?.description, 2000), activityCategory: cleanText(value?.activityCategory, 160), apiUrl, documentationUrl, sandboxUrl, connectorState, config, secret };
}

function credentialFields(value) {
    const labels = Array.isArray(value) ? value : String(value || "").split(/\r?\n|,/);
    return labels.map((item, index) => {
        const label = cleanText(typeof item === "object" ? item.label : item, 80);
        const key = cleanText(typeof item === "object" ? item.key : "", 40).replace(/[^a-zA-Z0-9_-]/g, "") || `credential${index + 1}`;
        return label ? { key, label, required: typeof item === "object" ? item.required !== false : true, secret: typeof item === "object" ? item.secret !== false : true } : null;
    }).filter(Boolean).slice(0, 8);
}

function sanitizeCredentials(value, fields) {
    const credentials = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const values = {};
    for (const field of credentialFields(fields)) {
        const entry = cleanText(credentials[field.key], 2000);
        if (field.required && !entry) return { ok: false, message: `Renseignez « ${field.label} »` };
        if (entry) values[field.key] = entry;
    }
    return { ok: true, values };
}

async function exchangeAuthorizationCode(pending, code, redirectUri) {
    const config = pending.connectorConfig && typeof pending.connectorConfig === "object" ? pending.connectorConfig : {};
    const tokenUrl = safeUrl(config.tokenUrl); const secret = decryptSecret(pending.connectorSecretCiphertext);
    if (!tokenUrl || !config.clientId || !secret) throw clientError(409, "Le connecteur OAuth n’est pas complètement configuré.");
    const response = await fetch(tokenUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: config.clientId, client_secret: secret }), signal: AbortSignal.timeout(15_000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) throw clientError(502, "Le partenaire a refusé l’autorisation. Réessayez depuis la fiche partenaire.");
    return { accessToken: String(payload.access_token), refreshToken: payload.refresh_token ? String(payload.refresh_token) : "", expiresIn: Number(payload.expires_in) || 0, connectedAt: new Date().toISOString() };
}

function requireAdministration(request, response, next) {
    return request.user?.role === "admin" ? next() : response.status(403).json({ message: "La gestion des partenaires est réservée à l’administration." });
}

function encryptionKey() { return crypto.createHash("sha256").update(String(process.env.SESSION_SECRET || "development-official-partner-key")).digest(); }
function encryptSecret(value) { if (!value || (typeof value === "object" && !Object.keys(value).length)) return ""; const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv); const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]); return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`; }
function decryptSecret(value) { try { const [iv, tag, encrypted] = String(value || "").split(".").map(item => Buffer.from(item, "base64url")); if (!iv?.length || !tag?.length || !encrypted?.length) return ""; const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), iv); decipher.setAuthTag(tag); return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8")); } catch { return ""; } }
function safeUrl(value) { const url = cleanText(value, 1000); if (!url) return ""; try { const parsed = new URL(url); return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : ""; } catch { return ""; } }
function clientError(status, message) { const error = new Error(message); error.status = status; return error; }

function cleanWebsite(value) {
    const website = cleanText(value, 500);
    if (!website) return "";
    try {
        const url = new URL(website.includes("://") ? website : `https://${website}`);
        return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
    } catch {
        return "";
    }
}

function cleanText(value, maximumLength) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximumLength);
}

function positiveId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function clientIp(request) {
    return String(request.ip || request.socket?.remoteAddress || "").slice(0, 100);
}

function asyncHandler(handler) {
    return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}
