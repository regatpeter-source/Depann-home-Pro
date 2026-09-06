import bcrypt from "bcrypt";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";
import { recordSecurityEvent } from "./security-hardening.js";
import { createUser, findUserById, findUserByUsername, getPool } from "./database.js";
import { sendDeviceVerificationCode } from "./email.js";
import { releaseLocksForUser } from "./collaboration.js";
import { resolveCompanyName, resolveGroupCompany } from "./group-context.js";
import { getOrganization } from "./organizations.js";
import { isRoleAllowedForSubscription, subscriptionRoleAccessMessage } from "./subscription-tiers.js";
import { hasCompanyEmailWorkspaceAccess, isAdvancedWorkstationTier, supportsConfigurablePcPermissions } from "./workstation-permissions.js";

const COOKIE_NAME = "depann_home_session";
const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;
const MIN_PASSWORD_LENGTH = 12;
const ADMIN_SESSION_DURATION = 12 * 60 * 60 * 1000;
const MOBILE_SESSION_DURATION = 90 * 24 * 60 * 60 * 1000;
const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CREATOR_TOTP_CHALLENGE_DURATION_SECONDS = 5 * 60;
const COMPANY_TOTP_CHALLENGE_DURATION_SECONDS = 5 * 60;
const COMPANY_TOTP_MAX_ATTEMPTS = 5;
const MOBILE_ADMIN_ROLE = "mobile_admin";
const STANDARD_PC_ROLE = "pc_standard";
const COMMERCIAL_ROLE = "commercial";
const TEAM_LEAD_ROLE = "team_lead";
const WORKSTATION_TOTP_ROLES = new Set(["admin", STANDARD_PC_ROLE, COMMERCIAL_ROLE]);
const CREATABLE_MEMBER_ROLES = new Set(["admin", STANDARD_PC_ROLE, COMMERCIAL_ROLE, MOBILE_ADMIN_ROLE, TEAM_LEAD_ROLE, "technician"]);

export function memberSeatFamily(role) {
    if (["admin", STANDARD_PC_ROLE, COMMERCIAL_ROLE, "accountant"].includes(role)) return "pc";
    if ([MOBILE_ADMIN_ROLE, TEAM_LEAD_ROLE, "technician"].includes(role)) return "mobile";
    return "";
}

export async function memberSeatError(ownerId, role, excludedMemberId = 0, database = getPool(), checkRoleAccess = true) {
    const family = memberSeatFamily(role);
    if (!family) return "";
    const roleAccessError = checkRoleAccess ? await memberRoleAccessError(ownerId, role) : "";
    if (roleAccessError) return roleAccessError;
    const { rows } = await database.query(`
        SELECT owner.max_pc_users AS "maxPcUsers",owner.max_technicians AS "maxMobileUsers",
            COUNT(DISTINCT member.id) FILTER (WHERE member.role IN ('admin','pc_standard','commercial','accountant') AND member.is_active AND member.id<>$2)::int AS "activePcUsers",
            COUNT(DISTINCT member.id) FILTER (WHERE member.role IN ('mobile_admin','team_lead','technician') AND member.is_active AND member.id<>$2)::int
                + COUNT(DISTINCT cross_device_mobile.id) FILTER (WHERE cross_device_mobile.status='approved')::int AS "activeMobileUsers"
        FROM depannhome_users owner LEFT JOIN depannhome_users member ON member.account_owner_id=owner.id
        LEFT JOIN depannhome_users cross_device_account ON cross_device_account.account_owner_id=owner.id AND cross_device_account.role IN ('admin','commercial') AND cross_device_account.is_active
        LEFT JOIN depannhome_auth_devices cross_device_mobile ON cross_device_mobile.user_id=cross_device_account.id AND cross_device_mobile.device_type='mobile'
        WHERE owner.id=$1 GROUP BY owner.id
    `, [ownerId, excludedMemberId]);
    const seats = rows[0];
    if (!seats) return "Compte entreprise introuvable.";
    if (family === "pc" && seats.activePcUsers >= seats.maxPcUsers) return "La limite de postes administratifs de votre entreprise est atteinte.";
    if (family === "mobile" && seats.activeMobileUsers >= seats.maxMobileUsers) return "La limite de postes mobiles de votre entreprise est atteinte.";
    return "";
}

export async function memberRoleAccessError(ownerId, role) {
    const organization = await getOrganization(ownerId);
    return subscriptionRoleAccessMessage(organization.subscriptionTier, role);
}

export async function mobileAdministratorSeatError(ownerId, excludedDeviceId = "") {
    const { rows } = await getPool().query(`
        SELECT owner.max_technicians AS "maxMobileUsers",
            COUNT(DISTINCT mobile_member.id) FILTER (WHERE mobile_member.is_active)::int
                + COUNT(DISTINCT cross_device_mobile.id) FILTER (WHERE cross_device_mobile.status='approved' AND cross_device_mobile.id<>$2)::int AS "activeMobileUsers"
        FROM depannhome_users owner
        LEFT JOIN depannhome_users mobile_member ON mobile_member.account_owner_id=owner.id AND mobile_member.role IN ('mobile_admin','team_lead','technician')
        LEFT JOIN depannhome_users cross_device_account ON cross_device_account.account_owner_id=owner.id AND cross_device_account.role IN ('admin','commercial') AND cross_device_account.is_active
        LEFT JOIN depannhome_auth_devices cross_device_mobile ON cross_device_mobile.user_id=cross_device_account.id AND cross_device_mobile.device_type='mobile'
        WHERE owner.id=$1 GROUP BY owner.id
    `, [ownerId, excludedDeviceId]);
    const seats = rows[0];
    if (!seats) return "Compte entreprise introuvable.";
    return seats.activeMobileUsers >= seats.maxMobileUsers
        ? "Aucun poste mobile supplémentaire n’est inclus dans votre offre. Demandez un poste mobile supplémentaire au Support."
        : "";
}

