import { ROUTES, DEFAULT_SETTINGS, FONT_OPTIONS, LANG_OPTIONS, MENU_ACCESS } from "./config.js?v=131";
import { createCalendarEventForClient, renderCalendar, renderCalendarOverview } from "./calendar.js?v=174";
import { openCreatorPartnerRequest, openCreatorRequestNotification, renderCreatorConsole } from "./creator.js?v=145";
import { createBillingDocumentForClient, renderBilling, synchronizeBillingDocuments, viewBillingDocument } from "./billing.js?v=181";
import { renderAccounting, renderElectronicInvoicingConfiguration } from "./accounting.js?v=15";
import { renderPurchases } from "./purchases.js?v=118";
import { renderGroupActivation, renderGroupWorkspace } from "./groups.js?v=3";
import { renderPartnerMissions } from "./partner-missions.js?v=50";
import { renderPartnerSandbox } from "./partner-sandbox.js?v=3";
import { renderPartnerConnections } from "./partner-connections.js?v=25";
import { renderCompanyEmailWorkspace, renderPartnerEmailSettings } from "./partner-email-settings.js?v=15";
import { renderDataImportTool } from "./data-imports.js?v=3";
import { renderLeakReportWizard as renderTechnicalReports } from "./leak-report-wizard.js?v=29";
import { getFirstUnreadClientId, refreshClientMessageAlert, refreshVisibleClientMessages } from "./messages.js?v=107";
import { getSearchableClients, renderClients } from "./clients.js?v=149";
import { synchronizeClients } from "./client-sync.js?v=125";
import { configureLibrary, openLibrarySection, renderLibrary, searchPersonalLibrary } from "./library.js?v=122";
import { getContextualSearchResults } from "./search.js?v=67";
import { state, resetSelection } from "./state.js?v=44";
import {
    getSettings,
    saveSettings
} from "./storage.js?v=44";
import { escapeHtml, normalizeText } from "./utils.js?v=44";
import { renderPlatformAnnouncement } from "./platform-announcement.js?v=1";
import { renderDocumentTemplateEditor } from "./document-template-editor.js?v=3";
import {
    clearSearch,
    createBackCard,
    createButton,
    createCard,
    createInfo,
    focusSearch,
    getContainer,
    renderError,
    setPage
} from "./ui.js?v=44";

const TEAM_SECTION_OPTIONS = ["Dépannage", "Recherche de fuite", "Plomberie", "Électricité", "Menuiserie", "Serrurerie", "Chauffage", "Climatisation", "Couverture", "Vitrerie", "Maçonnerie", "Peinture", "Carrelage", "Interphonie", "Alarme", "Électroménager", "Chantiers", "Métrés", "Maintenance", "Pose", "SAV"];

let database = { brands: [] };
let searchRequestId = 0;
let searchInputTimer = null;
let sharedSynchronizationTimer = null;
let sharedSynchronizationPromise = null;
let interactionSynchronizationTimer = null;
let interactionSynchronizationBound = false;
let pendingPartnerClientId = "";
const TECHNICIAN_CALENDAR_ALERT_KEY_PREFIX = "depannHomePro:technicianCalendar:lastViewed:";
const INTERACTION_SYNCHRONIZATION_DELAY = 1_500;
const SEARCH_EVENTS_TTL = 30_000;
let searchEventsCache = { expiresAt: 0, events: [] };
let searchEventsPromise = null;

export function initializeNavigation(loadedDatabase) {
    database = loadedDatabase;
    ensureMobileHomeNavigationButton();
    configureLibrary({
        openCatalog: renderBrands,
        openStore: renderStore,
        openRollerShutters: () => renderMotorFamily("volets-roulants"),
        openGates: () => renderMotorFamily("portails")
    });
    bindEvents();
    bindSilentInteractionSynchronization();
    applyRoleBasedMenus();
    updateSearchPlaceholder();
    window.addEventListener("depannhome:open-client", event => openClients(String(event.detail?.clientId || "")));
    window.addEventListener("depannhome:open-partner-email-settings", () => renderSettings({ section: "company", focusPartnerEmail: true }));
    window.addEventListener("depannhome:open-partner-email-missions", () => {
        if (canAccessRoute(ROUTES.partnerMissions) && document.body.dataset.canAccessCompanyEmail === "true") {
            window.dispatchEvent(new CustomEvent("depannhome:show-partner-email-missions"));
            renderPartnerMissions();
        }
    });
    window.addEventListener("depannhome:partner-email-changed", event => {
        const activeRoute = document.querySelector(".nav-button.active")?.dataset.nav;
        if (activeRoute !== ROUTES.companyEmail) return;
        if (event.detail?.reason === "sync") window.setTimeout(renderCompanyEmail, 2200);
        else renderCompanyEmail();
    });
    window.addEventListener("depannhome:edit-report-template", () => {
        if (!organizationFeatureEnabled("technicalReports") || document.body.dataset.role !== "admin" || !document.body.classList.contains("desktop-device")) return;
        openDocumentTemplateSettings("report");
    });
    window.addEventListener("depannhome:open-document-template", event => {
        const type = String(event.detail?.type || "");
        if (type === "quote" || (type === "quitus" && organizationFeatureEnabled("quitus")) || (type === "report" && organizationFeatureEnabled("technicalReports"))) openDocumentTemplateSettings(type);
    });
    window.addEventListener("depannhome:clients-synchronized", () => refreshClientMessageAlert());
    window.addEventListener("depannhome:partner-client-provisioned", event => {
        const clientId = String(event.detail?.clientId || "");
        if (!clientId) return;
        pendingPartnerClientId = clientId;
        if (document.querySelector(".nav-button.active")?.dataset.nav !== ROUTES.clients) return;
        renderClients({ database, navigateToRef, createBillingDocument: createBillingDocumentForClient, viewBillingDocument, createCalendarEvent: createCalendarEventForClient, selectedId: clientId, directoryClientId: clientId });
    });
    window.addEventListener("depannhome:technician-calendar-viewed", event => markTechnicianCalendarAlertsRead(event.detail?.events || []));
    window.addEventListener("depannhome:open-notification", event => openNotificationDestination(event.detail?.notification));
    window.addEventListener("depannhome:open-home", openHome);
    refreshClientMessageAlert();
    refreshTechnicianCalendarAlert();
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") refreshSharedData({ silent: true });
    });
    if (!sharedSynchronizationTimer) {
        sharedSynchronizationTimer = window.setInterval(() => {
            if (document.visibilityState === "visible") refreshSharedData({ silent: true });
        }, isTechnician() ? 30_000 : 90_000);
    }
    if (isAccountant() && canAccessRoute(ROUTES.billing)) renderBilling();
    else if (isAccountant() && canAccessRoute(ROUTES.accounting)) renderAccounting();
    else if (isMobileDeviceContext()) openHome();
    else if (document.body.classList.contains("desktop-device")) renderHome();
    else renderBrands();
}

export async function refreshSharedData(options = {}) {
    if (sharedSynchronizationPromise) {
        return options.includeClients
            ? Promise.all([sharedSynchronizationPromise, synchronizeClients()])
            : sharedSynchronizationPromise;
    }
    const requests = canAccessRoute(ROUTES.billing) ? [synchronizeBillingDocuments({ refreshView: !options.silent, force: Boolean(options.forceBilling) })] : [];
    if (isTechnician() && canAccessRoute(ROUTES.calendar)) requests.unshift(refreshTechnicianCalendarAlert());
    if (!isAccountant()) requests.unshift(refreshVisibleClientMessages());
    if (options.includeClients && !isAccountant()) requests.push(synchronizeClients());
    sharedSynchronizationPromise = Promise.all(requests).finally(() => {
        sharedSynchronizationPromise = null;
    });
    return sharedSynchronizationPromise;
}

function bindSilentInteractionSynchronization() {
    if (interactionSynchronizationBound) return;
    interactionSynchronizationBound = true;
    const schedule = event => {
        const control = event.target.closest("button, input[type=checkbox], input[type=radio], select");
        if (!control || control.disabled || control.id === "refreshBtn" || document.body.classList.contains("auth-pending")) return;
        window.clearTimeout(interactionSynchronizationTimer);
        interactionSynchronizationTimer = window.setTimeout(() => {
            interactionSynchronizationTimer = null;
            refreshSharedData({ includeClients: true, silent: true }).catch(() => {});
        }, INTERACTION_SYNCHRONIZATION_DELAY);
    };
    document.addEventListener("click", schedule, { capture: true });
    document.addEventListener("change", schedule, { capture: true });
}

export async function refreshApplication() {
    if (await refreshOrganizationAccess()) return { refreshed: true, accessChanged: true };
    const activeRoute = document.querySelector(".nav-button.active")?.dataset.nav || "";
    await refreshSharedData({ includeClients: true, forceBilling: true });

    if (activeRoute && MENU_ACCESS.navigation[activeRoute] && !canAccessRoute(activeRoute)) {
        openHome();
        return { refreshed: true };
    }

    if (isAccountant()) {
        if (canAccessRoute(ROUTES.billing)) renderBilling();
        else if (canAccessRoute(ROUTES.accounting)) renderAccounting();
    } else if (activeRoute === ROUTES.clients) {
        const selectedId = document.querySelector(".client-messages-panel")?.dataset.clientId || "";
        renderClients({ database, navigateToRef, createBillingDocument: createBillingDocumentForClient, viewBillingDocument, createCalendarEvent: createCalendarEventForClient, ...(selectedId ? { selectedId } : {}) });
    } else if (activeRoute === ROUTES.calendar) {
        renderCalendar();
    } else if (activeRoute === ROUTES.billing) {
        if (isTechnician() && organizationFeatureEnabled("technicalReports")) renderTechnicalReports();
        else renderBilling();
    } else if (activeRoute === ROUTES.technicalReports) {
        renderTechnicalReports();
    } else if (activeRoute === ROUTES.partnerMissions && !isAccountant()) {
        renderPartnerMissions();
    } else if (activeRoute === ROUTES.companyEmail) {
        renderCompanyEmail();
    } else if (activeRoute === ROUTES.partnerSandbox && document.body.dataset.role === "admin") {
        renderPartnerSandbox();
    } else if (activeRoute === ROUTES.purchases && ["admin", "pc_standard", "accountant", "mobile_admin"].includes(document.body.dataset.role)) {
        renderPurchases();
    } else if (activeRoute === ROUTES.groups && document.body.dataset.groupAdmin === "true") {
        renderGroupWorkspace();
    } else if (activeRoute === ROUTES.settings && canAccessRoute(ROUTES.settings)) {
        renderSettings();
    } else if (activeRoute === ROUTES.home) {
        openHome();
    }
    return { refreshed: true };
}

async function refreshOrganizationAccess() {
    try {
        const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
        if (!response.ok) return false;
        const session = await response.json();
        const organization = session.user?.organization;
        if (!organization?.features) return false;
        const previous = `${document.body.dataset.organizationInterface || ""}:${document.body.dataset.subscriptionTier || ""}:${document.body.dataset.organizationFeatures || ""}:${document.body.dataset.canAccessBilling || "false"}:${document.body.dataset.canAccessAccounting || "false"}:${document.body.dataset.canAccessCompanyEmail || "false"}`;
        const nextFeatures = JSON.stringify(organization.features);
        const next = `${organization.interfaceType || "standard"}:${organization.subscriptionTier || "pro"}:${nextFeatures}:${session.user.canAccessBilling ? "true" : "false"}:${session.user.canAccessAccounting ? "true" : "false"}:${session.user.canAccessCompanyEmail ? "true" : "false"}`;
        if (previous === next) return false;
        document.body.dataset.organizationInterface = organization.interfaceType || "standard";
        document.body.dataset.organizationType = organization.organizationType || "troubleshooting_company";
        document.body.dataset.organizationLicense = organization.licenseType || "depannhome_standard";
        document.body.dataset.subscriptionTier = organization.subscriptionTier || "pro";
        document.body.dataset.organizationFeatures = nextFeatures;
        window.location.reload();
        return true;
    } catch {
        return false;
    }
}

function bindEvents() {
    const search = document.getElementById("search");
    const clientsBtn = document.getElementById("clientsBtn");
    const billingBtn = document.getElementById("billingBtn");
    const accountingBtn = document.getElementById("accountingBtn");
    const purchasesBtn = document.getElementById("purchasesBtn");
    const groupsBtn = document.getElementById("groupsBtn");
    const partnerMissionsBtn = document.getElementById("partnerMissionsBtn");
    const companyEmailBtn = document.getElementById("companyEmailBtn");
    const partnerSandboxBtn = document.getElementById("partnerSandboxBtn");
    const calendarBtn = document.getElementById("calendarBtn");
    const libraryBtn = document.getElementById("libraryBtn");
    const settingsBtn = document.getElementById("settingsBtn");

    search.addEventListener("input", event => {
        const value = event.target.value.toLowerCase().trim();
        window.clearTimeout(searchInputTimer);

        if (!value) {
            searchRequestId += 1;
            openHome();
            return;
        }

        searchInputTimer = window.setTimeout(() => renderSearchResults(value), 120);
    });

    clientsBtn.addEventListener("click", () => { if (canAccessQuick("clients")) openClients(); });
    billingBtn?.addEventListener("click", () => {
        if (!canAccessQuick("billing")) return;
        if (isTechnician() && organizationFeatureEnabled("technicalReports")) renderTechnicalReports();
        else renderBilling();
    });
    accountingBtn?.addEventListener("click", () => { if (canAccessQuick("accounting")) renderAccounting(); });
    purchasesBtn?.addEventListener("click", () => { if (canAccessQuick("purchases")) renderPurchases(); });
    groupsBtn?.addEventListener("click", () => { if (canAccessQuick("groups")) renderGroupWorkspace(); });
    partnerMissionsBtn?.addEventListener("click", () => { if (canAccessQuick("partnerMissions")) renderPartnerMissions(); });
    companyEmailBtn?.addEventListener("click", () => { if (canAccessQuick("companyEmail")) renderCompanyEmail(); });
    partnerSandboxBtn?.addEventListener("click", () => { if (canAccessQuick("partnerSandbox")) renderPartnerSandbox(); });
    calendarBtn?.addEventListener("click", () => { if (canAccessQuick("calendar")) openCalendar(); });
    libraryBtn?.addEventListener("click", () => { if (canAccessQuick("library")) renderLibrary(); });
    settingsBtn?.addEventListener("click", () => { if (canAccessQuick("settings")) renderSettings(); });

    document.querySelectorAll(".nav-button").forEach(button => {
        button.addEventListener("click", async () => {
            const nav = button.dataset.nav;

            if (!canAccessRoute(nav)) return;

            if (isAccountant()) {
                if (nav === ROUTES.billing) renderBilling();
                if (nav === ROUTES.accounting) renderAccounting();
                if (nav === ROUTES.companyEmail) renderCompanyEmail();
                return;
            }

            if (nav === ROUTES.home) openHome();
            if (nav === ROUTES.search) focusSearch();
            if (nav === ROUTES.store) renderStore();
            if (nav === ROUTES.clients) openClients();
            if (nav === ROUTES.billing) {
                if (isTechnician() && organizationFeatureEnabled("technicalReports")) renderTechnicalReports();
                else renderBilling();
            }
            if (nav === ROUTES.accounting) renderAccounting();
            if (nav === ROUTES.purchases) renderPurchases();
            if (nav === ROUTES.groups && document.body.dataset.groupAdmin === "true") renderGroupWorkspace();
            if (nav === ROUTES.partnerMissions) renderPartnerMissions();
            if (nav === ROUTES.companyEmail) renderCompanyEmail();
            if (nav === ROUTES.partnerSandbox && document.body.dataset.role === "admin") renderPartnerSandbox();
            if (nav === ROUTES.calendar) openCalendar();
            if (nav === ROUTES.library) renderLibrary();
            if (nav === ROUTES.settings) renderSettings();
        });
    });
}

