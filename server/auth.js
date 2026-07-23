import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { createUser, findUserById, findUserByUsername, getPool } from "./database.js";

const COOKIE_NAME = "depann_home_session";
const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;
const MIN_PASSWORD_LENGTH = 12;
const ADMIN_SESSION_DURATION = 12 * 60 * 60 * 1000;
const TECHNICIAN_SESSION_DURATION = 30 * 24 * 60 * 60 * 1000;

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
        const user = username ? await findUserByUsername(username) : null;
        const passwordMatches = user?.is_active && user?.account_is_active && await bcrypt.compare(password, user.password_hash);

        if (!passwordMatches) {
            return response.status(401).json({ message: "Identifiant ou mot de passe incorrect." });
        }

        setSessionCookie(response, user);
        return response.json({ user: publicUser(user) });
    }));

    app.post("/api/auth/register", asyncHandler(async (request, response) => {
        if (!isPublicRegistrationEnabled()) {
            return response.status(403).json({ message: "La création de compte est réservée à l’administrateur." });
        }

        const username = normalizeUsername(request.body?.username);
        const password = String(request.body?.password || "");
        const validationError = validateCredentials(username, password);
        if (validationError) return response.status(400).json({ message: validationError });

        try {
            const passwordHash = await bcrypt.hash(password, 12);
            const user = await createUser({ username, passwordHash, role: "admin" });
            setSessionCookie(response, user);
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

    app.get("/api/auth/technicians", requireAccountAdministrator, asyncHandler(async (request, response) => {
        const { rows } = await getPool().query(`
            SELECT id, username, full_name AS "fullName", phone, is_active AS "isActive", created_at AS "createdAt"
            FROM depannhome_users
            WHERE account_owner_id = $1 AND id <> $1
            ORDER BY LOWER(full_name), username
        `, [getAccountOwnerId(request)]);
        response.json({ technicians: rows });
    }));

    app.post("/api/auth/technicians", requireAccountAdministrator, asyncHandler(async (request, response) => {
        const username = normalizeUsername(request.body?.username);
        const password = String(request.body?.password || "");
        const fullName = cleanText(request.body?.fullName, 100);
        const phone = cleanText(request.body?.phone, 30);
        const validationError = validateCredentials(username, password) || (!fullName ? "Le nom du technicien est obligatoire." : "") || (!phone ? "Le téléphone du technicien est obligatoire." : "");
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
            const user = await createUser({ username, passwordHash: await bcrypt.hash(password, 12), role: "technician", accountOwnerId: getAccountOwnerId(request), fullName, phone });
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
        if (!user?.is_active || !user.account_is_active) throw new Error("Session inactive");
        request.user = {
            sub: String(user.id),
            username: user.username,
            role: user.role,
            accountOwnerId: String(user.account_owner_id || user.id),
            fullName: user.full_name || "",
            phone: user.phone || "",
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

function setSessionCookie(response, user) {
    const duration = user.role === "technician" ? TECHNICIAN_SESSION_DURATION : ADMIN_SESSION_DURATION;
    const token = jwt.sign(
        { sub: String(user.id), username: user.username, role: user.role, accountOwnerId: String(user.account_owner_id || user.id), fullName: user.full_name || "", phone: user.phone || "" },
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
    const id = user.id || user.sub;
    return {
        id: String(id),
        username: user.username,
        role: user.role,
        accountOwnerId: String(user.account_owner_id || user.accountOwnerId || id),
        fullName: user.full_name || user.fullName || "",
        phone: user.phone || "",
        isActive: user.is_active !== false,
        isCreator: Boolean(user.isCreator || isCreatorUsername(user.username))
    };
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
