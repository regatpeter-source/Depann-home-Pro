import { ROUTES, STORAGE_KEYS, APP_VERSION, DEFAULT_SETTINGS, FONT_OPTIONS, LANG_OPTIONS } from "./config.js?v=44";
import { renderClients } from "./clients.js?v=44";
import { renderPhotoRecognition } from "./photo-recognition.js?v=44";
import { countProcedures } from "./data.js?v=44";
import { getSearchResults } from "./search.js?v=44";
import { state, resetSelection } from "./state.js?v=44";
import {
    addToHistory,
    clearHistory,
    getStoredRefs,
    isFavorite,
    toggleFavorite,
    getSettings,
    saveSettings
} from "./storage.js?v=44";
import { escapeHtml, formatList } from "./utils.js?v=44";
import {
    appendListSection,
    appendTechnicalNotice,
    appendWebPhotoGuides,
    appendResources,
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

export function initializeNavigation(loadedDatabase) {
    database = loadedDatabase;
    bindEvents();
    renderBrands();
}

function bindEvents() {
    const search = document.getElementById("search");
    const clientsBtn = document.getElementById("clientsBtn");
    const photoBtn = document.getElementById("photoBtn");
    const favoritesBtn = document.getElementById("favoritesBtn");
    const historyBtn = document.getElementById("historyBtn");

    search.addEventListener("input", event => {
        const value = event.target.value.toLowerCase().trim();

        if (!value) {
            renderBrands();
            return;
        }

        renderSearchResults(value);
    });

    clientsBtn.addEventListener("click", () => renderClients({ database, navigateToRef }));
    photoBtn?.addEventListener("click", () => renderPhotoRecognition(database, navigateToRef));
    favoritesBtn.addEventListener("click", renderFavorites);
    historyBtn.addEventListener("click", renderHistory);

    document.querySelectorAll(".nav-button").forEach(button => {
        button.addEventListener("click", () => {
            const nav = button.dataset.nav;

            if (nav === ROUTES.home) renderBrands();
            if (nav === ROUTES.search) focusSearch();
            if (nav === ROUTES.photo) renderPhotoRecognition(database, navigateToRef);
            if (nav === ROUTES.clients) renderClients({ database, navigateToRef });
            if (nav === ROUTES.favorites) renderFavorites();
            if (nav === ROUTES.settings) renderSettings();
        });
    });
}

export function renderBrands() {
    clearSearch();
    resetSelection("all");
    setPage("Marques", ROUTES.home);

    const container = getContainer();

    if (!database.brands.length) {
        container.appendChild(createInfo("Aucune marque disponible pour le moment."));
        return;
    }

    database.brands.forEach(brand => {
        container.appendChild(
            createCard(
                "🏷️",
                brand.name,
                `${brand.categories.length} catégorie(s)`,
                () => {
                    state.brand = brand;
                    renderCategories();
                }
            )
        );
    });
}

function renderCategories() {
    resetSelection("brand");
    setPage(state.brand.name, ROUTES.home);

    const container = getContainer();
    container.appendChild(createBackCard("Retour aux marques", renderBrands));

    if (!state.brand.categories.length) {
        container.appendChild(createInfo("Aucune catégorie disponible pour cette marque."));
        return;
    }

    state.brand.categories.forEach(category => {
        container.appendChild(
            createCard(
                "📂",
                category.name,
                `${category.products.length} produit(s)`,
                () => {
                    state.category = category;
                    renderProducts();
                }
            )
        );
    });
}

function renderProducts() {
    resetSelection("category");
    setPage(state.category.name, ROUTES.home);

    const container = getContainer();
    container.appendChild(createBackCard("Retour aux catégories", renderCategories));

    if (!state.category.products.length) {
        container.appendChild(createInfo("Aucun produit disponible dans cette catégorie."));
        return;
    }

    state.category.products.forEach(product => {
        container.appendChild(
            createCard(
                "🔧",
                product.name,
                `${product.procedures.length} procédure(s)`,
                () => {
                    state.product = product;
                    renderProcedures();
                }
            )
        );
    });
}

function renderProcedures() {
    resetSelection("product");
    setPage(state.product.name, ROUTES.home);

    const container = getContainer();
    container.appendChild(createBackCard("Retour aux produits", renderProducts));

    if (!state.product.procedures.length) {
        container.appendChild(createInfo("Aucune procédure disponible pour ce produit."));
        return;
    }

    state.product.procedures.forEach(procedure => {
        container.appendChild(
            createCard(
                "📄",
                procedure.title,
                `${procedure.duration} · ${procedure.difficulty}`,
                () => {
                    state.procedure = procedure;
                    renderProcedure();
                }
            )
        );
    });
}

function renderProcedure() {
    setPage(state.procedure.title, ROUTES.home, "detail");
    addToHistory(getCurrentRef());

    const container = getContainer();
    container.appendChild(createBackCard("Retour aux procédures", renderProcedures));

    const card = document.createElement("article");
    card.className = "brand-card full-card procedure-card";

    const currentRef = getCurrentRef();
    const favorite = isFavorite(currentRef);

    card.innerHTML = `
        <div class="procedure-header">
            <div>
                <p class="eyebrow">${escapeHtml(state.brand.name)} · ${escapeHtml(state.category.name)} · ${escapeHtml(state.product.name)}</p>
                <h2>${escapeHtml(state.procedure.title)}</h2>
            </div>
            <button type="button" class="secondary-button" id="toggleFavorite">
                ${favorite ? "★ Retirer" : "☆ Favori"}
            </button>
        </div>

        <div class="procedure-meta">
            <span>⏱ ${escapeHtml(state.procedure.duration)}</span>
            <span>📈 ${escapeHtml(state.procedure.difficulty)}</span>
            <span>🧰 ${escapeHtml(formatList(state.procedure.tools, "Aucun outil"))}</span>
        </div>
    `;

    appendTechnicalNotice(card, state.brand, state.category, state.product, state.procedure);
    appendListSection(card, "⚠️ Prérequis", state.procedure.requirements, "ul", "Aucun prérequis renseigné.");
    appendListSection(card, "📋 Étapes", state.procedure.steps, "ol", "Aucune étape renseignée.");
    appendListSection(card, "💡 Remarques", state.procedure.notes, "ul");
    appendWebPhotoGuides(card, state.brand, state.category, state.product, state.procedure);
    appendResources(card, state.procedure);

    container.appendChild(card);

    document.getElementById("toggleFavorite").addEventListener("click", () => {
        toggleFavorite(currentRef);
        renderProcedure();
    });
}

function renderSearchResults(query) {
    resetSelection("all");
    setPage("Résultats de recherche", ROUTES.search);

    const container = getContainer();
    const results = getSearchResults(database, query);

    if (!results.length) {
        container.appendChild(createInfo("Aucun résultat trouvé. Essayez avec une marque, un produit ou une panne."));
        return;
    }

    results.forEach(result => {
        container.appendChild(
            createCard(
                result.icon,
                result.title,
                result.subtitle,
                () => navigateToRef(result.ref)
            )
        );
    });
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

    renderRefList(favorites, container, "⭐");
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
        clearHistory();
        renderHistory();
    }));

    renderRefList(history, container, "🕘");
}

