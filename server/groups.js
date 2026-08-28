import bcrypt from "bcrypt";
import { createUser, findUserById, getPool } from "./database.js";
import { getAccountOwnerId, isCompanyAdministrator, refreshSessionForActiveCompany } from "./auth.js";
import { hasGroupCompanySwitchAccess } from "./workstation-permissions.js";

const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 12;

export async function initializeGroups() {
    const db = getPool();
    await db.query(`CREATE TABLE IF NOT EXISTS depannhome_groups (id BIGSERIAL PRIMARY KEY, name VARCHAR(160) NOT NULL, shared_partner_directory_enabled BOOLEAN NOT NULL DEFAULT FALSE, is_active BOOLEAN NOT NULL DEFAULT TRUE, created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await db.query(`CREATE TABLE IF NOT EXISTS depannhome_group_companies (group_id BIGINT NOT NULL REFERENCES depannhome_groups(id) ON DELETE CASCADE, company_owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE RESTRICT, is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(group_id, company_owner_id), UNIQUE(company_owner_id))`);
    await db.query(`CREATE TABLE IF NOT EXISTS depannhome_group_administrators (group_id BIGINT NOT NULL REFERENCES depannhome_groups(id) ON DELETE CASCADE, user_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(group_id,user_id))`);
    await db.query(`CREATE TABLE IF NOT EXISTS depannhome_group_audit (id BIGSERIAL PRIMARY KEY, group_id BIGINT NOT NULL REFERENCES depannhome_groups(id) ON DELETE CASCADE, company_owner_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL, actor_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL, action VARCHAR(80) NOT NULL, details JSONB NOT NULL DEFAULT '{}'::jsonb, ip_address VARCHAR(100) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await db.query("CREATE INDEX IF NOT EXISTS depannhome_group_companies_group_active_idx ON depannhome_group_companies(group_id,is_active)");
    await db.query("CREATE INDEX IF NOT EXISTS depannhome_group_audit_group_created_idx ON depannhome_group_audit(group_id,created_at DESC)");
}

export function registerGroupRoutes(app, requireAuthentication) {
    app.use("/api/groups", requireAuthentication);
    app.get("/api/groups/context", asyncHandler(async (req, res) => {
        if (!hasGroupCompanySwitchAccess(req.user)) return res.status(403).json({ message: "Vous n’êtes pas autorisé à accéder aux entreprises du groupe." });
        res.json({ enabled: true, ...(await groupContext(req.user.groupId, getAccountOwnerId(req))) });
    }));
    app.get("/api/groups/audit", requireGroupAdministrator, asyncHandler(async (req, res) => {
        const { rows } = await getPool().query(`SELECT audit.id,audit.action,audit.details,audit.created_at AS "createdAt",owner.company_name AS "companyName",actor.full_name AS "actorName",actor.username AS "actorUsername" FROM depannhome_group_audit audit LEFT JOIN depannhome_users owner ON owner.id=audit.company_owner_id LEFT JOIN depannhome_users actor ON actor.id=audit.actor_id WHERE audit.group_id=$1 ORDER BY audit.created_at DESC LIMIT 100`, [req.user.groupId]);
        res.json({ entries: rows });
    }));
    app.post("/api/groups/activate", asyncHandler(async (req, res) => {
        if (!isCompanyAdministrator(req) || req.user?.isGroupAdministrator) return res.status(403).json({ message: "Seul un Poste Admin de l’entreprise peut activer le mode Groupe." });
        const name = clean(req.body?.name, 160);
        if (!name) return res.status(400).json({ message: "Le nom du groupe est obligatoire." });
        const db = getPool(); const companyId = getAccountOwnerId(req);
        const client = await db.connect();
        try {
            await client.query("BEGIN");
            const membership = await client.query("SELECT group_id FROM depannhome_group_companies WHERE company_owner_id=$1 FOR UPDATE", [companyId]);
            if (membership.rowCount) {
                await client.query("ROLLBACK");
                return res.status(409).json({ message: "Cette entreprise appartient déjà à un groupe." });
            }
            const { rows } = await client.query("INSERT INTO depannhome_groups(name,created_by) VALUES($1,$2) RETURNING id", [name, req.user.sub]);
            const groupId = rows[0].id;
            await client.query("INSERT INTO depannhome_group_companies(group_id,company_owner_id) VALUES($1,$2)", [groupId, companyId]);
            await client.query("INSERT INTO depannhome_group_administrators(group_id,user_id) VALUES($1,$2)", [groupId, req.user.sub]);
            await audit(client, { groupId, companyId, actorId: req.user.sub, action: "group_activated", details: { name }, ip: req.ip });
            await client.query("COMMIT");
            const user = await findUserById(req.user.sub);
            await refreshSessionForActiveCompany(res, user, req.user.deviceId, companyId);
            res.status(201).json({ groupId: String(groupId) });
        } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }));
    app.delete("/api/groups/current", requireGroupAdministrator, asyncHandler(async (req, res) => {
        const db = getPool();
        const user = await findUserById(req.user.sub);
        if (!user) return res.status(401).json({ message: "Utilisateur introuvable." });
        const client = await db.connect();
        try {
            await client.query("BEGIN");
            const group = await client.query(`
                SELECT group_data.id, group_data.name
                FROM depannhome_groups group_data
                JOIN depannhome_group_administrators administrator ON administrator.group_id = group_data.id AND administrator.user_id = $1
                WHERE group_data.id = $2 AND group_data.is_active = TRUE
                FOR UPDATE
            `, [req.user.sub, req.user.groupId]);
            const currentGroup = group.rows[0];
            if (!currentGroup) {
                await client.query("ROLLBACK");
                return res.status(404).json({ message: "Groupe introuvable ou déjà désactivé." });
            }
            const companies = await client.query("SELECT COUNT(*)::int AS count FROM depannhome_group_companies WHERE group_id = $1", [currentGroup.id]);
            await client.query("DELETE FROM depannhome_groups WHERE id = $1", [currentGroup.id]);
            await client.query(`
                INSERT INTO depannhome_member_audit (owner_id, actor_id, target_user_id, target_username, target_full_name, action, details)
                VALUES ($1, $2, $2, $3, $4, 'group_deactivated', $5::jsonb)
            `, [user.account_owner_id, user.id, user.username, user.full_name || "", JSON.stringify({ groupName: currentGroup.name, companyCount: companies.rows[0]?.count || 0 })]);
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
        await refreshSessionForActiveCompany(res, user, req.user.deviceId, user.account_owner_id);
        res.status(204).end();
    }));
    app.post("/api/groups/companies", requireGroupAdministrator, asyncHandler(async (req, res) => {
        const input = companyInput(req.body);
        if (!input.ok) return res.status(400).json({ message: input.message });
        const groupId = req.user.groupId;
        const user = await createUser({ username: input.username, passwordHash: await bcrypt.hash(input.password, 12), role: "admin", fullName: input.fullName, phone: input.phone, email: input.email });
        const db = getPool();
        try {
            await db.query("UPDATE depannhome_users SET company_name=$2,max_pc_users=$3,max_technicians=$4 WHERE id=$1", [user.id, input.companyName, input.maxPcUsers, input.maxTechnicians]);
            await db.query("INSERT INTO depannhome_group_companies(group_id,company_owner_id) VALUES($1,$2)", [groupId, user.id]);
            await audit(db, { groupId, companyId: user.id, actorId: req.user.sub, action: "company_created", details: { companyName: input.companyName, administrator: input.username }, ip: req.ip });
            res.status(201).json({ companyId: String(user.id) });
        } catch (error) { await db.query("DELETE FROM depannhome_users WHERE id=$1", [user.id]); throw error; }
    }));
    app.patch("/api/groups/companies/:companyId", requireGroupAdministrator, asyncHandler(async (req, res) => {
        const companyId = positiveId(req.params.companyId); const groupId = req.user.groupId;
        const company = await groupCompany(groupId, companyId, true);
        if (!company) return res.status(404).json({ message: "Entreprise introuvable dans ce groupe." });
        const name = clean(req.body?.companyName, 160) || company.companyName;
        const isActive = typeof req.body?.isActive === "boolean" ? req.body.isActive : company.isActive;
        if (!isActive && String(companyId) === getAccountOwnerId(req)) return res.status(400).json({ message: "Changez d’entreprise active avant de désactiver celle-ci." });
        await getPool().query("UPDATE depannhome_group_companies SET is_active=$3,updated_at=NOW() WHERE group_id=$1 AND company_owner_id=$2", [groupId, companyId, isActive]);
        await getPool().query("UPDATE depannhome_users SET company_name=$2,is_active=$3,updated_at=NOW() WHERE id=$1 AND account_owner_id=id", [companyId, name, isActive]);
        await audit(getPool(), { groupId, companyId, actorId: req.user.sub, action: name !== company.companyName ? "company_updated" : isActive ? "company_activated" : "company_deactivated", details: { companyName: name, previousCompanyName: company.companyName, isActive, previousIsActive: company.isActive }, ip: req.ip });
        res.status(204).end();
    }));
    app.put("/api/groups/active-company", requireGroupCompanySwitchAccess, asyncHandler(async (req, res) => {
        const companyId = positiveId(req.body?.companyId); const company = await groupCompany(req.user.groupId, companyId, true);
        if (!company || !company.isActive) return res.status(404).json({ message: "Entreprise inactive ou non autorisée." });
        const user = await findUserById(req.user.sub);
        await refreshSessionForActiveCompany(res, user, req.user.deviceId, companyId);
        await audit(getPool(), { groupId: req.user.groupId, companyId, actorId: req.user.sub, action: "company_switched", details: { companyName: company.companyName, actorRole: req.user.role }, ip: req.ip });
        res.json({ activeCompanyId: String(companyId) });
    }));
    app.get("/api/groups/dashboard", requireGroupAdministrator, asyncHandler(async (req, res) => {
        const context = await groupContext(req.user.groupId, getAccountOwnerId(req));
        const start = date(req.query?.start); const end = date(req.query?.end);
        if ((req.query?.start && !start) || (req.query?.end && !end) || (start && end && start > end)) return res.status(400).json({ message: "Période invalide." });
        const selected = positiveId(req.query?.companyId);
        const companyIds = context.companies.filter(item => !selected || String(item.id) === String(selected)).map(item => item.id);
        if (!companyIds.length) return res.status(404).json({ message: "Entreprise non autorisée." });
        res.json({ dashboard: await dashboard(companyIds, start, end), companies: context.companies, activeCompanyId: context.activeCompanyId });
    }));
}

async function groupContext(groupId, activeCompanyId) {
    const { rows } = await getPool().query(`SELECT group_data.id,group_data.name,group_data.shared_partner_directory_enabled AS "sharedPartnerDirectoryEnabled",company.company_owner_id AS id,company.is_active AS "isActive",owner.company_name AS "companyName",owner.full_name AS "administratorName" FROM depannhome_groups group_data JOIN depannhome_group_companies company ON company.group_id=group_data.id JOIN depannhome_users owner ON owner.id=company.company_owner_id WHERE group_data.id=$1 AND group_data.is_active=TRUE ORDER BY LOWER(owner.company_name),owner.id`, [groupId]);
    const group = rows[0] ? { id: String(rows[0].id), name: rows[0].name, sharedPartnerDirectoryEnabled: rows[0].sharedPartnerDirectoryEnabled } : null;
    return { group, companies: rows.map(row => ({ id: String(row.id), companyName: row.companyName || row.administratorName || "Entreprise", isActive: row.isActive })), activeCompanyId: String(activeCompanyId || "") };
}

async function groupCompany(groupId, companyId) { const { rows } = await getPool().query(`SELECT company.company_owner_id AS id,company.is_active AS "isActive",owner.company_name AS "companyName" FROM depannhome_group_companies company JOIN depannhome_users owner ON owner.id=company.company_owner_id WHERE company.group_id=$1 AND company.company_owner_id=$2`, [groupId, companyId]); return rows[0] || null; }
async function dashboard(companyIds, start, end) {
    const db = getPool(); const dates = [companyIds, start || null, end || null];
    const [billing, interventions, technicians] = await Promise.all([
        db.query(`SELECT owner_id AS id,COUNT(*) FILTER (WHERE document_type='quote')::int AS quotes,COUNT(*) FILTER (WHERE document_type='invoice')::int AS invoices,COALESCE(SUM(CASE WHEN document_type='invoice' THEN (SELECT COALESCE(SUM(COALESCE((line->>'quantity')::numeric,0)*COALESCE(COALESCE(line->>'unitPrice',line->>'unit_price')::numeric,0)*(1+(COALESCE(line->>'vatRate',line->>'vat_rate','0'))::numeric/100)),0) FROM jsonb_array_elements(lines) line) ELSE 0 END),0)::float AS turnover FROM depannhome_billing_documents WHERE owner_id=ANY($1::bigint[]) AND ($2::date IS NULL OR issue_date >= $2::date) AND ($3::date IS NULL OR issue_date <= $3::date) GROUP BY owner_id`, dates),
        db.query(`SELECT owner_id AS id,COUNT(*)::int AS interventions FROM depannhome_calendar_events WHERE owner_id=ANY($1::bigint[]) AND ($2::date IS NULL OR event_date >= $2::date) AND ($3::date IS NULL OR event_date <= $3::date) GROUP BY owner_id`, dates),
        db.query("SELECT account_owner_id AS id,COUNT(*) FILTER (WHERE role='technician' AND is_active)::int AS technicians FROM depannhome_users WHERE account_owner_id=ANY($1::bigint[]) GROUP BY account_owner_id", [companyIds])
    ]);
    const values = new Map(companyIds.map(id => [String(id), { companyId: String(id), turnover: 0, quotes: 0, invoices: 0, interventions: 0, technicians: 0 }]));
    billing.rows.forEach(row => Object.assign(values.get(String(row.id)), { turnover: Number(row.turnover || 0), quotes: row.quotes, invoices: row.invoices })); interventions.rows.forEach(row => Object.assign(values.get(String(row.id)), { interventions: row.interventions })); technicians.rows.forEach(row => Object.assign(values.get(String(row.id)), { technicians: row.technicians }));
    const companies = [...values.values()]; const total = companies.reduce((sum, item) => ({ turnover: sum.turnover + item.turnover, quotes: sum.quotes + item.quotes, invoices: sum.invoices + item.invoices, interventions: sum.interventions + item.interventions, technicians: sum.technicians + item.technicians }), { turnover: 0, quotes: 0, invoices: 0, interventions: 0, technicians: 0 });
    return { total, companies };
}
async function audit(db, { groupId, companyId, actorId, action, details, ip }) { await db.query("INSERT INTO depannhome_group_audit(group_id,company_owner_id,actor_id,action,details,ip_address) VALUES($1,$2,$3,$4,$5::jsonb,$6)", [groupId, companyId || null, actorId, action, JSON.stringify(details || {}), String(ip || "").slice(0, 100)]); }
function requireGroupAdministrator(req, res, next) { if (isCompanyAdministrator(req) && req.user?.isGroupAdministrator && req.user?.groupId) return next(); return res.status(403).json({ message: "Accès réservé au Poste Admin du groupe." }); }
function requireGroupCompanySwitchAccess(req, res, next) { if (hasGroupCompanySwitchAccess(req.user)) return next(); return res.status(403).json({ message: "Vous n’êtes pas autorisé à changer d’entreprise dans ce groupe." }); }
function companyInput(value) { const companyName = clean(value?.companyName, 160), fullName = clean(value?.fullName, 100), phone = clean(value?.phone, 30), email = clean(value?.email, 160).toLowerCase(), username = clean(value?.username, 32).toLowerCase(), password = String(value?.password || ""), maxPcUsers = limit(value?.maxPcUsers, 1, 100), maxTechnicians = limit(value?.maxTechnicians, 0, 500); if (!companyName || !fullName || !USERNAME_PATTERN.test(username) || password.length < MIN_PASSWORD_LENGTH || (email && !EMAIL_PATTERN.test(email)) || !maxPcUsers || maxTechnicians === null) return { ok: false, message: "Informations de la nouvelle entreprise invalides." }; return { ok: true, companyName, fullName, phone, email, username, password, maxPcUsers, maxTechnicians }; }
function clean(value, maximum) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximum); }
function positiveId(value) { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : 0; }
function limit(value, minimum, maximum) { const valueNumber = Number(value); return Number.isSafeInteger(valueNumber) && valueNumber >= minimum && valueNumber <= maximum ? valueNumber : null; }
function date(value) { const text = String(value || ""); return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(new Date(`${text}T12:00:00`).getTime()) ? text : ""; }
function asyncHandler(handler) { return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next); }
