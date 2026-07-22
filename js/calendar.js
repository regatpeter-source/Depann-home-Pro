import { ROUTES } from "./config.js?v=84";
import { createBillingDocumentForClient } from "./billing.js?v=84";
import { getSearchableClients, renderClients } from "./clients.js?v=84";
import { addClientActivityByName, synchronizeClients } from "./client-sync.js?v=84";
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
let calendarView = "month";
let technicians = [];

export async function renderCalendar(options = {}) {
    if (options.date) displayedMonth = calendarView === "month" ? firstDayOfMonth(options.date) : atNoon(options.date);
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

    const [result, availableTechnicians] = await Promise.all([
        loadEvents(displayedMonth),
        isReadOnlyCalendar() ? Promise.resolve([]) : loadTechnicians()
    ]);
    if (!result.ok) {
        header.innerHTML = `<p class="auth-message error">${escapeHtml(result.message || "Impossible de charger le planning.")}</p>`;
        return;
    }

    events = result.events;
    technicians = availableTechnicians;
    renderHeader(header);
    renderEventForm(formPanel);
    renderCalendarGrid(gridPanel);
}

export function createCalendarEventForClient(client) {
    if (!client) return;
    if (isReadOnlyCalendar()) {
        selectedEvent = null;
        renderCalendar({ date: new Date() });
        return;
    }
    const date = new Date();
    selectedEvent = {
        ...newEventForDate(toDateString(date)),
        clientName: client.name || "",
        location: formatClientAddress(client)
    };
    renderCalendar({ date });
}

function renderHeader(panel) {
    const periodLabel = getPeriodLabel();
    const readOnly = isReadOnlyCalendar();
    panel.innerHTML = `
        <div class="calendar-toolbar">
            <div>
                <p class="eyebrow">Planning professionnel</p>
                <h2>${escapeHtml(periodLabel)}</h2>
                <p class="muted">${readOnly ? "Consultation du planning de l’entreprise." : "Vos interventions, rendez-vous et indisponibilités sont synchronisés avec ce compte."}</p>
            </div>
            <div class="calendar-toolbar-actions">
                <button type="button" class="secondary-button" data-calendar-action="previous">← ${getPreviousLabel()}</button>
                <button type="button" class="secondary-button auth-outline-button" data-calendar-action="today">Aujourd’hui</button>
                <button type="button" class="secondary-button" data-calendar-action="next">${getNextLabel()} →</button>
                ${readOnly ? "" : '<button type="button" class="secondary-button" data-calendar-action="new">+ Nouveau rendez-vous</button>'}
            </div>
        </div>
        <div class="calendar-view-switcher" role="group" aria-label="Vue du planning">
            ${[ ["month", "Mois"], ["week", "Semaine"], ["day", "Jour"] ].map(([view, label]) => `<button type="button" class="secondary-button${calendarView === view ? " active" : ""}" data-calendar-view="${view}">${label}</button>`).join("")}
        </div>
        <div class="calendar-legend">
            ${COLOR_OPTIONS.map(color => `<span><i style="background:${color.value}"></i>${color.label}</span>`).join("")}
        </div>
    `;

    panel.querySelector("[data-calendar-action=previous]").addEventListener("click", () => {
        displayedMonth = shiftDisplayedDate(-1);
        selectedEvent = null;
        renderCalendar();
    });
    panel.querySelector("[data-calendar-action=next]").addEventListener("click", () => {
        displayedMonth = shiftDisplayedDate(1);
        selectedEvent = null;
        renderCalendar();
    });
    panel.querySelector("[data-calendar-action=today]").addEventListener("click", () => {
        displayedMonth = calendarView === "month" ? firstDayOfMonth(new Date()) : atNoon(new Date());
        selectedEvent = null;
        renderCalendar();
    });
    panel.querySelector("[data-calendar-action=new]")?.addEventListener("click", () => {
        selectedEvent = newEventForDate(toDateString(new Date()));
        renderCalendar();
    });
    panel.querySelectorAll("[data-calendar-view]").forEach(button => button.addEventListener("click", () => {
        calendarView = button.dataset.calendarView;
        displayedMonth = calendarView === "month" ? firstDayOfMonth(displayedMonth) : atNoon(displayedMonth);
        selectedEvent = null;
        renderCalendar();
    }));
}

