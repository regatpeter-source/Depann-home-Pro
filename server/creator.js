import bcrypt from "bcrypt";
import { getPool } from "./database.js";
import { isCreatorUsername } from "./auth.js";

const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;
const MIN_PASSWORD_LENGTH = 12;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MEMBER_ROLES = new Set(["admin", "technician", "accountant"]);
const SUBSCRIPTION_PLANS = new Set(["free", "paid"]);
const SUBSCRIPTION_STATUSES = new Set(["active", "trial", "past_due", "suspended", "cancelled"]);
const QUOTE_TEMPLATE_POLICIES = new Set(["integrated_only", "company_choice", "external_only"]);

export function registerCreatorRoutes(app, requireCreator) {
    app.get("/api/creator/accounts", requireCreator, asyncHandler(async (request, response) => {
        const { rows } = await getPool().query(`
            SELECT
                owner.id,
                owner.company_name AS "companyName",
                owner.username AS "ownerUsername",
                owner.full_name AS "ownerFullName",
                owner.phone AS "ownerPhone",
                owner.is_active AS "isActive",
                owner.max_pc_users AS "maxPcUsers",
                owner.max_technicians AS "maxTechnicians",
                owner.subscription_plan AS "subscriptionPlan",
                owner.subscription_label AS "subscriptionLabel",
                owner.monthly_price_cents AS "monthlyPriceCents",
                owner.subscription_status AS "subscriptionStatus",
                TO_CHAR(owner.subscription_renewal_date, 'YYYY-MM-DD') AS "subscriptionRenewalDate",
                owner.billing_reference AS "billingReference",
                owner.creator_note AS "creatorNote",
                owner.quote_template_policy AS "quoteTemplatePolicy",
                owner.created_at AS "createdAt",
                COUNT(member.id) FILTER (WHERE member.role = 'admin' AND member.is_active)::int AS "activePcUsers",
                COUNT(member.id) FILTER (WHERE member.role = 'technician' AND member.is_active)::int AS "activeTechnicians",
                COUNT(member.id)::int AS "memberCount"
            FROM depannhome_users owner
            LEFT JOIN depannhome_users member ON member.account_owner_id = owner.id
            WHERE owner.account_owner_id = owner.id
            GROUP BY owner.id
            ORDER BY LOWER(COALESCE(NULLIF(owner.company_name, ''), owner.full_name, owner.username))
        `);
        response.json({ accounts: rows.filter(account => !isCreatorUsername(account.ownerUsername) || String(account.id) === String(request.user.sub)) });
    }));

    app.post("/api/creator/accounts", requireCreator, asyncHandler(async (request, response) => {
        const account = sanitizeAccount(request.body);
        const credentials = sanitizeCredentials(request.body);
        if (!account.ok) return response.status(400).json({ message: account.message });
        if (!credentials.ok) return response.status(400).json({ message: credentials.message });

        try {
            const database = getPool();
            const { rows } = await database.query(`
                INSERT INTO depannhome_users (username, password_hash, role, full_name, phone, company_name, max_pc_users, max_technicians,
                    subscription_plan, subscription_label, monthly_price_cents, subscription_status, subscription_renewal_date, billing_reference, creator_note, quote_template_policy)
                VALUES ($1, $2, 'admin', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::date, $13, $14, $15)
                RETURNING id
            `, [credentials.username, await bcrypt.hash(credentials.password, 12), account.fullName, account.phone, account.companyName, account.maxPcUsers, account.maxTechnicians,
                account.subscriptionPlan, account.subscriptionLabel, account.monthlyPriceCents, account.subscriptionStatus, account.subscriptionRenewalDate || null, account.billingReference, account.creatorNote, account.quoteTemplatePolicy]);
            const id = rows[0].id;
            await database.query("UPDATE depannhome_users SET account_owner_id = id WHERE id = $1", [id]);
            response.status(201).json({ id: String(id) });
        } catch (error) {
            if (error.code === "23505") return response.status(409).json({ message: "Cet identifiant est déjà utilisé." });
            throw error;
        }
    }));

    app.patch("/api/creator/accounts/:accountId", requireCreator, asyncHandler(async (request, response) => {
        const accountId = positiveId(request.params.accountId);
        if (!accountId) return response.status(400).json({ message: "Compte entreprise invalide." });
        const account = sanitizeAccount(request.body);
        if (!account.ok) return response.status(400).json({ message: account.message });

        const database = getPool();
        const owner = await findAccountOwner(database, accountId);
        if (!canManageAccount(owner, request)) return response.status(404).json({ message: "Compte entreprise introuvable." });
        const counts = await countActiveSeats(database, accountId);
        if (account.maxPcUsers < counts.activePcUsers || account.maxTechnicians < counts.activeTechnicians) {
            return response.status(400).json({ message: "Les limites ne peuvent pas être inférieures aux accès actifs existants." });
        }
        await database.query(`
            UPDATE depannhome_users
            SET company_name = $2, full_name = $3, phone = $4, max_pc_users = $5, max_technicians = $6, is_active = $7,
                subscription_plan = $8, subscription_label = $9, monthly_price_cents = $10, subscription_status = $11,
                subscription_renewal_date = $12::date, billing_reference = $13, creator_note = $14, quote_template_policy = $15, updated_at = NOW()
            WHERE id = $1 AND account_owner_id = id
        `, [accountId, account.companyName, account.fullName, account.phone, account.maxPcUsers, account.maxTechnicians, isOwnCreatorAccount(owner, request) ? true : account.isActive,
            account.subscriptionPlan, account.subscriptionLabel, account.monthlyPriceCents, account.subscriptionStatus, account.subscriptionRenewalDate || null, account.billingReference, account.creatorNote, account.quoteTemplatePolicy]);
        response.status(204).end();
    }));

    app.delete("/api/creator/accounts/:accountId", requireCreator, asyncHandler(async (request, response) => {
        const accountId = positiveId(request.params.accountId);
        if (!accountId) return response.status(400).json({ message: "Compte entreprise invalide." });
        if (String(accountId) === String(request.user.sub)) return response.status(403).json({ message: "Le compte Créateur ne peut pas être supprimé." });
        const database = getPool();
        const owner = await findAccountOwner(database, accountId);
        if (!owner || isCreatorUsername(owner.username)) return response.status(404).json({ message: "Compte entreprise introuvable." });
        const result = await database.query("DELETE FROM depannhome_users WHERE id = $1 AND account_owner_id = id", [accountId]);
        if (!result.rowCount) return response.status(404).json({ message: "Compte entreprise introuvable." });
        response.status(204).end();
    }));

    app.get("/api/creator/accounts/:accountId/members", requireCreator, asyncHandler(async (request, response) => {
        const startedAt = Date.now();
        const accountId = positiveId(request.params.accountId);
        console.info("[creator-members] request", { accountId, creatorId: request.user.sub });
        const owner = accountId && await findAccountOwner(getPool(), accountId);
        if (!canManageAccount(owner, request)) {
            console.info("[creator-members] account unavailable", { accountId, durationMs: Date.now() - startedAt });
            return response.status(404).json({ message: "Compte entreprise introuvable." });
        }
        const { rows } = await getPool().query(`
            SELECT id, username, role, full_name AS "fullName", phone, email, is_active AS "isActive", created_at AS "createdAt"
            FROM depannhome_users WHERE account_owner_id = $1
            ORDER BY CASE WHEN id = $1 THEN 0 ELSE 1 END, role, LOWER(full_name), username
        `, [accountId]);
        console.info("[creator-members] response", { accountId, count: rows.length, durationMs: Date.now() - startedAt });
        response.json({ members: rows });
    }));

    app.post("/api/creator/accounts/:accountId/members", requireCreator, asyncHandler(async (request, response) => {
        const accountId = positiveId(request.params.accountId);
        const role = MEMBER_ROLES.has(request.body?.role) ? request.body.role : "";
        const profile = sanitizeMemberProfile(request.body, role);
        const credentials = sanitizeCredentials(request.body);
        const database = getPool();
        const owner = accountId && await findAccountOwner(database, accountId);
        if (!canManageAccount(owner, request)) return response.status(404).json({ message: "Compte entreprise introuvable." });
        if (!role) return response.status(400).json({ message: "Choisissez le type d’accès." });
        if (!profile.ok) return response.status(400).json({ message: profile.message });
        if (!credentials.ok) return response.status(400).json({ message: credentials.message });
        if (!owner.is_active) return response.status(400).json({ message: "Réactivez d’abord l’entreprise pour créer un accès." });

        const client = await database.connect();
        try {
            await client.query("BEGIN");
            await ensureSeatAvailable(client, accountId, role);
            const { rows } = await client.query(`
                INSERT INTO depannhome_users (username, password_hash, role, account_owner_id, full_name, phone, email)
                VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
            `, [credentials.username, await bcrypt.hash(credentials.password, 12), role, accountId, profile.fullName, profile.phone, profile.email]);
            await client.query("COMMIT");
            response.status(201).json({ id: String(rows[0].id) });
        } catch (error) {
            await client.query("ROLLBACK");
            if (error.code === "23505") return response.status(409).json({ message: "Cet identifiant est déjà utilisé." });
            if (error.message?.startsWith("LIMIT:")) return response.status(400).json({ message: error.message.slice(6) });
            throw error;
        } finally {
            client.release();
        }
    }));

    app.patch("/api/creator/accounts/:accountId/members/:memberId", requireCreator, asyncHandler(async (request, response) => {
        const accountId = positiveId(request.params.accountId);
        const memberId = positiveId(request.params.memberId);
        const database = getPool();
        const owner = accountId && await findAccountOwner(database, accountId);
        if (!canManageAccount(owner, request)) return response.status(404).json({ message: "Compte entreprise introuvable." });
        const member = await findMember(database, accountId, memberId);
        if (!member) return response.status(404).json({ message: "Accès introuvable." });
        const profile = sanitizeMemberProfile(request.body, member.role);
        if (!profile.ok) return response.status(400).json({ message: profile.message });
        const username = normalizeUsername(request.body?.username);
        if (!USERNAME_PATTERN.test(username)) return response.status(400).json({ message: usernameMessage() });
        const password = String(request.body?.password || "");
        if (password && password.length < MIN_PASSWORD_LENGTH) return response.status(400).json({ message: passwordMessage() });
        const isActive = member.id === accountId ? owner.is_active : Boolean(request.body?.isActive);

        const client = await database.connect();
        try {
            await client.query("BEGIN");
            if (isActive && !member.isActive) await ensureSeatAvailable(client, accountId, member.role);
            await client.query(`
                UPDATE depannhome_users
                SET username = $3, full_name = $4, phone = $5, email = $6, is_active = $7,
                    password_hash = CASE WHEN $8 <> '' THEN $9 ELSE password_hash END, updated_at = NOW()
                WHERE id = $1 AND account_owner_id = $2
            `, [memberId, accountId, username, profile.fullName, profile.phone, profile.email, isActive, password, password ? await bcrypt.hash(password, 12) : ""]);
            await client.query("COMMIT");
            response.status(204).end();
        } catch (error) {
            await client.query("ROLLBACK");
            if (error.code === "23505") return response.status(409).json({ message: "Cet identifiant est déjà utilisé." });
            if (error.message?.startsWith("LIMIT:")) return response.status(400).json({ message: error.message.slice(6) });
            throw error;
        } finally {
            client.release();
        }
    }));

    app.delete("/api/creator/accounts/:accountId/members/:memberId", requireCreator, asyncHandler(async (request, response) => {
        const accountId = positiveId(request.params.accountId);
        const memberId = positiveId(request.params.memberId);
        if (!accountId || !memberId) return response.status(400).json({ message: "Accès invalide." });
        if (accountId === memberId) return response.status(400).json({ message: "Supprimez l’entreprise entière pour supprimer son administrateur principal." });
        const owner = await findAccountOwner(getPool(), accountId);
        if (!canManageAccount(owner, request)) return response.status(404).json({ message: "Compte entreprise introuvable." });
        const result = await getPool().query("DELETE FROM depannhome_users WHERE id = $1 AND account_owner_id = $2", [memberId, accountId]);
        if (!result.rowCount) return response.status(404).json({ message: "Accès introuvable." });
        response.status(204).end();
    }));
}

