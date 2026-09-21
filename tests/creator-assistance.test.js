import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const server = readFileSync(new URL("../server/creator-assistance.js", import.meta.url), "utf8");
const application = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const migration = readFileSync(new URL("../database/migrations/0006_creator_assistance.sql", import.meta.url), "utf8");
const consentMigration = readFileSync(new URL("../database/migrations/0021_creator_assistance_consent.sql", import.meta.url), "utf8");
const remoteControlMigration = readFileSync(new URL("../database/migrations/0022_secure_remote_assistance.sql", import.meta.url), "utf8");
const schema = readFileSync(new URL("../database/schema.sql", import.meta.url), "utf8");
const client = readFileSync(new URL("../js/creator.js", import.meta.url), "utf8");
const navigation = readFileSync(new URL("../js/navigation.js", import.meta.url), "utf8");
const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const serviceWorker = readFileSync(new URL("../service-worker.js", import.meta.url), "utf8");
const creatorServer = readFileSync(new URL("../server/creator.js", import.meta.url), "utf8");
const organizationServer = readFileSync(new URL("../server/organizations.js", import.meta.url), "utf8");
const supportServer = readFileSync(new URL("../server/support.js", import.meta.url), "utf8");
const collaborationClient = readFileSync(new URL("../js/collaboration.js", import.meta.url), "utf8");
const authenticationServer = readFileSync(new URL("../server/auth.js", import.meta.url), "utf8");

const tableDefinitions = [migration, schema, server];

test("creator assistance routes remain creator-only and never replace request.user", () => {
    assert.match(server, /\/api\/creator\/assistance\/sessions[^\n]+requireCreator/g);
    assert.doesNotMatch(server, /request\.user\s*=/);
    assert.doesNotMatch(server, /password_hash|secret_ciphertext\s+AS|verification_code_hash\s+AS/);
});

test("support sessions require consent context and have bounded lifetimes", () => {
    assert.match(server, /NORMAL_SESSION_MINUTES = 30/);
    assert.match(server, /EMERGENCY_SESSION_MINUTES = 10/);
    assert.match(server, /consentConfirmed/);
    assert.match(server, /supportRequestId/);
    assert.match(server, /session\.expires_at>NOW\(\)/);
    assert.match(server, /session\.revoked_at IS NULL/);
    assert.match(server, /session\.accepted_at IS NOT NULL/);
    assert.match(server, /support_assistance_consent_requested/);
    assert.match(server, /expires_at=NOW\(\)\+\(\$3::text\|\|' minutes'\)::interval/);
    assert.match(server, /CASE WHEN \$10::boolean THEN NOW\(\) ELSE NULL END/);
    assert.doesNotMatch(server, /CASE WHEN \$4='emergency'/);
});

