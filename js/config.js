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
const CALENDAR_USERS = TERRAIN.concat("accountant");
const PARTNER_MISSION_USERS = OPERATIONAL_MOBILE;
const LIBRARY_USERS = ["mobile_admin", "team_lead", "technician"];

// Toute nouvelle entrée de navigation doit être déclarée ici. Les éléments
// hors rôle sont retirés du DOM avant l’affichage de l’application.
export const MENU_ACCESS = Object.freeze({
    quick: Object.freeze({
        clients: OPERATIONAL_MOBILE,
        calendar: CALENDAR_USERS,
        library: LIBRARY_USERS,
        billing: OPERATIONAL_MOBILE.concat("accountant"),
        accounting: ADMINISTRATORS,
        groups: ADMINISTRATORS,
        partnerMissions: PARTNER_MISSION_USERS,
        partnerSandbox: ADMINISTRATORS,
        photo: OPERATIONAL_MOBILE,
        favorites: OPERATIONAL_MOBILE,
        settings: OPERATIONAL_PC
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
        [ROUTES.partnerMissions]: PARTNER_MISSION_USERS,
        [ROUTES.partnerSandbox]: ADMINISTRATORS,
        [ROUTES.technicalReports]: TERRAIN,
        [ROUTES.calendar]: CALENDAR_USERS,
        [ROUTES.library]: LIBRARY_USERS,
        [ROUTES.favorites]: OPERATIONAL_MOBILE,
        [ROUTES.settings]: OPERATIONAL_PC
    })
});
