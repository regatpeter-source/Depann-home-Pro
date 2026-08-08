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
const PARTNER_MANAGEMENT_ROLES = new Set(["admin", "pc_standard", "mobile_admin"]);
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
    await db.query(`UPDATE depannhome_partner_dialogue_messages message
        SET organization_name=COALESCE(NULLIF(profile.company_name,''),NULLIF(owner.company_name,''),NULLIF(owner.full_name,''),owner.username)
        FROM depannhome_users owner
        LEFT JOIN depannhome_billing_profiles profile ON profile.owner_id=owner.id
        WHERE message.owner_id=owner.id AND message.sender_type='internal'
            AND message.organization_name IN ('','Votre entreprise')`);
    await db.query("CREATE INDEX IF NOT EXISTS depannhome_partner_dialogue_messages_mission_idx ON depannhome_partner_dialogue_messages(owner_id, mission_id, created_at, id)");
    await db.query(`CREATE TABLE IF NOT EXISTS depannhome_partner_dialogue_attachments (
        id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
        mission_id BIGINT NOT NULL REFERENCES depannhome_partner_missions(id) ON DELETE CASCADE,
        message_id BIGINT NOT NULL REFERENCES depannhome_partner_dialogue_messages(id) ON DELETE CASCADE,
        attachment_type VARCHAR(40) NOT NULL DEFAULT 'document', filename VARCHAR(255) NOT NULL, mime_type VARCHAR(150) NOT NULL,
        file_size INTEGER NOT NULL CHECK(file_size > 0 AND file_size <= ${MAX_ATTACHMENT_BYTES}), file_data BYTEA NOT NULL, partner_visible BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.query("ALTER TABLE depannhome_partner_dialogue_attachments ADD COLUMN IF NOT EXISTS partner_visible BOOLEAN NOT NULL DEFAULT FALSE");
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
    await db.query(`CREATE TABLE IF NOT EXISTS depannhome_partner_mission_items (
        id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
        mission_id BIGINT NOT NULL REFERENCES depannhome_partner_missions(id) ON DELETE CASCADE,
        source_type VARCHAR(30) NOT NULL, source_id VARCHAR(120) NOT NULL, source_item_id VARCHAR(120) NOT NULL DEFAULT '',
        label VARCHAR(255) NOT NULL DEFAULT '', details JSONB NOT NULL DEFAULT '{}'::jsonb,
        partner_visible BOOLEAN NOT NULL DEFAULT FALSE, dialogue_message_id BIGINT REFERENCES depannhome_partner_dialogue_messages(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT depannhome_partner_mission_items_unique UNIQUE(mission_id, source_type, source_id, source_item_id)
    )`);
    await db.query("CREATE INDEX IF NOT EXISTS depannhome_partner_mission_items_visibility_idx ON depannhome_partner_mission_items(owner_id, mission_id, partner_visible, updated_at DESC)");
    await db.query(`CREATE TABLE IF NOT EXISTS depannhome_partner_mission_item_audit (
        id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
        mission_id BIGINT NOT NULL REFERENCES depannhome_partner_missions(id) ON DELETE CASCADE,
        item_id BIGINT NOT NULL REFERENCES depannhome_partner_mission_items(id) ON DELETE CASCADE,
        action VARCHAR(60) NOT NULL, actor_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
        old_value JSONB NOT NULL DEFAULT '{}'::jsonb, new_value JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.query(`INSERT INTO depannhome_partner_mission_items(owner_id,mission_id,source_type,source_id,label,details)
        SELECT mission.owner_id,mission.id,document.document_type,document.id::text,document.document_number,jsonb_build_object('documentType',document.document_type,'status',document.status)
        FROM depannhome_partner_missions mission JOIN depannhome_billing_documents document ON document.owner_id=mission.owner_id AND document.appointment_id=mission.calendar_event_id
        ON CONFLICT(mission_id,source_type,source_id,source_item_id) DO NOTHING`);
    await db.query(`INSERT INTO depannhome_partner_mission_items(owner_id,mission_id,source_type,source_id,label,details)
        SELECT mission.owner_id,mission.id,'report',report.id::text,report.title,jsonb_build_object('status',report.status)
        FROM depannhome_partner_missions mission JOIN depannhome_technical_reports report ON report.owner_id=mission.owner_id AND report.id=mission.technical_report_id
        ON CONFLICT(mission_id,source_type,source_id,source_item_id) DO NOTHING`);
}

export function registerPartnerDialogueRoutes(app, requireAuthentication) {
    app.get("/api/partner-dialogue/external/missions/:externalMissionId", asyncHandler(externalDialogue));
    app.post("/api/partner-dialogue/external/missions/:externalMissionId/messages", asyncHandler(externalMessage));
    app.get("/api/partner-dialogue/external/missions/:externalMissionId/attachments/:attachmentId", asyncHandler(externalAttachment));
    app.get("/api/partner-dialogue/external/missions/:externalMissionId/items/:itemId/download", asyncHandler(externalSharedItem));
    app.use("/api/partner-dialogue", requireAuthentication, requireDialogueAccess);
    app.get("/api/partner-dialogue/missions/:missionId", asyncHandler(internalDialogue));
    app.post("/api/partner-dialogue/missions/:missionId/messages", upload.array("files", MAX_ATTACHMENTS), asyncHandler(internalMessage));
    app.get("/api/partner-dialogue/sent-missions/:missionId", asyncHandler(sourceDialogue));
    app.post("/api/partner-dialogue/sent-missions/:missionId/messages", upload.array("files", MAX_ATTACHMENTS), asyncHandler(sourceMessage));
    app.patch("/api/partner-dialogue/missions/:missionId/entries/:messageId/visibility", asyncHandler(updateEntryVisibility));
    app.patch("/api/partner-dialogue/missions/:missionId/attachments/:attachmentId/visibility", asyncHandler(updateAttachmentVisibility));
    app.patch("/api/partner-dialogue/missions/:missionId/items/:itemId/visibility", asyncHandler(updateItemVisibility));
    app.get("/api/partner-dialogue/missions/:missionId/items/:itemId/download", asyncHandler(internalSharedItem));
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

export async function registerMissionSourceItem({ ownerId, appointmentId, sourceType, sourceId, sourceItemId = "", label = "", details = {} }) {
    if (!ownerId || !appointmentId || !sourceType || !sourceId) return null;
    const { rows: missions } = await getPool().query("SELECT id,billing_mode FROM depannhome_partner_missions WHERE owner_id=$1 AND calendar_event_id=$2 ORDER BY id DESC LIMIT 1", [ownerId, appointmentId]);
    const mission = missions[0];
    if (!mission) return null;
    const autoShare = ["quote", "invoice"].includes(sourceType) && mission.billing_mode === "principal";
    const { rows } = await getPool().query(`INSERT INTO depannhome_partner_mission_items(owner_id,mission_id,source_type,source_id,label,details,partner_visible)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
        ON CONFLICT(mission_id,source_type,source_id,source_item_id) DO UPDATE SET label=EXCLUDED.label,details=EXCLUDED.details,partner_visible=CASE WHEN EXCLUDED.partner_visible THEN TRUE ELSE depannhome_partner_mission_items.partner_visible END,updated_at=NOW()
        RETURNING *`, [ownerId, mission.id, sourceType, String(sourceId), String(sourceItemId || ""), clean(label, 255), JSON.stringify(details), autoShare]);
    const item = rows[0];
    if (item.partner_visible) await synchronizeItemJournal(item, mission, true);
    return publicMissionItem(item);
}

export async function sharePrincipalBillingDocuments(ownerId, missionId) {
    const { rows } = await getPool().query(`SELECT item.*,mission.billing_mode FROM depannhome_partner_mission_items item JOIN depannhome_partner_missions mission ON mission.id=item.mission_id WHERE item.owner_id=$1 AND item.mission_id=$2 AND item.source_type IN ('quote','invoice')`, [ownerId, missionId]);
    for (const item of rows) {
        if (item.billing_mode !== "principal") continue;
        await getPool().query("UPDATE depannhome_partner_mission_items SET partner_visible=TRUE,updated_at=NOW() WHERE id=$1", [item.id]);
        await synchronizeItemJournal({ ...item, partner_visible: true }, { id: missionId, owner_id: ownerId }, true);
    }
}

export async function hideDirectClientBillingDocuments(ownerId, missionId) {
    const { rows } = await getPool().query("UPDATE depannhome_partner_mission_items SET partner_visible=FALSE,updated_at=NOW() WHERE owner_id=$1 AND mission_id=$2 AND source_type IN ('quote','invoice') AND partner_visible=TRUE RETURNING *", [ownerId, missionId]);
    for (const item of rows) await synchronizeItemJournal(item, { id: missionId, owner_id: ownerId }, false);
}

async function internalDialogue(req, res) {
    const mission = await accessibleInternalMission(getAccountOwnerId(req), positiveId(req.params.missionId), req);
    if (!mission) return res.status(404).json({ message: "Dossier introuvable ou non accessible." });
    res.json(await dialoguePayload(mission, false));
}

async function sourceDialogue(req, res) {
    const mission = await accessibleSourceMission(getAccountOwnerId(req), positiveId(req.params.missionId));
    if (!mission) return res.status(404).json({ message: "Conversation partenaire introuvable ou non accessible." });
    res.json({ ...(await dialoguePayload(mission, true)), sourceDialogue: true });
}

async function internalMessage(req, res) {
    const ownerId = getAccountOwnerId(req); const mission = await accessibleInternalMission(ownerId, positiveId(req.params.missionId), req);
    if (!mission) return res.status(404).json({ message: "Dossier introuvable ou non accessible." });
    if (mission.status === "closed") return res.status(409).json({ message: "Ce dossier est clôturé : le fil est en lecture seule." });
    const input = messageInput(req.body, req.files); if (!input.ok) return res.status(400).json({ message: input.message });
    const company = await sourceCompany(ownerId);
    const message = await createMessageWithAttachments({ ownerId, missionId: mission.id, senderType: "internal", senderUserId: req.user.sub, senderName: req.user.fullName || req.user.username, organizationName: company.name, partnerVisible: Boolean(req.body?.partnerVisible), ...input });
    if (message.partnerVisible) await queuePartnerEvent(ownerId, mission.id, input.kind === "issue" ? "partner_dialogue_issue" : "partner_dialogue_message", { messageId: message.id, kind: input.kind, issueType: input.issueType, body: input.body, attachmentCount: message.attachments.length });
    await notifyInternalParticipants(ownerId, mission, req.user.sub, input.kind === "issue" ? "Problème signalé sur un dossier" : "Nouveau message de dossier", input.body || "Une pièce jointe a été ajoutée.", { missionId: mission.id, dialogueMessageId: message.id, kind: input.kind });
    if (message.partnerVisible) await notifyMissionSourceParticipants(ownerId, mission.id, input.kind === "issue" ? "Problème signalé par l’entreprise exécutante" : "Nouveau message de l’entreprise exécutante", input.body || "Une pièce jointe a été ajoutée.", message.id);
    await broadcastJournalUpdate(ownerId, mission.id, message.id, "created");
    res.status(201).json({ message });
}

async function sourceMessage(req, res) {
    const sourceOwnerId = getAccountOwnerId(req); const mission = await accessibleSourceMission(sourceOwnerId, positiveId(req.params.missionId));
    if (!mission) return res.status(404).json({ message: "Conversation partenaire introuvable ou non accessible." });
    if (mission.status === "closed") return res.status(409).json({ message: "Ce dossier est clôturé : le fil est en lecture seule." });
    const input = messageInput(req.body, req.files); if (!input.ok) return res.status(400).json({ message: input.message });
    const source = await sourceCompany(sourceOwnerId);
    const message = await createMessageWithAttachments({ ownerId: mission.owner_id, missionId: mission.id, senderType: "partner", senderUserId: req.user.sub, senderName: req.user.fullName || req.user.username || source.name, organizationName: source.name, partnerVisible: true, ...input });
    await notifyInternalParticipants(mission.owner_id, mission, null, input.kind === "issue" ? "Problème signalé par le partenaire" : "Nouveau message partenaire", input.body || "Une pièce jointe a été ajoutée.", { missionId: mission.id, dialogueMessageId: message.id, kind: input.kind });
    await broadcastJournalUpdate(mission.owner_id, mission.id, message.id, "created");
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

async function externalSharedItem(req, res) {
    const mission = await externalMission(req);
    if (!mission) return res.status(404).json({ message: "Document introuvable." });
    const item = await findMissionItem(mission.owner_id, mission.id, positiveId(req.params.itemId), true);
    if (!item) return res.status(404).json({ message: "Document introuvable." });
    return sendMissionItem(res, mission.owner_id, item);
}

async function internalSharedItem(req, res) {
    const ownerId = getAccountOwnerId(req); const mission = await accessibleInternalMission(ownerId, positiveId(req.params.missionId), req);
    const item = mission && await findMissionItem(ownerId, mission.id, positiveId(req.params.itemId));
    if (!item) return res.status(404).json({ message: "Document introuvable." });
    return sendMissionItem(res, ownerId, item);
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

async function updateItemVisibility(req, res) {
    const ownerId = getAccountOwnerId(req); const mission = await accessibleInternalMission(ownerId, positiveId(req.params.missionId), req);
    const item = mission && await findMissionItem(ownerId, mission.id, positiveId(req.params.itemId));
    if (!item) return res.status(404).json({ message: "Document introuvable ou non accessible." });
    if (typeof req.body?.partnerVisible !== "boolean") return res.status(400).json({ message: "Visibilité partenaire invalide." });
    if (["quote", "invoice"].includes(item.sourceType) && !PARTNER_MANAGEMENT_ROLES.has(req.user.role)) return res.status(403).json({ message: "Le partage des devis et factures est réservé aux postes PC autorisés." });
    if (req.body.partnerVisible && ["quote", "invoice"].includes(item.sourceType) && mission.billing_mode !== "principal") return res.status(409).json({ message: "Les devis et factures d’une mission facturée au client final restent strictement internes." });
    const { rows } = await getPool().query("UPDATE depannhome_partner_mission_items SET partner_visible=$4,updated_at=NOW() WHERE id=$1 AND owner_id=$2 AND mission_id=$3 RETURNING *", [item.id, ownerId, mission.id, req.body.partnerVisible]);
    const updated = rows[0];
    await getPool().query("INSERT INTO depannhome_partner_mission_item_audit(owner_id,mission_id,item_id,action,actor_id,old_value,new_value) VALUES($1,$2,$3,'visibility_changed',$4,$5::jsonb,$6::jsonb)", [ownerId, mission.id, updated.id, req.user.sub, JSON.stringify({ partnerVisible: item.partnerVisible }), JSON.stringify({ partnerVisible: updated.partner_visible })]);
    await synchronizeItemJournal(updated, mission, Boolean(updated.partner_visible));
    await broadcastJournalUpdate(ownerId, mission.id, updated.dialogue_message_id || 0, "item_visibility_changed");
    res.json({ item: publicMissionItem(updated) });
}

async function updateAttachmentVisibility(req, res) {
    const ownerId = getAccountOwnerId(req); const mission = await accessibleInternalMission(ownerId, positiveId(req.params.missionId), req);
    const attachmentId = positiveId(req.params.attachmentId); if (!mission || !attachmentId) return res.status(404).json({ message: "Pièce jointe introuvable." });
    if (typeof req.body?.partnerVisible !== "boolean") return res.status(400).json({ message: "Visibilité partenaire invalide." });
    const { rows } = await getPool().query("SELECT attachment.id,attachment.partner_visible,message.id AS message_id,message.partner_visible AS message_visible FROM depannhome_partner_dialogue_attachments attachment JOIN depannhome_partner_dialogue_messages message ON message.id=attachment.message_id WHERE attachment.id=$1 AND attachment.owner_id=$2 AND attachment.mission_id=$3", [attachmentId, ownerId, mission.id]);
    const attachment = rows[0]; if (!attachment) return res.status(404).json({ message: "Pièce jointe introuvable." });
    if (req.body.partnerVisible && !attachment.message_visible) return res.status(409).json({ message: "Partagez d’abord le message associé ou ajoutez cette pièce dans un message dédié." });
    await getPool().query("UPDATE depannhome_partner_dialogue_attachments SET partner_visible=$2 WHERE id=$1", [attachmentId, req.body.partnerVisible]);
    await insertAudit(getPool(), { ownerId, missionId: mission.id, messageId: attachment.message_id, action: "attachment_visibility_changed", actorId: req.user.sub, actorName: req.user.fullName || req.user.username, oldValue: { attachmentId, partnerVisible: attachment.partner_visible }, newValue: { attachmentId, partnerVisible: req.body.partnerVisible } });
    await broadcastJournalUpdate(ownerId, mission.id, attachment.message_id, "attachment_visibility_changed"); res.status(204).end();
}

async function dialoguePayload(mission, external) {
    const [messages, documents] = await Promise.all([loadMessages(mission, external), linkedDocuments(mission.owner_id, mission, external)]);
    return { mission: publicMissionSummary(mission), messages, linkedDocuments: documents, readOnly: mission.status === "closed", filters: ["messages"] };
}
async function loadMessages(mission, external) {
    const { rows } = await getPool().query(`SELECT message.id, message.sender_type AS "senderType", message.sender_name AS "senderName", message.organization_name AS "organizationName", message.kind, message.issue_type AS "issueType", message.body, message.reply_to_id AS "replyToId", message.partner_visible AS "partnerVisible", message.event_type AS "eventType", message.immutable, message.created_at AS "createdAt", message.updated_at AS "updatedAt", COALESCE((SELECT json_agg(json_build_object('id', attachment.id, 'filename', attachment.filename, 'mimeType', attachment.mime_type, 'fileSize', attachment.file_size, 'attachmentType', attachment.attachment_type, 'partnerVisible', attachment.partner_visible) ORDER BY attachment.id) FROM depannhome_partner_dialogue_attachments attachment WHERE attachment.message_id=message.id AND ($3=FALSE OR attachment.partner_visible=TRUE)), '[]'::json) AS attachments FROM depannhome_partner_dialogue_messages message WHERE message.owner_id=$1 AND message.mission_id=$2 AND ($3=FALSE OR message.partner_visible=TRUE) ORDER BY message.created_at ASC, message.id ASC LIMIT 1000`, [mission.owner_id, mission.id, external]);
    return rows.map(message => ({ ...message, attachments: (message.attachments || []).map(attachment => ({ ...attachment, url: external ? `/api/partner-dialogue/external/missions/${encodeURIComponent(mission.external_mission_id)}/attachments/${attachment.id}` : `/api/partner-dialogue/missions/${mission.id}/attachments/${attachment.id}` })) }));
}
async function linkedDocuments(ownerId, mission, external) {
    const { rows } = await getPool().query(`SELECT id,source_type AS "sourceType",source_id AS "sourceId",label,details,partner_visible AS "partnerVisible",created_at AS "createdAt",updated_at AS "updatedAt" FROM depannhome_partner_mission_items WHERE owner_id=$1 AND mission_id=$2 AND ($3=FALSE OR partner_visible=TRUE) ORDER BY updated_at DESC,id DESC`, [ownerId, mission.id, external]);
    return rows.map(item => ({ ...publicMissionItem(item), url: external ? `/api/partner-dialogue/external/missions/${encodeURIComponent(mission.external_mission_id)}/items/${item.id}/download` : "" }));
}
async function findMissionItem(ownerId, missionId, itemId, partnerOnly = false) {
    if (!itemId) return null;
    const { rows } = await getPool().query("SELECT * FROM depannhome_partner_mission_items WHERE id=$1 AND owner_id=$2 AND mission_id=$3 AND ($4=FALSE OR partner_visible=TRUE)", [itemId, ownerId, missionId, partnerOnly]);
    return rows[0] ? publicMissionItem(rows[0]) : null;
}
async function synchronizeItemJournal(item, mission, visible) {
    if (!visible) {
        if (item.dialogue_message_id) await getPool().query("UPDATE depannhome_partner_dialogue_messages SET partner_visible=FALSE,updated_at=NOW() WHERE id=$1 AND owner_id=$2 AND mission_id=$3", [item.dialogue_message_id, item.owner_id, item.mission_id]);
        return;
    }
    if (item.dialogue_message_id) {
        await getPool().query("UPDATE depannhome_partner_dialogue_messages SET partner_visible=TRUE,updated_at=NOW() WHERE id=$1 AND owner_id=$2 AND mission_id=$3", [item.dialogue_message_id, item.owner_id, item.mission_id]);
        return;
    }
    const message = await recordMissionDialogueEvent({ ownerId: item.owner_id, missionId: item.mission_id, status: "document_shared", action: "document_shared", details: { itemId: item.id, sourceType: item.source_type, label: item.label }, actorName: "Depann’Home Pro", partnerVisible: true });
    if (message?.id) await getPool().query("UPDATE depannhome_partner_mission_items SET dialogue_message_id=$2,updated_at=NOW() WHERE id=$1", [item.id, message.id]);
}
async function sendMissionItem(res, ownerId, item) {
    if (["quote", "invoice"].includes(item.sourceType)) {
        const { rows } = await getPool().query(`SELECT id,document_type AS "documentType",document_number AS "documentNumber",customer_name AS "customerName",customer_address AS "customerAddress",TO_CHAR(issue_date,'YYYY-MM-DD') AS "issueDate",TO_CHAR(due_date,'YYYY-MM-DD') AS "dueDate",quote_reference AS "quoteReference",lines,notes,financial_data AS "financialData" FROM depannhome_billing_documents WHERE id=$1 AND owner_id=$2 AND document_type=$3`, [item.sourceId, ownerId, item.sourceType]);
        const document = rows[0]; if (!document) return res.status(404).json({ message: "Document introuvable." });
        const profileResult = await getPool().query(`SELECT company_name AS "companyName",legal_form AS "legalForm",address,postal_code AS "postalCode",city,phone,email,registration_number AS "registrationNumber",siren,tax_number AS "taxNumber",bank_iban AS "bankIban",bank_bic AS "bankBic",payment_terms AS "paymentTerms",deposit_terms AS "depositTerms",footer_note AS "footerNote",logo_data AS "logoData",logo_mime_type AS "logoMimeType" FROM depannhome_billing_profiles WHERE owner_id=$1`, [ownerId]);
        const { createBillingPdf } = await import("./billing.js"); const pdf = await createBillingPdf(document, profileResult.rows[0] || {});
        res.set({ "Content-Type": "application/pdf", "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(`${item.sourceType === "quote" ? "devis" : "facture"}-${document.documentNumber}.pdf`)}`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" }); return res.send(pdf);
    }
    if (item.sourceType === "report") {
        const { rows } = await getPool().query("SELECT pdf_data AS data,pdf_filename AS filename FROM depannhome_technical_reports WHERE id=$1 AND owner_id=$2", [item.sourceId, ownerId]);
        if (!rows[0]?.data) return res.status(409).json({ message: "Le rapport doit être validé avant son partage." });
        res.set({ "Content-Type": "application/pdf", "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(rows[0].filename || `rapport-${item.sourceId}.pdf`)}`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" }); return res.send(rows[0].data);
    }
    if (item.sourceType === "photo") {
        const { rows } = await getPool().query("SELECT media FROM depannhome_technical_reports WHERE id=$1 AND owner_id=$2", [item.sourceId, ownerId]); const photo = (rows[0]?.media || []).find(entry => entry.id === item.sourceItemId);
        const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(photo?.dataUrl || "")); if (!match) return res.status(404).json({ message: "Photo introuvable." });
        res.set({ "Content-Type": match[1], "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(photo.name || `photo-${item.sourceItemId}`)}`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" }); return res.send(Buffer.from(match[2], "base64"));
    }
    return res.status(404).json({ message: "Document introuvable." });
}
function publicMissionItem(item) { return { id: Number(item.id), sourceType: item.sourceType || item.source_type, sourceId: String(item.sourceId || item.source_id || ""), sourceItemId: String(item.sourceItemId || item.source_item_id || ""), label: item.label || "Document", details: item.details || {}, partnerVisible: Boolean(item.partnerVisible ?? item.partner_visible), createdAt: item.createdAt || item.created_at, updatedAt: item.updatedAt || item.updated_at }; }
async function createMessageWithAttachments({ ownerId, missionId, senderType, senderUserId = null, senderName, organizationName, kind, issueType = "", body, replyToId = 0, partnerVisible = false, attachments = [] }) {
    const connection = await getPool().connect();
    try { await connection.query("BEGIN"); const message = await insertMessage({ ownerId, missionId, senderType, senderUserId, senderName, organizationName, kind, issueType, body, replyToId, partnerVisible }, connection); const saved = []; for (const attachment of attachments) { const { rows } = await connection.query("INSERT INTO depannhome_partner_dialogue_attachments(owner_id,mission_id,message_id,attachment_type,filename,mime_type,file_size,file_data,partner_visible) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,filename,mime_type AS \"mimeType\",file_size AS \"fileSize\",attachment_type AS \"attachmentType\",partner_visible AS \"partnerVisible\"", [ownerId, missionId, message.id, attachment.type, attachment.filename, attachment.mimeType, attachment.buffer.length, attachment.buffer, Boolean(partnerVisible)]); saved.push(rows[0]); } await insertAudit(connection, { ownerId, missionId, messageId: message.id, action: "created", actorId: senderUserId, actorName: senderName, newValue: { partnerVisible, kind, attachmentCount: saved.length } }); await connection.query("COMMIT"); return { ...message, attachments: saved }; } catch (error) { await connection.query("ROLLBACK"); throw error; } finally { connection.release(); }
}
async function insertMessage({ ownerId, missionId, senderType, senderUserId = null, senderName = "", organizationName = "", kind = "message", issueType = "", body = "", replyToId = 0, partnerVisible = false, eventType = "", immutable = false }, connection = getPool()) { const { rows } = await connection.query("INSERT INTO depannhome_partner_dialogue_messages(owner_id,mission_id,sender_type,sender_user_id,sender_name,organization_name,kind,issue_type,body,reply_to_id,partner_visible,event_type,immutable) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id,sender_type AS \"senderType\",sender_name AS \"senderName\",organization_name AS \"organizationName\",kind,issue_type AS \"issueType\",body,reply_to_id AS \"replyToId\",partner_visible AS \"partnerVisible\",event_type AS \"eventType\",immutable,created_at AS \"createdAt\"", [ownerId, missionId, senderType, senderUserId || null, clean(senderName, 160), clean(organizationName, 160), kind, issueType, body, replyToId || null, Boolean(partnerVisible), clean(eventType, 80), Boolean(immutable)]); return rows[0]; }
async function accessibleInternalMission(ownerId, id, req) { if (!id) return null; const { rows } = await getPool().query(`SELECT mission.*, intake.partner_name, COALESCE(technician.full_name, technician.username, '') AS technician_name, event.client_name, event.location, TO_CHAR(event.event_date,'YYYY-MM-DD') AS event_date, TO_CHAR(event.start_time,'HH24:MI') AS start_time FROM depannhome_partner_missions mission JOIN depannhome_partner_intakes intake ON intake.id=mission.intake_id LEFT JOIN depannhome_users technician ON technician.id=mission.assigned_technician_id LEFT JOIN depannhome_calendar_events event ON event.id=mission.calendar_event_id AND event.owner_id=mission.owner_id WHERE mission.id=$1 AND mission.owner_id=$2`, [id, ownerId]); return rows[0] || null; }
async function accessibleSourceMission(sourceOwnerId, id) { if (!id) return null; const { rows } = await getPool().query(`SELECT mission.*, intake.partner_name, COALESCE(technician.full_name, technician.username, '') AS technician_name, event.client_name, event.location, TO_CHAR(event.event_date,'YYYY-MM-DD') AS event_date, TO_CHAR(event.start_time,'HH24:MI') AS start_time FROM depannhome_partner_connection_sync_log log JOIN depannhome_partner_connections connection ON connection.id=log.connection_id AND connection.status='connected' JOIN depannhome_partner_missions mission ON mission.id=log.target_mission_id AND mission.owner_id=log.target_owner_id JOIN depannhome_partner_intakes intake ON intake.id=mission.intake_id LEFT JOIN depannhome_users technician ON technician.id=mission.assigned_technician_id LEFT JOIN depannhome_calendar_events event ON event.id=mission.calendar_event_id AND event.owner_id=mission.owner_id WHERE log.target_mission_id=$1 AND log.source_owner_id=$2 AND (CASE WHEN connection.company_low_id=$2 THEN COALESCE((connection.permissions_for_low->>'canUseMessaging')::boolean,TRUE) ELSE COALESCE((connection.permissions_for_high->>'canUseMessaging')::boolean,TRUE) END) LIMIT 1`, [id, sourceOwnerId]); return rows[0] || null; }
async function findMissionById(ownerId, id) { const { rows } = await getPool().query(`SELECT mission.*, intake.partner_name, COALESCE(technician.full_name, technician.username, '') AS technician_name, event.client_name, event.location, TO_CHAR(event.event_date,'YYYY-MM-DD') AS event_date, TO_CHAR(event.start_time,'HH24:MI') AS start_time FROM depannhome_partner_missions mission JOIN depannhome_partner_intakes intake ON intake.id=mission.intake_id LEFT JOIN depannhome_users technician ON technician.id=mission.assigned_technician_id LEFT JOIN depannhome_calendar_events event ON event.id=mission.calendar_event_id AND event.owner_id=mission.owner_id WHERE mission.id=$1 AND mission.owner_id=$2`, [id, ownerId]); return rows[0] || null; }
async function externalMission(req) { const key = clean(req.get("X-API-Key"), 300); const externalId = clean(req.params.externalMissionId, 160); if (!key || !externalId) return null; const { rows } = await getPool().query(`SELECT mission.*, intake.partner_name, intake.api_key_hash, COALESCE(technician.full_name, technician.username, '') AS technician_name, event.client_name, event.location, TO_CHAR(event.event_date,'YYYY-MM-DD') AS event_date, TO_CHAR(event.start_time,'HH24:MI') AS start_time FROM depannhome_partner_missions mission JOIN depannhome_partner_intakes intake ON intake.id=mission.intake_id LEFT JOIN depannhome_users technician ON technician.id=mission.assigned_technician_id LEFT JOIN depannhome_calendar_events event ON event.id=mission.calendar_event_id AND event.owner_id=mission.owner_id WHERE mission.external_mission_id=$1 AND intake.enabled=TRUE`, [externalId]); const mission = rows.find(row => safeEqual(hash(key), row.api_key_hash)); return mission || null; }
async function sendAttachment(res, ownerId, missionId, attachmentId, partnerOnly = false) { if (!attachmentId) return res.status(404).json({ message: "Pièce jointe introuvable." }); const { rows } = await getPool().query("SELECT attachment.filename,attachment.mime_type,attachment.file_data FROM depannhome_partner_dialogue_attachments attachment JOIN depannhome_partner_dialogue_messages message ON message.id=attachment.message_id WHERE attachment.id=$1 AND attachment.owner_id=$2 AND attachment.mission_id=$3 AND ($4=FALSE OR (message.partner_visible=TRUE AND attachment.partner_visible=TRUE))", [attachmentId, ownerId, missionId, partnerOnly]); const attachment = rows[0]; if (!attachment) return res.status(404).json({ message: "Pièce jointe introuvable." }); res.set({ "Content-Type": attachment.mime_type, "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" }); return res.send(attachment.file_data); }
async function notifyInternalParticipants(ownerId, mission, senderUserId, title, body, payload) { const { rows } = await getPool().query("SELECT id FROM depannhome_users WHERE account_owner_id=$1 AND is_active=TRUE AND role IN ('admin','pc_standard','mobile_admin')", [ownerId]); await Promise.all(rows.filter(row => String(row.id) !== String(senderUserId || "")).map(row => createNotification(ownerId, row.id, "partner_dialogue_updated", { entityType: "partner_mission", entityId: String(mission.id) }, title, clean(body, 2000), payload))); }
async function notifyMissionSourceParticipants(targetOwnerId, missionId, title, body, messageId) { const { rows } = await getPool().query("SELECT DISTINCT source_owner_id FROM depannhome_partner_connection_sync_log WHERE target_owner_id=$1 AND target_mission_id=$2", [targetOwnerId, missionId]); for (const source of rows) { const recipients = await getPool().query("SELECT id FROM depannhome_users WHERE account_owner_id=$1 AND role IN ('admin','pc_standard','mobile_admin') AND is_active=TRUE", [source.source_owner_id]); await Promise.all(recipients.rows.map(user => createNotification(source.source_owner_id, user.id, "partner_dialogue_updated", { entityType: "partner_mission", entityId: String(missionId) }, title, clean(body, 2000), { missionId, dialogueMessageId: messageId, sourceDialogue: true }))); } }
async function sourceCompany(ownerId) { const { rows } = await getPool().query("SELECT COALESCE(NULLIF(profile.company_name,''),NULLIF(user_account.company_name,''),NULLIF(user_account.full_name,''),user_account.username) AS name FROM depannhome_users user_account LEFT JOIN depannhome_billing_profiles profile ON profile.owner_id=user_account.id WHERE user_account.id=$1", [ownerId]); return rows[0] || { name: "Entreprise partenaire" }; }
async function queuePartnerEvent(ownerId, missionId, eventType, payload) { await getPool().query("INSERT INTO depannhome_partner_mission_outbox(owner_id,mission_id,event_type,payload) VALUES($1,$2,$3,$4::jsonb)", [ownerId, missionId, eventType, JSON.stringify(payload)]); }
function messageInput(body, files) { const kind = MESSAGE_KINDS.has(body?.kind) && body.kind !== "system" ? body.kind : "message"; const issueType = kind === "issue" && ISSUE_TYPES.has(body?.issueType) ? body.issueType : kind === "issue" ? "other" : ""; const text = clean(body?.body, MAX_MESSAGE_LENGTH); const attachments = (Array.isArray(files) ? files : []).map(file => ({ filename: safeFilename(file.originalname), mimeType: file.mimetype, buffer: file.buffer, type: attachmentType(body?.attachmentType, file.mimetype) })); return text || attachments.length ? { ok: true, kind, issueType, body: text, replyToId: positiveId(body?.replyToId), attachments } : { ok: false, message: "Saisissez un message ou joignez un fichier." }; }
function externalMessageInput(value) { const kind = MESSAGE_KINDS.has(value?.kind) && value.kind !== "system" ? value.kind : "message"; const issueType = kind === "issue" && ISSUE_TYPES.has(value?.issueType) ? value.issueType : kind === "issue" ? "other" : ""; const attachments = []; for (const item of Array.isArray(value?.attachments) ? value.attachments.slice(0, MAX_ATTACHMENTS) : []) { const parsed = dataUrlAttachment(item); if (!parsed) return { ok: false, message: "Une pièce jointe partenaire est invalide." }; attachments.push(parsed); } const body = clean(value?.body, MAX_MESSAGE_LENGTH); return body || attachments.length ? { ok: true, kind, issueType, body, authorName: clean(value?.authorName, 160), replyToId: positiveId(value?.replyToId), attachments } : { ok: false, message: "Saisissez un message ou joignez un fichier." }; }
function dataUrlAttachment(item) { const match = /^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(String(item?.dataUrl || "")); if (!match) return null; const buffer = Buffer.from(match[2], "base64"); if (!buffer.length || buffer.length > MAX_ATTACHMENT_BYTES || !ALLOWED_MIME_TYPES.has(match[1])) return null; return { filename: safeFilename(item?.filename || item?.name || "document-partenaire"), mimeType: match[1], buffer, type: attachmentType(item?.attachmentType, match[1]) }; }
function publicMissionSummary(mission) { const data = mission.mapped_data || {}; const year = new Date(mission.created_at || Date.now()).getFullYear(); return { id: mission.id, missionNumber: mission.source_mission_number || mission.mission_number || `MP-${year}-${String(mission.id).padStart(6, "0")}`, externalMissionId: mission.external_mission_id, interventionNumber: mission.intervention_number || `INT-${year}-${String(mission.id).padStart(6, "0")}`, interventionId: mission.calendar_event_id || null, clientId: mission.client_id || "", clientName: mission.client_name || data.clientName || "", address: mission.location || data.address || "", interventionType: data.interventionType || "Intervention", technicianName: mission.technician_name || "Non affecté", status: mission.status, scheduledDate: mission.event_date || mission.scheduled_date || null, scheduledStartTime: mission.start_time || mission.scheduled_start_time || null, technicalReportId: mission.technical_report_id || null, partnerName: mission.partner_name }; }
function systemMessage(status, action, details) { const actions = { client_created: "Fiche client créée automatiquement.", client_matched: "Mission rattachée à une fiche client existante.", appointment_created: "Rendez-vous planifié.", technician_assigned: "Technicien affecté.", report_created: "Rapport créé." }; const labels = { received: "Mission reçue.", pending_validation: "Mission en attente de validation.", accepted: "Mission acceptée.", assigned: "Technicien affecté.", scheduled: "Rendez-vous planifié.", en_route: "Technicien en route.", on_site: "Technicien arrivé sur site.", report_in_progress: "Rapport en cours.", report_completed: "Rapport terminé.", report_validated: "Rapport validé.", quote_created: "Devis créé.", quote_sent: "Devis envoyé.", quote_accepted: "Devis accepté.", work_completed: "Travaux terminés.", invoice_created: "Facture créée.", invoice_sent: "Facture envoyée.", document_shared: `${details?.label || "Document"} partagé avec le partenaire.`, rejected: "Mission refusée.", cancelled: "Mission annulée.", closed: "Mission clôturée : le fil est désormais en lecture seule." }; const message = actions[action] || labels[status] || (action === "updated" ? "Informations du dossier mises à jour." : "Dossier mis à jour."); return status === "received" && details?.summary ? `${message}\n${clean(details.summary, 2000)}` : message; }
function defaultSystemVisibility() { return false; }
async function insertAudit(connection, { ownerId, missionId, messageId, action, actorId = null, actorName = "", oldValue = {}, newValue = {} }) { await connection.query("INSERT INTO depannhome_partner_dialogue_audit(owner_id,mission_id,message_id,action,actor_id,actor_name,old_value,new_value) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)", [ownerId, missionId, messageId, action, actorId || null, clean(actorName, 160), JSON.stringify(oldValue), JSON.stringify(newValue)]); }
async function broadcastJournalUpdate(ownerId, missionId, messageId, action) { await broadcastOwnerEvent(ownerId, "mission_journal_updated", { entityType: "partner_mission", entityId: String(missionId), missionId, messageId, action }); }
function requireDialogueAccess(req, res, next) { if (PARTNER_MANAGEMENT_ROLES.has(req.user?.role)) return next(); return res.status(403).json({ message: "Le dialogue partenaire est réservé à l’administration." }); }
function attachmentType(value, mimeType) { const permitted = new Set(["photo", "document", "quote", "report", "invoice"]); if (permitted.has(value)) return value; return mimeType.startsWith("image/") ? "photo" : "document"; }
function safeFilename(value) { return path.basename(String(value || "document")).replace(/[\r\n]/g, " ").slice(0, 255) || "document"; }
function clean(value, max) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, max); }
function positiveId(value) { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : 0; }
function hash(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function safeEqual(a, b) { const first = Buffer.from(String(a)), second = Buffer.from(String(b)); return first.length === second.length && crypto.timingSafeEqual(first, second); }
export function partnerDialogueUploadErrorHandler(error, req, res, next) { if (error instanceof multer.MulterError) return res.status(400).json({ message: error.code === "LIMIT_FILE_SIZE" ? "Chaque pièce jointe est limitée à 5 Mo." : "Ajout de pièce jointe impossible." }); return next(error); }
function externalPublicMessage(message, externalMissionId) { return { ...message, attachments: message.attachments.map(attachment => ({ ...attachment, url: `/api/partner-dialogue/external/missions/${encodeURIComponent(externalMissionId)}/attachments/${attachment.id}` })) }; }
function asyncHandler(handler) { return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next); }