test("la prise en main distante exige un consentement distinct et reste révocable", () => {
    assert.match(remoteControlMigration, /access_scope IN \('diagnostic','control'\)/);
    assert.match(server, /const accessScope = !emergency/);
    assert.match(server, /\/api\/creator\/assistance\/sessions\/:sessionId\/control/);
    assert.match(server, /\/api\/assistance\/sessions\/:sessionId\/revoke/);
    assert.match(server, /app\.get\("\/api\/assistance\/active", requireAuthentication/);
    assert.match(authenticationServer, /findActiveCreatorSupportControl/);
    assert.match(authenticationServer, /access_scope='control'/);
    assert.match(authenticationServer, /control_last_seen_at=NOW\(\)/);
    assert.match(authenticationServer, /expires_at>NOW\(\)/);
    assert.match(server, /control_last_seen_at>NOW\(\)-INTERVAL '30 seconds'/);
    assert.match(remoteControlMigration, /control_started_at TIMESTAMPTZ/);
    assert.match(remoteControlMigration, /control_last_seen_at TIMESTAMPTZ/);
    assert.match(collaborationClient, /Prise en main limitée, visible et traçable/);
    assert.match(collaborationClient, /Retirer l’accès maintenant/);
    assert.match(collaborationClient, /Support Depann’Home Pro connecté à distance/);
    assert.match(collaborationClient, /setInterval\(loadCompanyAssistancePresence, 15_000\)/);
    assert.match(client, /Prise en main sécurisée/);
    assert.match(client, /data-enter-assistance-control/);
});

test("la prise en main bloque les zones sensibles et journalise chaque requête", () => {
    assert.match(application, /app\.use\(enforceCreatorAssistanceControl\)/);
    for (const path of ["/api/auth", "/api/accounting", "/api/connectors", "/api/partner-email", "/api/groups", "/api/data-imports", "/api/subscription"]) assert.match(server, new RegExp(path.replaceAll("/", "\\/")));
    assert.match(server, /SUPPORT_CONTROL_READABLE_SENSITIVE_PREFIXES = \["\/api\/accounting", "\/api\/partner-email", "\/api\/partner-missions", "\/api\/partner-dialogue"\]/);
    assert.match(server, /SUPPORT_CONTROL_BLOCKED_READ_PREFIXES = \["\/api\/accounting\/export", "\/api\/partner-email\/oauth"\]/);
    assert.match(server, /isAllowedSupportControlMutation/);
    assert.match(server, /\(\?:assign\|planning-draft\)/);
    const delegatedMutations = server.slice(server.indexOf("function isAllowedSupportControlMutation"), server.indexOf("export function registerCreatorAssistanceRoutes"));
    assert.doesNotMatch(delegatedMutations, /accept|reject|close|settlements|export/);
    assert.match(server, /const destructive = method === "DELETE"/);
    assert.match(server, /validate\|validation\|submit\|send\|email\|deliver\|delivery\|reopen\|cancel/);
    assert.match(server, /depannhome_creator_support_activity/);
    assert.match(server, /createPendingSupportActivity/);
    assert.match(server, /L’action est bloquée car sa traçabilité ne peut pas être garantie/);
    assert.ok(server.indexOf("mandatoryActivityId = await createPendingSupportActivity") < server.indexOf('return response.status(503)'));
    assert.match(remoteControlMigration, /method VARCHAR\(10\)/);
    assert.doesNotMatch(remoteControlMigration, /request_body|payload|details JSONB/);
    assert.match(navigation, /dataset\.supportControl === "true"/);
});

test("la co-navigation est consentie, isolée et ne transmet aucun contenu métier", () => {
    assert.match(server, /POST \/api\/collaboration\/support-cobrowse/);
    assert.match(server, /request\.user\.isSupportControl/);
    assert.match(server, /broadcastOwnerEvent\(getAccountOwnerId\(request\), "support_cobrowse"/);
    assert.match(server, /SUPPORT_COBROWSE_EVENTS = new Set\(\["route", "cursor", "click", "scroll", "follow", "action", "field", "dialog"\]\)/);
    assert.match(server, /recent\.length >= 20/);
    assert.doesNotMatch(server.slice(server.indexOf("function sanitizeCobrowseEvent")), /innerHTML|\.value|request\.body\?\.(?:text|content|email|password)/);
    assert.match(collaborationClient, /Suivre automatiquement/);
    assert.match(collaborationClient, /event\.key === "Escape"/);
    assert.match(collaborationClient, /input, textarea, select, \[contenteditable=true\], \[data-sensitive\]/);
    assert.match(collaborationClient, /depannhome:support-follow-route/);
    assert.doesNotMatch(collaborationClient, /dispatchEvent\(new MouseEvent|\.click\(\)/);
    assert.match(navigation, /\["documents", "personalization"\]\.includes\(section\)/);
});

test("l’entreprise voit automatiquement toutes les actions non sensibles du Support", () => {
    assert.match(collaborationClient, /nextSessionId !== activeAssistanceSessionId\) \{ followingSupport = true/);
    assert.match(collaborationClient, /Actions du Support en direct/);
    assert.match(collaborationClient, /aria-live="polite"/);
    assert.match(collaborationClient, /Page « \$\{area\} » ouverte/);
    assert.match(collaborationClient, /Fenêtre ouverte dans/);
    assert.match(collaborationClient, /Champ utilisé dans .+contenu masqué/);
    assert.match(collaborationClient, /supportActivities = supportActivities\.slice\(-50\)/);
    assert.match(server, /broadcastSupportOperation\(request, method, path, response\.statusCode, outcome\)/);
    assert.match(server, /type: "operation"/);
    assert.match(server, /function supportOperationArea/);
    const liveOperation = server.slice(server.indexOf("async function broadcastSupportOperation"), server.indexOf("function supportOperationArea"));
    assert.doesNotMatch(liveOperation, /request\.body|request\.query|request\.params|password|payload/);
    const broadcastPayload = liveOperation.slice(liveOperation.indexOf('type: "operation"'));
    assert.doesNotMatch(broadcastPayload, /\bpath\b|\burl\b/);
});

test("l’entreprise ciblée accepte ou refuse depuis une notification Support ouvrable", () => {
    assert.match(server, /app\.get\("\/api\/assistance\/sessions", requireAuthentication/);
    assert.match(server, /app\.get\("\/api\/assistance\/sessions\/:sessionId", requireAuthentication/);
    assert.match(server, /app\.post\("\/api\/assistance\/sessions\/:sessionId\/decision", requireAuthentication/);
    assert.match(server, /session\.target_company_owner_id=\$2/);
    assert.match(server, /if \(!isCompanyAdministrator\(request\)\)/);
    assert.match(collaborationClient, /"creator_assistance"/);
    assert.match(collaborationClient, /openCompanyAssistanceRequest/);
    assert.match(collaborationClient, /Accepter pendant 30 minutes/);
    assert.match(collaborationClient, /data-assistance-decision="decline"/);
    assert.match(collaborationClient, /creator_assistance_decision/);
    assert.match(collaborationClient, /item\?\.entityType === "creator_assistance" \|\| preferences/);
    assert.match(server, /safelyBroadcastCreatorDecision\(session\.createdBy, sessionId, decision\)/);
    assert.match(server, /JOIN depannhome_group_administrators administrator/);
    assert.match(client, /renderCreatorAssistanceSession\(event\.detail\.sessionId\)/);
    assert.match(navigation, /depannhome:open-company-assistance/);
    assert.match(navigation, /Demandes d’assistance/);
    assert.match(navigation, /fetch\("\/api\/assistance\/sessions"/);
});

test("recovery actions are constrained, audited and notify company administrators", () => {
    for (const action of ["restore_company", "reactivate_company", "reactivate_administrator", "reset_administrator_2fa", "revoke_company_sessions", "reject_device", "release_company_locks"]) {
        assert.match(server, new RegExp(action));
    }
    assert.match(server, /previous_state/);
    assert.match(server, /new_state/);
    assert.match(server, /insertCompanyNotifications/);
    assert.match(server, /company_notified_at/);
    assert.doesNotMatch(server, /approve_device/);
});

test("Creator can reset personal 2FA for every eligible PC role only", () => {
    assert.match(server, /WORKSTATION_2FA_RECOVERY_ROLES = new Set\(\["admin", "pc_standard", "commercial"\]\)/);
    assert.match(server, /reset_administrator_2fa" && !WORKSTATION_2FA_RECOVERY_ROLES\.has\(member\.role\)/);
    assert.match(server, /creator_workstation_2fa_reset/);
    assert.match(server, /DELETE FROM depannhome_company_totp_authenticators WHERE owner_id=\$1 AND user_id=\$2/);
    assert.match(client, /\["admin", "pc_standard", "commercial"\]\.includes\(member\.role\)/);
    assert.match(client, /Postes PC/);
    assert.match(client, /creatorMemberRoleLabel\(member\.role\)/);
});

test("account reactivation remains restricted to administrators", () => {
    assert.match(server, /actionType === "reactivate_administrator" && member\.role !== "admin"/);
    assert.match(client, /member\.role !== "admin" \|\| member\.isActive/);
});

test("la création d’assistance reste durable si une notification échoue", () => {
    const creation = server.slice(server.indexOf('app.post("/api/creator/assistance/sessions"'), server.indexOf('app.get("/api/assistance/sessions"'));
    assert.ok(creation.indexOf('connection.query("COMMIT")') < creation.indexOf("safelyInsertCompanyNotifications"));
    assert.match(server, /local company notification unavailable/);
    assert.match(server, /principal group notification unavailable/);
    assert.match(server, /SELECT id FROM depannhome_users WHERE account_owner_id=\$1 AND role='admin'/);
    assert.match(server, /support_assistance_closed[\s\S]+COMMIT/);
    assert.match(server, /creator_recovery_action[\s\S]+COMMIT/);
    assert.match(server, /safelyBroadcastCompanyNotifications/);
});

test("une action de récupération reverrouille une session encore active dans sa transaction", () => {
    const recovery = server.slice(server.indexOf("async function executeRecoveryAction"), server.indexOf("async function loadDiagnostics"));
    assert.match(recovery, /session\.revoked_at IS NULL AND session\.expires_at>NOW\(\)/);
    assert.match(recovery, /FOR UPDATE OF session/);
    assert.ok(recovery.indexOf("FOR UPDATE OF session") < recovery.indexOf("findCompanyOwner(connection, ownerId, true)"));
    assert.match(recovery, /Cette session d’assistance a été révoquée ou a expiré/);
});

test("création, organisation et profil entreprise partagent une transaction", () => {
    const creation = creatorServer.slice(creatorServer.indexOf('app.post("/api/creator/accounts"'), creatorServer.indexOf('app.patch("/api/creator/accounts/:accountId"'));
    assert.match(creation, /synchronizeCompanyProfile\(connection/);
    assert.match(creation, /createOrganization\(id, request\.body\?\.organization, request\.user\.sub, connection\)/);
    assert.ok(creation.indexOf("createOrganization") < creation.indexOf('connection.query("COMMIT")'));
    assert.match(organizationServer, /createOrganization\(ownerId, values = \{\}, actorId = null, database = getPool\(\)\)/);
    assert.match(organizationServer, /writeOrganizationAudit\([\s\S]*database\)/);
});

test("une réduction de sièges est revérifiée sous verrou avant modification", () => {
    const update = creatorServer.slice(creatorServer.indexOf('app.patch("/api/creator/accounts/:accountId"'), creatorServer.indexOf('app.patch("/api/creator/accounts/:accountId/activation"'));
    assert.match(update, /FROM depannhome_users WHERE id=\$1 AND account_owner_id=id FOR UPDATE/);
    assert.match(update, /const lockedCounts = await countActiveSeats\(connection, accountId\)/);
    assert.ok(update.indexOf("FOR UPDATE") < update.indexOf("const lockedCounts"));
    assert.ok(update.indexOf("const lockedCounts") < update.indexOf("UPDATE depannhome_users"));
    assert.match(update, /updateOrganization\(accountId, request\.body\?\.organization, request\.user\.sub, connection\)/);
});

test("le suivi Support Créateur applique aussi la restriction au poste desktop", () => {
    assert.match(supportServer, /app\.get\("\/api\/creator\/support-requests", requireAuthentication, requireCreator/);
    assert.match(supportServer, /app\.patch\("\/api\/creator\/support-requests\/:requestId", requireAuthentication, requireCreator/);
    assert.match(application, /registerSupportRoutes\(app, requireAuthentication, requireCreator\)/);
});

test("session revocation preserves administrator desktop approval while invalidating current sessions", () => {
    assert.match(server, /member\.role='admin' AND device\.device_type='desktop'/);
    assert.match(server, /session_id=NULL/);
    assert.match(server, /administratorDesktopApprovalPreserved: true/);
    assert.match(server, /Utilisez l’action de réactivation de l’entreprise/);
});

test("assistance tables are durable and migration is idempotent", () => {
    for (const source of tableDefinitions) {
        assert.match(source, /CREATE TABLE IF NOT EXISTS depannhome_creator_support_sessions/);
        assert.match(source, /CREATE TABLE IF NOT EXISTS depannhome_creator_recovery_actions/);
    }
    assert.match(consentMigration, /accepted_at TIMESTAMPTZ/);
    assert.match(consentMigration, /declined_at TIMESTAMPTZ/);
    assert.match(remoteControlMigration, /CREATE TABLE IF NOT EXISTS depannhome_creator_support_activity/);
    assert.match(application, /registerCreatorAssistanceRoutes\(app, requireCreator, requireAuthentication\)/);
    assert.match(application, /await initializeCreatorAssistance\(\)/);
});

test("creator console exposes an explicit assistance workflow and warning banner", () => {
    assert.match(client, /id="creatorAssistance"/);
    assert.match(client, /renderCreatorAssistance/);
    assert.match(client, /creator-assistance-banner/);
    assert.match(client, /Vue sans usurpation/);
    assert.match(client, /l’entreprise sera notifiée/);
    assert.match(client, /data-request-assistance/);
    assert.match(client, /En attente de l’entreprise/);
});

test("PWA versions are synchronized for creator assistance assets", () => {
    assert.match(navigation, /creator\.js\?v=170/);
    assert.match(index, /css\/style\.css\?v=290/);
    assert.match(index, /js\/app\.js\?v=475/);
    assert.match(serviceWorker, /depann-home-pro-v596/);
    assert.match(serviceWorker, /css\/style\.css\?v=290/);
    assert.match(serviceWorker, /js\/app\.js\?v=475/);
    assert.match(serviceWorker, /js\/collaboration\.js\?v=14/);
    assert.match(serviceWorker, /js\/navigation\.js\?v=498/);
    assert.match(serviceWorker, /js\/creator\.js\?v=170/);
    assert.match(serviceWorker, /js\/connectors\.js\?v=6/);
});

test("Creator account detail remains available when managing its own PC members", () => {
    assert.match(creatorServer, /app\.get\("\/api\/creator\/accounts\/:accountId", requireCreator/);
    assert.match(creatorServer, /const account = \(await loadCreatorAccounts\(request, accountId\)\)\[0\]/);
    assert.match(creatorServer, /!isCreatorUsername\(account\.ownerUsername\) \|\| String\(account\.id\) === String\(request\.user\.sub\)/);
    assert.match(creatorServer, /app\.post\("\/api\/creator\/accounts\/:accountId\/members", requireCreator/);
    assert.match(creatorServer, /sanitizeAccount\(request\.body, false, \{ platformCreator: ownCreatorAccount \}\)/);
    assert.match(creatorServer, /subscriptionPlan = platformCreator \|\| isFreePartner \? "free" : "paid"/);
    assert.match(creatorServer, /subscriptionTier = platformCreator \? "pro"/);
    assert.match(creatorServer, /proration = ownCreatorAccount \|\|/);
    assert.match(client, /Compte plateforme Créateur/);
    assert.match(client, /if \(!isOwnCreatorAccount\) bindSubscriptionTier/);
    assert.match(client, /const isPlatformCreator = !subscriptionTier/);
    assert.match(client, /const isPartner = !isPlatformCreator && interfaceType\.value === "partner"/);
});

test("Creator capacity uses a dedicated endpoint independent from the full company profile", () => {
    assert.match(creatorServer, /app\.patch\("\/api\/creator\/accounts\/:accountId\/capacity", requireCreator/);
    assert.match(client, /`\/api\/creator\/accounts\/\$\{encodeURIComponent\(accountId\)\}\/capacity`/);
    assert.match(client, /isOwnCreatorAccount \? "Enregistrer les capacités" : "Enregistrer l’entreprise"/);
});
