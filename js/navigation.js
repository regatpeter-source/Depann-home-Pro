import { ROUTES, STORAGE_KEYS, DEFAULT_SETTINGS, FONT_OPTIONS, LANG_OPTIONS } from "./config.js?v=116";
import { createCalendarEventForClient, renderCalendar, renderCalendarOverview } from "./calendar.js?v=117";
import { renderCreatorConsole } from "./creator.js?v=105";
import { createBillingDocumentForClient, renderBilling, viewBillingDocument } from "./billing.js?v=116";
import { renderPurchases } from "./purchases.js?v=111";
import { getFirstUnreadClientId, refreshClientMessageAlert } from "./messages.js?v=88";
import { getSearchableClients, renderClients } from "./clients.js?v=116";
import { configureLibrary, openLibrarySection, renderLibrary, searchPersonalLibrary } from "./library.js?v=118";
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

export function initializeNavigation(loadedDatabase) {
    database = loadedDatabase;
    configureLibrary({ openCatalog: renderBrands, openStore: renderStore });
    bindEvents();
    refreshClientMessageAlert();
    window.setInterval(refreshClientMessageAlert, 30000);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") refreshClientMessageAlert();
    });
    if (document.body.dataset.role === "technician") renderCalendarOverview();
    else if (document.body.classList.contains("desktop-device")) renderHome();
    else renderBrands();
}

function bindEvents() {
    const search = document.getElementById("search");
    const clientsBtn = document.getElementById("clientsBtn");
    const billingBtn = document.getElementById("billingBtn");
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

    clientsBtn.addEventListener("click", openClients);
    billingBtn?.addEventListener("click", renderBilling);
    purchasesBtn?.addEventListener("click", renderPurchases);
    calendarBtn?.addEventListener("click", openCalendar);
    libraryBtn?.addEventListener("click", renderLibrary);
    photoBtn?.addEventListener("click", () => renderPhotoRecognition(database, navigateToRef));
    favoritesBtn.addEventListener("click", renderFavorites);
    historyBtn.addEventListener("click", renderHistory);
    settingsBtn?.addEventListener("click", renderSettings);

    document.querySelectorAll(".nav-button").forEach(button => {
        button.addEventListener("click", async () => {
            const nav = button.dataset.nav;

            if (nav === ROUTES.home) openHome();
            if (nav === ROUTES.search) focusSearch();
            if (nav === ROUTES.store) renderStore();
            if (nav === ROUTES.photo) renderPhotoRecognition(database, navigateToRef);
            if (nav === ROUTES.clients) openClients();
            if (nav === ROUTES.billing) renderBilling();
            if (nav === ROUTES.purchases) renderPurchases();
            if (nav === ROUTES.calendar) openCalendar();
            if (nav === ROUTES.library) renderLibrary();
            if (nav === ROUTES.favorites) renderFavorites();
            if (nav === ROUTES.settings) renderSettings();
        });
    });
}

