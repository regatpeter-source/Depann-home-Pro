import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { createUser, findUserByUsername } from "./database.js";

const COOKIE_NAME = "depann_home_session";
const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;
const MIN_PASSWORD_LENGTH = 12;

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
        const passwordMatches = user && await bcrypt.compare(password, user.password_hash);

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
            const user = await createUser({ username, passwordHash });
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
}

export function validateAuthenticationConfiguration() {
    getSessionSecret();
}

export function authenticateRequest(request, response, next) {
    const token = request.cookies?.[COOKIE_NAME];
    if (!token) return next();

    try {
        request.user = jwt.verify(token, getSessionSecret());
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
    const token = jwt.sign(
        { sub: String(user.id), username: user.username, role: user.role },
        getSessionSecret(),
        { expiresIn: "12h" }
    );

    response.cookie(COOKIE_NAME, token, {
        ...cookieOptions(),
        maxAge: 12 * 60 * 60 * 1000
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
    return { id: String(user.id), username: user.username, role: user.role };
}

function normalizeUsername(value) {
    return String(value || "").trim().toLowerCase();
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