export function registerAuthRoutes(app) {
    app.get("/api/auth/session", asyncHandler(async (request, response) => {
        const user = request.user;
        if (!user) {
            if (request.sessionWindowReplaced) response.set("X-DepannHome-Session-Replaced", "true");
            return response.json({
                authenticated: false,
                registrationEnabled: isPublicRegistrationEnabled(),
                sessionReplaced: Boolean(request.sessionWindowReplaced),
                deviceIdentityChanged: Boolean(request.deviceIdentityChanged)
            });
        }
        const accountOwnerId = String(user.activeCompanyId || user.accountOwnerId || user.account_owner_id || user.id || user.sub);
        const organization = await getOrganization(accountOwnerId);
        if (user.deviceType === "mobile") {
            setSessionCookie(response, user, user.deviceId, user.deviceType, accountOwnerId);
        }

        return response.json({
            authenticated: true,
            registrationEnabled: isPublicRegistrationEnabled(),
            user: publicUser({ ...user, accountOwnerId, activeCompanyId: accountOwnerId, organization })
        });
    }));

    app.post("/api/auth/login", asyncHandler(async (request, response) => {
        const username = normalizeUsername(request.body?.username);
        const password = String(request.body?.password || "");
        const device = getDeviceDetails(request.body);
        if (!device) return response.status(400).json({ message: "Cet appareil ne peut pas être identifié. Actualisez l’application puis réessayez." });
        const user = username ? await findUserByUsername(username) : null;
        const passwordMatches = user?.is_active && user?.account_is_active && await bcrypt.compare(password, user.password_hash);

        if (!passwordMatches) {
            await recordSecurityEvent({ request, eventType: "login", outcome: "failure" });
            return response.status(401).json({ message: "Identifiant ou mot de passe incorrect." });
        }

        if (isCreatorUsername(user.username) && await isCreatorTotpEnabled(user.id)) {
            return response.status(202).json({
                totpRequired: true,
                challenge: await createCreatorTotpChallenge(user, device),
                message: "Saisissez le code affiché dans Google Authenticator."
            });
        }
        if (WORKSTATION_TOTP_ROLES.has(user.role) && device.type === "desktop" && !isCreatorUsername(user.username) && await hasCompanyTotpAuthenticator(user.id)) {
            return response.status(202).json({
                companyTotpRequired: true,
                challenge: await createCompanyTotpChallenge(user, device, "login"),
                message: "Saisissez le code de votre application d’authentification."
            });
        }
        return completeLogin(user, device, response, request);
    }));

    app.post("/api/auth/verify-creator-totp", asyncHandler(async (request, response) => {
        const challenge = await verifyCreatorTotpChallenge(request.body?.challenge);
        const code = normalizeTotpCode(request.body?.code);
        if (!challenge || !code) return response.status(401).json({ message: "Le code de sécurité est invalide ou a expiré." });
        const user = await findUserById(challenge.sub);
        if (!user?.is_active || !user.account_is_active || !isCreatorUsername(user.username)) {
            return response.status(401).json({ message: "Cette connexion n’est plus autorisée." });
        }
        const secret = await getCreatorTotpSecret(user.id);
        if (!secret || !isValidTotpCode(secret, code, user.username)) {
            const attempts = await recordCreatorTotpFailure(challenge.id);
            await recordSecurityEvent({ request, eventType: "creator_totp_validation", outcome: "failure", userId: user.id, details: { attempts } });
            return response.status(401).json({ message: "Le code Google Authenticator est incorrect." });
        }
        const device = getDeviceDetails({ deviceId: challenge.device?.id, deviceLabel: challenge.device?.label, deviceType: challenge.device?.type });
        if (!device) return response.status(401).json({ message: "Cet appareil ne peut pas être identifié. Recommencez la connexion." });
        const consumed = await getPool().query("UPDATE depannhome_creator_totp_challenges SET consumed_at=NOW() WHERE id=$1 AND consumed_at IS NULL AND expires_at>NOW() RETURNING id", [challenge.id]);
        if (!consumed.rowCount) return response.status(401).json({ message: "Cette demande a déjà été utilisée. Recommencez la connexion." });
        await recordSecurityEvent({ request, eventType: "creator_totp_validation", outcome: "success", userId: user.id });
        return completeLogin(user, device, response, request);
    }));

    app.post("/api/auth/verify-company-totp", asyncHandler(async (request, response) => {
        const challenge = await getCompanyTotpChallenge(request.body?.challenge, "login");
        const code = normalizeTotpCode(request.body?.code);
        if (!challenge || !code) return response.status(401).json({ message: "Le code de sécurité est invalide ou a expiré." });
        const user = await findUserById(challenge.user_id);
        if (!user?.is_active || !user.account_is_active || !WORKSTATION_TOTP_ROLES.has(user.role) || challenge.device?.type !== "desktop") {
            return response.status(401).json({ message: "Cette connexion n’est plus autorisée." });
        }
        const authenticator = await getCompanyTotpAuthenticator(user.id, "active");
        const secret = authenticator?.secret_ciphertext ? decryptCompanyTotpSecret(authenticator.secret_ciphertext) : "";
        if (!secret || !isValidTotpCode(secret, code, user.username)) {
            const attempts = await recordCompanyTotpFailure(challenge, user);
            await recordSecurityEvent({ request, eventType: "company_totp_validation", outcome: "failure", ownerId: user.account_owner_id, userId: user.id, details: { purpose: challenge.purpose, attempts } });
            return response.status(401).json({ message: attempts >= COMPANY_TOTP_MAX_ATTEMPTS ? "Trop de codes incorrects. Recommencez la connexion." : "Le code de votre application d’authentification est incorrect." });
        }
        const consumed = await getPool().query("UPDATE depannhome_company_totp_challenges SET consumed_at = NOW() WHERE id = $1 AND consumed_at IS NULL RETURNING id", [challenge.id]);
        if (!consumed.rowCount) return response.status(401).json({ message: "Cette demande a déjà été utilisée. Recommencez la connexion." });
        await recordMemberAudit(user.account_owner_id, user.id, user, "workstation_2fa_login_succeeded", { purpose: "login", deviceType: "desktop" });
        await recordSecurityEvent({ request, eventType: "company_totp_validation", outcome: "success", ownerId: user.account_owner_id, userId: user.id, details: { purpose: challenge.purpose } });
        const device = getDeviceDetails({ deviceId: challenge.device?.id, deviceLabel: challenge.device?.label, deviceType: challenge.device?.type });
        if (!device) return response.status(401).json({ message: "Cet appareil ne peut pas être identifié. Recommencez la connexion." });
        return completeLogin(user, device, response, request);
    }));

    app.post("/api/auth/device-validation-status", asyncHandler(async (request, response) => {
        const deviceId = validDeviceId(request.body?.deviceId);
        if (!deviceId) return response.status(400).json({ message: "Appareil invalide." });
        const { rows } = await getPool().query("SELECT status FROM depannhome_auth_devices WHERE id = $1", [deviceId]);
        const device = rows[0];
        if (!device) return response.status(404).json({ message: "Cette demande de validation n’existe plus." });
        if (device.status === "code_pending") return response.json({ codeRequired: true, message: "Le code a été envoyé à votre e-mail professionnel." });
        if (device.status === "rejected") return response.json({ rejected: true, message: "Cet appareil a été refusé par l’administrateur." });
        return response.json({ approvalRequired: true, message: "En attente de la validation de l’administrateur…" });
    }));

    app.post("/api/auth/verify-device-code", asyncHandler(async (request, response) => {
        const deviceId = validDeviceId(request.body?.deviceId);
        const code = String(request.body?.code || "").replace(/\s/g, "");
        if (!deviceId || !/^\d{6}$/.test(code)) return response.status(400).json({ message: "Code de validation invalide." });
        const { rows } = await getPool().query(`
            SELECT device.*, account.id AS user_id, account.username, account.role, account.account_owner_id, account.full_name, account.phone, account.email, account.department, account.departments, account.is_active,
                account.can_create_billing, account.can_access_billing, account.can_access_accounting, account.can_access_company_email, account.can_switch_group_companies,
                owner.is_active AS account_is_active, owner.max_pc_users, owner.max_technicians, owner.monthly_price_cents, owner.subscription_tier
            FROM depannhome_auth_devices device JOIN depannhome_users account ON account.id = device.user_id JOIN depannhome_users owner ON owner.id = account.account_owner_id WHERE device.id = $1
        `, [deviceId]);
        const device = rows[0];
        if (!device || device.status !== "code_pending" || !device.is_active || !device.account_is_active) return response.status(403).json({ message: "Cette demande de validation n’est plus active." });
        if (!device.verification_code_expires_at || new Date(device.verification_code_expires_at) < new Date() || device.verification_attempts >= 5) return response.status(403).json({ message: "Le code a expiré. Demandez à l’administrateur de valider à nouveau cet appareil." });
        if (!await bcrypt.compare(code, device.verification_code_hash)) {
            await getPool().query("UPDATE depannhome_auth_devices SET verification_attempts = verification_attempts + 1 WHERE id = $1", [deviceId]);
            return response.status(401).json({ message: "Code incorrect." });
        }
        const organization = await getOrganization(device.account_owner_id || device.user_id);
        const roleAccessError = subscriptionRoleAccessMessage(organization.subscriptionTier, device.role);
        if (!isCreatorUsername(device.username) && roleAccessError) return response.status(403).json({ message: roleAccessError });
        await getPool().query("UPDATE depannhome_auth_devices SET status = 'approved', verified_at = NOW(), verification_code_hash = '', verification_code_expires_at = NULL, verification_attempts = 0 WHERE id = $1", [deviceId]);
        const sessionId = device.role === "admin" && device.device_type === "desktop"
            ? await issueAdministratorPcSession(device.user_id, deviceId, clientWindowSessionId(request))
            : "";
        setSessionCookie(response, device, deviceId, device.device_type, "", sessionId);
        return response.json({ user: publicUser(device) });
    }));

    app.post("/api/auth/register", asyncHandler(async (request, response) => {
        if (!isPublicRegistrationEnabled()) {
            return response.status(403).json({ message: "La création de compte est réservée à l’administrateur." });
        }

        const username = normalizeUsername(request.body?.username);
        const password = String(request.body?.password || "");
        const device = getDeviceDetails(request.body);
        const validationError = validateCredentials(username, password) || (!device ? "Cet appareil ne peut pas être identifié." : "");
        if (validationError) return response.status(400).json({ message: validationError });

        try {
            const passwordHash = await bcrypt.hash(password, 12);
            const user = await createUser({ username, passwordHash, role: "admin" });
            const authDevice = await createAuthDevice(user.id, device, "approved");
            if (!authDevice) {
                return response.status(409).json({ message: "Cet appareil est déjà associé à un autre compte. Utilisez un autre navigateur ou contactez l’administrateur." });
            }
            const sessionId = device.type === "desktop" ? await issueAdministratorPcSession(user.id, authDevice.id, clientWindowSessionId(request)) : "";
            setSessionCookie(response, user, authDevice.id, device.type, "", sessionId);
            return response.status(201).json({ user: publicUser({ ...user, deviceType: device.type }) });
        } catch (error) {
            if (error.code === "23505") {
                return response.status(409).json({ message: "Ce nom d’utilisateur est déjà utilisé." });
            }
            throw error;
        }
    }));

    app.post("/api/auth/logout", asyncHandler(async (request, response) => {
        if (request.user) await releaseLocksForUser(request, "logout");
        response.clearCookie(COOKIE_NAME, cookieOptions());
        response.status(204).end();
    }));

    app.get("/api/auth/creator-2fa", requireAuthentication, requireCreator, asyncHandler(async (request, response) => {
        response.json({ enabled: await isCreatorTotpEnabled(request.user.sub) });
    }));

    app.post("/api/auth/creator-2fa/setup", requireAuthentication, requireCreator, asyncHandler(async (request, response) => {
        if (await isCreatorTotpEnabled(request.user.sub)) {
            return response.status(409).json({ message: "La double authentification est déjà activée. Désactivez-la avec un code valide avant de la reconfigurer." });
        }
        const secret = new OTPAuth.Secret({ size: 20 }).base32;
        const totp = createTotp(secret, request.user.username);
        const qrCodeDataUrl = await QRCode.toDataURL(totp.toString(), { width: 260, margin: 1, errorCorrectionLevel: "M" });
        await getPool().query(`
            INSERT INTO depannhome_creator_totp (user_id, pending_secret_ciphertext, pending_expires_at, enabled, updated_at)
            VALUES ($1, $2, NOW() + INTERVAL '10 minutes', FALSE, NOW())
            ON CONFLICT (user_id) DO UPDATE SET pending_secret_ciphertext = EXCLUDED.pending_secret_ciphertext,
                pending_expires_at = EXCLUDED.pending_expires_at, enabled = FALSE, updated_at = NOW()
        `, [request.user.sub, encryptCreatorTotpSecret(secret)]);
        response.json({ qrCodeDataUrl, manualSecret: secret, expiresInSeconds: 600 });
    }));

    app.post("/api/auth/creator-2fa/confirm", requireAuthentication, requireCreator, asyncHandler(async (request, response) => {
        const code = normalizeTotpCode(request.body?.code);
        if (!code) return response.status(400).json({ message: "Saisissez les 6 chiffres affichés dans Google Authenticator." });
        const { rows } = await getPool().query(`
            SELECT pending_secret_ciphertext AS "pendingSecretCiphertext"
            FROM depannhome_creator_totp
            WHERE user_id = $1 AND enabled = FALSE AND pending_expires_at > NOW()
        `, [request.user.sub]);
        const secret = rows[0]?.pendingSecretCiphertext ? decryptCreatorTotpSecret(rows[0].pendingSecretCiphertext) : "";
        if (!secret || !isValidTotpCode(secret, code, request.user.username)) {
            return response.status(400).json({ message: "Le code Google Authenticator est incorrect ou la configuration a expiré." });
        }
        await getPool().query(`
            UPDATE depannhome_creator_totp
            SET secret_ciphertext = pending_secret_ciphertext, pending_secret_ciphertext = '', pending_expires_at = NULL,
                enabled = TRUE, confirmed_at = NOW(), updated_at = NOW()
            WHERE user_id = $1
        `, [request.user.sub]);
        response.json({ message: "Google Authenticator est maintenant activé pour votre compte Créateur." });
    }));

    app.delete("/api/auth/creator-2fa", requireAuthentication, requireCreator, asyncHandler(async (request, response) => {
        const code = normalizeTotpCode(request.body?.code);
        const secret = await getCreatorTotpSecret(request.user.sub);
        if (!code || !secret || !isValidTotpCode(secret, code, request.user.username)) {
            return response.status(400).json({ message: "Saisissez un code Google Authenticator valide pour désactiver la double authentification." });
        }
        await getPool().query("DELETE FROM depannhome_creator_totp WHERE user_id = $1", [request.user.sub]);
        response.json({ message: "La double authentification a été désactivée." });
    }));

    app.get("/api/auth/workstation-2fa", requireAuthentication, requireWorkstationSecurityAccess, asyncHandler(async (request, response) => {
        response.json({ enabled: await hasCompanyTotpAuthenticator(request.user.sub) });
    }));

    app.post("/api/auth/workstation-2fa/setup", requireAuthentication, requireWorkstationSecurityAccess, asyncHandler(async (request, response) => {
        if (await hasCompanyTotpAuthenticator(request.user.sub)) return response.status(409).json({ message: "La double authentification est déjà activée pour ce poste." });
        const user = await findUserById(request.user.sub);
        if (!user) return response.status(404).json({ message: "Compte introuvable." });
        await getPool().query("DELETE FROM depannhome_company_totp_authenticators WHERE user_id = $1 AND status = 'pending'", [user.id]);
        const secret = new OTPAuth.Secret({ size: 20 }).base32;
        const authenticatorId = crypto.randomUUID();
        await getPool().query(`
            INSERT INTO depannhome_company_totp_authenticators (id, owner_id, user_id, secret_ciphertext, status, pending_expires_at)
            VALUES ($1, $2, $3, $4, 'pending', NOW() + INTERVAL '10 minutes')
        `, [authenticatorId, user.account_owner_id, user.id, encryptCompanyTotpSecret(secret)]);
        const qrCodeDataUrl = await QRCode.toDataURL(createTotp(secret, user.username).toString(), { width: 260, margin: 1, errorCorrectionLevel: "M" });
        response.json({ qrCodeDataUrl, manualSecret: secret, expiresInSeconds: 600 });
    }));

    app.post("/api/auth/workstation-2fa/confirm", requireAuthentication, requireWorkstationSecurityAccess, asyncHandler(async (request, response) => {
        const code = normalizeTotpCode(request.body?.code);
        const user = await findUserById(request.user.sub);
        const authenticator = user && await getCompanyTotpAuthenticator(user.id, "pending");
        const secret = authenticator?.secret_ciphertext ? decryptCompanyTotpSecret(authenticator.secret_ciphertext) : "";
        if (!code || !secret || !isValidTotpCode(secret, code, user.username)) return response.status(400).json({ message: "Le code est incorrect ou la configuration a expiré." });
        await getPool().query(`
            UPDATE depannhome_company_totp_authenticators
            SET status='active', pending_expires_at=NULL, confirmed_at=NOW(), updated_at=NOW()
            WHERE id=$1 AND user_id=$2 AND status='pending'
        `, [authenticator.id, user.id]);
        await recordMemberAudit(user.account_owner_id, user.id, user, "workstation_2fa_enabled", { scope: "personal", deviceType: "desktop" });
        response.json({ enabled: true, message: "La double authentification est activée pour votre poste PC." });
    }));

    app.delete("/api/auth/workstation-2fa", requireAuthentication, requireWorkstationSecurityAccess, asyncHandler(async (request, response) => {
        const code = normalizeTotpCode(request.body?.code);
        const user = await findUserById(request.user.sub);
        const authenticator = user && await getCompanyTotpAuthenticator(user.id, "active");
        const secret = authenticator?.secret_ciphertext ? decryptCompanyTotpSecret(authenticator.secret_ciphertext) : "";
        if (!code || !secret || !isValidTotpCode(secret, code, user.username)) return response.status(400).json({ message: "Saisissez un code valide pour désactiver la double authentification." });
        await getPool().query("DELETE FROM depannhome_company_totp_authenticators WHERE user_id=$1", [user.id]);
        await getPool().query("DELETE FROM depannhome_company_totp_challenges WHERE user_id=$1", [user.id]);
        await recordMemberAudit(user.account_owner_id, user.id, user, "workstation_2fa_disabled", { scope: "personal", deviceType: "desktop" });
        response.json({ enabled: false, message: "La double authentification est désactivée pour votre poste PC." });
    }));

    app.get("/api/auth/members", requireAccountAdministrator, asyncHandler(async (request, response) => {
        const { rows } = await getPool().query(`
            SELECT id, username, role, full_name AS "fullName", phone, email, department, departments, is_active AS "isActive", can_create_billing AS "canCreateBilling",
                can_access_billing AS "canAccessBilling", can_access_accounting AS "canAccessAccounting", can_access_company_email AS "canAccessCompanyEmail", can_switch_group_companies AS "canSwitchGroupCompanies", created_at AS "createdAt"
            FROM depannhome_users
            WHERE account_owner_id = $1 AND id <> $1
            ORDER BY role, LOWER(full_name), username
        `, [getAccountOwnerId(request)]);
        response.json({ members: rows });
    }));

    app.get("/api/auth/members/audit", requireAccountAdministrator, asyncHandler(async (request, response) => {
        const { rows } = await getPool().query(`
            SELECT audit.id, audit.action, audit.target_username AS "targetUsername", audit.target_full_name AS "targetFullName",
                audit.details, audit.created_at AS "createdAt", COALESCE(actor.full_name, actor.username, 'Compte supprimé') AS "actorName"
            FROM depannhome_member_audit audit
            LEFT JOIN depannhome_users actor ON actor.id = audit.actor_id
            WHERE audit.owner_id = $1
            ORDER BY audit.created_at DESC
            LIMIT 100
        `, [getAccountOwnerId(request)]);
        response.json({ entries: rows });
    }));

    app.post("/api/auth/members", requireAccountAdministrator, asyncHandler(async (request, response) => {
        const role = CREATABLE_MEMBER_ROLES.has(request.body?.role) ? request.body.role : "";
        const username = normalizeUsername(request.body?.username);
        const password = String(request.body?.password || "");
        const fullName = cleanText(request.body?.fullName, 100);
        const phone = cleanText(request.body?.phone, 30);
        const email = cleanText(request.body?.email, 160).toLowerCase();
        const departments = cleanDepartments(request.body?.departments, request.body?.department);
        const department = departments[0] || "";
        const validationError = validateCredentials(username, password)
            || (!role ? "Choisissez le type de poste." : "")
            || (!fullName ? "Le nom de l’utilisateur est obligatoire." : "")
            || (["technician", TEAM_LEAD_ROLE].includes(role) && !phone ? "Le téléphone du technicien est obligatoire." : "")
            || (["technician", TEAM_LEAD_ROLE].includes(role) && !departments.length ? "Choisissez au moins une section métier." : "")
            || ([MOBILE_ADMIN_ROLE, COMMERCIAL_ROLE].includes(role) && !phone ? `Le téléphone du ${role === COMMERCIAL_ROLE ? "Commercial / Chargé d’affaires" : "Poste Admin Mobile"} est obligatoire.` : "")
            || (["technician", TEAM_LEAD_ROLE, MOBILE_ADMIN_ROLE, COMMERCIAL_ROLE].includes(role) && !EMAIL_PATTERN.test(email) ? "L’e-mail professionnel est obligatoire pour l’activation mobile." : "");
        if (validationError) return response.status(400).json({ message: validationError });

        const seatError = await memberSeatError(getAccountOwnerId(request), role);
        if (seatError) return response.status(400).json({ message: seatError });
        try {
            const organization = await getOrganization(getAccountOwnerId(request));
            const configurablePermissions = isAdvancedWorkstationTier(organization.subscriptionTier) && supportsConfigurablePcPermissions(role);
            const canAccessBilling = configurablePermissions && request.body?.canAccessBilling === true;
            const canAccessAccounting = configurablePermissions && request.body?.canAccessAccounting === true;
            const canAccessCompanyEmail = configurablePermissions && request.body?.canAccessCompanyEmail === true;
            const canCreateBilling = ["technician", TEAM_LEAD_ROLE].includes(role) && request.body?.canCreateBilling === true;
            const canSwitchGroupCompanies = configurablePermissions && organization.subscriptionTier === "pro"
                && Boolean(request.user.groupId) && request.body?.canSwitchGroupCompanies === true;
            const memberDepartments = ["technician", TEAM_LEAD_ROLE].includes(role) ? departments : [];
            const member = await createUser({ username, passwordHash: await bcrypt.hash(password, 12), role, accountOwnerId: getAccountOwnerId(request), fullName, phone, email, department: memberDepartments[0] || "", departments: memberDepartments, canCreateBilling, canAccessBilling, canAccessAccounting, canAccessCompanyEmail, canSwitchGroupCompanies });
            await recordMemberAudit(getAccountOwnerId(request), request.user.sub, member, role === "admin" ? "administrator_created" : "member_created", { role, canCreateBilling, canAccessBilling, canAccessAccounting, canAccessCompanyEmail, canSwitchGroupCompanies });
            response.status(201).json({ member: publicUser(member) });
        } catch (error) {
            if (error.code === "23505") return response.status(409).json({ message: "Ce nom d’utilisateur est déjà utilisé." });
            throw error;
        }
    }));

    app.patch("/api/auth/members/:memberId", requireAccountAdministrator, asyncHandler(async (request, response) => {
        const memberId = positiveId(request.params.memberId);
        if (!memberId) return response.status(400).json({ message: "Accès invalide." });
        const { rows } = await getPool().query(`
            SELECT id, username, full_name AS "fullName", role, department, departments, is_active AS "isActive", can_create_billing AS "canCreateBilling",
                can_access_billing AS "canAccessBilling", can_access_accounting AS "canAccessAccounting", can_access_company_email AS "canAccessCompanyEmail", can_switch_group_companies AS "canSwitchGroupCompanies"
            FROM depannhome_users
            WHERE id = $1 AND account_owner_id = $2 AND id <> $2
        `, [memberId, getAccountOwnerId(request)]);
        const member = rows[0];
        if (!member) return response.status(404).json({ message: "Accès introuvable." });
        const isActive = typeof request.body?.isActive === "boolean" ? request.body.isActive : member.isActive;
        const canCreateBilling = ["technician", TEAM_LEAD_ROLE].includes(member.role) && typeof request.body?.canCreateBilling === "boolean"
            ? request.body.canCreateBilling
            : member.canCreateBilling;
        const organization = await getOrganization(getAccountOwnerId(request));
        const configurablePermissions = isAdvancedWorkstationTier(organization.subscriptionTier) && supportsConfigurablePcPermissions(member.role);
        const canAccessBilling = configurablePermissions && (typeof request.body?.canAccessBilling === "boolean" ? request.body.canAccessBilling : member.canAccessBilling);
        const canAccessAccounting = configurablePermissions && (typeof request.body?.canAccessAccounting === "boolean" ? request.body.canAccessAccounting : member.canAccessAccounting);
        const canAccessCompanyEmail = configurablePermissions && (typeof request.body?.canAccessCompanyEmail === "boolean" ? request.body.canAccessCompanyEmail : member.canAccessCompanyEmail);
        const canSwitchGroupCompanies = configurablePermissions && organization.subscriptionTier === "pro" && Boolean(request.user.groupId)
            && (typeof request.body?.canSwitchGroupCompanies === "boolean" ? request.body.canSwitchGroupCompanies : member.canSwitchGroupCompanies);
        const departments = ["technician", TEAM_LEAD_ROLE].includes(member.role) && (Array.isArray(request.body?.departments) || typeof request.body?.department === "string")
            ? cleanDepartments(request.body.departments, request.body.department)
            : cleanDepartments(member.departments, member.department);
        const department = departments[0] || "";
        if (member.role === "admin" && member.isActive && !isActive) {
            await ensureActiveAdministratorRemains(getAccountOwnerId(request), memberId);
        }
        if (isActive && !member.isActive) {
            const seatError = await memberSeatError(getAccountOwnerId(request), member.role, memberId);
            if (seatError) return response.status(400).json({ message: seatError });
        }
        await getPool().query("UPDATE depannhome_users SET is_active = $3, can_create_billing = $4, can_access_billing = $5, can_access_accounting = $6, can_access_company_email = $7, can_switch_group_companies = $8, department = $9, departments = $10::jsonb, updated_at = NOW() WHERE id = $1 AND account_owner_id = $2", [memberId, getAccountOwnerId(request), isActive, canCreateBilling, canAccessBilling, canAccessAccounting, canAccessCompanyEmail, canSwitchGroupCompanies, department, JSON.stringify(departments)]);
        await recordMemberAudit(getAccountOwnerId(request), request.user.sub, member, member.role === "admin" ? (isActive ? "administrator_activated" : "administrator_deactivated") : "member_updated", { isActive, canCreateBilling, canAccessBilling, canAccessAccounting, canAccessCompanyEmail, canSwitchGroupCompanies, departments });
        response.status(204).end();
    }));

    app.patch("/api/auth/members/:memberId/role", requireAccountAdministrator, asyncHandler(async (request, response) => {
        const memberId = positiveId(request.params.memberId);
        const nextRole = CREATABLE_MEMBER_ROLES.has(request.body?.role) ? request.body.role : "";
        if (!memberId || !nextRole) return response.status(400).json({ message: "Rôle invalide." });
        const ownerId = getAccountOwnerId(request);
        const roleAccessError = await memberRoleAccessError(ownerId, nextRole);
        if (roleAccessError) return response.status(400).json({ message: roleAccessError });
        const database = await getPool().connect();
        let failedStep = "initialisation";
        try {
            failedStep = "verrouillage du membre";
            await database.query("BEGIN");
            const { rows } = await database.query(`
                SELECT id, username, full_name AS "fullName", role, is_active AS "isActive"
                FROM depannhome_users WHERE id = $1 AND account_owner_id = $2 AND id <> $2
                FOR UPDATE
            `, [memberId, ownerId]);
            const member = rows[0];
            if (!member) { await database.query("ROLLBACK"); return response.status(404).json({ message: "Accès introuvable." }); }
            if (member.role === nextRole) { await database.query("COMMIT"); return response.status(204).end(); }
            if (member.role === "admin" && member.isActive && nextRole !== "admin") {
                const administrators = await database.query("SELECT COUNT(*)::int AS count FROM depannhome_users WHERE account_owner_id=$1 AND role='admin' AND is_active=TRUE AND id<>$2", [ownerId, memberId]);
                if (!administrators.rows[0]?.count) { await database.query("ROLLBACK"); return response.status(409).json({ message: "Cette opération est refusée : chaque entreprise doit conserver au moins un Poste Admin actif." }); }
            }
            if (member.isActive && memberSeatFamily(member.role) !== memberSeatFamily(nextRole)) {
                failedStep = "contrôle du quota de postes";
                const seatError = await memberSeatError(ownerId, nextRole, memberId, database, false);
                if (seatError) { await database.query("ROLLBACK"); return response.status(400).json({ message: seatError }); }
            }
            failedStep = "mise à jour du rôle";
            await database.query(`
                UPDATE depannhome_users
                SET role = $3, department = CASE WHEN $3 IN ('technician', 'team_lead') THEN department ELSE '' END,
                    departments = CASE WHEN $3 IN ('technician', 'team_lead') THEN departments ELSE '[]'::jsonb END,
                    can_create_billing = CASE WHEN $3 IN ('technician', 'team_lead') THEN FALSE ELSE can_create_billing END,
                    can_access_billing = CASE WHEN $3 IN ('pc_standard', 'commercial', 'accountant') THEN can_access_billing ELSE FALSE END,
                    can_access_accounting = CASE WHEN $3 IN ('pc_standard', 'commercial', 'accountant') THEN can_access_accounting ELSE FALSE END,
                    can_access_company_email = CASE WHEN $3 IN ('pc_standard', 'commercial', 'accountant') THEN can_access_company_email ELSE FALSE END,
                    can_switch_group_companies = CASE WHEN $3 IN ('pc_standard', 'commercial', 'accountant') THEN can_switch_group_companies ELSE FALSE END,
                    updated_at = NOW()
                WHERE id = $1 AND account_owner_id = $2
            `, [memberId, ownerId, nextRole]);
            const incompatibleDeviceType = [MOBILE_ADMIN_ROLE, TEAM_LEAD_ROLE, "technician"].includes(nextRole)
                ? "desktop"
                : [STANDARD_PC_ROLE, "accountant"].includes(nextRole) ? "mobile" : "";
            failedStep = "mise en conformité des appareils";
            const rejectedDevices = incompatibleDeviceType ? await database.query(`
                UPDATE depannhome_auth_devices
                SET status='rejected', session_id=NULL, verification_code_hash='', verification_code_expires_at=NULL
                WHERE user_id=$1 AND device_type=$2 AND status<>'rejected'
                RETURNING id
            `, [memberId, incompatibleDeviceType]) : { rows: [] };
            const deviceActivationRequired = rejectedDevices.rows.length > 0;
            let auditRecorded = true;
            await database.query("SAVEPOINT member_role_audit");
            try {
                await recordMemberAudit(ownerId, request.user.sub, member, "role_changed", { previousRole: member.role, nextRole, deviceActivationRequired, rejectedDeviceIds: rejectedDevices.rows.map(device => device.id) }, database);
                await database.query("RELEASE SAVEPOINT member_role_audit");
            } catch (auditError) {
                auditRecorded = false;
                await database.query("ROLLBACK TO SAVEPOINT member_role_audit");
                await database.query("RELEASE SAVEPOINT member_role_audit");
                console.error("[member-role-change] audit failed", { ownerId, memberId, nextRole, code: auditError.code, message: auditError.message });
            }
            failedStep = "validation de la transaction";
            await database.query("COMMIT");
            response.json({ role: nextRole, deviceActivationRequired, auditRecorded });
        } catch (error) {
            await database.query("ROLLBACK").catch(() => {});
            console.error("[member-role-change] failed", { ownerId, memberId, nextRole, failedStep, code: error.code, message: error.message });
            response.status(409).json({ message: `Le rôle n’a pas été modifié pendant l’étape « ${failedStep} ». Réessayez après avoir rechargé la page.` });
        } finally {
            database.release();
        }
    }));

    app.post("/api/auth/members/:memberId/reset-password", requireAccountAdministrator, asyncHandler(async (request, response) => {
        const memberId = positiveId(request.params.memberId);
        const password = String(request.body?.password || "");
        if (!memberId) return response.status(400).json({ message: "Accès invalide." });
        if (password.length < MIN_PASSWORD_LENGTH) return response.status(400).json({ message: `Le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères.` });
        const result = await getPool().query(`
            UPDATE depannhome_users
            SET password_hash = $3, updated_at = NOW()
            WHERE id = $1 AND account_owner_id = $2
            RETURNING id, username, full_name AS "fullName", role
        `, [memberId, getAccountOwnerId(request), await bcrypt.hash(password, 12)]);
        if (!result.rowCount) return response.status(404).json({ message: "Accès introuvable." });
        await recordMemberAudit(getAccountOwnerId(request), request.user.sub, result.rows[0], result.rows[0].role === "admin" ? "administrator_modified" : "member_password_reset", { field: "password" });
        response.status(204).end();
    }));

    app.delete("/api/auth/members/:memberId", requireAccountAdministrator, asyncHandler(async (request, response) => {
        const memberId = positiveId(request.params.memberId);
        if (!memberId) return response.status(400).json({ message: "Accès invalide." });
        const { rows } = await getPool().query("SELECT id, username, full_name AS \"fullName\", role, is_active AS \"isActive\" FROM depannhome_users WHERE id = $1 AND account_owner_id = $2 AND id <> $2", [memberId, getAccountOwnerId(request)]);
        const member = rows[0];
        if (!member) return response.status(404).json({ message: "Accès introuvable." });
        if (member.role === "admin" && member.isActive) await ensureActiveAdministratorRemains(getAccountOwnerId(request), memberId);
        const result = await getPool().query("DELETE FROM depannhome_users WHERE id = $1 AND account_owner_id = $2 AND id <> $2", [memberId, getAccountOwnerId(request)]);
        if (!result.rowCount) return response.status(404).json({ message: "Accès introuvable." });
        await recordMemberAudit(getAccountOwnerId(request), request.user.sub, member, member.role === "admin" ? "administrator_deleted" : "member_deleted", { role: member.role });
        response.status(204).end();
    }));

    app.get("/api/auth/technicians", requireTechnicianDirectoryAccess, asyncHandler(async (request, response) => {
        const { rows } = await getPool().query(`
            SELECT id, username, full_name AS "fullName", phone, email, department, departments, is_active AS "isActive", created_at AS "createdAt"
            FROM depannhome_users
            WHERE account_owner_id = $1 AND id <> $1 AND role = 'technician'
            ORDER BY LOWER(full_name), username
        `, [getAccountOwnerId(request)]);
        response.json({ technicians: rows });
    }));

    app.get("/api/auth/calendar-members", requireCalendarMemberDirectoryAccess, asyncHandler(async (request, response) => {
        const { rows } = await getPool().query(`
            SELECT id, username, full_name AS "fullName", phone, email, department, departments, role, is_active AS "isActive"
            FROM depannhome_users
            WHERE account_owner_id = $1 AND is_active = TRUE
            ORDER BY LOWER(COALESCE(NULLIF(full_name, ''), username)), username
        `, [getAccountOwnerId(request)]);
        response.json({ members: rows });
    }));

    app.post("/api/auth/technicians", requireAccountAdministrator, asyncHandler(async (request, response) => {
        const username = normalizeUsername(request.body?.username);
        const password = String(request.body?.password || "");
        const fullName = cleanText(request.body?.fullName, 100);
        const phone = cleanText(request.body?.phone, 30);
        const email = cleanText(request.body?.email, 160).toLowerCase();
        const departments = cleanDepartments(request.body?.departments, request.body?.department);
        const department = departments[0] || "";
        const canCreateBilling = request.body?.canCreateBilling === true;
        const validationError = validateCredentials(username, password) || (!fullName ? "Le nom du technicien est obligatoire." : "") || (!phone ? "Le téléphone du technicien est obligatoire." : "") || (!EMAIL_PATTERN.test(email) ? "L’e-mail professionnel du technicien est obligatoire." : "");
        if (validationError) return response.status(400).json({ message: validationError });
        const seatError = await memberSeatError(getAccountOwnerId(request), "technician");
        if (seatError) return response.status(400).json({ message: seatError });
        try {
            const user = await createUser({ username, passwordHash: await bcrypt.hash(password, 12), role: "technician", accountOwnerId: getAccountOwnerId(request), fullName, phone, email, department, departments, canCreateBilling });
            response.status(201).json({ technician: publicUser(user) });
        } catch (error) {
            if (error.code === "23505") return response.status(409).json({ message: "Ce nom d’utilisateur est déjà utilisé." });
            throw error;
        }
    }));

    app.patch("/api/auth/technicians/:technicianId", requireAccountAdministrator, asyncHandler(async (request, response) => {
        const technicianId = positiveId(request.params.technicianId);
        if (!technicianId) return response.status(400).json({ message: "Technicien invalide." });
        const isActive = Boolean(request.body?.isActive);
        const departments = cleanDepartments(request.body?.departments, request.body?.department);
        const department = departments[0] || "";
        if (isActive) {
            const seatError = await memberSeatError(getAccountOwnerId(request), "technician", technicianId);
            if (seatError) return response.status(400).json({ message: seatError });
        }
        const result = await getPool().query(`
            UPDATE depannhome_users SET is_active = $3, department = $4, departments = $5::jsonb, updated_at = NOW()
            WHERE id = $1 AND account_owner_id = $2 AND id <> $2 AND role = 'technician'
        `, [technicianId, getAccountOwnerId(request), isActive, department, JSON.stringify(departments)]);
        if (!result.rowCount) return response.status(404).json({ message: "Technicien introuvable." });
        response.status(204).end();
    }));

    app.delete("/api/auth/technicians/:technicianId", requireAccountAdministrator, asyncHandler(async (request, response) => {
        const technicianId = positiveId(request.params.technicianId);
        if (!technicianId) return response.status(400).json({ message: "Technicien invalide." });
        const result = await getPool().query(`
            DELETE FROM depannhome_users
            WHERE id = $1 AND account_owner_id = $2 AND id <> $2 AND role = 'technician'
        `, [technicianId, getAccountOwnerId(request)]);
        if (!result.rowCount) return response.status(404).json({ message: "Technicien introuvable." });
        response.status(204).end();
    }));

    app.get("/api/auth/devices", requireAccountAdministrator, asyncHandler(async (request, response) => {
        const database = getPool();
        const [devicesResult, seatsResult] = await Promise.all([
            database.query(`
            SELECT device.id, device.label, device.device_type AS "deviceType", device.status, device.created_at AS "createdAt", device.last_seen_at AS "lastSeenAt",
                account.id AS "userId", account.full_name AS "fullName", account.username, account.email, account.role AS "userRole",
                account.can_create_billing AS "canCreateBilling", account.can_access_billing AS "canAccessBilling",
                account.can_access_accounting AS "canAccessAccounting", account.can_access_company_email AS "canAccessCompanyEmail",
                account.can_switch_group_companies AS "canSwitchGroupCompanies"
            FROM depannhome_auth_devices device JOIN depannhome_users account ON account.id = device.user_id
            WHERE account.account_owner_id = $1
            ORDER BY CASE device.status WHEN 'approval_pending' THEN 0 WHEN 'code_pending' THEN 1 ELSE 2 END, device.created_at DESC
            `, [getAccountOwnerId(request)]),
            database.query(`
                SELECT owner.max_pc_users AS "maxPcUsers",owner.max_technicians AS "maxMobileUsers",
                    COUNT(DISTINCT account.id) FILTER (WHERE account.is_active AND account.role IN ('admin','pc_standard','commercial','accountant'))::int AS "activePcUsers",
                    COUNT(DISTINCT mobile_member.id) FILTER (WHERE mobile_member.is_active)::int
                        + COUNT(DISTINCT cross_device_mobile.id) FILTER (WHERE cross_device_mobile.status='approved')::int AS "activeMobileUsers"
                FROM depannhome_users owner
                LEFT JOIN depannhome_users account ON account.account_owner_id = owner.id
                LEFT JOIN depannhome_users mobile_member ON mobile_member.account_owner_id=owner.id AND mobile_member.role IN ('mobile_admin','team_lead','technician')
                LEFT JOIN depannhome_users cross_device_account ON cross_device_account.account_owner_id=owner.id AND cross_device_account.role IN ('admin','commercial') AND cross_device_account.is_active
                LEFT JOIN depannhome_auth_devices cross_device_mobile ON cross_device_mobile.user_id=cross_device_account.id AND cross_device_mobile.device_type='mobile'
                WHERE owner.id = $1 GROUP BY owner.id
            `, [getAccountOwnerId(request)])
        ]);
        response.json({ devices: devicesResult.rows, pcSeats: seatsResult.rows[0] || { maxPcUsers: 1, activePcUsers: 0, maxMobileUsers: 0, activeMobileUsers: 0 } });
    }));

    app.post("/api/auth/devices/:deviceId/approve", requireAccountAdministrator, asyncHandler(async (request, response) => {
        const deviceId = validDeviceId(request.params.deviceId);
        if (!deviceId) return response.status(400).json({ message: "Appareil invalide." });
        const { rows } = await getPool().query(`
            SELECT device.id, device.device_type AS "deviceType", account.role, account.full_name, account.email
            FROM depannhome_auth_devices device JOIN depannhome_users account ON account.id = device.user_id
            WHERE device.id = $1 AND account.account_owner_id = $2
        `, [deviceId, getAccountOwnerId(request)]);
        const device = rows[0];
        if (!device) return response.status(404).json({ message: "Appareil introuvable." });
        if (["admin", STANDARD_PC_ROLE, COMMERCIAL_ROLE].includes(device.role)) {
            if (device.deviceType === "mobile") {
                const seatError = await mobileAdministratorSeatError(getAccountOwnerId(request), deviceId);
                if (seatError) return response.status(400).json({ message: seatError });
                if (device.role === "admin") {
                    await getPool().query("UPDATE depannhome_auth_devices SET status = 'approved', approved_at = NOW(), approved_by = $2 WHERE id = $1", [deviceId, request.user.sub]);
                    return response.status(204).end();
                }
            }
            if (device.deviceType === "desktop") {
                const seats = await getPool().query(`
                SELECT owner.max_pc_users, COUNT(auth_device.id) FILTER (WHERE auth_device.status = 'approved' AND auth_device.device_type = 'desktop')::int AS approved_devices
                FROM depannhome_users owner
                LEFT JOIN depannhome_users account ON account.account_owner_id = owner.id AND account.role IN ('admin', 'pc_standard', 'commercial')
                LEFT JOIN depannhome_auth_devices auth_device ON auth_device.user_id = account.id
                WHERE owner.id = $1 GROUP BY owner.id
            `, [getAccountOwnerId(request)]);
                if (seats.rows[0]?.approved_devices >= seats.rows[0]?.max_pc_users) return response.status(400).json({ message: "Aucun poste administratif supplémentaire n’est inclus dans votre offre. Contactez Depann’Home Pro pour activer un poste administratif." });
                await getPool().query("UPDATE depannhome_auth_devices SET status = 'approved', approved_at = NOW(), approved_by = $2 WHERE id = $1", [deviceId, request.user.sub]);
                return response.status(204).end();
            }
        }
        if (!EMAIL_PATTERN.test(device.email || "")) return response.status(400).json({ message: "L’e-mail professionnel de ce technicien est invalide." });
        const code = String(crypto.randomInt(100000, 1000000));
        try {
            await sendDeviceVerificationCode({ recipient: device.email, name: device.full_name, code });
        } catch (error) {
            return response.status(error.code === "SMTP_NOT_CONFIGURED" ? 503 : 502).json({ message: error.code === "SMTP_NOT_CONFIGURED" ? "L’envoi des codes Brevo SMTP n’est pas encore configuré." : "L’e-mail de validation n’a pas pu être envoyé." });
        }
        await getPool().query(`
            UPDATE depannhome_auth_devices
            SET status = 'code_pending', verification_code_hash = $2,
                verification_code_expires_at = NOW() + INTERVAL '10 minutes', verification_attempts = 0,
                approved_at = NOW(), approved_by = $3
            WHERE id = $1
        `, [deviceId, await bcrypt.hash(code, 12), request.user.sub]);
        response.status(204).end();
    }));

    app.post("/api/auth/devices/:deviceId/reject", requireAccountAdministrator, asyncHandler(async (request, response) => {
        const deviceId = validDeviceId(request.params.deviceId);
        if (!deviceId) return response.status(400).json({ message: "Appareil invalide." });
        const result = await getPool().query(`
            UPDATE depannhome_auth_devices device SET status = 'rejected', verification_code_hash = '', verification_code_expires_at = NULL
            WHERE device.id = $1 AND EXISTS (SELECT 1 FROM depannhome_users account WHERE account.id = device.user_id AND account.account_owner_id = $2)
        `, [deviceId, getAccountOwnerId(request)]);
        if (!result.rowCount) return response.status(404).json({ message: "Appareil introuvable." });
        response.status(204).end();
    }));

    app.delete("/api/auth/devices/:deviceId", requireAccountAdministrator, asyncHandler(async (request, response) => {
        const deviceId = validDeviceId(request.params.deviceId);
        if (!deviceId) return response.status(400).json({ message: "Appareil invalide." });
        if (deviceId === request.user.deviceId) return response.status(400).json({ message: "Vous ne pouvez pas supprimer l’appareil utilisé pour cette session." });
        const result = await getPool().query(`
            DELETE FROM depannhome_auth_devices device
            USING depannhome_users account
            WHERE device.id = $1 AND account.id = device.user_id AND account.account_owner_id = $2
        `, [deviceId, getAccountOwnerId(request)]);
        if (!result.rowCount) return response.status(404).json({ message: "Appareil introuvable." });
        response.status(204).end();
    }));
}