function openHome() {
    if (document.body.classList.contains("desktop-device")) {
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

async function openClients() {
    const selectedId = await getFirstUnreadClientId();
    renderClients({ database, navigateToRef, createBillingDocument: createBillingDocumentForClient, viewBillingDocument, createCalendarEvent: createCalendarEventForClient, ...(selectedId ? { selectedId, focusMessages: true } : {}) });
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
    clearSearch();
    resetSelection("all");
    setPage("Paramètres", ROUTES.settings, "detail");

    const container = getContainer();
    const card = document.createElement("article");
    card.className = "brand-card full-card procedure-card";

    card.innerHTML = "<h2>Paramètres</h2>";

    // settings form
    const settings = getSettings();

    const section = document.createElement("section");
    section.className = "procedure-section";

    const form = document.createElement("div");
    form.className = "settings-form";

    // max history
    const maxLabel = document.createElement("label");
    maxLabel.textContent = "Taille de l'historique (max)";
    const maxInput = document.createElement("input");
    maxInput.type = "number";
    maxInput.min = "1";
    maxInput.value = settings.maxHistory || DEFAULT_SETTINGS.maxHistory;
    maxInput.style.marginLeft = "8px";
    maxLabel.appendChild(maxInput);

    // theme select
    const themeLabel = document.createElement("label");
    themeLabel.textContent = "Thème";
    themeLabel.style.display = "block";
    const themeSelect = document.createElement("select");
    const optLight = document.createElement("option"); optLight.value = "light"; optLight.text = "Clair";
    const optDark = document.createElement("option"); optDark.value = "dark"; optDark.text = "Sombre";
    themeSelect.appendChild(optLight);
    themeSelect.appendChild(optDark);
    themeSelect.value = settings.theme || DEFAULT_SETTINGS.theme;
    themeLabel.appendChild(themeSelect);

    // font select
    const fontLabel = document.createElement("label");
    fontLabel.textContent = "Police";
    fontLabel.style.display = "block";
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
    langLabel.textContent = "Langue";
    langLabel.style.display = "block";
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
    offlineLabel.textContent = "Montrer l'état hors-ligne";
    offlineLabel.style.display = "block";
    const offlineCheckbox = document.createElement("input");
    offlineCheckbox.type = "checkbox";
    offlineCheckbox.checked = settings.showOfflineBadge !== false;
    offlineCheckbox.style.marginLeft = "8px";
    offlineLabel.appendChild(offlineCheckbox);

    // actions
    const actions = document.createElement("div");
    actions.style.marginTop = "12px";

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

    form.appendChild(maxLabel);
    form.appendChild(themeLabel);
    form.appendChild(fontLabel);
    form.appendChild(langLabel);
    form.appendChild(offlineLabel);
    form.appendChild(actions);

    section.appendChild(form);
    card.appendChild(section);

    container.appendChild(card);
    if (document.body.dataset.role === "admin") renderTeamManagement(container);
    if (document.body.dataset.creator === "true") {
        const creatorCard = document.createElement("article");
        creatorCard.className = "brand-card full-card procedure-card creator-entry-card";
        creatorCard.innerHTML = '<p class="eyebrow">Administration plateforme</p><h2>Console Créateur</h2>';
        creatorCard.appendChild(createButton("Ouvrir la console Créateur", "secondary-button", renderCreatorConsole));
        container.appendChild(creatorCard);
    }
}

async function renderTeamManagement(container) {
    const card = document.createElement("article");
    card.className = "brand-card full-card procedure-card team-management";
    card.innerHTML = "<h2>Équipe</h2>";
    const form = document.createElement("form");
    form.className = "settings-form team-form";
    [["fullName", "Nom du technicien", "text", "Ex. Léa Martin"], ["phone", "Téléphone", "tel", "Ex. 06 12 34 56 78"], ["username", "Identifiant", "text", "minuscules, chiffres, . _ -"], ["password", "Mot de passe initial", "password", "12 caractères minimum"]].forEach(([name, label, type, placeholder]) => {
        const field = document.createElement("label");
        field.textContent = label;
        const input = document.createElement("input");
        input.name = name;
        input.type = type;
        input.required = true;
        input.placeholder = placeholder;
        input.autocomplete = "off";
        field.appendChild(input);
        form.appendChild(field);
    });
    const submit = createButton("Créer le compte technicien", "secondary-button", () => {});
    submit.type = "submit";
    form.appendChild(submit);
    const feedback = document.createElement("p");
    feedback.className = "muted";
    form.appendChild(feedback);
    card.appendChild(form);
    const list = document.createElement("div");
    list.className = "team-list";
    card.appendChild(list);
    container.appendChild(card);
    const load = async () => {
        list.textContent = "Chargement de l’équipe…";
        try {
            const response = await fetch("/api/auth/technicians", { credentials: "same-origin" });
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.message || "Impossible de charger l’équipe.");
            list.innerHTML = "";
            if (!payload.technicians?.length) return void (list.textContent = "Aucun technicien créé pour le moment.");
            payload.technicians.forEach(technician => {
                const item = document.createElement("div");
                item.className = "team-member";
                item.innerHTML = `<strong>${escapeHtml(technician.fullName || technician.username)}</strong><span>${escapeHtml(technician.phone || "Téléphone non renseigné")} · ${escapeHtml(technician.username)}</span>`;
                const toggle = createButton(technician.isActive ? "Désactiver" : "Réactiver", "secondary-button", async () => {
                    toggle.disabled = true;
                    const response = await fetch(`/api/auth/technicians/${encodeURIComponent(technician.id)}`, { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive: !technician.isActive }) });
                    if (!response.ok) feedback.textContent = "La mise à jour du technicien a échoué.";
                    await load();
                });
                item.appendChild(toggle);
                list.appendChild(item);
            });
        } catch (error) { list.textContent = error.message; }
    };
    form.addEventListener("submit", async event => {
        event.preventDefault();
        submit.disabled = true;
        feedback.textContent = "";
        try {
            const response = await fetch("/api/auth/technicians", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.message || "Création impossible.");
            form.reset();
            feedback.textContent = "Compte technicien créé.";
            await load();
        } catch (error) { feedback.textContent = error.message; }
        finally { submit.disabled = false; }
    });
    await load();
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