function applyRoleBasedMenus() {
    const quickSelectors = {
        clients: "#clientsBtn", calendar: "#calendarBtn", library: "#libraryBtn", billing: "#billingBtn", purchases: "#purchasesBtn",
        accounting: "#accountingBtn", groups: "#groupsBtn", partnerMissions: "#partnerMissionsBtn", companyEmail: "#companyEmailBtn",
        partnerSandbox: "#partnerSandboxBtn", settings: "#settingsBtn"
    };
    Object.entries(quickSelectors).forEach(([menu, selector]) => {
        const button = document.querySelector(selector);
        if (!isMenuAllowed(MENU_ACCESS.quick[menu], menuRoute(menu))) button?.remove();
    });
    document.querySelectorAll(".nav-button").forEach(button => {
        if (button.dataset.nav === ROUTES.home && isMobileDeviceContext()) return;
        if (isMobileDeviceContext()) { button.remove(); return; }
        if (!canAccessRoute(button.dataset.nav)) button.remove();
    });
    if (isMobileAdministrator()) {
        const calendarButton = document.getElementById("calendarBtn");
        const calendarLabel = calendarButton?.firstChild;
        if (calendarLabel?.nodeType === Node.TEXT_NODE) calendarLabel.textContent = " Interventions ";
        const navigationLabel = document.querySelector('.nav-button[data-nav="calendar"] span');
        if (navigationLabel) navigationLabel.textContent = "Interventions";
    }
}

function ensureMobileHomeNavigationButton() {
    if (!isMobileDeviceContext() || document.querySelector('.nav-button[data-nav="home"]')) return;
    const footer = document.querySelector("#authRoot > footer") || document.querySelector("footer");
    if (!footer) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "nav-button active";
    button.dataset.nav = ROUTES.home;
    button.innerHTML = "<span>Accueil</span>";
    footer.prepend(button);
}

function isMobileDeviceContext() {
    return document.body.dataset.deviceType === "mobile"
        || document.body.classList.contains("mobile-device")
        || window.matchMedia("(max-width: 700px), (pointer: coarse)").matches;
}

function isMenuAllowed(roles, route = "") {
    if (!Array.isArray(roles) || !roles.includes(document.body.dataset.role)) return false;
    if (route === ROUTES.billing && ["pc_standard", "accountant"].includes(document.body.dataset.role) && document.body.dataset.canAccessBilling !== "true") return false;
    if (route === ROUTES.accounting && ["pc_standard", "accountant"].includes(document.body.dataset.role) && document.body.dataset.canAccessAccounting !== "true") return false;
    if (route === ROUTES.companyEmail && document.body.dataset.canAccessCompanyEmail !== "true") return false;
    if (route === ROUTES.groups) return document.body.dataset.groupAdmin === "true";
    if (route === ROUTES.partnerSandbox) return document.body.classList.contains("partner-sandbox-enabled");
    return !route || isOrganizationRouteEnabled(route);
}

function canAccessQuick(menu) {
    return isMenuAllowed(MENU_ACCESS.quick[menu], menuRoute(menu));
}

function canAccessRoute(route) {
    return isMenuAllowed(MENU_ACCESS.navigation[route], route) && isOrganizationRouteEnabled(route);
}

function isDesktopDevice() {
    return document.body.classList.contains("desktop-device") || document.body.dataset.deviceType === "desktop";
}

function canAccessSettingsSection(section) {
    if (document.body.dataset.creator === "true") return true;
    if (document.body.dataset.organizationInterface === "partner") return section === "support" || (section === "network" && organizationFeatureEnabled("partnerConnections")) || (section === "company" && organizationFeatureEnabled("partnerMissions"));
    if (section === "company" && organizationFeatureEnabled("companyEmail")) return document.body.dataset.role === "admin";
    if (section === "network" && (organizationFeatureEnabled("partnerConnections") || organizationFeatureEnabled("partnerMissions"))) return true;
    const featureBySection = { documents: "billing", electronicInvoicing: "accounting", network: "partnerConnections", users: "settings", security: "settings", groups: "groups", personalization: "settings", imports: "imports" };
    const feature = featureBySection[section];
    if (feature && !organizationFeatureEnabled(feature)) return false;
    if (document.body.dataset.role === "admin") return true;
    if (section === "documents" && document.body.dataset.canAccessBilling === "true") return true;
    if (section === "electronicInvoicing" && document.body.dataset.canAccessAccounting === "true") return true;
    return ["network", "company", "personalization"].includes(section);
}

function isOrganizationRouteEnabled(route) {
    if (document.body.dataset.creator === "true") return true;
    if (route === ROUTES.settings && organizationFeatureEnabled("partnerConnections")) return true;
    if (route === ROUTES.settings && organizationFeatureEnabled("partnerMissions")) return true;
    const featureByRoute = { [ROUTES.search]: "library", [ROUTES.store]: "library", [ROUTES.clients]: "clients", [ROUTES.calendar]: "calendar", [ROUTES.library]: "library", [ROUTES.billing]: "billing", [ROUTES.accounting]: "accounting", [ROUTES.purchases]: "purchases", [ROUTES.messages]: "messages", [ROUTES.technicalReports]: "technicalReports", [ROUTES.partnerMissions]: "partnerMissions", [ROUTES.companyEmail]: "companyEmail", [ROUTES.groups]: "groups", [ROUTES.settings]: "settings" };
    const feature = featureByRoute[route];
    return !feature || organizationFeatureEnabled(feature);
}

function organizationFeatureEnabled(feature) {
    if (feature === "library" && isMobilePostRole() && document.body.dataset.organizationInterface === "standard") return true;
    let features = {};
    try { features = JSON.parse(document.body.dataset.organizationFeatures || "{}"); } catch { features = {}; }
    return features[feature] === true;
}

function isMobilePostRole() {
    return ["mobile_admin", "team_lead", "technician"].includes(document.body.dataset.role);
}

function menuRoute(menu) {
    return ({ clients: ROUTES.clients, calendar: ROUTES.calendar, library: ROUTES.library, billing: ROUTES.billing, accounting: ROUTES.accounting, purchases: ROUTES.purchases, groups: ROUTES.groups, partnerMissions: ROUTES.partnerMissions, companyEmail: ROUTES.companyEmail, partnerSandbox: ROUTES.partnerSandbox, settings: ROUTES.settings })[menu] || "";
}

function openHome() {
    if (isAccountant()) {
        if (canAccessRoute(ROUTES.billing)) renderBilling();
        else if (canAccessRoute(ROUTES.accounting)) renderAccounting();
        else renderPurchases();
        return;
    }
    if (isMobileDeviceContext()) {
        renderHome();
        return;
    }
    if (document.body.classList.contains("desktop-device") || isMobileAdministrator()) {
        renderHome();
        return;
    }
    renderBrands();
}

function openCalendar() {
    if (document.body.dataset.role === "technician") {
        renderCalendarOverview();
        return;
    }
    renderCalendar();
}

function renderCompanyEmail() {
    if (!canAccessRoute(ROUTES.companyEmail)) return;
    clearSearch();
    resetSelection("all");
    setPage("Espace e-mail de l’entreprise", ROUTES.companyEmail, "detail");
    renderCompanyEmailWorkspace(getContainer());
}

async function openClients(clientId = "") {
    if (isAccountant()) return;
    const provisionedClientId = clientId ? "" : pendingPartnerClientId;
    const selectedId = clientId || provisionedClientId || await getFirstUnreadClientId();
    await renderClients({ database, navigateToRef, createBillingDocument: createBillingDocumentForClient, viewBillingDocument, createCalendarEvent: createCalendarEventForClient, refreshFromServer: true, ...(selectedId ? { selectedId, focusMessages: true } : {}), ...(provisionedClientId ? { directoryClientId: provisionedClientId } : {}) });
    if (provisionedClientId === pendingPartnerClientId) pendingPartnerClientId = "";
}

function openNotificationDestination(notification) {
    const entityType = notification?.entityType || "";
    const entityId = String(notification?.entityId || notification?.payload?.partnerRequestId || "");
    if (entityType === "partner_request" && document.body.dataset.creator === "true") return openCreatorPartnerRequest(entityId);
    if (entityType === "subscription_request" && document.body.dataset.creator === "true") return openCreatorRequestNotification("subscription");
    if (entityType === "support_request" && document.body.dataset.creator === "true") return openCreatorRequestNotification("support");
    if (entityType === "partner_mission") return renderPartnerMissions({ missionId: entityId, sourceDialogue: Boolean(notification?.payload?.sourceDialogue) });
    if (entityType === "partner_connection") return renderSettings({ section: "network" });
    if (entityType === "technical_report") return organizationFeatureEnabled("technicalReports") ? renderTechnicalReports(Number(entityId) || 0) : openHome();
    if (entityType === "billing_document") return renderBilling();
    if (entityType === "client") return openClients(entityId || String(notification?.payload?.clientId || ""));
    if (entityType === "calendar_event") return renderCalendar();
}

function isAccountant() {
    return document.body.dataset.role === "accountant";
}

function isTechnician() {
    return document.body.dataset.role === "technician";
}

function isMobileAdministrator() {
    return document.body.dataset.role === "mobile_admin";
}

async function refreshTechnicianCalendarAlert() {
    if (!isTechnician()) return { ok: true, skipped: true };
    const today = dateString(new Date());
    try {
        const response = await fetch(`/api/calendar/events?start=${encodeURIComponent(today)}&end=${encodeURIComponent(today)}`, { credentials: "same-origin" });
        const data = await response.json().catch(() => null);
        if (!response.ok) return { ok: false, message: data?.message || "Impossible de vérifier le planning." };
        const seenEvents = getViewedTechnicianCalendarEvents(today);
        const unreadEvents = (data?.events || []).filter(event => seenEvents[String(event.id)] !== calendarEventVersion(event));
        updateTechnicianCalendarAlert(unreadEvents.length);
        return { ok: true, unreadCount: unreadEvents.length };
    } catch {
        return { ok: false, message: "Serveur indisponible." };
    }
}

function markTechnicianCalendarAlertsRead(calendarEvents) {
    if (!isTechnician()) return;
    const today = dateString(new Date());
    const seenEvents = getViewedTechnicianCalendarEvents(today);
    const todayEvents = calendarEvents.filter(event => event?.date === today);
    todayEvents
        .forEach(event => { seenEvents[String(event.id)] = calendarEventVersion(event); });
    try {
        localStorage.setItem(getTechnicianCalendarAlertKey(today), JSON.stringify(seenEvents));
    } catch {
        // Sans stockage local, l’alerte restera visible jusqu’à la prochaine actualisation.
    }
    if (todayEvents.length) updateTechnicianCalendarAlert(0);
    else refreshTechnicianCalendarAlert();
}

function updateTechnicianCalendarAlert(count) {
    document.querySelectorAll("[data-calendar-alert]").forEach(alert => {
        alert.hidden = count === 0;
        alert.textContent = count > 99 ? "99+" : String(count);
        alert.setAttribute("aria-label", `${count} nouveau${count > 1 ? "x" : ""} rendez-vous aujourd’hui`);
    });
}

function getViewedTechnicianCalendarEvents(date) {
    try {
        const value = JSON.parse(localStorage.getItem(getTechnicianCalendarAlertKey(date)) || "{}");
        return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
        return {};
    }
}

function getTechnicianCalendarAlertKey(date) {
    return `${TECHNICIAN_CALENDAR_ALERT_KEY_PREFIX}${document.body.dataset.accountId || "anonymous"}:${document.body.dataset.userId || "anonymous"}:${date}`;
}

function calendarEventVersion(event) {
    return String(event?.updatedAt || event?.createdAt || event?.id || "");
}

