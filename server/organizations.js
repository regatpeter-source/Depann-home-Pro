import { getPool } from "./database.js";
import { normalizeSubscriptionTier, subscriptionTierConfig } from "./subscription-tiers.js";

export const INTERFACE_TYPES = Object.freeze(["partner", "standard", "group"]);
export const ORGANIZATION_TYPES = Object.freeze([
    "troubleshooting_company", "leak_detection_company", "locksmith", "plumber", "property_manager",
    "real_estate_agency", "insurance", "expert", "principal", "partner_platform", "other"
]);
export const LICENSE_TYPES = Object.freeze(["partner_portal", "depannhome_standard", "depannhome_group"]);

const ALL_FEATURES = Object.freeze({
    clients: true, calendar: true, library: true, billing: true, accounting: true, quitus: true, technicalReports: true,
    partnerMissions: true, partnerConnections: true, messages: true, settings: true, imports: true, groups: true,
    purchases: true, connectors: true, photo: true
});
const PARTNER_FEATURES = Object.freeze({
    clients: true, calendar: true, library: false, billing: true, accounting: false, quitus: false, technicalReports: false,
    partnerMissions: true, partnerConnections: true, messages: true, settings: true, imports: false, groups: false,
    purchases: false, connectors: false, photo: false
});
const MOBILE_ROLES = Object.freeze(["mobile_admin", "team_lead", "technician"]);

export async function initializeOrganizations() {
    const db = getPool();
    await db.query(`INSERT INTO depannhome_organizations(account_owner_id,interface_type,organization_type,license_type,license_features)
        SELECT id,'standard','troubleshooting_company','depannhome_standard','{}'::jsonb
        FROM depannhome_users WHERE account_owner_id=id
        ON CONFLICT(account_owner_id) DO NOTHING`);
    await db.query("CREATE INDEX IF NOT EXISTS depannhome_organizations_interface_idx ON depannhome_organizations(interface_type,license_type)");
}

export async function getOrganization(ownerId) {
    if (!ownerId) return defaultOrganization();
    const { rows } = await getPool().query(`SELECT organization.id,organization.account_owner_id AS "accountOwnerId",organization.interface_type AS "interfaceType",organization.organization_type AS "organizationType",organization.license_type AS "licenseType",organization.license_features AS "licenseFeatures",owner.subscription_tier AS "subscriptionTier",organization.created_at AS "createdAt",organization.updated_at AS "updatedAt" FROM depannhome_organizations organization JOIN depannhome_users owner ON owner.id=organization.account_owner_id WHERE organization.account_owner_id=$1`, [ownerId]);
    return rows[0] ? publicOrganization(rows[0]) : defaultOrganization(ownerId);
}

export async function createOrganization(ownerId, values = {}, actorId = null) {
    const organization = sanitizeOrganization(values);
    if (!organization.ok) throw organizationError(organization.message);
    const { rows } = await getPool().query(`INSERT INTO depannhome_organizations(account_owner_id,interface_type,organization_type,license_type,license_features)
        VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(account_owner_id) DO UPDATE SET interface_type=EXCLUDED.interface_type,organization_type=EXCLUDED.organization_type,license_type=EXCLUDED.license_type,license_features=EXCLUDED.license_features,updated_at=NOW()
        RETURNING id,account_owner_id AS "accountOwnerId",interface_type AS "interfaceType",organization_type AS "organizationType",license_type AS "licenseType",license_features AS "licenseFeatures",created_at AS "createdAt",updated_at AS "updatedAt"`, [ownerId, organization.interfaceType, organization.organizationType, organization.licenseType, JSON.stringify(organization.licenseFeatures)]);
    const tierResult = await getPool().query("SELECT subscription_tier AS \"subscriptionTier\" FROM depannhome_users WHERE id=$1", [ownerId]);
    const created = publicOrganization({ ...rows[0], subscriptionTier: tierResult.rows[0]?.subscriptionTier });
    if (actorId) await writeOrganizationAudit(ownerId, actorId, "created", {}, auditSnapshot(created));
    return created;
}

export async function updateOrganization(ownerId, values, actorId = null) {
    if (!values || typeof values !== "object") return getOrganization(ownerId);
    const previous = await getOrganization(ownerId);
    const next = await createOrganization(ownerId, {
        interfaceType: values.interfaceType ?? previous.interfaceType,
        organizationType: values.organizationType ?? previous.organizationType,
        licenseType: values.licenseType ?? previous.licenseType,
        licenseFeatures: values.licenseFeatures ?? previous.licenseFeatures
    });
    if (actorId && JSON.stringify(auditSnapshot(previous)) !== JSON.stringify(auditSnapshot(next))) {
        await writeOrganizationAudit(ownerId, actorId, "updated", auditSnapshot(previous), auditSnapshot(next));
    }
    return next;
}

export async function getOrganizationHistory(ownerId) {
    const { rows } = await getPool().query(`
        SELECT audit.id, audit.action, audit.previous_value AS "previousValue", audit.next_value AS "nextValue", audit.created_at AS "createdAt",
            COALESCE(NULLIF(actor.full_name,''), actor.username, 'Système') AS "actorName"
        FROM depannhome_organization_audit audit
        LEFT JOIN depannhome_users actor ON actor.id=audit.actor_id
        WHERE audit.account_owner_id=$1
        ORDER BY audit.created_at DESC, audit.id DESC
        LIMIT 100
    `, [ownerId]);
    return rows;
}

