import { ROUTES } from "./config.js?v=106";
import { createBillingDocumentForClient, viewBillingDocument } from "./billing.js?v=200";
import { getSearchableClients } from "./clients.js?v=163";
import { addClientActivityByName, synchronizeClients } from "./client-sync.js?v=127";
import { renderClientMessages } from "./messages.js?v=107";
import { renderLeakReportWizard as renderTechnicalReports } from "./leak-report-wizard.js?v=46";
import { resetSelection } from "./state.js?v=44";
import { escapeHtml, normalizeText } from "./utils.js?v=44";
import { renderPlatformAnnouncement } from "./platform-announcement.js?v=1";
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
const EVENT_STATUS_OPTIONS = [
    { id: "planned", label: "Planifiée" },
    { id: "confirmed", label: "Confirmée" },
    { id: "in_progress", label: "En cours" },
    { id: "completed", label: "Terminée" },
    { id: "cancelled", label: "Annulée" }
];

let displayedMonth = firstDayOfMonth(new Date());
let events = [];
let selectedEvent = null;
let calendarView = "month";
let members = [];
let showAllTechnicians = true;
let visibleTechnicianIds = new Set();
const mobileAdminEditingEvents = new Set();
let userFilterOpen = false;
let calendarPanels = null;
let cachedMembers = null;
let cachedMembersAt = 0;
let calendarEventsCache = new Map();
let calendarUpdateVersion = 0;
const MEMBERS_CACHE_DURATION = 15 * 60 * 1000;
const EVENTS_CACHE_DURATION = 30 * 1000;
const PLANNING_DAY_START_HOUR = 8;
const PLANNING_DAY_END_HOUR = 19;
const PLANNING_SLOT_MINUTES = 15;

window.addEventListener("depannhome:billing-document-saved", event => {
    if (event.detail?.suppressNavigation) return;
    const appointmentId = String(event.detail?.appointmentId || "");
    const appointment = events.find(item => String(item.id) === appointmentId);
    if (!appointment) return;
    selectedEvent = appointment;
    calendarView = "day";
    displayedMonth = atNoon(new Date(`${appointment.date}T12:00:00`));
    renderCalendar({ date: displayedMonth, event: appointment });
});

export async function renderCalendar(options = {}) {
    if (["month", "week", "day"].includes(options.view)) calendarView = options.view;
    if (options.showAllTechnicians) {
        showAllTechnicians = true;
        visibleTechnicianIds.clear();
    } else if (Array.isArray(options.visibleTechnicianIds)) {
        visibleTechnicianIds = new Set(options.visibleTechnicianIds.map(String).filter(Boolean));
        showAllTechnicians = visibleTechnicianIds.size === 0;
    }
    if (options.date) displayedMonth = calendarView === "month" ? firstDayOfMonth(options.date) : atNoon(options.date);
    if (options.event) selectedEvent = options.event;

    clearSearch();
    resetSelection("all");
    const technicianHome = isReadOnlyCalendar();
    setPage(technicianHome ? "Accueil" : isMobileAdministrator() ? "Interventions" : "Planning", ROUTES.calendar, "detail");

    const container = getContainer();
    const header = document.createElement("section");
    header.className = technicianHome ? "technician-calendar-home" : "client-panel calendar-panel";
    const formPanel = document.createElement("section");
    formPanel.className = "client-panel calendar-form-panel";
    const gridPanel = document.createElement("section");
    gridPanel.className = "client-panel calendar-grid-panel";
    container.append(header, formPanel, gridPanel);
    calendarPanels = { header, form: formPanel, grid: gridPanel };
    if (technicianHome) renderPlatformAnnouncement(container);

    header.innerHTML = "<p class=\"muted\">Chargement du planning…</p>";
    formPanel.hidden = true;
    gridPanel.hidden = true;

    const [result, availableMembers] = await Promise.all([
        loadEvents(displayedMonth),
        isReadOnlyCalendar() ? Promise.resolve([]) : loadCalendarMembers()
    ]);
    if (!result.ok) {
        header.innerHTML = `<p class="auth-message error">${escapeHtml(result.message || "Impossible de charger le planning.")}</p>`;
        return;
    }

    events = result.events;
    members = availableMembers;
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
                <p class="eyebrow">${isMobileAdministrator() ? "Interventions terrain" : "Planning professionnel"}</p>
                <h2>${escapeHtml(periodLabel)}</h2>
            </div>
            <div class="calendar-toolbar-actions">
                <button type="button" class="secondary-button" data-calendar-action="previous">← ${getPreviousLabel()}</button>
                <button type="button" class="secondary-button auth-outline-button" data-calendar-action="today">Aujourd’hui</button>
                <button type="button" class="secondary-button" data-calendar-action="next">${getNextLabel()} →</button>
                ${readOnly ? "" : `<button type="button" class="secondary-button" data-calendar-action="new">${isMobileAdministrator() ? "+ Planifier une intervention" : "+ Nouveau rendez-vous"}</button><button type="button" class="secondary-button" data-calendar-action="new-task">+ Nouvelle tâche</button>`}
            </div>
        </div>
        <div class="calendar-view-switcher" role="group" aria-label="Vue du planning">
            ${[ ["month", "Mois"], ["week", "Semaine"], ["day", "Jour"] ].map(([view, label]) => `<button type="button" class="secondary-button${calendarView === view ? " active" : ""}" data-calendar-view="${view}">${label}</button>`).join("")}
        </div>
        ${readOnly ? "" : renderTechnicianFilter()}
        <div class="calendar-legend">
            ${COLOR_OPTIONS.map(color => `<span><i style="background:${color.value}"></i>${color.label}</span>`).join("")}
        </div>
        <div class="calendar-status-legend" aria-label="Statuts des interventions">
            ${EVENT_STATUS_OPTIONS.map(status => `<span class="status-${status.id}"><i></i>${status.label}</span>`).join("")}
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
    panel.querySelector("[data-calendar-filter-toggle]")?.addEventListener("click", () => {
        userFilterOpen = !userFilterOpen;
        refreshCalendarFilterView();
    });
    panel.querySelector("[data-calendar-filter=all]")?.addEventListener("change", event => {
        showAllTechnicians = event.currentTarget.checked;
        if (showAllTechnicians) visibleTechnicianIds.clear();
        refreshCalendarFilterView();
    });
    panel.querySelectorAll("[data-calendar-technician]").forEach(input => input.addEventListener("change", event => {
        showAllTechnicians = false;
        const id = String(event.currentTarget.dataset.calendarTechnician);
        if (event.currentTarget.checked) visibleTechnicianIds.add(id);
        else visibleTechnicianIds.delete(id);
        refreshCalendarFilterView();
    }));
}

function refreshCalendarFilterView() {
    if (!hasCalendarPanels()) {
        renderCalendar();
        return;
    }
    renderHeader(calendarPanels.header);
    renderCalendarGrid(calendarPanels.grid);
}

function hasCalendarPanels() {
    return Boolean(calendarPanels?.header?.isConnected && calendarPanels?.form?.isConnected && calendarPanels?.grid?.isConnected);
}

async function refreshCalendarPeriod() {
    if (!hasCalendarPanels()) {
        renderCalendar();
        return;
    }
    const version = ++calendarUpdateVersion;
    renderHeader(calendarPanels.header);
    renderEventForm(calendarPanels.form);
    calendarPanels.grid.hidden = false;
    calendarPanels.grid.innerHTML = '<p class="muted">Mise à jour du planning…</p>';
    const result = await loadEvents();
    if (version !== calendarUpdateVersion || !hasCalendarPanels()) return;
    if (!result.ok) {
        calendarPanels.grid.innerHTML = `<p class="auth-message error">${escapeHtml(result.message || "Impossible de charger le planning.")}</p>`;
        return;
    }
    events = result.events;
    if (isReadOnlyCalendar()) window.dispatchEvent(new CustomEvent("depannhome:technician-calendar-viewed", { detail: { events } }));
    renderHeader(calendarPanels.header);
    renderCalendarGrid(calendarPanels.grid);
}

function refreshCalendarDetail() {
    if (!hasCalendarPanels()) {
        renderCalendar();
        return;
    }
    renderEventForm(calendarPanels.form);
}

function bindCalendarViewSwitcher(panel) {
    panel.querySelectorAll("[data-calendar-view]").forEach(button => button.addEventListener("click", () => {
        const nextView = button.dataset.calendarView;
        if (nextView === calendarView) return;
        calendarView = nextView;
        displayedMonth = nextView === "month" ? firstDayOfMonth(displayedMonth) : atNoon(displayedMonth);
        if (!selectedEvent?.partnerMissionId) selectedEvent = null;
        refreshCalendarPeriod();
    }));
}

function bindCalendarNavigation(panel) {
    panel.querySelector("[data-calendar-action=previous]").addEventListener("click", () => {
        displayedMonth = shiftDisplayedDate(-1);
        selectedEvent = null;
        refreshCalendarPeriod();
    });
    panel.querySelector("[data-calendar-action=next]").addEventListener("click", () => {
        displayedMonth = shiftDisplayedDate(1);
        selectedEvent = null;
        refreshCalendarPeriod();
    });
    panel.querySelector("[data-calendar-action=today]").addEventListener("click", () => {
        displayedMonth = calendarView === "month" ? firstDayOfMonth(new Date()) : atNoon(new Date());
        selectedEvent = null;
        refreshCalendarPeriod();
    });
}

