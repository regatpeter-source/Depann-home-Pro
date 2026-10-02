import { LngLatBounds, Map, Marker, NavigationControl, Popup } from "/vendor/maplibre/maplibre-gl.mjs?v=6.11.2";
import { ROUTES } from "./config.js?v=138";
import { escapeHtml } from "./utils.js?v=44";
import { clearSearch, getContainer, setPage } from "./ui.js?v=44";

const SHARING_KEY = "depannHomePro:terrain-location-sharing";
const SEND_INTERVAL = 15_000;
const HEARTBEAT_INTERVAL = 60_000;
const MINIMUM_DISTANCE_METERS = 25;
let locationWatchId = null;
let sharingButton = null;
let sharingStatus = null;
let lastSentPosition = null;
let lastSentAt = 0;
let mapRefreshTimer = null;
let activeMap = null;
let activeMarkers = [];
const planningMaps = new WeakMap();

export function initializeTerrainLocationSharing() {
    if (!canShareLocation() || sharingButton) return;
    const container = document.createElement("aside");
    container.className = "terrain-location-control";
    container.setAttribute("aria-live", "polite");
    container.innerHTML = '<span class="terrain-location-dot" aria-hidden="true"></span><div><strong>Position terrain</strong><small data-location-status>Partage arrêté</small></div><button type="button" class="secondary-button" data-location-toggle>Démarrer</button>';
    document.body.appendChild(container);
    sharingButton = container.querySelector("[data-location-toggle]");
    sharingStatus = container.querySelector("[data-location-status]");
    sharingButton.addEventListener("click", () => isSharingEnabled() ? stopTerrainLocationSharing() : requestTerrainLocationSharing());
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && isSharingEnabled()) startPositionWatcher();
    });
    window.addEventListener("online", () => { if (isSharingEnabled()) startPositionWatcher(); });
    window.addEventListener("depannhome:stop-location-sharing", () => stopTerrainLocationSharing());
    if (isSharingEnabled()) startPositionWatcher();
}

export async function renderOperationsMap(options = {}) {
    clearMapRefresh();
    clearSearch();
    setPage("Carte des interventions", ROUTES.operationsMap, "detail");
    const date = validDate(options.date) || localDate();
    const container = getContainer();
    const panel = document.createElement("section");
    panel.className = "client-panel operations-map-panel";
    panel.innerHTML = `<header class="operations-map-heading"><div><p class="eyebrow">Pilotage terrain</p><h2>Interventions du jour sur la carte</h2><p class="muted">Les interventions sont numérotées dans l’ordre horaire. Les positions sont visibles uniquement lorsque les techniciens ont activé leur partage.</p></div><div class="operations-map-date"><label>Journée<input type="date" value="${escapeHtml(date)}" data-map-date></label><button type="button" class="secondary-button" data-map-refresh>Actualiser</button></div></header><div class="operations-map-privacy"><strong>Localisation responsable</strong><span>Dernière position uniquement · aucun trajet enregistré · « en direct » si actualisée depuis moins de 2 minutes.</span></div><div class="operations-map-layout"><aside class="operations-map-sidebar"><section data-map-filters></section><section data-map-list><p class="muted">Chargement des interventions…</p></section></aside><div class="operations-map-canvas" data-operations-map aria-label="Carte des interventions et techniciens"></div></div><p class="auth-message" data-map-feedback aria-live="polite"></p>`;
    container.appendChild(panel);
    panel.querySelector("[data-map-date]").addEventListener("change", event => renderOperationsMap({ date: event.currentTarget.value }));
    panel.querySelector("[data-map-refresh]").addEventListener("click", () => loadOperationsMap(panel, date, true));
    await loadOperationsMap(panel, date);
    mapRefreshTimer = window.setInterval(() => {
        if (!panel.isConnected) return clearMapRefresh();
        if (document.visibilityState === "visible") loadOperationsMap(panel, date);
    }, 15_000);
}