export function validateAuthenticationConfiguration() {
    getSessionSecret();
}

export async function authenticateRequest(request, response, next) {
    const token = request.cookies?.[COOKIE_NAME];
    if (!token) return next();

    try {
        const session = jwt.verify(token, getSessionSecret());
        const user = await findUserById(session.sub);
        const device = user && await findAuthDevice(user.id, session.deviceId);
        if (!user?.is_active || !user.account_is_active || device?.status !== "approved") throw new Error("Session inactive");
        const currentDevice = requestDeviceIdentity(request);
        if (currentDevice && (currentDevice.id !== device.id || currentDevice.type !== device.device_type)) {
            throw new Error("Identité appareil modifiée");
        }
        if (user.role === "admin" && device.device_type === "desktop" && (!session.sessionId || session.sessionId !== device.session_id)) {
            throw new Error("Session PC remplacée");
        }
        if (user.role === "admin" && device.device_type === "desktop" && requiresClientWindowProof(request)
            && session.sessionId !== clientWindowSessionId(request)) {
            throw new Error("Fenêtre PC remplacée");
        }
        const groupCompany = device.device_type === "desktop" ? await resolveGroupCompany(user.id, session.activeCompanyId) : null;
        const accountOwnerId = String(groupCompany?.companyId || user.account_owner_id || user.id);
        const activeCompanyName = groupCompany?.companyName || await resolveCompanyName(accountOwnerId);
        const organization = await getOrganization(accountOwnerId);
        if (!isCreatorUsername(user.username) && !isRoleAllowedForSubscription(organization.subscriptionTier, user.role)) throw new Error("Rôle exclu de l’offre");
        request.user = {
            sub: String(user.id),
            username: user.username,
            role: user.role,
            principalRole: groupCompany?.isGroupAdministrator ? "group_admin" : user.role,
            accountOwnerId,
            activeCompanyId: accountOwnerId,
            groupId: groupCompany ? String(groupCompany.groupId) : "",
            groupName: groupCompany?.groupName || "",
            activeCompanyName,
            isGroupAdministrator: Boolean(groupCompany?.isGroupAdministrator),
            fullName: user.full_name || "",
            phone: user.phone || "",
            email: user.email || "",
            department: user.department || "",
            departments: cleanDepartments(user.departments, user.department),
            technicianBillingEnabled: user.can_create_billing !== false,
            canAccessBilling: device.device_type !== "mobile" && (user.role === "admin" || user.can_access_billing === true),
            canAccessAccounting: device.device_type !== "mobile" && (user.role === "admin" || user.can_access_accounting === true),
            canAccessCompanyEmail: hasCompanyEmailWorkspaceAccess({ ...user, organization, deviceType: device.device_type }),
            canSwitchGroupCompanies: Boolean(groupCompany) && (user.role === "admin" || user.can_switch_group_companies === true),
            maxPcUsers: Number(user.max_pc_users) || 1,
            maxMobileUsers: Number(user.max_technicians) || 0,
            monthlyPriceCents: Number(user.monthly_price_cents) || 0,
            deviceId: device.id,
            deviceType: device.device_type || "desktop",
            organization,
            isCreator: isCreatorUsername(user.username)
        };
    } catch (error) {
        if (["Session PC remplacée", "Fenêtre PC remplacée"].includes(error.message)) request.sessionWindowReplaced = true;
        if (error.message === "Identité appareil modifiée") request.deviceIdentityChanged = true;
        if (error.message !== "Fenêtre PC remplacée") response.clearCookie(COOKIE_NAME, cookieOptions());
    }

    return next();
}

