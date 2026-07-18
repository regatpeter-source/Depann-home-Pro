import { ROUTES, STORAGE_KEYS, APP_VERSION, DEFAULT_SETTINGS, FONT_OPTIONS, LANG_OPTIONS } from "./config.js?v=44";
import { renderClients } from "./clients.js?v=44";
import { renderPhotoRecognition } from "./photo-recognition.js?v=44";
import { getSearchResults } from "./search.js?v=44";
import { state, resetSelection } from "./state.js?v=44";
import {
    clearHistory,
    getStoredRefs,
    getSettings,
    saveSettings
} from "./storage.js?v=44";
import { escapeHtml } from "./utils.js?v=44";
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
                "",
                result.title,
                result.subtitle,
                () => navigateToRef(result.ref),
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

    // header info
    const infoHtml = `
        <h2>Paramètres</h2>
        <div class="procedure-meta">
            <span>${database.brands.length} gamme(s)</span>
            <span>${getStoredRefs(STORAGE_KEYS.clients).length} client(s)</span>
            <span>${APP_VERSION}</span>
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
