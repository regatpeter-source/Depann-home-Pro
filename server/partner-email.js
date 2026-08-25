import crypto from "node:crypto";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { getPool } from "./database.js";
import { getAccountOwnerId } from "./auth.js";
import { getOrganization, isFeatureEnabled } from "./organizations.js";
import { decryptElectronicInvoicingCredentials, encryptElectronicInvoicingCredentials } from "./electronic-invoicing.js";
import { ingestEmailPartnerMission } from "./partner-missions.js";
import { recordMissionDialogueDocument, recordMissionDialogueEvent } from "./partner-dialogue.js";
import { extractPartnerDocumentText } from "./partner-email-document-extractor.js";

const ADMIN_ROLES = new Set(["admin", "pc_standard", "mobile_admin"]);
const PROVIDERS = new Set(["google", "microsoft", "imap"]);
const MODES = new Set(["manual", "automatic"]);
const ALLOWED_MIME = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "text/plain"]);
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const AUTO_THRESHOLD = 80;
const FETCH_LIMIT = 100;
let scheduler = null;

export async function initializePartnerEmail() {
    const db = getPool();
    await db.query(`CREATE TABLE IF NOT EXISTS depannhome_partner_email_connections (
        id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
        provider VARCHAR(20) NOT NULL CHECK(provider IN ('google','microsoft','imap')), email_address VARCHAR(254) NOT NULL,
        display_name VARCHAR(160) NOT NULL DEFAULT '', encrypted_credentials TEXT NOT NULL,
        server_configuration JSONB NOT NULL DEFAULT '{}'::jsonb, selection_mode VARCHAR(20) NOT NULL DEFAULT 'manual' CHECK(selection_mode IN ('manual','automatic')),
        allowed_senders JSONB NOT NULL DEFAULT '[]'::jsonb, automatic_threshold INTEGER NOT NULL DEFAULT 80 CHECK(automatic_threshold BETWEEN 70 AND 100),
        send_status_updates BOOLEAN NOT NULL DEFAULT FALSE, enabled BOOLEAN NOT NULL DEFAULT TRUE,
        last_uid BIGINT NOT NULL DEFAULT 0, last_sync_at TIMESTAMPTZ, last_error VARCHAR(500) NOT NULL DEFAULT '',
        created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT depannhome_partner_email_owner_address_unique UNIQUE(owner_id,email_address)
    )`);
    await db.query("CREATE INDEX IF NOT EXISTS depannhome_partner_email_connections_sync_idx ON depannhome_partner_email_connections(enabled,last_sync_at)");
    await db.query(`CREATE TABLE IF NOT EXISTS depannhome_partner_email_messages (
        id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
        connection_id BIGINT NOT NULL REFERENCES depannhome_partner_email_connections(id) ON DELETE CASCADE,
        uid BIGINT NOT NULL, message_id VARCHAR(500) NOT NULL, in_reply_to VARCHAR(500) NOT NULL DEFAULT '', references_header TEXT NOT NULL DEFAULT '',
        sender_address VARCHAR(254) NOT NULL, sender_name VARCHAR(160) NOT NULL DEFAULT '', recipients JSONB NOT NULL DEFAULT '[]'::jsonb,
        subject VARCHAR(500) NOT NULL DEFAULT '', body_text TEXT NOT NULL DEFAULT '', received_at TIMESTAMPTZ NOT NULL,
        classification_score INTEGER NOT NULL DEFAULT 0, classification_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
        status VARCHAR(20) NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate','processing','imported','ignored','rejected')),
        mission_id BIGINT REFERENCES depannhome_partner_missions(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), processed_at TIMESTAMPTZ,
        CONSTRAINT depannhome_partner_email_message_unique UNIQUE(owner_id,connection_id,message_id)
    )`);
    await db.query("ALTER TABLE depannhome_partner_email_messages DROP CONSTRAINT IF EXISTS depannhome_partner_email_messages_status_check");
    await db.query("ALTER TABLE depannhome_partner_email_messages ADD CONSTRAINT depannhome_partner_email_messages_status_check CHECK(status IN ('candidate','processing','imported','ignored','rejected'))");
    await db.query("CREATE INDEX IF NOT EXISTS depannhome_partner_email_messages_queue_idx ON depannhome_partner_email_messages(owner_id,status,received_at DESC)");
    await db.query(`CREATE TABLE IF NOT EXISTS depannhome_partner_email_attachments (
        id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
        email_message_id BIGINT NOT NULL REFERENCES depannhome_partner_email_messages(id) ON DELETE CASCADE,
        filename VARCHAR(255) NOT NULL, mime_type VARCHAR(150) NOT NULL, file_size INTEGER NOT NULL CHECK(file_size>0 AND file_size<=${MAX_ATTACHMENT_BYTES}),
        content_id VARCHAR(255) NOT NULL DEFAULT '', file_data BYTEA NOT NULL, selected BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS depannhome_partner_email_oauth_states (
        state_hash CHAR(64) PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
        actor_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE, provider VARCHAR(20) NOT NULL,
        encrypted_context TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.query("DELETE FROM depannhome_partner_email_oauth_states WHERE expires_at<=NOW()");
}

export function registerPartnerEmailRoutes(app, requireAuthentication) {
    app.get("/api/partner-email/oauth/:provider/callback", asyncHandler(async (req, res) => {
        const provider = String(req.params.provider || "");
        const state = String(req.query?.state || "");
        if (!["google", "microsoft"].includes(provider) || !state) return oauthPopup(res, false, "Autorisation de la boîte refusée ou expirée.");
        const { rows } = await getPool().query("DELETE FROM depannhome_partner_email_oauth_states WHERE state_hash=$1 AND provider=$2 AND expires_at>NOW() RETURNING owner_id,actor_id,encrypted_context", [hash(state), provider]);
        const pending = rows[0];
        if (!pending || req.query?.error || !req.query?.code) return oauthPopup(res, false, "Autorisation de la boîte refusée ou expirée.");
        const context = decryptElectronicInvoicingCredentials(pending.encrypted_context);
        const tokens = await exchangeOauthCode(provider, String(req.query.code), context.verifier);
        const identity = await oauthIdentity(provider, tokens.access_token);
        const encrypted = encryptElectronicInvoicingCredentials({ accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: new Date(Date.now() + Number(tokens.expires_in || 3600) * 1000).toISOString() });
        await getPool().query(`INSERT INTO depannhome_partner_email_connections(owner_id,provider,email_address,display_name,encrypted_credentials,server_configuration,selection_mode,allowed_senders,send_status_updates,created_by,last_error) VALUES($1,$2,$3,$4,$5,'{}'::jsonb,$6,$7::jsonb,$8,$9,'') ON CONFLICT(owner_id,email_address) DO UPDATE SET provider=EXCLUDED.provider,display_name=EXCLUDED.display_name,encrypted_credentials=EXCLUDED.encrypted_credentials,selection_mode=EXCLUDED.selection_mode,allowed_senders=EXCLUDED.allowed_senders,send_status_updates=EXCLUDED.send_status_updates,enabled=TRUE,last_error='',updated_at=NOW()`, [pending.owner_id, provider, identity.email, identity.name, encrypted, context.selectionMode, JSON.stringify(context.allowedSenders), context.sendStatusUpdates, pending.actor_id]);
        oauthPopup(res, true, "Boîte professionnelle connectée.");
    }));
    app.use("/api/partner-email", requireAuthentication, requireEmailAccess);
    app.get("/api/partner-email", asyncHandler(async (req, res) => {
        const ownerId = getAccountOwnerId(req);
        const [connections, messages] = await Promise.all([
            getPool().query(`SELECT id,provider,email_address AS "emailAddress",display_name AS "displayName",selection_mode AS "selectionMode",allowed_senders AS "allowedSenders",automatic_threshold AS "automaticThreshold",send_status_updates AS "sendStatusUpdates",enabled,last_sync_at AS "lastSyncAt",last_error AS "lastError",updated_at AS "updatedAt" FROM depannhome_partner_email_connections WHERE owner_id=$1 ORDER BY updated_at DESC`, [ownerId]),
            getPool().query(`SELECT message.id,message.connection_id AS "connectionId",message.sender_address AS "senderAddress",message.sender_name AS "senderName",message.subject,message.body_text AS "bodyText",message.received_at AS "receivedAt",message.classification_score AS "classificationScore",message.classification_reasons AS "classificationReasons",message.status,message.mission_id AS "missionId",COALESCE(json_agg(json_build_object('id',attachment.id,'filename',attachment.filename,'mimeType',attachment.mime_type,'fileSize',attachment.file_size,'selected',attachment.selected) ORDER BY attachment.id) FILTER(WHERE attachment.id IS NOT NULL),'[]'::json) AS attachments FROM depannhome_partner_email_messages message LEFT JOIN depannhome_partner_email_attachments attachment ON attachment.email_message_id=message.id WHERE message.owner_id=$1 AND message.status='candidate' GROUP BY message.id ORDER BY message.received_at DESC LIMIT 200`, [ownerId])
        ]);
        res.json({ connections: connections.rows, candidates: messages.rows, oauth: { google: oauthConfigured("google"), microsoft: oauthConfigured("microsoft") } });
    }));
    app.put("/api/partner-email/configuration", asyncHandler(async (req, res) => {
        const input = sanitizeImapConfiguration(req.body);
        if (!input.ok) return res.status(400).json({ message: input.message });
        if (isMicrosoftMailbox(input.emailAddress)) return res.status(400).json({ message: "Les adresses Outlook, Hotmail, Live et MSN exigent la connexion OAuth Microsoft. Utilisez le bouton « Connecter Microsoft » ; le mot de passe habituel ou un mot de passe d’application ne convient pas à ce formulaire." });
        const ownerId = getAccountOwnerId(req);
        const existing = await getPool().query("SELECT encrypted_credentials FROM depannhome_partner_email_connections WHERE owner_id=$1 AND email_address=$2", [ownerId, input.emailAddress]);
        let old = {};
        if (!input.password && existing.rows[0]) {
            try { old = decryptElectronicInvoicingCredentials(existing.rows[0].encrypted_credentials); }
            catch { throw httpError(422, "L’ancien mot de passe enregistré n’est plus lisible. Saisissez un nouveau mot de passe d’application."); }
        }
        const credentials = { username: input.username, password: input.password || old.password || "" };
        if (!credentials.password) return res.status(400).json({ message: "Le mot de passe d’application est obligatoire lors de la première connexion." });
        try { await testMailbox({ provider: "imap", emailAddress: input.emailAddress, credentials, server: input.server }); }
        catch (error) { throw httpError(422, publicMailError(error, { configuration: true })); }
        const encrypted = encryptElectronicInvoicingCredentials(credentials);
        const { rows } = await getPool().query(`INSERT INTO depannhome_partner_email_connections(owner_id,provider,email_address,display_name,encrypted_credentials,server_configuration,selection_mode,allowed_senders,automatic_threshold,send_status_updates,created_by,last_error) VALUES($1,'imap',$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9,$10,'') ON CONFLICT(owner_id,email_address) DO UPDATE SET provider='imap',display_name=EXCLUDED.display_name,encrypted_credentials=EXCLUDED.encrypted_credentials,server_configuration=EXCLUDED.server_configuration,selection_mode=EXCLUDED.selection_mode,allowed_senders=EXCLUDED.allowed_senders,automatic_threshold=EXCLUDED.automatic_threshold,send_status_updates=EXCLUDED.send_status_updates,enabled=TRUE,last_error='',updated_at=NOW() RETURNING id`, [ownerId, input.emailAddress, input.displayName, encrypted, JSON.stringify(input.server), input.selectionMode, JSON.stringify(input.allowedSenders), input.automaticThreshold, input.sendStatusUpdates, req.user.sub]);
        res.json({ id: rows[0].id, message: "Boîte professionnelle connectée et vérifiée." });
    }));
    app.post("/api/partner-email/oauth/:provider/authorize", asyncHandler(async (req, res) => {
        const provider = String(req.params.provider || "");
        if (!oauthConfigured(provider)) return res.status(503).json({ message: `La connexion ${provider === "google" ? "Google" : "Microsoft"} n’est pas encore configurée sur le serveur.` });
        const state = crypto.randomBytes(32).toString("base64url"); const verifier = crypto.randomBytes(48).toString("base64url");
        const context = { verifier, selectionMode: MODES.has(req.body?.selectionMode) ? req.body.selectionMode : "manual", sendStatusUpdates: Boolean(req.body?.sendStatusUpdates), allowedSenders: sanitizeSenders(req.body?.allowedSenders) };
        await getPool().query("INSERT INTO depannhome_partner_email_oauth_states(state_hash,owner_id,actor_id,provider,encrypted_context,expires_at) VALUES($1,$2,$3,$4,$5,NOW()+INTERVAL '10 minutes')", [hash(state), getAccountOwnerId(req), req.user.sub, provider, encryptElectronicInvoicingCredentials(context)]);
        res.json({ authorizationUrl: oauthAuthorizationUrl(provider, state, verifier) });
    }));
    app.post("/api/partner-email/:connectionId/sync", asyncHandler(async (req, res) => res.json(await syncConnection(getAccountOwnerId(req), positiveId(req.params.connectionId), req.user.sub))));
    app.post("/api/partner-email/candidates/import", asyncHandler(async (req, res) => {
        const ids = selectedIds(req.body?.ids); if (!ids.length) return res.status(400).json({ message: "Sélectionnez au moins un e-mail." });
        const results = []; for (const id of ids) results.push(await importCandidate(getAccountOwnerId(req), id, req.user.sub));
        res.json({ imported: results.length, results });
    }));
    app.post("/api/partner-email/candidates/ignore", asyncHandler(async (req, res) => { const ids = selectedIds(req.body?.ids); await getPool().query("UPDATE depannhome_partner_email_messages SET status='ignored',processed_at=NOW() WHERE owner_id=$1 AND id=ANY($2::bigint[]) AND status='candidate'", [getAccountOwnerId(req), ids]); res.json({ ignored: ids.length }); }));
    app.post("/api/partner-email/missions/:missionId/reply", asyncHandler(async (req, res) => {
        const body = clean(req.body?.body, 4000); if (!body) return res.status(400).json({ message: "Saisissez une réponse." });
        const attachments = outgoingAttachments(req.body?.attachments);
        await sendMissionEmail(getAccountOwnerId(req), positiveId(req.params.missionId), body, { statusUpdate: false, attachments });
        await recordMissionDialogueEvent({ ownerId: getAccountOwnerId(req), missionId: positiveId(req.params.missionId), status: "email_reply_sent", action: "email_reply_sent", details: { summary: `Réponse envoyée par e-mail${attachments.length ? ` avec ${attachments.length} document(s)` : ""}.` }, actorName: req.user.fullName || req.user.username, partnerVisible: false });
        res.json({ message: "Réponse et documents envoyés depuis la boîte professionnelle." });
    }));
    app.delete("/api/partner-email/:connectionId", asyncHandler(async (req, res) => { await getPool().query("DELETE FROM depannhome_partner_email_connections WHERE id=$1 AND owner_id=$2", [positiveId(req.params.connectionId), getAccountOwnerId(req)]); res.status(204).end(); }));
}

export function startPartnerEmailScheduler() {
    if (scheduler) return;
    scheduler = setInterval(() => synchronizeDueConnections().catch(error => console.error("[partner-email] synchronisation :", error.message)), 5 * 60 * 1000);
    scheduler.unref?.();
    synchronizeDueConnections().catch(error => console.error("[partner-email] synchronisation initiale :", error.message));
}

export async function synchronizeDueConnections() {
    const { rows } = await getPool().query("SELECT connection.id,connection.owner_id FROM depannhome_partner_email_connections connection JOIN depannhome_users owner ON owner.id=connection.owner_id WHERE connection.enabled=TRUE AND owner.is_active=TRUE AND owner.is_archived=FALSE AND (connection.last_sync_at IS NULL OR connection.last_sync_at<NOW()-INTERVAL '10 minutes') ORDER BY connection.last_sync_at NULLS FIRST LIMIT 20");
    for (const row of rows) {
        if (!isFeatureEnabled(await getOrganization(row.owner_id), "partnerMissions")) continue;
        await syncConnection(row.owner_id, row.id, null).catch(() => {});
    }
}

export function classifyPartnerEmail({ subject = "", text = "", from = "", attachments = [], allowedSenders = [], automatic = false, listMail = false }) {
    const haystack = `${subject}\n${text}`.toLowerCase(); const sender = String(from).toLowerCase(); let score = 0; const reasons = [];
    const add = (points, reason) => { score += points; reasons.push(reason); };
    if (/mission|intervention|ordre de service|bon de commande|sinistre|dossier|mandat|affectation/.test(haystack)) add(35, "Objet ou contenu associé à une mission");
    if (/client|assuré|adresse|téléphone|portable|lieu d'intervention|référence|n°\s*(?:de\s*)?sinistre/.test(haystack)) add(20, "Coordonnées ou référence de dossier détectées");
    if (attachments.some(item => ALLOWED_MIME.has(item.contentType))) add(20, "Document métier joint");
    if (/urgent|urgence|prioritaire|sous 24|délai/.test(haystack)) add(10, "Caractère opérationnel ou urgent");
    const trustedSender = allowedSenders.some(value => sender === value || sender.endsWith(`@${value.replace(/^@/, "")}`));
    if (trustedSender) add(25, "Expéditeur autorisé par l’entreprise");
    if (/relance|newsletter|publicité|promotion|facture impayée|règlement|paiement|relevé|notification automatique/.test(haystack)) add(-55, "Message assimilé à une relance ou information non opérationnelle");
    if (/no-?reply|noreply|nepasrepondre/.test(sender)) add(-25, "Adresse automatique");
    if (automatic || listMail) add(-70, "Réponse automatique ou message de liste détecté");
    if (!trustedSender && score >= AUTO_THRESHOLD) { score = AUTO_THRESHOLD - 1; reasons.push("Validation humaine requise : expéditeur non autorisé"); }
    return { score: Math.max(0, Math.min(100, score)), reasons, trustedSender, likelyMission: trustedSender && score >= AUTO_THRESHOLD };
}

async function syncConnection(ownerId, connectionId, actorId) {
    const connection = await findConnection(ownerId, connectionId); if (!connection) throw httpError(404, "Boîte professionnelle introuvable.");
    try {
        const access = await mailboxAccess(connection); const client = createImapClient({ host: access.imap.host, port: access.imap.port, secure: access.imap.secure, auth: access.auth, disableAutoIdle: true });
        await client.connect(); const lock = await client.getMailboxLock("INBOX"); let fetched = 0, candidates = 0, imported = 0, maxUid = Number(connection.last_uid || 0);
        try {
            const range = maxUid > 0 ? `${maxUid + 1}:*` : await recentUids(client);
            if (Array.isArray(range) && !range.length) return await completeSync(connectionId, { fetched, candidates, imported, maxUid });
            for await (const item of client.fetch(range, { uid: true, source: true }, { uid: true })) {
                if (!item.source || Number(item.uid) <= maxUid) continue; maxUid = Math.max(maxUid, Number(item.uid)); fetched += 1;
                const parsed = await simpleParser(item.source, { skipHtmlToText: false, maxHtmlLengthToParse: 2 * 1024 * 1024 });
                const saved = await saveParsedEmail(connection, item.uid, parsed); if (!saved) continue;
                candidates += 1;
                if (connection.selection_mode === "automatic" && saved.trustedSender && saved.score >= Number(connection.automatic_threshold || AUTO_THRESHOLD)) { await importCandidate(ownerId, saved.id, actorId); imported += 1; }
            }
        } finally { lock.release(); await client.logout(); }
        return completeSync(connectionId, { fetched, candidates, imported, maxUid });
    } catch (error) { await getPool().query("UPDATE depannhome_partner_email_connections SET last_error=$3,last_sync_at=NOW(),updated_at=NOW() WHERE id=$1 AND owner_id=$2", [connectionId, ownerId, clean(publicMailError(error), 500)]); throw httpError(502, publicMailError(error)); }
}

async function saveParsedEmail(connection, uid, parsed) {
    const from = parsed.from?.value?.[0] || {}; const messageId = clean(parsed.messageId || `uid-${uid}@${connection.email_address}`, 500);
    let totalAttachmentBytes = 0;
    const attachments = (parsed.attachments || []).filter(item => { const allowed = ALLOWED_MIME.has(item.contentType) && item.size > 0 && item.size <= MAX_ATTACHMENT_BYTES && totalAttachmentBytes + item.size <= 20 * 1024 * 1024; if (allowed) totalAttachmentBytes += item.size; return allowed; }).slice(0, MAX_ATTACHMENTS);
    const classification = classifyPartnerEmail({ subject: parsed.subject, text: parsed.text, from: from.address, attachments, allowedSenders: connection.allowed_senders || [], automatic: Boolean(parsed.headers?.get("auto-submitted")) || /^\s*(?:re|tr)?\s*:\s*(?:réponse automatique|automatic reply|out of office)/i.test(parsed.subject || ""), listMail: Boolean(parsed.headers?.get("list-unsubscribe") || parsed.headers?.get("list-id")) });
    const { rows } = await getPool().query(`INSERT INTO depannhome_partner_email_messages(owner_id,connection_id,uid,message_id,in_reply_to,references_header,sender_address,sender_name,recipients,subject,body_text,received_at,classification_score,classification_reasons) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14::jsonb) ON CONFLICT(owner_id,connection_id,message_id) DO NOTHING RETURNING id`, [connection.owner_id, connection.id, uid, messageId, clean(parsed.inReplyTo, 500), clean((parsed.references || []).join(" "), 4000), clean(from.address, 254), clean(from.name, 160), JSON.stringify(parsed.to?.value?.map(item => item.address).filter(Boolean) || []), clean(parsed.subject, 500), String(parsed.text || "").slice(0, 20000), parsed.date || new Date(), classification.score, JSON.stringify(classification.reasons)]);
    if (!rows[0]) return null;
    for (const attachment of attachments) await getPool().query("INSERT INTO depannhome_partner_email_attachments(owner_id,email_message_id,filename,mime_type,file_size,content_id,file_data) VALUES($1,$2,$3,$4,$5,$6,$7)", [connection.owner_id, rows[0].id, safeFilename(attachment.filename), attachment.contentType, attachment.size, clean(attachment.contentId, 255), attachment.content]);
    return { id: rows[0].id, score: classification.score, trustedSender: classification.trustedSender };
}

async function importCandidate(ownerId, emailId, actorId) {
    const { rows } = await getPool().query(`SELECT message.*,connection.display_name,connection.email_address,connection.id AS email_connection_id,COALESCE(json_agg(json_build_object('name',attachment.filename,'mime',attachment.mime_type,'size',attachment.file_size,'dataUrl','data:'||attachment.mime_type||';base64,'||encode(attachment.file_data,'base64')) ORDER BY attachment.id) FILTER(WHERE attachment.id IS NOT NULL AND attachment.selected=TRUE),'[]'::json) AS attachments FROM depannhome_partner_email_messages message JOIN depannhome_partner_email_connections connection ON connection.id=message.connection_id LEFT JOIN depannhome_partner_email_attachments attachment ON attachment.email_message_id=message.id WHERE message.id=$1 AND message.owner_id=$2 AND message.status='candidate' GROUP BY message.id,connection.id`, [emailId, ownerId]);
    const email = rows[0]; if (!email) throw httpError(404, "E-mail déjà traité ou introuvable.");
    const claimed = await getPool().query("UPDATE depannhome_partner_email_messages SET status='processing' WHERE id=$1 AND owner_id=$2 AND status='candidate' RETURNING id", [email.id, ownerId]);
    if (!claimed.rowCount) throw httpError(409, "Cet e-mail est déjà en cours de traitement.");
    try {
        const documentText = await extractPartnerDocumentText(email.attachments);
        const payload = extractMissionPayload(email, documentText);
        const result = await ingestEmailPartnerMission({ ownerId, connectionId: email.email_connection_id, emailId: email.id, partnerName: email.display_name || email.sender_address, actorId, payload });
        for (const attachment of email.attachments || []) {
            const match = /^data:([^;]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(attachment.dataUrl || ""));
            if (!match) continue;
            await recordMissionDialogueDocument({ ownerId, missionId: result.missionId, actorName: email.sender_name || email.sender_address, body: `Document reçu par e-mail : ${attachment.name}`, attachment: { filename: attachment.name, mimeType: match[1], buffer: Buffer.from(match[2], "base64"), type: match[1].startsWith("image/") ? "photo" : "document" }, partnerVisible: false, eventType: "email_attachment_received" });
        }
        await getPool().query("UPDATE depannhome_partner_email_messages SET status='imported',mission_id=$3,processed_at=NOW() WHERE id=$1 AND owner_id=$2 AND status='processing'", [email.id, ownerId, result.missionId]);
        return result;
    } catch (error) { await getPool().query("UPDATE depannhome_partner_email_messages SET status='candidate' WHERE id=$1 AND owner_id=$2 AND status='processing'", [email.id, ownerId]); throw error; }
}

export function extractMissionPayload(email, documentText = "") {
    const emailText = `${email.subject || ""}\n${email.body_text || ""}`;
    const emailFields = extractMissionFields(emailText);
    const documentFields = extractMissionFields(documentText);
    const value = key => emailFields[key] || documentFields[key] || "";
    const firstName = value("firstName"), lastName = value("lastName");
    let name = emailFields.insuredName || documentFields.insuredName || value("name");
    if (firstName && lastName && (!name || name.toLowerCase() === lastName.toLowerCase())) name = `${firstName} ${lastName}`;
    name ||= [firstName, lastName].filter(Boolean).join(" ") || "Client à identifier";
    const postalCode = value("postalCode");
    let address = value("address");
    if (postalCode && address && !address.includes(postalCode)) address = `${address}, ${postalCode}`;
    return {
        id: `email-${email.id}`,
        missionNumber: value("missionNumber") || `MAIL-${email.id}`,
        partnerReference: clean(email.message_id, 160),
        subject: email.subject,
        interventionType: value("interventionType") || clean(email.subject, 160),
        description: clean(email.body_text, 2000),
        client: { name, firstName, lastName, phone: value("phone"), email: value("email"), address, city: value("city") },
        claimNumber: value("claimNumber"),
        insurance: value("insurance"),
        expert: value("expert"),
        manager: value("manager"),
        principal: value("principal"),
        priority: /urgent|urgence|prioritaire/i.test(`${emailText}\n${documentText}`) ? "urgent" : "normal",
        attachments: email.attachments || [],
        sourceEmail: { from: email.sender_address, subject: email.subject, receivedAt: email.received_at }
    };
}

function extractMissionFields(text) {
    const field = pattern => clean(pattern.exec(String(text || ""))?.[1], 255);
    return {
        insuredName: field(/^(?:assuré(?:e)?|nom(?:\s+et\s+pr[ée]nom)?\s+(?:de\s+l['’])?assuré(?:e)?)\s*[:\-]\s*([^\n\r]+)/im),
        name: field(/^(?:client|bénéficiaire|occupant|nom(?:\s+(?:et\s+pr[ée]nom|du\s+client))?)\s*[:\-]\s*([^\n\r]+)/im),
        firstName: field(/^pr[ée]nom(?:\s+(?:de\s+l['’])?assuré(?:e)?)?\s*[:\-]\s*([^\n\r]+)/im),
        lastName: field(/^nom(?:\s+de\s+famille)?(?:\s+(?:de\s+l['’])?assuré(?:e)?)?\s*[:\-]\s*([^\n\r]+)/im),
        phone: field(/^(?:t[ée]l(?:[ée]phone)?|portable|mobile)\s*[:\-]\s*([+\d .()\/-]{8,})/im),
        email: field(/^(?:e-?mail|courriel)\s*[:\-]\s*([^\s<>]+@[^\s<>]+)/im).replace(/[.,;:)]+$/, ""),
        address: field(/^(?:adresse(?:\s+(?:client|du\s+client))?|lieu\s+d['’]intervention|adresse\s+d['’]intervention)\s*[:\-]\s*([^\n\r]+)/im),
        postalCode: field(/^(?:code\s+postal|cp)\s*[:\-]\s*(\d{5})/im),
        city: field(/^(?:ville|commune)\s*[:\-]\s*([^\n\r]+)/im),
        missionNumber: field(/^(?:mission|dossier|référence|ref)\s*(?:n°|no|numéro)?\s*[:#\-]?\s*([A-Z0-9][A-Z0-9/_-]{2,})/im),
        interventionType: field(/^(?:intervention|objet|nature|type\s+d['’]intervention)\s*[:\-]\s*([^\n\r]+)/im),
        claimNumber: field(/^(?:sinistre|n°\s+de\s+sinistre)\s*(?:n°|no|numéro)?\s*[:#\-]?\s*([A-Z0-9][A-Z0-9/_-]*)/im),
        insurance: field(/^(?:assurance|assureur|compagnie)\s*[:\-]\s*([^\n\r]+)/im),
        expert: field(/^expert\s*[:\-]\s*([^\n\r]+)/im),
        manager: field(/^(?:gestionnaire|chargé(?:e)?\s+de\s+dossier)\s*[:\-]\s*([^\n\r]+)/im),
        principal: field(/^(?:donneur\s+d['’]ordre|mandant)\s*[:\-]\s*([^\n\r]+)/im)
    };
}

export async function notifyEmailMissionStatus(ownerId, missionId, status, details = {}) {
    const { rows } = await getPool().query(`SELECT connection.send_status_updates FROM depannhome_partner_email_messages message JOIN depannhome_partner_email_connections connection ON connection.id=message.connection_id WHERE message.owner_id=$1 AND message.mission_id=$2 AND message.status='imported' ORDER BY message.id LIMIT 1`, [ownerId, missionId]);
    if (!rows[0]?.send_status_updates) return false;
    await sendMissionEmail(ownerId, missionId, `Mise à jour de votre mission : ${statusLabel(status)}.${details?.note ? `\n${clean(details.note, 1000)}` : ""}`, { statusUpdate: true }); return true;
}

async function sendMissionEmail(ownerId, missionId, body, { statusUpdate, attachments = [] }) {
    const { rows } = await getPool().query(`SELECT message.sender_address,message.subject,message.message_id,message.references_header,connection.* FROM depannhome_partner_email_messages message JOIN depannhome_partner_email_connections connection ON connection.id=message.connection_id WHERE message.owner_id=$1 AND message.mission_id=$2 AND message.status='imported' ORDER BY message.id LIMIT 1`, [ownerId, missionId]);
    const source = rows[0]; if (!source) throw httpError(404, "Aucun e-mail source n’est lié à cette mission.");
    const access = await mailboxAccess(source); const transporter = nodemailer.createTransport({ host: access.smtp.host, port: access.smtp.port, secure: access.smtp.secure, requireTLS: !access.smtp.secure, auth: access.smtpAuth });
    await transporter.sendMail({ from: { name: source.display_name || source.email_address, address: source.email_address }, to: source.sender_address, subject: `${/^re:/i.test(source.subject) ? "" : "Re: "}${source.subject}`, text: body, attachments, inReplyTo: source.message_id, references: [source.references_header, source.message_id].filter(Boolean).join(" "), headers: { "X-DepannHome-Mission": String(missionId), "X-DepannHome-Status-Update": statusUpdate ? "true" : "false" } });
}

async function mailboxAccess(connection) {
    let credentials = decryptElectronicInvoicingCredentials(connection.encrypted_credentials);
    if (["google", "microsoft"].includes(connection.provider) && (!credentials.accessToken || new Date(credentials.expiresAt || 0).getTime() < Date.now() + 60000)) {
        const tokens = await refreshOauth(connection.provider, credentials.refreshToken); credentials = { ...credentials, accessToken: tokens.access_token, refreshToken: tokens.refresh_token || credentials.refreshToken, expiresAt: new Date(Date.now() + Number(tokens.expires_in || 3600) * 1000).toISOString() };
        await getPool().query("UPDATE depannhome_partner_email_connections SET encrypted_credentials=$2,updated_at=NOW() WHERE id=$1", [connection.id, encryptElectronicInvoicingCredentials(credentials)]);
    }
    const server = connection.server_configuration || {};
    if (connection.provider === "google") return { imap: { host: "imap.gmail.com", port: 993, secure: true }, smtp: { host: "smtp.gmail.com", port: 465, secure: true }, auth: { user: connection.email_address, accessToken: credentials.accessToken }, smtpAuth: { type: "OAuth2", user: connection.email_address, accessToken: credentials.accessToken } };
    if (connection.provider === "microsoft") return { imap: { host: "outlook.office365.com", port: 993, secure: true }, smtp: { host: "smtp.office365.com", port: 587, secure: false }, auth: { user: connection.email_address, accessToken: credentials.accessToken }, smtpAuth: { type: "OAuth2", user: connection.email_address, accessToken: credentials.accessToken } };
    return { imap: server.imap, smtp: server.smtp, auth: { user: credentials.username, pass: credentials.password }, smtpAuth: { user: credentials.username, pass: credentials.password } };
}

async function testMailbox(connection) { const access = await mailboxAccess({ ...connection, id: 0, encrypted_credentials: encryptElectronicInvoicingCredentials(connection.credentials), server_configuration: connection.server }); const client = createImapClient({ host: access.imap.host, port: access.imap.port, secure: access.imap.secure, auth: access.auth }); await client.connect(); await client.logout(); const smtp = nodemailer.createTransport({ host: access.smtp.host, port: access.smtp.port, secure: access.smtp.secure, requireTLS: !access.smtp.secure, auth: access.smtpAuth, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000 }); await smtp.verify(); }
function createImapClient(options) { const client = new ImapFlow({ ...options, logger: false, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000 }); client.on("error", error => console.warn("[partner-email] erreur IMAP contrôlée :", publicMailError(error))); return client; }
async function findConnection(ownerId, id) { const { rows } = await getPool().query("SELECT * FROM depannhome_partner_email_connections WHERE id=$1 AND owner_id=$2 AND enabled=TRUE", [id, ownerId]); return rows[0] || null; }
async function recentUids(client) { const ids = await client.search({ since: new Date(Date.now() - 14 * 86400000) }, { uid: true }); return ids.slice(-FETCH_LIMIT); }
async function completeSync(connectionId, stats) { await getPool().query("UPDATE depannhome_partner_email_connections SET last_uid=GREATEST(last_uid,$2),last_sync_at=NOW(),last_error='',updated_at=NOW() WHERE id=$1", [connectionId, stats.maxUid]); return stats; }

function sanitizeImapConfiguration(value) { const emailAddress = clean(value?.emailAddress, 254).toLowerCase(), username = clean(value?.username || emailAddress, 254), password = String(value?.password || "").trim().slice(0, 1000), selectionMode = MODES.has(value?.selectionMode) ? value.selectionMode : "manual"; const imapHost = host(value?.imapHost), smtpHost = host(value?.smtpHost), imapPort = port(value?.imapPort, 993), smtpPort = port(value?.smtpPort, 465); if (!/^\S+@\S+\.\S+$/.test(emailAddress) || !imapHost || !smtpHost || !username) return { ok: false, message: "Renseignez l’adresse, l’utilisateur et les serveurs IMAP/SMTP de la boîte professionnelle." }; return { ok: true, emailAddress, username, password, displayName: clean(value?.displayName, 160), selectionMode, allowedSenders: sanitizeSenders(value?.allowedSenders), automaticThreshold: Math.max(70, Math.min(100, Number(value?.automaticThreshold) || AUTO_THRESHOLD)), sendStatusUpdates: Boolean(value?.sendStatusUpdates), server: { imap: { host: imapHost, port: imapPort, secure: value?.imapSecure !== false }, smtp: { host: smtpHost, port: smtpPort, secure: !(value?.smtpSecure === false || String(value?.smtpSecure) === "false") } } }; }
function outgoingAttachments(value) { let total = 0; const result = []; for (const item of Array.isArray(value) ? value.slice(0, 5) : []) { const match = /^data:([^;]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(item?.dataUrl || "")); if (!match || !ALLOWED_MIME.has(match[1])) throw httpError(400, "Un document à envoyer possède un format non autorisé."); const content = Buffer.from(match[2], "base64"); if (!content.length || content.length > MAX_ATTACHMENT_BYTES || total + content.length > 20 * 1024 * 1024) throw httpError(400, "Les documents à envoyer dépassent la limite autorisée."); total += content.length; result.push({ filename: safeFilename(item?.name), contentType: match[1], content }); } return result; }
function sanitizeSenders(value) { return [...new Set((Array.isArray(value) ? value : String(value || "").split(/[,;\n]/)).map(item => clean(item, 254).toLowerCase().replace(/^@/, "")).filter(item => /^\S+@\S+\.\S+$/.test(item) || /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(item)))].slice(0, 100); }
function isMicrosoftMailbox(value) { const domain = String(value || "").toLowerCase().split("@").pop(); return /^(?:(?:outlook|hotmail|live)\.[a-z.]+|msn\.com)$/.test(domain); }
function oauthConfigured(provider) { const prefix = provider === "google" ? "GOOGLE_MAIL" : provider === "microsoft" ? "MICROSOFT_MAIL" : ""; return Boolean(prefix && process.env[`${prefix}_CLIENT_ID`] && process.env[`${prefix}_CLIENT_SECRET`] && process.env[`${prefix}_REDIRECT_URI`]); }
function oauthSettings(provider) { const prefix = provider === "google" ? "GOOGLE_MAIL" : "MICROSOFT_MAIL"; return { clientId: process.env[`${prefix}_CLIENT_ID`], clientSecret: process.env[`${prefix}_CLIENT_SECRET`], redirectUri: process.env[`${prefix}_REDIRECT_URI`] }; }
function oauthAuthorizationUrl(provider, state, verifier) { const settings = oauthSettings(provider), challenge = crypto.createHash("sha256").update(verifier).digest("base64url"); const url = new URL(provider === "google" ? "https://accounts.google.com/o/oauth2/v2/auth" : "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"); url.search = new URLSearchParams({ client_id: settings.clientId, redirect_uri: settings.redirectUri, response_type: "code", state, code_challenge: challenge, code_challenge_method: "S256", access_type: "offline", prompt: "consent", scope: provider === "google" ? "openid email profile https://mail.google.com/" : "openid email profile offline_access User.Read https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send" }).toString(); return url.toString(); }
async function exchangeOauthCode(provider, code, verifier) { return oauthToken(provider, { grant_type: "authorization_code", code, redirect_uri: oauthSettings(provider).redirectUri, code_verifier: verifier }); }
async function refreshOauth(provider, refreshToken) { if (!refreshToken) throw new Error("Autorisation expirée : reconnectez la boîte."); return oauthToken(provider, { grant_type: "refresh_token", refresh_token: refreshToken }); }
async function oauthToken(provider, values) { const settings = oauthSettings(provider); const response = await fetch(provider === "google" ? "https://oauth2.googleapis.com/token" : "https://login.microsoftonline.com/common/oauth2/v2.0/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...values, client_id: settings.clientId, client_secret: settings.clientSecret }), signal: AbortSignal.timeout(15000) }); const payload = await response.json().catch(() => ({})); if (!response.ok || !payload.access_token) throw new Error("Le fournisseur de messagerie a refusé l’autorisation."); return payload; }
async function oauthIdentity(provider, accessToken) { const response = await fetch(provider === "google" ? "https://openidconnect.googleapis.com/v1/userinfo" : "https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName", { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15000) }); const value = await response.json(); const email = clean(value.email || value.mail || value.userPrincipalName, 254).toLowerCase(); if (!response.ok || !email) throw new Error("Impossible d’identifier la boîte autorisée."); return { email, name: clean(value.name || value.displayName, 160) }; }
function oauthPopup(res, success, message) { res.type("html").send(`<!doctype html><meta charset="utf-8"><title>Connexion boîte mail</title><p>${escapeHtml(message)}</p><script>window.opener?.postMessage(${JSON.stringify({ type: "depannhome:partner-email-oauth", success, message })},window.location.origin);window.close();</script>`); }
function requireEmailAccess(req, res, next) { if (!ADMIN_ROLES.has(req.user?.role)) return res.status(403).json({ message: "La boîte de missions est réservée aux postes autorisés." }); return next(); }
function selectedIds(value) { return [...new Set((Array.isArray(value) ? value : []).map(positiveId).filter(Boolean))].slice(0, 100); }
function publicMailError(error, { configuration = false } = {}) { const message = String(error?.message || ""); if (/auth|credential|login|password|invalid credentials|authentication failed/i.test(message)) return "La boîte a refusé l’authentification. Vérifiez son autorisation ou son mot de passe d’application."; if (/certificate|tls|ssl|self[- ]signed/i.test(message)) return "La connexion sécurisée au serveur de messagerie a échoué."; if (/timeout|timed out|etimedout|econnrefused|enotfound|getaddrinfo/i.test(message)) return "Le serveur de messagerie ne répond pas. Vérifiez les adresses, les ports et la disponibilité d’IMAP/SMTP."; return configuration ? "La vérification IMAP/SMTP a échoué. Vérifiez les serveurs, les ports et le mode de sécurité." : "La boîte professionnelle n’a pas pu être synchronisée."; }
function statusLabel(value) { return ({ pending_validation: "en attente de validation", accepted: "acceptée", rejected: "refusée", scheduled: "planifiée", en_route: "technicien en route", on_site: "technicien sur site", report_completed: "rapport terminé", report_validated: "rapport validé", quote_sent: "devis envoyé", work_completed: "travaux terminés", invoice_sent: "facture envoyée", closed: "clôturée", cancelled: "annulée" })[value] || value; }
function host(value) { const text = clean(value, 255).toLowerCase(); return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(text) ? text : ""; }
function port(value, fallback) { const number = Number(value || fallback); return Number.isSafeInteger(number) && number > 0 && number <= 65535 ? number : fallback; }
function positiveId(value) { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : 0; }
function safeFilename(value) { return String(value || "document").replace(/^.*[\\/]/, "").replace(/[\r\n]/g, " ").slice(0, 255) || "document"; }
function clean(value, max) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, max); }
function hash(value) { return crypto.createHash("sha256").update(String(value || "")).digest("hex"); }
function escapeHtml(value) { return String(value || "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }
function httpError(status, message) { const error = new Error(message); error.status = status; return error; }
function asyncHandler(handler) { return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(error => error.status ? res.status(error.status).json({ message: error.message }) : next(error)); }