async function findAccountOwner(database, id) {
    const { rows } = await database.query(`
        SELECT id, username, is_active, max_pc_users AS "maxPcUsers", max_technicians AS "maxTechnicians",
            subscription_plan AS "subscriptionPlan", subscription_status AS "subscriptionStatus"
        FROM depannhome_users WHERE id = $1 AND account_owner_id = id
    `, [id]);
    return rows[0] || null;
}

function isOwnCreatorAccount(owner, request) {
    return Boolean(owner) && isCreatorUsername(owner.username) && String(owner.id) === String(request.user.sub);
}

function canManageAccount(owner, request) {
    return Boolean(owner) && (!isCreatorUsername(owner.username) || isOwnCreatorAccount(owner, request));
}

async function findMember(database, accountId, memberId) {
    const { rows } = await database.query(`
        SELECT id, username, role, full_name AS "fullName", phone, email, is_active AS "isActive"
        FROM depannhome_users WHERE id = $1 AND account_owner_id = $2
    `, [memberId, accountId]);
    return rows[0] || null;
}

async function countActiveSeats(database, accountId) {
    const { rows } = await database.query(`
        SELECT
            COUNT(*) FILTER (WHERE role = 'admin' AND is_active)::int AS "activePcUsers",
            COUNT(*) FILTER (WHERE role = 'technician' AND is_active)::int AS "activeTechnicians"
        FROM depannhome_users WHERE account_owner_id = $1
    `, [accountId]);
    return rows[0];
}