function dateString(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function renderStore() {
    clearSearch();
    resetSelection("all");
    setPage("Magasin", ROUTES.store, "detail");

    const container = getContainer();
    const panel = document.createElement("article");
    panel.className = "brand-card full-card procedure-card store-panel";
    panel.innerHTML = `
        <div class="procedure-header">
            <div>
                <p class="eyebrow">Pièces détachées</p>
                <h2>Trouver une pièce</h2>
            </div>
        </div>
    `;

    const form = document.createElement("form");
    form.className = "store-form";

    const referenceLabel = document.createElement("label");
    referenceLabel.htmlFor = "storeReference";
    referenceLabel.textContent = "Référence de la pièce ou du produit";
    const referenceInput = document.createElement("input");
    referenceInput.id = "storeReference";
    referenceInput.type = "search";
    referenceInput.placeholder = "Ex. Oximo 50 RTS, CAME BX, 1841036";
    referenceInput.autocomplete = "off";
    referenceLabel.appendChild(referenceInput);

    const manufacturerLabel = document.createElement("label");
    manufacturerLabel.htmlFor = "storeManufacturer";
    manufacturerLabel.textContent = "Fabricant (facultatif)";
    const manufacturerSelect = document.createElement("select");
    manufacturerSelect.id = "storeManufacturer";
    manufacturerSelect.appendChild(new Option("Détection automatique", ""));
    getStoreManufacturers().forEach(manufacturer => {
        manufacturerSelect.appendChild(new Option(manufacturer.name, manufacturer.id));
    });
    manufacturerLabel.appendChild(manufacturerSelect);

    const submit = createButton("Rechercher la pièce", "secondary-button", () => {});
    submit.type = "submit";
    form.append(referenceLabel, manufacturerLabel, submit);
    panel.appendChild(form);

    const results = document.createElement("div");
    results.className = "store-results";
    panel.appendChild(results);
    container.appendChild(panel);

    form.addEventListener("submit", event => {
        event.preventDefault();
        renderStoreResults(results, referenceInput.value, manufacturerSelect.value);
    });

    referenceInput.focus();
}

function renderStoreResults(container, rawReference, selectedManufacturerId) {
    container.innerHTML = "";
    const reference = rawReference.trim();

    if (!reference) {
        container.appendChild(createInfo("Saisissez une référence avant de lancer la recherche."));
        return;
    }

    const matches = findStoreMatches(reference);
    const detectedManufacturer = matches[0]?.category;
    const selectedManufacturer = getStoreManufacturers().find(item => item.id === selectedManufacturerId);
    const manufacturer = selectedManufacturer || detectedManufacturer || null;
    const family = matches[0]?.brand || null;

    if (matches.length) {
        const heading = document.createElement("h3");
        heading.textContent = "Correspondances dans le catalogue";
        container.appendChild(heading);

        const list = document.createElement("div");
        list.className = "store-match-list";
        matches.forEach(match => {
            const card = document.createElement("button");
            card.type = "button";
            card.className = "store-match";
            card.innerHTML = `<strong>${escapeHtml(match.product.name)}</strong><span>${escapeHtml(match.category.name)} · ${escapeHtml(match.brand.name)} · ${escapeHtml(match.product.reference || "Référence non renseignée")}</span>`;
            card.addEventListener("click", () => navigateToRef(match.ref));
            list.appendChild(card);
        });
        container.appendChild(list);
    } else {
        container.appendChild(createInfo("Référence non trouvée dans le catalogue. Vous pouvez tout de même poursuivre vers un fournisseur."));
    }

    const actions = document.createElement("section");
    actions.className = "procedure-section store-actions";
    const heading = document.createElement("h3");
    heading.textContent = "Où chercher cette pièce ?";
    const description = document.createElement("p");
    description.className = "muted";
    description.textContent = manufacturer
        ? `Référence recherchée : ${reference}. Fabricant ${manufacturer.name}${family ? ` · ${family.name}` : ""}.`
        : `Référence recherchée : ${reference}. Sélectionnez un fabricant ci-dessus pour accéder directement à son assistance.`;
    actions.append(heading, description);

    const links = document.createElement("div");
    links.className = "store-links";
    links.appendChild(createExternalLink(
        `Chercher « ${reference} » sur Servistores`,
        getServistoresSearchUrl(reference),
        `Recherche Servistores pour la référence ${reference}`
    ));

    if (manufacturer) {
        links.appendChild(createExternalLink(
            `Chercher « ${reference} » chez ${manufacturer.name}`,
            getManufacturerSupportUrl(manufacturer.id, reference),
            `Recherche de la référence ${reference} sur le site officiel ${manufacturer.name}`
        ));
    }

    actions.appendChild(links);
    container.appendChild(actions);
}

function findStoreMatches(reference) {
    const query = compactReference(reference);
    if (!query) return [];

    const matches = [];
    database.brands.forEach((brand, brandIndex) => {
        brand.categories.forEach((category, categoryIndex) => {
            category.products.forEach((product, productIndex) => {
                const productReference = compactReference(product.reference);
                const productName = compactReference(product.name);
                const isExactReference = productReference === query;
                const isPartialMatch = query.length >= 3 && (productReference.includes(query) || query.includes(productReference) || productName.includes(query));

                if (!isExactReference && !isPartialMatch) return;
                matches.push({
                    brand,
                    category,
                    product,
                    ref: { type: "product", brandIndex, categoryIndex, productIndex },
                    score: isExactReference ? 2 : 1
                });
            });
        });
    });

    return matches.sort((first, second) => second.score - first.score).slice(0, 8);
}

function compactReference(value) {
    return normalizeText(value).replace(/[^a-z0-9]+/g, "");
}

function getStoreManufacturers() {
    const manufacturers = new Map();
    database.brands.forEach(brand => {
        brand.categories.forEach(category => {
            if (!manufacturers.has(category.id)) manufacturers.set(category.id, { id: category.id, name: category.name });
        });
    });
    return [...manufacturers.values()].sort((first, second) => first.name.localeCompare(second.name, "fr"));
}

function getServistoresSearchUrl(reference) {
    return `https://www.servistores.com/html/recherche.html?q=${encodeURIComponent(reference)}`;
}

function getManufacturerSupportUrl(manufacturerId, reference) {
    if (manufacturerId === "servistores") return getServistoresSearchUrl(reference);

    const domains = {
        somfy: "somfy.fr",
        nice: "niceforyou.com",
        bubendorff: "bubendorff.com",
        faac: "faac.it",
        came: "came.com",
        hormann: "hormann.fr"
    };
    const domain = domains[manufacturerId];
    if (!domain) return getServistoresSearchUrl(reference);

    return `https://www.google.com/search?q=${encodeURIComponent(`site:${domain} ${reference}`)}`;
}

function createExternalLink(label, href, title) {
    const link = document.createElement("a");
    link.className = "secondary-button store-external-link";
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = title;
    link.textContent = label;
    return link;
}

export function renderBrands() {
    clearSearch();
    resetSelection("all");
    setPage("Gammes", ROUTES.home);

    const container = getContainer();

    if (!database.brands.length) {
        container.appendChild(createInfo("Aucune gamme disponible pour le moment."));
        return;
    }

    const grid = document.createElement("section");
    grid.className = "motor-catalog-grid motor-family-grid";
    database.brands.forEach(brand => {
        grid.appendChild(
            createCard(
                "",
                brand.name,
                `${Array.isArray(brand.categories) ? brand.categories.length : 0} gamme(s)`,
                () => {
                    state.brand = brand;
                    renderBrandCategories();
                }
            )
        );
    });
    container.appendChild(grid);
}

function renderMotorFamily(familyId) {
    const brand = database.brands.find(item => item.id === familyId);
    if (!brand) return renderBrands();
    state.brand = brand;
    renderBrandCategories();
}

async function renderHome() {
    clearSearch();
    resetSelection("all");
    setPage("Accueil", ROUTES.home, "detail");

    const container = getContainer();
    const panel = document.createElement("section");
    panel.className = "client-panel home-panel dashboard-panel";
    if (!canAccessRoute(ROUTES.calendar)) {
        document.body.dataset.pageMode = "basic-home";
        renderPlatformAnnouncement(container);
        return;
    }
    panel.innerHTML = `
        <div class="dashboard-heading"><div><p class="eyebrow">Depann’Home Pro</p><h2>Tableau de bord</h2>${renderMobileUserSections()}</div><button type="button" class="secondary-button" data-dashboard-action="calendar">Voir le planning complet</button></div>
        <div class="dashboard-grid">
            <section class="dashboard-card"><p class="eyebrow">Aujourd’hui</p><h3>${escapeHtml(formatDashboardDate(new Date()))}</h3><div class="dashboard-events" data-dashboard-events="today"><p class="muted">Chargement des rendez-vous…</p></div></section>
            <section class="dashboard-card"><p class="eyebrow">À venir</p><h3>Les 7 prochains jours</h3><div class="dashboard-events" data-dashboard-events="upcoming"><p class="muted">Chargement des rendez-vous…</p></div></section>
        </div>
        ${canAccessRoute(ROUTES.library) ? '<p class="dashboard-catalog-note">Les gammes techniques — volets roulants et portails — sont disponibles dans la <strong>Bibliothèque</strong>.</p>' : ""}
    `;
    container.appendChild(panel);
    renderPlatformAnnouncement(container);

    panel.querySelector('[data-dashboard-action="calendar"]').addEventListener("click", renderCalendar);
    const result = await loadDashboardEvents();
    if (!panel.isConnected) return;
    if (!result.ok) {
        panel.querySelectorAll("[data-dashboard-events]").forEach(list => {
            list.innerHTML = `<p class="auth-message error">${escapeHtml(result.message || "Impossible de charger le planning.")}</p>`;
        });
        return;
    }

    const today = toDashboardDate(new Date());
    const upcomingEnd = toDashboardDate(addDashboardDays(new Date(), 6));
    const todayEvents = result.events.filter(event => event.date === today);
    const upcomingEvents = result.events.filter(event => event.date > today && event.date <= upcomingEnd);
    renderDashboardEvents(panel.querySelector('[data-dashboard-events="today"]'), todayEvents, "Aucun rendez-vous aujourd’hui.");
    renderDashboardEvents(panel.querySelector('[data-dashboard-events="upcoming"]'), upcomingEvents, "Aucun rendez-vous prévu dans les 7 prochains jours.");
}

async function loadDashboardEvents() {
    const start = toDashboardDate(new Date());
    const end = toDashboardDate(addDashboardDays(new Date(), 6));
    try {
        const response = await fetch(`/api/calendar/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`, { credentials: "same-origin" });
        const data = await response.json().catch(() => null);
        return response.ok ? { ok: true, events: data?.events || [] } : { ok: false, events: [], message: data?.message };
    } catch {
        return { ok: false, events: [], message: "Serveur indisponible." };
    }
}

function renderMobileUserSections() {
    if (!isMobileDeviceContext() || !["technician", "team_lead"].includes(document.body.dataset.role)) return "";
    let sections = [];
    try { sections = JSON.parse(document.body.dataset.userDepartments || "[]"); } catch { sections = []; }
    return sections.length ? `<div class="mobile-dashboard-sections"><strong>Sections métier</strong>${sections.map(section => `<span>${escapeHtml(section)}</span>`).join("")}</div>` : "";
}

function renderDashboardEvents(container, events, emptyMessage) {
    if (!events.length) {
        container.innerHTML = `<p class="muted">${escapeHtml(emptyMessage)}</p>`;
        return;
    }
    container.innerHTML = "";
    events.sort((first, second) => `${first.date}${first.startTime || "00:00"}`.localeCompare(`${second.date}${second.startTime || "00:00"}`)).forEach(event => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `dashboard-event color-${escapeHtml(event.color || "blue")}`;
        const date = event.date === toDashboardDate(new Date()) ? "Aujourd’hui" : formatDashboardDate(new Date(`${event.date}T12:00:00`));
        button.innerHTML = `<time>${escapeHtml(`${date}${event.startTime ? ` · ${event.startTime}` : ""}`)}</time><strong>${escapeHtml(event.title)}</strong>${event.clientName ? `<span>${escapeHtml(event.clientName)}</span>` : ""}${event.location ? `<small>${escapeHtml(event.location)}</small>` : ""}`;
        button.addEventListener("click", () => renderCalendar({ date: new Date(`${event.date}T12:00:00`), event }));
        container.appendChild(button);
    });
}

function addDashboardDays(date, amount) {
    const result = new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount, 12);
    return result;
}