export async function renderPlanningOperationsMap(container, options = {}) {
    if (!container) return;
    const date = validDate(options.date) || localDate();
    const technicianIds = [...new Set((options.technicianIds || []).map(String).filter(id => /^\d+$/.test(id)))];
    const address = String(options.address || "").trim();
    let state = planningMaps.get(container);
    if (!state) {
        container.innerHTML = `<div class="calendar-planning-map-heading"><div><p class="eyebrow">Carte terrain de planification</p><h3>Adresse et membres affectés</h3><p class="muted" data-planning-map-context></p></div><span data-planning-map-date></span></div><div class="calendar-planning-map-canvas" data-planning-map-canvas aria-label="Carte de proximité pour planifier l’intervention"></div><div class="calendar-planning-map-summary" data-planning-map-summary></div><p class="auth-message" data-planning-map-feedback aria-live="polite"></p>`;
        state = { map: null, markers: [], requestVersion: 0 };
        planningMaps.set(container, state);
    }
    const version = ++state.requestVersion;
    container.querySelector("[data-planning-map-date]").textContent = options.urgent ? "Urgence · aujourd’hui" : formatMapDate(date);
    container.querySelector("[data-planning-map-context]").textContent = technicianIds.length
        ? `${technicianIds.length} membre${technicianIds.length > 1 ? "s" : ""} sélectionné${technicianIds.length > 1 ? "s" : ""} · seuls leurs rendez-vous et positions sont affichés.`
        : "Sélectionnez un technicien ou une équipe pour afficher uniquement les membres concernés.";
    const summary = container.querySelector("[data-planning-map-summary]");
    const feedback = container.querySelector("[data-planning-map-feedback]");
    if (!technicianIds.length) {
        state.markers.forEach(marker => marker.remove());
        state.markers = [];
        summary.innerHTML = '<p class="muted">Aucun membre sélectionné.</p>';
        feedback.textContent = "";
        return;
    }
    if (!address) {
        state.markers.forEach(marker => marker.remove());
        state.markers = [];
        summary.innerHTML = '<p class="muted">Renseignez l’adresse d’intervention pour calculer la proximité.</p>';
        feedback.textContent = "";
        return;
    }
    feedback.classList.remove("error");
    feedback.textContent = "Actualisation de la carte de proximité…";
    const query = new URLSearchParams({ date, address, technicianIds: technicianIds.join(",") });
    if (options.excludeEventId) query.set("excludeEventId", String(options.excludeEventId));
    try {
        const response = await fetch(`/api/operations-map/day?${query}`, { credentials: "same-origin", cache: "no-store" });
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload?.message || "Impossible de charger la carte de proximité.");
        if (version !== state.requestVersion || !container.isConnected) return;
        const targetLocated = renderPlanningMapPayload(container, state, payload);
        feedback.textContent = targetLocated ? "" : "Adresse d’intervention non localisée. Vérifiez la rue, le code postal et la ville.";
        feedback.classList.toggle("error", !targetLocated);
    } catch (error) {
        if (version !== state.requestVersion) return;
        feedback.textContent = error.message;
        feedback.classList.add("error");
    }
}

