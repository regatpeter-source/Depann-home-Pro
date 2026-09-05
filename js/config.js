export const APP_VERSION = "1.16.0 Facturation réelle";
export const DATA_VERSION = "2026-07-20-35";

export const STORAGE_KEYS = {
    history: "depannHomePro:history",
    clients: "depannHomePro:clients"
};

export const DEFAULT_SETTINGS = {
    theme: "light", // or 'dark'
    interfaceDensity: "comfortable",
    reduceMotion: false,
    maxHistory: 20,
    showOfflineBadge: true,
    notifications: {
        partnerNewMission: true,
        partnerMissionUpdates: true,
        appointments: true,
        reports: true,
        billing: true,
        clientMessages: true,
        partnerNetwork: true,
        system: true
    }
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
    clients: "clients",
    billing: "billing",
    accounting: "accounting",
    groups: "groups",
    partnerMissions: "partner-missions",
    companyEmail: "company-email",
    partnerSandbox: "partner-sandbox",
    purchases: "purchases",
    technicalReports: "technical-reports",
        messages: "messages",
    calendar: "calendar",
    library: "library",
    history: "history",
    settings: "settings",
    creator: "creator"
};

const ADMINISTRATORS = ["admin"];
const OPERATIONAL_PC = ["admin", "pc_standard", "commercial"];
const OPERATIONAL_MOBILE = ["admin", "pc_standard", "commercial", "mobile_admin"];
const TERRAIN = ["admin", "pc_standard", "commercial", "mobile_admin", "team_lead", "technician"];
const CALENDAR_USERS = TERRAIN.concat("accountant");
const PARTNER_MISSION_USERS = OPERATIONAL_MOBILE;
const COMPANY_EMAIL_USERS = ["admin", "pc_standard", "commercial", "accountant", "mobile_admin"];
const LIBRARY_USERS = ["mobile_admin", "team_lead", "technician"];
const MOBILE_POST_USERS = ["mobile_admin", "team_lead", "technician"];
const PURCHASE_USERS = ["admin", "pc_standard", "commercial", "accountant", "mobile_admin"];
const INTERVENTION_SEARCH_USERS = ["team_lead", "technician"];

// Toute nouvelle entrée de navigation doit être déclarée ici. Les éléments
// hors rôle sont retirés du DOM avant l’affichage de l’application.
export const MENU_ACCESS = Object.freeze({
    quick: Object.freeze({
        clients: OPERATIONAL_MOBILE,
        calendar: CALENDAR_USERS,
        interventionSearch: INTERVENTION_SEARCH_USERS,
        library: LIBRARY_USERS,
        purchases: PURCHASE_USERS,
        billing: OPERATIONAL_MOBILE.concat("accountant"),
        accounting: ADMINISTRATORS.concat("pc_standard", "commercial", "accountant"),
        groups: ADMINISTRATORS,
        partnerMissions: PARTNER_MISSION_USERS,
        companyEmail: COMPANY_EMAIL_USERS,
        partnerSandbox: ADMINISTRATORS,
        settings: OPERATIONAL_PC
    }),
    navigation: Object.freeze({
        [ROUTES.home]: Array.from(new Set(OPERATIONAL_MOBILE.concat(MOBILE_POST_USERS))),
        [ROUTES.search]: OPERATIONAL_MOBILE,
        [ROUTES.store]: OPERATIONAL_MOBILE,
        [ROUTES.clients]: OPERATIONAL_MOBILE,
        [ROUTES.billing]: OPERATIONAL_MOBILE.concat("accountant"),
        [ROUTES.purchases]: PURCHASE_USERS,
        [ROUTES.accounting]: ADMINISTRATORS.concat("pc_standard", "commercial", "accountant"),
        [ROUTES.groups]: ADMINISTRATORS,
        [ROUTES.partnerMissions]: PARTNER_MISSION_USERS,
        [ROUTES.companyEmail]: COMPANY_EMAIL_USERS,
        [ROUTES.partnerSandbox]: ADMINISTRATORS,
        [ROUTES.technicalReports]: TERRAIN,
        [ROUTES.calendar]: CALENDAR_USERS,
        [ROUTES.library]: LIBRARY_USERS,
        [ROUTES.settings]: OPERATIONAL_PC
    })
});
