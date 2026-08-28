import crypto from "node:crypto";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { getPool } from "./database.js";
import { recordHealthSchedulerRun } from "./health-dashboard.js";
import { getAccountOwnerId } from "./auth.js";
import { getOrganization, isFeatureEnabled } from "./organizations.js";
import { decryptElectronicInvoicingCredentials, encryptElectronicInvoicingCredentials } from "./electronic-invoicing.js";
import { ingestEmailPartnerMission } from "./partner-missions.js";
import { recordMissionDialogueDocument, recordMissionDialogueEvent } from "./partner-dialogue.js";
import { extractPartnerDocumentText, normalizePartnerDocumentMime } from "./partner-email-document-extractor.js";
import { hasCompanyEmailWorkspaceAccess } from "./workstation-permissions.js";

const PROVIDERS = new Set(["google", "microsoft", "imap"]);
const MODES = new Set(["manual", "automatic"]);
const ALLOWED_MIME = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "text/plain"]);
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const MAX_NESTED_EMAIL_DEPTH = 3;
const MAX_NESTED_EMAILS = 10;
const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_NESTED_EMAIL_SOURCE_BYTES = 25 * 1024 * 1024;
const AUTO_THRESHOLD = 80;
const CANDIDATE_THRESHOLD = 35;
const FETCH_LIMIT = 100;
const PERIOD_FETCH_LIMIT = 500;
const LIVE_MAILBOX_DEFAULT_LIMIT = 30;
const LIVE_MAILBOX_MAX_LIMIT = 50;
const LIVE_MAILBOX_BODY_BYTES = 512 * 1024;
const MICROSOFT_IDENTITY_SCOPES = "openid email profile offline_access User.Read";
const MICROSOFT_MAIL_SCOPES = "Mail.Read Mail.Send";
const MICROSOFT_GRAPH_MAX_RETRIES = 2;
const MICROSOFT_GRAPH_MAX_RETRY_DELAY_MS = 10_000;
const PARTNER_EMAIL_SYNC_INTERVAL_MS = 10 * 60 * 1000;
let scheduler = null;
const activeMailboxSynchronizations = new Set();

