export const SUBSCRIPTION_TIERS = Object.freeze(["basic", "basic_plus", "pro"]);
const PC_ROLES = Object.freeze(["admin", "pc_standard", "accountant"]);
const ALL_MOBILE_ROLES = Object.freeze(["mobile_admin", "team_lead", "technician"]);

export const SUBSCRIPTION_TIER_CONFIG = Object.freeze({
    basic: Object.freeze({
        label: "Basic",
        pcRateCents: 2000,
        mobileRateCents: 500,
        description: "Postes PC et Administrateur Mobile avec clients, facturation, comptabilité, facturation électronique et PDP",
        allowedRoles: Object.freeze([...PC_ROLES, "mobile_admin"]),
        features: Object.freeze({ clients: true, calendar: false, library: false, billing: true, accounting: true, quitus: false, technicalReports: false, partnerMissions: false, partnerConnections: false, messages: true, settings: true, imports: false, groups: false, purchases: false, connectors: false, photo: false, favorites: false })
    }),
    basic_plus: Object.freeze({
        label: "Basic+",
        pcRateCents: 3500,
        mobileRateCents: 800,
        description: "Tous postes PC et mobiles avec planning et gestion des interventions",
        allowedRoles: Object.freeze([...PC_ROLES, ...ALL_MOBILE_ROLES]),
        features: Object.freeze({ clients: true, calendar: true, library: false, billing: true, accounting: true, quitus: false, technicalReports: false, partnerMissions: false, partnerConnections: false, messages: true, settings: true, imports: false, groups: false, purchases: false, connectors: false, photo: false, favorites: false })
    }),
    pro: Object.freeze({
        label: "Pro",
        pcRateCents: 7000,
        mobileRateCents: 1500,
        description: "Tous postes PC et mobiles avec accès complet à Depann’Home Pro, au Réseau et aux connexions API",
        allowedRoles: Object.freeze([...PC_ROLES, ...ALL_MOBILE_ROLES]),
        features: Object.freeze({ clients: true, calendar: true, library: true, billing: true, accounting: true, quitus: true, technicalReports: true, partnerMissions: true, partnerConnections: true, messages: true, settings: true, imports: true, groups: true, purchases: true, connectors: true, photo: true, favorites: true })
    })
});

export function normalizeSubscriptionTier(value, fallback = "pro") {
    return SUBSCRIPTION_TIERS.includes(value) ? value : fallback;
}

export function subscriptionTierConfig(value) {
    return SUBSCRIPTION_TIER_CONFIG[normalizeSubscriptionTier(value)];
}

export function isRoleAllowedForSubscription(tier, role) {
    return subscriptionTierConfig(tier).allowedRoles.includes(role);
}

export function subscriptionRoleAccessMessage(tier, role) {
    if (isRoleAllowedForSubscription(tier, role)) return "";
    return normalizeSubscriptionTier(tier) === "basic"
        ? "L’offre Basic autorise les postes PC et le poste Administrateur Mobile uniquement. Passez à Basic+ pour activer les techniciens et chefs d’équipe mobiles."
        : "Ce type de poste n’est pas inclus dans l’offre de l’entreprise.";
}

export function calculateSubscriptionPriceCents(tier, pcSeats, mobileSeats) {
    const config = subscriptionTierConfig(tier);
    const pc = safeSeats(pcSeats, 1);
    const mobile = safeSeats(mobileSeats, 0);
    return pc * config.pcRateCents + mobile * config.mobileRateCents;
}

function safeSeats(value, fallback) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}