function renderTechnicianFilter() {
    const count = showAllTechnicians ? members.length : visibleTechnicianIds.size;
    const groups = groupTechniciansByDepartment(members);
    return `
        <section class="calendar-technician-filter" aria-label="Filtrer le planning par membre">
            <div class="calendar-technician-filter-heading"><div><p class="eyebrow">Équipe affichée</p><strong>${count} membre${count === 1 ? "" : "s"} sélectionné${count === 1 ? "" : "s"}</strong></div><button type="button" class="secondary-button" data-calendar-filter-toggle aria-expanded="${userFilterOpen}">Filtrer les utilisateurs</button></div>
            <div class="calendar-technician-options" ${userFilterOpen ? "" : "hidden"}>
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
    if (event.eventType === "appointment" && event.isCompleted) {
        const client = findClientForEvent(event);
        panel.innerHTML = `
            <div class="calendar-event-detail">
                <div class="form-heading"><div><p class="eyebrow">Intervention terminée</p><h2>${escapeHtml(event.title)}</h2></div><span class="quitus-status signed">Terminée</span></div>
                <section class="calendar-appointment-information">
                    <p class="muted">Cette intervention est conservée dans l’historique du client. Elle ne peut plus être modifiée ou supprimée. Consultez la fiche client ou créez un nouveau rendez-vous à partir de ses informations.</p>
                    <dl><dt>Intervention</dt><dd>N° ${escapeHtml(event.id)}</dd><dt>Client</dt><dd>${escapeHtml(event.clientName || "Non renseigné")}</dd><dt>Date</dt><dd>${escapeHtml(formatActivityDate(event.date, event.startTime))}${event.endTime ? ` — ${escapeHtml(event.endTime)}` : ""}</dd>${renderAssignedTechniciansDetail(event)}${event.location ? `<dt>Lieu</dt><dd>${escapeHtml(event.location)}</dd>` : ""}${event.notes ? `<dt>Notes</dt><dd>${escapeHtml(event.notes)}</dd>` : ""}</dl>
                </section>
                ${client ? renderInsuranceDeductibleHtml(event, client) : ""}
                <div class="calendar-form-actions">${client ? `<button type="button" class="secondary-button" id="openCompletedAppointmentClient">Aller sur la fiche client</button><button type="button" class="secondary-button" id="scheduleCompletedAppointmentFollowUp">Planifier un nouveau rendez-vous</button>` : '<p class="auth-message">Aucune fiche client associée : l’intervention historique reste consultable.</p>'}<button type="button" class="secondary-button" id="closeCalendarDetail">Fermer</button></div>
            </div>`;
        initializeInsuranceDeductibleControls(panel, event);
        panel.querySelector("#openCompletedAppointmentClient")?.addEventListener("click", () => {
            window.dispatchEvent(new CustomEvent("depannhome:open-client", { detail: { clientId: client.id } }));
        });
        panel.querySelector("#scheduleCompletedAppointmentFollowUp")?.addEventListener("click", () => {
            const date = toDateString(new Date());
            selectedEvent = {
                ...newEventForDate(date),
                title: event.title || "Intervention",
                clientName: client.name || event.clientName || "",
                location: formatClientAddress(client) || event.location || "",
                notes: event.notes || "",
                startTime: event.startTime || "",
                endTime: event.endTime || "",
                color: event.color || "blue",
                assignedTechnicianId: event.assignedTechnicianId || "",
                assignedTechnicianName: event.assignedTechnicianName || "",
                assignedTechnicianIds: getAssignedTechnicianIds(event)
            };
            displayedMonth = firstDayOfMonth(new Date(`${date}T12:00:00`));
            refreshCalendarDetail();
        });
        panel.querySelector("#closeCalendarDetail").addEventListener("click", () => {
            selectedEvent = null;
            refreshCalendarDetail();
        });
        return;
    }
    if (calendarEventStatus(event) === "cancelled" && usesTerrainInterventionView(event)) {
        panel.innerHTML = `
            <div class="calendar-event-detail">
                <div class="form-heading"><div><p class="eyebrow">Intervention annulée</p><h2>${escapeHtml(event.title)}</h2></div><span class="quitus-status">Annulée</span></div>
                <section class="calendar-appointment-information">
                    <p class="muted">Cette intervention reste visible dans le planning et l’historique, mais elle ne réserve plus ce créneau.</p>
                    <dl><dt>Intervention</dt><dd>N° ${escapeHtml(event.id)}</dd><dt>Client</dt><dd>${escapeHtml(event.clientName || "Non renseigné")}</dd><dt>Date initiale</dt><dd>${escapeHtml(formatActivityDate(event.date, event.startTime))}${event.endTime ? ` — ${escapeHtml(event.endTime)}` : ""}</dd>${renderAssignedTechniciansDetail(event)}${event.location ? `<dt>Lieu</dt><dd>${escapeHtml(event.location)}</dd>` : ""}${event.notes ? `<dt>Notes</dt><dd>${escapeHtml(event.notes)}</dd>` : ""}</dl>
                </section>
                <div class="calendar-form-actions">${isMobileAdministrator() ? '<button type="button" class="secondary-button" id="editCalendarEvent">Modifier ou réactiver</button>' : ""}<button type="button" class="secondary-button" id="closeCalendarDetail">Fermer</button></div>
            </div>`;
        panel.querySelector("#editCalendarEvent")?.addEventListener("click", () => {
            mobileAdminEditingEvents.add(String(event.id));
            refreshCalendarDetail();
        });
        panel.querySelector("#closeCalendarDetail").addEventListener("click", () => {
            selectedEvent = null;
            refreshCalendarDetail();
        });
        return;
    }
    if (usesTerrainInterventionView(event)) {
        if (event.eventType !== "appointment") {
            panel.innerHTML = `
                <div class="calendar-event-detail">
                    <div class="form-heading"><div><p class="eyebrow">${escapeHtml(getEventType(event.eventType).label)}</p><h2>${escapeHtml(event.title)}</h2></div><button type="button" class="secondary-button" id="closeCalendarDetail">Fermer</button></div>
                    <section class="calendar-appointment-information"><dl><dt>Date</dt><dd>${escapeHtml(formatActivityDate(event.date, event.startTime))}${event.endTime ? ` — ${escapeHtml(event.endTime)}` : ""}</dd>${renderAssignedTechniciansDetail(event)}${event.location ? `<dt>Lieu</dt><dd>${escapeHtml(event.location)}</dd>` : ""}${event.notes ? `<dt>Notes</dt><dd>${escapeHtml(event.notes)}</dd>` : ""}</dl></section>
                </div>`;
            panel.querySelector("#closeCalendarDetail").addEventListener("click", () => {
                selectedEvent = null;
                refreshCalendarDetail();
            });
            return;
        }
        const client = findClientForEvent(event);
        const navigationHref = client ? getClientNavigationHref(client) : "";
        const phoneHref = client ? getClientPhoneHref(client) : "";
        panel.innerHTML = `
            <div class="calendar-event-detail">
                <div class="form-heading"><div><p class="eyebrow">${isMobileAdministrator() ? "Intervention à réaliser" : "Rendez-vous"}</p><h2>${escapeHtml(event.title)}</h2></div><div class="calendar-detail-actions">${isMobileAdministrator() ? '<button type="button" class="secondary-button" id="editCalendarEvent">Modifier le rendez-vous</button>' : ""}<button type="button" class="secondary-button" id="closeCalendarDetail">Fermer</button></div></div>
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
                    ${canAccessTechnicalReports() ? `<section class="calendar-billing-actions report-entry-point">
                        <div><p class="eyebrow">Rapport technique</p><h3>Recherche de fuite</h3><p class="muted">Rédigez le rapport terrain, joignez les photos et transmettez-le à l’administration.</p></div>
                        <div><button type="button" class="secondary-button" id="openTechnicalReport">Ouvrir le rapport</button></div>
                    </section>` : ""}
                    ${renderInsuranceDeductibleHtml(event, client)}
                    <section class="calendar-linked-documents" id="calendarLinkedDocuments"><p class="muted">Chargement des devis et factures de cette intervention…</p></section>
                    ${isTechnicianBillingAllowed() ? `<section class="calendar-billing-actions">
                        <div><p class="eyebrow">Fin d’intervention</p><h3>${isReadOnlyCalendar() ? "Devis" : "Devis et facture"}</h3><p class="muted">${isReadOnlyCalendar() ? "Créez le devis de cette intervention." : "Créez le document adapté après avoir renseigné l’intervention."}</p></div>
                        <div><button type="button" class="secondary-button" data-client-action="quote">Créer un devis</button>${isReadOnlyCalendar() ? "" : '<button type="button" class="secondary-button" data-client-action="invoice">Créer une facture</button>'}</div>
                    </section>` : ""}
                    ${event.eventType === "appointment" && canAccessQuitus() ? renderQuitusHtml(event) : ""}
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
        if (event.eventType === "appointment" && client && canAccessQuitus()) initializeQuitusForm(panel, event);
        loadLinkedBillingDocuments(panel.querySelector("#calendarLinkedDocuments"), event);
        panel.querySelector('[data-client-action="quote"]')?.addEventListener("click", () => createBillingDocumentForClient("quote", client, event.id));
        panel.querySelector('[data-client-action="invoice"]')?.addEventListener("click", () => createBillingDocumentForClient("invoice", client, event.id));
        panel.querySelector("#openTechnicalReport")?.addEventListener("click", () => renderTechnicalReports(0, event.id));
        panel.querySelector("#calendarInterventionPhotos")?.addEventListener("submit", eventSubmit => uploadInterventionPhotos(eventSubmit, client, event));
        panel.querySelector("#calendarClientUpload")?.addEventListener("submit", eventSubmit => uploadClientAttachments(eventSubmit, client, event));
        initializeInsuranceDeductibleControls(panel, event);
        panel.querySelector("#editCalendarEvent")?.addEventListener("click", () => {
            mobileAdminEditingEvents.add(String(event.id));
            refreshCalendarDetail();
        });
        panel.querySelector("#closeCalendarDetail").addEventListener("click", () => {
            selectedEvent = null;
            refreshCalendarDetail();
        });
        return;
    }
    const isEditing = Boolean(event.id);
    const clients = getSearchableClients().sort((first, second) => first.name.localeCompare(second.name, "fr"));
    panel.innerHTML = `
        <form id="calendarEventForm" class="client-form">
            <div class="form-heading">
                <div>
                    <p class="eyebrow">${event.partnerMissionId ? `Mission partenaire · ${escapeHtml(event.partnerMissionNumber || event.partnerMissionId)}` : isEditing ? "Modification" : event.eventType === "task" ? "Nouvelle tâche" : "Nouveau rendez-vous"}</p>
                    <h2>${event.partnerMissionId ? "Planifier la mission dans le planning général" : isEditing ? "Modifier l’élément du planning" : event.eventType === "task" ? "Planifier une tâche interne" : "Planifier une intervention"}</h2>
                </div>
                ${isEditing ? '<button type="button" class="secondary-button" id="cancelCalendarEdit">Annuler</button>' : ""}
            </div>
            <div class="form-grid">
                <label>
                    Type
                    <select name="eventType" ${event.partnerMissionId ? "disabled" : ""}>${EVENT_TYPE_OPTIONS.map(type => `<option value="${type.id}" ${event.eventType === type.id ? "selected" : ""}>${type.label}</option>`).join("")}</select>
                </label>
                <label>
                    Titre *
                    <input name="title" maxlength="160" required placeholder="Ex. Intervention volet roulant" value="${escapeHtml(event.title)}">
                </label>
                <label class="calendar-client-field">
                    Client
                    <span class="calendar-client-picker"><input name="clientName" list="calendarClients" maxlength="160" placeholder="Nom du client" value="${escapeHtml(event.clientName)}" ${event.partnerMissionId ? "readonly" : ""}><button type="button" class="secondary-button" id="openCalendarClient" hidden>Ouvrir la fiche</button></span>
                    <datalist id="calendarClients">${clients.map(client => `<option value="${escapeHtml(client.name)}">${escapeHtml([client.city, client.phone].filter(Boolean).join(" · "))}</option>`).join("")}</datalist>
                </label>
                <section class="calendar-client-preview form-wide" id="calendarClientPreview" hidden></section>
                ${isEditing || event.partnerMissionId ? `<label>
                    Date *
                    <input name="date" type="date" required value="${escapeHtml(event.date)}">
                </label>` : renderMultiDatePlanning(event)}
                <label>
                    Couleur
                    <select name="color">${COLOR_OPTIONS.map(color => `<option value="${color.id}" ${event.color === color.id ? "selected" : ""}>${color.label}</option>`).join("")}</select>
                </label>
                ${canManageCalendarEventStatus() ? `<label>
                    Statut
                    <select name="status">${EVENT_STATUS_OPTIONS.map(status => `<option value="${status.id}" ${calendarEventStatus(event) === status.id ? "selected" : ""}>${status.label}</option>`).join("")}</select>
                </label>` : `<label>Statut actuel<input type="hidden" name="status" value="${escapeHtml(calendarEventStatus(event))}"><span class="quitus-status">${escapeHtml(calendarEventStatusLabel(event))}</span></label>`}
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
                ${event.partnerMissionId ? `<label class="form-wide">Type de facturation<select name="billingMode"><option value="direct_client" ${event.billingMode !== "principal" ? "selected" : ""}>Facturation directe au client final — documents privés</option><option value="principal" ${event.billingMode === "principal" ? "selected" : ""}>Facturation destinée à ${escapeHtml(event.partnerName || "l’entreprise donneuse d’ordre")} — devis et factures partagés</option></select></label>` : ""}
            </div>
            <p id="calendarFormMessage" class="auth-message" aria-live="polite"></p>
            <section class="calendar-availability" id="calendarAvailability" aria-live="polite"></section>
            <div class="calendar-form-actions">
                <button type="submit" class="secondary-button">${event.partnerMissionId ? "Valider la planification" : isEditing ? "Enregistrer les modifications" : "Ajouter au planning"}</button>
                ${typeof event.pauseEvent === "function" ? '<button type="button" class="secondary-button" id="pauseCalendarEvent">Mettre en pause pour appeler le client</button>' : ""}
                ${isEditing && canManageCalendarEventStatus() ? '<button type="button" class="secondary-button danger-button" id="deleteCalendarEvent">Supprimer</button>' : ""}
            </div>
        </form>
        ${isEditing ? renderInsuranceDeductibleHtml(event, findClientForEvent(event)) : ""}
    `;

    panel.querySelector("#cancelCalendarEdit")?.addEventListener("click", () => {
        mobileAdminEditingEvents.delete(String(event.id || ""));
        selectedEvent = null;
        refreshCalendarDetail();
    });
    const form = panel.querySelector("#calendarEventForm");
    initializeInsuranceDeductibleControls(panel, event);
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
                const member = members.find(item => String(item.id) === id);
                return `<option value="${escapeHtml(id)}" ${current === id ? "selected" : ""}>${escapeHtml(member?.fullName || member?.username || "Membre")}</option>`;
            }).join("")
            : '<option value="">Aucun membre sélectionné</option>';
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
        if (address && (!event.partnerMissionId || !locationInput.value)) locationInput.value = address;
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
        if (["date", "startTime", "endTime", "assignedTechnicianId"].includes(name)) multiDatePlanning?.refresh();
    }));
    renderCalendarAvailability(form, event.id);

    form.querySelector("#pauseCalendarEvent")?.addEventListener("click", async () => {
        const button = form.querySelector("#pauseCalendarEvent");
        const submitButton = form.querySelector("button[type=submit]");
        const message = panel.querySelector("#calendarFormMessage");
        button.disabled = true;
        submitButton.disabled = true;
        message.textContent = "Mise en pause…";
        message.classList.remove("error");
        const result = await event.pauseEvent(formToEvent(new FormData(form)));
        if (!result.ok) {
            message.textContent = result.message || "Impossible de mettre cette planification en pause.";
            message.classList.add("error");
            button.disabled = false;
            submitButton.disabled = false;
        }
    });

    form.addEventListener("submit", async eventSubmit => {
        eventSubmit.preventDefault();
        const form = eventSubmit.currentTarget;
        const button = form.querySelector("button[type=submit]");
        const message = panel.querySelector("#calendarFormMessage");
        if (multiDatePlanning?.hasConflict()) {
            message.textContent = "Corrigez les conflits de la période avant de l’ajouter au planning.";
            message.classList.add("error");
            return;
        }
        button.disabled = true;
        message.textContent = "Enregistrement…";
        message.classList.remove("error");

        const payload = formToEvent(new FormData(form));
        const result = typeof event.saveEvent === "function"
            ? await event.saveEvent(payload)
            : isEditing
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
            label: (result.data?.count || payload.dates?.length || 1) > 1 ? `${result.data?.count || payload.dates.length} interventions créées` : "Intervention créée",
            detail: [payload.title, formatActivityDate(payload.date, payload.startTime)].filter(Boolean).join(" · "),
            appointmentId: (result.data?.count || 1) === 1 ? result.data?.id : ""
        });
        mobileAdminEditingEvents.delete(String(event.id || ""));
        displayedMonth = firstDayOfMonth(new Date(`${payload.date}T12:00:00`));
        selectedEvent = null;
        invalidateCalendarEventsCache();
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
        mobileAdminEditingEvents.delete(String(event.id || ""));
        selectedEvent = null;
        invalidateCalendarEventsCache();
        renderCalendar();
    });
}