function toDashboardDate(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatDashboardDate(date) {
    return new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" }).format(date);
}

function renderBrandCategories() {
    resetSelection("brand");
    setPage(state.brand.name, ROUTES.home);

    const container = getContainer();
    container.appendChild(createBackCard("Retour aux gammes", renderBrands));
    const categories = Array.isArray(state.brand?.categories) ? state.brand.categories : [];

    if (!categories.length) {
        container.appendChild(createInfo("Aucune marque disponible pour le moment. Le catalogue est prêt à être enrichi."));
        return;
    }

    const grid = document.createElement("section");
    grid.className = "motor-catalog-grid motor-brand-grid";
    categories.forEach(category => {
        grid.appendChild(
            createCard(
                "",
                category.name,
                "Gamme",
                () => {
                    state.category = category;
                    renderCategoryOverview();
                }
            )
        );
    });
    container.appendChild(grid);
}

function renderCategoryOverview() {
    resetSelection("category");
    setPage(state.category.name, ROUTES.home);

    const container = getContainer();
    container.appendChild(createBackCard("Retour aux marques", renderBrandCategories));

    const products = Array.isArray(state.category.products) ? state.category.products : [];
    if (!products.length) {
        container.appendChild(createInfo(`${state.category.name} est prêt à être enrichi avec les références produits.`));
        return;
    }

    const grid = document.createElement("section");
    grid.className = "motor-catalog-grid motor-product-grid";
    products.forEach((product, productIndex) => {
        const ref = {
            type: "product",
            brandIndex: database.brands.indexOf(state.brand),
            categoryIndex: state.brand.categories.indexOf(state.category),
            productIndex
        };

        grid.appendChild(createCard(
            "",
            product.name,
            product.reference || "Référence à préciser",
            () => {
                state.product = product;
                renderProductOverview();
            },
            { image: getRefPhoto(ref) }
        ));
    });
    container.appendChild(grid);
}

function renderProductOverview() {
    resetSelection("product");
    setPage(state.product.name, ROUTES.home);

    const container = getContainer();
    container.appendChild(createBackCard("Retour à la marque", renderCategoryOverview));
    container.appendChild(createInfo(`${state.product.name} est prêt à être enrichi. Notices disponibles ci-dessous si présentes.`));

    const documents = Array.isArray(state.product.documents) ? state.product.documents : [];

    if (state.product.displayAsVisualGallery && documents.length) {
        const section = document.createElement("section");
        section.className = "procedure-section";

        const heading = document.createElement("h3");
        heading.textContent = "Astuces en image";
        section.appendChild(heading);

        const gallery = document.createElement("div");
        gallery.className = "document-preview-gallery";

        documents.forEach(documentPath => {
            const fileName = documentPath.split("/").pop() || documentPath;
            const previewName = fileName.replace(/\.pdf$/i, ".png");
            const previewPath = `${state.product.previewDirectory}/${previewName}`;

            const link = document.createElement("a");
            link.className = "document-preview-card";
            link.href = documentPath;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.title = "Ouvrir le guide PDF";

            const image = document.createElement("img");
            image.src = previewPath;
            image.alt = fileName.replace(/[_-]+/g, " ").replace(/\.pdf$/i, "");
            image.loading = "lazy";

            const label = document.createElement("span");
            label.textContent = image.alt;

            link.append(image, label);
            gallery.appendChild(link);
        });

        section.appendChild(gallery);
        container.appendChild(section);
    }

    if (!state.product.displayAsVisualGallery && documents.length) {
        const section = document.createElement("section");
        section.className = "procedure-section";

        const heading = document.createElement("h3");
        heading.textContent = "Notices et documents";
        section.appendChild(heading);

        const list = document.createElement("ul");
        documents.forEach(documentPath => {
            const item = document.createElement("li");
            const link = document.createElement("a");
            link.href = documentPath;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.textContent = documentPath.split("/").pop() || documentPath;
            item.appendChild(link);
            list.appendChild(item);
        });

        section.appendChild(list);
        container.appendChild(section);
    }

    if (Array.isArray(state.product.photos) && state.product.photos.length) {
        const section = document.createElement("section");
        section.className = "procedure-section";

        const heading = document.createElement("h3");
        heading.textContent = "Photos et visuels";
        section.appendChild(heading);

        const gallery = document.createElement("div");
        gallery.className = "photo-gallery";

        state.product.photos.forEach(photoPath => {
            const item = document.createElement("div");
            item.className = "photo-gallery-item";

            const link = document.createElement("a");
            link.href = photoPath;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.title = photoPath.split("/").pop() || photoPath;

            const image = document.createElement("img");
            image.src = photoPath;
            image.alt = photoPath.split("/").pop() || "Photo";
            image.loading = "lazy";
            image.className = "product-photo";

            link.appendChild(image);
            item.appendChild(link);
            gallery.appendChild(item);
        });

        section.appendChild(gallery);
        container.appendChild(section);
    }
}

async function renderSearchResults(query) {
    const currentRequestId = ++searchRequestId;
    resetSelection("all");
    setPage("Résultats de recherche", ROUTES.search);

    const container = getContainer();
    const canSearchLibrary = canAccessRoute(ROUTES.library);
    const canSearchClients = canAccessRoute(ROUTES.clients);
    const canSearchCalendar = canAccessRoute(ROUTES.calendar);
    const includeTechnical = canSearchLibrary;
    container.appendChild(createInfo(includeTechnical ? "Recherche dans vos modules, clients, interventions et bibliothèque technique…" : "Recherche dans les fonctions et données accessibles à votre poste…"));

    const [privateLibrary, events] = await Promise.all([
        canSearchLibrary ? searchPersonalLibrary(query) : Promise.resolve({ sections: [], documents: [] }),
        canSearchCalendar ? loadSearchEvents() : Promise.resolve([])
    ]);
    if (currentRequestId !== searchRequestId || document.getElementById("search")?.value.toLowerCase().trim() !== query) return;

    const libraryResults = [
        ...(privateLibrary.sections || []).map(section => ({
            type: "librarySection",
            title: section.name,
            subtitle: "Bibliothèque privée — Section",
            sectionId: section.id,
            score: 80
        })),
        ...(privateLibrary.documents || []).map(document => ({
            type: "libraryDocument",
            title: document.title,
            subtitle: `Document privé — ${document.sectionName} · ${document.originalFilename}`,
            documentId: document.id,
            score: 95
        }))
    ];
    const results = [...getContextualSearchResults(database, query, {
        modules: getSearchModules(),
        includeClients: canSearchClients,
        includeTechnical,
        events
    }), ...libraryResults]
        .sort((first, second) => (second.score || 0) - (first.score || 0))
        .slice(0, 40);

    container.innerHTML = "";

    if (!results.length) {
        container.appendChild(createInfo("Aucun résultat accessible trouvé. Essayez un nom de module, un client, une intervention ou un mot-clé autorisé."));
        return;
    }

    results.forEach(result => {
        container.appendChild(
            createCard(
                "",
                result.title,
                result.type === "document" ? `${result.subtitle} · Document PDF` : result.subtitle,
                () => {
                    if (result.type === "module") {
                        result.open();
                        return;
                    }

                    if (result.type === "event") {
                        renderCalendar({ date: new Date(`${result.event.date}T12:00:00`), event: result.event });
                        return;
                    }

                    if (result.type === "document") {
                        window.open(result.documentPath, "_blank", "noopener,noreferrer");
                        return;
                    }

                    if (result.type === "libraryDocument") {
                        window.open(`/api/library/documents/${encodeURIComponent(result.documentId)}/download`, "_blank", "noopener,noreferrer");
                        return;
                    }

                    if (result.type === "librarySection") {
                        openLibrarySection(result.sectionId);
                        return;
                    }

                    if (result.type === "client" || result.type === "clientAttachment") {
                        renderClients({ selectedId: result.clientId, database, navigateToRef, createBillingDocument: createBillingDocumentForClient, createCalendarEvent: createCalendarEventForClient });
                        return;
                    }

                    navigateToRef(result.ref);
                },
                { image: getRefPhoto(result.ref) }
            )
        );
    });
}

function getSearchModules() {
    const modules = [];
    const add = (title, keywords, route, open) => {
        if (route && !canAccessRoute(route)) return;
        modules.push({ title, subtitle: `Module — ${title}`, keywords, open });
    };
    add("Clients", "client dossier contact fiche client", ROUTES.clients, () => openClients());
    add("Messagerie client", "messagerie message messages note échange discussion", ROUTES.clients, () => openClients());
    add("Planning", "planning agenda rendez vous intervention calendrier", ROUTES.calendar, openCalendar);
    if (document.body.dataset.technicianBillingEnabled !== "false") add("Devis et factures", "devis facture document commercial facturation", ROUTES.billing, renderBilling);
    add("Rapports de recherche de fuite", "rapport rapports fuite technique intervention", ROUTES.technicalReports, renderTechnicalReports);
    add("Missions partenaires", "mission partenaire réseau intervention externe", ROUTES.partnerMissions, renderPartnerMissions);
    add("Espace e-mail de l’entreprise", "email e-mail mail messagerie boîte professionnelle", ROUTES.companyEmail, renderCompanyEmail);
    add("Bibliothèque technique", "bibliothèque notice procédure moteur automatisme télécommande schéma diagnostic portail volet roulant porte garage serrure pièce détachée", ROUTES.library, renderLibrary);
    add("Comptabilité et facturation électronique & PDP", "comptabilité facturation électronique pdp export comptable facture", ROUTES.accounting, renderAccounting);
    add("Réseau Depann'Home Pro", "réseau partenaire partenaires api connexion annuaire", ROUTES.settings, () => renderSettings({ section: "network" }));
    if (organizationFeatureEnabled("partnerMissions")) add("Boîte mail de l’entreprise", "entreprise boîte mail email missions connexion imap smtp", ROUTES.settings, () => renderSettings({ section: "company" }));
    add("Modèles de documents", "modèle devis rapport quitus document logo", ROUTES.settings, () => renderSettings({ section: "documents" }));
    add("Utilisateurs", "utilisateur équipe technicien chef équipe poste pc droit accès", ROUTES.settings, () => renderSettings({ section: "users" }));
    add("Sécurité", "sécurité double authentification 2fa sms accès", ROUTES.settings, () => renderSettings({ section: "security" }));
    if (document.body.dataset.groupAdmin === "true") add("Groupe / Multi-entreprises", "groupe multi entreprises société", ROUTES.groups, renderGroupWorkspace);
    add("Importation de données", "import importation excel csv clients devis factures rapports", ROUTES.settings, () => renderSettings({ section: "imports" }));
    return modules;
}

async function loadSearchEvents() {
    if (searchEventsCache.expiresAt > Date.now()) return searchEventsCache.events;
        if (searchEventsPromise) return searchEventsPromise;
    const start = toDashboardDate(new Date());
    const end = toDashboardDate(addDashboardDays(new Date(), 90));
        searchEventsPromise = (async () => {
            try {
        const response = await fetch(`/api/calendar/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`, { credentials: "same-origin" });
        const data = response.ok ? await response.json() : null;
        searchEventsCache = { events: data?.events || [], expiresAt: Date.now() + SEARCH_EVENTS_TTL };
            } catch {
        searchEventsCache = { events: [], expiresAt: Date.now() + 5_000 };
            } finally {
                searchEventsPromise = null;
            }
            return searchEventsCache.events;
        })();
        return searchEventsPromise;
}

function updateSearchPlaceholder() {
    const search = document.getElementById("search");
    if (!search) return;
    search.placeholder = canAccessRoute(ROUTES.library)
        ? "Rechercher un module, client, intervention, notice…"
        : "Rechercher un module, un client ou une intervention…";
}

function getRefPhoto(ref) {
    if (ref?.type !== "product") return "";
    const product = resolveRef(ref).product;
    return Array.isArray(product?.photos) && product.photos.length ? product.photos[0] : "";
}

function renderSettings(options = {}) {
    if (!canAccessRoute(ROUTES.settings)) {
        openHome();
        return;
    }
    if (!options.legacy) {
        renderSettingsWorkspace(options);
        return;
    }
    clearSearch();
    resetSelection("all");
    setPage("Paramètres", ROUTES.settings, "detail");

    const container = getContainer();
    const card = document.createElement("article");
    card.className = "brand-card full-card procedure-card settings-card";

    card.innerHTML = '<div class="settings-heading"><div><p class="eyebrow">Application PC</p><h2>Paramètres</h2><p class="muted">Personnalisez l’affichage et le fonctionnement de votre espace de travail.</p></div></div>';

    // settings form
    const settings = getSettings();

    const section = document.createElement("section");
    section.className = "procedure-section settings-section";

    const form = document.createElement("div");
    form.className = "settings-form";
    const fields = document.createElement("div");
    fields.className = "settings-fields";

    // max history
    const maxLabel = document.createElement("label");
    maxLabel.className = "settings-field";
    maxLabel.textContent = "Taille de l'historique (max)";
    const maxInput = document.createElement("input");
    maxInput.type = "number";
    maxInput.min = "1";
    maxInput.value = settings.maxHistory || DEFAULT_SETTINGS.maxHistory;
    maxLabel.appendChild(maxInput);

    // theme select
    const themeLabel = document.createElement("label");
    themeLabel.className = "settings-field";
    themeLabel.textContent = "Thème";
    const themeSelect = document.createElement("select");
    const optLight = document.createElement("option"); optLight.value = "light"; optLight.text = "Clair";
    const optDark = document.createElement("option"); optDark.value = "dark"; optDark.text = "Sombre";
    themeSelect.appendChild(optLight);
    themeSelect.appendChild(optDark);
    themeSelect.value = settings.theme || DEFAULT_SETTINGS.theme;
    themeLabel.appendChild(themeSelect);

    // font select
    const fontLabel = document.createElement("label");
    fontLabel.className = "settings-field";
    fontLabel.textContent = "Police";
    const fontSelect = document.createElement("select");
    FONT_OPTIONS.forEach(opt => {
        const o = document.createElement("option");
        o.value = opt.id; o.text = opt.label;
        fontSelect.appendChild(o);
    });
    fontSelect.value = settings.font || DEFAULT_SETTINGS.font;
    fontLabel.appendChild(fontSelect);

    // language select
    const langLabel = document.createElement("label");
    langLabel.className = "settings-field";
    langLabel.textContent = "Langue";
    const langSelect = document.createElement("select");
    LANG_OPTIONS.forEach(opt => {
        const o = document.createElement("option");
        o.value = opt.id; o.text = opt.label;
        langSelect.appendChild(o);
    });
    langSelect.value = settings.lang || DEFAULT_SETTINGS.lang;
    langLabel.appendChild(langSelect);

    // show offline badge
    const offlineLabel = document.createElement("label");
    offlineLabel.className = "settings-toggle";
    offlineLabel.textContent = "Montrer l'état hors-ligne";
    const offlineCheckbox = document.createElement("input");
    offlineCheckbox.type = "checkbox";
    offlineCheckbox.checked = settings.showOfflineBadge !== false;
    offlineLabel.appendChild(offlineCheckbox);

    const pcSeatsHint = document.createElement("p");
    pcSeatsHint.className = "muted settings-info";
    pcSeatsHint.textContent = `Postes PC inclus dans votre offre : ${document.body.dataset.maxPcUsers || "1"}. Les postes supplémentaires sont activés par Depann’Home Pro, puis validés dans la section Équipe.`;

    // actions
    const actions = document.createElement("div");
    actions.className = "settings-actions";

    const saveBtn = createButton("Enregistrer", "secondary-button", () => {
        const newSettings = {
            maxHistory: Math.max(1, parseInt(maxInput.value || DEFAULT_SETTINGS.maxHistory, 10)),
            theme: themeSelect.value === "dark" ? "dark" : "light",
            showOfflineBadge: !!offlineCheckbox.checked,
            font: fontSelect.value,
            lang: langSelect.value
        };
        saveSettings(newSettings);
        // apply theme immediately
        document.body.classList.toggle("dark-theme", newSettings.theme === "dark");
        // apply font immediately
        const font = FONT_OPTIONS.find(f => f.id === newSettings.font) || FONT_OPTIONS[0];
        document.body.style.fontFamily = font && font.css ? font.css : "";
        // apply language immediately (update some static strings)
        document.documentElement.lang = newSettings.lang || 'fr';
        const lang = newSettings.lang || 'fr';
        const subtitle = lang === 'en' ? "Professional troubleshooting assistant" : "Assistant de dépannage professionnel";
        const searchPlaceholder = lang === 'en' ? "Search a brand, range or product..." : "Rechercher une marque, une gamme ou un produit...";
        const headerP = document.querySelector('header .header-content p');
        if (headerP) headerP.textContent = subtitle;
        const search = document.getElementById('search'); if (search) search.placeholder = searchPlaceholder;
        const texts = lang === "en"
            ? { home: "Home", search: "Search", store: "Store", photo: "Photo", clients: "Clients", billing: "Quotes", purchases: "Purchases", calendar: "Planning", library: "Library", settings: "Settings" }
            : { home: "Accueil", search: "Recherche", store: "Magasin", photo: "Photo", clients: "Clients", billing: "Devis", purchases: "Achats", calendar: "Planning", library: "Bibliothèque", settings: "Paramètres" };
        document.querySelectorAll("footer .nav-button").forEach(button => {
            const label = button.querySelector(".nav-label-clients") || button.querySelector("span");
            if (label) label.textContent = texts[button.dataset.nav] || label.textContent;
        });
        renderSettings({ section: "personalization" });
    });

    const resetBtn = createButton("Réinitialiser", "secondary-button", () => {
        if (!confirm("Réinitialiser tous les paramètres de l’application ?")) return;
        saveSettings(DEFAULT_SETTINGS);
        document.body.classList.toggle("dark-theme", DEFAULT_SETTINGS.theme === "dark");
        const font = FONT_OPTIONS.find(f => f.id === DEFAULT_SETTINGS.font) || FONT_OPTIONS[0];
        document.body.style.fontFamily = font && font.css ? font.css : "";
        document.documentElement.lang = DEFAULT_SETTINGS.lang || 'fr';
        renderSettings({ section: "personalization" });
    });

    actions.appendChild(saveBtn);
    actions.appendChild(resetBtn);

    fields.append(maxLabel, themeLabel, fontLabel, langLabel, offlineLabel);
    form.appendChild(fields);
    if (document.body.dataset.role === "admin") {
        form.appendChild(pcSeatsHint);
    }
    form.appendChild(actions);

    section.appendChild(form);
    card.appendChild(section);

    container.appendChild(card);
    if (!options.personalizationOnly && document.body.dataset.role === "admin") {
        renderTeamManagement(container);
        renderCompanyTwoFactorSecurity(container);
    }
    if (!options.personalizationOnly && document.body.dataset.role === "admin" && organizationFeatureEnabled("partnerConnections")) renderPartnerConnections(container);
    if (!options.personalizationOnly && document.body.dataset.groupAdmin === "true") {
        const groupCard = document.createElement("article");
        groupCard.className = "brand-card full-card procedure-card creator-entry-card";
        groupCard.innerHTML = '<p class="eyebrow">Multi-entreprises</p><h2>Groupe & entreprises</h2><p>Changez d’entreprise, pilotez les sociétés du groupe et consultez les indicateurs consolidés.</p>';
        groupCard.appendChild(createButton("Ouvrir le pilotage Groupe", "secondary-button", renderGroupWorkspace));
        container.appendChild(groupCard);
    } else if (!options.personalizationOnly && document.body.dataset.role === "admin") renderGroupActivation(container);
    if (!options.personalizationOnly && document.body.dataset.creator === "true" && document.body.dataset.deviceType === "desktop") {
        const creatorCard = document.createElement("article");
        creatorCard.className = "brand-card full-card procedure-card creator-entry-card";
        creatorCard.innerHTML = '<p class="eyebrow">Administration plateforme</p><h2>Console Créateur</h2>';
        creatorCard.appendChild(createButton("Ouvrir la console Créateur", "secondary-button", renderCreatorConsole));
        container.appendChild(creatorCard);
    }
    if (!options.personalizationOnly && document.body.dataset.role === "admin" && document.body.classList.contains("desktop-device")) {
        if (organizationFeatureEnabled("technicalReports")) renderReportTemplateSettings(container);
        renderDataImportTool(container);
        renderSupportContact(container);
        if (options.focusReportTemplate) window.requestAnimationFrame(() => document.getElementById("reportTemplateSettings")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
}

function renderSettingsWorkspace(options = {}) {
    const section = options.section || (options.focusReportTemplate ? "documents" : "");
    if (section && !canAccessSettingsSection(section)) {
        renderSettings();
        return;
    }
    if (!section) {
        clearSearch();
        resetSelection("all");
        setPage("Paramètres", ROUTES.settings, "detail");
        const container = getContainer();
        const hub = document.createElement("section");
        hub.className = "settings-hub";
        const internalNetworkOnly = document.body.dataset.organizationInterface === "partner" || !organizationFeatureEnabled("connectors");
        hub.innerHTML = `<header class="settings-hub-heading"><div><p class="eyebrow">${internalNetworkOnly ? "Réseau et assistance" : "Configuration de l’entreprise"}</p><h2>Paramètres</h2><p class="muted">${internalNetworkOnly ? "Retrouvez le Réseau Depann’Home Pro et contactez directement le Support." : "Toutes les configurations sont regroupées ici. Le menu principal reste dédié aux opérations quotidiennes."}</p></div></header>`;
        const grid = document.createElement("div");
        grid.className = "settings-card-grid";
        const cards = [
            ...(document.body.dataset.role === "admin" ? [["subscription", "Offre & abonnement", "Consultez les tarifs et demandez une évolution ou une rétrogradation au Support.", "subscription"]] : []),
            ...(document.body.dataset.role === "admin" ? [["documents", "Modèles de documents", `Identité, présentation et modèles des devis${organizationFeatureEnabled("quitus") ? ", quitus" : ""} et rapports.`, "document"]] : []),
            ...(document.body.dataset.role === "admin" && organizationFeatureEnabled("accounting") ? [["electronicInvoicing", "Facturation électronique", "Choisissez et configurez la plateforme propre à votre entreprise.", "document"]] : []),
            ...(organizationFeatureEnabled("companyEmail") && document.body.dataset.role === "admin" ? [["company", "Entreprise · Boîte mail", "Connectez la boîte de l’entreprise et choisissez si elle recherche automatiquement les missions.", "company"]] : []),
            ["network", internalNetworkOnly ? "Réseau Depann’Home Pro" : "Réseau & connecteurs", internalNetworkOnly ? "Recherchez des entreprises utilisatrices et gérez vos connexions internes." : "Deux espaces distincts : le réseau collaboratif Depann’Home Pro et les connecteurs API externes.", "network"],
            ...(internalNetworkOnly ? [["support", "Support", "Envoyez une demande à l’équipe Depann’Home Pro depuis votre compte partenaire.", "support"]] : []),
            ...(document.body.dataset.role === "admin" ? [["users", "Utilisateurs", "Accès, postes, techniciens et chefs d’équipe.", "users"], ["security", "Sécurité", "Double authentification et protection des accès.", "security"], ["groups", "Groupe / Multi-entreprises", "Sociétés, bascule de contexte et indicateurs consolidés.", "group"]] : []),
            ["personalization", "Personnalisation", "Langue, thème, police et préférences d’affichage.", "appearance"],
            ...(document.body.dataset.role === "admin" && document.body.classList.contains("desktop-device") ? [["imports", "Importation de données", "Importez vos clients, devis, factures et rapports depuis Excel ou CSV.", "import"]] : []),
            ...(document.body.dataset.role === "admin" && document.body.dataset.creator === "true" && document.body.dataset.deviceType === "desktop" ? [["creator", "Console Créateur", "Pilotage des entreprises, abonnements et services de la plateforme.", "creator"]] : [])
        ];
        cards.filter(([id]) => canAccessSettingsSection(id)).forEach(([id, title, description, icon]) => grid.appendChild(createSettingsNavigationCard(title, description, icon, () => renderSettings({ section: id }))));
        hub.appendChild(grid);
        container.appendChild(hub);
        return;
    }

    clearSearch();
    resetSelection("all");
    const titles = { subscription: "Offre & abonnement", documents: "Modèles de documents", electronicInvoicing: "Facturation électronique", company: "Entreprise · Boîte mail", network: document.body.dataset.organizationInterface === "partner" || !organizationFeatureEnabled("connectors") ? "Réseau Depann’Home Pro" : "Réseau & connecteurs", support: "Support", users: "Utilisateurs", security: "Sécurité", groups: "Groupe / Multi-entreprises", personalization: "Personnalisation", imports: "Importation de données", creator: "Console Créateur" };
    setPage(`Paramètres · ${titles[section] || "Configuration"}`, ROUTES.settings, "detail");
    const container = getContainer();
    container.appendChild(createBackCard("Retour aux Paramètres", () => renderSettings()));

    if (section === "subscription") return renderSubscriptionSettings(container);
    if (section === "electronicInvoicing") return renderElectronicInvoicingConfiguration(container);
    if (section === "documents") {
        const intro = createSettingsIntro("Modèles de documents");
        const grid = document.createElement("div");
        grid.className = "settings-subsection-grid";
        grid.append(createSettingsNavigationCard("Modèle de devis et facture", "Modifier le modèle intégré ou importer la base devis de l’entreprise ; la facture hérite automatiquement du devis", "document", () => openDocumentTemplateSettings("quote")));
        if (organizationFeatureEnabled("quitus")) grid.append(createSettingsNavigationCard("Modèle de quitus", "Modifier le modèle intégré ou importer la base quitus de l’entreprise", "document", () => openDocumentTemplateSettings("quitus")));
        if (organizationFeatureEnabled("technicalReports")) grid.append(createSettingsNavigationCard("Modèle de rapport", "Modifier le modèle intégré ou importer la base rapport de l’entreprise", "document", () => openDocumentTemplateSettings("report")));
        intro.appendChild(grid);
        container.appendChild(intro);
        return;
    }
    if (section === "company") {
        container.appendChild(createSettingsIntro("Boîte mail de l’entreprise", "Connectez une boîte dédiée aux demandes d’intervention. Seuls les e-mails détectés comme missions apparaissent dans Missions partenaires ; les autres messages restent privés."));
        renderPartnerEmailSettings(container);
        if (options.focusPartnerEmail) window.requestAnimationFrame(() => document.querySelector(".partner-email-settings-card")?.scrollIntoView({ behavior: "smooth", block: "start" }));
        return;
    }
    if (section === "network") {
        const internalNetworkOnly = document.body.dataset.organizationInterface === "partner" || !organizationFeatureEnabled("connectors");
        container.appendChild(createSettingsIntro(internalNetworkOnly ? "Réseau Depann’Home Pro" : "Réseau & connecteurs", internalNetworkOnly ? "Recherchez une entreprise utilisatrice, consultez sa fiche et demandez une connexion. Les connecteurs externes sont réservés aux donneurs d’ordre et ne sont pas disponibles sur le portail Partenaire." : "Le Réseau Depann’Home Pro relie uniquement les entreprises utilisatrices. Les connecteurs externes sont configurés séparément pour les échanges API avec les organismes tiers."));
        if (organizationFeatureEnabled("partnerConnections")) renderPartnerConnections(container);
        if (!internalNetworkOnly && document.body.classList.contains("partner-sandbox-enabled")) container.appendChild(createButton("Ouvrir l’environnement de recette partenaire", "secondary-button settings-inline-action", renderPartnerSandbox));
        return;
    }
    if (section === "support") return renderSupportContact(container);
    if (section === "users") return renderTeamManagement(container);
    if (section === "security") {
        renderCompanyTwoFactorSecurity(container);
        container.appendChild(createSettingsIntro("Évolutions de sécurité", "Les réglages de fournisseurs SMS et les futures options d’activation de comptes seront regroupés dans cet espace."));
        return;
    }
    if (section === "groups") {
        if (document.body.dataset.groupAdmin === "true") renderGroupWorkspace();
        else renderGroupActivation(container);
        return;
    }
    if (section === "imports") {
        if (!document.body.classList.contains("desktop-device")) return renderSettings();
        container.appendChild(createSettingsIntro("Importation de données", "Importez en toute sécurité vos clients, devis, factures et rapports à partir de fichiers Excel ou CSV."));
        renderDataImportTool(container);
        return;
    }
    if (section === "creator") {
        if (document.body.dataset.creator !== "true" || document.body.dataset.deviceType !== "desktop") return renderSettings();
        renderCreatorConsole();
        return;
    }
    renderSettings({ legacy: true, personalizationOnly: true });
}

async function renderSubscriptionSettings(container) {
    const tiers = [
        { id: "basic", label: "Basic", pc: 20, mobile: 5, description: "Postes PC et Administrateur Mobile. Clients, facturation, comptabilité et PDP. Bibliothèque sur mobile ; Achats sur tous les PC et l’Administrateur Mobile." },
        { id: "basic_plus", label: "Basic+", pc: 35, mobile: 8, description: "Tous postes PC et mobiles. Basic avec planning, imports de données, missions, messagerie et dossiers du Réseau Depann’Home Pro interne. Bibliothèque sur mobile ; Achats sur tous les PC et l’Administrateur Mobile. Sans connecteurs ni connexions API externes." },
        { id: "pro", label: "Pro", pc: 70, mobile: 15, description: "Tous postes et accès complet. Bibliothèque sur mobile ; Achats sur tous les PC et l’Administrateur Mobile ; Quitus, rapports, Réseau, API et imports. Licences Groupe d’entreprise / Multi-entreprises incluses sans supplément de licence." }
    ];
    const rank = { basic: 0, basic_plus: 1, pro: 2 };
    const result = await fetch("/api/subscription-change-requests", { credentials: "same-origin" });
    const data = await result.json().catch(() => ({}));
    const requests = result.ok ? data.requests || [] : [];
    const account = result.ok && data.account ? data.account : {};
    const currentTier = ["basic", "basic_plus", "pro"].includes(account.subscriptionTier) ? account.subscriptionTier : document.body.dataset.subscriptionTier || "pro";
    const currentPcSeats = Math.max(1, Number(account.maxPcUsers ?? document.body.dataset.maxPcUsers) || 1);
    const currentMobileSeats = Math.max(0, Number(account.maxMobileUsers ?? document.body.dataset.maxMobileUsers) || 0);
    const currentOffer = tiers.find(tier => tier.id === currentTier) || tiers[2];
    const totalCents = Math.max(0, Number(account.monthlyPriceCents) || 0) || (currentPcSeats * currentOffer.pc + currentMobileSeats * currentOffer.mobile) * 100;
    const latestInvoice = account.latestInvoice || null;
    const subscriptionStatus = subscriptionBillingStatus(account.subscriptionStatus);
    const renewalDate = formatSubscriptionBillingDate(account.subscriptionRenewalDate);
    const invoiceAmountCents = Math.max(0, Number(latestInvoice?.netAmountCents ?? latestInvoice?.amountCents) || 0);
    const creditedAmountCents = Math.max(0, Number(latestInvoice?.creditedAmountCents) || 0);
    const paidAmountCents = Math.max(0, Number(latestInvoice?.paidAmountCents) || 0);
    const pendingRefundCents = Math.max(0, Number(latestInvoice?.pendingRefundCents) || 0);
    const outstandingAmountCents = Math.max(0, Number(latestInvoice?.outstandingAmountCents ?? invoiceAmountCents) || 0);
    const formatSubscriptionAmount = amountCents => (amountCents / 100).toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
    const invoiceBalanceLabel = !latestInvoice
        ? "Aucun montant facturé à ce jour"
        : pendingRefundCents
            ? `0 € restant à payer · remboursement de ${formatSubscriptionAmount(pendingRefundCents)} à recevoir`
            : latestInvoice.paymentStatus === "paid"
                ? creditedAmountCents
                    ? `0 € restant à payer · ${formatSubscriptionAmount(paidAmountCents)} réglés et avoir de ${formatSubscriptionAmount(creditedAmountCents)} déduit`
                    : `0 € restant à payer · ${formatSubscriptionAmount(paidAmountCents || invoiceAmountCents)} réglés`
            : creditedAmountCents
                ? outstandingAmountCents
                    ? `${formatSubscriptionAmount(outstandingAmountCents)} restant à payer · avoir de ${formatSubscriptionAmount(creditedAmountCents)} déduit`
                    : `0 € restant à payer · facture couverte par un avoir de ${formatSubscriptionAmount(creditedAmountCents)}`
                : `${formatSubscriptionAmount(outstandingAmountCents)} TTC restant à payer`;
    document.body.dataset.subscriptionTier = currentTier;
    document.body.dataset.maxPcUsers = String(currentPcSeats);
    document.body.dataset.maxMobileUsers = String(currentMobileSeats);
    document.body.dataset.monthlyPriceCents = String(totalCents);
    const section = document.createElement("section");
    section.className = "creator-form subscription-company-panel";
    section.innerHTML = `<div class="form-heading"><div><p class="eyebrow">Offre actuelle : ${escapeHtml(currentOffer.label)}</p><h2>Offres Depann’Home Pro</h2></div></div><div class="creator-subscription-summary"><article><span>Postes PC autorisés</span><strong>${currentPcSeats}</strong></article><article><span>Postes mobiles autorisés</span><strong>${currentMobileSeats}</strong></article><article><span>Tarif total actuel</span><strong>${(totalCents / 100).toLocaleString("fr-FR", { style: "currency", currency: "EUR" })} TTC / mois</strong></article></div><p class="muted">Les tarifs mensuels sont calculés par poste. Une demande n’altère aucune donnée et ne change pas automatiquement votre offre : elle est transmise au Support pour étude.</p><div class="subscription-offers-grid">${tiers.map(tier => `<article class="subscription-offer-card${tier.id === currentTier ? " active" : ""}"><header><strong>${tier.label}</strong>${tier.id === currentTier ? '<span class="creator-state">Offre actuelle</span>' : ""}</header><p class="subscription-offer-price"><b>${tier.pc} € TTC</b> / poste PC / mois<br><b>${tier.mobile} € TTC</b> / poste mobile / mois</p><p>${tier.description}</p>${tier.id === currentTier ? "" : `<button type="button" class="secondary-button" data-request-tier="${tier.id}">Demander ${rank[tier.id] > rank[currentTier] ? "l’évolution" : "la rétrogradation"}</button>`}</article>`).join("")}</div><form data-seat-request class="creator-subscription-fields subscription-seat-request"><h3>Demander des postes supplémentaires</h3><div class="form-grid"><label>Postes PC souhaités<input name="requestedPcSeats" type="number" min="${currentPcSeats}" max="100" value="${currentPcSeats}" required></label><label>Postes mobiles souhaités<input name="requestedMobileSeats" type="number" min="${currentMobileSeats}" max="500" value="${currentMobileSeats}" required></label></div><button class="secondary-button">Transmettre la demande au Support</button></form><label class="form-wide subscription-support-message">Message facultatif au Support<textarea rows="4" maxlength="1000" data-subscription-request-message placeholder="Précisez votre besoin ou la date souhaitée."></textarea></label><p class="auth-message" data-subscription-request-feedback aria-live="polite"></p><section class="subscription-request-history"><h3>Demandes envoyées</h3><div class="creator-network-list">${requests.length ? requests.map(item => `<article class="creator-network-company"><div><strong>${escapeHtml(tiers.find(tier => tier.id === item.requestedTier)?.label || item.requestedTier)}</strong><p>${escapeHtml(subscriptionRequestStatusLabel(item.status))}${item.requestedPcSeats != null ? ` · ${item.requestedPcSeats} PC / ${item.requestedMobileSeats} mobile(s)` : ""}</p><small>${escapeHtml(formatSubscriptionRequestDate(item.createdAt))}</small></div></article>`).join("") : '<p class="muted">Aucune demande envoyée.</p>'}</div></section>`;
    section.querySelector(".subscription-offers-grid")?.insertAdjacentHTML("afterend", '<article class="settings-info-card"><h3>Licence Partenaire gratuite</h3><p>Le Portail Partenaire est distinct de l’abonnement Pro payant : aucun abonnement mensuel, aucune échéance et aucune facture. Son niveau technique Pro inclut un poste Administrateur PC, aucun poste mobile, ainsi que les espaces Clients et Missions partenaires avec leur messagerie contextuelle.</p></article>');
    const billingPanel = document.createElement("section");
    billingPanel.className = "subscription-billing-panel";
    billingPanel.innerHTML = `
        <div class="form-heading"><div><p class="eyebrow">Facturation de l’abonnement</p><h3>Échéances et dernière facture</h3></div><span class="subscription-billing-status ${escapeHtml(subscriptionStatus.className)}">${escapeHtml(subscriptionStatus.label)}</span></div>
        <div class="subscription-billing-grid">
            <article><span>Prochaine facturation</span><strong>${escapeHtml(renewalDate || "Date à confirmer")}</strong><small>${account.subscriptionPlan === "paid" ? "Échéance mensuelle programmée" : "Aucune facturation automatique programmée"}</small></article>
            <article><span>Dernière facture</span><strong>${escapeHtml(latestInvoice?.invoiceNumber || "Aucune facture émise")}</strong><small>${latestInvoice ? `${escapeHtml(formatSubscriptionBillingDate(latestInvoice.issueDate))} · ${latestInvoice.paymentStatus === "paid" ? `Réglée le ${escapeHtml(formatSubscriptionBillingDate(latestInvoice.paidDate))}` : escapeHtml(subscriptionInvoiceStatus(latestInvoice.status))}` : "La première facture apparaîtra ici après son émission."}</small></article>
            <article><span>Échéance de paiement</span><strong>${escapeHtml(latestInvoice ? formatSubscriptionBillingDate(latestInvoice.dueDate) : "—")}</strong><small>${escapeHtml(invoiceBalanceLabel)}</small></article>
            <article><span>Référence de facturation</span><strong>${escapeHtml(account.billingReference || "Non renseignée")}</strong><small>${escapeHtml(account.subscriptionLabel || currentOffer.label)}${account.discountLabel ? ` · ${escapeHtml(account.discountLabel)}` : ""}</small></article>
        </div>
        <p class="muted subscription-billing-note">Les informations sont synchronisées avec la facturation de l’entreprise. Après l’envoi d’une facture, la prochaine échéance est automatiquement reportée d’un mois.</p>
    `;
    section.querySelector(".creator-subscription-summary")?.after(billingPanel);
    container.appendChild(section);
    section.querySelectorAll("[data-request-tier]").forEach(button => button.addEventListener("click", async () => {
        const feedback = section.querySelector("[data-subscription-request-feedback]");
        button.disabled = true;
        const response = await fetch("/api/subscription-change-requests", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestedTier: button.dataset.requestTier, requestedPcSeats: currentPcSeats, requestedMobileSeats: currentMobileSeats, companyMessage: section.querySelector("[data-subscription-request-message]").value }) });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) { button.disabled = false; feedback.textContent = payload.message || "Demande impossible."; feedback.classList.add("error"); return; }
        feedback.textContent = payload.message; feedback.classList.remove("error");
        renderSettings({ section: "subscription" });
    }));
    section.querySelector("[data-seat-request]").addEventListener("submit", async event => {
        event.preventDefault();
        const feedback = section.querySelector("[data-subscription-request-feedback]");
        const values = Object.fromEntries(new FormData(event.currentTarget));
        const response = await fetch("/api/subscription-change-requests", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestedTier: currentTier, requestedPcSeats: Number(values.requestedPcSeats), requestedMobileSeats: Number(values.requestedMobileSeats), companyMessage: section.querySelector("[data-subscription-request-message]").value }) });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) { feedback.textContent = payload.message || "Demande impossible."; feedback.classList.add("error"); return; }
        feedback.textContent = payload.message; feedback.classList.remove("error");
        renderSettings({ section: "subscription" });
    });
}