export function requireAuthentication(request, response, next) {
    if (!request.user) {
        if (request.sessionWindowReplaced) response.set("X-DepannHome-Session-Replaced", "true");
        return response.status(401).json({ message: request.sessionWindowReplaced ? "Cette session Poste Admin a été remplacée par une connexion plus récente." : "Connexion requise.", sessionReplaced: Boolean(request.sessionWindowReplaced) });
    }

    return next();
}

export function restrictCommercialMobileAccess(request, response, next) {
    if (request.user?.role !== COMMERCIAL_ROLE || request.user?.deviceType !== "mobile" || !String(request.path || "").startsWith("/api/")) return next();
    const allowed = (request.method === "GET" && ["/api/auth/session", "/api/calendar/events", "/api/creator/platform-announcement/current"].includes(request.path))
        || (request.method === "POST" && request.path === "/api/auth/logout");
    return allowed ? next() : response.status(403).json({ message: "Sur mobile, le Commercial / Chargé d’affaires consulte uniquement ses rendez-vous affectés dans le planning." });
}

export function getAccountOwnerId(request) {
    return String(request.user?.accountOwnerId || request.user?.sub || "");
}

export function isCompanyAdministrator(request) {
    return request.user?.role === "admin";
}

export async function refreshSessionForActiveCompany(response, user, deviceId, activeCompanyId) {
    const device = await findAuthDevice(user.id, deviceId);
    setSessionCookie(response, user, deviceId, device?.device_type || "desktop", activeCompanyId, device?.session_id || "");
}

