import { ROUTES } from "./config.js?v=105";
import { createBillingDocumentForClient, viewBillingDocument } from "./billing.js?v=147";
import { getSearchableClients } from "./clients.js?v=136";
import { addClientActivityByName, synchronizeClients } from "./client-sync.js?v=116";
import { renderClientMessages } from "./messages.js?v=106";
import { renderLeakReportWizard as renderTechnicalReports } from "./leak-report-wizard.js?v=5";
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
const EVENT_TYPE_OPTIONS = [
    { id: "appointment", label: "Rendez-vous", title: "Intervention", color: "blue" },
    { id: "task", label: "Tâche interne", title: "Tâche à réaliser", color: "orange" },
    { id: "vacation", label: "Vacances", title: "Vacances", color: "purple" },
    { id: "sick_leave", label: "Arrêt", title: "Arrêt", color: "red" },
    { id: "unavailable", label: "Indisponibilité", title: "Indisponibilité", color: "gray" }
];

let displayedMonth = firstDayOfMonth(new Date());
let events = [];
let selectedEvent = null;
let calendarView = "month";
let technicians = [];
let showAllTechnicians = true;
let visibleTechnicianIds = new Set();

window.addEventListener("depannhome:billing-document-saved", event => {
    const appointmentId = String(event.detail?.appointmentId || "");
    const appointment = events.find(item => String(item.id) === appointmentId);
    if (!appointment) return;
    selectedEvent = appointment;
    calendarView = "day";
    displayedMonth = atNoon(new Date(`${appointment.date}T12:00:00`));
    renderCalendar({ date: displayedMonth, event: appointment });
});

export async function renderCalendar(options = {}) {
    if (options.date) displayedMonth = calendarView === "month" ? firstDayOfMonth(options.date) : atNoon(options.date);
    if (options.event) selectedEvent = options.event;

    clearSearch();
    resetSelection("all");
    const technicianHome = isReadOnlyCalendar();
    setPage(technicianHome ? "Accueil" : "Planning", ROUTES.calendar, "detail");

    const container = getContainer();
    const header = document.createElement("section");
    header.className = technicianHome ? "technician-calendar-home" : "client-panel calendar-panel";
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
    if (technicianHome) {
        window.dispatchEvent(new CustomEvent("depannhome:technician-calendar-viewed", { detail: { events } }));
    }
    renderHeader(header);
    renderEventForm(formPanel);
    renderCalendarGrid(gridPanel);
}

export function renderCalendarOverview() {
    selectedEvent = null;
    calendarView = "day";
    displayedMonth = atNoon(new Date());
    renderCalendar();
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
    if (readOnly) {
        panel.innerHTML = `
            <p class="eyebrow">Mon planning</p>
            <h2>${escapeHtml(periodLabel)}</h2>
            <div class="technician-calendar-navigation" aria-label="Navigation dans le planning">
                <button type="button" class="secondary-button" data-calendar-action="previous" aria-label="Jour précédent">←</button>
                <button type="button" class="secondary-button active" data-calendar-action="today">Aujourd’hui</button>
                <button type="button" class="secondary-button" data-calendar-action="next" aria-label="Jour suivant">→</button>
            </div>
            <div class="technician-calendar-view-switcher" role="group" aria-label="Vue du planning">
                ${[ ["day", "Jour"], ["week", "Semaine"], ["month", "Mois"] ].map(([view, label]) => `<button type="button" class="secondary-button${calendarView === view ? " active" : ""}" data-calendar-view="${view}">${label}</button>`).join("")}
            </div>
        `;
        bindCalendarNavigation(panel);
        bindCalendarViewSwitcher(panel);
        return;
    }
    panel.innerHTML = `
        <div class="calendar-toolbar">
            <div>
                <p class="eyebrow">Planning professionnel</p>
                <h2>${escapeHtml(periodLabel)}</h2>
            </div>
            <div class="calendar-toolbar-actions">
                <button type="button" class="secondary-button" data-calendar-action="previous">← ${getPreviousLabel()}</button>
                <button type="button" class="secondary-button auth-outline-button" data-calendar-action="today">Aujourd’hui</button>
                <button type="button" class="secondary-button" data-calendar-action="next">${getNextLabel()} →</button>
                ${readOnly ? "" : '<button type="button" class="secondary-button" data-calendar-action="new">+ Nouveau rendez-vous</button><button type="button" class="secondary-button" data-calendar-action="new-task">+ Nouvelle tâche</button>'}
            </div>
        </div>
        <div class="calendar-view-switcher" role="group" aria-label="Vue du planning">
            ${[ ["month", "Mois"], ["week", "Semaine"], ["day", "Jour"] ].map(([view, label]) => `<button type="button" class="secondary-button${calendarView === view ? " active" : ""}" data-calendar-view="${view}">${label}</button>`).join("")}
        </div>
        ${readOnly ? "" : renderTechnicianFilter()}
        <div class="calendar-legend">
            ${COLOR_OPTIONS.map(color => `<span><i style="background:${color.value}"></i>${color.label}</span>`).join("")}
        </div>
    `;

    bindCalendarNavigation(panel);
    panel.querySelector("[data-calendar-action=new]")?.addEventListener("click", () => {
        selectedEvent = newEventForDate(toDateString(new Date()));
        renderCalendar();
    });
    panel.querySelector("[data-calendar-action=new-task]")?.addEventListener("click", () => {
        selectedEvent = { ...newEventForDate(toDateString(new Date())), eventType: "task", title: getEventType("task").title, color: getEventType("task").color };
        renderCalendar();
    });
    bindCalendarViewSwitcher(panel);
    panel.querySelector("[data-calendar-filter=all]")?.addEventListener("change", event => {
        showAllTechnicians = event.currentTarget.checked;
        if (showAllTechnicians) visibleTechnicianIds.clear();
        renderCalendar();
    });
    panel.querySelectorAll("[data-calendar-technician]").forEach(input => input.addEventListener("change", event => {
        showAllTechnicians = false;
        const id = String(event.currentTarget.dataset.calendarTechnician);
        if (event.currentTarget.checked) visibleTechnicianIds.add(id);
        else visibleTechnicianIds.delete(id);
        renderCalendar();
    }));
}

function bindCalendarViewSwitcher(panel) {
    panel.querySelectorAll("[data-calendar-view]").forEach(button => button.addEventListener("click", () => {
        const nextView = button.dataset.calendarView;
        calendarView = nextView;
        displayedMonth = nextView === "month" ? firstDayOfMonth(displayedMonth) : atNoon(displayedMonth);
        selectedEvent = null;
        renderCalendar();
    }));
}

function bindCalendarNavigation(panel) {
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
}

