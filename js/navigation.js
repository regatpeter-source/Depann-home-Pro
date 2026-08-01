import { ROUTES, STORAGE_KEYS, DEFAULT_SETTINGS, FONT_OPTIONS, LANG_OPTIONS, MENU_ACCESS } from "./config.js?v=117";
import { createCalendarEventForClient, renderCalendar, renderCalendarOverview } from "./calendar.js?v=142";
import { renderCreatorConsole } from "./creator.js?v=119";
import { createBillingDocumentForClient, renderBilling, synchronizeBillingDocuments, viewBillingDocument } from "./billing.js?v=143";
import { renderAccounting } from "./accounting.js?v=2";
import { renderAccountingSandbox } from "./accounting-sandbox.js?v=1";
import { renderGroupActivation, renderGroupWorkspace } from "./groups.js?v=3";
import { renderPartnerMissions } from "./partner-missions.js?v=2";
import { renderPartnerSandbox } from "./partner-sandbox.js?v=3";
import { renderPartnerConnections } from "./partner-connections.js?v=6";
import { renderDataImportTool } from "./data-imports.js?v=1";
import { renderPurchases } from "./purchases.js?v=112";
import { renderLeakReportWizard as renderTechnicalReports } from "./leak-report-wizard.js?v=3";
import { getFirstUnreadClientId, refreshClientMessageAlert, refreshVisibleClientMessages } from "./messages.js?v=106";
import { getSearchableClients, renderClients } from "./clients.js?v=134";
import { synchronizeClients } from "./client-sync.js?v=118";
import { configureLibrary, openLibrarySection, renderLibrary, searchPersonalLibrary } from "./library.js?v=120";
import { renderPhotoRecognition } from "./photo-recognition.js?v=105";
import { getSearchResults } from "./search.js?v=63";
import { state, resetSelection } from "./state.js?v=44";
import {
    clearHistory,
    getStoredRefs,
    getSettings,
    saveSettings
} from "./storage.js?v=44";
import { escapeHtml, normalizeText } from "./utils.js?v=44";
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

let database = { brands: [] };
let searchRequestId = 0;
let sharedSynchronizationTimer = null;
let sharedSynchronizationPromise = null;
const TECHNICIAN_CALENDAR_ALERT_KEY_PREFIX = "depannHomePro:technicianCalendar:lastViewed:";

export function initializeNavigation(loadedDatabase) {
    database = loadedDatabase;
    configureLibrary({ openCatalog: renderBrands, openStore: renderStore });
    bindEvents();
    applyRoleBasedMenus();
    window.addEventListener("depannhome:open-client", event => openClients(String(event.detail?.clientId || "")));
    window.addEventListener("depannhome:clients-synchronized", () => refreshClientMessageAlert());
    window.addEventListener("depannhome:technician-calendar-viewed", event => markTechnicianCalendarAlertsRead(event.detail?.events || []));
    refreshClientMessageAlert();
    refreshTechnicianCalendarAlert();
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") refreshSharedData();
    });
    if (!sharedSynchronizationTimer) {
        sharedSynchronizationTimer = window.setInterval(() => {
            if (document.visibilityState === "visible") refreshSharedData();
        }, isTechnician() ? 30_000 : 90_000);
    }
    if (isAccountant()) renderBilling();
    else if (document.body.dataset.role === "technician") renderCalendarOverview();
    else if (isMobileAdministrator()) renderHome();
    else if (document.body.classList.contains("desktop-device")) renderHome();
    else renderBrands();
}

export async function refreshSharedData(options = {}) {
    if (sharedSynchronizationPromise) {
        return options.includeClients
            ? Promise.all([sharedSynchronizationPromise, synchronizeClients()])
            : sharedSynchronizationPromise;
    }
    const requests = [synchronizeBillingDocuments({ refreshView: true, force: Boolean(options.forceBilling) })];
    if (isTechnician()) requests.unshift(refreshTechnicianCalendarAlert());
    if (!isAccountant()) requests.unshift(refreshVisibleClientMessages());
    if (options.includeClients && !isAccountant()) requests.push(synchronizeClients());
    sharedSynchronizationPromise = Promise.all(requests).finally(() => {
        sharedSynchronizationPromise = null;
    });
    return sharedSynchronizationPromise;
}

