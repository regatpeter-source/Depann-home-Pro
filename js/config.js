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
    partnerMissions: "partner-missions",
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
