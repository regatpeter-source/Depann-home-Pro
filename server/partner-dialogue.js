import crypto from "node:crypto";
import multer from "multer";
import path from "node:path";
import { getPool } from "./database.js";
import { getAccountOwnerId } from "./auth.js";
import { broadcastOwnerEvent, createNotification } from "./collaboration.js";

const MAX_MESSAGE_LENGTH = 4000;
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MESSAGE_KINDS = new Set(["message", "issue", "system"]);
const ISSUE_TYPES = new Set(["client_absent", "access_impossible", "information_missing", "material_unavailable", "awaiting_authorization", "rescheduled", "information_requested", "other"]);
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ATTACHMENT_BYTES, files: MAX_ATTACHMENTS }, fileFilter: (request, file, callback) => callback(null, ALLOWED_MIME_TYPES.has(file.mimetype)) });

export async function initializePartnerDialogue() {
    const db = getPool();
    await db.query(`CREATE TABLE IF NOT EXISTS depannhome_partner_dialogue_messages (
        id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
        mission_id BIGINT NOT NULL REFERENCES depannhome_partner_missions(id) ON DELETE CASCADE,
        sender_type VARCHAR(20) NOT NULL, sender_user_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
        sender_name VARCHAR(160) NOT NULL DEFAULT '', organization_name VARCHAR(160) NOT NULL DEFAULT '',
        kind VARCHAR(20) NOT NULL DEFAULT 'message', issue_type VARCHAR(60) NOT NULL DEFAULT '',
        body VARCHAR(${MAX_MESSAGE_LENGTH}) NOT NULL DEFAULT '', reply_to_id BIGINT REFERENCES depannhome_partner_dialogue_messages(id) ON DELETE SET NULL,
        partner_visible BOOLEAN NOT NULL DEFAULT FALSE, event_type VARCHAR(80) NOT NULL DEFAULT '', immutable BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.query("ALTER TABLE depannhome_partner_dialogue_messages ADD COLUMN IF NOT EXISTS partner_visible BOOLEAN NOT NULL DEFAULT FALSE, ADD COLUMN IF NOT EXISTS event_type VARCHAR(80) NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS immutable BOOLEAN NOT NULL DEFAULT FALSE, ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
    await db.query("UPDATE depannhome_partner_dialogue_messages SET partner_visible=TRUE WHERE sender_type='partner'");
    await db.query("CREATE INDEX IF NOT EXISTS depannhome_partner_dialogue_messages_mission_idx ON depannhome_partner_dialogue_messages(owner_id, mission_id, created_at, id)");
    await db.query(`CREATE TABLE IF NOT EXISTS depannhome_partner_dialogue_attachments (
        id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
        mission_id BIGINT NOT NULL REFERENCES depannhome_partner_missions(id) ON DELETE CASCADE,
        message_id BIGINT NOT NULL REFERENCES depannhome_partner_dialogue_messages(id) ON DELETE CASCADE,
        attachment_type VARCHAR(40) NOT NULL DEFAULT 'document', filename VARCHAR(255) NOT NULL, mime_type VARCHAR(150) NOT NULL,
        file_size INTEGER NOT NULL CHECK(file_size > 0 AND file_size <= ${MAX_ATTACHMENT_BYTES}), file_data BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.query("CREATE INDEX IF NOT EXISTS depannhome_partner_dialogue_attachments_message_idx ON depannhome_partner_dialogue_attachments(message_id)");
    await db.query(`CREATE TABLE IF NOT EXISTS depannhome_partner_dialogue_audit (
        id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
        mission_id BIGINT NOT NULL REFERENCES depannhome_partner_missions(id) ON DELETE CASCADE,
        message_id BIGINT NOT NULL REFERENCES depannhome_partner_dialogue_messages(id) ON DELETE CASCADE,
        action VARCHAR(60) NOT NULL, actor_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
        actor_name VARCHAR(160) NOT NULL DEFAULT '', old_value JSONB NOT NULL DEFAULT '{}'::jsonb,
        new_value JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.query("CREATE INDEX IF NOT EXISTS depannhome_partner_dialogue_audit_message_idx ON depannhome_partner_dialogue_audit(owner_id, mission_id, message_id, created_at DESC)");
}

export function registerPartnerDialogueRoutes(app, requireAuthentication) {
    app.get("/api/partner-dialogue/external/missions/:externalMissionId", asyncHandler(externalDialogue));
    app.post("/api/partner-dialogue/external/missions/:externalMissionId/messages", asyncHandler(externalMessage));
    app.get("/api/partner-dialogue/external/missions/:externalMissionId/attachments/:attachmentId", asyncHandler(externalAttachment));
    app.use("/api/partner-dialogue", requireAuthentication, requireDialogueAccess);
    app.get("/api/partner-dialogue/missions/:missionId", asyncHandler(internalDialogue));
    app.post("/api/partner-dialogue/missions/:missionId/messages", upload.array("files", MAX_ATTACHMENTS), asyncHandler(internalMessage));
    app.patch("/api/partner-dialogue/missions/:missionId/entries/:messageId/visibility", asyncHandler(updateEntryVisibility));
    app.get("/api/partner-dialogue/missions/:missionId/attachments/:attachmentId", asyncHandler(internalAttachment));
}

export async function recordMissionDialogueEvent({ ownerId, missionId, status = "", action = "", details = {}, actorName = "", partnerVisible = defaultSystemVisibility(status) }) {
    if (!ownerId || !missionId) return null;
    const mission = await findMissionById(ownerId, missionId);
    if (!mission) return null;
    const body = systemMessage(status, action, details);
    const message = await insertMessage({ ownerId, missionId, senderType: "system", senderName: actorName || "Depann’Home Pro", organizationName: "Depann’Home Pro", kind: "system", body, eventType: status || action, partnerVisible, immutable: true });
    await insertAudit(getPool(), { ownerId, missionId, messageId: message.id, action: "created", actorName: actorName || "Depann’Home Pro", newValue: { partnerVisible, eventType: status || action, immutable: true, details } });
    if (partnerVisible) await queuePartnerEvent(ownerId, missionId, "partner_dialogue_system_event", { messageId: message.id, status, action, body });
    await notifyInternalParticipants(ownerId, mission, null, "Mise à jour du dossier", body, { missionId, dialogueMessageId: message.id, status });
    await broadcastJournalUpdate(ownerId, missionId, message.id, "created");
    return message;
}

export async function recordMissionDialogueDocument({ ownerId, missionId, actorName = "Depann’Home Pro", body, attachment, partnerVisible = false, eventType = "document_shared" }) {
    if (!ownerId || !missionId || !attachment?.buffer?.length) return null;
    const mission = await findMissionById(ownerId, missionId); if (!mission) return null;
    const message = await createMessageWithAttachments({ ownerId, missionId, senderType: "system", senderName: actorName, organizationName: "Depann’Home Pro", kind: "system", body: clean(body, MAX_MESSAGE_LENGTH), partnerVisible, attachments: [attachment] });
    await getPool().query("UPDATE depannhome_partner_dialogue_messages SET event_type=$4,immutable=TRUE,updated_at=NOW() WHERE id=$1 AND owner_id=$2 AND mission_id=$3", [message.id, ownerId, missionId, clean(eventType, 80)]);
    if (partnerVisible) await queuePartnerEvent(ownerId, missionId, "partner_dialogue_document", { messageId: message.id, eventType, attachmentType: attachment.type });
    await notifyInternalParticipants(ownerId, mission, null, "Document ajouté au dossier", body, { missionId, dialogueMessageId: message.id, eventType });
    await broadcastJournalUpdate(ownerId, missionId, message.id, "created");
    return message;
}

export async function recordMissionEventForSource({ ownerId, sourceType, sourceId, status, action, details = {}, actorName = "" }) {
    const column = sourceType === "report" ? "technical_report_id" : sourceType === "appointment" ? "calendar_event_id" : "";
    if (!ownerId || !sourceId || !column) return null;
    const { rows } = await getPool().query(`SELECT id FROM depannhome_partner_missions WHERE owner_id=$1 AND ${column}=$2 ORDER BY id DESC LIMIT 1`, [ownerId, sourceId]);
    return rows[0] ? recordMissionDialogueEvent({ ownerId, missionId: rows[0].id, status, action, details, actorName }) : null;
}

async function internalDialogue(req, res) {
    const mission = await accessibleInternalMission(getAccountOwnerId(req), positiveId(req.params.missionId), req);
    if (!mission) return res.status(404).json({ message: "Dossier introuvable ou non accessible." });
    res.json(await dialoguePayload(mission, false));
}

async function internalMessage(req, res) {
    const ownerId = getAccountOwnerId(req); const mission = await accessibleInternalMission(ownerId, positiveId(req.params.missionId), req);
    if (!mission) return res.status(404).json({ message: "Dossier introuvable ou non accessible." });
    if (mission.status === "closed") return res.status(409).json({ message: "Ce dossier est clôturé : le fil est en lecture seule." });
    const input = messageInput(req.body, req.files); if (!input.ok) return res.status(400).json({ message: input.message });
    const message = await createMessageWithAttachments({ ownerId, missionId: mission.id, senderType: "internal", senderUserId: req.user.sub, senderName: req.user.fullName || req.user.username, organizationName: "Votre entreprise", partnerVisible: Boolean(req.body?.partnerVisible), ...input });
    if (message.partnerVisible) await queuePartnerEvent(ownerId, mission.id, input.kind === "issue" ? "partner_dialogue_issue" : "partner_dialogue_message", { messageId: message.id, kind: input.kind, issueType: input.issueType, body: input.body, attachmentCount: message.attachments.length });
    await notifyInternalParticipants(ownerId, mission, req.user.sub, input.kind === "issue" ? "Problème signalé sur un dossier" : "Nouveau message de dossier", input.body || "Une pièce jointe a été ajoutée.", { missionId: mission.id, dialogueMessageId: message.id, kind: input.kind });
    await broadcastJournalUpdate(ownerId, mission.id, message.id, "created");
    res.status(201).json({ message });
}

async function externalDialogue(req, res) {
    const mission = await externalMission(req);
    if (!mission) return res.status(404).json({ message: "Dossier introuvable." });
    res.json(await dialoguePayload(mission, true));
}

async function externalMessage(req, res) {
    const mission = await externalMission(req);
    if (!mission) return res.status(404).json({ message: "Dossier introuvable." });
    if (mission.status === "closed") return res.status(409).json({ message: "Ce dossier est clôturé : le fil est en lecture seule." });
    const input = externalMessageInput(req.body); if (!input.ok) return res.status(400).json({ message: input.message });
    const message = await createMessageWithAttachments({ ownerId: mission.owner_id, missionId: mission.id, senderType: "partner", senderName: input.authorName || mission.partner_name, organizationName: mission.partner_name, partnerVisible: true, ...input });
    await notifyInternalParticipants(mission.owner_id, mission, null, input.kind === "issue" ? "Problème signalé par le partenaire" : "Nouveau message partenaire", input.body || "Une pièce jointe a été ajoutée.", { missionId: mission.id, dialogueMessageId: message.id, kind: input.kind });
    await queuePartnerEvent(mission.owner_id, mission.id, "partner_dialogue_message", { messageId: message.id, kind: input.kind, body: input.body, attachmentCount: message.attachments.length });
    await broadcastJournalUpdate(mission.owner_id, mission.id, message.id, "created");
    res.status(201).json({ message: externalPublicMessage(message, mission.external_mission_id) });
}

async function internalAttachment(req, res) {
    const mission = await accessibleInternalMission(getAccountOwnerId(req), positiveId(req.params.missionId), req);
    if (!mission) return res.status(404).json({ message: "Dossier introuvable ou non accessible." });
    return sendAttachment(res, mission.owner_id, mission.id, positiveId(req.params.attachmentId));
}
async function externalAttachment(req, res) {
    const mission = await externalMission(req);
    if (!mission) return res.status(404).json({ message: "Dossier introuvable." });
    return sendAttachment(res, mission.owner_id, mission.id, positiveId(req.params.attachmentId), true);
}

async function updateEntryVisibility(req, res) {
    const ownerId = getAccountOwnerId(req); const mission = await accessibleInternalMission(ownerId, positiveId(req.params.missionId), req);
    const messageId = positiveId(req.params.messageId);
    if (!mission || !messageId) return res.status(404).json({ message: "Entrée introuvable ou non accessible." });
    if (typeof req.body?.partnerVisible !== "boolean") return res.status(400).json({ message: "Visibilité partenaire invalide." });
    const { rows } = await getPool().query("SELECT id,partner_visible,immutable FROM depannhome_partner_dialogue_messages WHERE id=$1 AND owner_id=$2 AND mission_id=$3", [messageId, ownerId, mission.id]);
    const entry = rows[0]; if (!entry) return res.status(404).json({ message: "Entrée introuvable." });
    const visible = req.body.partnerVisible;
    await getPool().query("UPDATE depannhome_partner_dialogue_messages SET partner_visible=$4,updated_at=NOW() WHERE id=$1 AND owner_id=$2 AND mission_id=$3", [messageId, ownerId, mission.id, visible]);
    await insertAudit(getPool(), { ownerId, missionId: mission.id, messageId, action: "visibility_changed", actorId: req.user.sub, actorName: req.user.fullName || req.user.username, oldValue: { partnerVisible: entry.partner_visible }, newValue: { partnerVisible: visible } });
    await queuePartnerEvent(ownerId, mission.id, "partner_dialogue_visibility_changed", { messageId, partnerVisible: visible });
    await broadcastJournalUpdate(ownerId, mission.id, messageId, "visibility_changed");
    res.status(204).end();
}

async function dialoguePayload(mission, external) {
    const [messages, documents] = await Promise.all([loadMessages(mission, external), linkedDocuments(mission.owner_id, mission)]);
    return { mission: publicMissionSummary(mission), messages, linkedDocuments: documents, readOnly: mission.status === "closed", filters: ["all", "events", "messages", "documents", "photos", "quote", "report", "invoice", "internal", "partner_visible"] };
}
async function loadMessages(mission, external) {
    const { rows } = await getPool().query(`SELECT message.id, message.sender_type AS "senderType", message.sender_name AS "senderName", message.organization_name AS "organizationName", message.kind, message.issue_type AS "issueType", message.body, message.reply_to_id AS "replyToId", message.partner_visible AS "partnerVisible", message.event_type AS "eventType", message.immutable, message.created_at AS "createdAt", message.updated_at AS "updatedAt", COALESCE((SELECT json_agg(json_build_object('id', attachment.id, 'filename', attachment.filename, 'mimeType', attachment.mime_type, 'fileSize', attachment.file_size, 'attachmentType', attachment.attachment_type) ORDER BY attachment.id) FROM depannhome_partner_dialogue_attachments attachment WHERE attachment.message_id=message.id), '[]'::json) AS attachments FROM depannhome_partner_dialogue_messages message WHERE message.owner_id=$1 AND message.mission_id=$2 AND ($3=FALSE OR message.partner_visible=TRUE) ORDER BY message.created_at ASC, message.id ASC LIMIT 1000`, [mission.owner_id, mission.id, external]);
    return rows.map(message => ({ ...message, attachments: (message.attachments || []).map(attachment => ({ ...attachment, url: external ? `/api/partner-dialogue/external/missions/${encodeURIComponent(mission.external_mission_id)}/attachments/${attachment.id}` : `/api/partner-dialogue/missions/${mission.id}/attachments/${attachment.id}` })) }));
}
async function linkedDocuments(ownerId, mission) {
    const { rows } = await getPool().query(`SELECT id, document_type AS "documentType", document_number AS "documentNumber", status, TO_CHAR(issue_date,'YYYY-MM-DD') AS "issueDate" FROM depannhome_billing_documents WHERE owner_id=$1 AND (appointment_id=$2 OR (client_id<>'' AND client_id=$3)) ORDER BY issue_date DESC, id DESC LIMIT 50`, [ownerId, mission.calendar_event_id || 0, mission.client_id || ""]);
    return rows;
}
async function createMessageWithAttachments({ ownerId, missionId, senderType, senderUserId = null, senderName, organizationName, kind, issueType = "", body, replyToId = 0, partnerVisible = false, attachments = [] }) {
    const connection = await getPool().connect();
    try { await connection.query("BEGIN"); const message = await insertMessage({ ownerId, missionId, senderType, senderUserId, senderName, organizationName, kind, issueType, body, replyToId, partnerVisible }, connection); const saved = []; for (const attachment of attachments) { const { rows } = await connection.query("INSERT INTO depannhome_partner_dialogue_attachments(owner_id,mission_id,message_id,attachment_type,filename,mime_type,file_size,file_data) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,filename,mime_type AS \"mimeType\",file_size AS \"fileSize\",attachment_type AS \"attachmentType\"", [ownerId, missionId, message.id, attachment.type, attachment.filename, attachment.mimeType, attachment.buffer.length, attachment.buffer]); saved.push(rows[0]); } await insertAudit(connection, { ownerId, missionId, messageId: message.id, action: "created", actorId: senderUserId, actorName: senderName, newValue: { partnerVisible, kind, attachmentCount: saved.length } }); await connection.query("COMMIT"); return { ...message, attachments: saved }; } catch (error) { await connection.query("ROLLBACK"); throw error; } finally { connection.release(); }
}
async function insertMessage({ ownerId, missionId, senderType, senderUserId = null, senderName = "", organizationName = "", kind = "message", issueType = "", body = "", replyToId = 0, partnerVisible = false, eventType = "", immutable = false }, connection = getPool()) { const { rows } = await connection.query("INSERT INTO depannhome_partner_dialogue_messages(owner_id,mission_id,sender_type,sender_user_id,sender_name,organization_name,kind,issue_type,body,reply_to_id,partner_visible,event_type,immutable) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id,sender_type AS \"senderType\",sender_name AS \"senderName\",organization_name AS \"organizationName\",kind,issue_type AS \"issueType\",body,reply_to_id AS \"replyToId\",partner_visible AS \"partnerVisible\",event_type AS \"eventType\",immutable,created_at AS \"createdAt\"", [ownerId, missionId, senderType, senderUserId || null, clean(senderName, 160), clean(organizationName, 160), kind, issueType, body, replyToId || null, Boolean(partnerVisible), clean(eventType, 80), Boolean(immutable)]); return rows[0]; }
async function accessibleInternalMission(ownerId, id, req) { if (!id) return null; const technicianId = req.user.role === "technician" ? req.user.sub : null; const { rows } = await getPool().query(`SELECT mission.*, intake.partner_name, COALESCE(technician.full_name, technician.username, '') AS technician_name, event.client_name, event.location, TO_CHAR(event.event_date,'YYYY-MM-DD') AS event_date, TO_CHAR(event.start_time,'HH24:MI') AS start_time FROM depannhome_partner_missions mission JOIN depannhome_partner_intakes intake ON intake.id=mission.intake_id LEFT JOIN depannhome_users technician ON technician.id=mission.assigned_technician_id LEFT JOIN depannhome_calendar_events event ON event.id=mission.calendar_event_id AND event.owner_id=mission.owner_id WHERE mission.id=$1 AND mission.owner_id=$2 AND ($3::bigint IS NULL OR mission.assigned_technician_id=$3)`, [id, ownerId, technicianId]); return rows[0] || null; }
async function findMissionById(ownerId, id) { const { rows } = await getPool().query(`SELECT mission.*, intake.partner_name, COALESCE(technician.full_name, technician.username, '') AS technician_name, event.client_name, event.location, TO_CHAR(event.event_date,'YYYY-MM-DD') AS event_date, TO_CHAR(event.start_time,'HH24:MI') AS start_time FROM depannhome_partner_missions mission JOIN depannhome_partner_intakes intake ON intake.id=mission.intake_id LEFT JOIN depannhome_users technician ON technician.id=mission.assigned_technician_id LEFT JOIN depannhome_calendar_events event ON event.id=mission.calendar_event_id AND event.owner_id=mission.owner_id WHERE mission.id=$1 AND mission.owner_id=$2`, [id, ownerId]); return rows[0] || null; }
async function externalMission(req) { const key = clean(req.get("X-API-Key"), 300); const externalId = clean(req.params.externalMissionId, 160); if (!key || !externalId) return null; const { rows } = await getPool().query(`SELECT mission.*, intake.partner_name, intake.api_key_hash, COALESCE(technician.full_name, technician.username, '') AS technician_name, event.client_name, event.location, TO_CHAR(event.event_date,'YYYY-MM-DD') AS event_date, TO_CHAR(event.start_time,'HH24:MI') AS start_time FROM depannhome_partner_missions mission JOIN depannhome_partner_intakes intake ON intake.id=mission.intake_id LEFT JOIN depannhome_users technician ON technician.id=mission.assigned_technician_id LEFT JOIN depannhome_calendar_events event ON event.id=mission.calendar_event_id AND event.owner_id=mission.owner_id WHERE mission.external_mission_id=$1 AND intake.enabled=TRUE`, [externalId]); const mission = rows.find(row => safeEqual(hash(key), row.api_key_hash)); return mission || null; }
async function sendAttachment(res, ownerId, missionId, attachmentId, partnerOnly = false) { if (!attachmentId) return res.status(404).json({ message: "Pièce jointe introuvable." }); const { rows } = await getPool().query("SELECT attachment.filename,attachment.mime_type,attachment.file_data FROM depannhome_partner_dialogue_attachments attachment JOIN depannhome_partner_dialogue_messages message ON message.id=attachment.message_id WHERE attachment.id=$1 AND attachment.owner_id=$2 AND attachment.mission_id=$3 AND ($4=FALSE OR message.partner_visible=TRUE)", [attachmentId, ownerId, missionId, partnerOnly]); const attachment = rows[0]; if (!attachment) return res.status(404).json({ message: "Pièce jointe introuvable." }); res.set({ "Content-Type": attachment.mime_type, "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" }); return res.send(attachment.file_data); }
async function notifyInternalParticipants(ownerId, mission, senderUserId, title, body, payload) { const { rows } = await getPool().query("SELECT id FROM depannhome_users WHERE account_owner_id=$1 AND is_active=TRUE AND (role='admin' OR id=$2)", [ownerId, mission.assigned_technician_id || 0]); await Promise.all(rows.filter(row => String(row.id) !== String(senderUserId || "")).map(row => createNotification(ownerId, row.id, "partner_dialogue_updated", { entityType: "partner_mission", entityId: String(mission.id) }, title, clean(body, 2000), payload))); }
async function queuePartnerEvent(ownerId, missionId, eventType, payload) { await getPool().query("INSERT INTO depannhome_partner_mission_outbox(owner_id,mission_id,event_type,payload) VALUES($1,$2,$3,$4::jsonb)", [ownerId, missionId, eventType, JSON.stringify(payload)]); }
function messageInput(body, files) { const kind = MESSAGE_KINDS.has(body?.kind) && body.kind !== "system" ? body.kind : "message"; const issueType = kind === "issue" && ISSUE_TYPES.has(body?.issueType) ? body.issueType : kind === "issue" ? "other" : ""; const text = clean(body?.body, MAX_MESSAGE_LENGTH); const attachments = (Array.isArray(files) ? files : []).map(file => ({ filename: safeFilename(file.originalname), mimeType: file.mimetype, buffer: file.buffer, type: attachmentType(body?.attachmentType, file.mimetype) })); return text || attachments.length ? { ok: true, kind, issueType, body: text, replyToId: positiveId(body?.replyToId), attachments } : { ok: false, message: "Saisissez un message ou joignez un fichier." }; }
function externalMessageInput(value) { const kind = MESSAGE_KINDS.has(value?.kind) && value.kind !== "system" ? value.kind : "message"; const issueType = kind === "issue" && ISSUE_TYPES.has(value?.issueType) ? value.issueType : kind === "issue" ? "other" : ""; const attachments = []; for (const item of Array.isArray(value?.attachments) ? value.attachments.slice(0, MAX_ATTACHMENTS) : []) { const parsed = dataUrlAttachment(item); if (!parsed) return { ok: false, message: "Une pièce jointe partenaire est invalide." }; attachments.push(parsed); } const body = clean(value?.body, MAX_MESSAGE_LENGTH); return body || attachments.length ? { ok: true, kind, issueType, body, authorName: clean(value?.authorName, 160), replyToId: positiveId(value?.replyToId), attachments } : { ok: false, message: "Saisissez un message ou joignez un fichier." }; }
function dataUrlAttachment(item) { const match = /^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(String(item?.dataUrl || "")); if (!match) return null; const buffer = Buffer.from(match[2], "base64"); if (!buffer.length || buffer.length > MAX_ATTACHMENT_BYTES || !ALLOWED_MIME_TYPES.has(match[1])) return null; return { filename: safeFilename(item?.filename || item?.name || "document-partenaire"), mimeType: match[1], buffer, type: attachmentType(item?.attachmentType, match[1]) }; }
function publicMissionSummary(mission) { const data = mission.mapped_data || {}; return { id: mission.id, externalMissionId: mission.external_mission_id, interventionId: mission.calendar_event_id || null, clientId: mission.client_id || "", clientName: mission.client_name || data.clientName || "", address: mission.location || data.address || "", interventionType: data.interventionType || "Intervention", technicianName: mission.technician_name || "Non affecté", status: mission.status, scheduledDate: mission.event_date || mission.scheduled_date || null, scheduledStartTime: mission.start_time || mission.scheduled_start_time || null, technicalReportId: mission.technical_report_id || null, partnerName: mission.partner_name }; }
function systemMessage(status, action, details) { const labels = { received: "Mission reçue.", pending_validation: "Mission en attente de validation.", accepted: "Mission acceptée.", assigned: "Technicien affecté.", scheduled: "Rendez-vous planifié.", en_route: "Technicien en route.", on_site: "Technicien arrivé sur site.", report_in_progress: "Rapport en cours.", report_completed: "Rapport terminé.", report_validated: "Rapport validé.", quote_created: "Devis créé.", quote_sent: "Devis envoyé.", quote_accepted: "Devis accepté.", work_completed: "Travaux terminés.", invoice_created: "Facture créée.", invoice_sent: "Facture envoyée.", rejected: "Mission refusée.", cancelled: "Mission annulée.", closed: "Mission clôturée : le fil est désormais en lecture seule." }; return labels[status] || (action === "updated" ? "Informations du dossier mises à jour." : "Dossier mis à jour."); }
function defaultSystemVisibility() { return false; }
async function insertAudit(connection, { ownerId, missionId, messageId, action, actorId = null, actorName = "", oldValue = {}, newValue = {} }) { await connection.query("INSERT INTO depannhome_partner_dialogue_audit(owner_id,mission_id,message_id,action,actor_id,actor_name,old_value,new_value) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)", [ownerId, missionId, messageId, action, actorId || null, clean(actorName, 160), JSON.stringify(oldValue), JSON.stringify(newValue)]); }
async function broadcastJournalUpdate(ownerId, missionId, messageId, action) { await broadcastOwnerEvent(ownerId, "mission_journal_updated", { entityType: "partner_mission", entityId: String(missionId), missionId, messageId, action }); }
function requireDialogueAccess(req, res, next) { if (["admin", "technician"].includes(req.user?.role)) return next(); return res.status(403).json({ message: "Le dialogue partenaire n’est pas accessible." }); }
function attachmentType(value, mimeType) { const permitted = new Set(["photo", "document", "quote", "report", "invoice"]); if (permitted.has(value)) return value; return mimeType.startsWith("image/") ? "photo" : "document"; }
function safeFilename(value) { return path.basename(String(value || "document")).replace(/[\r\n]/g, " ").slice(0, 255) || "document"; }
function clean(value, max) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, max); }
function positiveId(value) { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : 0; }
function hash(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function safeEqual(a, b) { const first = Buffer.from(String(a)), second = Buffer.from(String(b)); return first.length === second.length && crypto.timingSafeEqual(first, second); }
export function partnerDialogueUploadErrorHandler(error, req, res, next) { if (error instanceof multer.MulterError) return res.status(400).json({ message: error.code === "LIMIT_FILE_SIZE" ? "Chaque pièce jointe est limitée à 5 Mo." : "Ajout de pièce jointe impossible." }); return next(error); }
function externalPublicMessage(message, externalMissionId) { return { ...message, attachments: message.attachments.map(attachment => ({ ...attachment, url: `/api/partner-dialogue/external/missions/${encodeURIComponent(externalMissionId)}/attachments/${attachment.id}` })) }; }
function asyncHandler(handler) { return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next); }