export async function initializePartnerEmail() {
    const db = getPool();
    await db.query(`CREATE TABLE IF NOT EXISTS depannhome_partner_email_connections (
        id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
        provider VARCHAR(20) NOT NULL CHECK(provider IN ('google','microsoft','imap')), email_address VARCHAR(254) NOT NULL,
        display_name VARCHAR(160) NOT NULL DEFAULT '', encrypted_credentials TEXT NOT NULL,
        server_configuration JSONB NOT NULL DEFAULT '{}'::jsonb, selection_mode VARCHAR(20) NOT NULL DEFAULT 'manual' CHECK(selection_mode IN ('manual','automatic')),
        allowed_senders JSONB NOT NULL DEFAULT '[]'::jsonb, required_keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
        automatic_threshold INTEGER NOT NULL DEFAULT 80 CHECK(automatic_threshold BETWEEN 70 AND 100),
        send_status_updates BOOLEAN NOT NULL DEFAULT FALSE, auto_search_enabled BOOLEAN NOT NULL DEFAULT FALSE, enabled BOOLEAN NOT NULL DEFAULT TRUE,
        last_uid BIGINT NOT NULL DEFAULT 0, last_sync_at TIMESTAMPTZ, last_error VARCHAR(500) NOT NULL DEFAULT '',
        created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT depannhome_partner_email_owner_address_unique UNIQUE(owner_id,email_address)
    )`);
    await db.query("ALTER TABLE depannhome_partner_email_connections ADD COLUMN IF NOT EXISTS auto_search_enabled BOOLEAN NOT NULL DEFAULT FALSE");
    await db.query("ALTER TABLE depannhome_partner_email_connections ADD COLUMN IF NOT EXISTS required_keywords JSONB NOT NULL DEFAULT '[]'::jsonb");
    await db.query("CREATE INDEX IF NOT EXISTS depannhome_partner_email_connections_auto_search_idx ON depannhome_partner_email_connections(auto_search_enabled,enabled,last_sync_at)");
    await db.query(`CREATE TABLE IF NOT EXISTS depannhome_partner_email_messages (
        id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
        connection_id BIGINT NOT NULL REFERENCES depannhome_partner_email_connections(id) ON DELETE CASCADE,
        uid BIGINT NOT NULL, message_id VARCHAR(500) NOT NULL, in_reply_to VARCHAR(500) NOT NULL DEFAULT '', references_header TEXT NOT NULL DEFAULT '',
        sender_address VARCHAR(254) NOT NULL, sender_name VARCHAR(160) NOT NULL DEFAULT '', recipients JSONB NOT NULL DEFAULT '[]'::jsonb,
        subject VARCHAR(500) NOT NULL DEFAULT '', body_text TEXT NOT NULL DEFAULT '', received_at TIMESTAMPTZ NOT NULL,
        document_text TEXT NOT NULL DEFAULT '',
        classification_score INTEGER NOT NULL DEFAULT 0, classification_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
        status VARCHAR(20) NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate','processing','imported','ignored','rejected')),
        mission_id BIGINT REFERENCES depannhome_partner_missions(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), processed_at TIMESTAMPTZ,
        CONSTRAINT depannhome_partner_email_message_unique UNIQUE(owner_id,connection_id,message_id)
    )`);
    await db.query("ALTER TABLE depannhome_partner_email_messages DROP CONSTRAINT IF EXISTS depannhome_partner_email_messages_status_check");
    await db.query("ALTER TABLE depannhome_partner_email_messages ADD COLUMN IF NOT EXISTS document_text TEXT NOT NULL DEFAULT ''");
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
        try {
            const context = decryptElectronicInvoicingCredentials(pending.encrypted_context);
            const identityTokens = await exchangeOauthCode(provider, String(req.query.code), context.verifier);
            const identity = await oauthIdentity(provider, identityTokens.access_token);
            const mailboxTokens = identityTokens;
            const encrypted = encryptElectronicInvoicingCredentials({ accessToken: mailboxTokens.access_token, refreshToken: mailboxTokens.refresh_token || identityTokens.refresh_token, expiresAt: new Date(Date.now() + Number(mailboxTokens.expires_in || 3600) * 1000).toISOString() });
            await getPool().query(`INSERT INTO depannhome_partner_email_connections(owner_id,provider,email_address,display_name,encrypted_credentials,server_configuration,selection_mode,allowed_senders,required_keywords,send_status_updates,auto_search_enabled,created_by,last_error) VALUES($1,$2,$3,$4,$5,'{}'::jsonb,$6,$7::jsonb,$8::jsonb,$9,$10,$11,'') ON CONFLICT(owner_id,email_address) DO UPDATE SET provider=EXCLUDED.provider,display_name=EXCLUDED.display_name,encrypted_credentials=EXCLUDED.encrypted_credentials,selection_mode=EXCLUDED.selection_mode,allowed_senders=EXCLUDED.allowed_senders,required_keywords=EXCLUDED.required_keywords,send_status_updates=EXCLUDED.send_status_updates,auto_search_enabled=EXCLUDED.auto_search_enabled,enabled=TRUE,last_error='',updated_at=NOW()`, [pending.owner_id, provider, identity.email, identity.name, encrypted, context.selectionMode, JSON.stringify(context.allowedSenders || []), JSON.stringify(context.requiredKeywords || []), context.sendStatusUpdates, context.autoSearchEnabled, pending.actor_id]);
            return oauthPopup(res, true, "Boîte professionnelle connectée.");
        } catch (error) {
            console.warn("[partner-email-oauth] authorization rejected", oauthErrorLog(error, provider));
            return oauthPopup(res, false, oauthErrorMessage(error, provider));
        }
    }));
    app.use("/api/partner-email", requireAuthentication, requireEmailAccess);
    app.get("/api/partner-email", asyncHandler(async (req, res) => {
        const ownerId = getAccountOwnerId(req);
        const [connections, messages] = await Promise.all([
            getPool().query(`SELECT id,provider,email_address AS "emailAddress",display_name AS "displayName",selection_mode AS "selectionMode",allowed_senders AS "allowedSenders",required_keywords AS "requiredKeywords",automatic_threshold AS "automaticThreshold",send_status_updates AS "sendStatusUpdates",auto_search_enabled AS "autoSearchEnabled",enabled,last_sync_at AS "lastSyncAt",last_error AS "lastError",updated_at AS "updatedAt" FROM depannhome_partner_email_connections WHERE owner_id=$1 ORDER BY updated_at DESC`, [ownerId]),
            getPool().query(`SELECT message.id,message.connection_id AS "connectionId",message.sender_address AS "senderAddress",message.sender_name AS "senderName",message.subject,message.body_text AS "bodyText",message.received_at AS "receivedAt",message.classification_score AS "classificationScore",message.classification_reasons AS "classificationReasons",message.status,message.mission_id AS "missionId",COALESCE(json_agg(json_build_object('id',attachment.id,'filename',attachment.filename,'mimeType',attachment.mime_type,'fileSize',attachment.file_size,'selected',attachment.selected) ORDER BY attachment.id) FILTER(WHERE attachment.id IS NOT NULL),'[]'::json) AS attachments FROM depannhome_partner_email_messages message LEFT JOIN depannhome_partner_email_attachments attachment ON attachment.email_message_id=message.id WHERE message.owner_id=$1 AND message.status='candidate' GROUP BY message.id ORDER BY message.received_at DESC LIMIT 200`, [ownerId])
        ]);
        res.json({ connections: connections.rows, candidates: messages.rows, oauth: { google: oauthConfigured("google"), microsoft: oauthConfigured("microsoft") } });
    }));
    app.put("/api/partner-email/configuration", requireEmailConfigurationAccess, asyncHandler(async (req, res) => {
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
        const credentials = { username: input.username, password: normalizeMailboxPassword(input.emailAddress, input.password || old.password || "") };
        if (!credentials.password) return res.status(400).json({ message: "Le mot de passe d’application est obligatoire lors de la première connexion." });
        try { await testMailbox({ provider: "imap", emailAddress: input.emailAddress, credentials, server: input.server }); }
        catch (error) { throw httpError(422, publicMailError(error, { configuration: true })); }
        const encrypted = encryptElectronicInvoicingCredentials(credentials);
        const { rows } = await getPool().query(`INSERT INTO depannhome_partner_email_connections(owner_id,provider,email_address,display_name,encrypted_credentials,server_configuration,selection_mode,allowed_senders,required_keywords,automatic_threshold,send_status_updates,auto_search_enabled,created_by,last_error) VALUES($1,'imap',$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,'') ON CONFLICT(owner_id,email_address) DO UPDATE SET provider='imap',display_name=EXCLUDED.display_name,encrypted_credentials=EXCLUDED.encrypted_credentials,server_configuration=EXCLUDED.server_configuration,selection_mode=EXCLUDED.selection_mode,allowed_senders=EXCLUDED.allowed_senders,required_keywords=EXCLUDED.required_keywords,automatic_threshold=EXCLUDED.automatic_threshold,send_status_updates=EXCLUDED.send_status_updates,auto_search_enabled=EXCLUDED.auto_search_enabled,enabled=TRUE,last_error='',updated_at=NOW() RETURNING id`, [ownerId, input.emailAddress, input.displayName, encrypted, JSON.stringify(input.server), input.selectionMode, JSON.stringify(input.allowedSenders), JSON.stringify(input.requiredKeywords), input.automaticThreshold, input.sendStatusUpdates, Boolean(req.body?.autoSearchEnabled), req.user.sub]);
        res.json({ id: rows[0].id, message: "Boîte professionnelle connectée et vérifiée." });
    }));
    app.post("/api/partner-email/oauth/:provider/authorize", requireEmailConfigurationAccess, asyncHandler(async (req, res) => {
        const provider = String(req.params.provider || "");
        if (!oauthConfigured(provider)) return res.status(503).json({ message: `La connexion ${provider === "google" ? "Google" : "Microsoft"} n’est pas encore configurée sur le serveur.` });
        const state = crypto.randomBytes(32).toString("base64url"); const verifier = crypto.randomBytes(48).toString("base64url");
        const context = { verifier, selectionMode: MODES.has(req.body?.selectionMode) ? req.body.selectionMode : "manual", sendStatusUpdates: Boolean(req.body?.sendStatusUpdates), autoSearchEnabled: Boolean(req.body?.autoSearchEnabled), allowedSenders: sanitizeSenders(req.body?.allowedSenders), requiredKeywords: sanitizeRequiredKeywords(req.body?.requiredKeywords) };
        await getPool().query("INSERT INTO depannhome_partner_email_oauth_states(state_hash,owner_id,actor_id,provider,encrypted_context,expires_at) VALUES($1,$2,$3,$4,$5,NOW()+INTERVAL '10 minutes')", [hash(state), getAccountOwnerId(req), req.user.sub, provider, encryptElectronicInvoicingCredentials(context)]);
        res.json({ authorizationUrl: oauthAuthorizationUrl(provider, state, verifier) });
    }));
    app.get("/api/partner-email/:connectionId/inbox", asyncHandler(async (req, res) => {
        const connection = await requiredConnection(getAccountOwnerId(req), positiveId(req.params.connectionId));
        const result = await liveMailboxOperation(connection, () => listLiveInbox(connection, parseMailboxPage(req.query)));
        setLiveMailboxHeaders(res).json(result);
    }));
    app.get("/api/partner-email/:connectionId/messages/:messageRef", asyncHandler(async (req, res) => {
        const connection = await requiredConnection(getAccountOwnerId(req), positiveId(req.params.connectionId));
        const result = await liveMailboxOperation(connection, () => readLiveMessage(connection, decodeMailboxReference(req.params.messageRef)));
        setLiveMailboxHeaders(res).json(result);
    }));
    app.post("/api/partner-email/:connectionId/messages/:messageRef/reply", asyncHandler(async (req, res) => {
        const connection = await requiredConnection(getAccountOwnerId(req), positiveId(req.params.connectionId));
        const body = mailboxReplyBody(req.body?.body);
        if (!body) return res.status(400).json({ message: "Saisissez une réponse." });
        await liveMailboxOperation(connection, () => sendLiveMailboxReply(connection, decodeMailboxReference(req.params.messageRef), body), { sending: true });
        setLiveMailboxHeaders(res).json({ message: "Réponse envoyée depuis la boîte professionnelle." });
    }));
    app.get("/api/partner-email/:connectionId/messages/:messageRef/attachments/:attachmentRef", asyncHandler(async (req, res) => {
        const connection = await requiredConnection(getAccountOwnerId(req), positiveId(req.params.connectionId));
        const attachment = await liveMailboxOperation(connection, () => downloadLiveAttachment(connection, decodeMailboxReference(req.params.messageRef), decodeMailboxReference(req.params.attachmentRef)));
        setLiveMailboxHeaders(res).set({ "Content-Type": attachment.contentType, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`, "Content-Length": String(attachment.content.length), "X-Content-Type-Options": "nosniff" }).send(attachment.content);
    }));
    app.post("/api/partner-email/:connectionId/messages/:messageRef/import", asyncHandler(async (req, res) => {
        const ownerId = getAccountOwnerId(req);
        const connection = await requiredConnection(ownerId, positiveId(req.params.connectionId));
        const result = await importLiveMailboxMessage(connection, decodeMailboxReference(req.params.messageRef), req.body?.attachmentIds, req.user.sub);
        const message = result.created ? "Mission partenaire et fiche client créées depuis cet e-mail." : result.reanalyzed ? "Mission partenaire et fiche client actualisées après relecture des pièces jointes." : "Cet e-mail est déjà rattaché à une mission partenaire.";
        res.status(result.created ? 201 : 200).json({ ...result, message });
    }));
    app.post("/api/partner-email/:connectionId/sync", asyncHandler(async (req, res) => res.json(await syncConnection(getAccountOwnerId(req), positiveId(req.params.connectionId), req.user.sub, parseMailboxSyncPeriod(req.body)))));
    app.patch("/api/partner-email/:connectionId/settings", requireEmailConfigurationAccess, asyncHandler(async (req, res) => {
        const selectionMode = MODES.has(req.body?.selectionMode) ? req.body.selectionMode : "";
        if (!selectionMode) return res.status(400).json({ message: "Choisissez un mode de recherche valide." });
        const allowedSenders = sanitizeSenders(req.body?.allowedSenders);
        const requiredKeywords = sanitizeRequiredKeywords(req.body?.requiredKeywords);
        const automaticThreshold = Math.max(70, Math.min(100, Number(req.body?.automaticThreshold) || AUTO_THRESHOLD));
        const { rows } = await getPool().query(`
            UPDATE depannhome_partner_email_connections
            SET selection_mode=$3, allowed_senders=$4::jsonb, required_keywords=$5::jsonb, automatic_threshold=$6,
                send_status_updates=$7, auto_search_enabled=$8, updated_at=NOW()
            WHERE id=$1 AND owner_id=$2 AND enabled=TRUE
            RETURNING selection_mode AS "selectionMode", allowed_senders AS "allowedSenders",
                required_keywords AS "requiredKeywords", automatic_threshold AS "automaticThreshold", send_status_updates AS "sendStatusUpdates",
                auto_search_enabled AS "autoSearchEnabled"
        `, [positiveId(req.params.connectionId), getAccountOwnerId(req), selectionMode, JSON.stringify(allowedSenders), JSON.stringify(requiredKeywords), automaticThreshold, Boolean(req.body?.sendStatusUpdates), Boolean(req.body?.autoSearchEnabled)]);
        if (!rows[0]) return res.status(404).json({ message: "Boîte professionnelle introuvable." });
        const removedCandidates = await reclassifyPendingCandidates(getAccountOwnerId(req), positiveId(req.params.connectionId), { allowedSenders, requiredKeywords });
        res.json({ ...rows[0], removedCandidates, message: `Réglages de recherche enregistrés.${removedCandidates ? ` ${removedCandidates} proposition(s) hors critères supprimée(s).` : ""}` });
    }));
    app.patch("/api/partner-email/:connectionId/automatic-search", requireEmailConfigurationAccess, asyncHandler(async (req, res) => {
        const { rows } = await getPool().query("UPDATE depannhome_partner_email_connections SET auto_search_enabled=$3,updated_at=NOW() WHERE id=$1 AND owner_id=$2 RETURNING auto_search_enabled AS \"autoSearchEnabled\"", [positiveId(req.params.connectionId), getAccountOwnerId(req), Boolean(req.body?.enabled)]);
        if (!rows[0]) return res.status(404).json({ message: "Boîte professionnelle introuvable." });
        res.json(rows[0]);
    }));
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
    app.delete("/api/partner-email/:connectionId", requireEmailConfigurationAccess, asyncHandler(async (req, res) => { await getPool().query("DELETE FROM depannhome_partner_email_connections WHERE id=$1 AND owner_id=$2", [positiveId(req.params.connectionId), getAccountOwnerId(req)]); res.status(204).end(); }));
}

export function startPartnerEmailScheduler() {
    if (scheduler) return;
    scheduler = { starting: true };
    void runPartnerEmailScheduler("startup").finally(scheduleNextPartnerEmailRun);
}

function scheduleNextPartnerEmailRun() {
    scheduler = setTimeout(() => {
        void runPartnerEmailScheduler("scheduled").finally(scheduleNextPartnerEmailRun);
    }, PARTNER_EMAIL_SYNC_INTERVAL_MS);
    scheduler.unref?.();
}

async function runPartnerEmailScheduler(source) {
    const startedAt = new Date();
    try {
        await recordHealthSchedulerRun("partner_email", source, "started", {}, startedAt);
        const result = await synchronizeDueConnections();
        await recordHealthSchedulerRun("partner_email", source, "completed", result, startedAt);
    } catch (error) {
        await recordHealthSchedulerRun("partner_email", source, "failed", { errorCode: error.code || error.name || "ERROR" }, startedAt).catch(() => {});
        console.error(`[partner-email] synchronisation ${source} :`, error.message);
    }
}

export async function synchronizeDueConnections() {
    const { rows } = await getPool().query("SELECT connection.id,connection.owner_id FROM depannhome_partner_email_connections connection JOIN depannhome_users owner ON owner.id=connection.owner_id WHERE connection.enabled=TRUE AND connection.auto_search_enabled=TRUE AND owner.is_active=TRUE AND owner.is_archived=FALSE AND (connection.last_sync_at IS NULL OR connection.last_sync_at<NOW()-INTERVAL '10 minutes') ORDER BY connection.last_sync_at NULLS FIRST LIMIT 20");
    for (const row of rows) {
        if (!isFeatureEnabled(await getOrganization(row.owner_id), "partnerMissions")) continue;
        await syncConnection(row.owner_id, row.id, null).catch(() => {});
    }
    return { selectedConnections: rows.length };
}

export function classifyPartnerEmail({ subject = "", text = "", from = "", attachments = [], allowedSenders = [], requiredKeywords = [], automatic = false, listMail = false, reply = false }) {
    if (reply || /^\s*(?:re|rép)\s*:/i.test(subject)) return { score: 0, reasons: ["Réponse à un fil existant ignorée"], trustedSender: false, likelyMission: false, keywordMatch: false };
    const haystack = `${subject}\n${stripQuotedEmailText(text)}`.toLowerCase(); const sender = String(from).toLowerCase(); let score = 0; const reasons = [];
    const add = (points, reason) => { score += points; reasons.push(reason); };
    const senderFilters = sanitizeSenders(allowedSenders); const trustedSender = senderFilters.length > 0 && senderMatchesAllowed(sender, senderFilters);
    if (senderFilters.length && !trustedSender) return { score: 0, reasons: ["Expéditeur absent des adresses partenaires recherchées"], trustedSender: false, likelyMission: false, keywordMatch: false };
    const keywords = sanitizeRequiredKeywords(requiredKeywords);
    const matches = keywords.filter(expression => keywordExpressionMatches(expression, haystack));
    if (keywords.length && !matches.length) return { score: 0, reasons: ["Aucun mot-clé obligatoire détecté"], trustedSender: false, likelyMission: false, keywordMatch: false };
    if (matches.length) add(45, `Mots-clés détectés : ${matches.join(", ")}`);
    if (/mission|intervention|ordre de service|bon de commande|sinistre|dossier|mandat|affectation/.test(haystack)) add(35, "Objet ou contenu associé à une mission");
    if (/client|assuré|adresse|téléphone|portable|lieu d'intervention|référence|n°\s*(?:de\s*)?sinistre/.test(haystack)) add(20, "Coordonnées ou référence de dossier détectées");
    if (attachments.some(item => ALLOWED_MIME.has(item.contentType))) add(20, "Document métier joint");
    if (/urgent|urgence|prioritaire|sous 24|délai/.test(haystack)) add(10, "Caractère opérationnel ou urgent");
    if (trustedSender) add(25, "Expéditeur autorisé par l’entreprise");
    if (/relance|newsletter|publicité|promotion|facture impayée|règlement|paiement|relevé|notification automatique/.test(haystack)) add(-55, "Message assimilé à une relance ou information non opérationnelle");
    if (/no-?reply|noreply|nepasrepondre/.test(sender)) add(-25, "Adresse automatique");
    if (automatic || listMail) add(-70, "Réponse automatique ou message de liste détecté");
    if (!trustedSender && score >= AUTO_THRESHOLD) { score = AUTO_THRESHOLD - 1; reasons.push("Validation humaine requise : expéditeur non autorisé"); }
    return { score: Math.max(0, Math.min(100, score)), reasons, trustedSender, likelyMission: trustedSender && score >= AUTO_THRESHOLD, keywordMatch: true };
}

async function syncConnection(ownerId, connectionId, actorId, syncPeriod = null) {
    const synchronizationKey = `${ownerId}:${connectionId}`;
    if (activeMailboxSynchronizations.has(synchronizationKey)) throw httpError(409, "Une synchronisation de cette boîte est déjà en cours. Patientez quelques instants avant de relancer la recherche.");
    activeMailboxSynchronizations.add(synchronizationKey);
    try { return await performConnectionSync(ownerId, connectionId, actorId, syncPeriod); }
    finally { activeMailboxSynchronizations.delete(synchronizationKey); }
}

async function performConnectionSync(ownerId, connectionId, actorId, syncPeriod = null) {
    const connection = await findConnection(ownerId, connectionId); if (!connection) throw httpError(404, "Boîte professionnelle introuvable.");
    try {
        if (connection.provider === "microsoft") return await syncMicrosoftConnection(connection, actorId, syncPeriod);
        const access = await mailboxAccess(connection); const client = createImapClient({ host: access.imap.host, port: access.imap.port, secure: access.imap.secure, auth: access.auth, disableAutoIdle: true });
        await client.connect(); const lock = await client.getMailboxLock("INBOX"); let fetched = 0, candidates = 0, imported = 0, maxUid = Number(connection.last_uid || 0), limited = false;
        try {
            let range;
            if (syncPeriod) {
                const search = await periodUids(client, syncPeriod); range = search.ids; limited = search.limited;
            } else range = maxUid > 0 ? `${maxUid + 1}:*` : await recentUids(client);
            if (Array.isArray(range) && !range.length) return await completeSync(connectionId, { fetched, candidates, imported, maxUid, limited, period: syncPeriod ? { from: syncPeriod.from, to: syncPeriod.to } : null }, { advanceCursor: !syncPeriod });
            for await (const item of client.fetch(range, { uid: true, source: true }, { uid: true })) {
                if (!item.source || (!syncPeriod && Number(item.uid) <= maxUid)) continue;
                if (!syncPeriod) maxUid = Math.max(maxUid, Number(item.uid)); fetched += 1;
                const parsed = await simpleParser(item.source, { skipHtmlToText: false, maxHtmlLengthToParse: 2 * 1024 * 1024 });
                const saved = await saveParsedEmail(connection, item.uid, parsed); if (!saved) continue;
                candidates += 1;
                if (saved.reanalyzeImported || (connection.selection_mode === "automatic" && saved.trustedSender && saved.score >= Number(connection.automatic_threshold || AUTO_THRESHOLD))) { await importCandidate(ownerId, saved.id, actorId); imported += 1; }
            }
        } finally { lock.release(); await client.logout(); }
        return completeSync(connectionId, { fetched, candidates, imported, maxUid, limited, period: syncPeriod ? { from: syncPeriod.from, to: syncPeriod.to } : null }, { advanceCursor: !syncPeriod });
    } catch (error) {
        const publicError = publicMailError(error, { provider: connection.provider });
        console.warn("[partner-email] mailbox synchronization rejected", mailErrorLog(error, connection.provider));
        await getPool().query("UPDATE depannhome_partner_email_connections SET last_error=$3,updated_at=NOW() WHERE id=$1 AND owner_id=$2", [connectionId, ownerId, clean(publicError, 500)]);
        const status = error?.statusCode === 429 ? 429 : error?.statusCode === 503 ? 503 : 502;
        throw httpError(status, publicError, { retryAfterSeconds: error?.retryAfterSeconds });
    }
}

async function syncMicrosoftConnection(connection, actorId, syncPeriod) {
    const access = await mailboxAccess(connection);
    const search = await graphInboxMessages(access.graphToken, connection, syncPeriod);
    let fetched = 0, candidates = 0, imported = 0;
    for (const message of search.messages) {
        const source = await graphMessageMime(access.graphToken, message.id);
        const parsed = await simpleParser(source, { skipHtmlToText: false, maxHtmlLengthToParse: 2 * 1024 * 1024 });
        fetched += 1;
        const saved = await saveParsedEmail(connection, graphMessageUid(message.id), parsed); if (!saved) continue;
        candidates += 1;
        if (saved.reanalyzeImported || (connection.selection_mode === "automatic" && saved.trustedSender && saved.score >= Number(connection.automatic_threshold || AUTO_THRESHOLD))) { await importCandidate(connection.owner_id, saved.id, actorId); imported += 1; }
    }
    return completeSync(connection.id, { fetched, candidates, imported, maxUid: Number(connection.last_uid || 0), limited: search.limited, period: syncPeriod ? { from: syncPeriod.from, to: syncPeriod.to } : null }, { advanceCursor: false });
}

async function listLiveInbox(connection, page) {
    if (connection.provider === "microsoft") {
        const access = await mailboxAccess(connection);
        const query = new URLSearchParams({ "$select": "id,subject,from,receivedDateTime,isRead,hasAttachments,bodyPreview", "$orderby": "receivedDateTime desc", "$top": String(page.limit + 1), "$skip": String(page.offset) });
        const payload = await graphJson(access.graphToken, `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?${query}`);
        const values = Array.isArray(payload.value) ? payload.value.filter(message => message?.id) : [];
        return mailboxPageResult(page, values.slice(0, page.limit).map(message => ({ id: encodeMailboxReference(message.id), subject: clean(message.subject || "Sans objet", 500), from: graphAddress(message.from?.emailAddress), receivedAt: message.receivedDateTime || null, isRead: Boolean(message.isRead), hasAttachments: Boolean(message.hasAttachments), preview: clean(message.bodyPreview, 280) })), values.length > page.limit);
    }
    return withImapInbox(connection, async client => {
        const total = Number(client.mailbox?.exists || 0);
        const end = Math.max(0, total - page.offset);
        if (!end) return mailboxPageResult(page, [], false, total);
        const start = Math.max(1, end - page.limit + 1);
        const messages = [];
        // start:end désigne volontairement des numéros de séquence ; uid:true demande seulement le véritable UID dans la réponse.
        for await (const item of client.fetch(`${start}:${end}`, { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true })) {
            messages.push({ id: encodeMailboxReference(item.uid), subject: clean(item.envelope?.subject || "Sans objet", 500), from: mailboxAddress(item.envelope?.from?.[0]), receivedAt: item.envelope?.date || item.internalDate || null, isRead: Boolean(item.flags?.has("\\Seen")), hasAttachments: inspectMailboxStructure(item.bodyStructure).attachments.length > 0, preview: "", sequence: Number(item.seq || 0) });
        }
        messages.sort((left, right) => right.sequence - left.sequence).forEach(message => delete message.sequence);
        return mailboxPageResult(page, messages, page.offset + messages.length < total, total);
    });
}

async function readLiveMessage(connection, messageId) {
    if (connection.provider === "microsoft") {
        const query = new URLSearchParams({ "$select": "id,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,body" });
        const message = await withMicrosoftGraphAccess(connection, accessToken => graphJson(accessToken, `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}?${query}`, { headers: { Prefer: 'outlook.body-content-type="text"' } }));
        let attachments = [], attachmentsUnavailable = false;
        try { attachments = await withMicrosoftGraphAccess(connection, accessToken => graphMessageAttachments(accessToken, messageId)); }
        catch (error) { attachmentsUnavailable = true; console.warn("[partner-email] Microsoft attachment metadata unavailable", mailErrorLog(error, "microsoft")); }
        const body = limitMailboxBody(message.body?.content);
        return { id: encodeMailboxReference(messageId), subject: clean(message.subject || "Sans objet", 500), from: graphAddress(message.from?.emailAddress), to: (message.toRecipients || []).map(item => graphAddress(item.emailAddress)).filter(item => item.address), cc: (message.ccRecipients || []).map(item => graphAddress(item.emailAddress)).filter(item => item.address), receivedAt: message.receivedDateTime || null, isRead: Boolean(message.isRead), bodyText: body.text, bodyTruncated: body.truncated, attachmentsUnavailable, attachments: attachments.map(attachment => liveAttachmentMetadata(attachment, attachment.id)) };
    }
    const uid = mailboxUid(messageId);
    return withImapInbox(connection, async client => {
        const message = await client.fetchOne(String(uid), { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true }, { uid: true });
        if (!message) throw httpError(404, "E-mail introuvable dans la boîte de réception.");
        const structure = inspectMailboxStructure(message.bodyStructure);
        let bodyText = "", bodyTruncated = false;
        if (structure.body?.part) {
            const downloaded = await client.download(String(uid), structure.body.part, { uid: true, maxBytes: LIVE_MAILBOX_BODY_BYTES });
            const content = await streamBuffer(downloaded.content, LIVE_MAILBOX_BODY_BYTES);
            const body = limitMailboxBody(structure.body.contentType === "text/html" ? htmlToText(content.toString("utf8")) : content.toString("utf8"));
            bodyText = body.text; bodyTruncated = body.truncated || Number(downloaded.meta?.expectedSize || structure.body.size || 0) > content.length;
        }
        return { id: encodeMailboxReference(uid), subject: clean(message.envelope?.subject || "Sans objet", 500), from: mailboxAddress(message.envelope?.from?.[0]), to: (message.envelope?.to || []).map(mailboxAddress).filter(item => item.address), cc: (message.envelope?.cc || []).map(mailboxAddress).filter(item => item.address), receivedAt: message.envelope?.date || message.internalDate || null, isRead: Boolean(message.flags?.has("\\Seen")), bodyText, bodyTruncated, attachments: structure.attachments.map(attachment => liveAttachmentMetadata(attachment, attachment.part)) };
    });
}

async function sendLiveMailboxReply(connection, messageId, body) {
    const access = await mailboxAccess(connection);
    if (connection.provider === "microsoft") {
        await graphJson(access.graphToken, `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}/reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ comment: body }) }, { allowEmpty: true });
        return;
    }
    const source = await withImapInbox(connection, async client => {
        const message = await client.fetchOne(String(mailboxUid(messageId)), { envelope: true }, { uid: true });
        if (!message?.envelope) throw httpError(404, "E-mail introuvable dans la boîte de réception.");
        const recipient = mailboxAddress(message.envelope.replyTo?.[0] || message.envelope.from?.[0]);
        if (!/^\S+@\S+\.\S+$/.test(recipient.address)) throw httpError(422, "Cet e-mail ne contient aucune adresse de réponse valide.");
        return { recipient, subject: replySubject(message.envelope.subject), messageId: clean(message.envelope.messageId, 500), inReplyTo: clean(message.envelope.inReplyTo, 500) };
    });
    const transporter = nodemailer.createTransport({ host: access.smtp.host, port: access.smtp.port, secure: access.smtp.secure, requireTLS: !access.smtp.secure, auth: access.smtpAuth, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000 });
    await transporter.sendMail({ from: { name: connection.display_name || connection.email_address, address: connection.email_address }, to: source.recipient, subject: source.subject, text: body, inReplyTo: source.messageId || undefined, references: [source.inReplyTo, source.messageId].filter(Boolean).join(" ") || undefined });
}

