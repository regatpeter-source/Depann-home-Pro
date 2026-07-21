import { ROUTES } from "./config.js?v=72";
import { getSearchableClients } from "./clients.js?v=72";
import { addClientActivityByName } from "./client-sync.js?v=72";
import { resetSelection } from "./state.js?v=44";
import { escapeHtml, normalizeText } from "./utils.js?v=44";
import { clearSearch, createInfo, getContainer, setPage } from "./ui.js?v=44";

const COLOR_OPTIONS = [
    { id: "blue", label: "Intervention", value: "#2563eb" },
    { id: "green", label: "Confirmé", value: "#15803d" },
    { id: "orange", label: "À préparer", value: "#d97706" },
    { id: "red", label: "Urgent", value: "#dc2626" },
    { id: "purple", label: "Personnel", value: "#7c3aed" },
    { id: "gray", label: "Indisponible", value: "#475569" }
];
const WEEK_DAYS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];

let displayedMonth = firstDayOfMonth(new Date());
let events = [];
let selectedEvent = null;

export async function renderCalendar(options = {}) {
    if (options.date) displayedMonth = firstDayOfMonth(options.date);
    if (options.event) selectedEvent = options.event;

    clearSearch();
    resetSelection("all");
    setPage("Planning", ROUTES.calendar, "detail");

    const container = getContainer();
    const header = document.createElement("section");
    header.className = "client-panel calendar-panel";
    const formPanel = document.createElement("section");
    formPanel.className = "client-panel calendar-form-panel";
    const gridPanel = document.createElement("section");
    gridPanel.className = "client-panel calendar-grid-panel";
    container.append(header, formPanel, gridPanel);

    header.innerHTML = "<p class=\"muted\">Chargement du planning…</p>";
    formPanel.hidden = true;
    gridPanel.hidden = true;

    const result = await loadEvents(displayedMonth);
    if (!result.ok) {
        header.innerHTML = `<p class="auth-message error">${escapeHtml(result.message || "Impossible de charger le planning.")}</p>`;
        return;
    }

    events = result.events;
    renderHeader(header);
    renderEventForm(formPanel);
    renderCalendarGrid(gridPanel);
}

export function createCalendarEventForClient(client) {
    if (!client) return;
    const date = new Date();
    selectedEvent = {
        ...newEventForDate(toDateString(date)),
        clientName: client.name || "",
        location: formatClientAddress(client)
    };
    renderCalendar({ date });
}

function renderHeader(panel) {
    const monthLabel = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" }).format(displayedMonth);
    panel.innerHTML = `
        <div class="calendar-toolbar">
            <div>
                <p class="eyebrow">Planning professionnel</p>
                <h2>${escapeHtml(capitalize(monthLabel))}</h2>
                <p class="muted">Vos interventions, rendez-vous et indisponibilités sont synchronisés avec ce compte.</p>
            </div>
            <div class="calendar-toolbar-actions">
                <button type="button" class="secondary-button" data-calendar-action="previous">← Mois précédent</button>
                <button type="button" class="secondary-button auth-outline-button" data-calendar-action="today">Aujourd’hui</button>
                <button type="button" class="secondary-button" data-calendar-action="next">Mois suivant →</button>
                <button type="button" class="secondary-button" data-calendar-action="new">+ Nouveau rendez-vous</button>
            </div>
        </div>
        <div class="calendar-legend">
            ${COLOR_OPTIONS.map(color => `<span><i style="background:${color.value}"></i>${color.label}</span>`).join("")}
        </div>
    `;

    panel.querySelector("[data-calendar-action=previous]").addEventListener("click", () => {
        displayedMonth = addMonths(displayedMonth, -1);
        selectedEvent = null;
        renderCalendar();
    });
    panel.querySelector("[data-calendar-action=next]").addEventListener("click", () => {
        displayedMonth = addMonths(displayedMonth, 1);
        selectedEvent = null;
        renderCalendar();
    });
    panel.querySelector("[data-calendar-action=today]").addEventListener("click", () => {
        displayedMonth = firstDayOfMonth(new Date());
        selectedEvent = null;
        renderCalendar();
    });
    panel.querySelector("[data-calendar-action=new]").addEventListener("click", () => {
        selectedEvent = newEventForDate(toDateString(new Date()));
        renderCalendar();
    });
}