export async function refreshApplication() {
    const activeRoute = document.querySelector(".nav-button.active")?.dataset.nav || "";
    await refreshSharedData({ includeClients: true, forceBilling: true });

    if (activeRoute && MENU_ACCESS.navigation[activeRoute] && !canAccessRoute(activeRoute)) {
        openHome();
        return { refreshed: true };
    }

    if (isAccountant()) {
        if (activeRoute === ROUTES.purchases) renderPurchases();
        else renderBilling();
    } else if (activeRoute === ROUTES.clients) {
        const selectedId = document.querySelector(".client-messages-panel")?.dataset.clientId || "";
        renderClients({ database, navigateToRef, createBillingDocument: createBillingDocumentForClient, viewBillingDocument, createCalendarEvent: createCalendarEventForClient, ...(selectedId ? { selectedId } : {}) });
    } else if (activeRoute === ROUTES.calendar) {
        renderCalendar();
    } else if (activeRoute === ROUTES.billing) {
        if (isTechnician()) renderTechnicalReports();
        else renderBilling();
    } else if (activeRoute === ROUTES.technicalReports) {
        renderTechnicalReports();
    } else if (activeRoute === ROUTES.partnerMissions && !isAccountant()) {
        renderPartnerMissions();
    } else if (activeRoute === ROUTES.partnerSandbox && document.body.dataset.role === "admin") {
        renderPartnerSandbox();
    } else if (activeRoute === ROUTES.accountingSandbox && document.body.dataset.role === "admin") {
        renderAccountingSandbox();
    } else if (activeRoute === ROUTES.groups && document.body.dataset.groupAdmin === "true") {
        renderGroupWorkspace();
    } else if (activeRoute === ROUTES.purchases) {
        renderPurchases();
    } else if (activeRoute === ROUTES.settings && canAccessRoute(ROUTES.settings)) {
        renderSettings();
    } else if (activeRoute === ROUTES.home) {
        openHome();
    }
    return { refreshed: true };
}