export function requireCreator(request, response, next) {
    if (!request.user?.isCreator) return response.status(403).json({ message: "Accès réservé au Créateur de l’application." });
    if (request.user.deviceType !== "desktop") return response.status(403).json({ message: "La console Créateur est accessible uniquement depuis un poste administratif." });
    return next();
}

export function isCreatorUsername(username) {
    return getCreatorUsernames().has(normalizeUsername(username));
}

function requireAccountAdministrator(request, response, next) {
    if (!isCompanyAdministrator(request)) {
        return response.status(403).json({ message: "Accès réservé à l’administrateur du compte." });
    }
    return next();
}

function requireWorkstationSecurityAccess(request, response, next) {
    if (request.user?.deviceType === "desktop" && WORKSTATION_TOTP_ROLES.has(request.user?.role)) return next();
    return response.status(403).json({ message: "La sécurité personnelle est accessible uniquement depuis votre poste PC administratif ou commercial." });
}

async function ensureActiveAdministratorRemains(ownerId, targetId) {
    const { rows } = await getPool().query(`
        SELECT COUNT(*) FILTER (WHERE role = 'admin' AND is_active AND id <> $2)::int AS "remainingAdministrators"
        FROM depannhome_users
        WHERE account_owner_id = $1
    `, [ownerId, targetId]);
    if (!rows[0]?.remainingAdministrators) {
        throw clientError(409, "Cette opération est refusée : chaque entreprise doit conserver au moins un Poste Admin actif.");
    }
}

