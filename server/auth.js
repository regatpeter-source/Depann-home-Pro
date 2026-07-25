import bcrypt from "bcrypt";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { createUser, findUserById, findUserByUsername, getPool } from "./database.js";
import { sendDeviceVerificationCode } from "./email.js";

const COOKIE_NAME = "depann_home_session";
const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;
const MIN_PASSWORD_LENGTH = 12;
const ADMIN_SESSION_DURATION = 12 * 60 * 60 * 1000;
const TECHNICIAN_SESSION_DURATION = 30 * 24 * 60 * 60 * 1000;
const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function registerAuthRoutes(app) {
    app.get("/api/auth/session", (request, response) => {
        const user = request.user;
        if (!user) {
            return response.status(401).json({
                authenticated: false,
                registrationEnabled: isPublicRegistrationEnabled()
            });
        }

        return response.json({
            authenticated: true,
            registrationEnabled: isPublicRegistrationEnabled(),
            user: publicUser(user)
        });
    });

    app.post("/api/auth/login", asyncHandler(async (request, response) => {
        const username = normalizeUsername(request.body?.username);
        const password = String(request.body?.password || "");
        const device = getDeviceDetails(request.body);
        if (!device) return response.status(400).json({ message: "Cet appareil ne peut pas être identifié. Actualisez l’application puis réessayez." });
        const user = username ? await findUserByUsername(username) : null;
        const passwordMatches = user?.is_active && user?.account_is_active && await bcrypt.compare(password, user.password_hash);

        if (!passwordMatches) {
            return response.status(401).json({ message: "Identifiant ou mot de passe incorrect." });
        }

        const isCreator = isCreatorUsername(user.username);
        const isMobileAdministrator = user.role === "admin" && device.type === "mobile";
        const authDeviceDetails = { ...device, type: isMobileAdministrator ? "mobile" : "desktop" };
        let authDevice = await findAuthDevice(user.id, device.id);
        if (!authDevice) {
            if (isMobileAdministrator && await userHasActiveMobileDevice(user.id)) {
                return response.status(409).json({ message: "Un téléphone ou une tablette est déjà associé à ce compte administrateur. Supprimez d’abord l’ancien appareil dans Équipe." });
            }
            // Le Créateur et le premier poste administrateur permettent le démarrage des comptes déjà créés.
            if (isCreator || (user.role === "admin" && String(user.account_owner_id) === String(user.id) && !await userHasApprovedDevice(user.id))) {
                authDevice = await createAuthDevice(user.id, authDeviceDetails, "approved");
            } else {
                authDevice = await createAuthDevice(user.id, authDeviceDetails, "approval_pending");
            }
            if (!authDevice) {
                return response.status(409).json({ message: isMobileAdministrator ? "Un téléphone ou une tablette est déjà associé à ce compte administrateur. Supprimez d’abord l’ancien appareil dans Équipe." : "Cet appareil est déjà associé à un autre compte. Utilisez un autre navigateur ou contactez l’administrateur." });
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
            `, [authDevice.id, device.label, authDeviceDetails.type, isCreator]);
            authDevice = rows[0];
        }
        if (authDevice.status === "approved") {
            setSessionCookie(response, user, authDevice.id);
            return response.json({ user: publicUser(user) });
        }
        if (authDevice.status === "code_pending") {
            return response.status(403).json({ codeRequired: true, deviceId: authDevice.id, message: "Saisissez le code envoyé à votre e-mail professionnel." });
        }
        return response.status(403).json({ approvalRequired: true, deviceId: authDevice.id, message: authDevice.status === "rejected" ? "Cet appareil a été refusé par l’administrateur." : "Cet appareil est en attente de validation par l’administrateur." });
    }));

    app.post("/api/auth/verify-device-code", asyncHandler(async (request, response) => {
        const deviceId = validDeviceId(request.body?.deviceId);
        const code = String(request.body?.code || "").replace(/\s/g, "");
        if (!deviceId || !/^\d{6}$/.test(code)) return response.status(400).json({ message: "Code de validation invalide." });
        const { rows } = await getPool().query(`
            SELECT device.*, account.id AS user_id, account.username, account.role, account.account_owner_id, account.full_name, account.phone, account.email, account.is_active, owner.is_active AS account_is_active, owner.technician_billing_enabled, owner.max_pc_users
            FROM depannhome_auth_devices device JOIN depannhome_users account ON account.id = device.user_id JOIN depannhome_users owner ON owner.id = account.account_owner_id WHERE device.id = $1
        `, [deviceId]);
        const device = rows[0];
        if (!device || device.status !== "code_pending" || !device.is_active || !device.account_is_active) return response.status(403).json({ message: "Cette demande de validation n’est plus active." });
        if (!device.verification_code_expires_at || new Date(device.verification_code_expires_at) < new Date() || device.verification_attempts >= 5) return response.status(403).json({ message: "Le code a expiré. Demandez à l’administrateur de valider à nouveau cet appareil." });
        if (!await bcrypt.compare(code, device.verification_code_hash)) {
            await getPool().query("UPDATE depannhome_auth_devices SET verification_attempts = verification_attempts + 1 WHERE id = $1", [deviceId]);
            return response.status(401).json({ message: "Code incorrect." });
        }
        await getPool().query("UPDATE depannhome_auth_devices SET status = 'approved', verified_at = NOW(), verification_code_hash = '', verification_code_expires_at = NULL, verification_attempts = 0 WHERE id = $1", [deviceId]);
        setSessionCookie(response, device, deviceId);
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
            setSessionCookie(response, user, authDevice.id);
            return response.status(201).json({ user: publicUser(user) });
        } catch (error) {
            if (error.code === "23505") {
                return response.status(409).json({ message: "Ce nom d’utilisateur est déjà utilisé." });
            }
            throw error;
        }
    }));

    app.post("/api/auth/logout", (request, response) => {
        response.clearCookie(COOKIE_NAME, cookieOptions());
        response.status(204).end();
    });

    app.put("/api/auth/technician-billing", requireAccountAdministrator, asyncHandler(async (request, response) => {
        if (typeof request.body?.enabled !== "boolean") return response.status(400).json({ message: "Réglage d’autorisation invalide." });
        await getPool().query(
            "UPDATE depannhome_users SET technician_billing_enabled = $2, updated_at = NOW() WHERE id = $1",
            [getAccountOwnerId(request), request.body.enabled]
        );
        response.status(204).end();
    }));

    app.get("/api/auth/members", requireAccountAdministrator, asyncHandler(async (request, response) => {
        const { rows } = await getPool().query(`
            SELECT id, username, role, full_name AS "fullName", phone, email, is_active AS "isActive", created_at AS "createdAt"
            FROM depannhome_users
            WHERE account_owner_id = $1 AND id <> $1
            ORDER BY role, LOWER(full_name), username
        `, [getAccountOwnerId(request)]);
        response.json({ members: rows });
    }));

    app.post("/api/auth/members", requireAccountAdministrator, asyncHandler(async (request, response) => {
        const role = request.body?.role === "admin" || request.body?.role === "technician" ? request.body.role : "";
        const username = normalizeUsername(request.body?.username);
        const password = String(request.body?.password || "");
        const fullName = cleanText(request.body?.fullName, 100);
        const phone = cleanText(request.body?.phone, 30);
        const email = cleanText(request.body?.email, 160).toLowerCase();
        const validationError = validateCredentials(username, password)
            || (!role ? "Choisissez le type de poste." : "")
            || (!fullName ? "Le nom de l’utilisateur est obligatoire." : "")
            || (role === "technician" && !phone ? "Le téléphone du technicien est obligatoire." : "")
            || (role === "technician" && !EMAIL_PATTERN.test(email) ? "L’e-mail professionnel du technicien est obligatoire." : "");
        if (validationError) return response.status(400).json({ message: validationError });

        if (role === "technician") {
            const seats = await getPool().query(`
                SELECT owner.max_technicians, COUNT(member.id) FILTER (WHERE member.role = 'technician' AND member.is_active)::int AS active_technicians
                FROM depannhome_users owner
                LEFT JOIN depannhome_users member ON member.account_owner_id = owner.id
                WHERE owner.id = $1 GROUP BY owner.id
            `, [getAccountOwnerId(request)]);
            if (seats.rows[0]?.active_technicians >= seats.rows[0]?.max_technicians) {
                return response.status(400).json({ message: "La limite de techniciens de votre entreprise est atteinte." });
            }
        }
        try {
            const member = await createUser({ username, passwordHash: await bcrypt.hash(password, 12), role, accountOwnerId: getAccountOwnerId(request), fullName, phone, email });
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
            SELECT id, role, is_active AS "isActive" FROM depannhome_users
            WHERE id = $1 AND account_owner_id = $2 AND id <> $2
        `, [memberId, getAccountOwnerId(request)]);
        const member = rows[0];
        if (!member) return response.status(404).json({ message: "Accès introuvable." });
        const isActive = Boolean(request.body?.isActive);
        if (member.role === "technician" && isActive && !member.isActive) {
            const seats = await getPool().query(`
                SELECT owner.max_technicians, COUNT(member.id) FILTER (WHERE member.role = 'technician' AND member.is_active AND member.id <> $2)::int AS active_technicians
                FROM depannhome_users owner
                LEFT JOIN depannhome_users member ON member.account_owner_id = owner.id
                WHERE owner.id = $1 GROUP BY owner.id
            `, [getAccountOwnerId(request), memberId]);
            if (seats.rows[0]?.active_technicians >= seats.rows[0]?.max_technicians) {
                return response.status(400).json({ message: "La limite de techniciens de votre entreprise est atteinte." });
            }
        }
        await getPool().query("UPDATE depannhome_users SET is_active = $3, updated_at = NOW() WHERE id = $1 AND account_owner_id = $2", [memberId, getAccountOwnerId(request), isActive]);
        response.status(204).end();
    }));

    app.delete("/api/auth/members/:memberId", requireAccountAdministrator, asyncHandler(async (request, response) => {
        const memberId = positiveId(request.params.memberId);
        if (!memberId) return response.status(400).json({ message: "Accès invalide." });
        const result = await getPool().query("DELETE FROM depannhome_users WHERE id = $1 AND account_owner_id = $2 AND id <> $2", [memberId, getAccountOwnerId(request)]);
        if (!result.rowCount) return response.status(404).json({ message: "Accès introuvable." });
        response.status(204).end();
    }));

    app.get("/api/auth/technicians", requireAccountAdministrator, asyncHandler(async (request, response) => {
        const { rows } = await getPool().query(`
            SELECT id, username, full_name AS "fullName", phone, email, is_active AS "isActive", created_at AS "createdAt"
            FROM depannhome_users
            WHERE account_owner_id = $1 AND id <> $1 AND role = 'technician'
            ORDER BY LOWER(full_name), username
        `, [getAccountOwnerId(request)]);
        response.json({ technicians: rows });
    }));

    app.post("/api/auth/technicians", requireAccountAdministrator, asyncHandler(async (request, response) => {
        const username = normalizeUsername(request.body?.username);
        const password = String(request.body?.password || "");
        const fullName = cleanText(request.body?.fullName, 100);
        const phone = cleanText(request.body?.phone, 30);
        const email = cleanText(request.body?.email, 160).toLowerCase();
        const validationError = validateCredentials(username, password) || (!fullName ? "Le nom du technicien est obligatoire." : "") || (!phone ? "Le téléphone du technicien est obligatoire." : "") || (!EMAIL_PATTERN.test(email) ? "L’e-mail professionnel du technicien est obligatoire." : "");
        if (validationError) return response.status(400).json({ message: validationError });
        const seats = await getPool().query(`
            SELECT owner.max_technicians, COUNT(member.id) FILTER (WHERE member.role = 'technician' AND member.is_active)::int AS active_technicians
            FROM depannhome_users owner
            LEFT JOIN depannhome_users member ON member.account_owner_id = owner.id
            WHERE owner.id = $1 GROUP BY owner.id
        `, [getAccountOwnerId(request)]);
        if (seats.rows[0]?.active_technicians >= seats.rows[0]?.max_technicians) {
            return response.status(400).json({ message: "La limite de techniciens de votre entreprise est atteinte." });
        }
        try {
            const user = await createUser({ username, passwordHash: await bcrypt.hash(password, 12), role: "technician", accountOwnerId: getAccountOwnerId(request), fullName, phone, email });
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
        if (isActive) {
            const seats = await getPool().query(`
                SELECT owner.max_technicians,
                    COUNT(member.id) FILTER (WHERE member.role = 'technician' AND member.is_active AND member.id <> $2)::int AS active_technicians
                FROM depannhome_users owner
                LEFT JOIN depannhome_users member ON member.account_owner_id = owner.id
                WHERE owner.id = $1 GROUP BY owner.id
            `, [getAccountOwnerId(request), technicianId]);
            if (seats.rows[0]?.active_technicians >= seats.rows[0]?.max_technicians) {
                return response.status(400).json({ message: "La limite de techniciens de votre entreprise est atteinte." });
            }
        }
        const result = await getPool().query(`
            UPDATE depannhome_users SET is_active = $3, updated_at = NOW()
            WHERE id = $1 AND account_owner_id = $2 AND id <> $2 AND role = 'technician'
        `, [technicianId, getAccountOwnerId(request), isActive]);
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
                account.id AS "userId", account.full_name AS "fullName", account.username, account.email, account.role AS "userRole"
            FROM depannhome_auth_devices device JOIN depannhome_users account ON account.id = device.user_id
            WHERE account.account_owner_id = $1
            ORDER BY CASE device.status WHEN 'approval_pending' THEN 0 WHEN 'code_pending' THEN 1 ELSE 2 END, device.created_at DESC
            `, [getAccountOwnerId(request)]),
            database.query(`
                SELECT owner.max_pc_users AS "maxPcUsers",
                    COUNT(device.id) FILTER (WHERE device.status = 'approved' AND device.device_type = 'desktop')::int AS "activePcUsers"
                FROM depannhome_users owner
                LEFT JOIN depannhome_users account ON account.account_owner_id = owner.id AND account.role = 'admin'
                LEFT JOIN depannhome_auth_devices device ON device.user_id = account.id
                WHERE owner.id = $1 GROUP BY owner.id
            `, [getAccountOwnerId(request)])
        ]);
        response.json({ devices: devicesResult.rows, pcSeats: seatsResult.rows[0] || { maxPcUsers: 1, activePcUsers: 0 } });
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
        if (device.role === "admin") {
            if (device.deviceType === "mobile") {
                await getPool().query("UPDATE depannhome_auth_devices SET status = 'approved', approved_at = NOW(), approved_by = $2 WHERE id = $1", [deviceId, request.user.sub]);
                return response.status(204).end();
            }
            const seats = await getPool().query(`
                SELECT owner.max_pc_users, COUNT(auth_device.id) FILTER (WHERE auth_device.status = 'approved' AND auth_device.device_type = 'desktop')::int AS approved_devices
                FROM depannhome_users owner
                LEFT JOIN depannhome_users account ON account.account_owner_id = owner.id AND account.role = 'admin'
                LEFT JOIN depannhome_auth_devices auth_device ON auth_device.user_id = account.id
                WHERE owner.id = $1 GROUP BY owner.id
            `, [getAccountOwnerId(request)]);
            if (seats.rows[0]?.approved_devices >= seats.rows[0]?.max_pc_users) return response.status(400).json({ message: "Aucun poste PC supplémentaire n’est inclus dans votre offre. Contactez Depann’Home Pro pour activer un poste PC." });
            await getPool().query("UPDATE depannhome_auth_devices SET status = 'approved', approved_at = NOW(), approved_by = $2 WHERE id = $1", [deviceId, request.user.sub]);
            return response.status(204).end();
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
        request.user = {
            sub: String(user.id),
            username: user.username,
            role: user.role,
            accountOwnerId: String(user.account_owner_id || user.id),
            fullName: user.full_name || "",
            phone: user.phone || "",
            email: user.email || "",
            technicianBillingEnabled: user.technician_billing_enabled !== false,
            maxPcUsers: Number(user.max_pc_users) || 1,
            deviceId: device.id,
            isCreator: isCreatorUsername(user.username)
        };
    } catch {
        response.clearCookie(COOKIE_NAME, cookieOptions());
    }

    return next();
}

export function requireAuthentication(request, response, next) {
    if (!request.user) {
        return response.status(401).json({ message: "Connexion requise." });
    }

    return next();
}

export function getAccountOwnerId(request) {
    return String(request.user?.accountOwnerId || request.user?.sub || "");
}

export function requireCreator(request, response, next) {
    if (!request.user?.isCreator) return response.status(403).json({ message: "Accès réservé au Créateur de l’application." });
    return next();
}

export function isCreatorUsername(username) {
    return getCreatorUsernames().has(normalizeUsername(username));
}

function requireAccountAdministrator(request, response, next) {
    if (!request.user || request.user.role !== "admin" || String(request.user.accountOwnerId || request.user.sub) !== String(request.user.sub)) {
        return response.status(403).json({ message: "Accès réservé à l’administrateur du compte." });
    }
    return next();
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
        SET password_hash = $2, updated_at = NOW()
        WHERE username = $1
        RETURNING id
    `, [username, await bcrypt.hash(password, 12)]);
    if (!result.rowCount) throw new Error("Réinitialisation Créateur impossible : aucun compte correspondant à cet identifiant.");
    console.log(`Mot de passe Créateur réinitialisé pour « ${username} ». Retirez immédiatement les variables CREATOR_PASSWORD_RECOVERY_* après connexion.`);
}

function setSessionCookie(response, user, deviceId) {
    const duration = user.role === "technician" ? TECHNICIAN_SESSION_DURATION : ADMIN_SESSION_DURATION;
    const token = jwt.sign(
        { sub: String(user.id || user.user_id), username: user.username, role: user.role, accountOwnerId: String(user.account_owner_id || user.id || user.user_id), fullName: user.full_name || "", phone: user.phone || "", deviceId },
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
        accountOwnerId: String(user.account_owner_id || user.accountOwnerId || id),
        fullName: user.full_name || user.fullName || "",
        phone: user.phone || "",
        email: user.email || "",
        technicianBillingEnabled: (user.technician_billing_enabled ?? user.technicianBillingEnabled) !== false,
        maxPcUsers: Number(user.max_pc_users ?? user.maxPcUsers) || 1,
        isActive: user.is_active !== false,
        isCreator: Boolean(user.isCreator || isCreatorUsername(user.username))
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

function positiveId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
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
    return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}