function renderPlanningMapPayload(container, state, payload) {
    const element = container.querySelector("[data-planning-map-canvas]");
    if (!state.map) {
        state.map = new Map({ container: element, style: mapStyleUrl(), center: [2.4, 46.7], zoom: 5, attributionControl: true });
        state.map.addControl(new NavigationControl({ showCompass: false }), "top-left");
    }
    state.markers.forEach(marker => marker.remove());
    state.markers = [];
    const bounds = new LngLatBounds();
    const target = payload?.target;
    if (validPoint(target)) {
        const popup = new Popup({ offset: 28 }).setHTML(`<strong>Adresse de l’intervention</strong><br>${escapeHtml(target.address)}`);
        state.markers.push(new Marker({ element: planningTargetMarker(), anchor: "bottom" }).setLngLat([target.longitude, target.latitude]).setPopup(popup).addTo(state.map));
        bounds.extend([target.longitude, target.latitude]);
    }
    for (const event of payload?.events || []) {
        if (!validPoint(event)) continue;
        const popup = new Popup({ offset: 25 }).setHTML(`<strong>${escapeHtml(event.startTime || "Sans horaire")} · ${escapeHtml(event.clientName || event.title)}</strong><br>${escapeHtml(event.location)}<br>${escapeHtml(technicianNames(event))}`);
        state.markers.push(new Marker({ element: planningEventMarker(event.dayNumber), anchor: "bottom" }).setLngLat([event.longitude, event.latitude]).setPopup(popup).addTo(state.map));
        bounds.extend([event.longitude, event.latitude]);
    }
    const technicians = (Array.isArray(payload?.technicians) ? [...payload.technicians] : []).sort((first, second) => {
        const firstDistance = validTravelTime(first) ? Number(first.travelDurationSeconds) : validPoint(target) && validPoint(first) ? distanceMeters(target, first) : Number.POSITIVE_INFINITY;
        const secondDistance = validTravelTime(second) ? Number(second.travelDurationSeconds) : validPoint(target) && validPoint(second) ? distanceMeters(target, second) : Number.POSITIVE_INFINITY;
        return firstDistance - secondDistance || String(first.name || "").localeCompare(String(second.name || ""), "fr");
    });
    for (const technician of technicians) {
        if (!validPoint(technician)) continue;
        const distance = validPoint(target) ? distanceMeters(target, technician) : null;
        const travel = travelTimeLabel(technician, distance);
        const popup = new Popup({ offset: 24 }).setHTML(`<strong>${escapeHtml(technician.name)}</strong><br>${technician.isLive ? "Position en direct" : `Dernière position ${escapeHtml(relativeTime(technician.updatedAt))}`}${travel ? `<br>Vers cette intervention : ${escapeHtml(travel)}` : ""}`);
        state.markers.push(new Marker({ element: technicianMarker(technician) }).setLngLat([technician.longitude, technician.latitude]).setPopup(popup).addTo(state.map));
        bounds.extend([technician.longitude, technician.latitude]);
    }
    if (!bounds.isEmpty()) state.map.fitBounds(bounds, { padding: 45, maxZoom: 14 });
    window.setTimeout(() => state.map?.resize(), 0);
    const summary = container.querySelector("[data-planning-map-summary]");
    summary.innerHTML = technicians.length ? technicians.map(technician => {
        const directDistance = validPoint(target) && validPoint(technician) ? distanceMeters(target, technician) : null;
        const travel = !validPoint(technician) ? "Position non partagée" : !validPoint(target) ? "Adresse non localisée" : travelTimeLabel(technician, directDistance);
        const freshness = validPoint(technician) ? technician.isLive ? "En direct" : `Actualisée ${relativeTime(technician.updatedAt)}` : "Activez le partage sur son poste mobile";
        return `<article><span class="technician-map-dot${technician.isLive ? " live" : ""}"></span><div><strong>${escapeHtml(technician.name)}</strong><small>${escapeHtml(freshness)}</small></div><b>${escapeHtml(travel)}</b></article>`;
    }).join("") : '<p class="muted">Aucun des membres sélectionnés n’est disponible sur cette carte.</p>';
    return validPoint(target);
}

async function loadOperationsMap(panel, date, announce = false) {
    const feedback = panel.querySelector("[data-map-feedback]");
    if (announce) feedback.textContent = "Actualisation de la carte…";
    try {
        const response = await fetch(`/api/operations-map/day?date=${encodeURIComponent(date)}`, { credentials: "same-origin", cache: "no-store" });
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload?.message || "Impossible de charger la carte terrain.");
        renderMapContents(panel, payload);
        feedback.textContent = announce ? "Carte actualisée." : "";
        feedback.classList.remove("error");
    } catch (error) {
        feedback.textContent = error.message;
        feedback.classList.add("error");
    }
}