async function recordMemberAudit(ownerId, actorId, member, action, details = {}, database = getPool()) {
    const targetUserId = action.endsWith("_deleted") ? null : member?.id || null;
    await database.query(`
        INSERT INTO depannhome_member_audit (owner_id, actor_id, target_user_id, target_username, target_full_name, action, details)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
    `, [ownerId, actorId || null, targetUserId, cleanText(member?.username, 32), cleanText(member?.fullName || member?.full_name, 100), action, JSON.stringify(details)]);
}

function requireTechnicianDirectoryAccess(request, response, next) {
    if (request.user?.role === MOBILE_ADMIN_ROLE) return next();
    return requireAccountAdministrator(request, response, next);
}

function requireCalendarMemberDirectoryAccess(request, response, next) {
    if (["admin", STANDARD_PC_ROLE, COMMERCIAL_ROLE, MOBILE_ADMIN_ROLE, TEAM_LEAD_ROLE].includes(request.user?.role)) return next();
    return response.status(403).json({ message: "L’annuaire du planning n’est pas accessible." });
}

export async function createInitialAdministrator() {
    const username = normalizeUsername(process.env.INITIAL_ADMIN_USERNAME);
    const password = String(process.env.INITIAL_ADMIN_PASSWORD || "");

    if (!username && !password) return;

    const validationError = validateCredentials(username, password);
    if (validationError) {
        throw new Error(`Administrateur initial invalide : ${validationError}`);
    }

    const existingUser = await findUserByUsername(username);
    if (existingUser) return;

    const passwordHash = await bcrypt.hash(password, 12);
    await createUser({ username, passwordHash, role: "admin" });
    console.log(`Administrateur initial « ${username} » créé.`);
}

export async function recoverCreatorPassword() {
    const username = normalizeUsername(process.env.CREATOR_PASSWORD_RECOVERY_USERNAME);
    const password = String(process.env.CREATOR_PASSWORD_RECOVERY_PASSWORD || "");
    const confirmation = String(process.env.CREATOR_PASSWORD_RECOVERY_CONFIRM || "");
    const configured = username || password || confirmation;
    if (!configured) return;
    if (confirmation !== "RESET_CREATOR_PASSWORD") {
        throw new Error("Réinitialisation Créateur refusée : définissez CREATOR_PASSWORD_RECOVERY_CONFIRM sur RESET_CREATOR_PASSWORD.");
    }
    if (!isCreatorUsername(username)) {
        throw new Error("Réinitialisation Créateur refusée : l’identifiant ciblé doit être présent dans CREATOR_USERNAMES.");
    }
    const validationError = validateCredentials(username, password);
    if (validationError) throw new Error(`Réinitialisation Créateur invalide : ${validationError}`);

    const result = await getPool().query(`
        UPDATE depannhome_users
        SET password_hash = $2, is_active = TRUE, updated_at = NOW()
        WHERE username = $1
        RETURNING id
    `, [username, await bcrypt.hash(password, 12)]);
    if (!result.rowCount) throw new Error("Réinitialisation Créateur impossible : aucun compte correspondant à cet identifiant.");
    const recoveredUser = await findUserByUsername(username);
    if (!recoveredUser || !await bcrypt.compare(password, recoveredUser.password_hash)) {
        throw new Error("Réinitialisation Créateur impossible : la vérification du nouveau mot de passe a échoué.");
    }
    await getPool().query("UPDATE depannhome_users SET is_active = TRUE, updated_at = NOW() WHERE id = $1", [recoveredUser.account_owner_id]);
    console.log(`Mot de passe Créateur réinitialisé et vérifié pour « ${username} ». Retirez immédiatement les variables CREATOR_PASSWORD_RECOVERY_* après connexion.`);
}

export async function recoverCreatorTotp() {
    const username = normalizeUsername(process.env.CREATOR_TOTP_RECOVERY_USERNAME);
    const confirmation = String(process.env.CREATOR_TOTP_RECOVERY_CONFIRM || "");
    if (!username && !confirmation) return;
    if (confirmation !== "RESET_CREATOR_TOTP" || !isCreatorUsername(username)) {
        throw new Error("Réinitialisation Google Authenticator refusée : vérifiez CREATOR_TOTP_RECOVERY_USERNAME, CREATOR_TOTP_RECOVERY_CONFIRM et CREATOR_USERNAMES.");
    }
    const result = await getPool().query(`
        DELETE FROM depannhome_creator_totp
        WHERE user_id = (SELECT id FROM depannhome_users WHERE username = $1)
    `, [username]);
    console.log(`Google Authenticator réinitialisé pour « ${username} » (${result.rowCount ? "configuration supprimée" : "aucune configuration active"}). Retirez immédiatement les variables CREATOR_TOTP_RECOVERY_* après redémarrage.`);
}

