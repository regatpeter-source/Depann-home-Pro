import { getPool } from "./database.js";

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
    await database.query("ALTER TABLE depannhome_partner_requests ADD COLUMN IF NOT EXISTS official_partner_id BIGINT REFERENCES depannhome_official_partners(id) ON DELETE SET NULL");
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_partner_requests_status_created_idx ON depannhome_partner_requests(status, created_at DESC)");
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_official_partners_status_idx ON depannhome_official_partners(status, created_at DESC)");
}

export function registerPartnerRequestRoutes(app, requireCreator) {
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