function renderEventForm(panel) {
    if (!selectedEvent) {
        panel.hidden = true;
        panel.innerHTML = "";
        return;
    }

    panel.hidden = false;
    const event = selectedEvent;
    const isEditing = Boolean(event.id);
    const clients = getSearchableClients().sort((first, second) => first.name.localeCompare(second.name, "fr"));
    panel.innerHTML = `
        <form id="calendarEventForm" class="client-form">
            <div class="form-heading">
                <div>
                    <p class="eyebrow">${isEditing ? "Modification" : "Nouveau rendez-vous"}</p>
                    <h2>${isEditing ? "Modifier le rendez-vous" : "Planifier une intervention"}</h2>
                </div>
                ${isEditing ? '<button type="button" class="secondary-button" id="cancelCalendarEdit">Annuler</button>' : ""}
            </div>
            <div class="form-grid">
                <label>
                    Titre *
                    <input name="title" maxlength="160" required placeholder="Ex. Intervention volet roulant" value="${escapeHtml(event.title)}">
                </label>
                <label>
                    Client
                    <input name="clientName" list="calendarClients" maxlength="160" placeholder="Nom du client" value="${escapeHtml(event.clientName)}">
                    <datalist id="calendarClients">${clients.map(client => `<option value="${escapeHtml(client.name)}">${escapeHtml([client.city, client.phone].filter(Boolean).join(" · "))}</option>`).join("")}</datalist>
                </label>
                <label>
                    Date *
                    <input name="date" type="date" required value="${escapeHtml(event.date)}">
                </label>
                <label>
                    Couleur / statut
                    <select name="color">${COLOR_OPTIONS.map(color => `<option value="${color.id}" ${event.color === color.id ? "selected" : ""}>${color.label}</option>`).join("")}</select>
                </label>
                <label>
                    Début
                    <input name="startTime" type="time" value="${escapeHtml(event.startTime)}">
                </label>
                <label>
                    Fin
                    <input name="endTime" type="time" value="${escapeHtml(event.endTime)}">
                </label>
                <label class="form-wide">
                    Adresse / lieu
                    <input name="location" maxlength="255" placeholder="Adresse d’intervention ou atelier" value="${escapeHtml(event.location)}">
                </label>
                <label class="form-wide">
                    Notes
                    <textarea name="notes" rows="3" maxlength="2000" placeholder="Travaux prévus, matériel à prévoir, consignes d’accès…">${escapeHtml(event.notes)}</textarea>
                </label>
            </div>
            <p id="calendarFormMessage" class="auth-message" aria-live="polite"></p>
            <div class="calendar-form-actions">
                <button type="submit" class="secondary-button">${isEditing ? "Enregistrer les modifications" : "Ajouter au planning"}</button>
                ${isEditing ? '<button type="button" class="secondary-button danger-button" id="deleteCalendarEvent">Supprimer</button>' : ""}
            </div>
        </form>
    `;

    panel.querySelector("#cancelCalendarEdit")?.addEventListener("click", () => {
        selectedEvent = null;
        renderCalendar();
    });
    const form = panel.querySelector("#calendarEventForm");
    const clientInput = form.querySelector("[name=clientName]");
    const locationInput = form.querySelector("[name=location]");
    const fillClientAddress = () => {
        const clientName = normalizeText(clientInput.value);
        const client = clients.find(item => normalizeText(item.name) === clientName);
        const address = client ? formatClientAddress(client) : "";
        if (address) locationInput.value = address;
    };
    clientInput.addEventListener("input", fillClientAddress);
    clientInput.addEventListener("change", fillClientAddress);

    form.addEventListener("submit", async eventSubmit => {
        eventSubmit.preventDefault();
        const form = eventSubmit.currentTarget;
        const button = form.querySelector("button[type=submit]");
        const message = panel.querySelector("#calendarFormMessage");
        button.disabled = true;
        message.textContent = "Enregistrement…";
        message.classList.remove("error");

        const payload = formToEvent(new FormData(form));
        const result = isEditing
            ? await request(`/api/calendar/events/${encodeURIComponent(event.id)}`, { method: "PUT", body: JSON.stringify(payload) })
            : await request("/api/calendar/events", { method: "POST", body: JSON.stringify(payload) });
        if (!result.ok) {
            message.textContent = result.message || "Impossible d’enregistrer le rendez-vous.";
            message.classList.add("error");
            button.disabled = false;
            return;
        }
        if (!isEditing && payload.clientName) addClientActivityByName(payload.clientName, {
            type: "appointment",
            label: "Rendez-vous créé",
            detail: [payload.title, formatActivityDate(payload.date, payload.startTime)].filter(Boolean).join(" · ")
        });
        displayedMonth = firstDayOfMonth(new Date(`${payload.date}T12:00:00`));
        selectedEvent = null;
        renderCalendar();
    });
    panel.querySelector("#deleteCalendarEvent")?.addEventListener("click", async () => {
        if (!confirm("Supprimer ce rendez-vous du planning ?")) return;
        const result = await request(`/api/calendar/events/${encodeURIComponent(event.id)}`, { method: "DELETE" });
        if (!result.ok) {
            panel.querySelector("#calendarFormMessage").textContent = result.message || "Suppression impossible.";
            panel.querySelector("#calendarFormMessage").classList.add("error");
            return;
        }
        selectedEvent = null;
        renderCalendar();
    });
}

