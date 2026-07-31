import crypto from "node:crypto";
import { getPool } from "./database.js";
import { getAccountOwnerId } from "./auth.js";

const ACTIONS = new Set([
    "new_mission", "accept", "reject", "reschedule", "reassign", "partner_message", "internal_message",
    "toggle_visibility", "create_quote", "accept_quote", "reject_quote", "complete_report", "add_photos",
    "create_invoice", "close", "cancel", "request_information"
]);
const TECHNICIANS = ["Technicien Démo", "Sophie Bernard", "Lucas Morel"];
const DEMO_PARTNER = Object.freeze({ id: "assurtest-demo", name: "AssurTest Démo", organizationType: "Assurance", status: "Partenaire officiel de démonstration", connector: "Simulé", api: "Simulée", description: "Assurance fictive permettant de tester les échanges avec Depann’Home Pro." });

export function isPartnerSandboxEnabled() {
    return process.env.PARTNER_SANDBOX_ENABLED === "true" && process.env.NODE_ENV !== "production";
}

export async function initializePartnerSandbox() {
    if (!isPartnerSandboxEnabled()) return;
    const database = getPool();
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_partner_sandbox_sessions (
            owner_id BIGINT PRIMARY KEY REFERENCES depannhome_users(id) ON DELETE CASCADE,
            payload JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
}

export function registerPartnerSandboxRoutes(app, requireAuthentication) {
    app.use("/api/partner-sandbox", requireAuthentication, requireSandboxAdministration, requireSandboxEnabled);
    app.get("/api/partner-sandbox", asyncHandler(async (request, response) => {
        response.json({ available: true, enabled: Boolean(await loadSession(getAccountOwnerId(request))) });
    }));
    app.get("/api/partner-sandbox/connection-scenario", asyncHandler(async (request, response) => {
        response.json({ scenario: connectionScenario(await loadSession(getAccountOwnerId(request))) });
    }));
    app.post("/api/partner-sandbox/connection-scenario/request", asyncHandler(async (request, response) => {
        const ownerId = getAccountOwnerId(request);
        const payload = await ensureSandboxPayload(ownerId, request.user);
        const connection = payload.connection || {};
        if (connection.status === "connected") return response.status(409).json({ message: "AssurTest Démo est déjà connecté." });
        payload.connection = { status: "pending", connectorActive: false, requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        appendApi(payload, "POST", "/simulated-api/connections", "202 Accepted", "Demande de connexion envoyée à AssurTest Démo.");
        appendTimeline(currentMission(payload), new Date(), "system", "Demande de connexion envoyée à AssurTest Démo.", "connection_requested", request.user.fullName || request.user.username);
        await saveSession(ownerId, request.user.sub, payload);
        response.status(201).json({ scenario: connectionScenario(payload) });
    }));
    app.post("/api/partner-sandbox/connection-scenario/accept", asyncHandler(async (request, response) => {
        const ownerId = getAccountOwnerId(request);
        const payload = await loadSession(ownerId);
        if (!payload?.connection || payload.connection.status !== "pending") return response.status(409).json({ message: "Aucune demande Sandbox en attente de validation." });
        payload.connection = { ...payload.connection, status: "connected", connectorActive: true, acceptedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        appendApi(payload, "POST", "/simulated-api/connections/assurtest-demo/accept", "200 OK", "Connexion acceptée et connecteur simulé activé.");
        appendTimeline(currentMission(payload), new Date(), "partner", "Connexion acceptée par AssurTest Démo. Le connecteur simulé est actif.", "connection_accepted");
        await saveSession(ownerId, request.user.sub, payload);
        response.json({ scenario: connectionScenario(payload) });
    }));
    app.post("/api/partner-sandbox/connection-scenario/disconnect", asyncHandler(async (request, response) => {
        const ownerId = getAccountOwnerId(request);
        const payload = await loadSession(ownerId);
        if (!payload?.connection || payload.connection.status !== "connected") return response.status(409).json({ message: "AssurTest Démo n’est pas connecté." });
        payload.connection = { ...payload.connection, status: "disconnected", connectorActive: false, disconnectedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        appendApi(payload, "POST", "/simulated-api/connections/assurtest-demo/disconnect", "200 OK", "Connecteur simulé désactivé ; l’historique est conservé.");
        appendTimeline(currentMission(payload), new Date(), "internal", "Connexion AssurTest Démo désactivée. L’historique Sandbox est conservé.", "connection_disconnected", request.user.fullName || request.user.username);
        await saveSession(ownerId, request.user.sub, payload);
        response.json({ scenario: connectionScenario(payload) });
    }));
    app.post("/api/partner-sandbox/activate", asyncHandler(async (request, response) => {
        const ownerId = getAccountOwnerId(request);
        const existing = await loadSession(ownerId);
        const payload = existing || createSandboxPayload(request.user);
        await saveSession(ownerId, request.user.sub, payload);
        response.status(existing ? 200 : 201).json({ sandbox: publicSandbox(payload) });
    }));
    app.get("/api/partner-sandbox/workspace", asyncHandler(async (request, response) => {
        const payload = await loadSession(getAccountOwnerId(request));
        if (!payload) return response.status(404).json({ message: "Le mode Sandbox n’est pas activé." });
        response.json({ sandbox: publicSandbox(payload) });
    }));
    app.post("/api/partner-sandbox/actions/:action", asyncHandler(async (request, response) => {
        const action = String(request.params.action || "");
        if (!ACTIONS.has(action)) return response.status(400).json({ message: "Action de simulation inconnue." });
        const ownerId = getAccountOwnerId(request);
        const payload = await loadSession(ownerId);
        if (!payload) return response.status(404).json({ message: "Activez d’abord le mode Sandbox." });
        applyAction(payload, action, request.body || {}, request.user);
        await saveSession(ownerId, request.user.sub, payload);
        response.json({ sandbox: publicSandbox(payload) });
    }));
    app.delete("/api/partner-sandbox", asyncHandler(async (request, response) => {
        await getPool().query("DELETE FROM depannhome_partner_sandbox_sessions WHERE owner_id=$1", [getAccountOwnerId(request)]);
        response.status(204).end();
    }));
}

function createSandboxPayload(user) {
    const now = new Date();
    const today = dateAt(now, 9, 0);
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const appointment = dateAt(tomorrow, 14, 0);
    const mission = createMission({ today, appointment, sequence: 1 });
    const payload = {
        version: 1,
        partner: { ...DEMO_PARTNER, banner: "Environnement de démonstration — aucune donnée réelle ni communication Internet." },
        connection: { status: "available", connectorActive: false, updatedAt: now.toISOString() },
        technicians: TECHNICIANS,
        activeMissionId: mission.id,
        missions: [mission],
        apiLog: [],
        createdFor: user?.fullName || user?.username || "Administrateur",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
    };
    appendApi(payload, "POST", "/simulated-api/missions", "201 Created", "Mission de démonstration créée localement.", today);
    return payload;
}

function createMission({ today = new Date(), appointment, sequence = 1 }) {
    const missionId = `ATD-${String(new Date().getFullYear())}-${String(sequence).padStart(4, "0")}`;
    const createdAt = new Date(today);
    const scheduledAt = appointment || addMinutes(createdAt, 24 * 60 + 5 * 60);
    const mission = {
        id: crypto.randomUUID(),
        externalMissionId: missionId,
        partnerReference: `SIN-${new Date().getFullYear()}-${String(sequence).padStart(5, "0")}`,
        status: "accepted",
        priority: "normal",
        client: { name: "Jean Martin", address: "15 rue des Acacias", phone: "06 XX XX XX XX", email: "jean.martin@example.test" },
        intervention: "Recherche de fuite après dégât des eaux.",
        receivedAt: createdAt.toISOString(),
        appointmentAt: scheduledAt.toISOString(),
        technician: "Technicien Démo",
        timeline: [],
        messages: [],
        documents: [],
        updatedAt: addMinutes(createdAt, 8).toISOString()
    };
    appendTimeline(mission, createdAt, "partner", "Mission envoyée par AssurTest Démo.", "mission_sent");
    appendTimeline(mission, addMinutes(createdAt, 1), "system", "Mission reçue.", "mission_received");
    appendTimeline(mission, addMinutes(createdAt, 2), "system", "Client Jean Martin créé dans l’environnement Sandbox.", "client_created");
    appendTimeline(mission, addMinutes(createdAt, 3), "system", "Intervention créée.", "intervention_created");
    appendTimeline(mission, addMinutes(createdAt, 5), "internal", "Technicien Démo affecté.", "technician_assigned");
    appendTimeline(mission, addMinutes(createdAt, 6), "system", `Rendez-vous planifié le ${formatDateTime(scheduledAt)}.`, "appointment_scheduled");
    appendTimeline(mission, addMinutes(createdAt, 8), "system", "Notification envoyée au technicien.", "technician_notified");
    appendMessage(mission, addMinutes(createdAt, 1), "partner", "AssurTest Démo", "Bonjour, merci d'intervenir rapidement sur ce dossier.", true);
    appendMessage(mission, addMinutes(createdAt, 2), "partner", "AssurTest Démo", "Le client est disponible à partir de 14h.", true);
    appendMessage(mission, addMinutes(createdAt, 3), "partner", "AssurTest Démo", "Merci de transmettre votre rapport dès la fin de l'intervention.", true);
    appendMessage(mission, addMinutes(createdAt, 4), "internal", "Équipe Depann’Home Pro", "Prévoir une caméra thermique.", false);
    appendMessage(mission, addMinutes(createdAt, 5), "internal", "Équipe Depann’Home Pro", "Le client possède un vide sanitaire.", false);
    appendMessage(mission, addMinutes(createdAt, 6), "internal", "Équipe Depann’Home Pro", "Attention au chien dans le jardin.", false);
    addDocument(mission, addMinutes(createdAt, 7), "quote", "Devis de démonstration", "DEV-DEMO-001", "pending");
    addDocument(mission, addMinutes(createdAt, 8), "report", "Rapport de démonstration", "RAP-DEMO-001", "completed");
    addDocument(mission, addMinutes(createdAt, 8), "photo", "Photo fictive — salle de bains", "PHOTO-DEMO-001", "available");
    addDocument(mission, addMinutes(createdAt, 8), "photo", "Photo fictive — compteur d’eau", "PHOTO-DEMO-002", "available");
    addDocument(mission, addMinutes(createdAt, 8), "photo", "Photo fictive — vide sanitaire", "PHOTO-DEMO-003", "available");
    addDocument(mission, addMinutes(createdAt, 8), "invoice", "Facture de démonstration", "FAC-DEMO-001", "draft");
    return mission;
}

function applyAction(payload, action, input, user) {
    const mission = currentMission(payload);
    const now = new Date();
    const actor = user?.fullName || user?.username || "Administrateur Sandbox";
    if (action === "new_mission") {
        const next = createMission({ today: now, appointment: addMinutes(now, 24 * 60 + 5 * 60), sequence: payload.missions.length + 1 });
        payload.missions.unshift(next);
        payload.activeMissionId = next.id;
        appendApi(payload, "POST", "/simulated-api/missions", "201 Created", "Nouvelle mission générée par le connecteur simulé.", now);
    } else if (action === "accept") {
        mission.status = "accepted";
        appendTimeline(mission, now, "internal", "Mission acceptée par l’administration.", "mission_accepted", actor);
        appendApi(payload, "POST", `/simulated-api/missions/${mission.externalMissionId}/accept`, "200 OK", "Accusé d’acceptation simulé.", now);
    } else if (action === "reject") {
        mission.status = "rejected";
        appendTimeline(mission, now, "internal", "Mission refusée avec retour simulé au partenaire.", "mission_rejected", actor);
        appendApi(payload, "POST", `/simulated-api/missions/${mission.externalMissionId}/reject`, "200 OK", "Refus simulé transmis localement.", now);
    } else if (action === "reschedule") {
        const when = validDateTime(input.appointmentAt) || addMinutes(new Date(mission.appointmentAt), 60);
        mission.appointmentAt = when.toISOString();
        mission.status = "scheduled";
        appendTimeline(mission, now, "internal", `Rendez-vous modifié : ${formatDateTime(when)}.`, "appointment_updated", actor);
        appendApi(payload, "PATCH", `/simulated-api/missions/${mission.externalMissionId}`, "200 OK", "Modification de rendez-vous simulée.", now);
    } else if (action === "reassign") {
        mission.technician = TECHNICIANS.includes(input.technician) ? input.technician : nextTechnician(mission.technician);
        mission.status = "assigned";
        appendTimeline(mission, now, "internal", `${mission.technician} affecté à la mission.`, "technician_assigned", actor);
        appendTimeline(mission, addMinutes(now, 1), "system", `Notification envoyée à ${mission.technician}.`, "technician_notified");
    } else if (action === "partner_message") {
        const body = clean(input.body, 4000) || "Le partenaire confirme que le client sera présent au rendez-vous.";
        appendMessage(mission, now, "partner", "AssurTest Démo", body, true);
        appendTimeline(mission, now, "partner", "Nouveau message reçu du partenaire.", "partner_message");
        appendApi(payload, "POST", `/simulated-api/missions/${mission.externalMissionId}/messages`, "201 Created", "Message partenaire simulé.", now);
    } else if (action === "internal_message") {
        const body = clean(input.body, 4000) || "Information interne ajoutée par l’équipe de démonstration.";
        appendMessage(mission, now, "internal", actor, body, false);
        appendTimeline(mission, now, "internal", "Nouveau message interne ajouté.", "internal_message", actor);
    } else if (action === "toggle_visibility") {
        const message = mission.messages.find(item => item.id === String(input.messageId));
        if (!message || message.senderType !== "internal") throw clientError(404, "Message interne introuvable.");
        message.partnerVisible = !message.partnerVisible;
        appendTimeline(mission, now, "internal", `Visibilité partenaire ${message.partnerVisible ? "activée" : "désactivée"} pour un message interne.`, "message_visibility_changed", actor);
        appendApi(payload, "PATCH", `/simulated-api/missions/${mission.externalMissionId}/messages/${message.id}`, "200 OK", `Visibilité partenaire ${message.partnerVisible ? "activée" : "désactivée"} localement.`, now);
    } else if (action === "create_quote") {
        addDocument(mission, now, "quote", "Devis de démonstration généré", `DEV-DEMO-${String(mission.documents.filter(item => item.type === "quote").length + 1).padStart(3, "0")}`, "pending");
    } else if (action === "accept_quote" || action === "reject_quote") {
        const quote = latestDocument(mission, "quote");
        if (!quote) throw clientError(409, "Aucun devis de démonstration à traiter.");
        quote.status = action === "accept_quote" ? "accepted" : "rejected";
        appendTimeline(mission, now, "partner", `Devis ${action === "accept_quote" ? "accepté" : "refusé"} par AssurTest Démo.`, `quote_${quote.status}`);
        appendApi(payload, "POST", `/simulated-api/missions/${mission.externalMissionId}/quotes/${quote.reference}/${quote.status}`, "200 OK", `Réponse devis simulée : ${quote.status}.`, now);
    } else if (action === "complete_report") {
        mission.status = "report_completed";
        addDocument(mission, now, "report", "Rapport terminé de démonstration", `RAP-DEMO-${String(mission.documents.filter(item => item.type === "report").length + 1).padStart(3, "0")}`, "completed");
    } else if (action === "add_photos") {
        for (const label of ["Trace d’humidité", "Contrôle caméra thermique", "Zone technique"]) addDocument(mission, now, "photo", `Photo fictive — ${label}`, `PHOTO-DEMO-${String(mission.documents.filter(item => item.type === "photo").length + 1).padStart(3, "0")}`, "available");
    } else if (action === "create_invoice") {
        addDocument(mission, now, "invoice", "Facture de démonstration générée", `FAC-DEMO-${String(mission.documents.filter(item => item.type === "invoice").length + 1).padStart(3, "0")}`, "issued");
        mission.status = "invoice_sent";
    } else if (action === "close" || action === "cancel") {
        mission.status = action === "close" ? "closed" : "cancelled";
        appendTimeline(mission, now, "internal", action === "close" ? "Mission clôturée." : "Mission annulée.", `mission_${mission.status}`, actor);
        appendApi(payload, "POST", `/simulated-api/missions/${mission.externalMissionId}/${mission.status}`, "200 OK", `${action === "close" ? "Clôture" : "Annulation"} simulée.`, now);
    } else if (action === "request_information") {
        appendMessage(mission, now, "partner", "AssurTest Démo", "Pouvez-vous confirmer la présence du client et préciser l’accès au vide sanitaire ?", true);
        appendTimeline(mission, now, "partner", "Demande d’informations complémentaires reçue.", "information_requested");
        appendApi(payload, "POST", `/simulated-api/missions/${mission.externalMissionId}/information-request`, "201 Created", "Demande d’informations complémentaires simulée.", now);
    }
    mission.updatedAt = now.toISOString();
    payload.updatedAt = now.toISOString();
}

function addDocument(mission, when, type, title, reference, status) {
    const document = { id: crypto.randomUUID(), type, title, reference, status, createdAt: new Date(when).toISOString(), preview: type === "photo" ? photoPreview(title) : "" };
    mission.documents.push(document);
    appendTimeline(mission, when, "system", `${title} ajouté au dossier.`, `${type}_created`, "Depann’Home Pro", document.id);
    return document;
}

function appendTimeline(mission, when, source, label, eventType, actorName = "AssurTest Démo", documentId = "") {
    mission.timeline.push({ id: crypto.randomUUID(), occurredAt: new Date(when).toISOString(), source, label, eventType, actorName, documentId });
    mission.timeline.sort((first, second) => new Date(first.occurredAt) - new Date(second.occurredAt));
}

function appendMessage(mission, when, senderType, senderName, body, partnerVisible) {
    mission.messages.push({ id: crypto.randomUUID(), senderType, senderName, body, partnerVisible, createdAt: new Date(when).toISOString() });
}

function appendApi(payload, method, endpoint, status, detail, when = new Date()) {
    payload.apiLog.unshift({ id: crypto.randomUUID(), method, endpoint, status, detail, createdAt: new Date(when).toISOString() });
    payload.apiLog = payload.apiLog.slice(0, 80);
}

function currentMission(payload) {
    const mission = payload.missions.find(item => item.id === payload.activeMissionId) || payload.missions[0];
    if (!mission) throw clientError(409, "Aucune mission de démonstration n’est disponible.");
    return mission;
}

async function loadSession(ownerId) {
    const { rows } = await getPool().query("SELECT payload FROM depannhome_partner_sandbox_sessions WHERE owner_id=$1", [ownerId]);
    return rows[0]?.payload || null;
}

async function ensureSandboxPayload(ownerId, user) {
    const existing = await loadSession(ownerId);
    if (existing) return existing;
    const payload = createSandboxPayload(user);
    await saveSession(ownerId, user?.sub || user?.id, payload);
    return payload;
}

async function saveSession(ownerId, userId, payload) {
    await getPool().query(`
        INSERT INTO depannhome_partner_sandbox_sessions(owner_id,payload,created_by)
        VALUES($1,$2::jsonb,$3)
        ON CONFLICT(owner_id) DO UPDATE SET payload=EXCLUDED.payload, updated_at=NOW()
    `, [ownerId, JSON.stringify(payload), userId || null]);
}

function publicSandbox(payload) {
    return payload;
}

function connectionScenario(payload) {
    const connection = payload?.connection || { status: "available", connectorActive: false, updatedAt: null };
    return { partner: DEMO_PARTNER, connection: { ...connection, isSandbox: true, id: "assurtest-demo", isRequester: true, lastSynchronizedAt: payload?.updatedAt || null } };
}

function requireSandboxAdministration(request, response, next) {
    if (request.user?.role === "admin" && String(request.user.accountOwnerId || request.user.sub) === String(request.user.sub)) return next();
    return response.status(403).json({ message: "Le mode Sandbox est réservé à l’administrateur principal du compte." });
}

function requireSandboxEnabled(_request, response, next) {
    if (isPartnerSandboxEnabled()) return next();
    return response.status(404).json({ message: "Environnement de démonstration indisponible." });
}

function dateAt(date, hour, minute) { const value = new Date(date); value.setHours(hour, minute, 0, 0); return value; }
function addMinutes(date, minutes) { return new Date(new Date(date).getTime() + minutes * 60000); }
function validDateTime(value) { const date = new Date(value || ""); return Number.isNaN(date.getTime()) ? null : date; }
function nextTechnician(current) { const index = TECHNICIANS.indexOf(current); return TECHNICIANS[(index + 1 + TECHNICIANS.length) % TECHNICIANS.length]; }
function latestDocument(mission, type) { return [...mission.documents].reverse().find(item => item.type === type); }
function clean(value, maximum) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximum); }
function formatDateTime(value) { return new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)); }
function photoPreview(title) { return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="360"><rect width="100%" height="100%" fill="#dbeafe"/><path d="M0 280L170 140l100 90 80-70 250 120v80H0z" fill="#60a5fa"/><circle cx="440" cy="90" r="42" fill="#fbbf24"/><text x="32" y="330" font-family="Arial" font-size="24" fill="#0f172a">${title}</text></svg>`)}`; }
function clientError(status, message) { const error = new Error(message); error.status = status; return error; }
function asyncHandler(handler) { return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(error => error.status ? response.status(error.status).json({ message: error.message }) : next(error)); }