async function ensureSeatAvailable(database, accountId, role) {
    if (role === "accountant") return;
    const { rows: owners } = await database.query(`
        SELECT max_pc_users AS "maxPcUsers", max_technicians AS "maxTechnicians"
        FROM depannhome_users WHERE id = $1 AND account_owner_id = id FOR UPDATE
    `, [accountId]);
    if (!owners[0]) throw new Error("LIMIT:Compte entreprise introuvable.");
    const counts = await countActiveSeats(database, accountId);
    const maximum = role === "admin" ? owners[0].maxPcUsers : owners[0].maxTechnicians;
    const active = role === "admin" ? counts.activePcUsers : counts.activeTechnicians;
    if (active >= maximum) throw new Error(`LIMIT:La limite de ${role === "admin" ? "postes PC" : "techniciens"} est atteinte.`);
}

function sanitizeAccount(value) {
    const companyName = cleanText(value?.companyName, 160);
    const fullName = cleanText(value?.fullName, 100);
    const phone = cleanText(value?.phone, 30);
    const maxPcUsers = positiveLimit(value?.maxPcUsers, 1, 100);
    const maxTechnicians = positiveLimit(value?.maxTechnicians, 0, 500);
    const subscriptionPlan = SUBSCRIPTION_PLANS.has(value?.subscriptionPlan) ? value.subscriptionPlan : "free";
    const subscriptionLabel = cleanText(value?.subscriptionLabel, 80);
    const monthlyPriceCents = moneyToCents(value?.monthlyPrice);
    const subscriptionStatus = SUBSCRIPTION_STATUSES.has(value?.subscriptionStatus) ? value.subscriptionStatus : "active";
    const subscriptionRenewalDate = sanitizeDate(value?.subscriptionRenewalDate);
    const billingReference = cleanText(value?.billingReference, 100);
    const creatorNote = cleanText(value?.creatorNote, 1000);
    const quoteTemplatePolicy = QUOTE_TEMPLATE_POLICIES.has(value?.quoteTemplatePolicy) ? value.quoteTemplatePolicy : "company_choice";
    const isActive = value?.isActive !== false;
    if (!companyName) return { ok: false, message: "Le nom de l’entreprise est obligatoire." };
    if (!fullName) return { ok: false, message: "Le nom du responsable est obligatoire." };
    if (!maxPcUsers) return { ok: false, message: "Indiquez au moins un poste PC." };
    if (maxTechnicians === null) return { ok: false, message: "Le nombre de techniciens est invalide." };
    if (monthlyPriceCents === null) return { ok: false, message: "Le tarif mensuel est invalide." };
    if (subscriptionPlan === "paid" && monthlyPriceCents <= 0) return { ok: false, message: "Indiquez un tarif mensuel supérieur à zéro pour un abonnement payant." };
    return { ok: true, companyName, fullName, phone, maxPcUsers, maxTechnicians, subscriptionPlan, subscriptionLabel,
        monthlyPriceCents: subscriptionPlan === "free" ? 0 : monthlyPriceCents, subscriptionStatus, subscriptionRenewalDate,
        billingReference, creatorNote, quoteTemplatePolicy, isActive };
}