async function completeLogin(user, device, response, request) {
    const organization = await getOrganization(user.account_owner_id || user.id);
    const roleAccessError = subscriptionRoleAccessMessage(organization.subscriptionTier, user.role);
    if (!isCreatorUsername(user.username) && roleAccessError) return response.status(403).json({ message: roleAccessError });
    const isDedicatedMobileAdministrator = user.role === MOBILE_ADMIN_ROLE;
    const isDedicatedMobileRole = [MOBILE_ADMIN_ROLE, TEAM_LEAD_ROLE, "technician"].includes(user.role);
    if (isDedicatedMobileRole && device.type !== "mobile") {
        return response.status(403).json({ message: "Ce poste mobile doit être activé depuis un téléphone ou une tablette." });
    }
    if ([STANDARD_PC_ROLE, "accountant"].includes(user.role) && device.type !== "desktop") {
        return response.status(403).json({ message: "Ce poste doit être activé depuis un ordinateur." });
    }
    const isCrossDeviceMobile = ["admin", COMMERCIAL_ROLE].includes(user.role) && device.type === "mobile";
    const isMobileAdministrator = isCrossDeviceMobile || isDedicatedMobileAdministrator;
    const isCompanyAdministratorPc = user.role === "admin" && device.type === "desktop";
    const isAccountant = user.role === "accountant";
    const authDeviceDetails = { ...device };
    // Un nouveau navigateur privé possède un identifiant local distinct. Il ne
    // doit donc jamais remplacer ni approuver automatiquement un poste administratif déjà
    // comptabilisé d’un autre utilisateur. Pour un même administrateur, une
    // nouvelle connexion administrative remplace toutefois son ancienne session administrative afin
    // qu’il ne puisse jamais conserver deux sessions simultanées.
    const automaticallyApproved = isAccountant;
    let authDevice = await findAuthDevice(user.id, device.id);
    if (isCrossDeviceMobile && authDevice?.status !== "approved") {
        const seatError = await mobileAdministratorSeatError(user.account_owner_id || user.id, authDevice?.id || device.id);
        if (seatError) return response.status(400).json({ message: seatError });
    }
    if (isCompanyAdministratorPc && authDevice?.status !== "approved" && await userHasApprovedDesktopDevice(user.id)) {
        authDevice = await replaceAdministratorDesktopDevice(user.id, authDevice?.id || device.id, authDeviceDetails);
    }
    if (!authDevice) {
        if (isMobileAdministrator && await userHasActiveMobileDevice(user.id)) {
            return response.status(409).json({ message: "Un téléphone ou une tablette est déjà associé à ce compte administrateur. Supprimez d’abord l’ancien appareil dans Équipe." });
        }
        if (automaticallyApproved || (user.role === "admin" && String(user.account_owner_id) === String(user.id) && !await userHasApprovedDevice(user.id))) {
            authDevice = await createAuthDevice(user.id, authDeviceDetails, "approved");
        } else {
            authDevice = await createAuthDevice(user.id, authDeviceDetails, "approval_pending");
        }
        if (!authDevice) {
            return response.status(409).json({ message: isMobileAdministrator ? `Un téléphone ou une tablette est déjà associé à ce ${isDedicatedMobileAdministrator ? "Poste Admin Mobile" : "compte administrateur"}. Supprimez d’abord l’ancien appareil dans Équipe.` : "Cet appareil est déjà associé à un autre compte. Utilisez un autre navigateur ou contactez l’administrateur." });
        }
    } else {
        if (isMobileAdministrator && authDevice.device_type !== "mobile" && await userHasActiveMobileDevice(user.id)) {
            return response.status(409).json({ message: "Un téléphone ou une tablette est déjà associé à ce compte administrateur. Supprimez d’abord l’ancien appareil dans Équipe." });
        }
        const { rows } = await getPool().query(`
            UPDATE depannhome_auth_devices
            SET label = $2, device_type = $3, last_seen_at = NOW(),
                status = CASE WHEN $4 THEN 'approved' ELSE status END,
                approved_at = CASE WHEN $4 AND approved_at IS NULL THEN NOW() ELSE approved_at END,
                verification_code_hash = CASE WHEN $4 THEN '' ELSE verification_code_hash END,
                verification_code_expires_at = CASE WHEN $4 THEN NULL ELSE verification_code_expires_at END,
                verification_attempts = CASE WHEN $4 THEN 0 ELSE verification_attempts END
            WHERE id = $1
            RETURNING *
        `, [authDevice.id, device.label, authDeviceDetails.type, automaticallyApproved]);
        authDevice = rows[0];
    }
    if (authDevice.status === "approved") {
        const groupCompany = authDevice.device_type === "desktop" ? await resolveGroupCompany(user.id, null) : null;
        const accountOwnerId = String(groupCompany?.companyId || user.account_owner_id || user.id);
        const activeCompanyName = groupCompany?.companyName || await resolveCompanyName(accountOwnerId);
        const organization = await getOrganization(accountOwnerId);
        const sessionId = isCompanyAdministratorPc ? await issueAdministratorPcSession(user.id, authDevice.id, clientWindowSessionId(request)) : "";
        setSessionCookie(response, user, authDevice.id, authDevice.device_type, groupCompany?.companyId, sessionId);
        return response.json({ user: publicUser({ ...user, accountOwnerId, activeCompanyId: accountOwnerId, groupId: groupCompany?.groupId, groupName: groupCompany?.groupName, activeCompanyName, isGroupAdministrator: Boolean(groupCompany?.isGroupAdministrator), role: user.role, principalRole: groupCompany?.isGroupAdministrator ? "group_admin" : user.role, deviceType: authDevice.device_type, organization }) });
    }
    if (authDevice.status === "code_pending") {
        return response.status(403).json({ codeRequired: true, deviceId: authDevice.id, message: "Saisissez le code envoyé à votre e-mail professionnel." });
    }
    return response.status(403).json({ approvalRequired: true, deviceId: authDevice.id, message: authDevice.status === "rejected" ? "Cet appareil a été refusé par l’administrateur." : "Cet appareil est en attente de validation par l’administrateur." });
}

async function isCreatorTotpEnabled(userId) {
    const { rows } = await getPool().query(
        "SELECT enabled, secret_ciphertext AS \"secretCiphertext\" FROM depannhome_creator_totp WHERE user_id = $1",
        [userId]
    );
    return Boolean(rows[0]?.enabled && rows[0]?.secretCiphertext);
}

async function getCreatorTotpSecret(userId) {
    const { rows } = await getPool().query(`
        SELECT secret_ciphertext AS "secretCiphertext" FROM depannhome_creator_totp
        WHERE user_id = $1 AND enabled = TRUE
    `, [userId]);
    return rows[0]?.secretCiphertext ? decryptCreatorTotpSecret(rows[0].secretCiphertext) : "";
}

async function getCompanyTotpAuthenticator(userId, status) {
    const { rows } = await getPool().query(`
        SELECT id, secret_ciphertext, status
        FROM depannhome_company_totp_authenticators
        WHERE user_id = $1 AND status = $2
            AND (status <> 'pending' OR pending_expires_at > NOW())
        ORDER BY confirmed_at DESC NULLS LAST, updated_at DESC
        LIMIT 1
    `, [userId, status]);
    return rows[0] || null;
}

async function hasCompanyTotpAuthenticator(userId) {
    return Boolean(await getCompanyTotpAuthenticator(userId, "active"));
}

async function createCompanyTotpChallenge(user, device, purpose) {
    const id = crypto.randomUUID();
    await getPool().query("DELETE FROM depannhome_company_totp_challenges WHERE user_id = $1 AND (expires_at <= NOW() OR consumed_at IS NOT NULL)", [user.id]);
    await getPool().query(`
        INSERT INTO depannhome_company_totp_challenges (id, owner_id, user_id, purpose, device, expires_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, NOW() + INTERVAL '5 minutes')
    `, [id, user.account_owner_id, user.id, purpose, JSON.stringify(device)]);
    return jwt.sign(
        { purpose: "company-totp", challengeId: id, sub: String(user.id), device },
        getSessionSecret(),
        { expiresIn: COMPANY_TOTP_CHALLENGE_DURATION_SECONDS }
    );
}

async function getCompanyTotpChallenge(value, expectedPurpose = "") {
    try {
        const token = jwt.verify(String(value || ""), getSessionSecret());
        if (token?.purpose !== "company-totp" || !validDeviceId(token.device?.id) || !token.challengeId || (expectedPurpose && !["login", "enrollment"].includes(expectedPurpose))) return null;
        const { rows } = await getPool().query(`
            SELECT id, owner_id, user_id, purpose, device, attempts
            FROM depannhome_company_totp_challenges
            WHERE id = $1 AND user_id = $2 AND expires_at > NOW() AND consumed_at IS NULL AND attempts < $3
                ${expectedPurpose ? "AND purpose = $4" : ""}
        `, expectedPurpose
            ? [token.challengeId, token.sub, COMPANY_TOTP_MAX_ATTEMPTS, expectedPurpose]
            : [token.challengeId, token.sub, COMPANY_TOTP_MAX_ATTEMPTS]);
        return rows[0] || null;
    } catch {
        return null;
    }
}

async function recordCompanyTotpFailure(challenge, user) {
    const { rows } = await getPool().query(`
        UPDATE depannhome_company_totp_challenges
        SET attempts = attempts + 1
        WHERE id = $1 AND consumed_at IS NULL
        RETURNING attempts
    `, [challenge.id]);
    const attempts = Number(rows[0]?.attempts || COMPANY_TOTP_MAX_ATTEMPTS);
    await recordMemberAudit(user.account_owner_id, null, user, "workstation_2fa_validation_failed", { purpose: challenge.purpose, deviceType: "desktop", attempts });
    return attempts;
}

async function createCreatorTotpChallenge(user, device) {
    const id = crypto.randomUUID();
    await getPool().query("DELETE FROM depannhome_creator_totp_challenges WHERE user_id=$1 AND (expires_at<=NOW() OR consumed_at IS NOT NULL)", [user.id]);
    await getPool().query("INSERT INTO depannhome_creator_totp_challenges(id,user_id,device,expires_at) VALUES($1,$2,$3::jsonb,NOW()+($4::text||' seconds')::interval)", [id, user.id, JSON.stringify(device), String(CREATOR_TOTP_CHALLENGE_DURATION_SECONDS)]);
    return jwt.sign(
        { purpose: "creator-totp", challengeId: id, sub: String(user.id), device },
        getSessionSecret(),
        { expiresIn: CREATOR_TOTP_CHALLENGE_DURATION_SECONDS }
    );
}

async function verifyCreatorTotpChallenge(value) {
    try {
        const token = jwt.verify(String(value || ""), getSessionSecret());
        if (token?.purpose !== "creator-totp" || !token.challengeId || !validDeviceId(token.device?.id)) return null;
        const { rows } = await getPool().query("SELECT id,user_id AS sub,device,attempts FROM depannhome_creator_totp_challenges WHERE id=$1 AND user_id=$2 AND expires_at>NOW() AND consumed_at IS NULL AND attempts<$3", [token.challengeId, token.sub, COMPANY_TOTP_MAX_ATTEMPTS]);
        return rows[0] || null;
    } catch {
        return null;
    }
}

async function recordCreatorTotpFailure(challengeId) {
    const { rows } = await getPool().query("UPDATE depannhome_creator_totp_challenges SET attempts=attempts+1 WHERE id=$1 AND consumed_at IS NULL RETURNING attempts", [challengeId]);
    return Number(rows[0]?.attempts || COMPANY_TOTP_MAX_ATTEMPTS);
}

function createTotp(secret, username) {
    return new OTPAuth.TOTP({
        issuer: "Depann'Home Pro",
        label: username,
        algorithm: "SHA1",
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(secret)
    });
}

function normalizeTotpCode(value) {
    const code = String(value || "").replace(/\s/g, "");
    return /^\d{6}$/.test(code) ? code : "";
}

function isValidTotpCode(secret, code, username) {
    try {
        return createTotp(secret, username).validate({ token: code, window: 1 }) !== null;
    } catch {
        return false;
    }
}

function encryptCreatorTotpSecret(secret) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", getCreatorTotpEncryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

