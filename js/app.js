import { initializeAuthentication, restoreApplicationShell, signOut } from "./auth.js?v=115";
import { initializeClientSynchronization } from "./client-sync.js?v=117";
import { loadDatabase } from "./data.js?v=59";
import { initializeNavigation, refreshApplication } from "./navigation.js?v=171";
import { renderError } from "./ui.js?v=44";
import { getSettings } from "./storage.js?v=44";
import { FONT_OPTIONS } from "./config.js?v=116";

let applicationStarted = false;

window.addEventListener("DOMContentLoaded", initializeApp);

async function initializeApp() {
    await initializeAuthentication({
        onAuthenticated: user => {
            if (!document.getElementById("app") && !restoreApplicationShell()) {
                console.error("Le conteneur principal de l’application est introuvable.");
                return;
            }

            showAuthenticatedUser(user);
            startApplication();
        }
    });
}

async function startApplication() {
    if (applicationStarted) return;
    applicationStarted = true;

    try {
        applyTheme();
        applyFont();
        applyLanguage();
        await initializeClientSynchronization();
        const database = await loadDatabase();
        initializeNavigation(database);
        registerServiceWorker();
    } catch (error) {
        applicationStarted = false;
        renderError("Impossible de charger la base de données.", error.message);
    }
}

function showAuthenticatedUser(user) {
    const session = document.getElementById("userSession");
    const email = document.getElementById("userEmail");
    const refreshButton = document.getElementById("refreshBtn");
    const logoutButton = document.getElementById("logoutBtn");

    if (session) session.hidden = false;
    if (email) email.textContent = user.fullName || user.username || "Utilisateur connecté";
    document.body.dataset.userId = user.id || "";
    document.body.dataset.accountId = user.accountOwnerId || user.id || "";
    document.body.dataset.role = user.role || "";
    document.body.dataset.userName = user.fullName || user.username || "";
    document.body.dataset.creator = user.isCreator ? "true" : "false";
    document.body.dataset.technicianBillingEnabled = user.technicianBillingEnabled === false ? "false" : "true";
    document.body.dataset.maxPcUsers = String(user.maxPcUsers || 1);
    updateDeviceMode();
    window.addEventListener("resize", updateDeviceMode);
    document.body.classList.remove("auth-pending");
    refreshButton?.addEventListener("click", async () => {
        refreshButton.disabled = true;
        const initialLabel = refreshButton.textContent;
        refreshButton.textContent = "Actualisation…";
        try {
            await refreshApplication();
            refreshButton.textContent = "Actualisé ✓";
        } finally {
            refreshButton.disabled = false;
            window.setTimeout(() => { refreshButton.textContent = initialLabel; }, 1_800);
        }
    });
    logoutButton?.addEventListener("click", async () => {
        logoutButton.disabled = true;
        await signOut();
        window.location.replace("/");
    }, { once: true });
}

function updateDeviceMode() {
    const isCreator = document.body.dataset.creator === "true";
    const isMobileDevice = !isCreator && (window.matchMedia("(max-width: 700px)").matches
        || window.matchMedia("(pointer: coarse)").matches);
    document.body.classList.toggle("mobile-device", isMobileDevice);
    document.body.classList.toggle("desktop-device", !isMobileDevice);
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

        const texts = lang === "en"
            ? { home: "Home", search: "Search", store: "Store", photo: "Photo", clients: "Clients", billing: "Quotes", calendar: "Planning", library: "Library", favorites: "Favorites", settings: "Settings" }
            : { home: "Accueil", search: "Recherche", store: "Magasin", photo: "Photo", clients: "Clients", billing: "Devis", calendar: "Planning", library: "Bibliothèque", favorites: "Favoris", settings: "Paramètres" };
        document.querySelectorAll("footer .nav-button").forEach(button => {
            const label = button.querySelector(".nav-label-clients") || button.querySelector("span");
            if (label) label.textContent = texts[button.dataset.nav] || label.textContent;
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