function renderRefList(refs, container, icon) {
    refs.forEach(ref => {
        const target = resolveRef(ref);
        if (!target?.procedure) return;

        container.appendChild(
            createCard(
                icon,
                target.procedure.title,
                `${target.brand.name} · ${target.product.name}`,
                () => navigateToRef(ref)
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

    // header info
    const infoHtml = `
        <h2>⚙️ Paramètres</h2>
        <div class="procedure-meta">
            <span>🏷️ ${database.brands.length} marque(s)</span>
            <span>📄 ${countProcedures(database)} procédure(s)</span>
            <span>👥 ${getStoredRefs(STORAGE_KEYS.clients).length} client(s)</span>
            <span>🚀 ${APP_VERSION}</span>
        </div>
    `;

    card.innerHTML = infoHtml;

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

    const saveBtn = createButton("Enregistrer", "primary-button", () => {
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
        const searchPlaceholder = lang === 'en' ? "Search a procedure, motor, remote..." : "Rechercher une procédure, un moteur, une télécommande...";
        const headerP = document.querySelector('header .header-content p');
        if (headerP) headerP.textContent = subtitle;
        const search = document.getElementById('search'); if (search) search.placeholder = searchPlaceholder;
        document.querySelectorAll('footer .nav-button span').forEach((span, idx) => {
            const texts = lang === 'en'
                ? ['Home','Search','Clients','Favorites','Settings']
                : ['Accueil','Recherche','Clients','Favoris','Paramètres'];
            span.textContent = texts[idx] || span.textContent;
        });
        renderSettings();
    });

    const resetBtn = createButton("Réinitialiser", "secondary-button", () => {
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
}

function getCurrentRef() {
    return {
        type: "procedure",
        brandIndex: database.brands.indexOf(state.brand),
        categoryIndex: state.brand.categories.indexOf(state.category),
        productIndex: state.category.products.indexOf(state.product),
        procedureIndex: state.product.procedures.indexOf(state.procedure)
    };
}

function resolveRef(ref) {
    const brand = database.brands[ref.brandIndex];
    const category = brand?.categories[ref.categoryIndex];
    const product = category?.products[ref.productIndex];
    const procedure = product?.procedures[ref.procedureIndex];

    return { brand, category, product, procedure };
}

function navigateToRef(ref) {
    const target = resolveRef(ref);

    state.brand = target.brand || null;
    state.category = target.category || null;
    state.product = target.product || null;
    state.procedure = target.procedure || null;

    clearSearch();

    if (ref.type === "brand" && state.brand) renderCategories();
    else if (ref.type === "category" && state.category) renderProducts();
    else if (ref.type === "product" && state.product) renderProcedures();
    else if (ref.type === "procedure" && state.procedure) renderProcedure();
    else renderError("Élément introuvable", "La donnée demandée n'existe plus dans la base.");
}
