import { loadDatabase } from "./data.js?v=44";
import { initializeNavigation } from "./navigation.js?v=44";
import { renderError } from "./ui.js?v=44";
import { getSettings } from "./storage.js?v=44";
import { FONT_OPTIONS } from "./config.js?v=44";

window.addEventListener("DOMContentLoaded", init);

async function init() {
    try {
        applyTheme();
        applyFont();
        applyLanguage();
        const database = await loadDatabase();
        initializeNavigation(database);
        registerServiceWorker();
    } catch (error) {
        renderError("Impossible de charger la base de données.", error.message);
    }
}

function applyTheme() {
    try {
        const settings = getSettings();
        document.body.classList.toggle("dark-theme", settings.theme === "dark");
    } catch {
        // ignore
    }
}

function applyFont() {
    try {
        const settings = getSettings();
        const font = FONT_OPTIONS.find(f => f.id === settings.font) || FONT_OPTIONS[0];
        if (font && font.css) document.body.style.fontFamily = font.css;
        else document.body.style.fontFamily = "";
    } catch {
        // ignore
    }
}

function applyLanguage() {
    try {
        const settings = getSettings();
        const lang = settings.lang || 'fr';
        document.documentElement.lang = lang;

        // update a few static UI strings (header, placeholder, nav labels)
        const title = lang === 'en' ? "Depann'Home Pro" : "Depann'Home Pro";
        const subtitle = lang === 'en' ? "Professional troubleshooting assistant" : "Assistant de dépannage professionnel";
        const searchPlaceholder = lang === 'en' ? "Search a procedure, motor, remote..." : "Rechercher une procédure, un moteur, une télécommande...";

        const headerH1 = document.querySelector('header .header-content h1');
        const headerP = document.querySelector('header .header-content p');
        if (headerH1) headerH1.textContent = title;
        if (headerP) headerP.textContent = subtitle;

        const search = document.getElementById('search');
        if (search) search.placeholder = searchPlaceholder;

        document.querySelectorAll('footer .nav-button span').forEach((span, idx) => {
            const texts = lang === 'en'
                ? ['Home','Search','Photo','Clients','Favorites','Settings']
                : ['Accueil','Recherche','Photo','Clients','Favoris','Paramètres'];
            span.textContent = texts[idx] || span.textContent;
        });
    } catch {
        // ignore
    }
}

function registerServiceWorker() {
    if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("service-worker.js").catch(() => {
            // L'application reste utilisable même si le cache hors-ligne n'est pas disponible.
        });
    }
}