function sanitizeMemberProfile(value, role) {
    const fullName = cleanText(value?.fullName, 100);
    const phone = cleanText(value?.phone, 30);
    const email = cleanText(value?.email, 160).toLowerCase();
    if (!fullName) return { ok: false, message: "Le nom est obligatoire." };
    if (role === "technician" && !phone) return { ok: false, message: "Le téléphone du technicien est obligatoire." };
    if (role === "technician" && !EMAIL_PATTERN.test(email)) return { ok: false, message: "L’e-mail professionnel du technicien est obligatoire." };
    return { ok: true, fullName, phone, email };
}

function sanitizeCredentials(value) {
    const username = normalizeUsername(value?.username);
    const password = String(value?.password || "");
    if (!USERNAME_PATTERN.test(username)) return { ok: false, message: usernameMessage() };
    if (password.length < MIN_PASSWORD_LENGTH) return { ok: false, message: passwordMessage() };
    return { ok: true, username, password };
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

function positiveLimit(value, minimum, maximum) {
    const limit = Number(value);
    return Number.isSafeInteger(limit) && limit >= minimum && limit <= maximum ? limit : null;
}

function moneyToCents(value) {
    const amount = String(value ?? "").trim().replace(",", ".");
    if (!amount) return 0;
    if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(amount)) return null;
    const cents = Math.round(Number(amount) * 100);
    return Number.isSafeInteger(cents) && cents >= 0 && cents <= 99999999 ? cents : null;
}

function sanitizeDate(value) {
    const date = String(value || "");
    return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(new Date(`${date}T12:00:00`).getTime()) ? date : "";
}

function usernameMessage() {
    return "L’identifiant doit contenir de 3 à 32 caractères : lettres minuscules, chiffres, point, tiret ou souligné.";
}

function passwordMessage() {
    return `Le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères.`;
}

function asyncHandler(handler) {
    return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}
