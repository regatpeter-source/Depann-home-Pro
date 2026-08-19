export const SUBSCRIPTION_TIERS = Object.freeze(["basic", "basic_plus", "pro"]);

export const SUBSCRIPTION_TIER_CONFIG = Object.freeze({
    basic: Object.freeze({
        label: "Basic",
        pcRateCents: 2000,
        mobileRateCents: 500,
        description: "Clients, facturation, comptabilité, facturation électronique et PDP",
        features: Object.freeze({ clients: true, calendar: false, library: false, billing: true, accounting: true, technicalReports: false, partnerMissions: false, partnerConnections: false, messages: true, settings: true, imports: false, groups: false, purchases: false, connectors: false, photo: false, favorites: false })
    }),
    basic_plus: Object.freeze({
        label: "Basic+",
        pcRateCents: 3500,
        mobileRateCents: 800,
        description: "Basic avec planning et gestion des interventions",
        features: Object.freeze({ clients: true, calendar: true, library: false, billing: true, accounting: true, technicalReports: false, partnerMissions: false, partnerConnections: false, messages: true, settings: true, imports: false, groups: false, purchases: false, connectors: false, photo: false, favorites: false })
    }),
    pro: Object.freeze({
        label: "Pro",
        pcRateCents: 7000,
        mobileRateCents: 1500,
        description: "Accès complet à Depann’Home Pro, au Réseau et aux connexions API",
        features: Object.freeze({ clients: true, calendar: true, library: true, billing: true, accounting: true, technicalReports: true, partnerMissions: true, partnerConnections: true, messages: true, settings: true, imports: true, groups: true, purchases: true, connectors: true, photo: true, favorites: true })
    })
});

export function normalizeSubscriptionTier(value, fallback = "pro") {
    return SUBSCRIPTION_TIERS.includes(value) ? value : fallback;
}

export function subscriptionTierConfig(value) {
    return SUBSCRIPTION_TIER_CONFIG[normalizeSubscriptionTier(value)];
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
