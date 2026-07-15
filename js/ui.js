import { state } from "./state.js";
import { escapeHtml } from "./utils.js";

export function getContainer() {
    return document.getElementById("brands");
}

export function getPageTitle() {
    return document.getElementById("pageTitle");
}

export function setPage(title, view = "home", layout = "grid") {
    state.view = view;

    const container = getContainer();
    const pageTitle = getPageTitle();

    pageTitle.textContent = title;
    container.className = layout === "detail" ? "detail-layout" : "cards-grid";
    container.innerHTML = "";

    updateActiveNav(view);
    renderBreadcrumb();
}

export function createCard(icon, title, subtitle, onClick, options = {}) {
    const card = document.createElement("article");
    card.className = `brand-card ${options.full ? "full-card" : ""}`.trim();
    card.tabIndex = 0;
    card.setAttribute("role", "button");

    const iconElement = document.createElement("div");
    iconElement.className = "card-icon";
    iconElement.textContent = icon;

    const titleElement = document.createElement("h2");
    titleElement.textContent = title;

    card.append(iconElement, titleElement);

    if (subtitle) {
        const subtitleElement = document.createElement("p");
        subtitleElement.className = "card-subtitle";
        subtitleElement.textContent = subtitle;
        card.appendChild(subtitleElement);
    }

    card.addEventListener("click", onClick);
    card.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onClick();
        }
    });

    return card;
}

export function createBackCard(label, onClick) {
    return createCard("⬅️", label, "Revenir à l'écran précédent", onClick);
}

export function createInfo(message) {
    const info = document.createElement("p");
    info.className = "empty-state";
    info.textContent = message;
    return info;
}

export function createButton(label, className, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
}

export function renderBreadcrumb() {
    const parts = ["🏠 Accueil"];

    if (state.brand) parts.push(state.brand.name);
    if (state.category) parts.push(state.category.name);
    if (state.product) parts.push(state.product.name);
    if (state.procedure) parts.push(state.procedure.title);

    document.getElementById("breadcrumb").textContent = parts.join(" > ");
}

export function updateActiveNav(view) {
    document.querySelectorAll(".nav-button").forEach(button => {
        button.classList.toggle("active", button.dataset.nav === view);
    });
}

export function focusSearch() {
    updateActiveNav("search");
    document.getElementById("search").focus();
}

export function clearSearch() {
    document.getElementById("search").value = "";
}

export function renderError(title, detail = "") {
    setPage("Erreur", "home", "detail");

    const card = document.createElement("article");
    card.className = "brand-card full-card";
    card.innerHTML = `<h2>⚠️ ${escapeHtml(title)}</h2><p>${escapeHtml(detail)}</p>`;
    getContainer().appendChild(card);
}

export function appendListSection(parent, title, items, listType = "ul", emptyMessage = "") {
    if (!items.length && !emptyMessage) return;

    const section = document.createElement("section");
    section.className = "procedure-section";

    const heading = document.createElement("h3");
    heading.textContent = title;
    section.appendChild(heading);

    if (!items.length) {
        const empty = document.createElement("p");
        empty.className = "muted";
        empty.textContent = emptyMessage;
        section.appendChild(empty);
    } else {
        const list = document.createElement(listType);
        items.forEach(item => {
            const li = document.createElement("li");
            li.textContent = item;
            list.appendChild(li);
        });
        section.appendChild(list);
    }

    parent.appendChild(section);
}

export function appendResources(parent, procedure) {
    const resources = [
        ...procedure.documents.map(item => ({ label: item, icon: "📎" })),
        ...procedure.photos.map(item => ({ label: item, icon: "🖼️" })),
        ...procedure.videos.map(item => ({ label: item, icon: "🎬" }))
    ];

    if (!resources.length) return;

    const section = document.createElement("section");
    section.className = "procedure-section";

    const heading = document.createElement("h3");
    heading.textContent = "📚 Ressources";
    section.appendChild(heading);

    const list = document.createElement("ul");
    resources.forEach(resource => {
        const item = document.createElement("li");
        item.textContent = `${resource.icon} ${resource.label}`;
        list.appendChild(item);
    });

    section.appendChild(list);
    parent.appendChild(section);
}