export function requireOrganizationFeature(feature) {
    return async (request, response, next) => {
        try {
            if (request.user?.isCreator) return next();
            const organization = await getOrganization(request.user?.accountOwnerId);
            if (!isFeatureEnabledForRole(organization, feature, request.user?.role)) return response.status(403).json({ message: "Cette fonctionnalité n’est pas incluse dans l’interface de votre organisation." });
            return next();
        } catch (error) {
            return next(error);
        }
    };
}

export function isFeatureEnabledForRole(organization, feature, role) {
    if (feature === "library") return MOBILE_ROLES.includes(role);
    if (feature === "purchases" && !["admin", "pc_standard", "accountant", "mobile_admin"].includes(role)) return false;
    return isFeatureEnabled(organization, feature);
}

export function isFeatureEnabled(organization, feature) {
    if (!feature) return true;
    if (organization?.features && typeof organization.features[feature] === "boolean") return organization.features[feature];
    const defaults = organizationDefaults(organization?.interfaceType, organization?.subscriptionTier);
    const overrides = organization?.licenseFeatures && typeof organization.licenseFeatures === "object" ? organization.licenseFeatures : {};
    if (organization?.interfaceType === "standard") return Boolean(defaults[feature]) && overrides[feature] !== false;
    return typeof overrides[feature] === "boolean" ? overrides[feature] : Boolean(defaults[feature]);
}

export function publicOrganization(row) {
    const interfaceType = INTERFACE_TYPES.includes(row?.interfaceType) ? row.interfaceType : "standard";
    const organizationType = ORGANIZATION_TYPES.includes(row?.organizationType) ? row.organizationType : "other";
    const licenseType = LICENSE_TYPES.includes(row?.licenseType) ? row.licenseType : interfaceType === "partner" ? "partner_portal" : interfaceType === "group" ? "depannhome_group" : "depannhome_standard";
    const licenseFeatures = row?.licenseFeatures && typeof row.licenseFeatures === "object" && !Array.isArray(row.licenseFeatures) ? row.licenseFeatures : {};
    const subscriptionTier = normalizeSubscriptionTier(row?.subscriptionTier, "pro");
    return { id: String(row?.id || ""), accountOwnerId: String(row?.accountOwnerId || ""), interfaceType, organizationType, licenseType, subscriptionTier, licenseFeatures, features: resolvedFeatures(interfaceType, subscriptionTier, licenseFeatures), badge: organizationBadge(interfaceType), createdAt: row?.createdAt || null, updatedAt: row?.updatedAt || null };
}

export function organizationBadge(interfaceType) {
    return ({ standard: "Entreprise Depann’Home Pro", partner: "Partenaire", group: "Groupe" })[interfaceType] || "Organisation";
}

function resolvedFeatures(interfaceType, subscriptionTier, overrides) {
    const defaults = organizationDefaults(interfaceType, subscriptionTier);
    if (interfaceType !== "standard") return { ...defaults, ...overrides };
    return Object.fromEntries(Object.keys(ALL_FEATURES).map(feature => [feature, Boolean(defaults[feature]) && overrides[feature] !== false]));
}

function organizationDefaults(interfaceType, subscriptionTier) {
    if (interfaceType === "partner") return PARTNER_FEATURES;
    if (interfaceType === "group") return ALL_FEATURES;
    return subscriptionTierConfig(subscriptionTier).features;
}

function sanitizeOrganization(values) {
    const interfaceType = INTERFACE_TYPES.includes(values?.interfaceType) ? values.interfaceType : "standard";
    const organizationType = ORGANIZATION_TYPES.includes(values?.organizationType) ? values.organizationType : "troubleshooting_company";
    const expectedLicense = interfaceType === "partner" ? "partner_portal" : interfaceType === "group" ? "depannhome_group" : "depannhome_standard";
    const licenseType = LICENSE_TYPES.includes(values?.licenseType) ? values.licenseType : expectedLicense;
    const rawFeatures = values?.licenseFeatures && typeof values.licenseFeatures === "object" && !Array.isArray(values.licenseFeatures) ? values.licenseFeatures : {};
    const licenseFeatures = Object.fromEntries(Object.entries(rawFeatures).filter(([key, value]) => Object.hasOwn(ALL_FEATURES, key) && typeof value === "boolean"));
    if (interfaceType === "partner" && licenseType !== "partner_portal") return { ok: false, message: "L’interface Partenaire requiert la licence Portail Partenaire." };
    if (interfaceType === "group" && licenseType !== "depannhome_group") return { ok: false, message: "L’interface Groupe requiert la licence Depann’Home Pro Groupe." };
    if (interfaceType === "standard" && licenseType !== "depannhome_standard") return { ok: false, message: "L’interface Standard requiert la licence Depann’Home Pro Standard." };
    return { ok: true, interfaceType, organizationType, licenseType, licenseFeatures };
}

function defaultOrganization(ownerId = "") {
    return publicOrganization({ accountOwnerId: ownerId, interfaceType: "standard", organizationType: "troubleshooting_company", licenseType: "depannhome_standard", subscriptionTier: "pro", licenseFeatures: {} });
}

function auditSnapshot(organization) {
    return { interfaceType: organization.interfaceType, organizationType: organization.organizationType, licenseType: organization.licenseType, licenseFeatures: organization.licenseFeatures };
}

async function writeOrganizationAudit(ownerId, actorId, action, previousValue, nextValue) {
    await getPool().query(`INSERT INTO depannhome_organization_audit(account_owner_id,actor_id,action,previous_value,next_value) VALUES($1,$2,$3,$4::jsonb,$5::jsonb)`, [ownerId, actorId, action, JSON.stringify(previousValue), JSON.stringify(nextValue)]);
}

function organizationError(message) { const error = new Error(message); error.status = 400; return error; }