function bindEvents() {
    const search = document.getElementById("search");
    const clientsBtn = document.getElementById("clientsBtn");
    const billingBtn = document.getElementById("billingBtn");
    const accountingBtn = document.getElementById("accountingBtn");
    const groupsBtn = document.getElementById("groupsBtn");
    const partnerMissionsBtn = document.getElementById("partnerMissionsBtn");
    const partnerSandboxBtn = document.getElementById("partnerSandboxBtn");
    const purchasesBtn = document.getElementById("purchasesBtn");
    const calendarBtn = document.getElementById("calendarBtn");
    const libraryBtn = document.getElementById("libraryBtn");
    const photoBtn = document.getElementById("photoBtn");
    const favoritesBtn = document.getElementById("favoritesBtn");
    const historyBtn = document.getElementById("historyBtn");
    const settingsBtn = document.getElementById("settingsBtn");

    search.addEventListener("input", event => {
        const value = event.target.value.toLowerCase().trim();

        if (!value) {
            searchRequestId += 1;
            openHome();
            return;
        }

        renderSearchResults(value);
    });

    clientsBtn.addEventListener("click", () => { if (canAccessQuick("clients")) openClients(); });
    billingBtn?.addEventListener("click", () => {
        if (!canAccessQuick("billing")) return;
        if (isTechnician()) renderTechnicalReports();
        else renderBilling();
    });
    accountingBtn?.addEventListener("click", () => { if (canAccessQuick("accounting")) renderAccounting(); });
    groupsBtn?.addEventListener("click", () => { if (canAccessQuick("groups")) renderGroupWorkspace(); });
    partnerMissionsBtn?.addEventListener("click", () => { if (canAccessQuick("partnerMissions")) renderPartnerMissions(); });
    partnerSandboxBtn?.addEventListener("click", () => { if (canAccessQuick("partnerSandbox")) renderPartnerSandbox(); });
    purchasesBtn?.addEventListener("click", () => { if (canAccessQuick("purchases")) renderPurchases(); });
    calendarBtn?.addEventListener("click", () => { if (canAccessQuick("calendar")) openCalendar(); });
    libraryBtn?.addEventListener("click", () => { if (canAccessQuick("library")) renderLibrary(); });
    photoBtn?.addEventListener("click", () => { if (canAccessQuick("photo")) renderPhotoRecognition(database, navigateToRef); });
    favoritesBtn.addEventListener("click", () => { if (canAccessQuick("favorites")) renderFavorites(); });
    historyBtn.addEventListener("click", () => { if (canAccessQuick("history")) renderHistory(); });
    settingsBtn?.addEventListener("click", () => { if (canAccessQuick("settings")) renderSettings(); });

    document.querySelectorAll(".nav-button").forEach(button => {
        button.addEventListener("click", async () => {
            const nav = button.dataset.nav;

            if (!canAccessRoute(nav)) return;

            if (isAccountant()) {
                if (nav === ROUTES.billing) renderBilling();
                if (nav === ROUTES.purchases) renderPurchases();
                return;
            }

            if (nav === ROUTES.home) openHome();
            if (nav === ROUTES.search) focusSearch();
            if (nav === ROUTES.store) renderStore();
            if (nav === ROUTES.photo) renderPhotoRecognition(database, navigateToRef);
            if (nav === ROUTES.clients) openClients();
            if (nav === ROUTES.billing) {
                if (isTechnician()) renderTechnicalReports();
                else renderBilling();
            }
            if (nav === ROUTES.accounting && document.body.dataset.role === "admin") renderAccounting();
            if (nav === ROUTES.groups && document.body.dataset.groupAdmin === "true") renderGroupWorkspace();
            if (nav === ROUTES.accountingSandbox && document.body.dataset.role === "admin") renderAccountingSandbox();
            if (nav === ROUTES.partnerMissions) renderPartnerMissions();
            if (nav === ROUTES.partnerSandbox && document.body.dataset.role === "admin") renderPartnerSandbox();
            if (nav === ROUTES.purchases) renderPurchases();
            if (nav === ROUTES.calendar) openCalendar();
            if (nav === ROUTES.library) renderLibrary();
            if (nav === ROUTES.favorites) renderFavorites();
            if (nav === ROUTES.settings) renderSettings();
        });
    });
}

function applyRoleBasedMenus() {
    const quickSelectors = {
        clients: "#clientsBtn", calendar: "#calendarBtn", library: "#libraryBtn", billing: "#billingBtn",
        accounting: "#accountingBtn", groups: "#groupsBtn", partnerMissions: "#partnerMissionsBtn",
        partnerSandbox: "#partnerSandboxBtn", purchases: "#purchasesBtn", photo: "#photoBtn",
        favorites: "#favoritesBtn", history: "#historyBtn", settings: "#settingsBtn"
    };
    Object.entries(quickSelectors).forEach(([menu, selector]) => {
        const button = document.querySelector(selector);
        if (!isMenuAllowed(MENU_ACCESS.quick[menu], menuRoute(menu))) button?.remove();
    });
    document.querySelectorAll(".nav-button").forEach(button => {
        if (!canAccessRoute(button.dataset.nav)) button.remove();
    });
}

function isMenuAllowed(roles, route = "") {
    if (!Array.isArray(roles) || !roles.includes(document.body.dataset.role)) return false;
    if (route === ROUTES.groups) return document.body.dataset.groupAdmin === "true";
    if (route === ROUTES.partnerSandbox) return document.body.classList.contains("partner-sandbox-enabled");
    return true;
}

function canAccessQuick(menu) {
    return isMenuAllowed(MENU_ACCESS.quick[menu], menuRoute(menu));
}

function canAccessRoute(route) {
    return isMenuAllowed(MENU_ACCESS.navigation[route], route);
}

function menuRoute(menu) {
    return ({ calendar: ROUTES.calendar, library: ROUTES.library, billing: ROUTES.billing, accounting: ROUTES.accounting, groups: ROUTES.groups, partnerMissions: ROUTES.partnerMissions, partnerSandbox: ROUTES.partnerSandbox, purchases: ROUTES.purchases, photo: ROUTES.photo, favorites: ROUTES.favorites, history: ROUTES.history, settings: ROUTES.settings })[menu] || "";
}