async function downloadLiveAttachment(connection, messageId, attachmentId) {
    if (connection.provider === "microsoft") {
        const file = await withMicrosoftGraphAccess(connection, accessToken => graphJson(accessToken, `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`));
        if (file["@odata.type"] && file["@odata.type"] !== "#microsoft.graph.fileAttachment") throw httpError(422, "Cette pièce jointe Microsoft n’est pas un fichier téléchargeable.");
        const safe = validatedLiveAttachment(file);
        if (typeof file.contentBytes !== "string" || !/^[A-Za-z0-9+/=]+$/.test(file.contentBytes)) throw httpError(422, "Cette pièce jointe Microsoft n’est pas un fichier téléchargeable ou son contenu est indisponible.");
        const content = Buffer.from(file.contentBytes, "base64");
        if (content.length > MAX_ATTACHMENT_BYTES) throw httpError(413, "Cette pièce jointe dépasse la limite de 5 Mo.");
        if (!content.length) throw httpError(404, "Pièce jointe vide ou introuvable.");
        return { ...safe, content };
    }
    const uid = mailboxUid(messageId);
    return withImapInbox(connection, async client => {
        const message = await client.fetchOne(String(uid), { uid: true, bodyStructure: true }, { uid: true });
        if (!message) throw httpError(404, "E-mail introuvable dans la boîte de réception.");
        const attachment = inspectMailboxStructure(message.bodyStructure).attachments.find(item => item.part === attachmentId);
        if (!attachment) throw httpError(404, "Pièce jointe introuvable.");
        const safe = validatedLiveAttachment(attachment);
        const downloaded = await client.download(String(uid), attachment.part, { uid: true, maxBytes: MAX_ATTACHMENT_BYTES + 1 });
        const content = await streamBuffer(downloaded.content, MAX_ATTACHMENT_BYTES);
        if (!content.length) throw httpError(404, "Pièce jointe vide ou introuvable.");
        return { ...safe, content };
    });
}