function renderCalendarGrid(panel) {
    panel.hidden = false;
    const days = getCalendarDays(displayedMonth);
    const eventsByDate = new Map();
    events.forEach(event => {
        if (!eventsByDate.has(event.date)) eventsByDate.set(event.date, []);
        eventsByDate.get(event.date).push(event);
    });
    const today = toDateString(new Date());

    panel.innerHTML = `
        <div class="calendar-weekdays">${WEEK_DAYS.map(day => `<span>${day}</span>`).join("")}</div>
        <div class="calendar-grid" id="calendarGrid"></div>
    `;
    const grid = panel.querySelector("#calendarGrid");
    days.forEach(day => {
        const date = toDateString(day);
        const isCurrentMonth = day.getMonth() === displayedMonth.getMonth();
        const cell = document.createElement("article");
        cell.className = `calendar-day${isCurrentMonth ? "" : " outside"}${date === today ? " today" : ""}`;
        cell.tabIndex = 0;
        cell.setAttribute("role", "button");
        cell.setAttribute("aria-label", `Ajouter un rendez-vous le ${formatShortDate(day)}`);
        cell.innerHTML = `<span class="calendar-day-number" aria-hidden="true">${day.getDate()}</span><div class="calendar-event-list"></div>`;
        const openNewEvent = () => {
            selectedEvent = newEventForDate(date);
            renderCalendar({ date: day });
        };
        cell.addEventListener("click", eventClick => {
            if (eventClick.target.closest(".calendar-event")) return;
            openNewEvent();
        });
        cell.addEventListener("keydown", eventKey => {
            if (eventKey.target !== cell || !["Enter", " "].includes(eventKey.key)) return;
            eventKey.preventDefault();
            openNewEvent();
        });

        const eventList = cell.querySelector(".calendar-event-list");
        (eventsByDate.get(date) || []).forEach(event => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = `calendar-event color-${event.color}`;
            button.title = [event.title, event.clientName, event.startTime && `${event.startTime}${event.endTime ? ` – ${event.endTime}` : ""}`, event.location].filter(Boolean).join(" · ");
            button.innerHTML = `<span>${escapeHtml(event.startTime || "Toute la journée")}</span><strong>${escapeHtml(event.title)}</strong>${event.clientName ? `<small>${escapeHtml(event.clientName)}</small>` : ""}`;
            button.addEventListener("click", () => {
                selectedEvent = event;
                renderCalendar({ date: day });
            });
            eventList.appendChild(button);
        });
        grid.appendChild(cell);
    });
}

async function loadEvents(month) {
    const start = toDateString(startOfCalendar(month));
    const end = toDateString(endOfCalendar(month));
    return request(`/api/calendar/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`)
        .then(result => result.ok ? { ok: true, events: result.data.events || [] } : { ok: false, message: result.message });
}

function newEventForDate(date) {
    return { title: "", clientName: "", location: "", date, startTime: "", endTime: "", color: "blue", notes: "" };
}

function formToEvent(form) {
    return {
        title: String(form.get("title") || "").trim(),
        clientName: String(form.get("clientName") || "").trim(),
        location: String(form.get("location") || "").trim(),
        date: String(form.get("date") || ""),
        startTime: String(form.get("startTime") || ""),
        endTime: String(form.get("endTime") || ""),
        color: String(form.get("color") || "blue"),
        notes: String(form.get("notes") || "").trim()
    };
}

function formatClientAddress(client) {
    return [client.address, client.city].map(value => String(value || "").trim()).filter(Boolean).join(", ");
}

function firstDayOfMonth(date) {
    return new Date(date.getFullYear(), date.getMonth(), 1, 12);
}

function addMonths(date, amount) {
    return new Date(date.getFullYear(), date.getMonth() + amount, 1, 12);
}

function startOfCalendar(month) {
    const first = firstDayOfMonth(month);
    const mondayOffset = (first.getDay() + 6) % 7;
    first.setDate(first.getDate() - mondayOffset);
    return first;
}

function endOfCalendar(month) {
    const last = new Date(month.getFullYear(), month.getMonth() + 1, 0, 12);
    const sundayOffset = 6 - ((last.getDay() + 6) % 7);
    last.setDate(last.getDate() + sundayOffset);
    return last;
}

function getCalendarDays(month) {
    const result = [];
    const day = startOfCalendar(month);
    const end = endOfCalendar(month);
    while (day <= end) {
        result.push(new Date(day));
        day.setDate(day.getDate() + 1);
    }
    return result;
}

function toDateString(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function formatShortDate(date) {
    return new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long" }).format(date);
}

function formatActivityDate(date, time) {
    return `${new Intl.DateTimeFormat("fr-FR").format(new Date(`${date}T12:00:00`))}${time ? ` à ${time}` : ""}`;
}

function capitalize(value) {
    return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

async function request(url, options = {}) {
    try {
        const response = await fetch(url, {
            credentials: "same-origin",
            headers: { "Content-Type": "application/json", ...(options.headers || {}) },
            ...options
        });
        const data = response.status === 204 ? null : await response.json().catch(() => null);
        return { ok: response.ok, data, message: data?.message };
    } catch {
        return { ok: false, data: null, message: "Serveur indisponible." };
    }
}