function openHome() {
    if (isAccountant()) {
        renderBilling();
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

async function openClients(clientId = "") {
    if (isAccountant()) return;
    const selectedId = clientId || await getFirstUnreadClientId();
    renderClients({ database, navigateToRef, createBillingDocument: createBillingDocumentForClient, viewBillingDocument, createCalendarEvent: createCalendarEventForClient, ...(selectedId ? { selectedId, focusMessages: true } : {}) });
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
    return `${TECHNICIAN_CALENDAR_ALERT_KEY_PREFIX}${document.body.dataset.userId || "anonymous"}:${date}`;
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

    database.brands.forEach(brand => {
        container.appendChild(
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
}

async function renderHome() {
    clearSearch();
    resetSelection("all");
    setPage("Accueil", ROUTES.home, "detail");

    const container = getContainer();
    const panel = document.createElement("section");
    panel.className = "client-panel home-panel dashboard-panel";
    panel.innerHTML = `
        <div class="dashboard-heading"><div><p class="eyebrow">Depann’Home Pro</p><h2>Tableau de bord</h2></div><button type="button" class="secondary-button" data-dashboard-action="calendar">Voir le planning complet</button></div>
        <div class="dashboard-grid">
            <section class="dashboard-card"><p class="eyebrow">Aujourd’hui</p><h3>${escapeHtml(formatDashboardDate(new Date()))}</h3><div class="dashboard-events" data-dashboard-events="today"><p class="muted">Chargement des rendez-vous…</p></div></section>
            <section class="dashboard-card"><p class="eyebrow">À venir</p><h3>Les 7 prochains jours</h3><div class="dashboard-events" data-dashboard-events="upcoming"><p class="muted">Chargement des rendez-vous…</p></div></section>
        </div>
        <p class="dashboard-catalog-note">Les gammes techniques — volets roulants et portails — sont disponibles dans la <strong>Bibliothèque</strong>.</p>
    `;
    container.appendChild(panel);

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

    categories.forEach(category => {
        container.appendChild(
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

    products.forEach((product, productIndex) => {
        const ref = {
            type: "product",
            brandIndex: database.brands.indexOf(state.brand),
            categoryIndex: state.brand.categories.indexOf(state.category),
            productIndex
        };

        container.appendChild(createCard(
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
    container.appendChild(createInfo("Recherche dans le catalogue, vos clients et votre bibliothèque…"));

    const localResults = getSearchResults(database, query);
    const privateLibrary = await searchPersonalLibrary(query);
    if (currentRequestId !== searchRequestId || document.getElementById("search")?.value.toLowerCase().trim() !== query) return;

    const libraryResults = [
        ...(privateLibrary.sections || []).map(section => ({
            type: "librarySection",
            title: section.name,
            subtitle: "Votre dossier privé",
            sectionId: section.id,
            score: 80
        })),
        ...(privateLibrary.documents || []).map(document => ({
            type: "libraryDocument",
            title: document.title,
            subtitle: `${document.sectionName} · ${document.originalFilename}`,
            documentId: document.id,
            score: 95
        }))
    ];
    const results = [...localResults, ...libraryResults]
        .sort((first, second) => (second.score || 0) - (first.score || 0))
        .slice(0, 40);

    container.innerHTML = "";

    if (!results.length) {
        container.appendChild(createInfo("Aucun résultat trouvé. Essayez avec une marque, un produit, un client, un devis ou un mot-clé de votre bibliothèque."));
        return;
    }

    results.forEach(result => {
        container.appendChild(
            createCard(
                "",
                result.title,
                result.type === "document" ? `${result.subtitle} · Document PDF` : result.subtitle,
                () => {
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

function getRefPhoto(ref) {
    if (ref?.type !== "product") return "";
    const product = resolveRef(ref).product;
    return Array.isArray(product?.photos) && product.photos.length ? product.photos[0] : "";
}

function renderFavorites() {
    clearSearch();
    resetSelection("all");
    setPage("Favoris", ROUTES.favorites);

    const container = getContainer();
    const favorites = getStoredRefs(STORAGE_KEYS.favorites);

    if (!favorites.length) {
        container.appendChild(createInfo("Aucun favori pour le moment. Ouvrez une procédure puis cliquez sur ☆ Favori."));
        return;
    }

    renderRefList(favorites, container, "");
}

function renderHistory() {
    clearSearch();
    resetSelection("all");
    setPage("Historique", ROUTES.history);

    const container = getContainer();
    const history = getStoredRefs(STORAGE_KEYS.history);

    if (!history.length) {
        container.appendChild(createInfo("L'historique est vide. Les procédures consultées apparaîtront ici."));
        return;
    }

    container.appendChild(createButton("Effacer l'historique", "secondary-button danger-button", () => {
        if (!confirm("Effacer définitivement tout l’historique des procédures consultées ?")) return;
        clearHistory();
        renderHistory();
    }));

    renderRefList(history, container, "");
}

function renderRefList(refs, container, icon) {
    refs.forEach(ref => {
        const target = resolveRef(ref);
        if (!target?.product) return;

        container.appendChild(
            createCard(
                "",
                target.product.name,
                `${target.brand.name} · ${target.category.name}`,
                () => navigateToRef(ref),
                { image: getRefPhoto(ref) }
            )
        );
    });
}

function renderSettings() {
    if (!canAccessRoute(ROUTES.settings)) {
        openHome();
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
            ? { home: "Home", search: "Search", store: "Store", photo: "Photo", clients: "Clients", billing: "Quotes", purchases: "Purchases", calendar: "Planning", library: "Library", favorites: "Favorites", settings: "Settings" }
            : { home: "Accueil", search: "Recherche", store: "Magasin", photo: "Photo", clients: "Clients", billing: "Devis", purchases: "Achats", calendar: "Planning", library: "Bibliothèque", favorites: "Favoris", settings: "Paramètres" };
        document.querySelectorAll("footer .nav-button").forEach(button => {
            const label = button.querySelector(".nav-label-clients") || button.querySelector("span");
            if (label) label.textContent = texts[button.dataset.nav] || label.textContent;
        });
        renderSettings();
    });

    const resetBtn = createButton("Réinitialiser", "secondary-button", () => {
        if (!confirm("Réinitialiser tous les paramètres de l’application ?")) return;
        saveSettings(DEFAULT_SETTINGS);
        document.body.classList.toggle("dark-theme", DEFAULT_SETTINGS.theme === "dark");
        const font = FONT_OPTIONS.find(f => f.id === DEFAULT_SETTINGS.font) || FONT_OPTIONS[0];
        document.body.style.fontFamily = font && font.css ? font.css : "";
        document.documentElement.lang = DEFAULT_SETTINGS.lang || 'fr';
        renderSettings();
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
    if (document.body.dataset.role === "admin") {
        renderTeamManagement(container);
        renderCompanyTwoFactorSecurity(container);
    }
    if (document.body.dataset.role === "admin") renderPartnerConnections(container);
    if (document.body.dataset.groupAdmin === "true") {
        const groupCard = document.createElement("article");
        groupCard.className = "brand-card full-card procedure-card creator-entry-card";
        groupCard.innerHTML = '<p class="eyebrow">Multi-entreprises</p><h2>Groupe & entreprises</h2><p>Changez d’entreprise, pilotez les sociétés du groupe et consultez les indicateurs consolidés.</p>';
        groupCard.appendChild(createButton("Ouvrir le pilotage Groupe", "secondary-button", renderGroupWorkspace));
        container.appendChild(groupCard);
    } else if (document.body.dataset.role === "admin") renderGroupActivation(container);
    if (document.body.dataset.creator === "true" && document.body.dataset.deviceType === "desktop") {
        const creatorCard = document.createElement("article");
        creatorCard.className = "brand-card full-card procedure-card creator-entry-card";
        creatorCard.innerHTML = '<p class="eyebrow">Administration plateforme</p><h2>Console Créateur</h2>';
        creatorCard.appendChild(createButton("Ouvrir la console Créateur", "secondary-button", renderCreatorConsole));
        container.appendChild(creatorCard);
    }
    if (document.body.dataset.role === "admin" && document.body.classList.contains("desktop-device")) {
        renderDataImportTool(container);
        renderSupportContact(container);
    }
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
    const card = document.createElement("article");
    card.className = "brand-card full-card procedure-card team-management";
    card.innerHTML = '<div class="team-heading"><div><p class="eyebrow">Gestion des accès</p><h2>Équipe et postes PC</h2><p class="muted">Créez les accès de vos techniciens et les postes PC inclus dans votre offre.</p></div><span class="team-heading-badge">Administration</span></div>';
    const form = document.createElement("form");
    form.className = "settings-form team-form";
    form.innerHTML = '<div class="team-form-heading"><div><h3>Créer un accès</h3><p class="muted">Choisissez le type de poste, puis renseignez les informations de la personne.</p></div></div>';
    const formFields = document.createElement("div");
    formFields.className = "team-form-fields";
    [["fullName", "Nom et prénom", "text", "Ex. Léa Martin"], ["phone", "Téléphone", "tel", "Ex. 06 12 34 56 78"], ["email", "E-mail professionnel", "email", "lea@entreprise.fr"], ["department", "Pôle / équipe", "text", "Ex. Dépannage, Chantiers, Métrés"], ["username", "Identifiant", "text", "minuscules, chiffres, . _ -"], ["password", "Mot de passe initial", "password", "12 caractères minimum"]].forEach(([name, label, type, placeholder]) => {
        const field = document.createElement("label");
        field.textContent = label;
        const input = document.createElement("input");
        input.name = name;
        input.type = type;
        input.required = true;
        input.placeholder = placeholder;
        input.autocomplete = name === "password" ? "new-password" : "off";
        if (name === "department") {
            input.setAttribute("list", "teamDepartmentSuggestions");
            input.dataset.technicianOnly = "true";
        }
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
    const roleField = document.createElement("label");
    roleField.textContent = "Type de poste";
    const roleInput = document.createElement("select");
    roleInput.name = "role";
    roleInput.innerHTML = '<option value="technician">Technicien</option><option value="team_lead">Technicien référent / Chef d’équipe</option><option value="pc_standard">Poste PC standard</option><option value="admin">Administrateur (PC)</option><option value="mobile_admin">Administrateur Mobile</option>';
    roleField.appendChild(roleInput);
    formFields.appendChild(roleField);
    const departmentSuggestions = document.createElement("datalist");
    departmentSuggestions.id = "teamDepartmentSuggestions";
    departmentSuggestions.innerHTML = ["Dépannage", "Chantiers", "Métrés", "Maintenance", "Pose", "SAV"].map(value => `<option value="${value}"></option>`).join("");
    form.appendChild(departmentSuggestions);
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
    membersSection.innerHTML = '<div class="team-section-heading"><div><p class="eyebrow">Accès créés</p><h3>Membres de l’équipe</h3></div></div>';
    const list = document.createElement("div");
    list.className = "team-list";
    membersSection.appendChild(list);
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
        form.elements.phone.required = isTechnician || isMobileAdmin;
        form.elements.email.required = isTechnician || isMobileAdmin;
        form.elements.department.disabled = !isTechnician;
        submit.textContent = isTechnician ? (roleInput.value === "team_lead" ? "Créer le chef d’équipe" : "Créer le technicien") : isMobileAdmin ? "Créer l’Administrateur Mobile" : roleInput.value === "admin" ? "Créer l’Administrateur (PC)" : "Créer le poste PC standard";
        roleField.dataset.role = roleInput.value;
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
    const load = async () => {
        list.textContent = "Chargement de l’équipe…";
        try {
            const response = await teamRequest("/api/auth/members");
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.message || "Impossible de charger l’équipe.");
            list.innerHTML = "";
            if (!payload.members?.length) list.textContent = "Aucun accès créé pour le moment.";
            (payload.members || []).forEach(member => {
                const item = document.createElement("div");
                item.className = "team-member";
                const memberType = member.role === "admin" ? "Administrateur (PC)" : member.role === "pc_standard" ? "Poste PC standard" : member.role === "mobile_admin" ? "Administrateur Mobile" : member.role === "team_lead" ? "Technicien référent / Chef d’équipe" : member.role === "accountant" ? "Comptable" : "Technicien";
                item.innerHTML = `<div class="team-member-summary"><div class="team-member-title"><strong>${escapeHtml(member.fullName || member.username)}</strong><span class="team-role-badge ${member.role === "admin" ? "is-admin" : member.role === "mobile_admin" ? "is-mobile-admin" : member.role === "accountant" ? "is-accountant" : "is-technician"}">${memberType}</span>${["technician", "team_lead"].includes(member.role) ? `<span class="team-department-badge">${escapeHtml(member.department || "Non classé")}</span>` : ""}<span class="team-state-badge ${member.isActive ? "is-active" : "is-inactive"}">${member.isActive ? "Actif" : "Désactivé"}</span></div><span class="team-member-meta">${escapeHtml(member.phone || "Téléphone non renseigné")}<span aria-hidden="true">·</span>${escapeHtml(member.email || "E-mail non renseigné")}<span aria-hidden="true">·</span>${escapeHtml(member.username)}${member.role === "mobile_admin" ? " · Activation par code e-mail sur smartphone" : member.role === "accountant" ? " · Espace comptabilité, sans limite de poste PC" : ""}</span></div>`;
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
                    const choices = "admin = Administrateur (PC)\npc_standard = Poste PC standard\nmobile_admin = Administrateur Mobile\nteam_lead = Technicien référent / Chef d’équipe\ntechnician = Technicien\naccountant = Comptable";
                    const nextRole = window.prompt(`Nouveau rôle pour ${member.fullName || member.username} :\n\n${choices}`, member.role);
                    if (nextRole === null || nextRole === member.role) return;
                    changeRole.disabled = true;
                    const response = await fetch(`/api/auth/members/${encodeURIComponent(member.id)}/role`, { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: nextRole.trim() }) });
                    if (!response.ok) feedback.textContent = (await response.json().catch(() => ({}))).message || "Le changement de rôle a échoué.";
                    await load();
                });
                if (["technician", "team_lead"].includes(member.role)) {
                    const editDepartment = createButton("Modifier le pôle", "secondary-button", async () => {
                        const department = window.prompt(`Pôle de ${member.fullName || member.username} :`, member.department || "");
                        if (department === null) return;
                        editDepartment.disabled = true;
                        const response = await fetch(`/api/auth/members/${encodeURIComponent(member.id)}`, { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive: member.isActive, canCreateBilling: member.canCreateBilling, department }) });
                        if (!response.ok) feedback.textContent = (await response.json().catch(() => ({}))).message || "La mise à jour du pôle a échoué.";
                        await load();
                    });
                    const billingPermission = createButton(member.canCreateBilling ? "Retirer le droit devis/factures" : "Autoriser devis/factures", "secondary-button", async () => {
                        billingPermission.disabled = true;
                        const response = await fetch(`/api/auth/members/${encodeURIComponent(member.id)}`, { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive: member.isActive, canCreateBilling: !member.canCreateBilling }) });
                        if (!response.ok) feedback.textContent = (await response.json().catch(() => ({}))).message || "La mise à jour de l’autorisation a échoué.";
                        await load();
                    });
                    actions.append(toggle, changeRole, editDepartment, billingPermission, remove);
                } else actions.append(toggle, changeRole, remove);
                item.appendChild(actions);
                list.appendChild(item);
            });
            const deviceResponse = await teamRequest("/api/auth/devices");
            const devicePayload = await deviceResponse.json();
            if (!deviceResponse.ok) throw new Error(devicePayload.message || "Impossible de charger les appareils.");
            const pcSeats = devicePayload.pcSeats || { maxPcUsers: Number(document.body.dataset.maxPcUsers || 1), activePcUsers: 0 };
            devices.innerHTML = `<div class="team-section-heading"><div><p class="eyebrow">Sécurité des connexions</p><h3>Appareils et postes PC</h3></div><span class="team-seat-badge">${escapeHtml(pcSeats.activePcUsers)} / ${escapeHtml(pcSeats.maxPcUsers)} postes PC</span></div><p class="muted team-section-description">Les téléphones et tablettes d’administrateurs ne consomment pas de poste PC. Après sa première connexion, le technicien crée ici une demande : le bouton « Autoriser et envoyer le code » apparaît alors.</p>`;
            const managedDevices = devicePayload.devices || [];
            if (!managedDevices.length) devices.insertAdjacentHTML("beforeend", "<p class=\"muted\">Aucun appareil enregistré.</p>");
            managedDevices.forEach(device => {
                const isPc = ["admin", "pc_standard"].includes(device.userRole) && device.deviceType !== "mobile";
                const isMobile = device.deviceType === "mobile";
                const pcSeatAvailable = Number(pcSeats.activePcUsers) < Number(pcSeats.maxPcUsers);
                const item = document.createElement("div");
                item.className = "team-member";
                const deviceTypeLabel = isPc ? device.userRole === "admin" ? "Poste Administrateur (PC)" : "Poste PC standard" : isMobile && ["admin", "mobile_admin"].includes(device.userRole) ? "Administrateur Mobile" : isMobile ? "Appareil mobile" : "Appareil technicien";
                const assigneeName = device.fullName || device.username || "Titulaire non renseigné";
                const statusLabel = device.status === "approved" ? "Activé" : device.status === "rejected" ? "Refusé" : device.status === "code_pending" ? "Code e-mail envoyé" : "En attente d’autorisation";
                item.innerHTML = `<div class="team-member-summary"><div class="team-member-title"><strong>${escapeHtml(deviceTypeLabel)} — ${escapeHtml(assigneeName)}</strong><span class="team-role-badge ${isPc ? "is-admin" : "is-technician"}">${isPc ? "PC" : "Mobile"}</span><span class="team-state-badge ${device.status === "approved" ? "is-active" : device.status === "rejected" ? "is-inactive" : "is-pending"}">${statusLabel}</span></div><span class="team-member-meta">Attribué à ${escapeHtml(assigneeName)}${device.username ? ` · ${escapeHtml(device.username)}` : ""} · ${escapeHtml(device.label)}${isMobile && device.userRole === "admin" ? " · Sans poste PC" : ""}</span></div>`;
                const actions = document.createElement("div");
                actions.className = "team-member-actions";
                if (device.status === "approval_pending" || device.status === "code_pending") {
                    const approve = createButton(isPc ? "Activer ce poste PC" : isMobile && device.userRole === "admin" ? "Autoriser cet appareil mobile" : (device.status === "code_pending" ? "Renvoyer le code" : "Autoriser et envoyer le code"), "secondary-button", async () => {
                        approve.disabled = true;
                        const result = await fetch(`/api/auth/devices/${encodeURIComponent(device.id)}/approve`, { method: "POST", credentials: "same-origin" });
                        if (!result.ok) feedback.textContent = (await result.json().catch(() => ({}))).message || "Autorisation impossible.";
                        await load();
                    });
                    if (isPc && !pcSeatAvailable) approve.disabled = true;
                    const reject = createButton("Refuser", "secondary-button", async () => {
                        const result = await fetch(`/api/auth/devices/${encodeURIComponent(device.id)}/reject`, { method: "POST", credentials: "same-origin" });
                        if (!result.ok) feedback.textContent = (await result.json().catch(() => ({}))).message || "Refus impossible.";
                        await load();
                    });
                    actions.append(approve, reject);
                }
                const manage = createButton("Gérer", "secondary-button", () => openDeviceManagement(device));
                manage.title = `Gérer ${isPc ? "ce poste PC" : "cet appareil"}`;
                actions.appendChild(manage);
                item.appendChild(actions);
                devices.appendChild(item);
            });
        } catch (error) {
            list.replaceChildren();
            const message = document.createElement("p");
            message.className = "auth-message error";
            message.textContent = error.message || "Impossible de charger les accès.";
            const retry = createButton("Réessayer", "secondary-button", load);
            list.append(message, retry);
        }
    };
    form.addEventListener("submit", async event => {
        event.preventDefault();
        submit.disabled = true;
        feedback.textContent = "";
        try {
            const values = Object.fromEntries(new FormData(form));
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