function renderEventForm(panel) {
    if (!selectedEvent) {
        panel.hidden = true;
        panel.innerHTML = "";
        return;
    }

    panel.hidden = false;
    const event = selectedEvent;
    if (isReadOnlyCalendar()) {
        const client = findClientForEvent(event);
        panel.innerHTML = `
            <div class="calendar-event-detail">
                <div class="form-heading"><div><p class="eyebrow">Rendez-vous</p><h2>${escapeHtml(event.title)}</h2></div><button type="button" class="secondary-button" id="closeCalendarDetail">Fermer</button></div>
                <dl><dt>Date</dt><dd>${escapeHtml(formatActivityDate(event.date, event.startTime))}${event.endTime ? ` — ${escapeHtml(event.endTime)}` : ""}</dd>${event.assignedTechnicianName ? `<dt>Technicien</dt><dd>${escapeHtml(event.assignedTechnicianName)}</dd>` : ""}${event.clientName ? `<dt>Client</dt><dd>${escapeHtml(event.clientName)}</dd>` : ""}${event.location ? `<dt>Lieu</dt><dd>${escapeHtml(event.location)}</dd>` : ""}${event.notes ? `<dt>Notes</dt><dd>${escapeHtml(event.notes)}</dd>` : ""}</dl>
                ${client ? `
                    <div class="calendar-event-actions" aria-label="Actions pour ${escapeHtml(client.name)}">
                        <button type="button" class="secondary-button" data-client-action="open">Fiche client</button>
                        <button type="button" class="secondary-button" data-client-action="quote">+ Devis</button>
                        <button type="button" class="secondary-button" data-client-action="invoice">+ Facture</button>
                        <button type="button" class="secondary-button" data-client-action="messages">Notes / messages</button>
                    </div>
                    <form id="calendarClientUpload" class="calendar-client-upload">
                        <div><p class="eyebrow">Dossier d’intervention</p><h3>Ajouter une photo ou un fichier</h3><p class="muted">Le dépôt est ajouté au dossier de ${escapeHtml(client.name)}, sans modifier ses coordonnées.</p></div>
                        <label>Type de fichier<select name="type"><option value="Photo">Photo</option><option value="Autre">Document</option><option value="Devis">Devis</option><option value="Facture">Facture</option></select></label>
                        <label>Fichiers<input name="files" type="file" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt"></label>
                        <label>Photo depuis l’appareil<input name="cameraPhoto" type="file" accept="image/*" capture="environment"></label>
                        <div class="calendar-form-actions"><button type="submit" class="secondary-button">Déposer dans le dossier</button></div>
                        <p class="auth-message" aria-live="polite"></p>
                    </form>` : `<p class="auth-message error">Aucun dossier client correspondant à ce rendez-vous. Demandez à l’administrateur d’associer le rendez-vous à un client existant.</p>`}
            </div>`;
        panel.querySelector('[data-client-action="open"]')?.addEventListener("click", () => renderClients({ selectedId: client.id }));
        panel.querySelector('[data-client-action="quote"]')?.addEventListener("click", () => createBillingDocumentForClient("quote", client));
        panel.querySelector('[data-client-action="invoice"]')?.addEventListener("click", () => createBillingDocumentForClient("invoice", client));
        panel.querySelector('[data-client-action="messages"]')?.addEventListener("click", () => renderClients({ selectedId: client.id }));
        panel.querySelector("#calendarClientUpload")?.addEventListener("submit", eventSubmit => uploadClientAttachments(eventSubmit, client));
        panel.querySelector("#closeCalendarDetail").addEventListener("click", () => {
            selectedEvent = null;
            renderCalendar();
        });
        return;
    }
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
                    Technicien affecté
                    <select name="assignedTechnicianId"><option value="">Non affecté</option>${technicians.map(technician => `<option value="${escapeHtml(technician.id)}" ${String(event.assignedTechnicianId || "") === String(technician.id) ? "selected" : ""}>${escapeHtml(technician.fullName || technician.username)}</option>`).join("")}</select>
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
            <section class="calendar-availability" id="calendarAvailability" aria-live="polite"></section>
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
    ["date", "startTime", "endTime", "title"].forEach(name => form.elements[name].addEventListener("input", () => renderCalendarAvailability(form, event.id)));
    renderCalendarAvailability(form, event.id);

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

function renderCalendarAvailability(form, editedEventId) {
    const preview = form.querySelector("#calendarAvailability");
    const candidate = formToEvent(new FormData(form));
    if (!candidate.date) {
        preview.innerHTML = "<p class=\"muted\">Choisissez une date pour visualiser les créneaux du planning.</p>";
        return;
    }
    const sameDayEvents = events
        .filter(event => event.date === candidate.date && String(event.id || "") !== String(editedEventId || ""))
        .sort(compareEventTimes);
    const conflict = findLocalCalendarConflict(sameDayEvents, candidate);
    const candidateLabel = candidate.title || "Nouveau rendez-vous";
    preview.classList.toggle("has-conflict", Boolean(conflict));
    preview.innerHTML = `
        <div class="calendar-availability-heading"><div><p class="eyebrow">Aperçu planning</p><h3>${escapeHtml(formatPreviewDate(candidate.date))}</h3></div><p class="${conflict ? "auth-message error" : "muted"}">${conflict ? `Chevauchement avec « ${escapeHtml(conflict.title)} » (${escapeHtml(formatEventTime(conflict))}).` : "Créneau disponible."}</p></div>
        <div class="calendar-time-preview">
            ${sameDayEvents.map(event => `<article class="calendar-time-slot"><time>${escapeHtml(formatEventTime(event))}</time><strong>${escapeHtml(event.title)}</strong>${event.clientName ? `<small>${escapeHtml(event.clientName)}</small>` : ""}</article>`).join("") || '<p class="muted">Aucun autre rendez-vous ce jour.</p>'}
            <article class="calendar-time-slot calendar-time-slot-preview${conflict ? " conflict" : ""}"><time>${escapeHtml(formatEventTime(candidate))}</time><strong>${escapeHtml(candidateLabel)}</strong><small>Créneau en cours de saisie</small></article>
        </div>
    `;
}

function findLocalCalendarConflict(dayEvents, candidate) {
    if (!candidate.startTime || !candidate.endTime) return dayEvents[0] || null;
    return dayEvents.find(event => !event.startTime || !event.endTime || (event.startTime < candidate.endTime && event.endTime > candidate.startTime)) || null;
}

function compareEventTimes(first, second) {
    return (first.startTime || "00:00").localeCompare(second.startTime || "00:00");
}

function formatEventTime(event) {
    return event.startTime && event.endTime ? `${event.startTime} – ${event.endTime}` : "Toute la journée";
}

function formatPreviewDate(value) {
    return new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${value}T12:00:00`));
}

function findClientForEvent(event) {
    const clientName = normalizeText(event.clientName || "");
    return clientName ? getSearchableClients().find(client => normalizeText(client.name) === clientName) || null : null;
}

async function uploadClientAttachments(event, client) {
    event.preventDefault();
    const form = event.currentTarget;
    const feedback = form.querySelector(".auth-message");
    const button = form.querySelector("button[type=submit]");
    const payload = new FormData();
    payload.append("type", new FormData(form).get("type") || "Autre");
    ["files", "cameraPhoto"].forEach(name => Array.from(form.elements[name].files || []).forEach(file => payload.append("files", file)));
    if (![...payload.keys()].includes("files")) {
        feedback.textContent = "Sélectionnez au moins une photo ou un fichier.";
        feedback.classList.add("error");
        return;
    }
    button.disabled = true;
    feedback.textContent = "Dépôt en cours…";
    feedback.classList.remove("error");
    const response = await fetch(`/api/clients/${encodeURIComponent(client.id)}/attachments`, {
        method: "POST",
        credentials: "same-origin",
        body: payload
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
        feedback.textContent = data?.message || "Dépôt impossible.";
        feedback.classList.add("error");
        button.disabled = false;
        return;
    }
    await synchronizeClients();
    form.reset();
    feedback.textContent = data?.message || "Fichier ajouté au dossier.";
}

function renderCalendarGrid(panel) {
    if (calendarView !== "month") return renderCalendarList(panel);
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
        const readOnly = isReadOnlyCalendar();
        if (!readOnly) {
            cell.tabIndex = 0;
            cell.setAttribute("role", "button");
            cell.setAttribute("aria-label", `Ajouter un rendez-vous le ${formatShortDate(day)}`);
        }
        cell.innerHTML = `<span class="calendar-day-number" aria-hidden="true">${day.getDate()}</span><div class="calendar-event-list"></div>`;
        const openNewEvent = () => {
            selectedEvent = newEventForDate(date);
            renderCalendar({ date: day });
        };
        if (!readOnly) {
            cell.addEventListener("click", eventClick => {
                if (eventClick.target.closest(".calendar-event")) return;
                openNewEvent();
            });
            cell.addEventListener("keydown", eventKey => {
                if (eventKey.target !== cell || !["Enter", " "].includes(eventKey.key)) return;
                eventKey.preventDefault();
                openNewEvent();
            });
        }

        const eventList = cell.querySelector(".calendar-event-list");
        (eventsByDate.get(date) || []).forEach(event => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = `calendar-event color-${event.color}`;
            button.title = [event.title, event.assignedTechnicianName, event.clientName, event.startTime && `${event.startTime}${event.endTime ? ` – ${event.endTime}` : ""}`, event.location].filter(Boolean).join(" · ");
            button.innerHTML = `<span>${escapeHtml(event.startTime || "Toute la journée")}</span><strong>${escapeHtml(event.title)}</strong>${event.assignedTechnicianName ? `<small>👤 ${escapeHtml(event.assignedTechnicianName)}</small>` : ""}${event.clientName ? `<small>${escapeHtml(event.clientName)}</small>` : ""}`;
            button.addEventListener("click", () => {
                selectedEvent = event;
                renderCalendar({ date: day });
            });
            eventList.appendChild(button);
        });
        grid.appendChild(cell);
    });
}

function renderCalendarList(panel) {
    panel.hidden = false;
    const { start, end } = getDisplayedRange();
    const eventDates = new Map();
    events.forEach(event => {
        if (!eventDates.has(event.date)) eventDates.set(event.date, []);
        eventDates.get(event.date).push(event);
    });
    const days = [];
    for (const day = new Date(start); day <= end; day.setDate(day.getDate() + 1)) days.push(new Date(day));
    panel.innerHTML = `<div class="calendar-list-view">${days.map(day => {
        const date = toDateString(day);
        const dayEvents = eventDates.get(date) || [];
        return `<section class="calendar-list-day"><h3>${escapeHtml(new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" }).format(day))}</h3>${dayEvents.length ? `<div class="calendar-list-events">${dayEvents.map(event => `<button type="button" class="calendar-event color-${escapeHtml(event.color)}" data-calendar-event="${escapeHtml(event.id)}"><span>${escapeHtml(event.startTime || "Toute la journée")}</span><strong>${escapeHtml(event.title)}</strong>${event.assignedTechnicianName ? `<small>👤 ${escapeHtml(event.assignedTechnicianName)}</small>` : ""}${event.clientName ? `<small>${escapeHtml(event.clientName)}</small>` : ""}</button>`).join("")}</div>` : '<p class="muted">Aucun rendez-vous.</p>'}</section>`;
    }).join("")}</div>`;
    panel.querySelectorAll("[data-calendar-event]").forEach(button => button.addEventListener("click", () => {
        selectedEvent = events.find(event => String(event.id) === button.dataset.calendarEvent) || null;
        renderCalendar();
    }));
}

async function loadEvents() {
    const { start, end } = getDisplayedRange();
    const startDate = toDateString(start);
    const endDate = toDateString(end);
    return request(`/api/calendar/events?start=${encodeURIComponent(startDate)}&end=${encodeURIComponent(endDate)}`)
        .then(result => result.ok ? { ok: true, events: result.data.events || [] } : { ok: false, message: result.message });
}

async function loadTechnicians() {
    const result = await request("/api/auth/technicians");
    return result.ok ? (result.data?.technicians || []).filter(technician => technician.isActive) : [];
}

function isReadOnlyCalendar() {
    return document.body.dataset.role === "technician";
}

function getDisplayedRange() {
    if (calendarView === "day") {
        const day = atNoon(displayedMonth);
        return { start: day, end: day };
    }
    if (calendarView === "week") {
        const start = startOfWeek(displayedMonth);
        const end = new Date(start);
        end.setDate(end.getDate() + 6);
        return { start, end };
    }
    return { start: startOfCalendar(displayedMonth), end: endOfCalendar(displayedMonth) };
}

function getPeriodLabel() {
    if (calendarView === "month") return capitalize(new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" }).format(displayedMonth));
    if (calendarView === "day") return capitalize(new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(displayedMonth));
    const { start, end } = getDisplayedRange();
    return `Semaine du ${new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long" }).format(start)} au ${new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric" }).format(end)}`;
}

function getPreviousLabel() { return calendarView === "month" ? "Mois précédent" : calendarView === "week" ? "Semaine précédente" : "Jour précédent"; }
function getNextLabel() { return calendarView === "month" ? "Mois suivant" : calendarView === "week" ? "Semaine suivante" : "Jour suivant"; }
function shiftDisplayedDate(amount) {
    if (calendarView === "month") return addMonths(displayedMonth, amount);
    const next = atNoon(displayedMonth);
    next.setDate(next.getDate() + (calendarView === "week" ? amount * 7 : amount));
    return next;
}

function startOfWeek(date) {
    const start = atNoon(date);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    return start;
}

function atNoon(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12); }

function newEventForDate(date) {
    return { title: "", clientName: "", location: "", date, startTime: "", endTime: "", color: "blue", notes: "", assignedTechnicianId: "", assignedTechnicianName: "" };
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
        assignedTechnicianId: String(form.get("assignedTechnicianId") || ""),
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