function subscriptionRequestStatusLabel(status) {
    return ({ new: "Nouvelle", under_review: "En cours d’étude", accepted: "Acceptée", refused: "Refusée", cancelled: "Annulée" })[status] || "Nouvelle";
}

function formatSubscriptionRequestDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(date);
}

function formatSubscriptionBillingDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));
    if (!match) return "";
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
    return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "long", year: "numeric" }).format(date);
}

function subscriptionBillingStatus(status) {
    return ({
        active: { label: "À jour", className: "is-current" },
        trial: { label: "Période d’essai", className: "is-trial" },
        past_due: { label: "Paiement à suivre", className: "is-warning" },
        suspended: { label: "Abonnement suspendu", className: "is-warning" },
        cancelled: { label: "Abonnement résilié", className: "is-inactive" }
    })[status] || { label: "Statut à confirmer", className: "is-inactive" };
}

function subscriptionInvoiceStatus(status) {
    return ({ pending: "À envoyer", sending: "Envoi en cours", sent: "Envoyée", failed: "Échec d’envoi" })[status] || "État inconnu";
}

async function openDocumentTemplateSettings(type) {
    if (type === "report" && !organizationFeatureEnabled("technicalReports")) return renderSettings({ section: "documents" });
    await renderDocumentTemplateEditor(type, () => renderSettings({ section: "documents" }), () => openIntegratedDocumentSettings(type));
}