function renderMultiDatePlanning(event) {
    return `
        <section class="calendar-multi-date-planning form-wide" id="calendarMultiDatePlanning">
            <div class="calendar-multi-date-heading"><div><p class="eyebrow">Planification étendue</p><h3>Période de planification</h3></div><span class="calendar-multi-date-count" id="calendarMultiDateCount">1 jour</span></div>
            <div class="calendar-date-range-inputs">
                <label>Date de début *<input name="date" type="date" required value="${escapeHtml(event.date)}"></label>
                <label>Date de fin *<input type="date" id="calendarRangeEnd" required value="${escapeHtml(event.date)}"></label>
            </div>
            <p class="muted">Le même ${escapeHtml(event.eventType === "task" ? "travail" : "rendez-vous")} sera planifié chaque jour de la période, avec les mêmes membres et horaires (30 jours maximum).</p>
            <p class="calendar-range-status muted" id="calendarRangeStatus" aria-live="polite">Choisissez les dates de début et de fin.</p>
            <div class="calendar-selected-date-inputs" id="calendarSelectedDateInputs"></div>
        </section>
    `;
}

function initializeMultiDatePlanning(form, event) {
    const section = form.querySelector("#calendarMultiDatePlanning");
    if (!section) return null;
    const startInput = form.elements.date;
    const endInput = section.querySelector("#calendarRangeEnd");
    const status = section.querySelector("#calendarRangeStatus");
    const submitButton = form.querySelector('button[type="submit"]');
    let requestVersion = 0;
    let rangeHasConflict = false;
    const updateEndBounds = () => {
        endInput.min = startInput.value;
        if (!startInput.value) {
            endInput.removeAttribute("max");
            return;
        }
        const maximum = new Date(`${startInput.value}T12:00:00`);
        maximum.setDate(maximum.getDate() + 29);
        endInput.max = toDateString(maximum);
    };
    const selectedDates = () => {
        const start = startInput.value;
        const end = endInput.value;
        if (!start || !end || end < start) return [];
        return datesBetween(start, end).slice(0, 31);
    };
    const render = () => {
        updateEndBounds();
        const dates = selectedDates();
        const valid = dates.length > 0 && dates.length <= 30;
        endInput.setCustomValidity(!endInput.value ? "Indiquez la date de fin." : endInput.value < startInput.value ? "La date de fin doit être postérieure ou égale à la date de début." : dates.length > 30 ? "La période ne peut pas dépasser 30 jours." : "");
        section.querySelector("#calendarMultiDateCount").textContent = valid ? `${dates.length} jour${dates.length > 1 ? "s" : ""}` : "Période invalide";
        section.querySelector("#calendarSelectedDateInputs").innerHTML = dates.map(date => `<input type="hidden" name="dates" value="${escapeHtml(date)}">`).join("");
        if (!valid) {
            rangeHasConflict = false;
            submitButton.disabled = false;
            status.textContent = "Corrigez la période pour contrôler sa disponibilité.";
        }
        return valid ? dates : [];
    };
    const refresh = async () => {
        const version = ++requestVersion;
        const dates = render();
        const technicianIds = [...form.querySelectorAll("[data-calendar-assignment]:checked")].map(input => input.value);
        if (!dates.length) return;
        if (!technicianIds.length) {
            rangeHasConflict = false;
            submitButton.disabled = false;
            status.textContent = "Sélectionnez au moins un membre pour vérifier les conflits dans le planning général.";
            status.classList.remove("error", "success");
            return;
        }
        status.textContent = "Vérification de toute la période dans le planning général…";
        status.classList.remove("error", "success");
        const query = new URLSearchParams({ start: dates[0], end: dates.at(-1), technicianIds: technicianIds.join(","), startTime: form.elements.startTime.value, endTime: form.elements.endTime.value, count: "31" });
        const result = await request(`/api/calendar/availability?${query}`);
        if (version !== requestVersion) return;
        if (!result.ok) {
            rangeHasConflict = false;
            submitButton.disabled = false;
            status.textContent = result.message || "Impossible de vérifier cette période.";
            status.classList.add("error");
            return;
        }
        const conflicts = result.data?.conflicts || [];
        rangeHasConflict = conflicts.length > 0;
        submitButton.disabled = rangeHasConflict;
        status.classList.toggle("error", conflicts.length > 0);
        status.classList.toggle("success", conflicts.length === 0);
        status.innerHTML = conflicts.length
            ? `<strong>${conflicts.length} jour${conflicts.length > 1 ? "s" : ""} en conflit :</strong> ${conflicts.map(conflict => `${escapeHtml(formatPreviewDate(conflict.date))} avec « ${escapeHtml(conflict.title)} » (${escapeHtml(formatEventTime(conflict))})`).join(" · ")}`
            : `<strong>Période disponible :</strong> aucun conflit détecté sur les ${dates.length} jour${dates.length > 1 ? "s" : ""}.`;
    };
    startInput.addEventListener("change", () => {
        if (!endInput.value || endInput.value < startInput.value) endInput.value = startInput.value;
        refresh();
    });
    endInput.addEventListener("change", refresh);
    render();
    refresh();
    return { refresh, hasConflict: () => rangeHasConflict };
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

function renderCalendarAvailability(form, editedEventId) {
    const preview = form.querySelector("#calendarAvailability");
    const candidate = formToEvent(new FormData(form));
    if (!candidate.date) {
        preview.innerHTML = "<p class=\"muted\">Choisissez une date pour visualiser les créneaux du planning.</p>";
        return;
    }
    const candidateTechnicians = new Set(getAssignedTechnicianIds(candidate));
    const sameDayEvents = events
        .filter(event => event.date === candidate.date && String(event.id || "") !== String(editedEventId || ""))
        .filter(event => !["completed", "cancelled"].includes(calendarEventStatus(event)))
        .filter(event => !candidateTechnicians.size || getAssignedTechnicianIds(event).some(id => candidateTechnicians.has(id)))
        .sort(compareEventTimes);
    const conflict = findLocalCalendarConflict(sameDayEvents, candidate);
    const candidateLabel = candidate.title || "Nouveau rendez-vous";
    preview.classList.toggle("has-conflict", Boolean(conflict));
    preview.innerHTML = `
        <div class="calendar-availability-heading"><div><p class="eyebrow">Aperçu planning</p><h3>${escapeHtml(formatPreviewDate(candidate.date))}</h3></div><div class="calendar-availability-actions" role="group" aria-label="Période affichée sous le formulaire"><button type="button" class="secondary-button${calendarView === "day" ? " active" : ""}" data-calendar-availability-view="day">Jour</button><button type="button" class="secondary-button${calendarView === "week" ? " active" : ""}" data-calendar-availability-view="week">Semaine</button></div><p class="${conflict ? "auth-message error" : "muted"}">${conflict ? `Chevauchement avec « ${escapeHtml(conflict.title)} » (${escapeHtml(formatEventTime(conflict))}).` : "Créneau disponible."}</p></div>
        <div class="calendar-time-preview">
            ${sameDayEvents.map(event => `<article class="calendar-time-slot"><time>${escapeHtml(formatEventTime(event))}</time><strong>${escapeHtml(event.title)}</strong>${event.clientName ? `<small>${escapeHtml(event.clientName)}</small>` : ""}</article>`).join("") || '<p class="muted">Aucun autre rendez-vous ce jour.</p>'}
            <article class="calendar-time-slot calendar-time-slot-preview${conflict ? " conflict" : ""}"><time>${escapeHtml(formatEventTime(candidate))}</time><strong>${escapeHtml(candidateLabel)}</strong><small>Créneau en cours de saisie</small></article>
        </div>
    `;
    preview.querySelectorAll("[data-calendar-availability-view]").forEach(button => button.addEventListener("click", () => {
        const nextView = button.dataset.calendarAvailabilityView;
        if (nextView === calendarView) return;
        calendarView = nextView;
        displayedMonth = atNoon(new Date(`${candidate.date}T12:00:00`));
        refreshCalendarPeriod();
    }));
}

function findLocalCalendarConflict(dayEvents, candidate) {
    if (["completed", "cancelled"].includes(calendarEventStatus(candidate))) return null;
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
    if (event.startTime && event.endTime) return `${event.startTime} – ${event.endTime}`;
    if (event.startTime) return `Dès ${event.startTime}`;
    if (event.endTime) return `Jusqu’à ${event.endTime}`;
    return "Toute la journée";
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
    const groups = groupTechniciansByDepartment(members);
    return `
        <section class="calendar-technician-assignment form-wide">
            <div class="calendar-technician-assignment-heading"><div><p class="eyebrow">Affectation</p><h3>Membres affectés</h3><p class="muted">Recherchez puis cochez les membres concernés. Le référent est conservé pour les anciens rendez-vous et les exports.</p></div></div>
            <label class="calendar-technician-search">Rechercher un membre, un rôle ou un pôle<input id="calendarTechnicianSearch" type="search" placeholder="Ex. admin, dépannage, Léa…" autocomplete="off"></label>
            <div class="calendar-technician-assignment-groups">
                ${groups.map(([department, groupMembers]) => `<section data-calendar-assignment-group><h4>${escapeHtml(department)}</h4>${groupMembers.map(member => `<label data-calendar-assignment-option="${escapeHtml(`${department} ${member.role || ""} ${member.fullName || member.username}`)}"><input type="checkbox" name="assignedTechnicianIds" value="${escapeHtml(member.id)}" data-calendar-assignment ${selected.has(String(member.id)) ? "checked" : ""}><span>${escapeHtml(member.fullName || member.username)}</span><small>${escapeHtml([roleLabel(member.role), member.phone].filter(Boolean).join(" · "))}</small></label>`).join("")}</section>`).join("") || '<p class="muted">Aucun membre actif n’est disponible.</p>'}
            </div>
            <label class="calendar-primary-technician">Membre référent<select name="assignedTechnicianId"></select></label>
        </section>`;
}

function groupTechniciansByDepartment(items) {
    const groups = new Map();
    items.forEach(technician => {
        const values = Array.isArray(technician.departments) ? technician.departments : [technician.department];
        const departments = [...new Set(values.map(value => String(value || "").trim()).filter(Boolean))];
        (departments.length ? departments : ["Non classé"]).forEach(department => {
            if (!groups.has(department)) groups.set(department, []);
            groups.get(department).push(technician);
        });
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
    return names.length ? `<dt>Membre${names.length > 1 ? "s" : ""} affecté${names.length > 1 ? "s" : ""}</dt><dd>${escapeHtml(names.join(" · "))}</dd>` : "";
}

function findClientForEvent(event) {
    const clientId = String(event.clientId || "");
    if (clientId) return getSearchableClients().find(client => String(client.id) === clientId) || null;
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
    invalidateCalendarEventsCache();
    renderCalendar({ event: appointment });
}

function renderQuitusHtml(event) {
    if (event.isCompleted) return "";
    const validated = event.quitusStatus === "validated" || event.quitusStatus === "signed";
    const approval = "Lu et approuvé – Travaux réalisés et intervention acceptée";
    if (validated) {
        return `
            <section class="calendar-quitus" aria-label="Quitus validé">
                <div class="form-heading"><div><p class="eyebrow">Quitus d’intervention</p><h3>Quitus validé</h3></div><span class="quitus-status signed">Validé</span></div>
                <p><strong>Signé par :</strong> ${escapeHtml(event.quitusSignedBy || event.clientName || "Client")}</p>
                <p class="quitus-stored-observations"><strong>Observations ou réserves :</strong> ${escapeHtml(event.quitusObservations || "Aucune observation ni réserve.")}</p>
                <p class="quitus-approval-confirmation">${event.quitusApproved ? `✓ ${escapeHtml(approval)}` : "Validation antérieure à l’ajout de la case d’approbation."}</p>
                <p class="muted">Validé le ${escapeHtml(formatQuitusValidationDate(event.quitusSignedAt))}. La signature et le quitus sont définitivement verrouillés ; le PDF est disponible dans le dossier client.</p>
            </section>
        `;
    }
    const clientName = event.quitusSignedBy || event.clientName || "Nom du client";
    const companyName = event.quitusCompanyName || "l’entreprise";
    const address = event.location || "adresse de l’intervention";
    const city = event.quitusClientCity || "ville non renseignée";
    const date = formatQuitusLegalDate(event.date);
    return `
        <form id="calendarQuitusForm" class="calendar-quitus">
            <div class="form-heading"><div><p class="eyebrow">Quitus d’intervention</p><h3>Quitus à faire signer</h3></div><span class="quitus-status">En attente</span></div>
            <label>Nom du client signataire<input name="signedBy" maxlength="160" required value="${escapeHtml(event.quitusSignedBy || event.clientName || "")}" placeholder="Nom et prénom"></label>
            <section class="quitus-legal-declaration" aria-label="Déclaration du client" data-client-name="${escapeHtml(clientName)}" data-company-name="${escapeHtml(companyName)}" data-address="${escapeHtml(address)}" data-date="${escapeHtml(date)}" data-city="${escapeHtml(city)}"></section>
            <label>Observations ou réserves du client<textarea name="observations" maxlength="2000" rows="5" enterkeyhint="done" placeholder="Indiquez ici toute observation ou réserve. Laissez vide si aucune.">${escapeHtml(event.quitusObservations || "")}</textarea></label>
            <p class="quitus-signature-mention"><strong>Signature du client précédée de la mention :</strong></p>
            <label class="quitus-approval"><input name="approved" type="checkbox" required> <span>${escapeHtml(approval)}</span></label>
            <label>Signature du client<canvas class="quitus-signature-canvas" width="640" height="220" aria-label="Zone de signature tactile"></canvas></label>
            <div class="calendar-form-actions"><button type="button" class="secondary-button" data-quitus-action="clear">Effacer la signature</button><button type="submit" class="secondary-button">Valider le quitus</button></div>
            <p class="auth-message" aria-live="polite"></p>
        </form>
    `;
}

function renderInsuranceDeductibleHtml(event, client) {
    if (!event?.insuranceName || !client) return "";
    const status = String(event.deductibleStatus || "none");
    const amount = formatDeductibleAmount(event.deductibleAmountCents);
    const expectedAmountCents = Number(client.insuranceDeductibleAmountCents || 0);
    const expectedAmountHtml = expectedAmountCents ? `<p class="deductible-expected"><strong>Franchise prévue sur la fiche client : ${escapeHtml(formatDeductibleAmount(expectedAmountCents))}</strong><br><small>Vérifiez ce montant avec le client avant d’enregistrer la somme réellement encaissée.</small></p>` : "";
    const photo = (client.attachments || []).find(attachment => String(attachment.id) === String(event.deductiblePhotoAttachmentId || ""));
    const photoHtml = photo?.dataUrl ? `<img class="deductible-proof-photo" src="${escapeHtml(photo.dataUrl)}" alt="Photo de preuve de la franchise">` : "";
    const summary = event.deductibleAmountCents ? `<dl><dt>Montant encaissé</dt><dd>${escapeHtml(amount)}</dd><dt>Moyen de paiement</dt><dd>${escapeHtml(event.deductiblePaymentMethod || "Non renseigné")}</dd><dt>Déclaré par</dt><dd>${escapeHtml(event.deductibleCollectedByName || "Technicien")}</dd></dl>${photoHtml}` : "";
    if (status === "validated") return `
        <section class="calendar-quitus insurance-deductible" aria-label="Franchise validée">
            <div class="form-heading"><div><p class="eyebrow">Assurance · ${escapeHtml(event.insuranceName)}</p><h3>Franchise validée</h3></div><span class="quitus-status signed">Validée administrativement</span></div>
            ${expectedAmountHtml}${summary}<p class="muted">Contrôlée par ${escapeHtml(event.deductibleReviewedByName || "Administration")} le ${escapeHtml(formatQuitusValidationDate(event.deductibleReviewedAt))}. Cette preuve est verrouillée et figure dans l’historique de l’intervention.</p>
        </section>`;
    if (status === "pending") {
        if (canReviewInsuranceDeductible()) return `
            <form class="calendar-quitus insurance-deductible" data-deductible-review>
                <div class="form-heading"><div><p class="eyebrow">Assurance · ${escapeHtml(event.insuranceName)}</p><h3>Franchise à contrôler</h3></div><span class="quitus-status">En attente administrative</span></div>
                ${expectedAmountHtml}${summary}<label>Note de contrôle ou motif du refus<textarea name="reviewNote" maxlength="1000" rows="3" placeholder="Obligatoire en cas de refus"></textarea></label>
                <div class="calendar-form-actions"><button type="button" class="secondary-button" data-deductible-decision="validated">Valider la franchise</button><button type="button" class="secondary-button danger-button" data-deductible-decision="rejected">Refuser et redemander une preuve</button></div><p class="auth-message" aria-live="polite"></p>
            </form>`;
        return `<section class="calendar-quitus insurance-deductible"><div class="form-heading"><div><p class="eyebrow">Assurance · ${escapeHtml(event.insuranceName)}</p><h3>Franchise transmise</h3></div><span class="quitus-status">Contrôle administratif en attente</span></div>${expectedAmountHtml}${summary}<p class="muted">Le poste administratif doit contrôler le montant, le moyen de paiement et la photo.</p></section>`;
    }
    if (!canRecordInsuranceDeductible()) return status === "rejected" ? `<section class="calendar-quitus insurance-deductible"><div class="form-heading"><div><p class="eyebrow">Assurance · ${escapeHtml(event.insuranceName)}</p><h3>Franchise refusée</h3></div><span class="quitus-status">À reprendre</span></div>${summary}<p class="auth-message error">${escapeHtml(event.deductibleReviewNote || "Une nouvelle preuve doit être transmise par le technicien.")}</p></section>` : "";
    return `
        <form class="calendar-quitus insurance-deductible" data-deductible-capture>
            <div class="form-heading"><div><p class="eyebrow">Assurance · ${escapeHtml(event.insuranceName)}</p><h3>${status === "rejected" ? "Corriger la franchise" : "Franchise encaissée auprès du client"}</h3></div><span class="quitus-status">${status === "rejected" ? "Refusée par le poste administratif" : "À déclarer"}</span></div>
            ${status === "rejected" ? `<p class="auth-message error">Motif : ${escapeHtml(event.deductibleReviewNote || "Preuve à reprendre")}</p>` : ""}
            <p class="muted">Dossier ${escapeHtml(event.insuranceClaimNumber || "sans numéro de sinistre")} · saisissez uniquement le montant réellement reçu.</p>${expectedAmountHtml}
            <label>Montant de la franchise encaissée (€)<input name="amount" type="number" min="0.01" max="1000000" step="0.01" inputmode="decimal" required value="${event.deductibleAmountCents || expectedAmountCents ? escapeHtml((Number(event.deductibleAmountCents || expectedAmountCents) / 100).toFixed(2)) : ""}"></label>
            <label>Moyen de paiement<select name="paymentMethod" required>${["Chèque", "Espèces", "Virement", "Carte bancaire"].map(method => `<option value="${method}" ${event.deductiblePaymentMethod === method ? "selected" : ""}>${method}</option>`).join("")}</select></label>
            <label>Photo de preuve obligatoire<input name="photo" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" required></label>
            <div class="calendar-form-actions"><button type="submit" class="secondary-button">Transmettre au poste administratif</button></div><p class="auth-message" aria-live="polite"></p>
        </form>`;
}

function initializeInsuranceDeductibleControls(panel, appointment) {
    const capture = panel.querySelector("[data-deductible-capture]");
    capture?.addEventListener("submit", async eventSubmit => {
        eventSubmit.preventDefault();
        const button = capture.querySelector('button[type="submit"]');
        const feedback = capture.querySelector(".auth-message:last-child");
        const amountCents = Math.round(Number(capture.elements.amount.value) * 100);
        const photo = capture.elements.photo.files?.[0];
        if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || !photo) {
            feedback.textContent = "Renseignez le montant encaissé et prenez une photo de preuve.";
            feedback.classList.add("error");
            return;
        }
        const payload = new FormData();
        payload.append("amountCents", String(amountCents));
        payload.append("paymentMethod", capture.elements.paymentMethod.value);
        payload.append("photo", photo);
        button.disabled = true;
        feedback.classList.remove("error");
        feedback.textContent = "Transmission au poste administratif…";
        const result = await multipartRequest(`/api/calendar/events/${encodeURIComponent(appointment.id)}/deductible`, payload);
        if (!result.ok) {
            feedback.textContent = result.message || "Transmission impossible.";
            feedback.classList.add("error");
            button.disabled = false;
            return;
        }
        Object.assign(appointment, result.data?.deductible || {});
        await synchronizeClients();
        invalidateCalendarEventsCache();
        renderCalendar({ event: appointment });
    });
    const review = panel.querySelector("[data-deductible-review]");
    review?.querySelectorAll("[data-deductible-decision]").forEach(button => button.addEventListener("click", async () => {
        const decision = button.dataset.deductibleDecision;
        const feedback = review.querySelector(".auth-message");
        const reviewNote = review.elements.reviewNote.value.trim();
        if (decision === "rejected" && !reviewNote) {
            feedback.textContent = "Indiquez le motif du refus pour guider le technicien.";
            feedback.classList.add("error");
            return;
        }
        review.querySelectorAll("button").forEach(item => { item.disabled = true; });
        feedback.classList.remove("error");
        feedback.textContent = decision === "validated" ? "Validation de la franchise…" : "Enregistrement du refus…";
        const result = await request(`/api/calendar/events/${encodeURIComponent(appointment.id)}/deductible/review`, { method: "PATCH", body: JSON.stringify({ decision, reviewNote }) });
        if (!result.ok) {
            feedback.textContent = result.message || "Contrôle impossible.";
            feedback.classList.add("error");
            review.querySelectorAll("button").forEach(item => { item.disabled = false; });
            return;
        }
        Object.assign(appointment, result.data?.deductible || {});
        await synchronizeClients();
        invalidateCalendarEventsCache();
        renderCalendar({ event: appointment });
    }));
}

function canRecordInsuranceDeductible() {
    return document.body.dataset.deviceType === "mobile" && ["technician", "team_lead", "mobile_admin"].includes(document.body.dataset.role);
}

function canReviewInsuranceDeductible() {
    return document.body.dataset.deviceType === "desktop" && ["admin", "pc_standard"].includes(document.body.dataset.role);
}

function formatDeductibleAmount(value) {
    return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(Number(value || 0) / 100);
}

function initializeQuitusForm(panel, event) {
    const form = panel.querySelector("#calendarQuitusForm");
    if (!form) return;
    const declaration = form.querySelector(".quitus-legal-declaration");
    const signedByInput = form.elements.signedBy;
    const renderDeclaration = () => {
        const clientName = signedByInput.value.trim() || declaration.dataset.clientName;
        declaration.innerHTML = `
            <p>Je soussigné(e), <strong>${escapeHtml(clientName)}</strong>, reconnais que le technicien de <strong>${escapeHtml(declaration.dataset.companyName)}</strong> est intervenu à mon domicile / dans les locaux situés <strong>${escapeHtml(declaration.dataset.address)}</strong>, le <strong>${escapeHtml(declaration.dataset.date)}</strong>, afin de réaliser les travaux et prestations décrits dans le présent document.</p>
            <p>Je reconnais que l’intervention s’est déroulée conformément aux travaux convenus et que les prestations indiquées ci-dessus ont été réalisées.</p>
            <p>Je déclare avoir pris connaissance des travaux réalisés et les accepter.</p>
            <p>Les éventuelles observations ou réserves sont indiquées dans le présent document.</p>
            <p><strong>Fait le ${escapeHtml(declaration.dataset.date)}, à ${escapeHtml(declaration.dataset.city)}.</strong></p>
        `;
    };
    signedByInput.addEventListener("input", renderDeclaration);
    renderDeclaration();
    const signature = initializeSignatureCanvas(form.querySelector("canvas"), event.quitusSignature || "");
    form.querySelector('[data-quitus-action="clear"]').addEventListener("click", () => {
        if (confirm("Effacer définitivement la signature en cours ?")) signature.clear();
    });
    form.addEventListener("submit", async eventSubmit => {
        eventSubmit.preventDefault();
        const button = form.querySelector('button[type="submit"]');
        const feedback = form.querySelector(".auth-message");
        const signatureValue = signature.value();
        const formData = new FormData(form);
        if (!form.elements.approved.checked) {
            feedback.textContent = "Le client doit cocher « Lu et approuvé » avant de signer.";
            feedback.classList.add("error");
            return;
        }
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
            body: JSON.stringify({ status: "validated", signedBy: formData.get("signedBy"), observations: formData.get("observations"), approved: true, signature: signatureValue })
        });
        if (!result.ok) {
            feedback.textContent = result.message || "Validation du quitus impossible.";
            feedback.classList.add("error");
            button.disabled = false;
            return;
        }
        Object.assign(event, result.data?.quitus || {});
        await synchronizeClients();
        invalidateCalendarEventsCache();
        renderCalendar({ event });
    });
}

