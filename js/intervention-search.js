import { ROUTES } from "./config.js?v=135";
import { pageSizeOptions, paginateItems, renderBusinessPagination } from "./pagination.js?v=1";
import { matches } from "./search.js?v=75";
import { resetSelection } from "./state.js?v=44";
import { escapeHtml } from "./utils.js?v=44";
import { clearSearch, createInfo, getContainer, setPage } from "./ui.js?v=44";

const DEFAULT_FILTERS = Object.freeze({ query: "", status: "all", startDate: "", endDate: "" });
const STATUS_LABELS = Object.freeze({
    planned: "Planifiée",
    confirmed: "Confirmée",
    in_progress: "En cours",
    completed: "Terminée",
    cancelled: "Annulée"
});

let filters = { ...DEFAULT_FILTERS };
let paginationState = { page: 1, pageSize: 20 };
let lastResults = [];
let hasSearched = false;
let openIntervention = null;

export function renderInterventionSearch(options = {}) {
    if (typeof options.openEvent === "function") openIntervention = options.openEvent;
    clearSearch();
    resetSelection("all");
    setPage("Retrouver une intervention", ROUTES.calendar, "detail");

    const container = getContainer();
    const panel = document.createElement("section");
    panel.className = "client-panel intervention-search-panel";
    panel.innerHTML = `
        <div class="intervention-search-heading">
            <div><p class="eyebrow">Interventions accessibles</p><h2>Recherche d’une intervention</h2></div>
            <button type="button" class="secondary-button" data-refresh-interventions>Actualiser</button>
        </div>
        <form class="client-directory-form intervention-search-form" data-intervention-search-form>
            <label>Recherche
                <input name="query" type="search" placeholder="N° d’intervention, client, adresse, contenu…" value="${escapeHtml(filters.query)}">
            </label>
            <label>Statut
                <select name="status">
                    <option value="all" ${filters.status === "all" ? "selected" : ""}>Tous les statuts</option>
                    ${Object.entries(STATUS_LABELS).map(([value, label]) => `<option value="${value}" ${filters.status === value ? "selected" : ""}>${label}</option>`).join("")}
                </select>
            </label>
            <label>Du
                <input name="startDate" type="date" value="${escapeHtml(filters.startDate)}">
            </label>
            <label>Au
                <input name="endDate" type="date" value="${escapeHtml(filters.endDate)}">
            </label>
            <div class="client-directory-actions intervention-search-actions">
                <button type="submit" class="secondary-button">Rechercher</button>
                <button type="button" class="secondary-button" data-clear-interventions>Effacer</button>
            </div>
        </form>
        <p class="client-search-hint">Vous pouvez combiner le numéro, le client, l’adresse, le contenu, le statut et la période. Seules les interventions autorisées pour ce poste sont consultables.</p>
        <p class="auth-message" data-intervention-feedback aria-live="polite"></p>`;

    const results = document.createElement("section");
    results.className = "client-directory-results intervention-search-results";
    results.id = "interventionSearchResults";
    container.append(panel, results);

    panel.querySelector("[data-intervention-search-form]").addEventListener("submit", async event => {
        event.preventDefault();
        filters = readFilters(new FormData(event.currentTarget));
        paginationState.page = 1;
        await runSearch(results, panel);
        results.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    panel.querySelector("[data-clear-interventions]").addEventListener("click", () => {
        filters = { ...DEFAULT_FILTERS };
        paginationState.page = 1;
        hasSearched = false;
        lastResults = [];
        panel.querySelector("[data-intervention-search-form]").reset();
        panel.querySelector("[data-intervention-feedback]").textContent = "";
        renderPrompt(results);
    });
    panel.querySelector("[data-refresh-interventions]").addEventListener("click", async event => {
        const button = event.currentTarget;
        button.disabled = true;
        if (!hasSearched) filters = readFilters(new FormData(panel.querySelector("[data-intervention-search-form]")));
        await runSearch(results, panel);
        button.disabled = false;
    });

    if (hasSearched) renderResults(results, lastResults);
    else renderPrompt(results);
}

function renderPrompt(section) {
    section.innerHTML = "";
    section.appendChild(createInfo("Utilisez les critères ci-dessus pour retrouver une intervention. Lancez la recherche pour afficher les résultats."));
}

async function runSearch(section, panel) {
    const feedback = panel.querySelector("[data-intervention-feedback]");
    feedback.textContent = "";
    feedback.classList.remove("error");
    if (filters.startDate && filters.endDate && filters.startDate > filters.endDate) {
        feedback.textContent = "La date de début doit précéder la date de fin.";
        feedback.classList.add("error");
        return;
    }
    section.innerHTML = '<p class="muted">Recherche des interventions…</p>';
    try {
        const events = await loadAuthorizedInterventions(filters.startDate, filters.endDate);
        lastResults = events.filter(event => eventMatchesFilters(event, filters));
        hasSearched = true;
        renderResults(section, lastResults);
    } catch (error) {
        section.innerHTML = "";
        feedback.textContent = error.message || "Impossible de rechercher les interventions.";
        feedback.classList.add("error");
        section.appendChild(createInfo("La recherche n’a pas pu aboutir. Vérifiez votre connexion puis réessayez."));
    }
}

async function loadAuthorizedInterventions(startDate, endDate) {
    const start = startDate || "2000-01-01";
    const end = endDate || "2100-12-31";
    const response = await fetch(`/api/calendar/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`, { credentials: "same-origin" });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.message || "Impossible de charger les interventions autorisées.");
    return (Array.isArray(payload?.events) ? payload.events : []).filter(event => event.eventType === "appointment");
}

function eventMatchesFilters(event, activeFilters) {
    const status = event.isCompleted ? "completed" : String(event.status || "planned");
    if (activeFilters.status !== "all" && status !== activeFilters.status) return false;
    if (activeFilters.startDate && String(event.date || "") < activeFilters.startDate) return false;
    if (activeFilters.endDate && String(event.date || "") > activeFilters.endDate) return false;
    if (!activeFilters.query) return true;
    return matches([
        `Intervention numéro ${event.id || ""}`,
        event.title,
        event.clientName,
        event.location,
        event.notes,
        event.assignedTechnicianName,
        ...(Array.isArray(event.assignedTechnicians) ? event.assignedTechnicians.map(member => member.fullName) : [])
    ].filter(Boolean).join(" "), activeFilters.query);
}

function renderResults(section, events) {
    section.innerHTML = "";
    if (!events.length) {
        section.appendChild(createInfo("Aucune intervention accessible ne correspond à ces critères. Modifiez les critères puis relancez la recherche."));
        return;
    }
    const orderedEvents = [...events].sort((first, second) => eventTimestamp(second) - eventTimestamp(first));
    const pagination = paginateItems(orderedEvents, paginationState);
    const summary = document.createElement("div");
    summary.className = "client-search-results-summary intervention-search-summary";
    summary.tabIndex = -1;
    summary.innerHTML = `<div><strong>${events.length} intervention${events.length > 1 ? "s" : ""} trouvée${events.length > 1 ? "s" : ""}</strong><span>Classées de la plus récente à la plus ancienne.</span></div><label>Afficher<select data-intervention-page-size aria-label="Nombre d’interventions par page">${pageSizeOptions(pagination.pageSize, "interventions")}</select></label>`;
    section.appendChild(summary);

    const wrapper = document.createElement("div");
    wrapper.className = "client-table-wrapper intervention-search-table-wrapper";
    const table = document.createElement("table");
    table.className = "client-table intervention-search-table";
    table.innerHTML = '<thead><tr><th scope="col">Intervention</th><th scope="col">Client</th><th scope="col">Date et heure</th><th scope="col">Adresse</th><th scope="col">Statut</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody></tbody>';
    const body = table.querySelector("tbody");
    pagination.items.forEach(event => body.appendChild(renderResultRow(event)));
    wrapper.appendChild(table);
    section.appendChild(wrapper);

    const paginationNode = document.createElement("nav");
    paginationNode.className = "business-pagination";
    paginationNode.setAttribute("aria-label", "Pages des interventions");
    section.appendChild(paginationNode);
    renderBusinessPagination(paginationNode, pagination, {
        singular: "intervention",
        plural: "interventions",
        onPageChange: page => {
            paginationState.page = page;
            renderResults(section, events);
            section.scrollIntoView({ behavior: "smooth", block: "start" });
        }
    });
    summary.querySelector("[data-intervention-page-size]").addEventListener("change", event => {
        paginationState.pageSize = Number(event.currentTarget.value);
        paginationState.page = 1;
        renderResults(section, events);
    });
}

function renderResultRow(event) {
    const row = document.createElement("tr");
    const status = event.isCompleted ? "completed" : String(event.status || "planned");
    row.innerHTML = `
        <td data-label="Intervention"><strong>N° ${escapeHtml(event.id || "—")}</strong><small>${escapeHtml(event.title || "Intervention")}</small></td>
        <td data-label="Client"><strong>${escapeHtml(event.clientName || "Client non renseigné")}</strong>${event.assignedTechnicianName ? `<small>Affectée à ${escapeHtml(event.assignedTechnicianName)}</small>` : ""}</td>
        <td data-label="Date et heure"><strong>${escapeHtml(formatDate(event.date))}</strong><small>${escapeHtml(formatTimeRange(event))}</small></td>
        <td data-label="Adresse">${escapeHtml(event.location || "Adresse non renseignée")}</td>
        <td data-label="Statut"><span class="intervention-search-status status-${escapeHtml(status)}">${escapeHtml(STATUS_LABELS[status] || "Planifiée")}</span></td>
        <td data-label="Actions"><div class="client-card-actions"><button type="button" class="secondary-button" data-open-intervention>Voir l’intervention</button></div></td>`;
    row.querySelector("[data-open-intervention]").addEventListener("click", () => openIntervention?.(event));
    return row;
}

function readFilters(formData) {
    const status = String(formData.get("status") || "all");
    return {
        query: String(formData.get("query") || "").trim(),
        status: status === "all" || Object.hasOwn(STATUS_LABELS, status) ? status : "all",
        startDate: validDateInput(formData.get("startDate")),
        endDate: validDateInput(formData.get("endDate"))
    };
}

function validDateInput(value) {
    const date = String(value || "");
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
}

function eventTimestamp(event) {
    return new Date(`${event.date || "1970-01-01"}T${event.startTime || "00:00"}:00`).getTime() || 0;
}

function formatDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return "Date non renseignée";
    return new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium" }).format(new Date(`${value}T12:00:00`));
}

function formatTimeRange(event) {
    if (!event.startTime) return "Horaire non renseigné";
    return `${event.startTime}${event.endTime ? ` – ${event.endTime}` : ""}`;
}