function renderTechnicianFilter() {
    const count = showAllTechnicians ? technicians.length : visibleTechnicianIds.size;
    const groups = groupTechniciansByDepartment(technicians);
    return `
        <section class="calendar-technician-filter" aria-label="Filtrer le planning par technicien">
            <div><p class="eyebrow">Équipe affichée</p><strong>${count} technicien${count === 1 ? "" : "s"} sélectionné${count === 1 ? "" : "s"}</strong></div>
            <div class="calendar-technician-options">
                <label><input type="checkbox" data-calendar-filter="all" ${showAllTechnicians ? "checked" : ""}> Toute l’équipe</label>
                ${groups.map(([department, members]) => `<span class="calendar-technician-group"><em>${escapeHtml(department)}</em>${members.map(technician => `<label><input type="checkbox" data-calendar-technician="${escapeHtml(technician.id)}" ${showAllTechnicians || visibleTechnicianIds.has(String(technician.id)) ? "checked" : ""}> ${escapeHtml(technician.fullName || technician.username)}</label>`).join("")}</span>`).join("")}
            </div>
        </section>
    `;
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
        if (event.eventType !== "appointment") {
            panel.innerHTML = `
                <div class="calendar-event-detail">
                    <div class="form-heading"><div><p class="eyebrow">${escapeHtml(getEventType(event.eventType).label)}</p><h2>${escapeHtml(event.title)}</h2></div><button type="button" class="secondary-button" id="closeCalendarDetail">Fermer</button></div>
                    <section class="calendar-appointment-information"><dl><dt>Date</dt><dd>${escapeHtml(formatActivityDate(event.date, event.startTime))}${event.endTime ? ` — ${escapeHtml(event.endTime)}` : ""}</dd>${renderAssignedTechniciansDetail(event)}${event.location ? `<dt>Lieu</dt><dd>${escapeHtml(event.location)}</dd>` : ""}${event.notes ? `<dt>Notes</dt><dd>${escapeHtml(event.notes)}</dd>` : ""}</dl></section>
                </div>`;
            panel.querySelector("#closeCalendarDetail").addEventListener("click", () => {
                selectedEvent = null;
                renderCalendar();
            });
            return;
        }
        const client = findClientForEvent(event);
        const navigationHref = client ? getClientNavigationHref(client) : "";
        const phoneHref = client ? getClientPhoneHref(client) : "";
        panel.innerHTML = `
            <div class="calendar-event-detail">
                <div class="form-heading"><div><p class="eyebrow">Rendez-vous</p><h2>${escapeHtml(event.title)}</h2></div><button type="button" class="secondary-button" id="closeCalendarDetail">Fermer</button></div>
                ${client ? `
                    <section class="calendar-client-summary">
                        <div><p class="eyebrow">Fiche client</p><h3>${escapeHtml(client.name)}</h3><p class="muted">${escapeHtml(client.type || "Client")}</p></div>
                        <div class="calendar-contact-list">
                            <div class="calendar-contact-item"><span>Téléphone</span><strong>${escapeHtml(client.phone || "Non renseigné")}</strong>${phoneHref ? `<a class="secondary-button client-navigation-button" href="${escapeHtml(phoneHref)}" aria-label="Appeler ${escapeHtml(client.name)} au ${escapeHtml(client.phone)}">Appeler</a>` : ""}</div>
                            ${client.email ? `<div class="calendar-contact-item"><span>E-mail</span><strong>${escapeHtml(client.email)}</strong><a class="secondary-button client-navigation-button" href="mailto:${escapeHtml(client.email)}" aria-label="Écrire à ${escapeHtml(client.name)}">E-mail</a></div>` : ""}
                            <div class="calendar-contact-item"><span>Adresse</span><strong>${escapeHtml(formatClientAddress(client) || event.location || "Non renseignée")}</strong>${navigationHref ? `<a class="secondary-button client-navigation-button" href="${escapeHtml(navigationHref)}" aria-label="Y aller vers ${escapeHtml(formatClientAddress(client))}">Y aller</a>` : ""}</div>
                            ${client.equipment ? `<div class="calendar-contact-item calendar-client-full-width"><span>Équipements</span><strong>${escapeHtml(client.equipment)}</strong></div>` : ""}
                            ${client.notes ? `<div class="calendar-contact-item calendar-client-full-width"><span>Consignes client</span><strong>${escapeHtml(client.notes)}</strong></div>` : ""}
                        </div>
                    </section>
                    <section class="calendar-appointment-information">
                        <p class="eyebrow">Informations du rendez-vous</p>
                        <dl><dt>Date</dt><dd>${escapeHtml(formatActivityDate(event.date, event.startTime))}${event.endTime ? ` — ${escapeHtml(event.endTime)}` : ""}</dd>${renderAssignedTechniciansDetail(event)}${event.notes ? `<dt>Notes</dt><dd>${escapeHtml(event.notes)}</dd>` : ""}</dl>
                    </section>
                    ${renderInterventionPhotosHtml(client, event)}
                    <section class="calendar-billing-actions report-entry-point">
                        <div><p class="eyebrow">Rapport technique</p><h3>Recherche de fuite</h3><p class="muted">Rédigez le rapport terrain, joignez les photos et transmettez-le à l’administration.</p></div>
                        <div><button type="button" class="secondary-button" id="openTechnicalReport">Ouvrir le rapport</button></div>
                    </section>
                    <section class="calendar-linked-documents" id="calendarLinkedDocuments"><p class="muted">Chargement des devis et factures de cette intervention…</p></section>
                    ${isTechnicianBillingAllowed() ? `<section class="calendar-billing-actions">
                        <div><p class="eyebrow">Fin d’intervention</p><h3>${isReadOnlyCalendar() ? "Devis" : "Devis et facture"}</h3><p class="muted">${isReadOnlyCalendar() ? "Créez le devis de cette intervention." : "Créez le document adapté après avoir renseigné l’intervention."}</p></div>
                        <div><button type="button" class="secondary-button" data-client-action="quote">Créer un devis</button>${isReadOnlyCalendar() ? "" : '<button type="button" class="secondary-button" data-client-action="invoice">Créer une facture</button>'}</div>
                    </section>` : ""}
                    ${event.eventType === "appointment" ? renderQuitusHtml(event) : ""}
                    <div class="calendar-client-messages-slot"></div>
                    <form id="calendarClientUpload" class="calendar-client-upload">
                        <div><p class="eyebrow">Dossier d’intervention</p><h3>Ajouter une photo ou un fichier</h3></div>
                        <label>Type de fichier<select name="type"><option value="Photo">Photo</option><option value="Autre">Document</option><option value="Devis">Devis</option><option value="Facture">Facture</option></select></label>
                        <label>Fichiers<input name="files" type="file" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt"></label>
                        <label>Photo depuis l’appareil<input name="cameraPhoto" type="file" accept="image/*" capture="environment"></label>
                        <div class="calendar-form-actions"><button type="submit" class="secondary-button">Déposer dans le dossier</button></div>
                        <p class="auth-message" aria-live="polite"></p>
                    </form>` : `<p class="auth-message error">Aucun dossier client correspondant à ce rendez-vous. Demandez à l’administrateur d’associer le rendez-vous à un client existant.</p>`}
            </div>`;
        panel.querySelector(".calendar-client-messages-slot")?.append(renderClientMessages(client));
        if (event.eventType === "appointment" && client) initializeQuitusForm(panel, event);
        loadLinkedBillingDocuments(panel.querySelector("#calendarLinkedDocuments"), event);
        panel.querySelector('[data-client-action="quote"]')?.addEventListener("click", () => createBillingDocumentForClient("quote", client, event.id));
        panel.querySelector('[data-client-action="invoice"]')?.addEventListener("click", () => createBillingDocumentForClient("invoice", client, event.id));
        panel.querySelector("#openTechnicalReport")?.addEventListener("click", () => renderTechnicalReports(0, event.id));
        panel.querySelector("#calendarInterventionPhotos")?.addEventListener("submit", eventSubmit => uploadInterventionPhotos(eventSubmit, client, event));
        panel.querySelector("#calendarClientUpload")?.addEventListener("submit", eventSubmit => uploadClientAttachments(eventSubmit, client, event));
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
                    <p class="eyebrow">${isEditing ? "Modification" : event.eventType === "task" ? "Nouvelle tâche" : "Nouveau rendez-vous"}</p>
                    <h2>${isEditing ? "Modifier l’élément du planning" : event.eventType === "task" ? "Planifier une tâche interne" : "Planifier une intervention"}</h2>
                </div>
                ${isEditing ? '<button type="button" class="secondary-button" id="cancelCalendarEdit">Annuler</button>' : ""}
            </div>
            <div class="form-grid">
                <label>
                    Type
                    <select name="eventType">${EVENT_TYPE_OPTIONS.map(type => `<option value="${type.id}" ${event.eventType === type.id ? "selected" : ""}>${type.label}</option>`).join("")}</select>
                </label>
                <label>
                    Titre *
                    <input name="title" maxlength="160" required placeholder="Ex. Intervention volet roulant" value="${escapeHtml(event.title)}">
                </label>
                <label class="calendar-client-field">
                    Client
                    <span class="calendar-client-picker"><input name="clientName" list="calendarClients" maxlength="160" placeholder="Nom du client" value="${escapeHtml(event.clientName)}"><button type="button" class="secondary-button" id="openCalendarClient" hidden>Ouvrir la fiche</button></span>
                    <datalist id="calendarClients">${clients.map(client => `<option value="${escapeHtml(client.name)}">${escapeHtml([client.city, client.phone].filter(Boolean).join(" · "))}</option>`).join("")}</datalist>
                </label>
                <section class="calendar-client-preview form-wide" id="calendarClientPreview" hidden></section>
                <label>
                    Date *
                    <input name="date" type="date" required value="${escapeHtml(event.date)}">
                </label>
                ${isEditing ? "" : renderMultiDatePlanning(event)}
                <label>
                    Couleur / statut
                    <select name="color">${COLOR_OPTIONS.map(color => `<option value="${color.id}" ${event.color === color.id ? "selected" : ""}>${color.label}</option>`).join("")}</select>
                </label>
                ${renderTechnicianAssignmentField(event)}
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
    const clientField = clientInput.closest("label");
    const locationInput = form.querySelector("[name=location]");
    const eventTypeInput = form.querySelector("[name=eventType]");
    const openClientButton = form.querySelector("#openCalendarClient");
    const clientPreview = form.querySelector("#calendarClientPreview");
    const technicianSearch = form.querySelector("#calendarTechnicianSearch");
    const primaryTechnicianInput = form.querySelector("[name=assignedTechnicianId]");
    const assignmentInputs = [...form.querySelectorAll("[data-calendar-assignment]")];
    const multiDatePlanning = initializeMultiDatePlanning(form, event);
    const syncPrimaryTechnician = () => {
        const selected = assignmentInputs.filter(input => input.checked).map(input => String(input.value));
        const current = String(primaryTechnicianInput.value || event.assignedTechnicianId || "");
        primaryTechnicianInput.innerHTML = selected.length
            ? selected.map(id => {
                const technician = technicians.find(item => String(item.id) === id);
                return `<option value="${escapeHtml(id)}" ${current === id ? "selected" : ""}>${escapeHtml(technician?.fullName || technician?.username || "Technicien")}</option>`;
            }).join("")
            : '<option value="">Aucun technicien sélectionné</option>';
        if (selected.length && !selected.includes(current)) primaryTechnicianInput.value = selected[0];
        primaryTechnicianInput.disabled = !selected.length;
    };
    const filterTechnicians = () => {
        const search = normalizeText(technicianSearch.value);
        form.querySelectorAll("[data-calendar-assignment-option]").forEach(option => {
            option.hidden = Boolean(search) && !normalizeText(option.dataset.calendarAssignmentOption).includes(search);
        });
        form.querySelectorAll("[data-calendar-assignment-group]").forEach(group => {
            group.hidden = [...group.querySelectorAll("[data-calendar-assignment-option]")].every(option => option.hidden);
        });
    };
    const fillClientAddress = () => {
        const clientName = normalizeText(clientInput.value);
        const client = clients.find(item => normalizeText(item.name) === clientName);
        const address = client ? formatClientAddress(client) : "";
        if (address) locationInput.value = address;
        openClientButton.hidden = !client;
        clientPreview.hidden = !client;
        clientPreview.innerHTML = client ? renderCalendarClientPreview(client) : "";
        openClientButton.onclick = () => {
            if (client) window.dispatchEvent(new CustomEvent("depannhome:open-client", { detail: { clientId: client.id } }));
        };
    };
    clientInput.addEventListener("input", fillClientAddress);
    clientInput.addEventListener("change", fillClientAddress);
    fillClientAddress();
    assignmentInputs.forEach(input => input.addEventListener("change", () => {
        syncPrimaryTechnician();
        renderCalendarAvailability(form, event.id);
        multiDatePlanning?.refresh();
    }));
    technicianSearch.addEventListener("input", filterTechnicians);
    syncPrimaryTechnician();
    eventTypeInput.addEventListener("change", () => {
        const type = getEventType(eventTypeInput.value);
        if (!event.id || form.elements.title.value === getEventType(event.eventType).title) form.elements.title.value = type.title;
        form.elements.color.value = type.color;
        if (type.id !== "appointment") {
            clientInput.value = "";
            if (type.id !== "task") {
                locationInput.value = "";
                form.elements.startTime.value = "";
                form.elements.endTime.value = "";
            }
            fillClientAddress();
        }
        clientField.hidden = type.id !== "appointment";
        clientPreview.hidden = type.id !== "appointment" || !clientInput.value;
        renderCalendarAvailability(form, event.id);
    });
    clientField.hidden = eventTypeInput.value !== "appointment";
    ["date", "startTime", "endTime", "title", "assignedTechnicianId"].forEach(name => form.elements[name].addEventListener("input", () => {
        renderCalendarAvailability(form, event.id);
        if (name === "date") multiDatePlanning?.setPrimaryDate();
        if (["date", "startTime", "endTime", "assignedTechnicianId"].includes(name)) multiDatePlanning?.refresh();
    }));
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
            message.textContent = result.message || "Impossible d’enregistrer cet élément du planning.";
            message.classList.add("error");
            button.disabled = false;
            return;
        }
        if (!isEditing && payload.clientName) addClientActivityByName(payload.clientName, {
            type: "appointment",
            label: (result.data?.count || payload.dates?.length || 1) > 1 ? `${result.data?.count || payload.dates.length} rendez-vous créés` : "Rendez-vous créé",
            detail: [payload.title, formatActivityDate(payload.date, payload.startTime)].filter(Boolean).join(" · ")
        });
        displayedMonth = firstDayOfMonth(new Date(`${payload.date}T12:00:00`));
        selectedEvent = null;
        renderCalendar();
    });
    panel.querySelector("#deleteCalendarEvent")?.addEventListener("click", async () => {
        if (!confirm("Supprimer cet élément du planning ?")) return;
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

function renderMultiDatePlanning(event) {
    return `
        <section class="calendar-multi-date-planning form-wide" id="calendarMultiDatePlanning">
            <div class="calendar-multi-date-heading"><div><p class="eyebrow">Planification étendue</p><h3>Proposer ou sélectionner plusieurs dates</h3></div><span class="calendar-multi-date-count" id="calendarMultiDateCount">1 date</span></div>
            <p class="muted">Une occurrence du ${escapeHtml(event.eventType === "task" ? "travail" : "rendez-vous")} sera créée pour chaque date sélectionnée, avec les mêmes techniciens et horaires.</p>
            <section class="calendar-date-range" aria-label="Sélectionner une période">
                <div><p class="eyebrow">Rendez-vous longue durée</p><h4>Sélectionner une période</h4><p class="muted">Au poste PC, cliquez sur le premier jour et faites glisser jusqu’au dernier jour dans le calendrier.</p></div>
                <div class="calendar-date-range-inputs"><label>Date de début<input type="date" id="calendarRangeStart" value="${escapeHtml(event.date)}"></label><label>Date de fin<input type="date" id="calendarRangeEnd" value="${escapeHtml(event.date)}"></label></div>
                <div class="calendar-range-picker" id="calendarRangePicker" aria-label="Calendrier de sélection de période"></div>
            </section>
            <div class="calendar-multi-date-controls"><label>Ajouter une date depuis le calendrier<input type="date" id="calendarAdditionalDate" value="${escapeHtml(event.date)}"></label><button type="button" class="secondary-button" id="calendarAddDate">Ajouter</button></div>
            <div class="calendar-selected-dates" id="calendarSelectedDates" aria-live="polite"></div>
            <div class="calendar-date-proposals" id="calendarDateProposals" aria-live="polite"><p class="muted">Recherche des créneaux proposés…</p></div>
            <div class="calendar-selected-date-inputs" id="calendarSelectedDateInputs"></div>
        </section>
    `;
}

function initializeMultiDatePlanning(form, event) {
    const section = form.querySelector("#calendarMultiDatePlanning");
    if (!section) return null;
    const selectedDates = new Set([form.elements.date.value]);
    let primaryDate = form.elements.date.value;
    let availableDates = [];
    let requestVersion = 0;
    let rangeMonth = firstDayOfMonth(new Date(`${primaryDate}T12:00:00`));
    let draggingRange = false;
    let rangeAnchor = primaryDate;
    const selected = () => [...selectedDates].filter(Boolean).sort();
    const render = () => {
        const dates = selected();
        section.querySelector("#calendarMultiDateCount").textContent = `${dates.length} date${dates.length > 1 ? "s" : ""}`;
        section.querySelector("#calendarSelectedDateInputs").innerHTML = dates.map(date => `<input type="hidden" name="dates" value="${escapeHtml(date)}">`).join("");
        section.querySelector("#calendarSelectedDates").innerHTML = dates.map(date => `<span class="calendar-selected-date"><time>${escapeHtml(formatPlanningDate(date))}</time>${date === primaryDate ? '<em>Date principale</em>' : `<button type="button" data-remove-planning-date="${escapeHtml(date)}" aria-label="Retirer le ${escapeHtml(formatPlanningDate(date))}">×</button>`}</span>`).join("");
        section.querySelector("#calendarRangeStart").value = dates[0] || primaryDate;
        section.querySelector("#calendarRangeEnd").value = dates.at(-1) || primaryDate;
        renderRangePicker();
        section.querySelector("#calendarDateProposals").innerHTML = availableDates.length ? `
            <div class="calendar-date-proposals-heading"><strong>Créneaux disponibles proposés</strong><span>Cliquez pour ${dates.length > 1 ? "ajouter ou retirer" : "sélectionner plusieurs dates"}.</span></div>
            <div class="calendar-date-proposal-grid">${availableDates.map(date => `<button type="button" class="calendar-date-proposal${selectedDates.has(date) ? " selected" : ""}" data-planning-date="${escapeHtml(date)}" aria-pressed="${selectedDates.has(date)}">${escapeHtml(formatPlanningDate(date))}</button>`).join("")}</div>
        ` : '<p class="muted">Sélectionnez un technicien et des horaires pour recevoir des propositions de créneaux libres, ou ajoutez des dates avec le calendrier ci-dessus.</p>';
        section.querySelectorAll("[data-planning-date]").forEach(button => button.addEventListener("click", () => {
            const date = button.dataset.planningDate;
            if (selectedDates.has(date) && date !== primaryDate) selectedDates.delete(date);
            else selectedDates.add(date);
            render();
        }));
        section.querySelectorAll("[data-remove-planning-date]").forEach(button => button.addEventListener("click", () => {
            selectedDates.delete(button.dataset.removePlanningDate);
            render();
        }));
    };
    const setDateRange = (first, last) => {
        if (!first || !last) return;
        const start = first <= last ? first : last;
        const end = first <= last ? last : first;
        const dates = datesBetween(start, end).slice(0, 30);
        selectedDates.clear();
        dates.forEach(date => selectedDates.add(date));
        primaryDate = dates[0];
        form.elements.date.value = primaryDate;
        section.querySelector("#calendarAdditionalDate").value = dates.at(-1);
        render();
    };
    const renderRangePicker = () => {
        const picker = section.querySelector("#calendarRangePicker");
        const months = [rangeMonth, addMonths(rangeMonth, 1)];
        picker.innerHTML = `
            <div class="calendar-range-picker-toolbar"><button type="button" class="secondary-button" data-range-month="previous" aria-label="Mois précédent">←</button><strong>${escapeHtml(formatRangeMonth(rangeMonth))} — ${escapeHtml(formatRangeMonth(months[1]))}</strong><button type="button" class="secondary-button" data-range-month="next" aria-label="Mois suivant">→</button></div>
            <div class="calendar-range-months">${months.map(renderRangeMonth).join("")}</div>
        `;
        picker.querySelector("[data-range-month=previous]").addEventListener("click", () => { rangeMonth = addMonths(rangeMonth, -1); renderRangePicker(); });
        picker.querySelector("[data-range-month=next]").addEventListener("click", () => { rangeMonth = addMonths(rangeMonth, 1); renderRangePicker(); });
        picker.querySelectorAll("[data-range-date]").forEach(button => {
            button.addEventListener("pointerdown", pointer => {
                if (pointer.pointerType === "touch") return;
                pointer.preventDefault();
                draggingRange = true;
                rangeAnchor = button.dataset.rangeDate;
                setDateRange(rangeAnchor, rangeAnchor);
            });
            button.addEventListener("pointerenter", () => {
                if (draggingRange) setDateRange(rangeAnchor, button.dataset.rangeDate);
            });
            button.addEventListener("click", () => {
                if (!draggingRange) setDateRange(button.dataset.rangeDate, button.dataset.rangeDate);
            });
        });
    };
    const refresh = async () => {
        const date = form.elements.date.value;
        const technicianIds = [...form.querySelectorAll("[data-calendar-assignment]:checked")].map(input => input.value);
        if (!date || !technicianIds.length) {
            availableDates = [];
            render();
            return;
        }
        const end = new Date(`${date}T12:00:00`);
        end.setDate(end.getDate() + 60);
        const version = ++requestVersion;
        section.querySelector("#calendarDateProposals").innerHTML = '<p class="muted">Recherche des créneaux disponibles pour les techniciens sélectionnés…</p>';
        const query = new URLSearchParams({ start: date, end: toDateString(end), technicianIds: technicianIds.join(","), startTime: form.elements.startTime.value, endTime: form.elements.endTime.value, count: "14" });
        const result = await request(`/api/calendar/availability?${query}`);
        if (version !== requestVersion) return;
        availableDates = result.ok ? result.data?.availableDates || [] : [];
        render();
    };
    section.querySelector("#calendarAddDate").addEventListener("click", () => {
        const date = section.querySelector("#calendarAdditionalDate").value;
        if (!date) return;
        selectedDates.add(date);
        render();
    });
    section.querySelector("#calendarRangeStart").addEventListener("change", () => {
        const end = section.querySelector("#calendarRangeEnd").value || section.querySelector("#calendarRangeStart").value;
        setDateRange(section.querySelector("#calendarRangeStart").value, end);
    });
    section.querySelector("#calendarRangeEnd").addEventListener("change", () => {
        const start = section.querySelector("#calendarRangeStart").value || section.querySelector("#calendarRangeEnd").value;
        setDateRange(start, section.querySelector("#calendarRangeEnd").value);
    });
    document.addEventListener("pointerup", () => { draggingRange = false; }, { once: false });
    render();
    refresh();
    return {
        refresh,
        setPrimaryDate: () => {
            const nextDate = form.elements.date.value;
            if (!nextDate || nextDate === primaryDate) return;
            selectedDates.delete(primaryDate);
            primaryDate = nextDate;
            selectedDates.add(primaryDate);
            rangeMonth = firstDayOfMonth(new Date(`${primaryDate}T12:00:00`));
            section.querySelector("#calendarAdditionalDate").value = primaryDate;
            render();
        }
    };
}

function renderRangeMonth(month) {
    const selectedStart = document.querySelector("#calendarRangeStart")?.value || "";
    const selectedEnd = document.querySelector("#calendarRangeEnd")?.value || "";
    const days = getCalendarDays(month);
    return `<section class="calendar-range-month"><h5>${escapeHtml(formatRangeMonth(month))}</h5><div class="calendar-range-weekdays">${WEEK_DAYS.map(day => `<span>${day.slice(0, 1)}</span>`).join("")}</div><div class="calendar-range-days">${days.map(day => {
        const date = toDateString(day);
        const inMonth = day.getMonth() === month.getMonth();
        const selected = selectedStart && selectedEnd && date >= selectedStart && date <= selectedEnd;
        return `<button type="button" class="calendar-range-day${inMonth ? "" : " outside"}${selected ? " selected" : ""}${date === selectedStart ? " range-start" : ""}${date === selectedEnd ? " range-end" : ""}" data-range-date="${date}" aria-label="${escapeHtml(formatPlanningDate(date))}">${day.getDate()}</button>`;
    }).join("")}</div></section>`;
}

function datesBetween(start, end) {
    const dates = [];
    const cursor = new Date(`${start}T12:00:00`);
    const last = new Date(`${end}T12:00:00`);
    while (cursor <= last) {
        dates.push(toDateString(cursor));
        cursor.setDate(cursor.getDate() + 1);
    }
    return dates;
}

function formatRangeMonth(value) {
    return capitalize(new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" }).format(value));
}

function formatPlanningDate(value) {
    return new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(new Date(`${value}T12:00:00`));
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
    const candidateTechnicians = new Set(getAssignedTechnicianIds(candidate));
    return dayEvents.find(event => {
        const eventTechnicians = getAssignedTechnicianIds(event);
        const sharesTechnician = candidateTechnicians.size
            ? eventTechnicians.some(id => candidateTechnicians.has(id))
            : !eventTechnicians.length;
        return sharesTechnician && (!event.startTime || !event.endTime || (event.startTime < candidate.endTime && event.endTime > candidate.startTime));
    }) || null;
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

function renderCalendarClientPreview(client) {
    return `
        <div class="calendar-client-preview-heading"><div><p class="eyebrow">Informations du client</p><h3>${escapeHtml(client.name)}</h3></div><span>${escapeHtml(client.type || "Client")}</span></div>
        <div class="calendar-client-preview-details">
            <span><strong>Téléphone</strong>${escapeHtml(client.phone || "Non renseigné")}</span>
            <span><strong>E-mail</strong>${escapeHtml(client.email || "Non renseigné")}</span>
            <span class="calendar-client-preview-wide"><strong>Adresse</strong>${escapeHtml(formatClientAddress(client) || "Non renseignée")}</span>
            ${client.equipment ? `<span class="calendar-client-preview-wide"><strong>Équipements</strong>${escapeHtml(client.equipment)}</span>` : ""}
            ${client.notes ? `<span class="calendar-client-preview-wide"><strong>Consignes client</strong>${escapeHtml(client.notes)}</span>` : ""}
        </div>`;
}

function renderTechnicianAssignmentField(event) {
    const selected = new Set(getAssignedTechnicianIds(event));
    const groups = groupTechniciansByDepartment(technicians);
    return `
        <section class="calendar-technician-assignment form-wide">
            <div class="calendar-technician-assignment-heading"><div><p class="eyebrow">Équipe d’intervention</p><h3>Techniciens affectés</h3><p class="muted">Recherchez puis cochez tous les intervenants. Le référent est utilisé pour les anciens rendez-vous et les exports.</p></div></div>
            <label class="calendar-technician-search">Rechercher un technicien ou un pôle<input id="calendarTechnicianSearch" type="search" placeholder="Ex. dépannage, chantier, Léa…" autocomplete="off"></label>
            <div class="calendar-technician-assignment-groups">
                ${groups.map(([department, members]) => `<section data-calendar-assignment-group><h4>${escapeHtml(department)}</h4>${members.map(technician => `<label data-calendar-assignment-option="${escapeHtml(`${department} ${technician.fullName || technician.username}`)}"><input type="checkbox" name="assignedTechnicianIds" value="${escapeHtml(technician.id)}" data-calendar-assignment ${selected.has(String(technician.id)) ? "checked" : ""}><span>${escapeHtml(technician.fullName || technician.username)}</span><small>${escapeHtml(technician.phone || "")}</small></label>`).join("")}</section>`).join("") || '<p class="muted">Aucun technicien actif n’est disponible.</p>'}
            </div>
            <label class="calendar-primary-technician">Technicien référent<select name="assignedTechnicianId"></select></label>
        </section>`;
}

function groupTechniciansByDepartment(items) {
    const groups = new Map();
    items.forEach(technician => {
        const department = String(technician.department || "Non classé").trim() || "Non classé";
        if (!groups.has(department)) groups.set(department, []);
        groups.get(department).push(technician);
    });
    return [...groups.entries()].sort(([first], [second]) => first.localeCompare(second, "fr"));
}

function getAssignedTechnicianIds(event) {
    const assigned = Array.isArray(event?.assignedTechnicianIds)
        ? event.assignedTechnicianIds
        : Array.isArray(event?.assignedTechnicians)
            ? event.assignedTechnicians.map(technician => technician?.id)
            : [event?.assignedTechnicianId];
    return [...new Set(assigned.map(id => String(id || "")).filter(Boolean))];
}

function getAssignedTechnicianNames(event) {
    if (Array.isArray(event?.assignedTechnicians) && event.assignedTechnicians.length) {
        return event.assignedTechnicians.map(technician => technician.fullName || "Technicien").filter(Boolean);
    }
    return event?.assignedTechnicianName ? [event.assignedTechnicianName] : [];
}

function renderAssignedTechniciansDetail(event) {
    const names = getAssignedTechnicianNames(event);
    return names.length ? `<dt>Technicien${names.length > 1 ? "s" : ""}</dt><dd>${escapeHtml(names.join(" · "))}</dd>` : "";
}

function findClientForEvent(event) {
    const clientName = normalizeText(event.clientName || "");
    return clientName ? getSearchableClients().find(client => normalizeText(client.name) === clientName) || null : null;
}

async function uploadClientAttachments(event, client, appointment) {
    event.preventDefault();
    const form = event.currentTarget;
    const feedback = form.querySelector(".auth-message");
    const button = form.querySelector("button[type=submit]");
    const files = ["files", "cameraPhoto"].flatMap(name => Array.from(form.elements[name].files || []));
    if (!files.length) {
        feedback.textContent = "Sélectionnez au moins une photo ou un fichier.";
        feedback.classList.add("error");
        return;
    }
    button.disabled = true;
    feedback.textContent = "Dépôt en cours…";
    feedback.classList.remove("error");
    const result = await uploadClientFiles(client, new FormData(form).get("type") || "Autre", files, appointment?.id);
    if (!result.ok) {
        feedback.textContent = result.message || "Dépôt impossible.";
        feedback.classList.add("error");
        button.disabled = false;
        return;
    }
    form.reset();
    feedback.textContent = result.message || "Fichier ajouté au dossier.";
    selectedEvent = appointment;
    renderCalendar({ event: appointment });
}

function renderQuitusHtml(event) {
    const validated = event.quitusStatus === "validated" || event.quitusStatus === "signed";
    if (validated) {
        return `
            <section class="calendar-quitus" aria-label="Quitus validé">
                <div class="form-heading"><div><p class="eyebrow">Quitus d’intervention</p><h3>Quitus validé</h3></div><span class="quitus-status signed">Validé</span></div>
                <p><strong>Signé par :</strong> ${escapeHtml(event.quitusSignedBy || event.clientName || "Client")}</p>
                <p class="muted">Validé le ${escapeHtml(formatQuitusValidationDate(event.quitusSignedAt))}. La signature et le quitus sont définitivement verrouillés ; le PDF est disponible dans le dossier client.</p>
            </section>
        `;
    }
    return `
        <form id="calendarQuitusForm" class="calendar-quitus">
            <div class="form-heading"><div><p class="eyebrow">Quitus d’intervention</p><h3>Quitus à faire signer</h3></div><span class="quitus-status">En attente</span></div>
            <label>Nom du client signataire<input name="signedBy" maxlength="160" required value="${escapeHtml(event.quitusSignedBy || event.clientName || "")}" placeholder="Nom et prénom"></label>
            <label>Signature du client<canvas class="quitus-signature-canvas" width="640" height="220" aria-label="Zone de signature tactile"></canvas></label>
            <div class="calendar-form-actions"><button type="button" class="secondary-button" data-quitus-action="clear">Effacer la signature</button><button type="submit" class="secondary-button">Valider le quitus</button></div>
            <p class="auth-message" aria-live="polite"></p>
        </form>
    `;
}

function initializeQuitusForm(panel, event) {
    const form = panel.querySelector("#calendarQuitusForm");
    if (!form) return;
    const signature = initializeSignatureCanvas(form.querySelector("canvas"), event.quitusSignature || "");
    form.querySelector('[data-quitus-action="clear"]').addEventListener("click", () => {
        if (confirm("Effacer définitivement la signature en cours ?")) signature.clear();
    });
    form.addEventListener("submit", async eventSubmit => {
        eventSubmit.preventDefault();
        const button = form.querySelector('button[type="submit"]');
        const feedback = form.querySelector(".auth-message");
        const signatureValue = signature.value();
        if (!signatureValue) {
            feedback.textContent = "Le client doit signer le quitus.";
            feedback.classList.add("error");
            return;
        }
        button.disabled = true;
        feedback.classList.remove("error");
        feedback.textContent = "Validation du quitus…";
        const result = await request(`/api/calendar/events/${encodeURIComponent(event.id)}/quitus`, {
            method: "PATCH",
            body: JSON.stringify({ status: "validated", signedBy: new FormData(form).get("signedBy"), signature: signatureValue })
        });
        if (!result.ok) {
            feedback.textContent = result.message || "Validation du quitus impossible.";
            feedback.classList.add("error");
            button.disabled = false;
            return;
        }
        Object.assign(event, result.data?.quitus || {});
        await synchronizeClients();
        renderCalendar({ event });
    });
}

function formatQuitusValidationDate(value) {
    if (!value || Number.isNaN(new Date(value).getTime())) return "à l’instant";
    return new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeStyle: "short" }).format(new Date(value));
}

function initializeSignatureCanvas(canvas, existingSignature = "") {
    const context = canvas.getContext("2d");
    context.lineWidth = 3;
    context.lineCap = "round";
    context.strokeStyle = "#003B73";
    let drawing = false;
    let hasSignature = false;
    const position = pointer => {
        const bounds = canvas.getBoundingClientRect();
        return { x: (pointer.clientX - bounds.left) * canvas.width / bounds.width, y: (pointer.clientY - bounds.top) * canvas.height / bounds.height };
    };
    const clear = () => {
        context.clearRect(0, 0, canvas.width, canvas.height);
        hasSignature = false;
    };
    const load = source => {
        if (!source) return;
        const image = new Image();
        image.onload = () => {
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            hasSignature = true;
        };
        image.src = source;
    };
    canvas.addEventListener("pointerdown", pointer => {
        pointer.preventDefault();
        drawing = true;
        canvas.setPointerCapture(pointer.pointerId);
        const point = position(pointer);
        context.beginPath();
        context.moveTo(point.x, point.y);
    });
    canvas.addEventListener("pointermove", pointer => {
        if (!drawing) return;
        const point = position(pointer);
        context.lineTo(point.x, point.y);
        context.stroke();
        hasSignature = true;
    });
    ["pointerup", "pointercancel"].forEach(name => canvas.addEventListener(name, () => { drawing = false; }));
    load(existingSignature);
    return { clear, value: () => hasSignature ? canvas.toDataURL("image/png") : "" };
}

function renderInterventionPhotosHtml(client, appointment) {
    const appointmentPhotos = (client.attachments || []).filter(attachment => String(attachment.appointmentId || "") === String(appointment?.id || ""));
    const before = appointmentPhotos.filter(attachment => attachment.type === "Photo avant");
    const after = appointmentPhotos.filter(attachment => attachment.type === "Photo après");
    const general = appointmentPhotos.filter(attachment => attachment.type === "Photo");
    const previews = photos => photos.length
        ? `<div class="intervention-photo-previews">${photos.map(photo => `<img src="${escapeHtml(photo.dataUrl)}" alt="${escapeHtml(photo.name)}">`).join("")}</div>`
        : '<p class="muted">Aucune photo pour le moment.</p>';
    return `
        <form id="calendarInterventionPhotos" class="calendar-intervention-photos">
            <div><p class="eyebrow">Photos d’intervention</p><h3>Avant / après</h3></div>
            <section><h4>Avant intervention</h4>${previews(before)}<label>Ajouter une photo avant<input name="beforePhoto" type="file" accept="image/*" capture="environment"></label></section>
            <section><h4>Après intervention</h4>${previews(after)}<label>Ajouter une photo après<input name="afterPhoto" type="file" accept="image/*" capture="environment"></label></section>
            ${general.length ? `<section><h4>Autres photos de l’intervention</h4>${previews(general)}</section>` : ""}
            <div class="calendar-form-actions"><button type="submit" class="secondary-button">Ajouter les photos</button></div><p class="auth-message" aria-live="polite"></p>
        </form>
    `;
}

async function uploadInterventionPhotos(event, client, appointment) {
    event.preventDefault();
    const form = event.currentTarget;
    const feedback = form.querySelector(".auth-message");
    const button = form.querySelector('button[type="submit"]');
    const uploads = [
        { type: "Photo avant", files: Array.from(form.elements.beforePhoto.files || []) },
        { type: "Photo après", files: Array.from(form.elements.afterPhoto.files || []) }
    ].filter(upload => upload.files.length);
    if (!uploads.length) {
        feedback.textContent = "Sélectionnez au moins une photo avant ou après.";
        feedback.classList.add("error");
        return;
    }
    button.disabled = true;
    feedback.classList.remove("error");
    feedback.textContent = "Ajout des photos…";
    for (const upload of uploads) {
        const result = await uploadClientFiles(client, upload.type, upload.files, appointment?.id);
        if (!result.ok) {
            feedback.textContent = result.message || "Ajout des photos impossible.";
            feedback.classList.add("error");
            button.disabled = false;
            return;
        }
    }
    selectedEvent = appointment;
    renderCalendar({ event: appointment });
}

async function uploadClientFiles(client, type, files, appointmentId = "") {
    const payload = new FormData();
    payload.append("type", type);
    if (appointmentId) payload.append("appointmentId", String(appointmentId));
    files.forEach(file => payload.append("files", file));
    const response = await fetch(`/api/clients/${encodeURIComponent(client.id)}/attachments`, { method: "POST", credentials: "same-origin", body: payload });
    const data = await response.json().catch(() => null);
    if (!response.ok) return { ok: false, message: data?.message };
    await synchronizeClients();
    return { ok: true, message: data?.message };
}

async function loadLinkedBillingDocuments(panel, appointment) {
    if (!panel || !appointment?.id) return;
    const result = await request("/api/billing");
    if (!result.ok) {
        panel.innerHTML = `<p class="auth-message error">${escapeHtml(result.message || "Impossible de charger les documents de l’intervention.")}</p>`;
        return;
    }
    const documents = (result.data?.documents || []).filter(document => String(document.appointmentId || "") === String(appointment.id));
    panel.innerHTML = `
        <div class="form-heading"><div><p class="eyebrow">Dossier d’intervention</p><h3>Devis et factures créés</h3></div><span class="quitus-status${documents.length ? " signed" : ""}">${documents.length ? `${documents.length} créé${documents.length > 1 ? "s" : ""}` : "Aucun"}</span></div>
        ${documents.length ? `<div class="client-activity-list">${documents.map(document => `<article class="client-activity-item"><div><strong>${escapeHtml(document.documentType === "invoice" ? "Facture" : document.documentType === "credit" ? "Avoir" : "Devis")} ${escapeHtml(document.documentNumber)}</strong><p>${escapeHtml(documentStatusLabel(document.status))}${document.quoteReference ? ` · Réf. devis ${escapeHtml(document.quoteReference)}` : ""}</p></div><button type="button" class="secondary-button" data-linked-document="${escapeHtml(document.id)}">Consulter</button></article>`).join("")}</div>` : '<p class="muted">Les devis, factures et avoirs créés depuis ce rendez-vous apparaîtront ici.</p>'}
    `;
    panel.querySelectorAll("[data-linked-document]").forEach(button => button.addEventListener("click", () => viewBillingDocument(button.dataset.linkedDocument)));
}

function renderCalendarGrid(panel) {
    if (calendarView !== "month") return renderCalendarList(panel);
    panel.hidden = false;
    const days = getCalendarDays(displayedMonth);
    const eventsByDate = new Map();
    getVisibleEvents().forEach(event => {
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
            const clientDetails = getEventClientDetails(event);
            const button = document.createElement("button");
            button.type = "button";
            button.className = `calendar-event color-${event.color}`;
            button.title = [event.title, getAssignedTechnicianNames(event).join(" · "), clientDetails.name, clientDetails.phone, clientDetails.address, event.startTime && `${event.startTime}${event.endTime ? ` – ${event.endTime}` : ""}`].filter(Boolean).join(" · ");
            button.innerHTML = renderCalendarEventCard(event, clientDetails);
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
    getVisibleEvents().forEach(event => {
        if (!eventDates.has(event.date)) eventDates.set(event.date, []);
        eventDates.get(event.date).push(event);
    });
    const days = [];
    for (const day = new Date(start); day <= end; day.setDate(day.getDate() + 1)) days.push(new Date(day));
    const canCreate = !isReadOnlyCalendar();
    panel.innerHTML = `<div class="calendar-list-view">${days.map(day => {
        const date = toDateString(day);
        const dayEvents = eventDates.get(date) || [];
        const emptyMessage = canCreate ? "Aucun événement. Cliquez pour en ajouter un." : "Aucun rendez-vous prévu.";
        return `<section class="calendar-list-day${canCreate ? " calendar-list-day-clickable" : ""}"${canCreate ? ` data-calendar-date="${date}" tabindex="0" role="button" aria-label="Ajouter un événement le ${escapeHtml(formatShortDate(day))}"` : ""}><h3>${escapeHtml(new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" }).format(day))}</h3>${dayEvents.length ? `<div class="calendar-list-events">${dayEvents.map(event => `<button type="button" class="calendar-event color-${escapeHtml(event.color)}" data-calendar-event="${escapeHtml(event.id)}">${renderCalendarEventCard(event, getEventClientDetails(event))}</button>`).join("")}</div>` : `<p class="muted">${emptyMessage}</p>`}</section>`;
    }).join("")}</div>`;
    panel.querySelectorAll("[data-calendar-event]").forEach(button => button.addEventListener("click", () => {
        selectedEvent = events.find(event => String(event.id) === button.dataset.calendarEvent) || null;
        renderCalendar();
    }));
    panel.querySelectorAll("[data-calendar-date]").forEach(day => {
        const openNewEvent = () => {
            selectedEvent = newEventForDate(day.dataset.calendarDate);
            renderCalendar({ date: new Date(`${day.dataset.calendarDate}T12:00:00`) });
        };
        day.addEventListener("click", event => {
            if (!event.target.closest(".calendar-event")) openNewEvent();
        });
        day.addEventListener("keydown", event => {
            if (event.target !== day || !["Enter", " "].includes(event.key)) return;
            event.preventDefault();
            openNewEvent();
        });
    });
}

function getVisibleEvents() {
    if (isReadOnlyCalendar() || showAllTechnicians) return events;
    return events.filter(event => getAssignedTechnicianIds(event).some(id => visibleTechnicianIds.has(id)));
}

function renderCalendarEventCard(event, client) {
    const technicianNames = getAssignedTechnicianNames(event);
    return `<span>${escapeHtml(event.startTime || "Toute la journée")}</span><strong>${escapeHtml(event.title)}</strong>${technicianNames.length ? `<small>👥 ${escapeHtml(technicianNames.join(" · "))}</small>` : ""}${client.name ? `<small class="calendar-event-client">${escapeHtml(client.name)}</small>` : ""}${client.phone ? `<small class="calendar-event-contact">📞 ${escapeHtml(client.phone)}</small>` : ""}${client.address ? `<small class="calendar-event-contact">📍 ${escapeHtml(client.address)}</small>` : ""}`;
}

function getEventClientDetails(event) {
    const client = findClientForEvent(event);
    return {
        name: client?.name || event.clientName || "",
        phone: client?.phone || "",
        address: (client ? formatClientAddress(client) : "") || event.location || ""
    };
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

function isTechnicianBillingAllowed() {
    return document.body.dataset.role !== "technician" || document.body.dataset.technicianBillingEnabled !== "false";
}

function isReadOnlyCalendar() {
    return document.body.dataset.role === "technician";
}

function documentStatusLabel(value) { return ({ draft: "Brouillon", sent: "Envoyé", validated: "Validé", paid: "Réglé", issued: "Émis", cancelled: "Annulé", accepted: "Accepté", rejected: "Refusé", pending: "En attente" })[String(value || "").toLowerCase()] || "Non renseigné"; }

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
    return { title: "", clientName: "", location: "", date, startTime: "", endTime: "", color: "blue", eventType: "appointment", notes: "", assignedTechnicianId: "", assignedTechnicianName: "", assignedTechnicianIds: [] };
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
        eventType: String(form.get("eventType") || "appointment"),
        assignedTechnicianId: String(form.get("assignedTechnicianId") || ""),
        assignedTechnicianIds: form.getAll("assignedTechnicianIds").map(value => String(value || "")),
        dates: form.getAll("dates").map(value => String(value || "")),
        notes: String(form.get("notes") || "").trim()
    };
}

function getEventType(value) {
    return EVENT_TYPE_OPTIONS.find(type => type.id === value) || EVENT_TYPE_OPTIONS[0];
}

function formatClientAddress(client) {
    return [client.address, client.city].map(value => String(value || "").trim()).filter(Boolean).join(", ");
}

function getClientNavigationHref(client) {
    const address = formatClientAddress(client);
    return address ? `geo:0,0?q=${encodeURIComponent(address)}` : "";
}

function getClientPhoneHref(client) {
    const phone = String(client?.phone || "").replace(/[^\d+]/g, "");
    return phone.replace(/\D/g, "").length >= 6 ? `tel:${phone}` : "";
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
