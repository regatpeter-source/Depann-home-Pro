import { ROUTES } from "./config.js?v=105";
import { createBillingDocumentForClient } from "./billing.js?v=125";
import { getSearchableClients } from "./clients.js?v=124";
import { addClientActivityByName, synchronizeClients } from "./client-sync.js?v=88";
import { renderClientMessages } from "./messages.js?v=88";
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
                ${readOnly ? "" : '<button type="button" class="secondary-button" data-calendar-action="new">+ Nouveau rendez-vous</button>'}
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
    return `
        <section class="calendar-technician-filter" aria-label="Filtrer le planning par technicien">
            <div><p class="eyebrow">Équipe affichée</p><strong>${count} technicien${count === 1 ? "" : "s"} sélectionné${count === 1 ? "" : "s"}</strong></div>
            <div class="calendar-technician-options">
                <label><input type="checkbox" data-calendar-filter="all" ${showAllTechnicians ? "checked" : ""}> Toute l’équipe</label>
                ${technicians.map(technician => `<label><input type="checkbox" data-calendar-technician="${escapeHtml(technician.id)}" ${showAllTechnicians || visibleTechnicianIds.has(String(technician.id)) ? "checked" : ""}> ${escapeHtml(technician.fullName || technician.username)}</label>`).join("")}
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
                        </div>
                    </section>
                    <section class="calendar-appointment-information">
                        <p class="eyebrow">Informations du rendez-vous</p>
                        <dl><dt>Date</dt><dd>${escapeHtml(formatActivityDate(event.date, event.startTime))}${event.endTime ? ` — ${escapeHtml(event.endTime)}` : ""}</dd>${event.assignedTechnicianName ? `<dt>Technicien</dt><dd>${escapeHtml(event.assignedTechnicianName)}</dd>` : ""}${event.notes ? `<dt>Notes</dt><dd>${escapeHtml(event.notes)}</dd>` : ""}</dl>
                    </section>
                    ${renderInterventionPhotosHtml(client)}
                    <section class="calendar-billing-actions">
                        <div><p class="eyebrow">Fin d’intervention</p><h3>Devis et facture</h3><p class="muted">Créez le document adapté après avoir renseigné l’intervention.</p></div>
                        <div><button type="button" class="secondary-button" data-client-action="quote">Créer un devis</button><button type="button" class="secondary-button" data-client-action="invoice">Créer une facture</button></div>
                    </section>
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
        panel.querySelector('[data-client-action="quote"]')?.addEventListener("click", () => createBillingDocumentForClient("quote", client));
        panel.querySelector('[data-client-action="invoice"]')?.addEventListener("click", () => createBillingDocumentForClient("invoice", client));
        panel.querySelector("#calendarInterventionPhotos")?.addEventListener("submit", eventSubmit => uploadInterventionPhotos(eventSubmit, client));
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
                    Type
                    <select name="eventType">${EVENT_TYPE_OPTIONS.map(type => `<option value="${type.id}" ${event.eventType === type.id ? "selected" : ""}>${type.label}</option>`).join("")}</select>
                </label>
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
    const eventTypeInput = form.querySelector("[name=eventType]");
    const fillClientAddress = () => {
        const clientName = normalizeText(clientInput.value);
        const client = clients.find(item => normalizeText(item.name) === clientName);
        const address = client ? formatClientAddress(client) : "";
        if (address) locationInput.value = address;
    };
    clientInput.addEventListener("input", fillClientAddress);
    clientInput.addEventListener("change", fillClientAddress);
    eventTypeInput.addEventListener("change", () => {
        const type = getEventType(eventTypeInput.value);
        if (!event.id || form.elements.title.value === getEventType(event.eventType).title) form.elements.title.value = type.title;
        form.elements.color.value = type.color;
        if (type.id !== "appointment") {
            clientInput.value = "";
            locationInput.value = "";
            form.elements.startTime.value = "";
            form.elements.endTime.value = "";
        }
        renderCalendarAvailability(form, event.id);
    });
    ["date", "startTime", "endTime", "title", "assignedTechnicianId"].forEach(name => form.elements[name].addEventListener("input", () => renderCalendarAvailability(form, event.id)));
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
    const files = ["files", "cameraPhoto"].flatMap(name => Array.from(form.elements[name].files || []));
    if (!files.length) {
        feedback.textContent = "Sélectionnez au moins une photo ou un fichier.";
        feedback.classList.add("error");
        return;
    }
    button.disabled = true;
    feedback.textContent = "Dépôt en cours…";
    feedback.classList.remove("error");
    const result = await uploadClientFiles(client, new FormData(form).get("type") || "Autre", files);
    if (!result.ok) {
        feedback.textContent = result.message || "Dépôt impossible.";
        feedback.classList.add("error");
        button.disabled = false;
        return;
    }
    form.reset();
    feedback.textContent = result.message || "Fichier ajouté au dossier.";
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

function renderInterventionPhotosHtml(client) {
    const before = (client.attachments || []).filter(attachment => attachment.type === "Photo avant");
    const after = (client.attachments || []).filter(attachment => attachment.type === "Photo après");
    const previews = photos => photos.length
        ? `<div class="intervention-photo-previews">${photos.map(photo => `<img src="${escapeHtml(photo.dataUrl)}" alt="${escapeHtml(photo.name)}">`).join("")}</div>`
        : '<p class="muted">Aucune photo pour le moment.</p>';
    return `
        <form id="calendarInterventionPhotos" class="calendar-intervention-photos">
            <div><p class="eyebrow">Photos d’intervention</p><h3>Avant / après</h3></div>
            <section><h4>Avant intervention</h4>${previews(before)}<label>Ajouter une photo avant<input name="beforePhoto" type="file" accept="image/*" capture="environment"></label></section>
            <section><h4>Après intervention</h4>${previews(after)}<label>Ajouter une photo après<input name="afterPhoto" type="file" accept="image/*" capture="environment"></label></section>
            <div class="calendar-form-actions"><button type="submit" class="secondary-button">Ajouter les photos</button></div><p class="auth-message" aria-live="polite"></p>
        </form>
    `;
}

async function uploadInterventionPhotos(event, client) {
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
        const result = await uploadClientFiles(client, upload.type, upload.files);
        if (!result.ok) {
            feedback.textContent = result.message || "Ajout des photos impossible.";
            feedback.classList.add("error");
            button.disabled = false;
            return;
        }
    }
    selectedEvent = event;
    renderCalendar({ event });
}

async function uploadClientFiles(client, type, files) {
    const payload = new FormData();
    payload.append("type", type);
    files.forEach(file => payload.append("files", file));
    const response = await fetch(`/api/clients/${encodeURIComponent(client.id)}/attachments`, { method: "POST", credentials: "same-origin", body: payload });
    const data = await response.json().catch(() => null);
    if (!response.ok) return { ok: false, message: data?.message };
    await synchronizeClients();
    return { ok: true, message: data?.message };
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
            button.title = [event.title, event.assignedTechnicianName, clientDetails.name, clientDetails.phone, clientDetails.address, event.startTime && `${event.startTime}${event.endTime ? ` – ${event.endTime}` : ""}`].filter(Boolean).join(" · ");
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
    return events.filter(event => visibleTechnicianIds.has(String(event.assignedTechnicianId || "")));
}

function renderCalendarEventCard(event, client) {
    return `<span>${escapeHtml(event.startTime || "Toute la journée")}</span><strong>${escapeHtml(event.title)}</strong>${event.assignedTechnicianName ? `<small>👤 ${escapeHtml(event.assignedTechnicianName)}</small>` : ""}${client.name ? `<small class="calendar-event-client">${escapeHtml(client.name)}</small>` : ""}${client.phone ? `<small class="calendar-event-contact">📞 ${escapeHtml(client.phone)}</small>` : ""}${client.address ? `<small class="calendar-event-contact">📍 ${escapeHtml(client.address)}</small>` : ""}`;
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
    return { title: "", clientName: "", location: "", date, startTime: "", endTime: "", color: "blue", eventType: "appointment", notes: "", assignedTechnicianId: "", assignedTechnicianName: "" };
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
