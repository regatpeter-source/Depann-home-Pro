import { initializeAuthentication, restoreApplicationShell, signOut } from "./auth.js?v=125";
import { initializeClientSynchronization } from "./client-sync.js?v=127";
import { initializeCollaboration } from "./collaboration.js?v=7";
import { loadDatabase } from "./data.js?v=59";
import { initializeNavigation, refreshApplication } from "./navigation.js?v=439";
import { renderError } from "./ui.js?v=44";
import { getSettings } from "./storage.js?v=45";
import { FONT_OPTIONS } from "./config.js?v=133";
import { installClientSessionGuard, onClientSessionReplaced } from "./client-session.js?v=3";
import { initializeInterfaceLanguage } from "./i18n.js?v=5";

let applicationStarted = false;
let sessionReplacementHandled = false;
let administratorSessionMonitor = null;

installClientSessionGuard();
onClientSessionReplaced(() => {
    if (sessionReplacementHandled || document.body.classList.contains("auth-pending")) return;
    sessionReplacementHandled = true;
    document.body.classList.add("auth-pending");
    window.location.replace("/?session=replaced");
});

if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", initializeApp, { once: true });
else initializeApp();

async function initializeApp() {
    initializeInterfaceLanguage();
    try {
        await initializeAuthentication({
            onAuthenticated: user => {
                if (!document.getElementById("app") && !restoreApplicationShell()) {
                    console.error("Le conteneur principal de l’application est introuvable.");
                    return;
                }

                showAuthenticatedUser(user);
                startAdministratorSessionMonitor(user);
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

function startAdministratorSessionMonitor(user) {
    if (administratorSessionMonitor || user.role !== "admin" || user.deviceType === "mobile") return;
    const check = async () => {
        if (document.visibilityState === "visible") await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" }).catch(() => null);
    };
    administratorSessionMonitor = window.setInterval(check, 3_000);
}

async function startApplication() {
    if (applicationStarted) return;
    applicationStarted = true;

    try {
        applyTheme();
        applyInterfacePreferences();
        applyFont();
        enforceOfficialProductName();
        if (isCommercialMobile()) {
            initializeNavigation({ brands: [] });
            document.body.classList.remove("auth-pending");
            registerServiceWorker();
            return;
        }
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
    document.body.classList.remove("partner-sandbox-enabled");
    let features = {};
    try { features = JSON.parse(document.body.dataset.organizationFeatures || "{}"); } catch {}
    if (document.body.dataset.creator !== "true" && features.connectors !== true) return;
    try {
        const partnerResponse = await fetch("/api/partner-sandbox", { credentials: "same-origin" });
        const partner = partnerResponse.ok ? await partnerResponse.json() : null;
        document.body.classList.toggle("partner-sandbox-enabled", Boolean(partner?.available));
    } catch {}
}

function showAuthenticatedUser(user) {
    const session = document.getElementById("userSession");
    const email = document.getElementById("userEmail");
    const workstationLabel = document.getElementById("workstationLabel");
    const mobileUserSections = document.getElementById("mobileUserSections");
    const activeCompanyBadge = document.getElementById("activeCompanyBadge");
    const activeCompanyName = document.getElementById("activeCompanyName");
    const refreshButton = document.getElementById("refreshBtn");
    const logoutButton = document.getElementById("logoutBtn");

    if (session) session.hidden = false;
    if (email) email.textContent = user.fullName || user.username || "Utilisateur connecté";
    if (workstationLabel) workstationLabel.textContent = activeWorkstationLabel(user.role, user.deviceType);
    const sections = Array.isArray(user.departments) ? user.departments.filter(Boolean) : user.department ? [user.department] : [];
    if (mobileUserSections) {
        mobileUserSections.replaceChildren(...sections.map(section => Object.assign(document.createElement("span"), { textContent: section })));
        mobileUserSections.hidden = user.deviceType !== "mobile" || !["technician", "team_lead"].includes(user.role) || !sections.length;
    }
    if (activeCompanyName) activeCompanyName.textContent = user.activeCompanyName || "";
    if (activeCompanyBadge) activeCompanyBadge.hidden = !user.activeCompanyName;
    document.body.dataset.userId = user.id || "";
    document.body.dataset.accountId = user.accountOwnerId || user.id || "";
    document.body.dataset.activeCompanyId = user.activeCompanyId || user.accountOwnerId || user.id || "";
    document.body.dataset.activeCompanyName = user.activeCompanyName || "";
    document.body.dataset.role = user.role || "";
    document.body.dataset.userName = user.fullName || user.username || "";
    document.body.dataset.creator = user.isCreator ? "true" : "false";
    document.body.dataset.deviceType = user.deviceType || "desktop";
    document.body.dataset.technicianBillingEnabled = user.technicianBillingEnabled === false ? "false" : "true";
    document.body.dataset.userDepartments = JSON.stringify(sections);
    document.body.dataset.canAccessBilling = user.canAccessBilling ? "true" : "false";
    document.body.dataset.canAccessAccounting = user.canAccessAccounting ? "true" : "false";
    document.body.dataset.canAccessCompanyEmail = user.canAccessCompanyEmail ? "true" : "false";
    document.body.dataset.canSwitchGroupCompanies = user.canSwitchGroupCompanies ? "true" : "false";
    document.body.dataset.maxPcUsers = String(user.maxPcUsers || 1);
    document.body.dataset.maxMobileUsers = String(user.maxMobileUsers || 0);
    document.body.dataset.monthlyPriceCents = String(user.monthlyPriceCents || 0);
    document.body.dataset.groupAdmin = user.isGroupAdministrator ? "true" : "false";
    document.body.dataset.groupId = user.groupId || "";
    document.body.dataset.groupName = user.groupName || "";
    document.body.dataset.organizationInterface = user.organization?.interfaceType || "standard";
    document.body.dataset.organizationType = user.organization?.organizationType || "troubleshooting_company";
    document.body.dataset.organizationLicense = user.organization?.licenseType || "depannhome_standard";
    document.body.dataset.subscriptionTier = user.organization?.subscriptionTier || "pro";
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

function activeWorkstationLabel(role, deviceType) {
    if (deviceType === "mobile") {
    if (role === "commercial") return "Commercial / Chargé d’affaires mobile";
        if (["admin", "mobile_admin"].includes(role)) return "Poste Admin Mobile";
        if (role === "team_lead") return "Chef d’équipe mobile";
        if (role === "technician") return "Technicien mobile";
        return "Poste mobile";
    }
    if (role === "admin") return "Poste Admin";
    if (role === "commercial") return "Commercial / Chargé d’affaires";
    if (["pc_standard", "accountant"].includes(role)) return "Poste administratif";
    return "Poste administratif";
}

function isCommercialMobile() {
    return document.body.dataset.role === "commercial" && document.body.dataset.deviceType === "mobile";
}

async function initializeGroupCompanySelector(user) {
    const field = document.getElementById("groupCompanySelector");
    const select = field?.querySelector("select");
    if (!field || !select || !user.canSwitchGroupCompanies) { if (field) field.hidden = true; return; }
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

function applyInterfacePreferences() {
    try {
        const settings = getSettings();
        document.body.classList.toggle("compact-interface", settings.interfaceDensity === "compact");
        document.body.classList.toggle("reduce-motion", settings.reduceMotion === true);
        document.body.classList.toggle("hide-sync-indicator", settings.showOfflineBadge === false);
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

function registerServiceWorker() {
    if ("serviceWorker" in navigator) {
        let reloadingForServiceWorkerUpdate = false;
        navigator.serviceWorker.addEventListener("controllerchange", () => {
            if (reloadingForServiceWorkerUpdate) return;
            reloadingForServiceWorkerUpdate = true;
            window.location.reload();
        }, { once: true });
        navigator.serviceWorker.register("service-worker.js", { updateViaCache: "none" })
            .then(registration => registration.update())
            .catch(() => {
                // L'application reste utilisable même si le cache hors-ligne n'est pas disponible.
            });
    }
}