function decryptCreatorTotpSecret(value) {
    try {
        const [ivValue, tagValue, encryptedValue] = String(value || "").split(".");
        if (!ivValue || !tagValue || !encryptedValue) return "";
        const decipher = crypto.createDecipheriv("aes-256-gcm", getCreatorTotpEncryptionKey(), Buffer.from(ivValue, "base64url"));
        decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
        return Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64url")), decipher.final()]).toString("utf8");
    } catch {
        return "";
    }
}

function encryptCompanyTotpSecret(secret) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", getCompanyTotpEncryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

function decryptCompanyTotpSecret(value) {
    try {
        const [ivValue, tagValue, encryptedValue] = String(value || "").split(".");
        if (!ivValue || !tagValue || !encryptedValue) return "";
        const decipher = crypto.createDecipheriv("aes-256-gcm", getCompanyTotpEncryptionKey(), Buffer.from(ivValue, "base64url"));
        decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
        return Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64url")), decipher.final()]).toString("utf8");
    } catch {
        return "";
    }
}

function getCreatorTotpEncryptionKey() {
    return crypto.createHash("sha256").update(`${getSessionSecret()}:creator-totp:v1`).digest();
}

function getCompanyTotpEncryptionKey() {
    return crypto.createHash("sha256").update(`${getSessionSecret()}:company-totp:v1`).digest();
}

async function issueAdministratorPcSession(userId, deviceId, clientSessionId = "") {
    const sessionId = clientSessionId || crypto.randomUUID();
    const { rows } = await getPool().query(`
        UPDATE depannhome_auth_devices
        SET session_id = $3, last_seen_at = NOW()
        WHERE id = $1 AND user_id = $2 AND device_type = 'desktop' AND status = 'approved'
        RETURNING session_id
    `, [deviceId, userId, sessionId]);
    if (!rows[0]?.session_id) throw new Error("Session Poste Admin introuvable.");
    return rows[0].session_id;
}

function clientWindowSessionId(request) {
    const value = String(request.get?.("X-DepannHome-Client-Session") || request.query?.clientSession || "");
    return DEVICE_ID_PATTERN.test(value) ? value : "";
}

function requestDeviceIdentity(request) {
    const id = validDeviceId(request.get?.("X-DepannHome-Device-Id"));
    const type = String(request.get?.("X-DepannHome-Device-Type") || "");
    return id && ["desktop", "mobile"].includes(type) ? { id, type } : null;
}

function requiresClientWindowProof(request) {
    if (!String(request.path || "").startsWith("/api/")) return false;
    const destination = String(request.get?.("Sec-Fetch-Dest") || "").toLowerCase();
    return !destination || destination === "empty";
}

export function sessionDurationForDevice(deviceType) {
    return deviceType === "mobile" ? MOBILE_SESSION_DURATION : ADMIN_SESSION_DURATION;
}

function setSessionCookie(response, user, deviceId, deviceType, activeCompanyId = "", sessionId = "") {
    const duration = sessionDurationForDevice(deviceType);
    const userId = user.id || user.user_id || user.sub;
    const token = jwt.sign(
        { sub: String(userId), username: user.username, role: user.role, accountOwnerId: String(user.account_owner_id || user.accountOwnerId || userId), activeCompanyId: String(activeCompanyId || ""), fullName: user.full_name || user.fullName || "", phone: user.phone || "", deviceId, sessionId },
        getSessionSecret(),
        { expiresIn: Math.floor(duration / 1000) }
    );

    response.cookie(COOKIE_NAME, token, {
        ...cookieOptions(),
        maxAge: duration
    });
}

function cookieOptions() {
    return {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/"
    };
}

function publicUser(user) {
    const id = user.id || user.user_id || user.sub;
    return {
        id: String(id),
        username: user.username,
        role: user.role,
        principalRole: user.principalRole || user.role,
        accountOwnerId: String(user.accountOwnerId || user.account_owner_id || id),
        activeCompanyId: String(user.activeCompanyId || user.accountOwnerId || user.account_owner_id || id),
        groupId: user.groupId ? String(user.groupId) : "",
        groupName: user.groupName || "",
        activeCompanyName: user.activeCompanyName || "",
        isGroupAdministrator: Boolean(user.isGroupAdministrator),
        fullName: user.full_name || user.fullName || "",
        phone: user.phone || "",
        email: user.email || "",
        department: user.department || "",
        departments: cleanDepartments(user.departments, user.department),
        technicianBillingEnabled: (user.can_create_billing ?? user.technicianBillingEnabled) !== false,
        canAccessBilling: (user.deviceType || user.device_type || "desktop") !== "mobile" && (user.role === "admin" || (user.can_access_billing ?? user.canAccessBilling) === true),
        canAccessAccounting: (user.deviceType || user.device_type || "desktop") !== "mobile" && (user.role === "admin" || (user.can_access_accounting ?? user.canAccessAccounting) === true),
        canAccessCompanyEmail: (user.can_access_company_email ?? user.canAccessCompanyEmail) === true || ["admin", "mobile_admin"].includes(user.role) && ["basic_plus", "pro"].includes(user.organization?.subscriptionTier || user.subscription_tier),
        canSwitchGroupCompanies: Boolean(user.groupId) && (user.role === "admin" || (user.can_switch_group_companies ?? user.canSwitchGroupCompanies) === true),
        maxPcUsers: Number(user.max_pc_users ?? user.maxPcUsers) || 1,
        maxMobileUsers: Number(user.max_technicians ?? user.maxMobileUsers) || 0,
        monthlyPriceCents: Number(user.monthly_price_cents ?? user.monthlyPriceCents) || 0,
        organization: user.organization || null,
        isActive: user.is_active !== false,
        isCreator: Boolean(user.isCreator || isCreatorUsername(user.username)),
        deviceType: user.deviceType || user.device_type || "desktop"
    };
}

function getDeviceDetails(body) {
    const id = validDeviceId(body?.deviceId);
    const type = body?.deviceType === "mobile" ? "mobile" : "desktop";
    return id ? { id, label: cleanText(body?.deviceLabel, 100) || "Appareil non nommé", type } : null;
}

function validDeviceId(value) {
    const id = String(value || "");
    return DEVICE_ID_PATTERN.test(id) ? id : "";
}

async function findAuthDevice(userId, deviceId) {
    if (!validDeviceId(deviceId)) return null;
    const { rows } = await getPool().query("SELECT * FROM depannhome_auth_devices WHERE user_id = $1 AND id = $2", [userId, deviceId]);
    return rows[0] || null;
}

async function userHasApprovedDevice(userId) {
    const { rows } = await getPool().query("SELECT EXISTS(SELECT 1 FROM depannhome_auth_devices WHERE user_id = $1 AND status = 'approved') AS has_device", [userId]);
    return rows[0]?.has_device;
}

async function userHasApprovedDesktopDevice(userId) {
    const { rows } = await getPool().query("SELECT EXISTS(SELECT 1 FROM depannhome_auth_devices WHERE user_id=$1 AND device_type='desktop' AND status='approved') AS has_device", [userId]);
    return rows[0]?.has_device;
}

async function replaceAdministratorDesktopDevice(userId, deviceId, device) {
    const database = getPool();
    const connection = await database.connect();
    try {
        await connection.query("BEGIN");
        await connection.query(`
            UPDATE depannhome_auth_devices
            SET status='rejected', session_id=NULL, verification_code_hash='', verification_code_expires_at=NULL
            WHERE user_id=$1 AND device_type='desktop' AND status='approved' AND id<>$2
        `, [userId, deviceId]);
        const { rows } = await connection.query(`
            INSERT INTO depannhome_auth_devices (id,user_id,label,device_type,status,approved_at,last_seen_at)
            VALUES($1,$2,$3,'desktop','approved',NOW(),NOW())
            ON CONFLICT(id) DO UPDATE SET user_id=EXCLUDED.user_id,label=EXCLUDED.label,device_type='desktop',status='approved',approved_at=NOW(),last_seen_at=NOW(),session_id=NULL,verification_code_hash='',verification_code_expires_at=NULL,verification_attempts=0
            WHERE depannhome_auth_devices.user_id=EXCLUDED.user_id
            RETURNING *
        `, [deviceId, userId, device.label]);
        if (!rows[0]) throw new Error("Cet appareil est déjà associé à un autre compte.");
        await connection.query("COMMIT");
        return rows[0];
    } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
    } finally {
        connection.release();
    }
}

async function userHasActiveMobileDevice(userId) {
    const { rows } = await getPool().query(`
        SELECT EXISTS(
            SELECT 1 FROM depannhome_auth_devices
            WHERE user_id = $1 AND device_type = 'mobile' AND status <> 'rejected'
        ) AS has_device
    `, [userId]);
    return rows[0]?.has_device;
}

async function createAuthDevice(userId, device, status) {
    try {
        const { rows } = await getPool().query(`
            INSERT INTO depannhome_auth_devices (id, user_id, label, device_type, status, approved_at)
            VALUES ($1, $2, $3, $4, $5::text, CASE WHEN $5::text = 'approved' THEN NOW() ELSE NULL END)
            ON CONFLICT (id) DO UPDATE
            SET label = EXCLUDED.label, device_type = EXCLUDED.device_type, last_seen_at = NOW()
            WHERE depannhome_auth_devices.user_id = EXCLUDED.user_id
            RETURNING *
        `, [device.id, userId, device.label, device.type, status]);
        return rows[0];
    } catch (error) {
        if (error.code === "23505" && error.constraint === "depannhome_auth_devices_one_active_mobile_per_user_idx") return null;
        throw error;
    }
}

function normalizeUsername(value) {
    return String(value || "").trim().toLowerCase();
}

function cleanText(value, maximumLength) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximumLength);
}

function cleanDepartments(value, legacyValue = "") {
    const source = Array.isArray(value) ? value : String(value || legacyValue || "").split(",");
    return [...new Set(source.map(item => cleanText(item, 80)).filter(Boolean))].slice(0, 12);
}

function positiveId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function clientError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function validateCredentials(username, password) {
    if (!USERNAME_PATTERN.test(username || "")) {
        return "Le nom d’utilisateur doit contenir de 3 à 32 caractères : lettres minuscules, chiffres, point, tiret ou souligné.";
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
        return `Le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères.`;
    }

    return "";
}

function isPublicRegistrationEnabled() {
    return process.env.ALLOW_PUBLIC_REGISTRATION === "true";
}

function getCreatorUsernames() {
    return new Set(String(process.env.CREATOR_USERNAMES || "")
        .split(",")
        .map(normalizeUsername)
        .filter(Boolean));
}

function getSessionSecret() {
    const secret = process.env.SESSION_SECRET;
    if (!secret || secret.length < 32) {
        throw new Error("SESSION_SECRET doit contenir au moins 32 caractères.");
    }
    return secret;
}

function asyncHandler(handler) {
    return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(error => error.status ? response.status(error.status).json({ message: error.message }) : next(error));
}