function renderMapContents(panel, payload) {
    const events = Array.isArray(payload.events) ? payload.events : [];
    const technicians = Array.isArray(payload.technicians) ? payload.technicians : [];
    const filters = panel.querySelector("[data-map-filters]");
    const selected = selectedTechnicianIds(filters);
    filters.innerHTML = `<div class="operations-map-sidebar-title"><div><p class="eyebrow">Équipe</p><h3>Techniciens visibles</h3></div><span>${technicians.length}</span></div>${technicians.length ? `<div class="operations-map-technicians">${technicians.map(technician => `<label><input type="checkbox" value="${escapeHtml(technician.id)}" ${!selected.size || selected.has(String(technician.id)) ? "checked" : ""}><span class="technician-map-dot${technician.isLive ? " live" : ""}"></span><span><strong>${escapeHtml(technician.name)}</strong><small>${technician.isLive ? "En direct" : `Dernière position ${escapeHtml(relativeTime(technician.updatedAt))}`}</small></span></label>`).join("")}</div>` : '<p class="muted">Aucun technicien ne partage actuellement sa position.</p>'}`;
    const applySelection = () => renderMapMarkers(panel, events, technicians, selectedTechnicianIds(filters));
    filters.querySelectorAll('input[type="checkbox"]').forEach(input => input.addEventListener("change", applySelection));
    renderInterventionList(panel.querySelector("[data-map-list]"), events);
    renderMapMarkers(panel, events, technicians, selectedTechnicianIds(filters));
}

function renderInterventionList(container, events) {
    container.innerHTML = `<div class="operations-map-sidebar-title"><div><p class="eyebrow">Tournée</p><h3>Interventions planifiées</h3></div><span>${events.length}</span></div>${events.length ? `<ol class="operations-map-interventions">${events.map(event => `<li><button type="button" data-map-event="${escapeHtml(event.id)}"><b>${event.dayNumber}</b><span><strong>${escapeHtml(event.startTime || "Sans horaire")} · ${escapeHtml(event.clientName || event.title)}</strong><small>${escapeHtml(event.location || "Adresse non renseignée")}</small><em>${escapeHtml(technicianNames(event))}</em></span></button></li>`).join("")}</ol>` : '<p class="muted">Aucune intervention planifiée pour cette journée.</p>'}`;
    container.querySelectorAll("[data-map-event]").forEach(button => button.addEventListener("click", () => openIntervention(events.find(event => String(event.id) === button.dataset.mapEvent))));
}

function renderMapMarkers(panel, events, technicians, selectedIds) {
    const element = panel.querySelector("[data-operations-map]");
    if (!activeMap || activeMap.getContainer() !== element) {
        activeMap?.remove();
        activeMap = new Map({ container: element, style: mapStyleUrl(), center: [2.4, 46.7], zoom: 5, attributionControl: true });
        activeMap.addControl(new NavigationControl({ showCompass: false }), "top-left");
        activeMap.on("error", event => {
            const feedback = panel.querySelector("[data-map-feedback]");
            if (!feedback || !event?.error) return;
            feedback.textContent = "Le fond cartographique est momentanément indisponible. Les positions et interventions restent actualisées.";
            feedback.classList.add("error");
        });
    }
    activeMarkers.forEach(marker => marker.remove());
    activeMarkers = [];
    const bounds = new LngLatBounds();
    for (const event of events) {
        if (!validPoint(event)) continue;
        const popup = new Popup({ offset: 30 }).setHTML(`<strong>Intervention n°${event.dayNumber}</strong><br>${escapeHtml(event.startTime || "Sans horaire")} · ${escapeHtml(event.clientName || event.title)}<br>${escapeHtml(event.location)}<br><button type="button" class="map-popup-action" data-popup-event="${escapeHtml(event.id)}">Ouvrir l’intervention</button>`);
        popup.on("open", () => popup.getElement()?.querySelector("[data-popup-event]")?.addEventListener("click", () => openIntervention(event), { once: true }));
        activeMarkers.push(new Marker({ element: interventionMarker(event.dayNumber), anchor: "bottom" }).setLngLat([event.longitude, event.latitude]).setPopup(popup).addTo(activeMap));
        bounds.extend([event.longitude, event.latitude]);
    }
    for (const technician of technicians.filter(item => selectedIds.has(String(item.id)))) {
        if (!validPoint(technician)) continue;
        const popup = new Popup({ offset: 24 }).setHTML(`<strong>${escapeHtml(technician.name)}</strong><br>${technician.isLive ? "Position en direct" : `Dernière position ${escapeHtml(relativeTime(technician.updatedAt))}`}<br>Précision : ${Math.round(Number(technician.accuracyMeters) || 0)} m`);
        activeMarkers.push(new Marker({ element: technicianMarker(technician) }).setLngLat([technician.longitude, technician.latitude]).setPopup(popup).addTo(activeMap));
        bounds.extend([technician.longitude, technician.latitude]);
    }
    if (!bounds.isEmpty()) activeMap.fitBounds(bounds, { padding: 35, maxZoom: 14 });
    window.setTimeout(() => activeMap?.resize(), 0);
}