async function graphMessageAttachments(accessToken, messageId) {
    const query = new URLSearchParams({ "$select": "id,name,contentType,size,isInline", "$top": "100" });
    let url = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}/attachments?${query}`;
    const attachments = [];
    while (url && attachments.length < 100) {
        const payload = await graphJson(accessToken, url);
        attachments.push(...(Array.isArray(payload.value) ? payload.value.filter(item => item?.id) : []));
        url = typeof payload["@odata.nextLink"] === "string" && payload["@odata.nextLink"].startsWith("https://graph.microsoft.com/") ? payload["@odata.nextLink"] : "";
    }
    return attachments.slice(0, 100);
}

async function withImapInbox(connection, operation) {
    const access = await mailboxAccess(connection);
    const client = createImapClient({ host: access.imap.host, port: access.imap.port, secure: access.imap.secure, auth: access.auth, disableAutoIdle: true });
    await client.connect(); const lock = await client.getMailboxLock("INBOX");
    try { return await operation(client); }
    finally { lock.release(); await client.logout().catch(() => {}); }
}

export function inspectMailboxStructure(root) {
    const nodes = [];
    const visit = node => { if (!node) return; nodes.push(node); (node.childNodes || []).forEach(visit); };
    visit(root);
    const attachments = nodes.filter(node => node.part && node.type && (node.disposition === "attachment" || node.dispositionParameters?.filename || node.parameters?.name)).map(node => ({ part: String(node.part), filename: safeFilename(node.dispositionParameters?.filename || node.parameters?.name || "document"), contentType: String(node.type || "application/octet-stream").toLowerCase(), size: Math.max(0, Number(node.size) || 0) }));
    const bodyNodes = nodes.filter(node => /^text\/(?:plain|html)$/i.test(node.type || "") && node.disposition !== "attachment" && !node.dispositionParameters?.filename && !node.parameters?.name);
    const selected = bodyNodes.find(node => String(node.type).toLowerCase() === "text/plain") || bodyNodes.find(node => String(node.type).toLowerCase() === "text/html");
    return { body: selected ? { part: String(selected.part || "1"), contentType: String(selected.type).toLowerCase(), size: Math.max(0, Number(selected.size) || 0) } : null, attachments };
}

export function parseMailboxPage(value) {
    const offset = Math.max(0, Math.min(10000, Number.parseInt(value?.offset, 10) || 0));
    const limit = Math.max(1, Math.min(LIVE_MAILBOX_MAX_LIMIT, Number.parseInt(value?.limit, 10) || LIVE_MAILBOX_DEFAULT_LIMIT));
    return { offset, limit };
}

function mailboxPageResult(page, messages, hasMore, total = null) { return { messages, offset: page.offset, limit: page.limit, hasMore: Boolean(hasMore), hasPrevious: page.offset > 0, total }; }
function mailboxAddress(value) { return { name: clean(value?.name, 160), address: clean(value?.address, 254).toLowerCase() }; }
function graphAddress(value) { return mailboxAddress(value); }
export function mailboxReplyBody(value) { return String(value || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, 10000); }
export function replySubject(value) { const subject = clean(value || "Sans objet", 500); return /^\s*re\s*:/i.test(subject) ? subject : `Re: ${subject}`; }
function liveAttachmentMetadata(value, reference) { const filename = safeFilename(value.name || value.filename); const metadata = { filename, contentType: normalizePartnerDocumentMime({ filename, contentType: value.contentType }), size: Math.max(0, Number(value.size) || 0) }; return { ...metadata, id: encodeMailboxReference(reference), downloadable: ALLOWED_MIME.has(metadata.contentType) && metadata.size > 0 && metadata.size <= MAX_ATTACHMENT_BYTES }; }
function validatedLiveAttachment(value) { const metadata = liveAttachmentMetadata(value, value.id || value.part); if (!ALLOWED_MIME.has(metadata.contentType)) throw httpError(415, "Le format de cette pièce jointe n’est pas autorisé."); if (!metadata.size || metadata.size > MAX_ATTACHMENT_BYTES) throw httpError(413, "Cette pièce jointe dépasse la limite de 5 Mo."); return metadata; }
function limitMailboxBody(value) { const text = String(value || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ""); return { text: text.slice(0, LIVE_MAILBOX_BODY_BYTES), truncated: text.length > LIVE_MAILBOX_BODY_BYTES }; }
function htmlToText(value) { return String(value || "").replace(/<\s*(?:script|style)[^>]*>[\s\S]*?<\s*\/\s*(?:script|style)\s*>/gi, " ").replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\s*\/\s*(?:p|div|li|tr|h[1-6])\s*>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&#x([0-9a-f]+);/gi, (match, value) => htmlCodePoint(value, 16, match)).replace(/&#(\d+);/g, (match, value) => htmlCodePoint(value, 10, match)).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(); }
function htmlCodePoint(value, radix, fallback) { const code = Number.parseInt(value, radix); try { return Number.isSafeInteger(code) && code >= 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : fallback; } catch { return fallback; } }
async function streamBuffer(stream, maxBytes) { const chunks = []; let size = 0; if (!stream) return Buffer.alloc(0); for await (const chunk of stream) { const buffer = Buffer.from(chunk); size += buffer.length; if (size > maxBytes) { stream.destroy?.(); await stream.cancel?.().catch(() => {}); throw httpError(413, "Le contenu demandé dépasse la limite autorisée."); } chunks.push(buffer); } return Buffer.concat(chunks, size); }
function encodeMailboxReference(value) { return Buffer.from(String(value || ""), "utf8").toString("base64url"); }
function decodeMailboxReference(value) { const token = String(value || ""); if (!token || token.length > 2000 || !/^[A-Za-z0-9_-]+$/.test(token)) throw httpError(400, "Référence d’e-mail invalide."); const decoded = Buffer.from(token, "base64url").toString("utf8"); if (!decoded || decoded.length > 1000) throw httpError(400, "Référence d’e-mail invalide."); return decoded; }
function mailboxUid(value) { const uid = positiveId(value); if (!uid) throw httpError(400, "Référence d’e-mail invalide."); return uid; }
async function requiredConnection(ownerId, connectionId) { const connection = await findConnection(ownerId, connectionId); if (!connection) throw httpError(404, "Boîte professionnelle introuvable."); return connection; }
async function liveMailboxOperation(connection, operation, { sending = false } = {}) { try { return await operation(); } catch (error) { if (error?.status) throw error; console.warn("[partner-email] live mailbox rejected", mailErrorLog(error, connection.provider)); const status = error?.statusCode === 400 ? 422 : error?.statusCode === 404 ? 404 : error?.statusCode === 429 ? 429 : error?.statusCode === 503 ? 503 : 502; throw httpError(status, publicMailError(error, { provider: connection.provider, sending }), { retryAfterSeconds: error?.retryAfterSeconds }); } }
function setLiveMailboxHeaders(response) { return response.set({ "Cache-Control": "private, no-store", Pragma: "no-cache", Expires: "0" }); }

async function saveParsedEmail(connection, uid, parsed, { forceCandidate = false, messageId: forcedMessageId = "" } = {}) {
    const from = parsed.from?.value?.[0] || {}; const messageId = clean(parsed.messageId || `uid-${uid}@${connection.email_address}`, 500);
    const nested = await extractNestedPartnerEmailContent(parsed);
    const attachments = preparePartnerEmailAttachments([...(parsed.attachments || []).filter(item => !isNestedEmailAttachment(item)), ...nested.attachments]);
    const attachmentText = await extractPartnerDocumentText(attachments.map(item => ({ name: item.filename, mime: item.contentType, size: item.size, buffer: item.content })));
    const documentText = [parsed.nestedText, nested.text, attachmentText].filter(Boolean).join("\n").slice(0, 50000);
    const classification = classifyPartnerEmail({ subject: parsed.subject, text: `${parsed.text || ""}\n${documentText}`, from: from.address, attachments, allowedSenders: forceCandidate ? [] : connection.allowed_senders || [], requiredKeywords: forceCandidate ? [] : connection.required_keywords || [], reply: forceCandidate ? false : Boolean(parsed.inReplyTo) || /^\s*(?:re|rép)\s*:/i.test(parsed.subject || ""), automatic: forceCandidate ? false : Boolean(parsed.headers?.get("auto-submitted")) || /^\s*(?:re|tr)?\s*:\s*(?:réponse automatique|automatic reply|out of office)/i.test(parsed.subject || ""), listMail: forceCandidate ? false : Boolean(parsed.headers?.get("list-unsubscribe") || parsed.headers?.get("list-id")) });
    if (!forceCandidate && classification.score < CANDIDATE_THRESHOLD) return null;
    const stableMessageId = clean(forcedMessageId || messageId, 500);
    const { rows } = await getPool().query(`INSERT INTO depannhome_partner_email_messages(owner_id,connection_id,uid,message_id,in_reply_to,references_header,sender_address,sender_name,recipients,subject,body_text,document_text,received_at,classification_score,classification_reasons) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15::jsonb) ON CONFLICT(owner_id,connection_id,message_id) DO NOTHING RETURNING id,status,mission_id AS "missionId"`, [connection.owner_id, connection.id, uid, stableMessageId, clean(parsed.inReplyTo, 500), clean((parsed.references || []).join(" "), 4000), clean(from.address, 254), clean(from.name, 160), JSON.stringify(parsed.to?.value?.map(item => item.address).filter(Boolean) || []), clean(parsed.subject, 500), String(parsed.text || "").slice(0, 20000), documentText.slice(0, 50000), parsed.date || new Date(), classification.score, JSON.stringify(classification.reasons)]);
    if (!rows[0]) return refreshPreviouslyParsedEmail(connection, stableMessageId, parsed, documentText, attachments, classification, forceCandidate);
    for (const attachment of attachments) await getPool().query("INSERT INTO depannhome_partner_email_attachments(owner_id,email_message_id,filename,mime_type,file_size,content_id,file_data) VALUES($1,$2,$3,$4,$5,$6,$7)", [connection.owner_id, rows[0].id, safeFilename(attachment.filename), attachment.contentType, attachment.size, clean(attachment.contentId, 255), attachment.content]);
    return { ...rows[0], score: classification.score, trustedSender: classification.trustedSender };
}

async function refreshPreviouslyParsedEmail(connection, stableMessageId, parsed, documentText, attachments, classification, forceCandidate) {
    const database = await getPool().connect();
    try {
        await database.query("BEGIN");
        const { rows } = await database.query(`SELECT message.id,message.status,message.mission_id AS "missionId",message.document_text AS "documentText",(SELECT COUNT(*)::int FROM depannhome_partner_email_attachments attachment WHERE attachment.email_message_id=message.id) AS "attachmentCount" FROM depannhome_partner_email_messages message WHERE message.owner_id=$1 AND message.connection_id=$2 AND message.message_id=$3 FOR UPDATE`, [connection.owner_id, connection.id, stableMessageId]);
        const existing = rows[0];
        if (!existing || existing.status === "processing" || ["ignored", "rejected"].includes(existing.status) && !forceCandidate) { await database.query("ROLLBACK"); return null; }
        const evidenceImproved = shouldRefreshStoredPartnerEmail({ attachmentCount: existing.attachmentCount, documentText: existing.documentText }, { attachmentCount: attachments.length, documentText });
        if (!evidenceImproved && !forceCandidate) { await database.query("ROLLBACK"); return null; }
        const reanalyzeImported = existing.status === "imported" && evidenceImproved;
        await database.query("DELETE FROM depannhome_partner_email_attachments WHERE email_message_id=$1 AND owner_id=$2", [existing.id, connection.owner_id]);
        for (const attachment of attachments) await database.query("INSERT INTO depannhome_partner_email_attachments(owner_id,email_message_id,filename,mime_type,file_size,content_id,file_data) VALUES($1,$2,$3,$4,$5,$6,$7)", [connection.owner_id, existing.id, safeFilename(attachment.filename), attachment.contentType, attachment.size, clean(attachment.contentId, 255), attachment.content]);
        await database.query(`UPDATE depannhome_partner_email_messages SET body_text=$3,document_text=$4,classification_score=$5,classification_reasons=$6::jsonb,status='candidate',processed_at=NULL WHERE id=$1 AND owner_id=$2`, [existing.id, connection.owner_id, String(parsed.text || "").slice(0, 20000), documentText.slice(0, 50000), classification.score, JSON.stringify(classification.reasons)]);
        await database.query("COMMIT");
        console.info("[partner-email] contenu enrichi après nouvelle lecture", { emailId: existing.id, attachmentCount: attachments.length, reanalyzeImported });
        return { id: existing.id, missionId: existing.missionId, status: "candidate", score: classification.score, trustedSender: classification.trustedSender, reanalyzeImported };
    } catch (error) {
        await database.query("ROLLBACK");
        throw error;
    } finally { database.release(); }
}

export function shouldRefreshStoredPartnerEmail(existing, incoming) {
    const oldAttachments = Math.max(0, Number(existing?.attachmentCount) || 0), newAttachments = Math.max(0, Number(incoming?.attachmentCount) || 0);
    const oldText = String(existing?.documentText || "").trim(), newText = String(incoming?.documentText || "").trim();
    return newAttachments > oldAttachments || (!oldText && Boolean(newText));
}

async function importLiveMailboxMessage(connection, messageId, requestedAttachmentIds, actorId) {
    const message = await liveMailboxOperation(connection, () => readLiveMessage(connection, messageId));
    const available = (message.attachments || []).filter(item => item.downloadable);
    const requested = Array.isArray(requestedAttachmentIds) ? requestedAttachmentIds.map(String).slice(0, MAX_ATTACHMENTS) : available.map(item => item.id);
    if (requested.some(id => !available.some(item => item.id === id))) throw httpError(400, "Une pièce jointe sélectionnée est invalide ou indisponible.");
    const selected = available.filter(item => requested.includes(item.id));
    const uid = connection.provider === "microsoft" ? graphMessageUid(messageId) : mailboxUid(messageId);
    const attachments = [];
    let nestedMessageText = "";
    for (const item of selected) {
        const downloaded = await liveMailboxOperation(connection, () => downloadLiveAttachment(connection, messageId, decodeMailboxReference(item.id)));
        attachments.push({ filename: downloaded.filename, contentType: downloaded.contentType, size: downloaded.content.length, content: downloaded.content });
    }
    try {
        const parsedSource = await liveMailboxOperation(connection, () => parseLiveMailboxSource(connection, messageId));
        const nested = await extractNestedPartnerEmailContent(parsedSource);
        nestedMessageText = nested.text;
        attachments.push(...nested.attachments);
    } catch (error) {
        console.warn("[partner-email] lecture des messages transférés imbriqués impossible", mailErrorLog(error, connection.provider));
    }
    const preparedAttachments = preparePartnerEmailAttachments(attachments);
    const existing = await getPool().query("SELECT id,status,mission_id AS \"missionId\" FROM depannhome_partner_email_messages WHERE owner_id=$1 AND connection_id=$2 AND uid=$3 ORDER BY id DESC LIMIT 1", [connection.owner_id, connection.id, uid]);
    if (existing.rows[0]) {
        const saved = existing.rows[0];
        if (saved.status === "processing") throw httpError(409, "Cet e-mail est déjà en cours de traitement.");
        const wasImported = saved.status === "imported" && Boolean(saved.missionId);
        await refreshStoredLiveEmail(connection, saved.id, message, preparedAttachments, nestedMessageText);
        const result = await importCandidate(connection.owner_id, saved.id, actorId);
        return { ...result, reanalyzed: wasImported };
    }
    const manualMessageId = `manual-${hash(`${connection.provider}:${messageId}`)}@depannhome.local`;
    const saved = await saveParsedEmail(connection, uid, {
        messageId: manualMessageId,
        subject: message.subject,
        text: message.bodyText,
        date: message.receivedAt,
        from: { value: [message.from || {}] },
        to: { value: message.to || [] },
        attachments: preparedAttachments,
        nestedText: nestedMessageText,
        headers: new Map()
    }, { forceCandidate: true, messageId: manualMessageId });
    if (!saved) throw httpError(500, "Cet e-mail n’a pas pu être préparé pour l’import.");
    if (saved.status === "processing") throw httpError(409, "Cet e-mail est déjà en cours de traitement.");
    if (saved.status === "imported" && saved.missionId) {
        return existingEmailMission(connection.owner_id, saved.missionId);
    }
    if (["ignored", "rejected"].includes(saved.status)) await getPool().query("UPDATE depannhome_partner_email_messages SET status='candidate',processed_at=NULL WHERE id=$1 AND owner_id=$2", [saved.id, connection.owner_id]);
    return importCandidate(connection.owner_id, saved.id, actorId);
}

async function parseLiveMailboxSource(connection, messageId) {
    if (connection.provider === "microsoft") {
        const source = await withMicrosoftGraphAccess(connection, accessToken => graphMessageMime(accessToken, messageId));
        return simpleParser(source, { skipHtmlToText: false, maxHtmlLengthToParse: 2 * 1024 * 1024 });
    }
    return withImapInbox(connection, async client => {
        const message = await client.fetchOne(String(mailboxUid(messageId)), { source: true }, { uid: true });
        if (!message?.source) throw httpError(404, "E-mail introuvable dans la boîte de réception.");
        return simpleParser(message.source, { skipHtmlToText: false, maxHtmlLengthToParse: 2 * 1024 * 1024 });
    });
}

export async function extractNestedPartnerEmailContent(parsed) {
    const state = { attachments: [], texts: [], messages: 0, bytes: 0 };
    await collectNestedPartnerEmailContent(parsed?.attachments, 0, state);
    return { attachments: state.attachments, text: state.texts.join("\n").slice(0, 50000) };
}

async function collectNestedPartnerEmailContent(attachments, depth, state) {
    if (depth >= MAX_NESTED_EMAIL_DEPTH || state.messages >= MAX_NESTED_EMAILS) return;
    for (const attachment of Array.isArray(attachments) ? attachments : []) {
        if (!isNestedEmailAttachment(attachment) || state.messages >= MAX_NESTED_EMAILS) continue;
        const content = Buffer.isBuffer(attachment.content) ? attachment.content : Buffer.alloc(0);
        if (!content.length || content.length > MAX_NESTED_EMAIL_SOURCE_BYTES || state.bytes + content.length > MAX_NESTED_EMAIL_SOURCE_BYTES) continue;
        state.messages += 1; state.bytes += content.length;
        try {
            const nested = await simpleParser(content, { skipHtmlToText: false, maxHtmlLengthToParse: 2 * 1024 * 1024 });
            const text = [nested.subject, nested.text].filter(Boolean).join("\n").trim();
            if (text) state.texts.push(text);
            state.attachments.push(...(nested.attachments || []).filter(item => !isNestedEmailAttachment(item)));
            await collectNestedPartnerEmailContent(nested.attachments, depth + 1, state);
        } catch (error) {
            console.warn("[partner-email] e-mail transféré imbriqué illisible :", error?.message || "erreur MIME");
        }
    }
}

function isNestedEmailAttachment(attachment) {
    const mime = String(attachment?.contentType || attachment?.mime || "").toLowerCase().split(";", 1)[0].trim();
    return mime === "message/rfc822" || /\.eml$/i.test(String(attachment?.filename || attachment?.name || ""));
}

function preparePartnerEmailAttachments(values) {
    const attachments = []; const signatures = new Set(); let totalBytes = 0;
    for (const item of Array.isArray(values) ? values : []) {
        const content = Buffer.isBuffer(item?.content) ? item.content : Buffer.isBuffer(item?.buffer) ? item.buffer : Buffer.alloc(0);
        const filename = safeFilename(item?.filename || item?.name);
        const contentType = normalizePartnerDocumentMime({ filename, contentType: item?.contentType || item?.mime });
        const size = content.length;
        if (!ALLOWED_MIME.has(contentType) || !size || size > MAX_ATTACHMENT_BYTES || totalBytes + size > MAX_TOTAL_ATTACHMENT_BYTES) continue;
        const signature = `${filename}\u0000${contentType}\u0000${size}\u0000${hash(content)}`;
        if (signatures.has(signature)) continue;
        signatures.add(signature); totalBytes += size;
        attachments.push({ ...item, filename, contentType, size, content });
        if (attachments.length >= MAX_ATTACHMENTS) break;
    }
    return attachments;
}

async function refreshStoredLiveEmail(connection, emailId, message, attachments, nestedText = "") {
    const attachmentText = await extractPartnerDocumentText(attachments.map(item => ({ name: item.filename, mime: item.contentType, size: item.size, buffer: item.content })));
    const documentText = [nestedText, attachmentText].filter(Boolean).join("\n").slice(0, 50000);
    const database = await getPool().connect();
    try {
        await database.query("BEGIN");
        const locked = await database.query("SELECT status FROM depannhome_partner_email_messages WHERE id=$1 AND owner_id=$2 FOR UPDATE", [emailId, connection.owner_id]);
        if (!locked.rows[0]) throw httpError(404, "E-mail introuvable.");
        if (locked.rows[0].status === "processing") throw httpError(409, "Cet e-mail est déjà en cours de traitement.");
        await database.query("DELETE FROM depannhome_partner_email_attachments WHERE email_message_id=$1 AND owner_id=$2", [emailId, connection.owner_id]);
        for (const attachment of attachments) await database.query("INSERT INTO depannhome_partner_email_attachments(owner_id,email_message_id,filename,mime_type,file_size,content_id,file_data) VALUES($1,$2,$3,$4,$5,'',$6)", [connection.owner_id, emailId, safeFilename(attachment.filename), attachment.contentType, attachment.size, attachment.content]);
        await database.query("UPDATE depannhome_partner_email_messages SET sender_address=$3,sender_name=$4,recipients=$5::jsonb,subject=$6,body_text=$7,document_text=$8,received_at=$9,status='candidate',processed_at=NULL WHERE id=$1 AND owner_id=$2", [emailId, connection.owner_id, clean(message.from?.address, 254), clean(message.from?.name, 160), JSON.stringify((message.to || []).map(item => item.address).filter(Boolean)), clean(message.subject, 500), String(message.bodyText || "").slice(0, 20000), documentText.slice(0, 50000), message.receivedAt || new Date()]);
        await database.query("COMMIT");
    } catch (error) {
        await database.query("ROLLBACK");
        throw error;
    } finally {
        database.release();
    }
}

async function existingEmailMission(ownerId, missionId) {
    const { rows } = await getPool().query("SELECT id AS \"missionId\",client_id AS \"clientId\" FROM depannhome_partner_missions WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL", [missionId, ownerId]);
    if (!rows[0]) throw httpError(409, "La mission liée à cet e-mail n’est plus disponible.");
    return { ...rows[0], created: false };
}

async function importCandidate(ownerId, emailId, actorId) {
    const { rows } = await getPool().query(`SELECT message.*,connection.display_name,connection.email_address,connection.id AS email_connection_id,COALESCE(json_agg(json_build_object('sourceAttachmentId',attachment.id,'name',attachment.filename,'mime',attachment.mime_type,'size',attachment.file_size,'dataUrl','data:'||attachment.mime_type||';base64,'||REPLACE(REPLACE(encode(attachment.file_data,'base64'),E'\n',''),E'\r','')) ORDER BY attachment.id) FILTER(WHERE attachment.id IS NOT NULL AND attachment.selected=TRUE),'[]'::json) AS attachments FROM depannhome_partner_email_messages message JOIN depannhome_partner_email_connections connection ON connection.id=message.connection_id LEFT JOIN depannhome_partner_email_attachments attachment ON attachment.email_message_id=message.id WHERE message.id=$1 AND message.owner_id=$2 AND message.status='candidate' GROUP BY message.id,connection.id`, [emailId, ownerId]);
    const email = rows[0]; if (!email) throw httpError(404, "E-mail déjà traité ou introuvable.");
    const claimed = await getPool().query("UPDATE depannhome_partner_email_messages SET status='processing' WHERE id=$1 AND owner_id=$2 AND status='candidate' RETURNING id", [email.id, ownerId]);
    if (!claimed.rowCount) throw httpError(409, "Cet e-mail est déjà en cours de traitement.");
    try {
        const documentText = await extractPartnerDocumentText(email.attachments);
        const payload = extractMissionPayload(email, documentText);
        const result = await ingestEmailPartnerMission({ ownerId, connectionId: email.email_connection_id, emailId: email.id, partnerName: email.display_name || email.sender_address, actorId, payload });
        for (const attachment of email.attachments || []) {
            const match = partnerEmailDataUrl(attachment.dataUrl);
            if (!match) continue;
            const content = Buffer.from(match.base64, "base64");
            const duplicate = await getPool().query("SELECT 1 FROM depannhome_partner_dialogue_attachments WHERE owner_id=$1 AND mission_id=$2 AND filename=$3 AND mime_type=$4 AND file_size=$5 AND file_data=$6 LIMIT 1", [ownerId, result.missionId, attachment.name, match.mime, content.length, content]);
            if (duplicate.rowCount) continue;
            await recordMissionDialogueDocument({ ownerId, missionId: result.missionId, actorName: email.sender_name || email.sender_address, body: `Document reçu par e-mail : ${attachment.name}`, attachment: { filename: attachment.name, mimeType: match.mime, buffer: content, type: match.mime.startsWith("image/") ? "photo" : "document" }, partnerVisible: false, eventType: "email_attachment_received" });
        }
        await getPool().query("UPDATE depannhome_partner_email_messages SET status='imported',mission_id=$3,processed_at=NOW() WHERE id=$1 AND owner_id=$2 AND status='processing'", [email.id, ownerId, result.missionId]);
        return result;
    } catch (error) { await getPool().query("UPDATE depannhome_partner_email_messages SET status='candidate' WHERE id=$1 AND owner_id=$2 AND status='processing'", [email.id, ownerId]); throw error; }
}

export function partnerEmailDataUrl(value) {
    const match = /^data:([^;]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(value || ""));
    if (!match) return null;
    const base64 = match[2].replace(/\s/g, "");
    return base64 && base64.length % 4 === 0 ? { mime: match[1], base64 } : null;
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
    const postalAddress = normalizeMissionPostalAddress(value("address"), value("postalCode"), value("city"));
    const missionNumber = value("missionNumber") || `MAIL-${email.id}`;
    return {
        id: `email-${email.id}`,
        missionNumber,
        partnerReference: missionNumber,
        subject: email.subject,
        interventionType: value("interventionType") || clean(email.subject, 160),
        description: clean(email.body_text, 2000),
        client: { name, firstName, lastName, phone: value("phone"), email: value("email"), address: postalAddress.address, postalCode: postalAddress.postalCode, city: postalAddress.city },
        insuranceDossier: value("insuranceDossier"),
        claimNumber: value("claimNumber"),
        insuredNumber: value("insuredNumber"),
        mandateNumber: value("mandateNumber"),
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
    const source = String(text || "");
    const field = pattern => trimFollowingMissionField(clean(pattern.exec(source)?.[1], 255));
    const first = (...patterns) => patterns.map(field).find(Boolean) || "";
    const postalCity = /(?:^|\s)(?:code\s+postal\s*(?:\/|-|et)?\s*ville|cp\s*(?:\/|-|et)\s*ville)\s*[:\-]\s*(\d{5})\s+([^\n\r]+)/im.exec(source);
    return {
        insuredName: first(/^(?:b[ée]n[ée]ficiaire|assur[ée]e?)\s*[:\-]\s*([^\n\r]+)/im, /^(?:nom(?:\s+et\s+pr[ée]nom)?\s+(?:de\s+l['’])?assur[ée]e?)\s*[:\-]\s*([^\n\r]+)/im, /\bmission\s+chez\s+((?:monsieur|madame|m\.|mme)\s+[^,\n\r]+?)(?=\s*,?\s*assur[ée]e?\b)/im),
        name: first(/^(?:client|b[ée]n[ée]ficiaire|occupant)\s*[:\-]\s*([^\n\r]+)/im, /^(?:nom(?:\s+(?:et\s+pr[ée]nom|du\s+client))?)\s*[:\-]\s*([^\n\r]+)/im),
        firstName: field(/(?:^|\s)pr[ée]nom(?:\s+(?:de\s+l['’])?assur[ée]e?)?\s*[:\-]\s*([^\n\r]+)/im),
        lastName: field(/(?:^|\s)nom(?:\s+de\s+famille)?(?:\s+(?:de\s+l['’])?assur[ée]e?)?\s*[:\-]\s*([^\n\r]+)/im),
        phone: field(/(?:^|\s)(?:t[ée]l(?:[ée]phone)?|portable|mobile)\s*[:\-]\s*([+\d .()\/-]{8,})/im),
        email: field(/(?:^|\s)(?:e-?mail|courriel)\s*[:\-]\s*([^\s<>]+@[^\s<>]+)/im).replace(/[.,;:)]+$/, ""),
        address: first(/^(?:adresse\s+(?:du\s+|de\s+l['’])?(?:b[ée]n[ée]ficiaire|sinistre|assur[ée]e?|client)|lieu\s+d['’]intervention|adresse\s+d['’]intervention)\s*[:\-]\s*([^\n\r]+)/im, /(?:^|\s)(?:adresse|lieu)\s*[:\-]\s*([^\n\r]+)/im),
        postalCode: postalCity?.[1] || field(/(?:^|\s)(?:code\s+postal|cp)\s*[:\-]\s*(\d{5})/im),
        city: trimFollowingMissionField(clean(postalCity?.[2], 100)) || field(/^(?:ville|commune)\s*[:\-]\s*([^\n\r]+)/im),
        missionNumber: first(/^(?:n°\s*)?dossier\s+(?:imh\s*)?[:#\-]\s*([A-Z0-9][A-Z0-9/_-]{2,})/im, /^(?:r[ée]f(?:[ée]rence)?\s+imh|notre\s+r[ée]f[ée]rence)\s*[:#\-]\s*([A-Z0-9][A-Z0-9/_-]{2,})/im, /^(?:mission|dossier|référence|ref)\s*(?:(?:n°|no|numéro)\s*[:#\-]?|[:#\-]\s*)([A-Z0-9][A-Z0-9/_-]{2,})/im),
        interventionType: field(/^(?:intervention|objet|nature|type\s+d['’]intervention)\s*[:\-]\s*([^\n\r]+)/im),
        insuranceDossier: first(/^(?:(?:n[°o]\s*)?dossier\s+(?:de\s+l['’])?assur(?:eur|ance)|r[ée]f(?:[ée]rence)?\.?\s+(?:(?:du\s+)?dossier\s+(?:de\s+l['’])?)?assur(?:eur|ance))\s*(?:n[°o]|no|num[ée]ro)?\s*[:#\-]\s*([A-Z0-9][A-Z0-9./_-]{2,})/im),
        claimNumber: field(/^(?:sinistre|n°\s+de\s+sinistre)\s*(?:n°|no|numéro)?\s*[:#\-]?\s*([A-Z0-9][A-Z0-9/_-]*)/im),
        insuredNumber: extractInsuredNumber(source),
        mandateNumber: first(/^(?:n[°o]\s*)?mandat\s*(?:n[°o]|no|num[ée]ro)?\s*[:#\-]\s*([A-Z0-9][A-Z0-9./_-]{2,})/im, /^(?:r[ée]f(?:[ée]rence)?\s+(?:du\s+)?mandat)\s*[:#\-]\s*([A-Z0-9][A-Z0-9./_-]{2,})/im),
        insurance: extractInsuranceName(source, field),
        expert: field(/^expert\s*[:\-]\s*([^\n\r]+)/im),
        manager: field(/^(?:gestionnaire|chargé(?:e)?\s+de\s+dossier)\s*[:\-]\s*([^\n\r]+)/im),
        principal: field(/^(?:donneur\s+d['’]ordre|mandant)\s*[:\-]\s*([^\n\r]+)/im)
    };
}

const INSURED_NUMBER_SUBJECT = String.raw`(?:assur[ée](?:e)?|soci[ée]taire|adh[ée]rent(?:e)?|contrat|police)`;
const INSURED_NUMBER_LABEL = String.raw`(?:(?:n(?:um[ée]ro|[°o])\s*(?:de\s+l['’])?\s*)?${INSURED_NUMBER_SUBJECT}(?:\s*\/\s*${INSURED_NUMBER_SUBJECT})*(?:\s+n(?:um[ée]ro|[°o]))?|r[ée]f(?:[ée]rence)?\s+(?:contrat|police))`;

function extractInsuredNumber(source) {
    const direct = new RegExp(`(?:^|\\n)${INSURED_NUMBER_LABEL}\\s*[:#\\-]\\s*([A-Z0-9][A-Z0-9./_-]{2,39})`, "im").exec(source)?.[1] || "";
    if (validInsuredNumber(direct)) return clean(direct, 40);
    const reverse = new RegExp(`(?:^|\\n)\\s*([A-Z0-9][A-Z0-9./_-]{2,39})\\s+${INSURED_NUMBER_LABEL}\\s*[:#\\-]?`, "im").exec(source)?.[1] || "";
    if (validInsuredNumber(reverse)) return clean(reverse, 40);
    const label = new RegExp(`${INSURED_NUMBER_LABEL}\\s*[:#\\-]`, "ig");
    const candidates = [];
    for (const match of source.matchAll(label)) {
        const nearby = source.slice(match.index + match[0].length, match.index + match[0].length + 500);
        for (const candidate of nearby.matchAll(/\b[A-Z0-9][A-Z0-9./_-]{2,39}\b/gi)) {
            if (!validInsuredNumber(candidate[0])) continue;
            const prefix = nearby.slice(Math.max(0, candidate.index - 30), candidate.index);
            if (/(?:t[ée]l(?:[ée]phone)?|portable|mobile|code\s+postal|\bcp|dossier|mission|r[ée]f(?:[ée]rence)?|sinistre)\s*[:#\-]?\s*$/i.test(prefix)) continue;
            const value = candidate[0];
            const score = /^\d{6,9}$/.test(value) ? 3 : /[A-Z]/i.test(value) && /\d/.test(value) ? 2 : 1;
            candidates.push({ value, score, distance: candidate.index });
        }
    }
    candidates.sort((left, right) => right.score - left.score || left.distance - right.distance);
    return clean(candidates[0]?.value, 40);
}

function validInsuredNumber(value) {
    const candidate = String(value || "").trim();
    return candidate.length >= 3 && candidate.length <= 40 && /\d/.test(candidate) && /^[A-Z0-9][A-Z0-9./_-]*$/i.test(candidate);
}

function extractInsuranceName(source, field) {
    const sentence = trimFollowingMissionField(clean(/\bassur[ée]e?\s+(?:aupr[èe]s\s+de|par)\s+([\p{L}\p{N}&'’.() -]{2,100}?)(?=[,;\n.]|$)/imu.exec(source)?.[1], 100));
    if (sentence) return normalizeInsuranceName(sentence);
    const labeled = field(/^(?:assurance|assureur|compagnie(?:\s+d['’]assurance)?|soci[ée]t[ée]\s+d['’]assurance|organisme\s+assureur|mutuelle|grand\s+compte)\s*[:\-]\s*([^\n\r]+)/im);
    return normalizeInsuranceName(labeled);
}

function normalizeInsuranceName(value) {
    return clean(String(value || "").replace(/\s+(?:nature(?:\s+du)?|type(?:\s+de)?|n(?:um[ée]ro|[°o])?\s*(?:de\s+)?(?:sinistre|dossier|contrat|police))\s*$/i, ""), 160);
}

function trimFollowingMissionField(value) { return clean(String(value || "").split(/\s+(?=(?:assur[ée]e?|client|bénéficiaire|occupant|nom|pr[ée]nom|adresse|lieu\s+d['’]intervention|t[ée]l(?:[ée]phone)?|portable|mobile|e-?mail|courriel|code\s+postal|cp|ville|commune|mission|dossier|référence|ref|intervention|objet|nature|sinistre|mandat|assurance|assureur|compagnie|expert|gestionnaire|donneur\s+d['’]ordre|mandant)\s*[:#\-])/i)[0], 255); }
export function normalizeMissionPostalAddress(addressValue, postalCodeValue = "", cityValue = "") {
    let address = clean(addressValue, 255); let postalCode = clean(postalCodeValue, 10); let city = clean(cityValue, 100);
    const inline = /^(.*?)[,\s]+(\d{5})\s+([^,;]+)$/i.exec(address);
    if (inline) { address = clean(inline[1], 255); postalCode ||= inline[2]; city ||= clean(inline[3], 100); }
    if (postalCode) address = clean(address.replace(new RegExp(`[,\\s]+${postalCode}(?:\\s+${escapeRegExp(city)})?$`, "i"), ""), 255);
    return { address: [address, postalCode].filter(Boolean).join(", "), postalCode, city };
}

export async function notifyEmailMissionStatus(ownerId, missionId, status, details = {}) {
    const { rows } = await getPool().query(`SELECT connection.send_status_updates FROM depannhome_partner_email_messages message JOIN depannhome_partner_email_connections connection ON connection.id=message.connection_id WHERE message.owner_id=$1 AND message.mission_id=$2 AND message.status='imported' ORDER BY message.id LIMIT 1`, [ownerId, missionId]);
    if (!rows[0]?.send_status_updates) return false;
    await sendMissionEmail(ownerId, missionId, `Mise à jour de votre mission : ${statusLabel(status)}.${details?.note ? `\n${clean(details.note, 1000)}` : ""}`, { statusUpdate: true }); return true;
}

export async function sendMissionEmail(ownerId, missionId, body, { statusUpdate = false, attachments = [] } = {}) {
    const { rows } = await getPool().query(`SELECT message.mission_id,message.sender_address,message.subject,message.message_id,message.references_header,connection.* FROM depannhome_partner_email_messages message JOIN depannhome_partner_email_connections connection ON connection.id=message.connection_id WHERE message.owner_id=$1 AND message.mission_id=$2 AND message.status='imported' ORDER BY message.id LIMIT 1`, [ownerId, missionId]);
    const source = rows[0]; if (!source) throw httpError(404, "Aucun e-mail source n’est lié à cette mission.");
    const access = await mailboxAccess(source);
    if (source.provider === "microsoft") { await sendMicrosoftGraphMail(access.graphToken, { source, body, attachments, statusUpdate }); return { recipient: source.sender_address, provider: source.provider }; }
    const transporter = nodemailer.createTransport({ host: access.smtp.host, port: access.smtp.port, secure: access.smtp.secure, requireTLS: !access.smtp.secure, auth: access.smtpAuth });
    await transporter.sendMail({ from: { name: source.display_name || source.email_address, address: source.email_address }, to: source.sender_address, subject: `${/^re:/i.test(source.subject) ? "" : "Re: "}${source.subject}`, text: body, attachments, inReplyTo: source.message_id, references: [source.references_header, source.message_id].filter(Boolean).join(" "), headers: { "X-DepannHome-Mission": String(missionId), "X-DepannHome-Status-Update": statusUpdate ? "true" : "false" } });
    return { recipient: source.sender_address, provider: source.provider };
}

async function mailboxAccess(connection, { forceRefresh = false } = {}) {
    let credentials = decryptElectronicInvoicingCredentials(connection.encrypted_credentials);
    if (["google", "microsoft"].includes(connection.provider) && (forceRefresh || !credentials.accessToken || new Date(credentials.expiresAt || 0).getTime() < Date.now() + 60000)) {
        const tokens = await refreshOauth(connection.provider, credentials.refreshToken); credentials = { ...credentials, accessToken: tokens.access_token, refreshToken: tokens.refresh_token || credentials.refreshToken, expiresAt: new Date(Date.now() + Number(tokens.expires_in || 3600) * 1000).toISOString() };
        const encryptedCredentials = encryptElectronicInvoicingCredentials(credentials);
        await getPool().query("UPDATE depannhome_partner_email_connections SET encrypted_credentials=$2,updated_at=NOW() WHERE id=$1", [connection.id, encryptedCredentials]);
        connection.encrypted_credentials = encryptedCredentials;
    }
    const server = connection.server_configuration || {};
    if (connection.provider === "google") return { imap: { host: "imap.gmail.com", port: 993, secure: true }, smtp: { host: "smtp.gmail.com", port: 465, secure: true }, auth: { user: connection.email_address, accessToken: credentials.accessToken }, smtpAuth: { type: "OAuth2", user: connection.email_address, accessToken: credentials.accessToken } };
    if (connection.provider === "microsoft") return { graphToken: credentials.accessToken };
    return { imap: server.imap, smtp: server.smtp, auth: { user: credentials.username, pass: credentials.password }, smtpAuth: { user: credentials.username, pass: credentials.password } };
}

async function withMicrosoftGraphAccess(connection, operation) {
    let access = await mailboxAccess(connection);
    try { return await operation(access.graphToken); }
    catch (error) {
        if (!error?.authenticationFailed) throw error;
        access = await mailboxAccess(connection, { forceRefresh: true });
        return operation(access.graphToken);
    }
}

async function testMailbox(connection) { const access = await mailboxAccess({ ...connection, id: 0, encrypted_credentials: encryptElectronicInvoicingCredentials(connection.credentials), server_configuration: connection.server }); const client = createImapClient({ host: access.imap.host, port: access.imap.port, secure: access.imap.secure, auth: access.auth }); await client.connect(); await client.logout(); const smtp = nodemailer.createTransport({ host: access.smtp.host, port: access.smtp.port, secure: access.smtp.secure, requireTLS: !access.smtp.secure, auth: access.smtpAuth, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000 }); await smtp.verify(); }
function createImapClient(options) { const client = new ImapFlow({ ...options, logger: false, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000 }); client.on("error", error => console.warn("[partner-email] erreur IMAP contrôlée :", publicMailError(error))); return client; }
async function findConnection(ownerId, id) { const { rows } = await getPool().query("SELECT * FROM depannhome_partner_email_connections WHERE id=$1 AND owner_id=$2 AND enabled=TRUE", [id, ownerId]); return rows[0] || null; }
async function recentUids(client) { const ids = await client.search({ since: new Date(Date.now() - 14 * 86400000) }, { uid: true }); return ids.slice(-FETCH_LIMIT); }
async function periodUids(client, period) { const ids = await client.search({ since: period.since, before: period.before }, { uid: true }); return { ids: ids.slice(-PERIOD_FETCH_LIMIT), limited: ids.length > PERIOD_FETCH_LIMIT }; }
async function completeSync(connectionId, stats, { advanceCursor = true } = {}) { if (advanceCursor) await getPool().query("UPDATE depannhome_partner_email_connections SET last_uid=GREATEST(last_uid,$2),last_sync_at=NOW(),last_error='',updated_at=NOW() WHERE id=$1", [connectionId, stats.maxUid]); else await getPool().query("UPDATE depannhome_partner_email_connections SET last_sync_at=NOW(),last_error='',updated_at=NOW() WHERE id=$1", [connectionId]); return stats; }

async function graphInboxMessages(accessToken, connection, syncPeriod) {
    const since = syncPeriod?.since || new Date(Math.max(new Date(connection.last_sync_at || 0).getTime() - 5 * 60000, Date.now() - 14 * 86400000));
    const filters = [`receivedDateTime ge ${since.toISOString()}`];
    if (syncPeriod?.before) filters.push(`receivedDateTime lt ${syncPeriod.before.toISOString()}`);
    const query = new URLSearchParams({ "$select": "id,receivedDateTime,from", "$filter": filters.join(" and "), "$orderby": "receivedDateTime asc", "$top": "50" });
    let url = `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?${query}`;
    const messages = []; let scanned = 0; const limit = syncPeriod ? PERIOD_FETCH_LIMIT : FETCH_LIMIT;
    while (url && scanned < limit) {
        const payload = await graphJson(accessToken, url);
        const page = Array.isArray(payload.value) ? payload.value : []; scanned += page.length;
        messages.push(...page.filter(message => message?.id && senderMatchesAllowed(message.from?.emailAddress?.address, connection.allowed_senders || [])));
        url = typeof payload["@odata.nextLink"] === "string" && payload["@odata.nextLink"].startsWith("https://graph.microsoft.com/") ? payload["@odata.nextLink"] : "";
    }
    return { messages: messages.slice(-limit), limited: Boolean(url) };
}

async function graphMessageMime(accessToken, messageId) {
    const response = await graphFetch(accessToken, `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}/$value`, { headers: { Accept: "application/octet-stream" } });
    return Buffer.from(await response.arrayBuffer());
}

async function sendMicrosoftGraphMail(accessToken, { source, body, attachments, statusUpdate }) {
    await graphJson(accessToken, "https://graph.microsoft.com/v1.0/me/sendMail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: { subject: `${/^re:/i.test(source.subject) ? "" : "Re: "}${source.subject}`, body: { contentType: "Text", content: body }, toRecipients: [{ emailAddress: { address: source.sender_address } }], internetMessageHeaders: [{ name: "X-DepannHome-Mission", value: String(source.mission_id || "") }, { name: "X-DepannHome-Status-Update", value: statusUpdate ? "true" : "false" }], attachments: attachments.map(attachment => ({ "@odata.type": "#microsoft.graph.fileAttachment", name: attachment.filename, contentType: attachment.contentType, contentBytes: Buffer.from(attachment.content).toString("base64") })) }, saveToSentItems: true })
    }, { allowEmpty: true });
}

async function graphJson(accessToken, url, options = {}, { allowEmpty = false } = {}) {
    const response = await graphFetch(accessToken, url, options);
    if (allowEmpty && response.status === 202) return {};
    return response.json().catch(() => ({}));
}

async function graphFetch(accessToken, url, options = {}) {
    for (let attempt = 0; attempt <= MICROSOFT_GRAPH_MAX_RETRIES; attempt += 1) {
        let response;
        try { response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${accessToken}`, ...(options.headers || {}) }, signal: AbortSignal.timeout(20000) }); }
        catch (error) { if (error?.name === "TimeoutError") throw new Error("Microsoft Graph timed out."); throw error; }
        if (response.ok) return response;
        const payload = await response.json().catch(() => ({}));
        const retryAfterSeconds = parseMicrosoftRetryAfter(response.headers.get("retry-after"));
        const retryable = response.status === 429 || response.status === 503;
        const retryDelay = retryAfterSeconds ? retryAfterSeconds * 1000 : 1000 * (2 ** attempt);
        if (retryable && attempt < MICROSOFT_GRAPH_MAX_RETRIES && retryDelay <= MICROSOFT_GRAPH_MAX_RETRY_DELAY_MS) {
            console.warn("[partner-email-graph] Microsoft Graph temporairement limité", { status: response.status, code: clean(payload?.error?.code, 80) || "temporary_limit", retryAfterSeconds: Math.ceil(retryDelay / 1000), attempt: attempt + 1 });
            await delay(retryDelay);
            continue;
        }
        const error = new Error(response.status === 401 || response.status === 403 ? "Microsoft Graph authentication failed." : response.status === 429 ? "Microsoft Graph throttled." : "Microsoft Graph request failed.");
        error.code = clean(payload?.error?.code, 80); error.statusCode = response.status; error.authenticationFailed = response.status === 401 || response.status === 403;
        error.throttled = response.status === 429; error.retryAfterSeconds = retryAfterSeconds;
        throw error;
    }
    throw new Error("Microsoft Graph request failed.");
}

export function parseMicrosoftRetryAfter(value, now = Date.now()) {
    const text = String(value || "").trim();
    if (!text) return 0;
    if (/^\d+$/.test(text)) return Math.max(1, Math.min(3600, Number(text)));
    const date = Date.parse(text);
    return Number.isFinite(date) && date > now ? Math.max(1, Math.min(3600, Math.ceil((date - now) / 1000))) : 0;
}

function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

function graphMessageUid(messageId) { return Number.parseInt(hash(messageId).slice(0, 13), 16); }

export function parseMailboxSyncPeriod(value) {
    const from = clean(value?.from, 10), to = clean(value?.to, 10);
    if (!from && !to) return null;
    const since = isoDate(from), until = isoDate(to);
    if (!since || !until) throw httpError(400, "Sélectionnez une date de début et une date de fin valides.");
    const days = Math.round((until.getTime() - since.getTime()) / 86400000);
    if (days < 0) throw httpError(400, "La date de fin doit être postérieure ou égale à la date de début.");
    if (days > 30) throw httpError(400, "La recherche des e-mails est limitée à une période de 31 jours.");
    return { from, to, since, before: new Date(until.getTime() + 86400000) };
}

function sanitizeImapConfiguration(value) { const emailAddress = clean(value?.emailAddress, 254).toLowerCase(), username = clean(value?.username || emailAddress, 254), password = String(value?.password || "").trim().slice(0, 1000), selectionMode = MODES.has(value?.selectionMode) ? value.selectionMode : "manual"; const imapHost = host(value?.imapHost), smtpHost = host(value?.smtpHost), imapPort = port(value?.imapPort, 993), smtpPort = port(value?.smtpPort, 465); if (!/^\S+@\S+\.\S+$/.test(emailAddress) || !imapHost || !smtpHost || !username) return { ok: false, message: "Renseignez l’adresse, l’utilisateur et les serveurs IMAP/SMTP de la boîte professionnelle." }; return { ok: true, emailAddress, username, password, displayName: clean(value?.displayName, 160), selectionMode, allowedSenders: sanitizeSenders(value?.allowedSenders), requiredKeywords: sanitizeRequiredKeywords(value?.requiredKeywords), automaticThreshold: Math.max(70, Math.min(100, Number(value?.automaticThreshold) || AUTO_THRESHOLD)), sendStatusUpdates: Boolean(value?.sendStatusUpdates), server: { imap: { host: imapHost, port: imapPort, secure: value?.imapSecure !== false }, smtp: { host: smtpHost, port: smtpPort, secure: !(value?.smtpSecure === false || String(value?.smtpSecure) === "false") } } }; }
function outgoingAttachments(value) { let total = 0; const result = []; for (const item of Array.isArray(value) ? value.slice(0, 5) : []) { const match = /^data:([^;]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(item?.dataUrl || "")); if (!match || !ALLOWED_MIME.has(match[1])) throw httpError(400, "Un document à envoyer possède un format non autorisé."); const content = Buffer.from(match[2], "base64"); if (!content.length || content.length > MAX_ATTACHMENT_BYTES || total + content.length > 20 * 1024 * 1024) throw httpError(400, "Les documents à envoyer dépassent la limite autorisée."); total += content.length; result.push({ filename: safeFilename(item?.name), contentType: match[1], content }); } return result; }
function sanitizeSenders(value) { return [...new Set((Array.isArray(value) ? value : String(value || "").split(/[,;\n]/)).map(item => clean(item, 254).toLowerCase().replace(/^@/, "")).filter(item => /^\S+@\S+\.\S+$/.test(item) || /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(item)))].slice(0, 100); }
export function senderMatchesAllowed(sender, allowedSenders = []) { const address = String(sender || "").trim().toLowerCase(); const senderDomain = address.includes("@") ? address.split("@").pop() : ""; const filters = sanitizeSenders(allowedSenders); return !filters.length || filters.some(value => value.includes("@") ? address === value : senderDomain === value || senderDomain.endsWith(`.${value}`)); }
export function sanitizeRequiredKeywords(value) { return [...new Set((Array.isArray(value) ? value : String(value || "").split(/[,;\n]/)).map(item => clean(item, 120)).filter(item => normalizeKeywordText(item).split(" ").some(token => token.length >= 2)))].slice(0, 20); }
export function stripQuotedEmailText(value) { const lines = String(value || "").replace(/\r/g, "").split("\n"); const kept = []; for (const line of lines) { if (/^\s*(?:-{2,}\s*)?(?:message d['’]origine|original message|forwarded message)|^\s*(?:on .{0,200} wrote|le .{0,200} a écrit)\s*:|^\s*--\s*$/i.test(line)) break; if (!/^\s*>/.test(line)) kept.push(line); } return kept.join("\n").trim(); }
function normalizeKeywordText(value) { return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " "); }
function keywordExpressionMatches(expression, value) { const content = ` ${normalizeKeywordText(value)} `; const tokens = normalizeKeywordText(expression).split(" ").filter(token => token.length >= 2); return tokens.length > 0 && tokens.every(token => content.includes(` ${token} `)); }

async function reclassifyPendingCandidates(ownerId, connectionId, { allowedSenders, requiredKeywords }) {
    const { rows } = await getPool().query(`SELECT message.id,message.subject,message.body_text,message.document_text,message.sender_address,message.in_reply_to,EXISTS(SELECT 1 FROM depannhome_partner_email_attachments attachment WHERE attachment.email_message_id=message.id) AS has_attachment FROM depannhome_partner_email_messages message WHERE message.owner_id=$1 AND message.connection_id=$2 AND message.status='candidate'`, [ownerId, connectionId]);
    let removed = 0;
    for (const message of rows) {
        const classification = classifyPartnerEmail({ subject: message.subject, text: `${message.body_text || ""}\n${message.document_text || ""}`, from: message.sender_address, attachments: message.has_attachment ? [{ contentType: "application/pdf" }] : [], allowedSenders, requiredKeywords, reply: Boolean(message.in_reply_to) });
        if (classification.score < CANDIDATE_THRESHOLD) { await getPool().query("UPDATE depannhome_partner_email_messages SET status='ignored',classification_score=$3,classification_reasons=$4::jsonb,processed_at=NOW() WHERE id=$1 AND owner_id=$2 AND status='candidate'", [message.id, ownerId, classification.score, JSON.stringify(classification.reasons)]); removed += 1; }
        else await getPool().query("UPDATE depannhome_partner_email_messages SET classification_score=$3,classification_reasons=$4::jsonb WHERE id=$1 AND owner_id=$2 AND status='candidate'", [message.id, ownerId, classification.score, JSON.stringify(classification.reasons)]);
    }
    return removed;
}
function isMicrosoftMailbox(value) { const domain = String(value || "").toLowerCase().split("@").pop(); return /^(?:(?:outlook|hotmail|live)\.[a-z.]+|msn\.com)$/.test(domain); }
function normalizeMailboxPassword(emailAddress, value) { const password = String(value || "").trim(); return String(emailAddress || "").toLowerCase().endsWith("@gmail.com") ? password.replace(/\s+/g, "") : password; }
function oauthConfigured(provider) { const prefix = provider === "google" ? "GOOGLE_MAIL" : provider === "microsoft" ? "MICROSOFT_MAIL" : ""; return Boolean(prefix && process.env[`${prefix}_CLIENT_ID`] && process.env[`${prefix}_CLIENT_SECRET`] && process.env[`${prefix}_REDIRECT_URI`]); }
function oauthSettings(provider) { const prefix = provider === "google" ? "GOOGLE_MAIL" : "MICROSOFT_MAIL"; return { clientId: process.env[`${prefix}_CLIENT_ID`], clientSecret: process.env[`${prefix}_CLIENT_SECRET`], redirectUri: process.env[`${prefix}_REDIRECT_URI`] }; }
function oauthAuthorizationUrl(provider, state, verifier) { const settings = oauthSettings(provider), challenge = crypto.createHash("sha256").update(verifier).digest("base64url"); const url = new URL(provider === "google" ? "https://accounts.google.com/o/oauth2/v2/auth" : "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"); url.search = new URLSearchParams({ client_id: settings.clientId, redirect_uri: settings.redirectUri, response_type: "code", state, code_challenge: challenge, code_challenge_method: "S256", access_type: "offline", prompt: "consent", scope: provider === "google" ? "openid email profile https://mail.google.com/" : `${MICROSOFT_IDENTITY_SCOPES} ${MICROSOFT_MAIL_SCOPES}` }).toString(); return url.toString(); }
async function exchangeOauthCode(provider, code, verifier) { return oauthToken(provider, { grant_type: "authorization_code", code, redirect_uri: oauthSettings(provider).redirectUri, code_verifier: verifier, ...(provider === "microsoft" ? { scope: `${MICROSOFT_IDENTITY_SCOPES} ${MICROSOFT_MAIL_SCOPES}` } : {}) }); }
async function refreshOauth(provider, refreshToken) { if (!refreshToken) throw oauthProviderError(provider, { error: "missing_refresh_token" }, 400); return oauthToken(provider, { grant_type: "refresh_token", refresh_token: refreshToken, ...(provider === "microsoft" ? { scope: `${MICROSOFT_IDENTITY_SCOPES} ${MICROSOFT_MAIL_SCOPES}` } : {}) }); }
async function oauthToken(provider, values) {
    const settings = oauthSettings(provider);
    const response = await fetch(provider === "google" ? "https://oauth2.googleapis.com/token" : "https://login.microsoftonline.com/common/oauth2/v2.0/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...values, client_id: settings.clientId, client_secret: settings.clientSecret }), signal: AbortSignal.timeout(15000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) throw oauthProviderError(provider, payload, response.status);
    return payload;
}
async function oauthIdentity(provider, accessToken) { const response = await fetch(provider === "google" ? "https://openidconnect.googleapis.com/v1/userinfo" : "https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName", { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15000) }); const value = await response.json(); const email = clean(value.email || value.mail || value.userPrincipalName, 254).toLowerCase(); if (!response.ok || !email) throw new Error("Impossible d’identifier la boîte autorisée."); return { email, name: clean(value.name || value.displayName, 160) }; }
function oauthProviderError(provider, payload, status) { const error = new Error("Le fournisseur de messagerie a refusé l’autorisation."); error.oauthProvider = provider; error.oauthCode = clean(payload?.error, 80); error.oauthErrorCodes = (Array.isArray(payload?.error_codes) ? payload.error_codes : []).map(value => Number(value)).filter(Number.isFinite).slice(0, 5); error.oauthStatus = Number(status) || 0; error.oauthCorrelationId = clean(payload?.correlation_id, 80); return error; }
export function oauthErrorMessage(error, provider = "") {
    const code = String(error?.oauthCode || ""); const errorCodes = new Set(error?.oauthErrorCodes || []);
    if (code === "invalid_client" || errorCodes.has(7000215)) return `La configuration ${provider === "microsoft" ? "Microsoft Entra" : "OAuth"} est refusée : vérifiez l’identifiant client et surtout la valeur du secret client (pas son identifiant).`;
    if (errorCodes.has(7000222)) return "Le secret client Microsoft a expiré. Créez un nouveau secret dans Microsoft Entra puis remplacez sa valeur sur Render.";
    if (errorCodes.has(700016)) return "L’application Microsoft est introuvable pour cet identifiant client ou ce type de compte.";
    if (errorCodes.has(50011)) return "L’adresse de redirection Microsoft ne correspond pas exactement à celle configurée dans Microsoft Entra.";
    if (code === "invalid_grant") return "Le code Microsoft est invalide ou a expiré. Fermez cette fenêtre puis relancez immédiatement « Connecter Microsoft ».";
    if (["invalid_scope", "consent_required", "unauthorized_client"].includes(code)) return "L’application Microsoft ne dispose pas des autorisations déléguées Mail.Read et Mail.Send requises, ou le consentement est manquant.";
    if (code === "missing_refresh_token") return "Microsoft n’a pas fourni l’autorisation hors ligne nécessaire. Relancez la connexion et acceptez toutes les autorisations demandées.";
    return "Microsoft a refusé l’autorisation. Vérifiez le type de comptes accepté, l’URI Web, le secret client et les autorisations Graph Mail.Read/Mail.Send dans Microsoft Entra.";
}
function oauthErrorLog(error, provider) { return { provider, code: clean(error?.oauthCode || "provider_error", 80), errorCodes: Array.isArray(error?.oauthErrorCodes) ? error.oauthErrorCodes : [], status: Number(error?.oauthStatus) || 0, correlationId: clean(error?.oauthCorrelationId, 80) }; }
function mailErrorLog(error, provider) { return { provider, code: clean(error?.oauthCode || error?.code || error?.responseCode || "mailbox_error", 80), errorCodes: Array.isArray(error?.oauthErrorCodes) ? error.oauthErrorCodes : [], status: Number(error?.oauthStatus || error?.statusCode) || 0, authenticationFailed: Boolean(error?.authenticationFailed) }; }
function oauthPopup(res, success, message) { res.type("html").send(`<!doctype html><meta charset="utf-8"><title>Connexion boîte mail</title><p>${escapeHtml(message)}</p><script>window.opener?.postMessage(${JSON.stringify({ type: "depannhome:partner-email-oauth", success, message })},window.location.origin);window.close();</script>`); }
function requireEmailAccess(req, res, next) { if (!hasCompanyEmailWorkspaceAccess(req.user)) return res.status(403).json({ message: "L’espace e-mail de l’entreprise n’est pas autorisé sur ce poste." }); return next(); }
function requireEmailConfigurationAccess(req, res, next) { if (req.user?.role !== "admin" || req.user?.deviceType !== "desktop") return res.status(403).json({ message: "Seul un Administrateur PC peut modifier les réglages de la boîte professionnelle." }); return next(); }
function selectedIds(value) { return [...new Set((Array.isArray(value) ? value : []).map(positiveId).filter(Boolean))].slice(0, 100); }
export function publicMailError(error, { configuration = false, provider = "", sending = false } = {}) {
    if (error?.oauthCode || error?.oauthProvider) return oauthErrorMessage(error, provider || error.oauthProvider);
    const message = String(error?.message || "");
    const authenticationFailed = Boolean(error?.authenticationFailed) || /auth|credential|login|password|invalid credentials|authentication failed|authenticate failed/i.test(message);
    if (provider === "microsoft" && error?.statusCode === 400) return "Microsoft n’a pas pu fournir cette pièce jointe. Actualisez la boîte de réception puis réessayez.";
    if (provider === "microsoft" && error?.statusCode === 404) return sending ? "L’e-mail d’origine n’est plus disponible dans la boîte Microsoft." : "Cet e-mail ou cette pièce jointe n’est plus disponible dans la boîte Microsoft. Actualisez la boîte de réception.";
    if (provider === "microsoft" && (error?.throttled || error?.statusCode === 429 || error?.code === "ApplicationThrottled")) return `Microsoft limite temporairement l’accès à cette boîte. ${error?.retryAfterSeconds ? `Réessayez dans environ ${error.retryAfterSeconds} seconde(s)` : "Patientez quelques instants"}${sending ? "." : ", puis relancez une période plus courte."}`;
    if (provider === "microsoft" && authenticationFailed) return "Microsoft refuse l’accès à cette boîte. Déconnectez-la puis utilisez de nouveau « Connecter Microsoft » afin de renouveler les autorisations Mail.Read et Mail.Send.";
    if (provider === "microsoft" && error?.statusCode === 503) return "Microsoft Graph est temporairement indisponible. Patientez quelques instants puis réessayez.";
    if (authenticationFailed) return "La boîte a refusé l’authentification. Vérifiez son autorisation ou son mot de passe d’application.";
    if (/certificate|tls|ssl|self[- ]signed/i.test(message)) return "La connexion sécurisée au serveur de messagerie a échoué.";
    if (/timeout|timed out|etimedout|econnrefused|enotfound|getaddrinfo/i.test(message)) return "Le serveur de messagerie ne répond pas. Vérifiez les adresses, les ports et la disponibilité d’IMAP/SMTP.";
    return configuration ? "La vérification IMAP/SMTP a échoué. Vérifiez les serveurs, les ports et le mode de sécurité." : sending ? "La réponse n’a pas pu être envoyée depuis la boîte professionnelle." : "La boîte professionnelle n’a pas pu être synchronisée.";
}
function statusLabel(value) { return ({ pending_validation: "en attente de validation", accepted: "acceptée", rejected: "refusée", scheduled: "planifiée", en_route: "technicien en route", on_site: "technicien sur site", report_completed: "rapport terminé", report_validated: "rapport validé", quote_sent: "devis envoyé", work_completed: "travaux terminés", invoice_sent: "facture envoyée", closed: "clôturée", cancelled: "annulée" })[value] || value; }
function host(value) { const text = clean(value, 255).toLowerCase(); return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(text) ? text : ""; }
function port(value, fallback) { const number = Number(value || fallback); return Number.isSafeInteger(number) && number > 0 && number <= 65535 ? number : fallback; }
function isoDate(value) { const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "")); if (!match) return null; const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))); return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]) ? date : null; }
function positiveId(value) { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : 0; }
function safeFilename(value) { return String(value || "document").replace(/^.*[\\/]/, "").replace(/[\r\n]/g, " ").slice(0, 255) || "document"; }
function escapeRegExp(value) { return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function clean(value, max) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, max); }
function hash(value) { return crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : String(value || "")).digest("hex"); }
function escapeHtml(value) { return String(value || "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }
function httpError(status, message, details = {}) { const error = new Error(message); error.status = status; Object.assign(error, details); return error; }
function asyncHandler(handler) { return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(error => { if (!error.status) return next(error); if (error.retryAfterSeconds) res.set("Retry-After", String(error.retryAfterSeconds)); return res.status(error.status).json({ message: error.message, ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}) }); }); }