async function openIntegratedDocumentSettings(type) {
    if (type === "report" && !organizationFeatureEnabled("technicalReports")) return renderSettings({ section: "documents" });
    await renderBilling({ profile: true, templateSection: type, integratedOnly: true, onTemplateRendered: type === "report" ? () => renderReportTemplateSettings(getContainer()) : null });
}

function createSettingsIntro(title, description) {
    const card = document.createElement("article");
    card.className = "brand-card full-card procedure-card settings-section-intro";
    card.innerHTML = `<p class="eyebrow">Configuration</p><h2>${escapeHtml(title)}</h2>${description ? `<p class="muted">${escapeHtml(description)}</p>` : ""}`;
    return card;
}

function createSettingsNavigationCard(title, description, icon, onClick) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "settings-navigation-card";
    card.innerHTML = `<span class="settings-navigation-icon" aria-hidden="true">${settingsIcon(icon)}</span><span><strong>${escapeHtml(title)}</strong>${description ? `<small>${escapeHtml(description)}</small>` : ""}</span><span class="settings-navigation-arrow" aria-hidden="true">›</span>`;
    card.addEventListener("click", onClick);
    return card;
}

function settingsIcon(icon) {
    const paths = {
        document: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v5h5M10 12h5M10 16h5"/>',
        partners: '<path d="M8 12l3 3 5-6"/><path d="M4 12a8 8 0 0114-5M20 12a8 8 0 01-14 5"/>',
        network: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4a12 12 0 010 16M12 4a12 12 0 000 16"/>',
        users: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2"/><path d="M3 20c.6-4 3-6 6-6s5.4 2 6 6M15 15c2.5.2 4 1.8 4.5 4"/>',
        security: '<rect x="6" y="10" width="12" height="10" rx="2"/><path d="M9 10V7a3 3 0 016 0v3M12 14v2"/>',
        group: '<path d="M4 20V9l8-5 8 5v11M8 20v-6h8v6M4 9h16"/>',
        creator: '<circle cx="12" cy="8" r="3"/><path d="M5 21c.5-4.2 3.1-6.5 7-6.5s6.5 2.3 7 6.5M18 5l1 1 2-1M18 5l1-2"/>',
        appearance: '<circle cx="12" cy="12" r="8"/><path d="M12 4v16M4 12h16"/>',
        import: '<path d="M12 3v12M7 10l5 5 5-5M5 20h14"/>',
        support: '<path d="M4 13a8 8 0 0116 0v5M4 13h3v6H5a1 1 0 01-1-1zM20 13h-3v6h2a1 1 0 001-1zM17 19c0 2-2 2-5 2"/>'
    };
    return `<svg viewBox="0 0 24 24" focusable="false">${paths[icon] || paths.help}</svg>`;
}

async function renderReportTemplateSettings(container) {
    const card = document.createElement("article");
    card.id = "reportTemplateSettings";
    card.className = "brand-card full-card procedure-card report-template-settings";
    card.innerHTML = '<div class="settings-heading"><div><p class="eyebrow">Rapports</p><h2>Modèle de rapport</h2></div></div><p class="muted">Chargement du modèle…</p>';
    container.appendChild(card);
    try {
        const response = await fetch("/api/technical-reports/template", { credentials: "same-origin" });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.message || "Impossible de charger le modèle de rapport.");
        const template = data.template || {};
        const footerOptions = [["address", "Adresse"], ["phone", "Téléphone"], ["email", "E-mail"], ["website", "Site Internet"], ["siret", "SIRET"], ["vat", "TVA"], ["legalNotice", "Mentions légales"]];
        const selected = new Set(template.footerFields || []);
        card.innerHTML = `<div class="settings-heading"><div><p class="eyebrow">Paramètres → Rapports</p><h2>Modèle de rapport</h2><p class="muted">Les réglages sont appliqués à la prévisualisation et aux PDF officiels futurs.</p></div></div><form class="client-form report-template-form" enctype="multipart/form-data"><div class="form-grid"><label>Logo principal<input name="primaryLogo" type="file" accept="image/png,image/jpeg,image/webp"></label><label>Logo secondaire (pied de page)<input name="secondaryLogo" type="file" accept="image/png,image/jpeg,image/webp"></label>${template.hasPrimaryLogo ? '<label class="billing-remove-logo"><input name="removePrimaryLogo" type="checkbox" value="true"> Supprimer le logo principal</label>' : ""}${template.hasSecondaryLogo ? '<label class="billing-remove-logo"><input name="removeSecondaryLogo" type="checkbox" value="true"> Supprimer le logo secondaire</label>' : ""}<label>Nom de l’entreprise<input name="companyName" maxlength="160" value="${escapeHtml(template.companyName || "")}"></label><label>Téléphone<input name="phone" maxlength="50" value="${escapeHtml(template.phone || "")}"></label><label class="form-wide">Adresse<input name="address" maxlength="255" value="${escapeHtml(template.address || "")}"></label><label>E-mail<input name="email" type="email" maxlength="160" value="${escapeHtml(template.email || "")}"></label><label>Site Internet<input name="website" maxlength="160" value="${escapeHtml(template.website || "")}"></label><label>SIRET<input name="siret" maxlength="100" value="${escapeHtml(template.siret || "")}"></label><label>TVA<input name="vat" maxlength="100" value="${escapeHtml(template.vat || "")}"></label><label class="form-wide">Mentions légales<textarea name="legalNotice" rows="2" maxlength="1000">${escapeHtml(template.legalNotice || "")}</textarea></label><label class="form-wide">Texte d’en-tête<textarea name="headerText" rows="2" maxlength="500">${escapeHtml(template.headerText || "")}</textarea></label><label class="form-wide">Texte du pied de page<textarea name="footerText" rows="2" maxlength="500">${escapeHtml(template.footerText || "")}</textarea></label><label>Couleur principale<input name="primaryColor" type="color" value="${escapeHtml(template.primaryColor || "#003b73")}"></label><label>Couleur secondaire<input name="secondaryColor" type="color" value="${escapeHtml(template.secondaryColor || "#0a5c36")}"></label><label>Couleur des titres<input name="titleColor" type="color" value="${escapeHtml(template.titleColor || "#003b73")}"></label><label>Couleur des séparateurs<input name="separatorColor" type="color" value="${escapeHtml(template.separatorColor || "#0a5c36")}"></label><label>Police<select name="font"><option value="Helvetica" ${template.font === "Helvetica" ? "selected" : ""}>Helvetica / Sans-serif</option><option value="Times-Roman" ${template.font === "Times-Roman" ? "selected" : ""}>Times / Serif</option><option value="Courier" ${template.font === "Courier" ? "selected" : ""}>Courier / Monospace</option></select></label></div><fieldset class="report-template-footer-fields"><legend>Informations affichées dans le pied de page</legend>${footerOptions.map(([value, label]) => `<label><input type="checkbox" name="footerFields" value="${value}" ${selected.has(value) ? "checked" : ""}> ${label}</label>`).join("")}</fieldset><p class="auth-message" aria-live="polite"></p><div class="form-actions"><button type="submit" class="secondary-button">Enregistrer le modèle de rapport</button></div></form>`;
        card.querySelector(".settings-heading .muted")?.remove();
        const previewButton = createButton("Aperçu du rapport", "secondary-button", () => {
            const popup = window.open("", "_blank");
            if (!popup) { alert("Autorisez les fenêtres pop-up pour afficher l’aperçu du rapport."); return; }
            popup.location.href = "/api/billing/document-templates/report/preview";
        });
        card.querySelector(".form-actions")?.appendChild(previewButton);
        card.querySelector("form").addEventListener("submit", async event => { event.preventDefault(); const form = event.currentTarget; const message = form.querySelector(".auth-message"); const submit = form.querySelector("button[type=submit]"); submit.disabled = true; message.textContent = "Enregistrement…"; message.classList.remove("error"); const result = await fetch("/api/technical-reports/template", { method: "PUT", credentials: "same-origin", body: new FormData(form) }); if (!result.ok) { const payload = await result.json().catch(() => ({})); message.textContent = payload.message || "Impossible d’enregistrer le modèle."; message.classList.add("error"); submit.disabled = false; return; } message.textContent = "Modèle de rapport enregistré."; });
    } catch (error) { card.innerHTML = `<p class="auth-message error">${escapeHtml(error.message || "Impossible de charger le modèle de rapport.")}</p>`; }
}

async function renderCompanyTwoFactorSecurity(container) {
    const card = document.createElement("article");
    card.className = "brand-card full-card procedure-card creator-entry-card company-two-factor-card";
    card.innerHTML = '<p class="eyebrow">Sécurité</p><h2>Double authentification (2FA)</h2><p class="muted">Chargement des paramètres de sécurité…</p>';
    container.appendChild(card);
    try {
        const response = await fetch("/api/auth/company-2fa", { credentials: "same-origin" });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.message || "Impossible de charger les paramètres de sécurité.");
        const administrators = data.administrators || [];
        const administratorRows = data.enabled
            ? `<section class="team-section"><div class="team-section-heading"><div><p class="eyebrow">Comptes concernés</p><h3>Administrateurs (PC)</h3></div></div><p class="muted">Chaque administrateur configure sa propre application lors de sa prochaine connexion. Une réinitialisation entraîne la génération d’un nouveau QR code à la connexion suivante.</p><div class="team-list">${administrators.map(administrator => `<div class="team-member"><div class="team-member-summary"><div class="team-member-title"><strong>${escapeHtml(administrator.fullName || administrator.username)}</strong><span class="team-state-badge ${administrator.configured ? "is-active" : "is-pending"}">${administrator.configured ? "Application associée" : "Configuration requise"}</span></div><span class="team-member-meta">${escapeHtml(administrator.username)}</span></div><div class="team-member-actions">${administrator.configured ? `<button type="button" class="secondary-button" data-company-2fa-reset="${escapeHtml(administrator.id)}">Réinitialiser le 2FA</button>` : ""}</div></div>`).join("") || '<p class="muted">Aucun Administrateur (PC) actif n’est disponible.</p>'}</div></section>`
            : "";
        card.innerHTML = `
            <div class="settings-heading"><div><p class="eyebrow">Sécurité</p><h2>Double authentification (2FA)</h2><p class="muted">Activez une protection supplémentaire pour les comptes Administrateur de votre entreprise en demandant un code de validation lors de chaque connexion.</p></div><span class="team-state-badge ${data.enabled ? "is-active" : "is-inactive"}">${data.enabled ? "Activée" : "Désactivée"}</span></div>
            <form class="settings-form company-two-factor-form">
                <label class="settings-toggle"><input name="enabled" type="checkbox" ${data.enabled ? "checked" : ""}>Activer la double authentification pour les comptes Administrateur.<span>Les Administrateurs Mobile, postes PC standard, techniciens et chefs d’équipe ne sont pas concernés.</span></label>
                <p class="muted">Compatible avec Google Authenticator, Microsoft Authenticator, Authy et toute application TOTP. Les codes ne sont jamais enregistrés.</p>
                <div class="settings-actions"><button type="submit" class="secondary-button">Enregistrer la sécurité</button></div>
                <p class="auth-message" aria-live="polite"></p>
            </form>
            ${administratorRows}
        `;
        const form = card.querySelector(".company-two-factor-form");
        form.addEventListener("submit", async event => {
            event.preventDefault();
            const enabled = form.elements.enabled.checked;
            if (!enabled && data.enabled && !confirm("Désactiver la double authentification pour tous les Administrateurs (PC) ? Les associations actuelles seront supprimées.")) return;
            const button = form.querySelector('button[type="submit"]');
            const feedback = form.querySelector(".auth-message");
            button.disabled = true;
            feedback.textContent = "Enregistrement…";
            feedback.classList.remove("error");
            const result = await fetch("/api/auth/company-2fa/policy", { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) });
            const payload = await result.json().catch(() => ({}));
            if (!result.ok) {
                feedback.textContent = payload.message || "La mise à jour de la sécurité a échoué.";
                feedback.classList.add("error");
                button.disabled = false;
                return;
            }
            renderSettings();
        });
        card.querySelectorAll("[data-company-2fa-reset]").forEach(button => button.addEventListener("click", async () => {
            if (!confirm("Réinitialiser cette application d’authentification ? L’administrateur devra scanner un nouveau QR code à sa prochaine connexion.")) return;
            button.disabled = true;
            const result = await fetch(`/api/auth/company-2fa/administrators/${encodeURIComponent(button.dataset.company2faReset)}/reset`, { method: "POST", credentials: "same-origin" });
            if (!result.ok) {
                button.disabled = false;
                alert((await result.json().catch(() => ({}))).message || "La réinitialisation a échoué.");
                return;
            }
            renderSettings();
        }));
    } catch (error) {
        card.innerHTML = '<p class="eyebrow">Sécurité</p><h2>Double authentification (2FA)</h2>';
        card.appendChild(createInfo(error.message || "Impossible de charger les paramètres de sécurité."));
    }
}

function renderSupportContact(container) {
    const card = document.createElement("article");
    card.className = "brand-card full-card procedure-card creator-entry-card";
    card.innerHTML = `
        <p class="eyebrow">Assistance Depann’Home Pro</p>
        <h2>Contacter le support</h2>
        <p>Décrivez votre demande : notre équipe la recevra avec les informations de votre compte.</p>
        <form class="support-request-form">
            <label>Votre message<textarea name="message" rows="10" maxlength="4000" required aria-describedby="supportMessageHint supportRequestFeedback" placeholder="Expliquez la situation rencontrée, les étapes déjà effectuées et toute information utile…"></textarea></label>
            <div class="support-request-meta"><span id="supportMessageHint">10 caractères minimum · 4 000 maximum</span><span data-support-character-count aria-live="polite">0 / 4 000</span></div>
            <div class="support-request-actions"><button type="submit" class="secondary-button">Envoyer ma demande</button></div>
            <p id="supportRequestFeedback" class="auth-message" aria-live="polite"></p>
        </form>
    `;
    const form = card.querySelector(".support-request-form");
    const textarea = form.elements.message;
    const characterCount = form.querySelector("[data-support-character-count]");
    const feedback = form.querySelector(".auth-message");
    const button = form.querySelector('button[type="submit"]');
    const updateCharacterCount = () => { characterCount.textContent = `${textarea.value.length.toLocaleString("fr-FR")} / 4 000`; };
    textarea.addEventListener("input", updateCharacterCount);
    form.addEventListener("submit", async event => {
        event.preventDefault();
        button.disabled = true;
        const label = button.textContent;
        button.textContent = "Envoi…";
        feedback.textContent = "";
        feedback.classList.remove("error");
        try {
            const response = await fetch("/api/support/requests", {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ message: textarea.value })
            });
            const data = await response.json().catch(() => null);
            if (!response.ok) throw new Error(data?.message || "Impossible d’envoyer votre demande au support.");
            form.reset();
            updateCharacterCount();
            feedback.textContent = data?.message || "Votre message est envoyé et sera traité dans les meilleurs délais.";
        } catch (error) {
            feedback.textContent = error.message || "Impossible d’envoyer votre demande au support.";
            feedback.classList.add("error");
        } finally {
            button.disabled = false;
            button.textContent = label;
        }
    });
    container.appendChild(card);
}

