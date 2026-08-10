import { initializeAuthentication, restoreApplicationShell, signOut } from "./auth.js?v=120";
import { initializeClientSynchronization } from "./client-sync.js?v=124";
import { initializeCollaboration } from "./collaboration.js?v=4";
import { loadDatabase } from "./data.js?v=59";
import { initializeNavigation, refreshApplication } from "./navigation.js?v=280";
import { renderError } from "./ui.js?v=44";
import { getSettings } from "./storage.js?v=44";
import { FONT_OPTIONS } from "./config.js?v=121";

let applicationStarted = false;

if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", initializeApp, { once: true });
else initializeApp();

async function initializeApp() {
    try {
        await initializeAuthentication({
            onAuthenticated: user => {
                if (!document.getElementById("app") && !restoreApplicationShell()) {
                    console.error("Le conteneur principal de l’application est introuvable.");
                    return;
                }

                showAuthenticatedUser(user);
                initializeGroupCompanySelector(user);
                startApplication();
            }
        });
    } catch (error) {
        document.body.classList.remove("auth-pending");
        document.getElementById("authRoot").innerHTML = `<main class="auth-page"><section class="auth-card"><h1>Depann'Home Pro</h1><p class="auth-message error">Impossible de joindre le serveur. Vérifiez votre connexion puis actualisez la page.</p></section></main>`;
        console.error("Impossible d’initialiser l’application.", error);
    }
}

async function startApplication() {
    if (applicationStarted) return;
    applicationStarted = true;

    try {
        applyTheme();
        applyFont();
        applyLanguage();
        enforceOfficialProductName();
        await initializeSandboxCapabilities();
        await initializeClientSynchronization();
        initializeCollaboration();
        const database = await loadDatabase();
        initializeNavigation(database);
        document.body.classList.remove("auth-pending");
        registerServiceWorker();
    } catch (error) {
        applicationStarted = false;
        document.body.classList.remove("auth-pending");
        renderError("Impossible de charger la base de données.", error.message);
    }
}

function enforceOfficialProductName() {
    const normalize = node => {
        if (node.nodeType === Node.TEXT_NODE) {
            const parentTag = node.parentElement?.tagName;
            if (["SCRIPT", "STYLE", "CODE", "PRE"].includes(parentTag)) return;
            const normalized = node.nodeValue
                .replace(/Depann[’']Home Pro/g, "Depann'Home Pro")
                .replace(/DepannHomePro|DepanHomePro/g, "Depann'Home Pro");
            if (normalized !== node.nodeValue) node.nodeValue = normalized;
            return;
        }
        if (node.nodeType === Node.ELEMENT_NODE) node.childNodes.forEach(normalize);
    };
    normalize(document.body);
    new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(normalize))).observe(document.body, { childList: true, subtree: true });
}

async function initializeSandboxCapabilities() {
    try {
        const [partnerResponse, accountingResponse] = await Promise.all([
            fetch("/api/partner-sandbox", { credentials: "same-origin" }),
            fetch("/api/accounting-sandbox", { credentials: "same-origin" })
        ]);
        const [partner, accounting] = await Promise.all([
            partnerResponse.ok ? partnerResponse.json() : null,
            accountingResponse.ok ? accountingResponse.json() : null
        ]);
        document.body.classList.toggle("partner-sandbox-enabled", Boolean(partner?.available));
        document.body.classList.toggle("accounting-sandbox-enabled", Boolean(accounting?.available));
    } catch {
        document.body.classList.remove("partner-sandbox-enabled");
        document.body.classList.remove("accounting-sandbox-enabled");
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
    document.body.dataset.deviceType = user.deviceType || "desktop";
    document.body.dataset.technicianBillingEnabled = user.technicianBillingEnabled === false ? "false" : "true";
    document.body.dataset.maxPcUsers = String(user.maxPcUsers || 1);
    document.body.dataset.groupAdmin = user.isGroupAdministrator ? "true" : "false";
    document.body.dataset.groupId = user.groupId || "";
    document.body.dataset.organizationInterface = user.organization?.interfaceType || "standard";
    document.body.dataset.organizationType = user.organization?.organizationType || "troubleshooting_company";
    document.body.dataset.organizationLicense = user.organization?.licenseType || "depannhome_standard";
    document.body.dataset.organizationFeatures = JSON.stringify(user.organization?.features || {});
    updateDeviceMode();
    window.addEventListener("resize", updateDeviceMode);
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

async function initializeGroupCompanySelector(user) {
    const field = document.getElementById("groupCompanySelector");
    const select = field?.querySelector("select");
    if (!field || !select || user.role !== "admin" || !user.isGroupAdministrator) { if (field) field.hidden = true; return; }
    try {
        const response = await fetch("/api/groups/context", { credentials: "same-origin" });
        const data = response.ok ? await response.json() : null;
        if (!data?.enabled || !data.companies?.length) return;
        select.innerHTML = data.companies.filter(company => company.isActive).map(company => `<option value="${escapeAttribute(company.id)}" ${String(company.id) === String(data.activeCompanyId) ? "selected" : ""}>${escapeHtmlText(company.companyName)}</option>`).join("");
        field.hidden = false;
        select.addEventListener("change", async () => {
            select.disabled = true;
            const result = await fetch("/api/groups/active-company", { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ companyId: select.value }) });
            if (!result.ok) { select.disabled = false; return alert((await result.json().catch(() => ({}))).message || "Changement d’entreprise impossible."); }
            window.location.reload();
        });
    } catch { field.hidden = true; }
}

function escapeHtmlText(value) { const node = document.createElement("span"); node.textContent = String(value || ""); return node.innerHTML; }
function escapeAttribute(value) { return escapeHtmlText(value).replace(/"/g, "&quot;"); }

function updateDeviceMode() {
    const isMobileDevice = document.body.dataset.deviceType === "mobile";
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
        const searchPlaceholder = lang === "en" ? "Search a module, client, or appointment..." : "Rechercher un module, un client ou une intervention...";

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
