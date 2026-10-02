import * as L from "/vendor/leaflet/leaflet-src.esm.js?v=1.9.4";
import { ROUTES } from "./config.js?v=137";
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
        activeMap = L.map(element, { zoomControl: true }).setView([46.7, 2.4], 6);
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' }).addTo(activeMap);
    }
    activeMap.eachLayer(layer => { if (!(layer instanceof L.TileLayer)) activeMap.removeLayer(layer); });
    const bounds = [];
    for (const event of events) {
        if (!validPoint(event)) continue;
        const marker = L.marker([event.latitude, event.longitude], { icon: interventionIcon(event.dayNumber) }).addTo(activeMap);
        marker.bindPopup(`<strong>Intervention n°${event.dayNumber}</strong><br>${escapeHtml(event.startTime || "Sans horaire")} · ${escapeHtml(event.clientName || event.title)}<br>${escapeHtml(event.location)}<br><button type="button" class="map-popup-action" data-popup-event="${escapeHtml(event.id)}">Ouvrir l’intervention</button>`);
        marker.on("popupopen", popup => popup.popup.getElement()?.querySelector("[data-popup-event]")?.addEventListener("click", () => openIntervention(event)));
        bounds.push([event.latitude, event.longitude]);
    }
    for (const technician of technicians.filter(item => selectedIds.has(String(item.id)))) {
        if (!validPoint(technician)) continue;
        L.marker([technician.latitude, technician.longitude], { icon: technicianIcon(technician) }).addTo(activeMap).bindPopup(`<strong>${escapeHtml(technician.name)}</strong><br>${technician.isLive ? "Position en direct" : `Dernière position ${escapeHtml(relativeTime(technician.updatedAt))}`}<br>Précision : ${Math.round(Number(technician.accuracyMeters) || 0)} m`);
        bounds.push([technician.latitude, technician.longitude]);
    }
    if (bounds.length) activeMap.fitBounds(bounds, { padding: [35, 35], maxZoom: 14 });
    window.setTimeout(() => activeMap?.invalidateSize(), 0);
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
function validPoint(item) { return Number.isFinite(Number(item?.latitude)) && Number.isFinite(Number(item?.longitude)); }
function technicianNames(event) { return (event.assignedTechnicians || []).map(item => item.fullName).filter(Boolean).join(", ") || "Non affectée"; }
function interventionIcon(number) { return L.divIcon({ className: "operations-map-marker", html: `<span>${Number(number) || "·"}</span>`, iconSize: [34, 42], iconAnchor: [17, 42], popupAnchor: [0, -38] }); }
function technicianIcon(technician) { const initials = String(technician.name || "T").split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase(); return L.divIcon({ className: `technician-map-marker${technician.isLive ? " live" : ""}`, html: `<span>${escapeHtml(initials)}</span><i></i>`, iconSize: [42, 42], iconAnchor: [21, 21], popupAnchor: [0, -24] }); }
function openIntervention(event) { if (event) window.dispatchEvent(new CustomEvent("depannhome:open-map-intervention", { detail: { event } })); }
function localDate() { const now = new Date(); return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10); }
function validDate(value) { const date = String(value || ""); return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : ""; }
function relativeTime(value) { const elapsed = Math.max(0, Date.now() - new Date(value).getTime()); const minutes = Math.floor(elapsed / 60_000); if (minutes < 1) return "à l’instant"; if (minutes < 60) return `il y a ${minutes} min`; const hours = Math.floor(minutes / 60); return `il y a ${hours} h`;
}
function distanceMeters(first, second) { const radius = 6371e3; const toRadians = value => value * Math.PI / 180; const latitudeDelta = toRadians(second.latitude - first.latitude); const longitudeDelta = toRadians(second.longitude - first.longitude); const firstLatitude = toRadians(first.latitude); const secondLatitude = toRadians(second.latitude); const value = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2; return radius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value)); }
function clearMapRefresh() { if (mapRefreshTimer) window.clearInterval(mapRefreshTimer); mapRefreshTimer = null; activeMap?.remove(); activeMap = null; }