async function renderTeamManagement(container) {
    const DEVICE_REFRESH_INTERVAL_MS = 3_000;
    const card = document.createElement("article");
    card.className = "brand-card full-card procedure-card team-management";
    card.innerHTML = '<div class="team-heading"><div><p class="eyebrow">Gestion des accès</p><h2>Équipe et postes PC</h2><p class="muted">Créez les accès de vos techniciens et les postes PC inclus dans votre offre.</p></div><span class="team-heading-badge">Administration</span></div>';
    const form = document.createElement("form");
    form.className = "settings-form team-form";
    form.innerHTML = '<div class="team-form-heading"><div><h3>Créer un accès</h3><p class="muted">Choisissez le type de poste, puis renseignez les informations de la personne.</p></div></div>';
    const formFields = document.createElement("div");
    formFields.className = "team-form-fields";
    [["fullName", "Nom et prénom", "text", "Ex. Léa Martin"], ["phone", "Téléphone", "tel", "Ex. 06 12 34 56 78"], ["email", "E-mail professionnel", "email", "lea@entreprise.fr"], ["username", "Identifiant", "text", "minuscules, chiffres, . _ -"], ["password", "Mot de passe initial", "password", "12 caractères minimum"]].forEach(([name, label, type, placeholder]) => {
        const field = document.createElement("label");
        field.textContent = label;
        const input = document.createElement("input");
        input.name = name;
        input.type = type;
        input.required = true;
        input.placeholder = placeholder;
        input.autocomplete = name === "password" ? "new-password" : "off";
        if (name === "password") {
            const wrapper = document.createElement("span");
            wrapper.className = "password-input";
            const toggle = createButton("Afficher", "secondary-button", () => {
                const visible = input.type === "password";
                input.type = visible ? "text" : "password";
                toggle.textContent = visible ? "Masquer" : "Afficher";
                toggle.setAttribute("aria-label", visible ? "Masquer le mot de passe" : "Afficher le mot de passe");
                toggle.setAttribute("aria-pressed", String(visible));
                input.focus();
            });
            toggle.type = "button";
            toggle.setAttribute("aria-label", "Afficher le mot de passe");
            toggle.setAttribute("aria-pressed", "false");
            wrapper.append(input, toggle);
            field.appendChild(wrapper);
        } else {
            field.appendChild(input);
        }
        formFields.appendChild(field);
    });
    const departmentsField = document.createElement("fieldset");
    departmentsField.className = "team-departments-field";
    departmentsField.innerHTML = `<legend>Sections métier</legend><p class="muted">Sélectionnez une ou plusieurs sections. Elles seront proposées dans le planning.</p><div>${TEAM_SECTION_OPTIONS.map(section => `<label><input type="checkbox" name="departments" value="${escapeHtml(section)}"><span>${escapeHtml(section)}</span></label>`).join("")}</div>`;
    formFields.appendChild(departmentsField);
    const roleField = document.createElement("label");
    roleField.textContent = "Type de poste";
    const roleInput = document.createElement("select");
    roleInput.name = "role";
    const tier = document.body.dataset.subscriptionTier || "pro";
    const roleOptions = tier === "basic"
        ? [["pc_standard", "Poste PC standard"], ["admin", "Administrateur (PC)"], ["mobile_admin", "Administrateur Mobile"]]
        : [["technician", "Technicien"], ["team_lead", "Technicien référent / Chef d’équipe"], ["pc_standard", "Poste PC standard"], ["accountant", "Comptable (PC)"], ["admin", "Administrateur (PC)"], ["mobile_admin", "Administrateur Mobile"]];
    roleInput.innerHTML = roleOptions.map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
    roleField.appendChild(roleInput);
    formFields.appendChild(roleField);
    const advancedPcPermissions = ["basic_plus", "pro"].includes(tier);
    const groupCompanyPermissionAvailable = tier === "pro" && Boolean(document.body.dataset.groupId);
    const permissionsField = document.createElement("fieldset");
    permissionsField.className = "team-permissions-fieldset";
    permissionsField.innerHTML = `
        <legend>Autorisations du poste PC</legend>
        <p class="muted" data-pc-permission-help>Ces deux accès sont indépendants : cochez l’un, l’autre ou les deux selon les missions du poste.</p>
        <label class="settings-toggle"><span><strong>Devis et factures</strong><small>Créer et gérer les devis, factures, modèles et paramètres commerciaux</small></span><input type="checkbox" name="canAccessBilling"></label>
        <label class="settings-toggle"><span><strong>Comptabilité et e-facturation</strong><small>Journaux, règlements, TVA, FEC, facturation électronique et PDP — sans création de devis ni facture</small></span><input type="checkbox" name="canAccessAccounting"></label>
        <label class="settings-toggle"><span><strong>Espace e-mail de l’entreprise</strong><small>Consulter la boîte professionnelle connectée, ses messages et ses pièces jointes</small></span><input type="checkbox" name="canAccessCompanyEmail"></label>
        ${groupCompanyPermissionAvailable ? '<label class="settings-toggle" data-group-company-permission><span><strong>Entreprises du même groupe</strong><small>Changer de société active sans partager leurs données</small></span><input type="checkbox" name="canSwitchGroupCompanies"></label>' : ""}
    `;
    permissionsField.hidden = true;
    formFields.appendChild(permissionsField);
    const mobileBillingPermissionField = document.createElement("fieldset");
    mobileBillingPermissionField.className = "team-permissions-fieldset";
    mobileBillingPermissionField.innerHTML = `
        <legend>Autorisation du technicien mobile</legend>
        <p class="muted">Ce droit permet au technicien de créer des documents commerciaux depuis les interventions qui lui sont affectées.</p>
        <label class="settings-toggle"><span><strong>Créer des devis et factures</strong><small>Autoriser ce technicien à créer des devis et factures pour ses interventions</small></span><input type="checkbox" name="canCreateBilling"></label>
    `;
    mobileBillingPermissionField.hidden = true;
    formFields.appendChild(mobileBillingPermissionField);
    const submit = createButton("Créer le technicien", "secondary-button", () => {});
    submit.type = "submit";
    const formActions = document.createElement("div");
    formActions.className = "team-form-actions";
    formActions.appendChild(submit);
    const feedback = document.createElement("p");
    feedback.className = "muted team-feedback";
    form.append(formFields, formActions, feedback);
    card.appendChild(form);
    const membersSection = document.createElement("section");
    membersSection.className = "team-section";
    membersSection.innerHTML = '<div class="team-section-heading"><div><p class="eyebrow">Organisation</p><h3>Pôles et équipes</h3><p class="muted">Les techniciens et chefs d’équipe sont regroupés ici et dans le planning.</p></div></div>';
    const departments = document.createElement("div");
    departments.className = "team-department-groups";
    const list = document.createElement("div");
    list.className = "team-list";
    membersSection.append(departments, list);
    card.appendChild(membersSection);
    const devicesSection = document.createElement("section");
    devicesSection.className = "team-section";
    const devices = document.createElement("div");
    devices.className = "team-list";
    devicesSection.appendChild(devices);
    card.appendChild(devicesSection);
    container.appendChild(card);
    const updateRoleFields = () => {
        const isTechnician = ["technician", "team_lead"].includes(roleInput.value);
        const isMobileAdmin = roleInput.value === "mobile_admin";
        const isConfigurablePc = ["pc_standard", "accountant"].includes(roleInput.value);
        const isAdministratorPc = roleInput.value === "admin";
        form.elements.phone.required = isTechnician || isMobileAdmin;
        form.elements.email.required = isTechnician || isMobileAdmin;
        departmentsField.hidden = !isTechnician;
        departmentsField.querySelectorAll("input").forEach(input => { input.disabled = !isTechnician; });
        submit.textContent = isTechnician ? (roleInput.value === "team_lead" ? "Créer le chef d’équipe" : "Créer le technicien") : isMobileAdmin ? "Créer l’Administrateur Mobile" : isAdministratorPc ? "Créer l’Administrateur (PC)" : roleInput.value === "accountant" ? "Créer le Comptable (PC)" : "Créer le poste PC standard";
        roleField.dataset.role = roleInput.value;
        permissionsField.hidden = !advancedPcPermissions || (!isConfigurablePc && !isAdministratorPc);
        permissionsField.querySelectorAll("input").forEach(input => { input.disabled = !isConfigurablePc; });
        permissionsField.querySelectorAll(".settings-toggle").forEach(label => { label.hidden = isAdministratorPc; });
        permissionsField.querySelector("[data-pc-permission-help]").textContent = isAdministratorPc
            ? "L’Administrateur (PC) dispose automatiquement de tous les accès, sans restriction."
            : "Choisissez uniquement les espaces nécessaires à ce poste. Ces droits sont contrôlés côté serveur.";
        mobileBillingPermissionField.hidden = roleInput.value !== "technician";
        form.elements.canCreateBilling.disabled = roleInput.value !== "technician";
        feedback.textContent = isMobileAdmin ? "Ce poste s’active uniquement depuis un smartphone ou une tablette : l’appareil devra être autorisé, puis confirmé avec le code envoyé par e-mail." : "";
    };
    roleInput.addEventListener("change", updateRoleFields);
    updateRoleFields();
    const openDeviceManagement = device => {
        const isPc = ["admin", "pc_standard"].includes(device.userRole) && device.deviceType !== "mobile";
        const deviceName = isPc ? "ce poste PC" : "cet appareil";
        const accountName = device.fullName || device.username || "ce compte";
        const dialog = document.createElement("dialog");
        dialog.className = "device-management-dialog";
        dialog.innerHTML = `
            <div class="device-management-heading"><div><p class="eyebrow">Sécurité des connexions</p><h2>Gérer ${escapeHtml(deviceName)}</h2><p class="muted">${escapeHtml(device.label)} · Compte : ${escapeHtml(accountName)}</p></div><button type="button" class="secondary-button" data-close-device-management>Fermer</button></div>
            <form class="device-password-form"><h3>Réinitialiser le mot de passe</h3><p class="muted">Le nouveau mot de passe sera demandé lors de la prochaine connexion du compte.</p><label>Nouveau mot de passe<input name="password" type="password" autocomplete="new-password" minlength="12" required placeholder="12 caractères minimum"></label><label>Confirmer le mot de passe<input name="passwordConfirmation" type="password" autocomplete="new-password" minlength="12" required></label><p class="auth-message" aria-live="polite"></p><button type="submit" class="secondary-button">Réinitialiser le mot de passe</button></form>
            <section class="device-management-danger"><h3>Supprimer ${escapeHtml(deviceName)}</h3><p>Cette action retire uniquement ${escapeHtml(deviceName)}. Le compte utilisateur reste disponible et pourra se reconnecter après une nouvelle validation.</p><button type="button" class="secondary-button danger-button" data-delete-device>Supprimer ${escapeHtml(deviceName)}</button></section>
        `;
        const close = () => dialog.close();
        dialog.querySelector("[data-close-device-management]").addEventListener("click", close);
        dialog.addEventListener("close", () => dialog.remove(), { once: true });
        dialog.querySelector(".device-password-form").addEventListener("submit", async event => {
            event.preventDefault();
            const form = event.currentTarget;
            const status = form.querySelector(".auth-message");
            const submitButton = form.querySelector("button[type=submit]");
            const values = new FormData(form);
            const password = String(values.get("password") || "");
            if (password !== String(values.get("passwordConfirmation") || "")) {
                status.textContent = "Les deux mots de passe ne correspondent pas.";
                status.classList.add("error");
                return;
            }
            submitButton.disabled = true;
            status.textContent = "Réinitialisation en cours…";
            status.classList.remove("error");
            const result = await fetch(`/api/auth/members/${encodeURIComponent(device.userId)}/reset-password`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
            const payload = await result.json().catch(() => ({}));
            if (!result.ok) {
                status.textContent = payload.message || "La réinitialisation du mot de passe a échoué.";
                status.classList.add("error");
                submitButton.disabled = false;
                return;
            }
            feedback.textContent = `Mot de passe réinitialisé pour ${accountName}.`;
            close();
        });
        dialog.querySelector("[data-delete-device]").addEventListener("click", async event => {
            if (!confirm(`Supprimer définitivement ${deviceName} ?`)) return;
            event.currentTarget.disabled = true;
            const result = await fetch(`/api/auth/devices/${encodeURIComponent(device.id)}`, { method: "DELETE", credentials: "same-origin" });
            const payload = await result.json().catch(() => ({}));
            if (!result.ok) {
                event.currentTarget.disabled = false;
                feedback.textContent = payload.message || "La suppression de l’appareil a échoué.";
                return;
            }
            feedback.textContent = `${isPc ? "Poste PC" : "Appareil"} supprimé.`;
            close();
            await load();
        });
        document.body.appendChild(dialog);
        dialog.showModal();
    };
    let loadingTeam = false;
    const load = async ({ silent = false } = {}) => {
        if (loadingTeam || !card.isConnected) return;
        loadingTeam = true;
        if (!silent) list.textContent = "Chargement de l’équipe…";
        try {
            const response = await teamRequest("/api/auth/members");
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.message || "Impossible de charger l’équipe.");
            list.innerHTML = "";
            const fieldMembers = (payload.members || []).filter(member => ["technician", "team_lead"].includes(member.role));
            const departmentGroups = new Map();
            fieldMembers.forEach(member => {
                memberDepartments(member).forEach(department => {
                    if (!departmentGroups.has(department)) departmentGroups.set(department, []);
                    departmentGroups.get(department).push(member);
                });
            });
            departments.innerHTML = [...departmentGroups.entries()]
                .sort(([first], [second]) => first.localeCompare(second, "fr"))
                .map(([department, groupMembers]) => `<article class="team-department-group"><strong>${escapeHtml(department)}</strong><span>${groupMembers.length} membre${groupMembers.length > 1 ? "s" : ""}</span><small>${escapeHtml(groupMembers.map(member => member.fullName || member.username).join(" · "))}</small></article>`)
                .join("") || '<p class="muted">Aucun technicien ou chef d’équipe n’est encore affecté à un pôle.</p>';
            if (!payload.members?.length) list.textContent = "Aucun accès créé pour le moment.";
            (payload.members || []).forEach(member => {
                const item = document.createElement("div");
                item.className = "team-member";
                const memberType = member.role === "admin" ? "Administrateur (PC)" : member.role === "pc_standard" ? "Poste PC standard" : member.role === "mobile_admin" ? "Administrateur Mobile" : member.role === "team_lead" ? "Technicien référent / Chef d’équipe" : member.role === "accountant" ? "Comptable" : "Technicien";
                const permissionSummary = member.role === "admin"
                    ? " · Tous les accès"
                    : ["pc_standard", "accountant"].includes(member.role) && advancedPcPermissions
                        ? ` · Facturation : ${member.canAccessBilling ? "oui" : "non"} · Comptabilité : ${member.canAccessAccounting ? "oui" : "non"} · E-mail : ${member.canAccessCompanyEmail ? "oui" : "non"}${groupCompanyPermissionAvailable ? ` · Groupe : ${member.canSwitchGroupCompanies ? "oui" : "non"}` : ""}`
                        : "";
                const sectionBadges = ["technician", "team_lead"].includes(member.role) ? memberDepartments(member).map(section => `<span class="team-department-badge">${escapeHtml(section)}</span>`).join("") : "";
                item.innerHTML = `<div class="team-member-summary"><div class="team-member-title"><strong>${escapeHtml(member.fullName || member.username)}</strong><span class="team-role-badge ${member.role === "admin" ? "is-admin" : member.role === "mobile_admin" ? "is-mobile-admin" : member.role === "accountant" ? "is-accountant" : "is-technician"}">${memberType}</span>${sectionBadges}<span class="team-state-badge ${member.isActive ? "is-active" : "is-inactive"}">${member.isActive ? "Actif" : "Désactivé"}</span></div><span class="team-member-meta">${escapeHtml(member.phone || "Téléphone non renseigné")}<span aria-hidden="true">·</span>${escapeHtml(member.email || "E-mail non renseigné")}<span aria-hidden="true">·</span>${escapeHtml(member.username)}${member.role === "mobile_admin" ? " · Activation par code e-mail sur smartphone" : ""}${permissionSummary}</span></div>`;
                const actions = document.createElement("div");
                actions.className = "team-member-actions";
                const toggle = createButton(member.isActive ? "Désactiver" : "Réactiver", "secondary-button", async () => {
                    toggle.disabled = true;
                    const response = await fetch(`/api/auth/members/${encodeURIComponent(member.id)}`, { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive: !member.isActive }) });
                    if (!response.ok) feedback.textContent = "La mise à jour de l’accès a échoué.";
                    await load();
                });
                const remove = createButton("Supprimer", "secondary-button danger-button", async () => {
                    if (!confirm(`Supprimer définitivement l’accès de ${member.fullName || member.username} ?`)) return;
                    remove.disabled = true;
                    const response = await fetch(`/api/auth/members/${encodeURIComponent(member.id)}`, { method: "DELETE", credentials: "same-origin" });
                    if (!response.ok) feedback.textContent = (await response.json().catch(() => ({}))).message || "La suppression de l’accès a échoué.";
                    await load();
                });
                const changeRole = createButton("Changer le rôle", "secondary-button", async () => {
                    const availableRoles = tier === "basic"
                        ? [["admin", "Administrateur (PC)"], ["pc_standard", "Poste PC standard"], ["accountant", "Comptable (PC)"], ["mobile_admin", "Administrateur Mobile"]]
                        : [["admin", "Administrateur (PC)"], ["pc_standard", "Poste PC standard"], ["accountant", "Comptable (PC)"], ["mobile_admin", "Administrateur Mobile"], ["team_lead", "Technicien référent / Chef d’équipe"], ["technician", "Technicien"]];
                    const nextRole = await chooseMemberRole(member, availableRoles);
                    if (!nextRole || nextRole === member.role) return;
                    changeRole.disabled = true;
                    const response = await fetch(`/api/auth/members/${encodeURIComponent(member.id)}/role`, { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: nextRole }) });
                    const payload = await response.json().catch(() => ({}));
                    if (!response.ok) { feedback.textContent = payload.message || "Le changement de rôle a échoué."; changeRole.disabled = false; return; }
                    feedback.textContent = payload.deviceActivationRequired
                        ? "Le rôle a été modifié. L’ancien appareil incompatible a été révoqué : activez ce compte sur le nouveau type de poste."
                        : "Le rôle a été modifié. L’appareil actuel reste autorisé.";
                    await load();
                });
                const permissionButtons = [];
                if (advancedPcPermissions && ["pc_standard", "accountant"].includes(member.role)) {
                    const addPermissionButton = (property, enabledLabel, disabledLabel) => {
                        const button = createButton(member[property] ? enabledLabel : disabledLabel, "secondary-button", async () => {
                            button.disabled = true;
                            const response = await fetch(`/api/auth/members/${encodeURIComponent(member.id)}`, { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive: member.isActive, [property]: !member[property] }) });
                            if (!response.ok) feedback.textContent = (await response.json().catch(() => ({}))).message || "La mise à jour de l’autorisation a échoué.";
                            await load();
                        });
                        permissionButtons.push(button);
                    };
                    addPermissionButton("canAccessBilling", "Retirer Devis et factures", "Autoriser Devis et factures");
                    addPermissionButton("canAccessAccounting", "Retirer Comptabilité et e-facturation", "Autoriser Comptabilité et e-facturation");
                    addPermissionButton("canAccessCompanyEmail", "Retirer Espace e-mail", "Autoriser Espace e-mail");
                    if (groupCompanyPermissionAvailable) addPermissionButton("canSwitchGroupCompanies", "Retirer accès Groupe", "Autoriser accès Groupe");
                }
                if (["technician", "team_lead"].includes(member.role)) {
                    const editDepartment = createButton("Modifier les sections", "secondary-button", async () => {
                        const selectedDepartments = await chooseMemberDepartments(member);
                        if (!selectedDepartments) return;
                        editDepartment.disabled = true;
                        const response = await fetch(`/api/auth/members/${encodeURIComponent(member.id)}`, { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive: member.isActive, canCreateBilling: member.canCreateBilling, departments: selectedDepartments }) });
                        if (!response.ok) feedback.textContent = (await response.json().catch(() => ({}))).message || "La mise à jour des sections a échoué.";
                        await load();
                    });
                    const billingPermission = createButton(member.canCreateBilling ? "Retirer le droit devis/factures" : "Autoriser devis/factures", "secondary-button", async () => {
                        billingPermission.disabled = true;
                        const response = await fetch(`/api/auth/members/${encodeURIComponent(member.id)}`, { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive: member.isActive, canCreateBilling: !member.canCreateBilling }) });
                        if (!response.ok) feedback.textContent = (await response.json().catch(() => ({}))).message || "La mise à jour de l’autorisation a échoué.";
                        await load();
                    });
                    actions.append(toggle, changeRole, editDepartment, billingPermission, remove);
                } else actions.append(toggle, changeRole, ...permissionButtons, remove);
                item.appendChild(actions);
                list.appendChild(item);
            });
            const deviceResponse = await teamRequest("/api/auth/devices");
            const devicePayload = await deviceResponse.json();
            if (!deviceResponse.ok) throw new Error(devicePayload.message || "Impossible de charger les appareils.");
            const pcSeats = devicePayload.pcSeats || { maxPcUsers: Number(document.body.dataset.maxPcUsers || 1), activePcUsers: 0, maxMobileUsers: Number(document.body.dataset.maxMobileUsers || 0), activeMobileUsers: 0 };
            devices.innerHTML = `<div class="team-section-heading"><div><p class="eyebrow">Sécurité des connexions</p><h3>Appareils et postes</h3></div><div class="creator-form-actions"><span class="team-seat-badge">${escapeHtml(pcSeats.activePcUsers)} / ${escapeHtml(pcSeats.maxPcUsers)} postes PC</span><span class="team-seat-badge">${escapeHtml(pcSeats.activeMobileUsers)} / ${escapeHtml(pcSeats.maxMobileUsers)} postes mobiles</span></div></div><p class="muted team-section-description">Chaque téléphone ou tablette d’un Administrateur consomme un poste mobile, sans consommer de poste PC. Les comptes Administrateur Mobile, Chef d’équipe et Technicien consomment également chacun un poste mobile.</p>`;
            const managedDevices = devicePayload.devices || [];
            if (!managedDevices.length) devices.insertAdjacentHTML("beforeend", "<p class=\"muted\">Aucun appareil enregistré.</p>");
            managedDevices.forEach(device => {
                const isPc = ["admin", "pc_standard", "accountant"].includes(device.userRole) && device.deviceType !== "mobile";
                const isMobile = device.deviceType === "mobile";
                const pcSeatAvailable = Number(pcSeats.activePcUsers) < Number(pcSeats.maxPcUsers);
                const mobileSeatAvailable = Number(pcSeats.activeMobileUsers) < Number(pcSeats.maxMobileUsers);
                const item = document.createElement("div");
                item.className = "team-member";
                const deviceTypeLabel = isPc
                    ? device.userRole === "admin" ? "Poste Administrateur (PC)" : device.userRole === "accountant" ? "Poste comptable (PC)" : "Poste PC standard"
                    : isMobile && ["admin", "mobile_admin"].includes(device.userRole) ? "Administrateur Mobile"
                        : isMobile && device.userRole === "team_lead" ? "Chef d’équipe mobile"
                            : isMobile && device.userRole === "technician" ? "Technicien mobile"
                                : isMobile ? "Appareil mobile" : "Appareil non conforme";
                const assigneeName = device.fullName || device.username || "Titulaire non renseigné";
                const statusLabel = device.status === "approved" ? "Activé" : device.status === "rejected" ? "Refusé" : device.status === "code_pending" ? "Code e-mail envoyé" : "En attente d’autorisation";
                item.innerHTML = `<div class="team-member-summary"><div class="team-member-title"><strong>${escapeHtml(deviceTypeLabel)} — ${escapeHtml(assigneeName)}</strong><span class="team-role-badge ${isPc ? "is-admin" : "is-technician"}">${isPc ? "PC" : "Mobile"}</span><span class="team-state-badge ${device.status === "approved" ? "is-active" : device.status === "rejected" ? "is-inactive" : "is-pending"}">${statusLabel}</span></div><span class="team-member-meta">Attribué à ${escapeHtml(assigneeName)}${device.username ? ` · ${escapeHtml(device.username)}` : ""} · ${escapeHtml(device.label)}${isMobile && device.userRole === "admin" ? " · Consomme un poste mobile" : ""}</span></div>`;
                const actions = document.createElement("div");
                actions.className = "team-member-actions";
                if (["approval_pending", "code_pending", "rejected"].includes(device.status)) {
                    const approveLabel = device.status === "rejected"
                        ? (isPc ? "Réactiver ce poste PC" : "Réactiver ce poste mobile")
                        : isPc ? "Activer ce poste PC"
                            : isMobile && device.userRole === "admin" ? "Autoriser cet appareil mobile"
                                : device.status === "code_pending" ? "Renvoyer le code" : "Autoriser et envoyer le code";
                    const approve = createButton(approveLabel, "secondary-button", async () => {
                        approve.disabled = true;
                        const result = await fetch(`/api/auth/devices/${encodeURIComponent(device.id)}/approve`, { method: "POST", credentials: "same-origin" });
                        if (!result.ok) feedback.textContent = (await result.json().catch(() => ({}))).message || "Autorisation impossible.";
                        await load();
                    });
                    if (isPc && !pcSeatAvailable) approve.disabled = true;
                    if (isMobile && device.userRole === "admin" && !mobileSeatAvailable) approve.disabled = true;
                    actions.appendChild(approve);
                    if (device.status !== "rejected") {
                        const reject = createButton("Refuser", "secondary-button", async () => {
                            const result = await fetch(`/api/auth/devices/${encodeURIComponent(device.id)}/reject`, { method: "POST", credentials: "same-origin" });
                            if (!result.ok) feedback.textContent = (await result.json().catch(() => ({}))).message || "Refus impossible.";
                            await load();
                        });
                        actions.appendChild(reject);
                    }
                }
                const manage = createButton("Gérer", "secondary-button", () => openDeviceManagement(device));
                manage.title = `Gérer ${isPc ? "ce poste PC" : "cet appareil"}`;
                actions.appendChild(manage);
                item.appendChild(actions);
                devices.appendChild(item);
            });
        } catch (error) {
            if (silent) return;
            list.replaceChildren();
            const message = document.createElement("p");
            message.className = "auth-message error";
            message.textContent = error.message || "Impossible de charger les accès.";
            const retry = createButton("Réessayer", "secondary-button", load);
            list.append(message, retry);
        } finally {
            loadingTeam = false;
        }
    };
    form.addEventListener("submit", async event => {
        event.preventDefault();
        submit.disabled = true;
        feedback.textContent = "";
        try {
            const values = Object.fromEntries(new FormData(form));
            values.departments = [...departmentsField.querySelectorAll('input[name="departments"]:checked')].map(input => input.value);
            if (["technician", "team_lead"].includes(roleInput.value) && !values.departments.length) throw new Error("Choisissez au moins une section métier.");
            values.canCreateBilling = roleInput.value === "technician" && Boolean(form.elements.canCreateBilling.checked);
            values.canAccessBilling = Boolean(form.elements.canAccessBilling?.checked);
            values.canAccessAccounting = Boolean(form.elements.canAccessAccounting?.checked);
            values.canAccessCompanyEmail = Boolean(form.elements.canAccessCompanyEmail?.checked);
            values.canSwitchGroupCompanies = Boolean(form.elements.canSwitchGroupCompanies?.checked);
            const response = await fetch("/api/auth/members", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.message || "Création impossible.");
            form.reset();
            updateRoleFields();
            feedback.textContent = values.role === "admin" ? "Poste PC créé. Sa première connexion devra être activée dans la liste des appareils." : values.role === "mobile_admin" ? "Administrateur Mobile créé. À sa première connexion smartphone, autorisez l’appareil puis envoyez le code e-mail." : "Compte technicien créé.";
            await load();
        } catch (error) { feedback.textContent = error.message; }
        finally { submit.disabled = false; }
    });
    await load();
    const refreshDevicesWhileVisible = async () => {
        if (!card.isConnected) return;
        if (document.visibilityState === "visible") await load({ silent: true });
        if (card.isConnected) window.setTimeout(refreshDevicesWhileVisible, DEVICE_REFRESH_INTERVAL_MS);
    };
    window.setTimeout(refreshDevicesWhileVisible, DEVICE_REFRESH_INTERVAL_MS);
}