function requestTerrainLocationSharing() {
    if (!navigator.geolocation) return updateSharingState("La géolocalisation n’est pas disponible sur ce téléphone.", true);
    const accepted = window.confirm("Partager votre position pendant le service ?\n\nSeule votre dernière position est conservée. Aucun trajet n’est enregistré. Le partage fonctionne lorsque l’application est ouverte et peut s’interrompre en arrière-plan selon le téléphone. Vous pourrez l’arrêter à tout moment.");
    if (!accepted) return;
    localStorage.setItem(SHARING_KEY, "true");
    startPositionWatcher();
}

function startPositionWatcher() {
    if (!isSharingEnabled() || locationWatchId !== null || !navigator.geolocation) return;
    updateSharingState("Recherche de votre position…");
    locationWatchId = navigator.geolocation.watchPosition(handlePosition, handlePositionError, { enableHighAccuracy: true, maximumAge: 15_000, timeout: 20_000 });
    sharingButton.textContent = "Arrêter";
    sharingButton.closest(".terrain-location-control")?.classList.add("sharing");
}

async function handlePosition(position) {
    const next = { latitude: position.coords.latitude, longitude: position.coords.longitude, accuracyMeters: position.coords.accuracy, recordedAt: new Date(position.timestamp).toISOString() };
    const now = Date.now();
    if (lastSentPosition && now - lastSentAt < SEND_INTERVAL) return;
    if (lastSentPosition && now - lastSentAt < HEARTBEAT_INTERVAL && distanceMeters(lastSentPosition, next) < MINIMUM_DISTANCE_METERS) return;
    try {
        const response = await fetch("/api/operations-map/location", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...next, consent: true }) });
        if (!response.ok) throw new Error("Transmission refusée");
        lastSentPosition = next;
        lastSentAt = now;
        updateSharingState(`Partagée à ${new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(new Date())}`);
    } catch {
        updateSharingState("Position en attente de connexion", true);
    }
}

function handlePositionError(error) {
    const messages = { 1: "Autorisation de localisation refusée", 2: "Position momentanément indisponible", 3: "Délai de localisation dépassé" };
    updateSharingState(messages[error.code] || "Localisation impossible", true);
    if (error.code === 1) stopTerrainLocationSharing({ removeServerPosition: true });
}

export async function stopTerrainLocationSharing({ removeServerPosition = true } = {}) {
    localStorage.removeItem(SHARING_KEY);
    if (locationWatchId !== null) navigator.geolocation?.clearWatch(locationWatchId);
    locationWatchId = null;
    lastSentPosition = null;
    lastSentAt = 0;
    if (sharingButton) sharingButton.textContent = "Démarrer";
    sharingButton?.closest(".terrain-location-control")?.classList.remove("sharing", "error");
    updateSharingState("Partage arrêté");
    if (removeServerPosition && canShareLocation()) await fetch("/api/operations-map/location", { method: "DELETE", credentials: "same-origin" }).catch(() => {});
}