function formatQuitusValidationDate(value) {
    if (!value || Number.isNaN(new Date(value).getTime())) return "à l’instant";
    return new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeStyle: "short" }).format(new Date(value));
}

function formatQuitusLegalDate(value) {
    if (!value || Number.isNaN(new Date(`${value}T12:00:00`).getTime())) return "date indiquée";
    return new Intl.DateTimeFormat("fr-FR", { dateStyle: "long" }).format(new Date(`${value}T12:00:00`));
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
            <div><p class="eyebrow">Dossier de l’intervention</p><h3>Ajouter des photos</h3><p class="muted">Ces photos sont enregistrées dans la fiche client. Elles ne sont envoyées au partenaire qu’après une sélection explicite dans le Centre de mission.</p></div>
            <section><h4>Photos de l’intervention</h4>${previews(general)}<label>Ajouter des photos<input name="generalPhotos" type="file" accept="image/*" capture="environment" multiple></label></section>
            <section><h4>Avant intervention</h4>${previews(before)}<label>Ajouter des photos avant<input name="beforePhoto" type="file" accept="image/*" capture="environment" multiple></label></section>
            <section><h4>Après intervention</h4>${previews(after)}<label>Ajouter des photos après<input name="afterPhoto" type="file" accept="image/*" capture="environment" multiple></label></section>
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
        { type: "Photo", files: Array.from(form.elements.generalPhotos.files || []) },
        { type: "Photo avant", files: Array.from(form.elements.beforePhoto.files || []) },
        { type: "Photo après", files: Array.from(form.elements.afterPhoto.files || []) }
    ].filter(upload => upload.files.length);
    if (!uploads.length) {
        feedback.textContent = "Sélectionnez au moins une photo de l’intervention.";
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
    invalidateCalendarEventsCache();
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
    eventsByDate.forEach(dayEvents => dayEvents.sort(compareEventTimes));
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
            displayedMonth = calendarView === "month" ? firstDayOfMonth(day) : atNoon(day);
            refreshCalendarDetail();
        };
        if (!readOnly) {
            cell.addEventListener("click", eventClick => {
                if (eventClick.target.closest(".calendar-event, .calendar-overflow-button")) return;
                openNewEvent();
            });
            cell.addEventListener("keydown", eventKey => {
                if (eventKey.target !== cell || !["Enter", " "].includes(eventKey.key)) return;
                eventKey.preventDefault();
                openNewEvent();
            });
        }

        const eventList = cell.querySelector(".calendar-event-list");
        const dayEvents = eventsByDate.get(date) || [];
        const visibleEvents = dayEvents.slice(0, getCalendarEventLimit("month"));
        visibleEvents.forEach(event => {
            const clientDetails = getEventClientDetails(event);
            const button = document.createElement("button");
            button.type = "button";
            button.className = calendarEventClassName(event);
            button.dataset.calendarStatus = calendarEventStatus(event);
            button.title = calendarEventAccessibleLabel(event, clientDetails);
            button.setAttribute("aria-label", calendarEventAccessibleLabel(event, clientDetails, date));
            button.innerHTML = renderCalendarEventCard(event, clientDetails);
            button.addEventListener("click", () => {
                selectedEvent = event;
                refreshCalendarDetail();
            });
            eventList.appendChild(button);
        });
        const hiddenCount = dayEvents.length - visibleEvents.length;
        if (hiddenCount > 0) {
            const more = document.createElement("button");
            more.type = "button";
            more.className = "calendar-overflow-button";
            more.textContent = `+ ${hiddenCount} autre${hiddenCount > 1 ? "s" : ""}`;
            more.setAttribute("aria-label", `Afficher ${hiddenCount} autre${hiddenCount > 1 ? "s" : ""} intervention${hiddenCount > 1 ? "s" : ""} du ${formatShortDate(day)}`);
            more.addEventListener("click", () => openCalendarDay(date));
            eventList.appendChild(more);
        }
        grid.appendChild(cell);
    });
}

