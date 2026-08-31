import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import PizZip from "pizzip";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { classifyPartnerEmail, extractMissionPayload, extractNestedPartnerEmailContent, inspectMailboxStructure, mailboxReplyBody, mailTechnicalReason, normalizeMissionPostalAddress, oauthErrorMessage, oauthMailboxProviderIssue, parseMailboxPage, parseMailboxSyncPeriod, parseMicrosoftRetryAfter, partnerEmailDataUrl, publicMailError, replySubject, richerDocumentText, sanitizeRequiredKeywords, senderMatchesAllowed, shouldRefreshStoredPartnerEmail, stripQuotedEmailText } from "../server/partner-email.js";
import { simpleParser } from "mailparser";
import { mapPayload, readableEmailMissionReference } from "../server/partner-missions.js";
import { embeddedPdfImages, extractPartnerDocumentText, normalizePartnerDocumentMime, pdfImageOcrBuffer } from "../server/partner-email-document-extractor.js";

const serverSource = readFileSync(new URL("../server/partner-email.js", import.meta.url), "utf8");
const missionSource = readFileSync(new URL("../server/partner-missions.js", import.meta.url), "utf8");
const missionClientSource = readFileSync(new URL("../js/partner-missions.js", import.meta.url), "utf8");
const clientsSource = readFileSync(new URL("../js/clients.js", import.meta.url), "utf8");
const emailSettingsSource = readFileSync(new URL("../js/partner-email-settings.js", import.meta.url), "utf8");
const navigationSource = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
const schemaSource = readFileSync(new URL("../database/schema.sql", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const appClientSource = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");

const pdf = [{ contentType: "application/pdf", size: 1200 }];

test("une demande opérationnelle d’un expéditeur autorisé dépasse le seuil strict", () => {
    const result = classifyPartnerEmail({
        subject: "Nouvelle mission urgente – dossier SIN-2026-42",
        text: "Client : Marie Martin\nAdresse : 2 rue des Lilas\nTéléphone : 0600000000",
        from: "missions@assureur.test",
        allowedSenders: ["assureur.test"],
        attachments: pdf
    });
    assert.equal(result.trustedSender, true);
    assert.equal(result.likelyMission, true);
    assert.ok(result.score >= 80);
    assert.ok(result.reasons.some(reason => /Expéditeur autorisé/.test(reason)));
});

test("un expéditeur inconnu reste en validation humaine même avec de forts indices", () => {
    const result = classifyPartnerEmail({
        subject: "Mission urgente d’intervention sinistre",
        text: "Client : Marie Martin\nAdresse : 2 rue des Lilas\nRéférence : ABC-42",
        from: "inconnu@example.test",
        attachments: pdf
    });
    assert.equal(result.trustedSender, false);
    assert.equal(result.likelyMission, false);
    assert.ok(result.score < 80);
    assert.ok(result.reasons.some(reason => /Validation humaine/.test(reason)));
});

test("une liste de partenaires filtre strictement les expéditeurs tandis qu’une liste vide reste ouverte", () => {
    assert.equal(senderMatchesAllowed("missions@partenaire.fr", ["partenaire.fr"]), true);
    assert.equal(senderMatchesAllowed("missions@mail.partenaire.fr", ["partenaire.fr"]), true);
    assert.equal(senderMatchesAllowed("missions@partenaire.fr", ["missions@partenaire.fr"]), true);
    assert.equal(senderMatchesAllowed("autre@partenaire.fr", ["missions@partenaire.fr"]), false);
    assert.equal(senderMatchesAllowed("missions@fauxpartenaire.fr", ["partenaire.fr"]), false);
    assert.equal(senderMatchesAllowed("autre@example.test", ["partenaire.fr"]), false);
    assert.equal(senderMatchesAllowed("autre@example.test", []), true);
    const rejected = classifyPartnerEmail({ subject: "Mission urgente", text: "Client et adresse", from: "autre@example.test", allowedSenders: ["partenaire.fr"], attachments: pdf });
    assert.equal(rejected.score, 0);
    assert.match(rejected.reasons[0], /absent des adresses partenaires/);
    const unrestricted = classifyPartnerEmail({ subject: "Mission urgente", text: "Client et adresse", from: "autre@example.test", allowedSenders: [], attachments: pdf });
    assert.ok(unrestricted.score >= 35);
});

test("les relances et réponses automatiques ne deviennent pas des missions", () => {
    const reminder = classifyPartnerEmail({ subject: "Relance facture impayée", text: "Merci de procéder au règlement", from: "missions@assureur.test", allowedSenders: ["assureur.test"] });
    const automatic = classifyPartnerEmail({ subject: "Automatic reply: mission reçue", text: "Out of office", from: "missions@assureur.test", allowedSenders: ["assureur.test"], automatic: true, attachments: pdf });
    assert.equal(reminder.likelyMission, false);
    assert.equal(automatic.likelyMission, false);
    assert.ok(automatic.reasons.some(reason => /automatique/.test(reason)));
    assert.match(serverSource, /CANDIDATE_THRESHOLD = 35/);
    assert.match(serverSource, /classification\.score < CANDIDATE_THRESHOLD\) return null/);
});

test("les mots-clés obligatoires écartent les faux positifs et les réponses citées", () => {
    assert.deepEqual(sanitizeRequiredKeywords("mission partenaire IMH, sinistre urgent\nmission partenaire IMH"), ["mission partenaire IMH", "sinistre urgent"]);
    const matching = classifyPartnerEmail({ subject: "Mission intervention IMH", text: "Demande du partenaire pour le client", from: "missions@imh.test", allowedSenders: ["imh.test"], requiredKeywords: ["mission partenaire IMH"] });
    assert.equal(matching.keywordMatch, true);
    assert.ok(matching.score >= 80);
    const unrelated = classifyPartnerEmail({ subject: "Réservation M Regat", text: "Client : Peter\nAdresse : Nantes", from: "admin@example.test", attachments: pdf, requiredKeywords: ["mission partenaire IMH"] });
    assert.equal(unrelated.score, 0);
    assert.match(unrelated.reasons[0], /Aucun mot-clé/);
    const quoted = "Bien reçu, merci.\n\n----- Message d’origine -----\nMission partenaire IMH\nClient : Peter";
    assert.equal(stripQuotedEmailText(quoted), "Bien reçu, merci.");
    const reply = classifyPartnerEmail({ subject: "RE: Mission partenaire IMH", text: quoted, from: "admin@example.test", requiredKeywords: ["mission partenaire IMH"], reply: true });
    assert.equal(reply.score, 0);
    assert.match(reply.reasons[0], /fil existant/);
});

test("la recherche automatique s’exécute toutes les 10 minutes avec les critères enregistrés", () => {
    assert.match(serverSource, /PARTNER_EMAIL_SYNC_INTERVAL_MS = 10 \* 60 \* 1000/);
    assert.match(serverSource, /runPartnerEmailScheduler\("startup"\)\.finally\(scheduleNextPartnerEmailRun\)/);
    assert.match(serverSource, /setTimeout\(\(\) =>[\s\S]*?runPartnerEmailScheduler\("scheduled"\)[\s\S]*?PARTNER_EMAIL_SYNC_INTERVAL_MS/);
    assert.match(serverSource, /runPartnerEmailScheduler\("scheduled"\)\.finally\(scheduleNextPartnerEmailRun\)/);
    assert.match(serverSource, /connection\.enabled=TRUE AND connection\.auto_search_enabled=TRUE/);
    assert.match(serverSource, /connection\.last_sync_at IS NULL OR connection\.last_sync_at<NOW\(\)-INTERVAL '10 minutes'/);
    const accepted = classifyPartnerEmail({ subject: "Ordre de mission – dégât des eaux", text: "Client assuré et adresse", from: "missions@mail.assureur.fr", allowedSenders: ["assureur.fr"], requiredKeywords: ["dégât des eaux"], attachments: pdf });
    assert.equal(accepted.trustedSender, true);
    assert.equal(accepted.keywordMatch, true);
    assert.ok(accepted.score >= 80);
    assert.equal(classifyPartnerEmail({ subject: "Ordre de mission", text: "Client assuré et adresse", from: "missions@mail.assureur.fr", allowedSenders: ["assureur.fr"], requiredKeywords: ["dégât des eaux"], attachments: pdf }).score, 0);
    assert.equal(classifyPartnerEmail({ subject: "Ordre de mission – dégât des eaux", text: "Client assuré et adresse", from: "mission@autre.fr", allowedSenders: ["assureur.fr"], requiredKeywords: ["dégât des eaux"], attachments: pdf }).score, 0);
});

test("les secrets, dédoublonnages et pièces privées sont définis côté serveur", () => {
    assert.match(serverSource, /encryptElectronicInvoicingCredentials/);
    assert.match(serverSource, /UNIQUE\(owner_id,connection_id,message_id\)/);
    assert.match(serverSource, /partnerVisible: false/);
    assert.match(serverSource, /MAX_ATTACHMENT_BYTES = 5 \* 1024 \* 1024/);
    assert.doesNotMatch(serverSource, /encrypted_credentials AS/);
    assert.match(schemaSource, /depannhome_partner_email_messages[\s\S]*?status IN \('candidate','processing','imported','ignored','rejected'\)/);
});

test("la boîte mail dépend de la capacité E-mail Basic+/Pro et non des connecteurs", () => {
    assert.match(appSource, /const requirePartnerEmailFeature = requireOrganizationFeature\("companyEmail"\)/);
    assert.match(appSource, /if \(isPartnerEmailOAuthCallback\(request\)\) return next\(\)/);
    assert.match(missionSource, /intake\.partner_key LIKE 'email-%'/);
    assert.match(missionSource, /sourceType: partnerKey\.startsWith\("connection-"\) \? "depannhome_network" : partnerKey\.startsWith\("email-"\) \? "professional_email"/);
});

test("les callbacks OAuth mail utilisent l’état temporaire sans exiger le cookie de session", () => {
    const callback = serverSource.indexOf('app.get("/api/partner-email/oauth/:provider/callback"');
    const protection = serverSource.indexOf('app.use("/api/partner-email", requireAuthentication');
    assert.ok(callback >= 0 && callback < protection);
    assert.match(serverSource, /RETURNING owner_id,actor_id,encrypted_context/);
    assert.match(serverSource, /\[pending\.owner_id, provider,[\s\S]*?pending\.actor_id\]/);
    assert.doesNotMatch(serverSource.slice(callback, protection), /req\.user|getAccountOwnerId\(req\)/);
    assert.match(appSource, /function isPartnerEmailOAuthCallback\(request\)[\s\S]*?request\.method === "GET"[\s\S]*?google\|microsoft/);
});

test("une boîte OAuth n’est déclarée connectée qu’après un accès réel au fournisseur", () => {
    const callback = serverSource.slice(serverSource.indexOf('app.get("/api/partner-email/oauth/:provider/callback"'), serverSource.indexOf('app.use("/api/partner-email"'));
    assert.ok(callback.indexOf("verifyOAuthMailboxAccess") < callback.indexOf("INSERT INTO depannhome_partner_email_connections"));
    assert.match(callback, /verified_at\) VALUES[\s\S]*NOW\(\)/);
    assert.match(callback, /connectée et accès aux e-mails vérifié/);
    assert.match(serverSource, /gmailProfile\(accessToken\)/);
    assert.match(serverSource, /mailFolders\/inbox\/messages\?\$select=id&\$top=1/);
    assert.match(schemaSource, /verified_at TIMESTAMPTZ/);
    assert.match(emailSettingsSource, /Connexion non vérifiée/);
});

test("une adresse Hotmail engagée par erreur via Google est orientée vers Microsoft", () => {
    assert.match(oauthMailboxProviderIssue("google", "regatpeter@hotmail.fr"), /Connecter Microsoft/);
    assert.equal(oauthMailboxProviderIssue("microsoft", "regatpeter@hotmail.fr"), "");
    assert.equal(oauthMailboxProviderIssue("google", "missions@entreprise.fr"), "");
    assert.match(publicMailError({ publicMessage: oauthMailboxProviderIssue("google", "regatpeter@hotmail.fr") }, { provider: "google" }), /Outlook\/Hotmail/);
});

test("les refus réels de transport exposent une cause technique nettoyée sans masquer l’action adaptée", () => {
    const error = Object.assign(new Error("Authentication failed"), { authenticationFailed: true, responseCode: "AUTHENTICATIONFAILED", responseText: "Invalid credentials" });
    assert.equal(mailTechnicalReason(error), "AUTHENTICATIONFAILED · Invalid credentials");
    assert.equal(mailTechnicalReason(new Error("access_token=secret-value password=hunter2")), "access_token=[masqué] password=[masqué]");
    const message = publicMailError(error, { provider: "google", mailbox: "boite@entreprise.fr" });
    assert.match(message, /Gmail API/);
    assert.match(message, /Cause technique : AUTHENTICATIONFAILED/);
    assert.match(message, /Connecter Google Workspace/);
    assert.match(serverSource, /operation: "inbox_list"/);
    assert.match(serverSource, /operation: "mailbox_sync"/);
    assert.match(serverSource, /technicalReason: mailTechnicalReason\(error\)/);
    assert.match(oauthErrorMessage({ oauthCode: "invalid_scope" }, "google"), /Google Cloud/);
    assert.doesNotMatch(oauthErrorMessage({ oauthCode: "invalid_scope" }, "google"), /Microsoft|Mail\.Read/);
});

test("Gmail API désactivée produit une consigne Google Cloud exploitable", () => {
    const error = Object.assign(new Error("Gmail API authentication failed."), { code: "accessNotConfigured", statusCode: 403, authenticationFailed: true });
    const message = publicMailError(error, { provider: "google", configuration: true });
    assert.match(message, /Gmail API n’est pas activée/);
    assert.match(message, /GOOGLE_MAIL_CLIENT_ID/);
    assert.match(message, /API et services → Bibliothèque/);
    assert.match(message, /Connecter Google Workspace/);
    assert.doesNotMatch(message, /renouveler les autorisations/);
    assert.match(serverSource, /error\?\.oauthCode \|\| error\?\.code \|\| "provider_error"/);
    assert.match(serverSource, /error\?\.oauthStatus \|\| error\?\.statusCode/);
});

test("les refus Gmail Workspace indiquent leur remède au lieu d’un 502 générique", () => {
    assert.match(publicMailError({ code: "failedPrecondition", statusCode: 400 }, { provider: "google" }), /Ouvrez Gmail une première fois/);
    assert.match(publicMailError({ code: "insufficientPermissions", statusCode: 403 }, { provider: "google" }), /gmail\.readonly et gmail\.send/);
    assert.match(publicMailError({ code: "domainPolicy", statusCode: 403 }, { provider: "google" }), /administrateur Google Workspace/);
    assert.match(publicMailError({ code: "INVALID_ARGUMENT", statusCode: 400 }, { provider: "google" }), /Réduisez la période/);
    assert.match(publicMailError({ code: "backendError", statusCode: 500 }, { provider: "google" }), /backendError/);
    const googleSync = serverSource.slice(serverSource.indexOf("async function syncGoogleConnection"), serverSource.indexOf("async function syncMicrosoftConnection"));
    assert.match(googleSync, /error\?\.statusCode !== 404/);
    assert.match(googleSync, /unavailable \+= 1/);
    assert.match(serverSource, /error\?\.statusCode === 400 \? 422/);
});

test("Microsoft utilise Graph pour les comptes personnels et explique les refus sans exposer les secrets", () => {
    assert.match(serverSource, /MICROSOFT_IDENTITY_SCOPES/);
    assert.match(serverSource, /MICROSOFT_MAIL_SCOPES = "Mail\.Read Mail\.Send"/);
    assert.match(serverSource, /graph\.microsoft\.com\/v1\.0\/me\/mailFolders\/inbox\/messages/);
    assert.match(serverSource, /graph\.microsoft\.com\/v1\.0\/me\/messages\/\$\{encodeURIComponent\(messageId\)\}\/\$value/);
    assert.match(serverSource, /graph\.microsoft\.com\/v1\.0\/me\/sendMail/);
    assert.doesNotMatch(serverSource, /outlook\.office365\.com|smtp\.office365\.com|IMAP\.AccessAsUser\.All|SMTP\.Send/);
    assert.match(serverSource, /console\.warn\("\[partner-email-oauth\] authorization or mailbox validation rejected"/);
    assert.doesNotMatch(serverSource, /console\.(?:warn|error)\([^\n]*clientSecret/);
    assert.match(oauthErrorMessage({ oauthCode: "invalid_client", oauthErrorCodes: [7000215] }, "microsoft"), /valeur du secret client/);
    assert.match(oauthErrorMessage({ oauthCode: "invalid_grant" }, "microsoft"), /expiré/);
    assert.match(oauthErrorMessage({ oauthErrorCodes: [50011] }, "microsoft"), /redirection/);
});

test("la synchronisation distingue un refus OAuth d’un accès Microsoft Graph refusé", () => {
    const mailErrorLogSource = serverSource.slice(serverSource.indexOf("function mailErrorLog"), serverSource.indexOf("function oauthPopup"));
    assert.match(publicMailError({ oauthProvider: "microsoft", oauthCode: "consent_required" }, { provider: "microsoft" }), /Mail\.Read et Mail\.Send/);
    assert.match(publicMailError({ authenticationFailed: true }, { provider: "microsoft" }), /Connecter Microsoft/);
    assert.match(publicMailError(new Error("Authentication failed"), { provider: "google" }), /Gmail API/);
    assert.match(serverSource, /mailbox synchronization rejected/);
    assert.doesNotMatch(mailErrorLogSource, /accessToken|refreshToken|clientSecret/);
    assert.match(publicMailError({ statusCode: 404 }, { provider: "microsoft" }), /n’est plus disponible/);
    assert.match(publicMailError({ statusCode: 503 }, { provider: "microsoft" }), /temporairement indisponible/);
    assert.match(publicMailError({ statusCode: 400, code: "BadRequest" }, { provider: "microsoft" }), /n’a pas pu fournir cette pièce jointe/);
    const liveFailureHandler = serverSource.slice(serverSource.indexOf("async function liveMailboxOperation"), serverSource.indexOf("function setLiveMailboxHeaders"));
    assert.match(liveFailureHandler, /error\?\.statusCode === 400 \? 422/);
    assert.match(liveFailureHandler, /error\?\.statusCode === 404 \? 404/);
});

test("Microsoft Graph respecte Retry-After et limite les reprises en cas de quota", () => {
    const now = Date.parse("2026-08-25T12:00:00Z");
    assert.equal(parseMicrosoftRetryAfter("7", now), 7);
    assert.equal(parseMicrosoftRetryAfter("Tue, 25 Aug 2026 12:00:12 GMT", now), 12);
    assert.equal(parseMicrosoftRetryAfter("date invalide", now), 0);
    assert.equal(parseMicrosoftRetryAfter("99999", now), 3600);
    assert.match(serverSource, /MICROSOFT_GRAPH_MAX_RETRIES = 2/);
    assert.match(serverSource, /response\.status === 429 \|\| response\.status === 503/);
    assert.match(serverSource, /response\.headers\.get\("retry-after"\)/);
    assert.match(serverSource, /await delay\(retryDelay\)/);
    assert.match(serverSource, /res\.set\("Retry-After"/);
    assert.match(publicMailError({ statusCode: 429, code: "ApplicationThrottled", throttled: true, retryAfterSeconds: 15 }, { provider: "microsoft" }), /Réessayez dans environ 15 seconde/);
});

test("la synchronisation Microsoft est séquentielle et reprend sans perdre de messages", () => {
    const microsoftSync = serverSource.slice(serverSource.indexOf("async function syncMicrosoftConnection"), serverSource.indexOf("async function listLiveInbox"));
    assert.match(microsoftSync, /for \(const message of search\.messages\)/);
    assert.doesNotMatch(microsoftSync, /Promise\.all/);
    assert.match(serverSource, /activeMailboxSynchronizations/);
    assert.match(serverSource, /Une synchronisation de cette boîte est déjà en cours/);
    const failureHandler = serverSource.slice(serverSource.indexOf("mailbox synchronization rejected"), serverSource.indexOf("async function syncMicrosoftConnection"));
    assert.doesNotMatch(failureHandler, /last_sync_at=NOW/);
    assert.match(failureHandler, /error\?\.statusCode === 429 \? 429/);
});

test("les missions e-mail utilisent la même interface que les missions internes et externes", () => {
    assert.match(missionClientSource, /shell\.querySelectorAll\('\.partner-mission-tabs'\)\[1\]\.innerHTML = externalTabs/);
    assert.match(missionClientSource, /emailCandidates[\s\S]*\.map\(emailCandidateMission\)/);
    assert.match(missionClientSource, /class="partner-mission-card priority-/);
    assert.match(missionClientSource, /status: "email_candidate"/);
    assert.match(missionClientSource, /id="syncPartnerEmail"/);
    assert.match(missionClientSource, /id="partnerEmailSyncFrom"/);
    assert.match(missionClientSource, /id="partnerEmailSyncTo"/);
    assert.match(missionClientSource, /JSON\.stringify\(\{ from, to \}\)/);
    assert.doesNotMatch(missionClientSource, /data-mission-tab="email-inbox"/);
    assert.doesNotMatch(missionClientSource, /partner-email-candidate(?:-heading|-select)?/);
});

test("toutes les origines affichent réellement toutes les missions sans filtre de statut", () => {
    const filtering = missionClientSource.slice(missionClientSource.indexOf("function renderMissionTab"), missionClientSource.indexOf("function renderMissions"));
    const dashboardQuery = missionSource.slice(missionSource.indexOf("async function missionDashboard"), missionSource.indexOf("async function reconcileMissionClients"));
    assert.match(filtering, /activeMissionSpace === "network"[\s\S]*?activeMissionSpace === "email"[\s\S]*?sourceType === "external_connector"/);
    assert.match(filtering, /\(!status \|\| mission\.status === status\) && \(!query \|\| matchesSearch\)/);
    assert.doesNotMatch(filtering, /mission\.status !== "closed"/);
    assert.doesNotMatch(dashboardQuery, /LIMIT 200/);
    assert.match(missionSource, /depannhome_partner_missions_owner_visible_updated_idx/);
});

test("une lecture API interrompue est retentée sans rejouer les écritures", () => {
    const apiClient = missionClientSource.slice(missionClientSource.indexOf("async function api(url"));
    assert.match(apiClient, /String\(options\.method \|\| "GET"\)\.toUpperCase\(\) === "GET"/);
    assert.match(apiClient, /response = await fetch\(url, \{ \.\.\.requestOptions, cache: "no-store" \}\)/);
    assert.match(apiClient, /if \(!retryable\) throw error/);
});

test("toutes les missions utilisent le planning visuel puis ouvrent leur conversation", () => {
    const rendering = missionClientSource.slice(missionClientSource.indexOf("node.querySelectorAll(\"[data-accept]\")"), missionClientSource.indexOf("node.querySelectorAll(\"[data-reject]\")"));
    const planning = missionClientSource.slice(missionClientSource.indexOf("async function openPartnerMissionPlanning"), missionClientSource.indexOf("function showAccept"));
    assert.match(rendering, /if \(mission\) openPartnerMissionPlanning\(mission\)/);
    assert.doesNotMatch(rendering, /sourceType === "depannhome_network"/);
    assert.match(planning, /view: "day"/);
    assert.match(planning, /visibleTechnicianIds: assignedTechnicianIds/);
    assert.match(planning, /assignedTechnicianIds: payload\.assignedTechnicianIds/);
    assert.match(planning, /await openPartnerDialogue\(mission\.id\)/);
});

test("l’acceptation garantit le client et verrouille tous les techniciens sélectionnés", () => {
    const acceptance = missionSource.slice(missionSource.indexOf("async function acceptMission"), missionSource.indexOf("async function updateStatus"));
    assert.match(acceptance, /const clientId = await upsertClient/);
    assert.match(acceptance, /assignedTechnicianIds = \[\.\.\.new Set/);
    assert.match(acceptance, /for \(const assignedId of \[\.\.\.assignedTechnicianIds\]\.sort/);
    assert.match(acceptance, /assertAvailableSchedule\(connection, ownerId, assignedId/);
    assert.match(acceptance, /replacePartnerCalendarAssignments\(connection, eventId, assignedTechnicianIds, technicianId\)/);
    assert.ok(acceptance.indexOf("await upsertClient") < acceptance.indexOf("await upsertCalendar"));
});

test("un chargement de missions devenu obsolète n’écrit pas dans l’écran suivant", () => {
    assert.match(missionClientSource, /partnerMissionRenderSequence/);
    assert.match(missionClientSource, /renderSequence !== partnerMissionRenderSequence/);
    assert.match(missionClientSource, /!shell\?\.isConnected \|\| !container\.contains\(shell\)/);
    assert.match(missionClientSource, /!shell\.isConnected \|\| !container\.contains\(shell\)/);
});

test("la recherche manuelle accepte une période inclusive de 31 jours sans déplacer le curseur automatique", () => {
    const period = parseMailboxSyncPeriod({ from: "2026-08-01", to: "2026-08-31" });
    assert.equal(period.from, "2026-08-01");
    assert.equal(period.to, "2026-08-31");
    assert.equal(period.since.toISOString(), "2026-08-01T00:00:00.000Z");
    assert.equal(period.before.toISOString(), "2026-09-01T00:00:00.000Z");
    assert.throws(() => parseMailboxSyncPeriod({ from: "2026-08-01", to: "2026-09-01" }), /31 jours/);
    assert.throws(() => parseMailboxSyncPeriod({ from: "2026-08-31", to: "2026-08-01" }), /postérieure/);
    assert.throws(() => parseMailboxSyncPeriod({ from: "2026-02-30", to: "2026-02-30" }), /valides/);
    assert.match(serverSource, /periodUids\(client, syncPeriod\)/);
    assert.match(serverSource, /advanceCursor: !syncPeriod/);
    assert.match(serverSource, /PERIOD_FETCH_LIMIT = 500/);
});

test("la boîte professionnelle se configure dans l’espace Entreprise dédié", () => {
    assert.match(navigationSource, /renderPartnerEmailSettings\(container\)/);
    assert.match(navigationSource, /depannhome:open-partner-email-settings/);
    assert.match(navigationSource, /section: "company", focusPartnerEmail: true/);
    assert.match(navigationSource, /Entreprise · Boîte mail/);
    const networkSection = navigationSource.slice(navigationSource.indexOf('if (section === "network")'), navigationSource.indexOf('if (section === "support")'));
    assert.doesNotMatch(networkSection, /renderPartnerEmailSettings/);
    assert.match(navigationSource, /organizationFeatureEnabled\("partnerConnections"\)\) renderPartnerConnections\(container\)/);
    assert.match(emailSettingsSource, /id="partnerEmailImapForm"/);
    assert.match(emailSettingsSource, /\/api\/partner-email\/configuration/);
    assert.match(emailSettingsSource, /data-email-oauth="microsoft"/);
    assert.match(emailSettingsSource, /emailPasswordToggle/);
    assert.match(emailSettingsSource, /password\.type = visible \? "text" : "password"/);
    assert.match(emailSettingsSource, /aria-pressed/);
    assert.doesNotMatch(missionClientSource, /id="partnerEmailImapForm"/);
    assert.doesNotMatch(missionClientSource, /activeMissionTab === "email-settings"/);
    assert.doesNotMatch(missionClientSource, /id="configurePartnerEmail"/);
});

test("la recherche automatique des missions est une option explicite indépendante de la recherche manuelle", () => {
    assert.match(schemaSource, /auto_search_enabled BOOLEAN NOT NULL DEFAULT FALSE/);
    assert.match(serverSource, /ADD COLUMN IF NOT EXISTS auto_search_enabled BOOLEAN NOT NULL DEFAULT FALSE/);
    assert.match(serverSource, /connection\.enabled=TRUE AND connection\.auto_search_enabled=TRUE/);
    assert.match(serverSource, /auto_search_enabled AS "autoSearchEnabled"/);
    assert.match(serverSource, /:connectionId\/automatic-search/);
    assert.match(emailSettingsSource, /partnerEmailOauthAutoSearch/);
    assert.match(emailSettingsSource, /data-email-auto-search/);
    assert.match(emailSettingsSource, /Activer la recherche automatique des missions/);
    const manualSyncRoute = serverSource.slice(serverSource.indexOf('app.post("/api/partner-email/:connectionId/sync"'), serverSource.indexOf('app.patch("/api/partner-email/:connectionId/settings"'));
    assert.doesNotMatch(manualSyncRoute, /auto_search_enabled/);
});

test("une boîte rattachée s’actualise immédiatement et expose toutes les commandes de recherche", () => {
    assert.match(emailSettingsSource, /depannhome:partner-email-changed/);
    assert.match(emailSettingsSource, /dispatchMailboxChanged\("connection"\)/);
    assert.match(emailSettingsSource, /dispatchMailboxChanged\("sync"/);
    assert.match(emailSettingsSource, /data-email-sync-from/);
    assert.match(emailSettingsSource, /data-email-sync-to/);
    assert.match(emailSettingsSource, /data-email-selection-mode/);
    assert.match(emailSettingsSource, /data-email-auto-search/);
    assert.match(emailSettingsSource, /data-email-save-settings/);
    assert.match(emailSettingsSource, /Voir les missions détectées/);
    assert.match(emailSettingsSource, /mission\(s\) à confirmer/);
    assert.match(navigationSource, /depannhome:open-partner-email-missions/);
    assert.match(missionClientSource, /depannhome:show-partner-email-missions/);
    assert.match(missionClientSource, /depannhome:partner-email-changed/);
});

test("les réglages d’une boîte existante sont enregistrés côté serveur par un Poste Admin", () => {
    assert.match(serverSource, /:connectionId\/settings", requireEmailConfigurationAccess/);
    assert.match(serverSource, /SET selection_mode=\$3, allowed_senders=\$4::jsonb, required_keywords=\$5::jsonb, automatic_threshold=\$6/);
    assert.match(serverSource, /auto_search_enabled=\$8/);
    assert.match(serverSource, /req\.user\?\.role !== "admin"/);
    assert.match(serverSource, /req\.user\?\.deviceType !== "desktop"/);
    assert.match(emailSettingsSource, /function canConfigureMailbox\(\)/);
    assert.match(emailSettingsSource, /selectionMode: row\.querySelector\("\[data-email-selection-mode\]"\)\.value/);
    assert.match(emailSettingsSource, /automaticThreshold: Number/);
    assert.match(emailSettingsSource, /allowedSenders: row\.querySelector/);
});

test("les critères e-mail sont enregistrés et nettoient immédiatement les propositions hors sujet", () => {
    assert.match(schemaSource, /required_keywords JSONB NOT NULL DEFAULT '\[\]'::jsonb/);
    assert.match(serverSource, /ADD COLUMN IF NOT EXISTS required_keywords/);
    assert.match(serverSource, /required_keywords AS "requiredKeywords"/);
    assert.match(serverSource, /reclassifyPendingCandidates/);
    assert.match(serverSource, /status='ignored'.*classification_score/s);
    assert.match(emailSettingsSource, /Mots-clés obligatoires pour une mission/);
    assert.match(emailSettingsSource, /data-email-required-keywords/);
    assert.match(emailSettingsSource, /requiredKeywords: row\.querySelector/);
    assert.match(emailSettingsSource, /Critères enregistrés pour cette boîte/);
    assert.match(emailSettingsSource, /Expéditeurs \/ domaines/);
    assert.match(emailSettingsSource, /Les critères enregistrés s’appliquent aux prochaines recherches manuelles et automatiques/);
    assert.match(emailSettingsSource, /reload: \(\) => loadCompanyEmailWorkspace\(card\)/);
});

test("les propositions de mission peuvent être confirmées ou supprimées seules ou en sélection", () => {
    assert.match(missionClientSource, /data-email-confirm-one/);
    assert.match(missionClientSource, /data-email-delete-one/);
    assert.match(missionClientSource, /Confirmer la sélection/);
    assert.match(missionClientSource, /Supprimer la sélection/);
    assert.match(missionClientSource, /l’e-mail reste dans la boîte connectée/);
    assert.match(missionClientSource, /\/api\/partner-email\/candidates\/import/);
    assert.match(missionClientSource, /\/api\/partner-email\/candidates\/ignore/);
});

test("l’espace e-mail affiche et présélectionne les missions trouvées pour leur validation", () => {
    assert.match(emailSettingsSource, /data-email-search-results/);
    assert.match(emailSettingsSource, /String\(candidate\.connectionId\) === String\(connection\.id\)/);
    assert.match(emailSettingsSource, /connection\.selectionMode === "manual" \? "checked"/);
    assert.match(emailSettingsSource, /Valider la sélection vers Missions partenaires/);
    assert.match(emailSettingsSource, /\/api\/partner-email\/candidates\/\$\{action\}/);
    assert.match(emailSettingsSource, /await refreshEmailSearchResults\(card, button\.dataset\.emailSync, true\)/);
    assert.match(emailSettingsSource, /candidate-import/);
});

test("la boîte complète se consulte à la demande sans stockage ni déplacement du curseur de missions", () => {
    assert.deepEqual(parseMailboxPage({}), { offset: 0, limit: 30 });
    assert.deepEqual(parseMailboxPage({ offset: "42", limit: "500" }), { offset: 42, limit: 50 });
    assert.deepEqual(parseMailboxPage({ offset: "-8", limit: "0" }), { offset: 0, limit: 30 });
    const routes = serverSource.slice(serverSource.indexOf('app.get("/api/partner-email/:connectionId/inbox"'), serverSource.indexOf('app.post("/api/partner-email/:connectionId/sync"'));
    assert.match(routes, /listLiveInbox/);
    assert.match(routes, /readLiveMessage/);
    assert.match(routes, /downloadLiveAttachment/);
    assert.match(routes, /setLiveMailboxHeaders\(res\)/);
    assert.match(routes, /X-Content-Type-Options.*nosniff/);
    assert.doesNotMatch(routes, /INSERT INTO|last_uid|last_sync_at|saveParsedEmail|completeSync/);
    assert.match(serverSource, /Cache-Control": "private, no-store"/);
    assert.match(serverSource, /Pragma: "no-cache"/);
    assert.match(appSource, /partner-email\/:connectionId\/inbox/);
    assert.match(appSource, /Trop de consultations de la boîte mail/);
    assert.match(serverSource, /LIVE_MAILBOX_DEFAULT_LIMIT = 30/);
    assert.match(serverSource, /LIVE_MAILBOX_MAX_LIMIT = 50/);
    assert.match(serverSource, /LIVE_MAILBOX_BODY_BYTES = 512 \* 1024/);
    assert.match(serverSource, /client\.download\(String\(uid\), structure\.body\.part/);
    assert.match(serverSource, /maxBytes: MAX_ATTACHMENT_BYTES \+ 1/);
    const graphAttachmentDownload = serverSource.slice(serverSource.indexOf("async function downloadLiveAttachment"), serverSource.indexOf("async function graphMessageAttachments"));
    assert.match(graphAttachmentDownload, /contentBytes/);
    assert.match(graphAttachmentDownload, /Buffer\.from\(file\.contentBytes, "base64"\)/);
    assert.equal((graphAttachmentDownload.match(/graphJson\(/g) || []).length, 1);
    assert.doesNotMatch(graphAttachmentDownload, /\?\$select=/);
    assert.match(graphAttachmentDownload, /#microsoft\.graph\.fileAttachment/);
    assert.doesNotMatch(graphAttachmentDownload, /\/\$value/);
    const graphMessageRead = serverSource.slice(serverSource.indexOf("async function readLiveMessage"), serverSource.indexOf("async function sendLiveMailboxReply"));
    assert.match(graphMessageRead, /attachmentsUnavailable/);
    assert.match(graphMessageRead, /Microsoft attachment metadata unavailable/);
    assert.match(serverSource, /withMicrosoftGraphAccess[\s\S]*forceRefresh: true/);
    assert.match(emailSettingsSource, /Microsoft n’a pas permis de charger ses pièces jointes/);
});

test("un e-mail ouvert crée une mission avec les pièces sélectionnées et celles de ses messages imbriqués", () => {
    const importRoute = serverSource.slice(serverSource.indexOf('app.post("/api/partner-email/:connectionId/messages/:messageRef/import"'), serverSource.indexOf('app.post("/api/partner-email/:connectionId/sync"'));
    assert.match(importRoute, /requiredConnection\(ownerId/);
    assert.match(importRoute, /importLiveMailboxMessage/);
    assert.match(importRoute, /req\.body\?\.attachmentIds/);
    assert.match(serverSource, /requestedAttachmentIds\.map\(String\)\.slice\(0, MAX_ATTACHMENTS\)/);
    assert.match(serverSource, /extractNestedPartnerEmailContent\(parsedSource\)/);
    assert.match(serverSource, /preparePartnerEmailAttachments\(attachments\)/);
    assert.match(serverSource, /refreshStoredLiveEmail/);
    assert.match(serverSource, /DELETE FROM depannhome_partner_email_attachments WHERE email_message_id=\$1/);
    assert.match(serverSource, /WHERE owner_id=\$1 AND connection_id=\$2 AND uid=\$3/);
    assert.match(serverSource, /reanalyzed: wasImported/);
    assert.match(serverSource, /depannhome_partner_dialogue_attachments WHERE owner_id=\$1 AND mission_id=\$2[\s\S]*?file_data=\$6/);
    assert.match(appSource, /messages\/:messageRef\/import[\s\S]*?limit: 30/);
    assert.match(emailSettingsSource, /data-mailbox-mission-attachment/);
    assert.match(emailSettingsSource, /data-mailbox-import-mission/);
    assert.match(emailSettingsSource, /JSON\.stringify\(\{ attachmentIds \}\)/);
    assert.match(emailSettingsSource, /Envoyer ce mail dans Missions partenaires/);
});

test("la détection automatique recherche les indices dans le corps et les documents", () => {
    assert.match(schemaSource, /body_text TEXT NOT NULL DEFAULT '', document_text TEXT NOT NULL DEFAULT ''/);
    assert.match(serverSource, /depannhome_partner_email_messages ADD COLUMN IF NOT EXISTS document_text TEXT NOT NULL DEFAULT ''/);
    assert.match(serverSource, /const attachmentText = await extractPartnerDocumentText\(attachments\.map/);
    assert.match(serverSource, /\[parsed\.nestedText, nested\.text, attachmentText\]/);
    assert.match(serverSource, /text: `\$\{parsed\.text \|\| ""\}\\n\$\{documentText\}`/);
    assert.match(serverSource, /message\.body_text \|\| ""\}\\n\$\{message\.document_text \|\| ""/);
    assert.match(serverSource, /forceCandidate \? \[\] : connection\.required_keywords/);
});

test("l’import manuel actualise la fiche client et les missions visibles", () => {
    assert.match(emailSettingsSource, /synchronizeClients\(\{ forceFull: true \}\)/);
    assert.match(emailSettingsSource, /depannhome:partner-client-provisioned/);
    assert.match(emailSettingsSource, /dispatchMailboxChanged\("mailbox-import"/);
    assert.match(emailSettingsSource, /Mission partenaire créée/);
    assert.match(emailSettingsSource, /Mission partenaire actualisée/);
});

test("l’entreprise répond directement depuis la boîte connectée dans le fil d’origine", () => {
    assert.equal(replySubject("Demande d’intervention"), "Re: Demande d’intervention");
    assert.equal(replySubject("RE: Demande d’intervention"), "RE: Demande d’intervention");
    assert.equal(mailboxReplyBody("  Bonjour\u0000\nMerci  "), "Bonjour\nMerci");
    assert.equal(mailboxReplyBody("x".repeat(12000)).length, 10000);
    const replyRoute = serverSource.slice(serverSource.indexOf('app.post("/api/partner-email/:connectionId/messages/:messageRef/reply"'), serverSource.indexOf('app.get("/api/partner-email/:connectionId/messages/:messageRef/attachments'));
    assert.match(replyRoute, /requiredConnection/);
    assert.match(replyRoute, /sendLiveMailboxReply/);
    assert.doesNotMatch(replyRoute, /req\.body\?\.(?:to|recipient|subject)/);
    assert.match(serverSource, /graph\.microsoft\.com\/v1\.0\/me\/messages\/\$\{encodeURIComponent\(messageId\)\}\/reply/);
    assert.match(serverSource, /message\.envelope\.replyTo\?\.\[0\] \|\| message\.envelope\.from\?\.\[0\]/);
    assert.match(serverSource, /inReplyTo: source\.messageId/);
    assert.match(serverSource, /references: \[source\.inReplyTo, source\.messageId\]/);
    assert.match(publicMailError(new Error("SMTP rejected"), { provider: "imap", sending: true }), /réponse n’a pas pu être envoyée/);
    assert.match(appSource, /Trop de réponses ont été envoyées/);
    assert.match(emailSettingsSource, /data-mailbox-reply/);
    assert.match(emailSettingsSource, /Répondre dans le fil d’origine/);
    assert.match(emailSettingsSource, /Envoyé depuis la boîte connectée/);
    assert.match(emailSettingsSource, /dispatchMailboxChanged\("reply"/);
});

test("la structure IMAP sépare le corps du message des pièces téléchargées sur demande", () => {
    const structure = inspectMailboxStructure({ type: "multipart/mixed", childNodes: [
        { part: "1", type: "text/html", size: 400 },
        { part: "2", type: "text/plain", size: 200 },
        { part: "3", type: "application/pdf", size: 1200, disposition: "attachment", dispositionParameters: { filename: "mission.pdf" } }
    ] });
    assert.deepEqual(structure.body, { part: "2", contentType: "text/plain", size: 200 });
    assert.deepEqual(structure.attachments, [{ part: "3", filename: "mission.pdf", contentType: "application/pdf", size: 1200 }]);
    assert.match(emailSettingsSource, /Consulter les e-mails/);
    assert.match(emailSettingsSource, /Lecture directe, sans copie permanente/);
    assert.match(emailSettingsSource, /data-mailbox-page/);
    assert.match(emailSettingsSource, /Cliquez sur un document pour le télécharger avec son nom d’origine/);
});

test("les erreurs IMAP et SMTP attendues ne remontent pas en erreur serveur 500", () => {
    const configurationRoute = serverSource.slice(serverSource.indexOf('app.put("/api/partner-email/configuration"'), serverSource.indexOf('app.post("/api/partner-email/oauth/:provider/authorize"'));
    assert.match(configurationRoute, /throw httpError\(422, publicMailError\(error, \{ configuration: true \}\)\)/);
    assert.match(configurationRoute, /L’ancien mot de passe enregistré n’est plus lisible/);
    assert.match(serverSource, /connectionTimeout: 15000/);
    assert.match(serverSource, /Le serveur de messagerie ne répond pas/);
});

test("les comptes Microsoft personnels sont orientés vers OAuth et non vers le mot de passe IMAP", () => {
    assert.match(serverSource, /isMicrosoftMailbox\(input\.emailAddress\)/);
    assert.match(serverSource, /Outlook, Hotmail, Live et MSN exigent la connexion OAuth Microsoft/);
    assert.match(emailSettingsSource, /Connecter Microsoft \(Outlook, Hotmail, Microsoft 365\)/);
    assert.match(emailSettingsSource, /Microsoft refuse l’authentification IMAP classique/);
});

test("Gmail personnel dispose d’un parcours par mot de passe d’application sans OAuth obligatoire", () => {
    assert.match(emailSettingsSource, /isGmailMailbox/);
    assert.match(emailSettingsSource, /imap\.gmail\.com/);
    assert.match(emailSettingsSource, /smtp\.gmail\.com/);
    assert.match(emailSettingsSource, /myaccount\.google\.com\/apppasswords/);
    assert.match(emailSettingsSource, /jamais votre mot de passe Gmail habituel/);
    assert.match(serverSource, /normalizeMailboxPassword/);
    assert.match(serverSource, /password\.replace\(\/\\s\+\/g, ""\)/);
});

test("Google Workspace utilise uniquement Gmail API avec les scopes minimaux", () => {
    const gmailSource = readFileSync(new URL("../server/gmail-api-client.js", import.meta.url), "utf8");
    assert.match(serverSource, /GOOGLE_WORKSPACE_SCOPES = "openid email profile https:\/\/www\.googleapis\.com\/auth\/gmail\.readonly https:\/\/www\.googleapis\.com\/auth\/gmail\.send"/);
    assert.doesNotMatch(serverSource, /https:\/\/mail\.google\.com\//);
    assert.match(serverSource, /if \(connection\.provider === "google"\) return await syncGoogleConnection/);
    assert.match(serverSource, /gmailMessageRaw/);
    assert.match(serverSource, /gmailSendMessage/);
    assert.doesNotMatch(gmailSource, /messages\/(?:batchModify|modify|trash|untrash)|\/labels|\/threads\/.+\/trash/);
    assert.doesNotMatch(serverSource, /provider === "google"[^\n]+(?:imap|smtp)/i);
});

test("un timeout ImapFlow ne peut pas arrêter le processus Node", () => {
    assert.equal((serverSource.match(/new ImapFlow/g) || []).length, 1);
    assert.match(serverSource, /function createImapClient\(options\)/);
    assert.match(serverSource, /client\.on\("error", error => console\.warn/);
    assert.equal((serverSource.match(/createImapClient\(/g) || []).length, 4);
    assert.match(serverSource, /async function withImapInbox/);
});

test("Missions partenaires rappelle la configuration uniquement sans boîte connectée", () => {
    assert.match(missionClientSource, /!dashboard\.partnerEmail\.connections\.length/);
    assert.match(missionClientSource, /Aucune boîte mail professionnelle n’est configurée/);
    assert.match(missionClientSource, /id="openPartnerEmailSettings"/);
    assert.match(missionClientSource, /new CustomEvent\("depannhome:open-partner-email-settings"\)/);
});

test("la détection Sandbox ne provoque pas de 403 sans connecteurs", () => {
    assert.match(appClientSource, /features\.connectors !== true\) return/);
    assert.match(appSource, /request\.method === "GET" && request\.path === "\/"/);
    assert.match(appSource, /return requirePartnerSandboxFeature\(request, response, next\)/);
});

test("les coordonnées client sont extraites des pièces TXT, PDF, DOCX et XLSX", async () => {
    assert.match(readFileSync(new URL("../server/partner-email-document-extractor.js", import.meta.url), "utf8"), /verbosity: VerbosityLevel\.ERRORS/);
    const pdfDocument = await PDFDocument.create();
    const page = pdfDocument.addPage();
    const font = await pdfDocument.embedFont(StandardFonts.Helvetica);
    page.drawText("Client : Alice PDF", { x: 40, y: 780, font, size: 12 });
    page.drawText("Adresse : 4 rue du PDF", { x: 40, y: 760, font, size: 12 });
    const pdfBuffer = Buffer.from(await pdfDocument.save());

    const docx = new PizZip();
    docx.file("word/document.xml", "<w:document xmlns:w=\"x\"><w:body><w:p><w:r><w:t>Client : Alice DOCX</w:t></w:r></w:p><w:p><w:r><w:t>Ville : Nantes</w:t></w:r></w:p></w:body></w:document>");
    const docxBuffer = docx.generate({ type: "nodebuffer" });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Mission");
    sheet.addRow(["Client", "Alice XLSX"]);
    sheet.addRow(["Téléphone", "06 11 22 33 44"]);
    const xlsxBuffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const fixtures = [
        { mime: "text/plain", buffer: Buffer.from("Client : Alice TXT\nE-mail : alice@example.test") },
        { mime: "application/pdf", buffer: pdfBuffer },
        { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: docxBuffer },
        { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: xlsxBuffer }
    ];
    const texts = await Promise.all(fixtures.map(attachment => extractPartnerDocumentText([attachment])));
    assert.match(texts[0], /Alice TXT/);
    assert.match(texts[1], /Alice PDF/);
    assert.match(texts[2], /Alice DOCX/);
    assert.match(texts[3], /Alice XLSX/);
});

test("les documents Outlook au type générique sont reconnus grâce à leur extension", async () => {
    assert.equal(normalizePartnerDocumentMime({ filename: "ordre-mission.pdf", contentType: "application/octet-stream" }), "application/pdf");
    assert.equal(normalizePartnerDocumentMime({ filename: "ordre-mission", contentType: "application/x-pdf" }), "application/pdf");
    assert.equal(normalizePartnerDocumentMime({ filename: "ordre-mission", contentType: "application/acrobat" }), "application/pdf");
    assert.equal(normalizePartnerDocumentMime({ name: "CLIENT.JPEG", mime: "binary/octet-stream" }), "image/jpeg");
    assert.equal(normalizePartnerDocumentMime({ filename: "mission.docx", contentType: "application/octet-stream; name=mission.docx" }), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    const text = await extractPartnerDocumentText([{ filename: "client.txt", mime: "application/octet-stream", buffer: Buffer.from("Client : Alice Outlook\nTéléphone : 0611223344") }]);
    assert.match(text, /Alice Outlook/);
});

test("un e-mail transféré imbriqué fournit les coordonnées client et ses pièces jointes", async () => {
    const original = [
        "From: missions@assureur.test", "To: partenaire@example.test", "Subject: Ordre de mission SIN-84", "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="original"', "", "--original", "Content-Type: text/plain; charset=utf-8", "",
        "Client : Alice Martin\r\nAdresse : 12 rue des Lilas 44000 Nantes\r\nTéléphone : 0611223344",
        "--original", 'Content-Type: application/pdf; name="mission.pdf"', 'Content-Disposition: attachment; filename="mission.pdf"', "Content-Transfer-Encoding: base64", "",
        Buffer.from("document-pdf-test").toString("base64"), "--original--"
    ].join("\r\n");
    const forwarded = [
        "From: transfert@example.test", "To: partenaire@example.test", "Subject: Fwd: mission", "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="forwarded"', "", "--forwarded", "Content-Type: text/plain; charset=utf-8", "", "Message transféré",
        "--forwarded", 'Content-Type: message/rfc822; name="mission.eml"', 'Content-Disposition: attachment; filename="mission.eml"', "Content-Transfer-Encoding: base64", "",
        Buffer.from(original).toString("base64"), "--forwarded--"
    ].join("\r\n");
    const nested = await extractNestedPartnerEmailContent(await simpleParser(forwarded));
    assert.match(nested.text, /Alice Martin/);
    assert.equal(nested.attachments.length, 1);
    assert.equal(nested.attachments[0].filename, "mission.pdf");
    const payload = extractMissionPayload({ id: 84, subject: "Fwd: mission", body_text: "Message transféré", attachments: nested.attachments }, nested.text);
    assert.equal(payload.client.name, "Alice Martin");
    assert.equal(payload.client.phone, "0611223344");
    assert.equal(payload.client.city, "Nantes");
});

test("une nouvelle recherche enrichit les anciens candidats et répare les missions importées sans PDF", () => {
    assert.equal(shouldRefreshStoredPartnerEmail({ attachmentCount: 0, documentText: "" }, { attachmentCount: 1, documentText: "Client : Alice" }), true);
    assert.equal(shouldRefreshStoredPartnerEmail({ attachmentCount: 1, documentText: "Client : Alice" }, { attachmentCount: 1, documentText: "Client : Alice" }), false);
    assert.equal(shouldRefreshStoredPartnerEmail({ attachmentCount: 0, documentText: "" }, { attachmentCount: 0, documentText: "Client : Alice" }), true);
    assert.match(serverSource, /refreshPreviouslyParsedEmail/);
    assert.match(serverSource, /saved\.reanalyzeImported \|\|/);
    assert.match(serverSource, /status='candidate',processed_at=NULL/);
    assert.match(serverSource, /document_extraction_version INTEGER NOT NULL DEFAULT 0/);
    assert.match(serverSource, /existing\.documentExtractionVersion < DOCUMENT_EXTRACTION_VERSION/);
    assert.equal(richerDocumentText("Client : Alice\nAdresse : Nantes", ""), "Client : Alice\nAdresse : Nantes");
    assert.equal(richerDocumentText("Texte technique", "Client : Alice\nAdresse : Nantes"), "Client : Alice\nAdresse : Nantes");
    assert.match(serverSource, /richerDocumentText\(email\.document_text, await extractPartnerDocumentText\(email\.attachments\)\)/);
    assert.match(serverSource, /richerDocumentText\(locked\.rows\[0\]\.document_text, documentText\)/);
    assert.match(serverSource, /missionId: email\.mission_id/);
    assert.match(missionSource, /missionId: linkedMissionId/);
    assert.match(missionSource, /UPDATE depannhome_partner_missions SET partner_reference=\$4/);
    assert.match(missionSource, /client à identifier/);
});

test("les PDF base64 multiligne produits par PostgreSQL sont lus et joints", async () => {
    const source = Buffer.from("Client : Alice Martin\nAdresse : 12 rue des Lilas 44000 Nantes\n".repeat(4));
    const wrapped = source.toString("base64").replace(/(.{76})/g, "$1\n");
    const parsed = partnerEmailDataUrl(`data:application/pdf;base64,${wrapped}`);
    assert.equal(parsed?.mime, "application/pdf");
    assert.deepEqual(Buffer.from(parsed.base64, "base64"), source);
    const text = await extractPartnerDocumentText([{ mime: "text/plain", dataUrl: `data:text/plain;base64,${wrapped}` }]);
    assert.match(text, /Alice Martin/);
    assert.match(serverSource, /REPLACE\(REPLACE\(encode\(attachment\.file_data,'base64'\)/);
    assert.match(missionSource, /compactDataUrl = String\(item\?\.dataUrl/);
});

test("un ordre de mission IMH sépare l’assuré, l’adresse, le dossier et le numéro sociétaire", () => {
    const text = `Notre référence : 267057H26-RENU1-1
ORDRE DE MISSION URGENT
Suite à notre dernier entretien, nous vous confirmons votre mission chez Monsieur DOMINIQUE RIGALLEAU, assuré auprès de MACIF.
Adresse du bénéficiaire : 22 RUE ROBERT CHEVRIER 35200 RENNES
Tél fixe : 0665916004 Tél portable : 0665916004
Email : rigalandais@sfr.fr
Bénéficiaire : Monsieur DOMINIQUE RIGALLEAU
Adresse du sinistre : 22 RUE ROBERT CHEVRIER
Code postal Ville : 35200 RENNES
Grand Compte : MACIF
N° Sociétaire : 4152292
N° mandat : MDT-2026/7788
Référence dossier assureur : MACIF-DOS-88421
Réf IMH : 267057H26-RENU1
N° dossier IMH : 267057H26-RENU1`;
    const payload = extractMissionPayload({ id: 50, subject: "Mission imh", body_text: "" }, text);
    assert.equal(payload.client.name, "Monsieur DOMINIQUE RIGALLEAU");
    assert.equal(payload.client.address, "22 RUE ROBERT CHEVRIER, 35200");
    assert.equal(payload.client.postalCode, "35200");
    assert.equal(payload.client.city, "RENNES");
    assert.equal(payload.client.phone, "0665916004");
    assert.equal(payload.client.email, "rigalandais@sfr.fr");
    assert.equal(payload.missionNumber, "267057H26-RENU1");
    assert.equal(payload.partnerReference, "267057H26-RENU1");
    assert.equal(payload.interventionReference, "267057H26-RENU1");
    assert.equal(payload.insuredNumber, "4152292");
    assert.equal(payload.mandateNumber, "MDT-2026/7788");
    assert.equal(payload.insuranceDossier, "MACIF-DOS-88421");
    assert.equal(payload.insurance, "MACIF");
    const mapped = mapPayload(payload);
    assert.equal(mapped.clientName, "Monsieur DOMINIQUE RIGALLEAU");
    assert.equal(mapped.address, "22 RUE ROBERT CHEVRIER, 35200");
    assert.equal(mapped.insuredNumber, "4152292");
    assert.equal(mapped.insuranceDossier, "MACIF-DOS-88421");
    assert.equal(mapped.mandateNumber, "MDT-2026/7788");
});

test("un dossier IMH multi-pages extrait les données essentielles sans confondre le prestataire", () => {
    const text = `Inter Mutuelles Habitat Gie - Tél : 05 17 18 62 60
Objet : Confirmation de mission urgente
ORDRE DE MISSION URGENTE RECHERCHE DE FUITE VISUELLE
Suite à notre dernier entretien, et conformément à la demande de Madame LEVANA CHETRIT
THOUROT, assuré auprès de la compagnie MATMUT, nous vous confirmons votre mission pour l’intervention relative au sinistre Dégât des eaux, Gel du 23/07/26.
L’adresse du sinistre :
24 RUE ARISTIDE BRIAND
44510 LE POULIGUEN
Téléphone fixe: 01 47 50 25 46
Téléphone portable: 06 27 75 17 86
Votre mission est d’effectuer une recherche de fuite visuelle, correspondant à 2h d’intervention.
Nos Références :
2713642-REN1 / 1
Vos Références :
552563
Descriptif des travaux
Nos Référence : 2713642-REN1 Madame LEVANA CHETRIT THOUROT
N° Téléphone Bénéficiaire : 01 47 50 25 46 / 06 27 75 17 86
Rapport de Recherche de Fuite N° Dossier IMH 2713642-REN1
N° Prestataire 552563
BENEFICIAIRE
Nom Prénom
LEVANA CHETRIT THOUROT
Téléphone 01 47 50 25 46 / 06 27 75 17 86
Adresse du sinistre 24 RUE ARISTIDE BRIAND
44510 LE POULIGUEN`;
    const payload = extractMissionPayload({ id: 59, subject: "Confirmation de mission urgente", body_text: "" }, text);
    assert.equal(payload.client.name, "Madame LEVANA CHETRIT THOUROT");
    assert.equal(payload.client.phone.replace(/\s/g, ""), "0627751786");
    assert.equal(payload.client.address, "24 RUE ARISTIDE BRIAND, 44510"); assert.equal(payload.client.city, "LE POULIGUEN");
    assert.equal(payload.missionNumber, "2713642-REN1"); assert.equal(payload.partnerReference, "2713642-REN1");
    assert.equal(payload.interventionReference, "2713642-REN1"); assert.equal(payload.insuranceDossier, "2713642-REN1");
    assert.equal(payload.interventionType, "RECHERCHE DE FUITE VISUELLE"); assert.equal(payload.insurance, "la compagnie MATMUT");
    assert.match(payload.description, /recherche de fuite visuelle/i);
    assert.equal(payload.insuredNumber, ""); assert.equal(payload.claimNumber, "");
});

test("le bénéficiaire IMH est retrouvé lorsque la référence et le nom partagent une ligne", () => {
    const payload = extractMissionPayload({ id: 61, subject: "Mission imh", body_text: "" }, `Descriptif des travaux
Nos Référence : 2713642-REN1 Madame LEVANA CHETRIT THOUROT
24 RUE ARISTIDE BRIAND
44510 LE POULIGUEN`);
    assert.equal(payload.client.name, "Madame LEVANA CHETRIT THOUROT");
});

test("une commande assistance Repartim complète la fiche client et ses références", () => {
    const text = `Identification du dossier :
COVEA
Référence [expert]: 0002981195
Réf. Sinistre : M2873751
Bénéficiaire :
COUDRAIS CHARLOTTE
Adresse de l'intervention :
54 RUE ANGE BLAIZE
35000 RENNES
Tél : 06 72 57 08 10
Détail de l'intervention : RDV LE 27/07/APM RDF /APPART /MISSIONNER POUR RDF NN DESTRUCTIVE.
COMMANDE ASSISTANCE
N° 131B252728`;
    const payload = extractMissionPayload({ id: 70, subject: "Mission Repartim", body_text: "" }, text);
    assert.equal(payload.client.name, "COUDRAIS CHARLOTTE"); assert.equal(payload.client.address, "54 RUE ANGE BLAIZE, 35000");
    assert.equal(payload.client.city, "RENNES"); assert.equal(payload.client.phone.replace(/\s/g, ""), "0672570810");
    assert.equal(payload.missionNumber, "131B252728"); assert.equal(payload.claimNumber, "M2873751");
    assert.equal(payload.insurance, "COVEA"); assert.equal(payload.expert, "0002981195");
    assert.equal(payload.interventionType, "COMMANDE ASSISTANCE"); assert.match(payload.description, /RDF NN DESTRUCTIVE/);
});

test("une commande de travaux Repartim reconnaît l’assuré et le donneur d’ordre", () => {
    const payload = extractMissionPayload({ id: 71, subject: "Commande Repartim", body_text: "" }, `Donneurs d'Ordres :
COVEA
Référence [expert]: 0002981195
Réf. Sinistre : M2873751
Assuré(e):
COUDRAIS CHARLOTTE
Adresse :
54 RUE ANGE BLAIZE
35000 RENNES
PORTABLE : 06 72 57 08 10
COMMANDE DE TRAVAUX
N° 071000003962293 du 27/07/2026`);
    assert.equal(payload.client.name, "COUDRAIS CHARLOTTE"); assert.equal(payload.client.city, "RENNES");
    assert.equal(payload.principal, "COVEA"); assert.equal(payload.insurance, "COVEA");
    assert.equal(payload.missionNumber, "071000003962293"); assert.equal(payload.claimNumber, "M2873751");
    assert.equal(payload.interventionType, "COMMANDE DE TRAVAUX");
});

test("une attestation Repartim à ordre de lecture inversé retrouve le bénéficiaire", () => {
    const payload = extractMissionPayload({ id: 72, subject: "Attestation Repartim", body_text: "" }, `ATTESTATION DE FIN DE TRAVAUX /
DE FIN D'INTERVENTION
COUDRAIS CHARLOTTE
54 RUE ANGE BLAIZE
35000 RENNES
M2873751
Donneur d'ordres : COVEA
Référence du devis : Dates travaux :
Adresse de l'intervention :
Bénéficiaire de l'intervention : Ref sinistre :`);
    assert.equal(payload.client.name, "COUDRAIS CHARLOTTE"); assert.equal(payload.client.address, "54 RUE ANGE BLAIZE, 35000");
    assert.equal(payload.client.city, "RENNES"); assert.equal(payload.claimNumber, "M2873751");
    assert.equal(payload.principal, "COVEA"); assert.equal(payload.interventionType, "ATTESTATION DE FIN DE TRAVAUX / DE FIN D'INTERVENTION");
});

test("un PDF en colonnes ignore un faux numéro assuré et retrouve la référence voisine", () => {
    const text = `Grand Compte : MACIF Nature du
N° assuré / sociétaire : Le
sinistre : Dégât des eaux
Référence interne : ABC
4152292
N° dossier IMH : 267057H26-RENU1`;
    const payload = extractMissionPayload({ id: 53, subject: "Mission imh", body_text: "" }, text);
    assert.equal(payload.insuredNumber, "4152292");
    assert.equal(payload.insurance, "MACIF");
});

test("les références assuré, adhérent, contrat et police sont reconnues quel que soit l’assureur", () => {
    const cases = [
        ["Assureur : AXA\nN° contrat : AXA-2026.001", "AXA", "AXA-2026.001"],
        ["Compagnie d’assurance : Allianz\nNuméro de police : POL/784512", "Allianz", "POL/784512"],
        ["Société d’assurance : Generali\nContrat n° : GE-445566", "Generali", "GE-445566"],
        ["Organisme assureur : SMABTP\nN° adhérent : 8899771", "SMABTP", "8899771"],
        ["Mutuelle : MAIF\nRéférence contrat : M-2026-7788", "MAIF", "M-2026-7788"]
    ];
    for (const [text, insurance, insuredNumber] of cases) {
        const payload = extractMissionPayload({ id: 60, subject: "Ordre de mission", body_text: "" }, text);
        assert.equal(payload.insurance, insurance);
        assert.equal(payload.insuredNumber, insuredNumber);
    }
});

test("le mail garde la priorité et les documents complètent les champs manquants", () => {
    const payload = extractMissionPayload({ id: 42, subject: "Mission", body_text: "Client : Camille Mail\nTéléphone : 0600000000", sender_name: "Assureur", message_id: "mail-42" }, "Client : Alice Document\nTéléphone : 0711111111\nE-mail : alice@example.test\nAdresse : 12 rue des Lilas\nCode postal : 44000\nVille : Nantes\nSinistre : SIN-42\nAssureur : Exemple Assurance");
    assert.equal(payload.client.name, "Camille Mail");
    assert.equal(payload.client.phone, "0600000000");
    assert.equal(payload.client.email, "alice@example.test");
    assert.equal(payload.client.address, "12 rue des Lilas, 44000");
    assert.equal(payload.client.city, "Nantes");
    assert.equal(payload.claimNumber, "SIN-42");
    assert.equal(payload.insurance, "Exemple Assurance");
});

test("les coordonnées inline créent une fiche client complète avec une référence lisible", () => {
    const payload = extractMissionPayload({
        id: 40,
        subject: "Mission intervention IMH",
        body_text: "Assuré : M. le Charue Adresse : 17 allée des fleurs 44420 Herbignac Tel : 0777767512",
        sender_name: "Peter Regat",
        message_id: "<CA+MfGwK_technique@mail.gmail.com>"
    });
    assert.equal(payload.client.name, "M. le Charue");
    assert.equal(payload.client.address, "17 allée des fleurs, 44420");
    assert.equal(payload.client.postalCode, "44420");
    assert.equal(payload.client.city, "Herbignac");
    assert.equal(payload.client.phone, "0777767512");
    assert.equal(payload.missionNumber, "MAIL-40");
    assert.equal(payload.partnerReference, "MAIL-40");
    const mapped = mapPayload(payload);
    assert.equal(mapped.address, "17 allée des fleurs, 44420");
    assert.equal(mapped.interventionAddress, "17 allée des fleurs, 44420");
    assert.equal(mapped.postalCode, "44420");
    assert.equal(mapped.city, "Herbignac");
    assert.equal(mapped.clientName, "M. le Charue");
    assert.equal(readableEmailMissionReference(payload, 40), "MAIL-40");
    assert.equal(readableEmailMissionReference({ id: "email-40", missionNumber: "intervention", partnerReference: "<technical@gmail.com>" }, 40), "MAIL-40");
    assert.deepEqual(normalizeMissionPostalAddress("17 allée des fleurs 44420 Herbignac"), { address: "17 allée des fleurs, 44420", postalCode: "44420", city: "Herbignac" });
});

test("les anciennes missions e-mail sont réparées avec leur fiche client liée", () => {
    assert.match(missionSource, /repairImportedEmailMissionClients/);
    assert.match(missionSource, /source_data#>>'\{client,address\}'/);
    assert.match(missionSource, /partner_reference ~ '\^<\.\*@\.\*>\$'/);
    assert.match(missionSource, /source_data=\$4::jsonb,mapped_data=\$5::jsonb,client_id=\$6/);
    assert.match(missionSource, /email\.document_text/);
    assert.match(missionSource, /mergeReparsedEmailPayload/);
    assert.match(missionSource, /mapped_data->>'insuredNumber'/);
    assert.match(missionSource, /client_created" : "client_matched/);
    assert.match(emailSettingsSource, /synchronizeClients\(\{ forceFull: true \}\)/);
    assert.match(emailSettingsSource, /depannhome:partner-client-provisioned/);
});

test("l’assuré est toujours l’identité de la fiche client", () => {
    const payload = extractMissionPayload(
        { id: 43, subject: "Mission", body_text: "Client : Plateforme prestataire", sender_name: "Cabinet Dupont", message_id: "mail-43" },
        "Nom et prénom de l’assurée : Marie Martin\nAdresse : 8 rue des Assurés\nTéléphone : 0612345678"
    );
    assert.equal(payload.client.name, "Marie Martin");
    assert.notEqual(payload.client.name, "Plateforme prestataire");

    const unidentified = extractMissionPayload({ id: 44, subject: "Mission", body_text: "", sender_name: "Cabinet Dupont", message_id: "mail-44" });
    assert.equal(unidentified.client.name, "Client à identifier");
});

test("une pièce illisible ou une image sans OCR ne bloque pas l’import", async () => {
    const text = await extractPartnerDocumentText([
        { mime: "application/pdf", buffer: Buffer.from("PDF corrompu") },
        { mime: "image/png", buffer: Buffer.from("image non OCRisée") },
        { mime: "text/plain", buffer: Buffer.from("Client : Client Valide") }
    ]);
    assert.match(text, /Client Valide/);
});

test("un PDF scanné sans couche texte est lu localement par OCR", async () => {
    const canvas = createCanvas(1200, 500); const context = canvas.getContext("2d");
    context.fillStyle = "white"; context.fillRect(0, 0, 1200, 500); context.fillStyle = "black"; context.font = "bold 44px Arial";
    context.fillText("Assure : Marie Martin", 50, 100); context.fillText("Adresse : 12 rue des Lilas 44000 Nantes", 50, 180); context.fillText("Telephone : 0612345678", 50, 260);
    const document = await PDFDocument.create(); const image = await document.embedPng(canvas.toBuffer("image/png")); const page = document.addPage([600, 250]); page.drawImage(image, { x: 0, y: 0, width: 600, height: 250 });
    const text = await extractPartnerDocumentText([{ mime: "application/pdf", buffer: Buffer.from(await document.save()) }]);
    assert.match(text, /Marie Martin/i); assert.match(text.replace(/\s/g, ""), /0612345678/);
    const payload = extractMissionPayload({ id: 51, subject: "Mission partenaire", body_text: "" }, text);
    assert.equal(payload.client.name, "Marie Martin"); assert.equal(payload.client.phone, "0612345678"); assert.equal(payload.client.city, "Nantes");
});

test("un scan PDF A4 haute résolution est réduit puis lu par OCR", async () => {
    const canvas = createCanvas(1800, 2500); const context = canvas.getContext("2d");
    context.fillStyle = "white"; context.fillRect(0, 0, 1800, 2500); context.fillStyle = "black"; context.font = "bold 72px Arial";
    context.fillText("Client : Jeanne Durand", 100, 300); context.fillText("Adresse : 8 rue Victor Hugo 35000 Rennes", 100, 500); context.fillText("Telephone : 0677889900", 100, 700);
    const document = await PDFDocument.create(); const image = await document.embedPng(canvas.toBuffer("image/png")); const font = await document.embedFont(StandardFonts.Helvetica); const page = document.addPage([595, 842]); page.drawImage(image, { x: 0, y: 0, width: 595, height: 842 });
    page.drawText("Mission IMH - document numerise automatiquement - reference technique 2026", { x: 20, y: 20, font, size: 8 });
    const text = await extractPartnerDocumentText([{ filename: "ordre-mission-a4.pdf", mime: "application/pdf", buffer: Buffer.from(await document.save()) }]);
    assert.match(text, /Jeanne Durand/i); assert.match(text.replace(/\s/g, ""), /0677889900/);
    const payload = extractMissionPayload({ id: 54, subject: "Mission partenaire", body_text: "" }, text);
    assert.equal(payload.client.name, "Jeanne Durand"); assert.equal(payload.client.phone, "0677889900"); assert.equal(payload.client.city, "Rennes");
    assert.match(readFileSync(new URL("../server/partner-email-document-extractor.js", import.meta.url), "utf8"), /pdfTextNeedsOcr\(output\)/);
});

test("les coordonnées de l’assureur dans l’en-tête ne masquent pas le client scanné", async () => {
    const canvas = createCanvas(2400, 1200); const context = canvas.getContext("2d");
    context.fillStyle = "white"; context.fillRect(0, 0, 2400, 1200); context.fillStyle = "black"; context.font = "bold 60px Arial";
    context.fillText("Assure : Paul Martin", 80, 220); context.fillText("Adresse du beneficiaire : 12 rue des Lilas 35000 Rennes", 80, 400); context.fillText("Telephone : 06 11 22 33 44", 80, 580);
    const document = await PDFDocument.create(); const image = await document.embedPng(canvas.toBuffer("image/png")); const font = await document.embedFont(StandardFonts.Helvetica); const page = document.addPage([1000, 500]);
    page.drawImage(image, { x: 0, y: 0, width: 1000, height: 500 });
    page.drawText("Assureur : la compagnie MATMUT - Telephone : 05 17 18 62 60 - Mission urgente", { x: 20, y: 20, font, size: 9 });
    const text = await extractPartnerDocumentText([{ filename: "mission-matmut.pdf", mime: "application/pdf", buffer: Buffer.from(await document.save()) }]);
    const payload = extractMissionPayload({ id: 59, subject: "Confirmation de mission urgente", body_text: "" }, text);
    assert.equal(payload.client.name, "Paul Martin"); assert.equal(payload.client.phone.replace(/\s/g, ""), "0611223344");
    assert.equal(payload.client.address, "12 rue des Lilas, 35000"); assert.equal(payload.client.city, "Rennes");
});

test("un scan PDF monochrome compressé sur un bit reste lisible par l’OCR", async () => {
    const buffer = pdfImageOcrBuffer({ width: 8, height: 1, kind: 1, data: Uint8Array.of(0b10101010) });
    const image = await loadImage(buffer); const canvas = createCanvas(8, 1); const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, 8, 1).data;
    assert.deepEqual(Array.from({ length: 8 }, (_, index) => pixels[index * 4]), [255, 0, 255, 0, 255, 0, 255, 0]);
});

test("les images PDF partagées et répétées sont récupérées avant les petits logos", async () => {
    const logo = { width: 2, height: 2, kind: 2, data: new Uint8Array(12).fill(255) };
    const scan = { width: 20, height: 20, kind: 2, data: new Uint8Array(1200).fill(255) };
    const page = {
        getOperatorList: async () => ({ fnArray: [OPS.paintImageXObject, OPS.paintImageXObjectRepeat], argsArray: [["logo"], ["g_scan", 1, 1, [0, 0]]] }),
        objs: { get: (reference, resolve) => resolve(reference === "logo" ? logo : null) },
        commonObjs: { get: (reference, resolve) => resolve(reference === "g_scan" ? scan : null) }
    };
    const images = await embeddedPdfImages(page, 1); const selected = await loadImage(images[0]);
    assert.equal(selected.width, 20); assert.equal(selected.height, 20);
});

test("une photo jointe contenant la fiche d’intervention est lue par OCR", async () => {
    const canvas = createCanvas(1400, 600); const context = canvas.getContext("2d");
    context.fillStyle = "white"; context.fillRect(0, 0, 1400, 600); context.fillStyle = "black"; context.font = "bold 48px Arial";
    context.fillText("Client : Alice Martin", 50, 110); context.fillText("Adresse : 18 rue des Fleurs 44000 Nantes", 50, 220); context.fillText("Telephone : 0611223344", 50, 330);
    const text = await extractPartnerDocumentText([{ filename: "fiche-client.png", mime: "application/octet-stream", buffer: canvas.toBuffer("image/png") }]);
    assert.match(text, /Alice Martin/i);
    assert.match(text.replace(/\s/g, ""), /0611223344/);
    const payload = extractMissionPayload({ id: 52, subject: "Mission partenaire", body_text: "" }, text);
    assert.equal(payload.client.name, "Alice Martin");
    assert.equal(payload.client.phone, "0611223344");
});

test("les PDF reçus sont téléchargeables et liés au dossier de mission", () => {
    assert.match(emailSettingsSource, /downloadMailboxAttachment/);
    assert.match(emailSettingsSource, /URL\.createObjectURL/);
    assert.match(emailSettingsSource, /data-mailbox-attachment-name/);
    assert.match(readFileSync(new URL("../server/partner-dialogue.js", import.meta.url), "utf8"), /source_type[\s\S]*?'email_attachment'/);
    assert.match(readFileSync(new URL("../server/partner-dialogue.js", import.meta.url), "utf8"), /message\.event_type='email_attachment_received'/);
});

test("les pièces e-mail disposent de rubriques dédiées dans la mission et la fiche client", () => {
    const attachments = Array.from({ length: 12 }, (_, index) => ({ name: `document-${index}.pdf` }));
    assert.equal(mapPayload({ attachments }).attachments.length, 10);
    assert.match(missionSource, /emailAttachments: await missionEmailAttachments/);
    assert.match(missionSource, /source_type='email_attachment'/);
    assert.match(missionSource, /Mission partenaire · E-mail/);
    assert.match(missionSource, /source: "partner_email"/);
    assert.match(missionSource, /fromEmail \? "Mission partenaire · E-mail" : "Document partenaire"/);
    assert.match(missionSource, /attachmentSignature/);
    assert.match(missionClientSource, /Pièces jointes reçues par e-mail/);
    assert.match(missionClientSource, /attachment\.url/);
    assert.match(clientsSource, /Mission partenaire · E-mail/);
    assert.match(clientsSource, /isPartnerEmailAttachment/);
    assert.match(clientsSource, /renderAttachmentsHtml\(client\.id, emailMissionFiles/);
});

test("les réponses e-mail affichent le contexte, les compteurs et l’état d’envoi", () => {
    assert.match(emailSettingsSource, /Réponse sécurisée/);
    assert.match(emailSettingsSource, /data-mailbox-reply-count/);
    assert.match(emailSettingsSource, /Envoi en cours/);
    assert.match(missionClientSource, /data-email-reply-count/);
    assert.match(missionClientSource, /data-email-reply-files/);
});