function updateSharingState(message, error = false) {
    if (sharingStatus) sharingStatus.textContent = message;
    sharingButton?.closest(".terrain-location-control")?.classList.toggle("error", error);
}
function isSharingEnabled() { return localStorage.getItem(SHARING_KEY) === "true"; }
function canShareLocation() { return document.body.dataset.deviceType === "mobile" && ["mobile_admin", "team_lead", "technician"].includes(document.body.dataset.role); }
function selectedTechnicianIds(container) { return new Set([...container.querySelectorAll('input[type="checkbox"]:checked')].map(input => input.value)); }
function validPoint(item) { return item?.latitude !== null && item?.latitude !== "" && item?.longitude !== null && item?.longitude !== "" && Number.isFinite(Number(item?.latitude)) && Number.isFinite(Number(item?.longitude)); }
function technicianNames(event) { return (event.assignedTechnicians || []).map(item => item.fullName).filter(Boolean).join(", ") || "Non affectée"; }
function interventionMarker(number) { const element = document.createElement("div"); element.className = "operations-map-marker"; element.innerHTML = `<span>${Number(number) || "·"}</span>`; return element; }
function planningEventMarker(number) { const element = interventionMarker(number); element.classList.add("planning-event-marker"); return element; }
function planningTargetMarker() { const element = document.createElement("div"); element.className = "planning-target-marker"; element.innerHTML = '<span><b>⌂</b></span><em>Intervention</em>'; return element; }
function technicianMarker(technician) { const initials = String(technician.name || "T").split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase(); const element = document.createElement("div"); element.className = `technician-map-marker${technician.isLive ? " live" : ""}`; element.innerHTML = `<span>${escapeHtml(initials)}</span><i></i>`; return element; }
function openIntervention(event) { if (event) window.dispatchEvent(new CustomEvent("depannhome:open-map-intervention", { detail: { event } })); }
function localDate() { const now = new Date(); return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10); }
function validDate(value) { const date = String(value || ""); return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : ""; }
function relativeTime(value) { const elapsed = Math.max(0, Date.now() - new Date(value).getTime()); const minutes = Math.floor(elapsed / 60_000); if (minutes < 1) return "à l’instant"; if (minutes < 60) return `il y a ${minutes} min`; const hours = Math.floor(minutes / 60); return `il y a ${hours} h`;
}
function formatMapDate(value) { return new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "2-digit", month: "2-digit" }).format(new Date(`${value}T12:00:00`)); }
function formatDistance(value) { return value < 1000 ? `${Math.round(value)} m` : `${(value / 1000).toFixed(value < 10_000 ? 1 : 0).replace(".", ",")} km`; }
function formatTravelDuration(value) { const minutes = Math.max(1, Math.round(Number(value) / 60)); const hours = Math.floor(minutes / 60); const remaining = minutes % 60; return hours ? `${hours} h${remaining ? ` ${remaining} min` : ""}` : `${minutes} min`; }
function validTravelTime(value) { return Number.isFinite(Number(value?.travelDurationSeconds)) && Number(value.travelDurationSeconds) >= 0 && Number.isFinite(Number(value?.routeDistanceMeters)) && Number(value.routeDistanceMeters) >= 0; }
function travelTimeLabel(technician, directDistance) { return validTravelTime(technician) ? `${formatDistance(Number(technician.routeDistanceMeters))} · ${formatTravelDuration(technician.travelDurationSeconds)} en voiture` : directDistance === null ? "" : `${formatDistance(directDistance)} à vol d’oiseau · trajet indisponible`; }
function mapStyleUrl() { return `https://tiles.openfreemap.org/styles/${document.body.classList.contains("dark-theme") ? "dark" : "liberty"}`; }
function distanceMeters(first, second) { const radius = 6371e3; const toRadians = value => value * Math.PI / 180; const latitudeDelta = toRadians(second.latitude - first.latitude); const longitudeDelta = toRadians(second.longitude - first.longitude); const firstLatitude = toRadians(first.latitude); const secondLatitude = toRadians(second.latitude); const value = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2; return radius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value)); }
function clearMapRefresh() { if (mapRefreshTimer) window.clearInterval(mapRefreshTimer); mapRefreshTimer = null; activeMarkers = []; activeMap?.remove(); activeMap = null; }