function renderCalendarList(panel) {
    if (document.body.classList.contains("desktop-device") || document.body.classList.contains("mobile-device")) return renderCalendarTimeline(panel);
    panel.hidden = false;
    const { start, end } = getDisplayedRange();
    const eventDates = new Map();
    getVisibleEvents().forEach(event => {
        if (!eventDates.has(event.date)) eventDates.set(event.date, []);
        eventDates.get(event.date).push(event);
    });
    eventDates.forEach(dayEvents => dayEvents.sort(compareEventTimes));
    const days = [];
    for (const day = new Date(start); day <= end; day.setDate(day.getDate() + 1)) days.push(new Date(day));
    const canCreate = !isReadOnlyCalendar();
    panel.innerHTML = `<div class="calendar-list-view calendar-list-${calendarView}">${days.map(day => {
        const date = toDateString(day);
        const dayEvents = eventDates.get(date) || [];
        const visibleEvents = dayEvents.slice(0, getCalendarEventLimit(calendarView));
        const hiddenCount = dayEvents.length - visibleEvents.length;
        const emptyMessage = canCreate ? "Aucun événement. Cliquez pour en ajouter un." : "Aucun rendez-vous prévu.";
        return `<section class="calendar-list-day${canCreate ? " calendar-list-day-clickable" : ""}"${canCreate ? ` data-calendar-date="${date}" tabindex="0" role="button" aria-label="Ajouter un événement le ${escapeHtml(formatShortDate(day))}"` : ""}><h3>${escapeHtml(new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" }).format(day))}</h3>${dayEvents.length ? `<div class="calendar-list-events">${visibleEvents.map(event => { const client = getEventClientDetails(event); return `<button type="button" class="${calendarEventClassName(event)}" data-calendar-event="${escapeHtml(event.id)}" data-calendar-status="${calendarEventStatus(event)}" aria-label="${escapeHtml(calendarEventAccessibleLabel(event, client, date))}" title="${escapeHtml(calendarEventAccessibleLabel(event, client))}">${renderCalendarEventCard(event, client)}</button>`; }).join("")}${hiddenCount > 0 ? `<button type="button" class="calendar-overflow-button" data-calendar-more-date="${date}">+ ${hiddenCount} autre${hiddenCount > 1 ? "s" : ""}</button>` : ""}</div>` : `<p class="muted">${emptyMessage}</p>`}</section>`;
    }).join("")}</div>`;
    panel.querySelectorAll("[data-calendar-event]").forEach(button => button.addEventListener("click", () => {
        selectedEvent = events.find(event => String(event.id) === button.dataset.calendarEvent) || null;
        refreshCalendarDetail();
    }));
    panel.querySelectorAll("[data-calendar-more-date]").forEach(button => button.addEventListener("click", () => openCalendarDay(button.dataset.calendarMoreDate)));
    panel.querySelectorAll("[data-calendar-date]").forEach(day => {
        const openNewEvent = () => {
            selectedEvent = newEventForDate(day.dataset.calendarDate);
            refreshCalendarDetail();
        };
        day.addEventListener("click", event => {
            if (!event.target.closest(".calendar-event, .calendar-overflow-button")) openNewEvent();
        });
        day.addEventListener("keydown", event => {
            if (event.target !== day || !["Enter", " "].includes(event.key)) return;
            event.preventDefault();
            openNewEvent();
        });
    });
}

function renderCalendarTimeline(panel) {
    panel.hidden = false;
    const { start, end } = getDisplayedRange();
    const eventDates = new Map();
    getVisibleEvents().forEach(event => {
        if (!eventDates.has(event.date)) eventDates.set(event.date, []);
        eventDates.get(event.date).push(event);
    });
    eventDates.forEach(dayEvents => dayEvents.sort(compareEventTimes));
    const days = [];
    for (const day = new Date(start); day <= end; day.setDate(day.getDate() + 1)) days.push(new Date(day));
    const dayLayouts = days.map(day => buildTimelineDayLayout(eventDates.get(toDateString(day)) || []));
    const canCreate = !isReadOnlyCalendar();
    const allDayLabel = "Sans horaire / hors plage";

    panel.innerHTML = `
        <div class="calendar-timeline calendar-timeline-${calendarView}" style="--calendar-day-count:${days.length};--calendar-hour-count:${PLANNING_DAY_END_HOUR - PLANNING_DAY_START_HOUR}">
            <div class="calendar-timeline-header">
                <span class="calendar-timeline-corner">Heure</span>
                ${days.map(day => `<div><strong>${escapeHtml(new Intl.DateTimeFormat("fr-FR", { weekday: "short" }).format(day))}</strong><time datetime="${toDateString(day)}">${escapeHtml(new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit" }).format(day))}</time></div>`).join("")}
            </div>
            <div class="calendar-timeline-all-day">
                <span>${allDayLabel}</span>
                ${dayLayouts.map(({ untimedEvents }, index) => `<div data-calendar-untimed-date="${toDateString(days[index])}">${untimedEvents.map(event => `<button type="button" class="${calendarEventClassName(event, "calendar-timeline-untimed")}" data-calendar-event="${escapeHtml(event.id)}" data-calendar-status="${calendarEventStatus(event)}" aria-label="${escapeHtml(calendarEventAccessibleLabel(event, getEventClientDetails(event), toDateString(days[index])))}"><strong>${escapeHtml(getEventClientDetails(event).name || event.title || "Événement")}</strong><small>${escapeHtml(formatEventTime(event))}</small>${renderCalendarStatusBadge(event)}</button>`).join("") || '<small class="calendar-timeline-empty">—</small>'}</div>`).join("")}
            </div>
            <div class="calendar-timeline-body">
                <div class="calendar-time-axis" aria-hidden="true">
                    ${Array.from({ length: PLANNING_DAY_END_HOUR - PLANNING_DAY_START_HOUR + 1 }, (_, index) => `<time style="--calendar-hour-index:${index}">${String(PLANNING_DAY_START_HOUR + index).padStart(2, "0")}:00</time>`).join("")}
                </div>
                ${dayLayouts.map(({ timedEvents }, index) => {
                    const date = toDateString(days[index]);
                    return `<div class="calendar-timeline-day" data-calendar-timeline-date="${date}"${canCreate ? ` tabindex="0" role="button" aria-label="Ajouter un rendez-vous le ${escapeHtml(formatShortDate(days[index]))}"` : ""}>${timedEvents.map(item => {
                        const client = getEventClientDetails(item.event);
                        return `<button type="button" class="${calendarEventClassName(item.event, "calendar-timeline-event")}" data-calendar-event="${escapeHtml(item.event.id)}" data-calendar-status="${calendarEventStatus(item.event)}" style="--event-start:${item.startRatio};--event-duration:${item.durationRatio};--event-lane:${item.lane};--event-lanes:${item.lanes}" aria-label="${escapeHtml(calendarEventAccessibleLabel(item.event, client, date))}" title="${escapeHtml(calendarEventAccessibleLabel(item.event, client))}">${renderCalendarEventCard(item.event, client)}</button>`;
                    }).join("")}</div>`;
                }).join("")}
            </div>
        </div>`;

    panel.querySelectorAll("[data-calendar-event]").forEach(button => button.addEventListener("click", eventClick => {
        eventClick.stopPropagation();
        selectedEvent = events.find(event => String(event.id) === button.dataset.calendarEvent) || null;
        refreshCalendarDetail();
    }));
    if (!canCreate) return;
    panel.querySelectorAll("[data-calendar-timeline-date]").forEach(day => {
        const openAtPosition = clientY => {
            const bounds = day.getBoundingClientRect();
            const totalMinutes = (PLANNING_DAY_END_HOUR - PLANNING_DAY_START_HOUR) * 60;
            const offset = Math.max(0, Math.min(bounds.height - 1, clientY - bounds.top));
            const rawMinutes = PLANNING_DAY_START_HOUR * 60 + offset / bounds.height * totalMinutes;
            const startMinutes = Math.min(PLANNING_DAY_END_HOUR * 60 - 60, Math.round(rawMinutes / PLANNING_SLOT_MINUTES) * PLANNING_SLOT_MINUTES);
            selectedEvent = { ...newEventForDate(day.dataset.calendarTimelineDate), startTime: minutesToCalendarTime(startMinutes), endTime: minutesToCalendarTime(startMinutes + 60) };
            refreshCalendarDetail();
        };
        day.addEventListener("click", eventClick => {
            if (!eventClick.target.closest(".calendar-timeline-event")) openAtPosition(eventClick.clientY);
        });
        day.addEventListener("keydown", eventKey => {
            if (eventKey.target !== day || !["Enter", " "].includes(eventKey.key)) return;
            eventKey.preventDefault();
            openAtPosition(day.getBoundingClientRect().top);
        });
    });
}

function buildTimelineDayLayout(dayEvents) {
    const rangeStart = PLANNING_DAY_START_HOUR * 60;
    const rangeEnd = PLANNING_DAY_END_HOUR * 60;
    const rangeDuration = rangeEnd - rangeStart;
    const untimedEvents = [];
    const candidates = [];
    dayEvents.forEach(event => {
        const start = calendarTimeToMinutes(event.startTime);
        const explicitEnd = calendarTimeToMinutes(event.endTime);
        if (start === null) {
            untimedEvents.push(event);
            return;
        }
        const end = explicitEnd !== null && explicitEnd > start ? explicitEnd : start + 60;
        if (end <= rangeStart || start >= rangeEnd) {
            untimedEvents.push(event);
            return;
        }
        candidates.push({ event, start: Math.max(start, rangeStart), end: Math.min(end, rangeEnd) });
    });
    let overlapGroup = [];
    let overlapGroupEnd = -1;
    const finalizeOverlapGroup = () => {
        if (!overlapGroup.length) return;
        const laneEnds = [];
        overlapGroup.forEach(item => {
            let lane = laneEnds.findIndex(end => end <= item.start);
            if (lane < 0) lane = laneEnds.length;
            laneEnds[lane] = item.end;
            item.lane = lane;
        });
        overlapGroup.forEach(item => { item.lanes = Math.max(1, laneEnds.length); });
        overlapGroup = [];
    };
    candidates.forEach(item => {
        if (overlapGroup.length && item.start >= overlapGroupEnd) finalizeOverlapGroup();
        overlapGroup.push(item);
        overlapGroupEnd = Math.max(overlapGroupEnd, item.end);
    });
    finalizeOverlapGroup();
    return {
        untimedEvents,
        timedEvents: candidates.map(item => ({
            ...item,
            startRatio: (item.start - rangeStart) / rangeDuration,
            durationRatio: Math.max(PLANNING_SLOT_MINUTES / rangeDuration, (item.end - item.start) / rangeDuration)
        }))
    };
}

function calendarTimeToMinutes(value) {
    const match = String(value || "").match(/^(\d{1,2}):(\d{2})/);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59 ? hours * 60 + minutes : null;
}

function minutesToCalendarTime(value) {
    const minutes = Math.max(0, Math.min(23 * 60 + 59, Number(value) || 0));
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function getVisibleEvents() {
    if (isReadOnlyCalendar() || showAllTechnicians) return events;
    return events.filter(event => getAssignedTechnicianIds(event).some(id => visibleTechnicianIds.has(id)));
}

function renderCalendarEventCard(event, client) {
    const technicianNames = getAssignedTechnicianNames(event);
    const primary = client.name || event.title || "Intervention";
    return `<time class="calendar-event-time">${escapeHtml(formatEventTime(event))}</time><span class="calendar-event-identity"><strong class="calendar-event-client">${escapeHtml(primary)}</strong>${client.address ? `<small class="calendar-event-address">${escapeHtml(client.address)}</small>` : ""}</span><span class="calendar-event-context">${client.name && event.title ? `<small class="calendar-event-title">${escapeHtml(event.title)}</small>` : ""}${technicianNames.length ? `<small class="calendar-event-technicians">${escapeHtml(technicianNames.join(" · "))}</small>` : ""}${client.phone ? `<small class="calendar-event-phone">${escapeHtml(client.phone)}</small>` : ""}</span>${renderCalendarStatusBadge(event)}`;
}

function calendarEventStatus(event) {
    if (event?.isCompleted) return "completed";
    return EVENT_STATUS_OPTIONS.some(status => status.id === event?.status) ? event.status : "planned";
}

function calendarEventStatusLabel(event) {
    const status = calendarEventStatus(event);
    return EVENT_STATUS_OPTIONS.find(option => option.id === status)?.label || "Planifiée";
}

function calendarEventClassName(event, extraClass = "") {
    return ["calendar-event", extraClass, `color-${event?.color || "blue"}`, `status-${calendarEventStatus(event)}`].filter(Boolean).join(" ");
}

function renderCalendarStatusBadge(event) {
    const status = calendarEventStatus(event);
    return status === "planned" ? "" : `<span class="calendar-event-status">${escapeHtml(calendarEventStatusLabel(event))}</span>`;
}

function getCalendarEventLimit(view) {
    if (view === "day") return Number.POSITIVE_INFINITY;
    const mobile = document.body.dataset.deviceType === "mobile" || document.body.classList.contains("mobile-device");
    return view === "month" ? (mobile ? 2 : 3) : (mobile ? 3 : 4);
}

function openCalendarDay(date) {
    calendarView = "day";
    displayedMonth = atNoon(new Date(`${date}T12:00:00`));
    selectedEvent = null;
    refreshCalendarPeriod();
}

function calendarEventAccessibleLabel(event, client, date = "") {
    return [date ? formatPreviewDate(date) : "", calendarEventStatusLabel(event), formatEventTime(event), client.name, client.address, event.title, getAssignedTechnicianNames(event).join(" · "), client.phone].filter(Boolean).join(" · ");
}

function getEventClientDetails(event) {
    const client = findClientForEvent(event);
    return {
        name: client?.name || event.clientName || "",
        phone: client?.phone || "",
        address: (client ? formatClientAddress(client) : "") || event.location || ""
    };
}

function invalidateCalendarEventsCache() {
    calendarEventsCache.clear();
}

async function loadEvents() {
    const { start, end } = getDisplayedRange();
    const startDate = toDateString(start);
    const endDate = toDateString(end);
    const cacheKey = `${startDate}:${endDate}`;
    const cached = calendarEventsCache.get(cacheKey);
    if (cached && Date.now() - cached.loadedAt < EVENTS_CACHE_DURATION) return { ok: true, events: cached.events };
    return request(`/api/calendar/events?start=${encodeURIComponent(startDate)}&end=${encodeURIComponent(endDate)}`)
        .then(result => {
            if (!result.ok) return { ok: false, message: result.message };
            const loadedEvents = result.data.events || [];
            calendarEventsCache.set(cacheKey, { events: loadedEvents, loadedAt: Date.now() });
            return { ok: true, events: loadedEvents };
        });
}

async function loadCalendarMembers() {
    if (cachedMembers && Date.now() - cachedMembersAt < MEMBERS_CACHE_DURATION) return cachedMembers;
    const result = await request("/api/auth/calendar-members");
    const loadedMembers = result.ok ? (result.data?.members || []).filter(member => member.isActive) : [];
    if (result.ok) {
        cachedMembers = loadedMembers;
        cachedMembersAt = Date.now();
    }
    return loadedMembers;
}

function isTechnicianBillingAllowed() {
    return document.body.dataset.role !== "technician" || document.body.dataset.technicianBillingEnabled !== "false";
}

function canAccessTechnicalReports() {
    try { return JSON.parse(document.body.dataset.organizationFeatures || "{}").technicalReports !== false; }
    catch { return false; }
}

function canAccessQuitus() {
    try { return JSON.parse(document.body.dataset.organizationFeatures || "{}").quitus === true; }
    catch { return false; }
}

function isReadOnlyCalendar() {
    return ["technician", "accountant"].includes(document.body.dataset.role);
}

function isMobileAdministrator() {
    return document.body.dataset.role === "mobile_admin";
}

function canManageCalendarEventStatus() {
    return ["admin", "pc_standard", "mobile_admin"].includes(document.body.dataset.role);
}

function usesTerrainInterventionView(event) {
    return isReadOnlyCalendar() || (isMobileAdministrator() && Boolean(event?.id) && event.eventType === "appointment" && !mobileAdminEditingEvents.has(String(event.id)));
}

function roleLabel(role) {
    return ({ admin: "Poste Admin", pc_standard: "Poste administratif", mobile_admin: "Poste Admin Mobile", team_lead: "Chef d’équipe", technician: "Technicien", accountant: "Poste administratif" })[String(role || "")] || "Membre";
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
    return { title: "", clientName: "", location: "", date, startTime: "", endTime: "", color: "blue", eventType: "appointment", status: "planned", notes: "", assignedTechnicianId: "", assignedTechnicianName: "", assignedTechnicianIds: [] };
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
        status: String(form.get("status") || "planned"),
        assignedTechnicianId: String(form.get("assignedTechnicianId") || ""),
        assignedTechnicianIds: form.getAll("assignedTechnicianIds").map(value => String(value || "")),
        billingMode: String(form.get("billingMode") || ""),
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

async function multipartRequest(url, body) {
    try {
        const response = await fetch(url, { method: "POST", credentials: "same-origin", body });
        const data = await response.json().catch(() => null);
        return { ok: response.ok, data, message: data?.message };
    } catch {
        return { ok: false, data: null, message: "Serveur indisponible." };
    }
}