async function teamRequest(url, options = {}) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
        return await fetch(url, { credentials: "same-origin", ...options, signal: controller.signal });
    } catch (error) {
        if (error.name === "AbortError") throw new Error("Le chargement des accès a expiré. Vérifiez votre connexion puis réessayez.");
        throw error;
    } finally {
        window.clearTimeout(timeout);
    }
}

function chooseMemberRole(member, roles) {
    return new Promise(resolve => {
        const dialog = document.createElement("dialog");
        dialog.className = "device-management-dialog";
        dialog.innerHTML = `<form method="dialog"><div class="device-management-heading"><div><p class="eyebrow">Gestion des accès</p><h2>Changer le rôle</h2><p class="muted">${escapeHtml(member.fullName || member.username)}</p></div><button type="button" class="secondary-button" data-cancel-role>Fermer</button></div><label>Nouveau rôle<select name="role">${roles.map(([value, label]) => `<option value="${value}" ${value === member.role ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select></label><div class="form-actions"><button type="submit" class="secondary-button">Confirmer</button></div></form>`;
        let settled = false;
        const finish = value => { if (settled) return; settled = true; resolve(value); dialog.close(); };
        dialog.querySelector("[data-cancel-role]").addEventListener("click", () => finish(""));
        dialog.querySelector("form").addEventListener("submit", event => { event.preventDefault(); finish(event.currentTarget.elements.role.value); });
        dialog.addEventListener("cancel", event => { event.preventDefault(); finish(""); });
        dialog.addEventListener("close", () => { dialog.remove(); if (!settled) resolve(""); }, { once: true });
        document.body.appendChild(dialog);
        dialog.showModal();
    });
}

function memberDepartments(member) {
    const values = Array.isArray(member?.departments) ? member.departments : [member?.department];
    const departments = [...new Set(values.map(value => String(value || "").trim()).filter(Boolean))];
    return departments.length ? departments : ["Non classé"];
}

function chooseMemberDepartments(member) {
    return new Promise(resolve => {
        const selected = new Set(memberDepartments(member).filter(section => section !== "Non classé"));
        const dialog = document.createElement("dialog");
        dialog.className = "device-management-dialog";
        dialog.innerHTML = `<form method="dialog"><div class="device-management-heading"><div><p class="eyebrow">Organisation</p><h2>Sections métier</h2><p class="muted">${escapeHtml(member.fullName || member.username)}</p></div><button type="button" class="secondary-button" data-cancel-sections>Fermer</button></div><fieldset class="team-departments-field"><legend>Sélection multiple</legend><div>${TEAM_SECTION_OPTIONS.map(section => `<label><input type="checkbox" name="departments" value="${escapeHtml(section)}" ${selected.has(section) ? "checked" : ""}><span>${escapeHtml(section)}</span></label>`).join("")}</div></fieldset><p class="auth-message" aria-live="polite"></p><div class="form-actions"><button type="submit" class="secondary-button">Enregistrer</button></div></form>`;
        let settled = false;
        const finish = value => { if (settled) return; settled = true; resolve(value); dialog.close(); };
        dialog.querySelector("[data-cancel-sections]").addEventListener("click", () => finish(null));
        dialog.querySelector("form").addEventListener("submit", event => {
            event.preventDefault();
            const departments = [...event.currentTarget.querySelectorAll('input[name="departments"]:checked')].map(input => input.value);
            if (!departments.length) { event.currentTarget.querySelector(".auth-message").textContent = "Sélectionnez au moins une section."; return; }
            finish(departments);
        });
        dialog.addEventListener("cancel", event => { event.preventDefault(); finish(null); });
        dialog.addEventListener("close", () => { dialog.remove(); if (!settled) resolve(null); }, { once: true });
        document.body.appendChild(dialog);
        dialog.showModal();
    });
}

function getCurrentRef() {
    return {
        type: "product",
        brandIndex: database.brands.indexOf(state.brand),
        categoryIndex: state.brand.categories.indexOf(state.category),
        productIndex: state.category.products.indexOf(state.product),
        productIndex: state.category.products.indexOf(state.product)
    };
}

function resolveRef(ref) {
    const brand = database.brands[ref.brandIndex];
    const category = brand?.categories[ref.categoryIndex];
    const product = category?.products[ref.productIndex];
    return { brand, category, product };
}

function navigateToRef(ref) {
    const target = resolveRef(ref);

    state.brand = target.brand || null;
    state.category = target.category || null;
    state.product = target.product || null;
    state.procedure = target.procedure || null;

    clearSearch();

    if (ref.type === "brand" && state.brand) renderBrandCategories();
    else if (ref.type === "category" && state.category) renderCategoryOverview();
    else if (ref.type === "product" && state.product) renderProductOverview();
    else renderError("Élément introuvable", "La donnée demandée n'existe plus dans la base.");
}
