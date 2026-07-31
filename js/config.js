export const APP_VERSION = "1.15.3 Facture depuis devis";
export const DATA_VERSION = "2026-07-20-35";

export const STORAGE_KEYS = {
    favorites: "depannHomePro:favorites",
    history: "depannHomePro:history",
    clients: "depannHomePro:clients"
};

export const DEFAULT_SETTINGS = {
    theme: "light", // or 'dark'
    maxHistory: 20,
    showOfflineBadge: true
};

// font: one of 'system', 'arial', 'georgia', 'courier'
// lang: 'fr' or 'en'
export const FONT_OPTIONS = [
    { id: "system", label: "Système", css: "" },
    { id: "arial", label: "Arial / Sans-serif", css: "Arial, Helvetica, sans-serif" },
    { id: "georgia", label: "Georgia / Serif", css: "Georgia, 'Times New Roman', serif" },
    { id: "courier", label: "Courier New / Monospace", css: "'Courier New', Courier, monospace" }
];

export const LANG_OPTIONS = [
    { id: "fr", label: "Français" },
    { id: "en", label: "English" }
];

export const DEFAULT_LANGUAGE = "fr";

DEFAULT_SETTINGS.font = "system";
DEFAULT_SETTINGS.lang = DEFAULT_LANGUAGE;

export const SETTINGS_KEY = "depannHomePro:settings";

export const ROUTES = {
    home: "home",
    search: "search",
    store: "store",
    photo: "photo",
    clients: "clients",
    billing: "billing",
    accounting: "accounting",
    accountingSandbox: "accounting-sandbox",
    groups: "groups",
    partnerMissions: "partner-missions",
    partnerSandbox: "partner-sandbox",
    purchases: "purchases",
    technicalReports: "technical-reports",
        messages: "messages",
    calendar: "calendar",
    library: "library",
    favorites: "favorites",
    history: "history",
    settings: "settings",
    creator: "creator"
};

const ADMINISTRATORS = ["admin"];
const OPERATIONAL_PC = ["admin", "pc_standard"];
const OPERATIONAL_MOBILE = ["admin", "pc_standard", "mobile_admin"];
const TERRAIN = ["admin", "pc_standard", "mobile_admin", "team_lead", "technician"];

// Toute nouvelle entrée de navigation doit être déclarée ici. Les éléments
// hors rôle sont retirés du DOM avant l’affichage de l’application.
export const MENU_ACCESS = Object.freeze({
    quick: Object.freeze({
        clients: OPERATIONAL_MOBILE,
        calendar: TERRAIN,
        library: TERRAIN,
        billing: OPERATIONAL_MOBILE.concat("accountant"),
        accounting: ADMINISTRATORS,
        groups: ADMINISTRATORS,
        partnerMissions: OPERATIONAL_PC,
        partnerSandbox: ADMINISTRATORS,
        purchases: OPERATIONAL_PC.concat("accountant"),
        photo: OPERATIONAL_MOBILE,
        favorites: OPERATIONAL_MOBILE,
        history: OPERATIONAL_MOBILE,
        settings: ADMINISTRATORS
    }),
    navigation: Object.freeze({
        [ROUTES.home]: OPERATIONAL_MOBILE,
        [ROUTES.search]: OPERATIONAL_MOBILE,
        [ROUTES.store]: OPERATIONAL_MOBILE,
        [ROUTES.photo]: OPERATIONAL_MOBILE,
        [ROUTES.clients]: OPERATIONAL_MOBILE,
        [ROUTES.billing]: OPERATIONAL_MOBILE.concat("accountant"),
        [ROUTES.accounting]: ADMINISTRATORS,
        [ROUTES.accountingSandbox]: ADMINISTRATORS,
        [ROUTES.groups]: ADMINISTRATORS,
        [ROUTES.partnerMissions]: OPERATIONAL_PC,
        [ROUTES.partnerSandbox]: ADMINISTRATORS,
        [ROUTES.purchases]: OPERATIONAL_PC.concat("accountant"),
        [ROUTES.technicalReports]: TERRAIN,
        [ROUTES.calendar]: TERRAIN,
        [ROUTES.library]: TERRAIN,
        [ROUTES.favorites]: OPERATIONAL_MOBILE,
        [ROUTES.history]: OPERATIONAL_MOBILE,
        [ROUTES.settings]: ADMINISTRATORS
    })
});
