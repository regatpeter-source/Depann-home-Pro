import bcrypt from "bcrypt";
import { createUser, findUserById, getPool } from "./database.js";
import { getAccountOwnerId, isCompanyAdministrator, refreshSessionForActiveCompany } from "./auth.js";
import { hasGroupCompanySwitchAccess } from "./workstation-permissions.js";
import { strictDateOnly } from "./date-validation.js";
import { companySeatState, groupSeatStatus } from "./seat-limits.js";
import { createOrganization, getOrganization, updateOrganization } from "./organizations.js";

const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 12;

export async function initializeGroups() {
    const db = getPool();
    await db.query(`CREATE TABLE IF NOT EXISTS depannhome_groups (id BIGSERIAL PRIMARY KEY, name VARCHAR(160) NOT NULL, shared_partner_directory_enabled BOOLEAN NOT NULL DEFAULT FALSE, is_active BOOLEAN NOT NULL DEFAULT TRUE, created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await db.query(`CREATE TABLE IF NOT EXISTS depannhome_group_companies (group_id BIGINT NOT NULL REFERENCES depannhome_groups(id) ON DELETE CASCADE, company_owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE RESTRICT, is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(group_id, company_owner_id), UNIQUE(company_owner_id))`);
    await db.query(`CREATE TABLE IF NOT EXISTS depannhome_group_administrators (group_id BIGINT NOT NULL REFERENCES depannhome_groups(id) ON DELETE CASCADE, user_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(group_id,user_id))`);
    await db.query(`CREATE TABLE IF NOT EXISTS depannhome_group_audit (id BIGSERIAL PRIMARY KEY, group_id BIGINT NOT NULL REFERENCES depannhome_groups(id) ON DELETE CASCADE, company_owner_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL, actor_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL, action VARCHAR(80) NOT NULL, details JSONB NOT NULL DEFAULT '{}'::jsonb, ip_address VARCHAR(100) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await db.query(`CREATE TABLE IF NOT EXISTS depannhome_group_entitlements (group_id BIGINT PRIMARY KEY REFERENCES depannhome_groups(id) ON DELETE CASCADE,principal_company_owner_id BIGINT NOT NULL UNIQUE REFERENCES depannhome_users(id) ON DELETE RESTRICT,max_companies INTEGER NOT NULL CHECK(max_companies BETWEEN 1 AND 100),total_pc_seats INTEGER NOT NULL CHECK(total_pc_seats BETWEEN 1 AND 1000),total_mobile_seats INTEGER NOT NULL CHECK(total_mobile_seats BETWEEN 0 AND 5000),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await db.query(`CREATE TABLE IF NOT EXISTS depannhome_group_company_seat_allocations (group_id BIGINT NOT NULL REFERENCES depannhome_groups(id) ON DELETE CASCADE,company_owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,allocated_pc_seats INTEGER NOT NULL CHECK(allocated_pc_seats BETWEEN 1 AND 100),allocated_mobile_seats INTEGER NOT NULL CHECK(allocated_mobile_seats BETWEEN 0 AND 500),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(group_id,company_owner_id),UNIQUE(company_owner_id))`);
    await db.query("CREATE INDEX IF NOT EXISTS depannhome_group_companies_group_active_idx ON depannhome_group_companies(group_id,is_active)");
    await db.query("CREATE INDEX IF NOT EXISTS depannhome_group_audit_group_created_idx ON depannhome_group_audit(group_id,created_at DESC)");
    await db.query(`UPDATE depannhome_organizations organization SET interface_type='group',license_type='depannhome_group',updated_at=NOW()
        FROM depannhome_group_companies company
        JOIN depannhome_groups group_data ON group_data.id=company.group_id AND group_data.is_active=TRUE
        JOIN depannhome_group_entitlements entitlement ON entitlement.group_id=group_data.id
        JOIN depannhome_users principal ON principal.id=entitlement.principal_company_owner_id AND principal.subscription_plan='paid' AND principal.subscription_tier='pro'
        WHERE organization.account_owner_id=company.company_owner_id AND organization.interface_type<>'partner'
            AND (organization.interface_type<>'group' OR organization.license_type<>'depannhome_group')`);
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
    app.get("/api/groups/seat-status", requireGroupAdministrator, asyncHandler(async (req, res) => {
        const seats = await groupSeatStatus(getPool(), req.user.groupId);
        if (!seats) return res.status(404).json({ message: "Enveloppe du groupe introuvable." });
        res.json({ seats });
    }));
    app.post("/api/groups/activate", asyncHandler(async (req, res) => {
        if (req.user?.groupId) return res.status(403).json({ message: "Cette entreprise appartient déjà à un groupe. Seule l’entreprise principale gère le mode Groupe." });
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
            const owner = await client.query("SELECT max_pc_users,max_technicians,max_group_companies,subscription_plan,subscription_tier FROM depannhome_users WHERE id=$1 AND account_owner_id=id FOR UPDATE", [companyId]);
            if (!owner.rows[0]) { await client.query("ROLLBACK"); return res.status(404).json({ message: "Entreprise introuvable." }); }
            const organization = await getOrganization(companyId, client);
            const activationError = groupActivationAccessError(owner.rows[0], organization);
            if (activationError) { await client.query("ROLLBACK"); return res.status(403).json({ message: activationError }); }
            const { rows } = await client.query("INSERT INTO depannhome_groups(name,created_by) VALUES($1,$2) RETURNING id", [name, req.user.sub]);
            const groupId = rows[0].id;
            await client.query("INSERT INTO depannhome_group_companies(group_id,company_owner_id) VALUES($1,$2)", [groupId, companyId]);
            await client.query("INSERT INTO depannhome_group_administrators(group_id,user_id) VALUES($1,$2)", [groupId, req.user.sub]);
            await client.query("INSERT INTO depannhome_group_entitlements(group_id,principal_company_owner_id,max_companies,total_pc_seats,total_mobile_seats) VALUES($1,$2,$3,$4,$5)", [groupId, companyId, owner.rows[0].max_group_companies, owner.rows[0].max_pc_users, owner.rows[0].max_technicians]);
            await client.query("INSERT INTO depannhome_group_company_seat_allocations(group_id,company_owner_id,allocated_pc_seats,allocated_mobile_seats) VALUES($1,$2,$3,$4)", [groupId, companyId, owner.rows[0].max_pc_users, owner.rows[0].max_technicians]);
            await client.query("UPDATE depannhome_users SET subscription_label=$2,updated_at=NOW() WHERE id=$1", [companyId, `${tierLabel(owner.rows[0].subscription_tier)} Groupe — abonnement global facturé à l’entreprise principale`]);
            await updateOrganization(companyId, { interfaceType: "group", licenseType: "depannhome_group" }, req.user.sub, client);
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
            await client.query(`UPDATE depannhome_organizations SET interface_type='standard',license_type='depannhome_standard',updated_at=NOW() WHERE account_owner_id IN (SELECT company_owner_id FROM depannhome_group_companies WHERE group_id=$1)`, [currentGroup.id]);
            await client.query("DELETE FROM depannhome_groups WHERE id = $1", [currentGroup.id]);
            await client.query("UPDATE depannhome_users SET subscription_label=CASE subscription_tier WHEN 'basic' THEN 'Basic' WHEN 'basic_plus' THEN 'Basic+' ELSE 'Pro' END,updated_at=NOW() WHERE id=$1", [user.account_owner_id]);
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
        const input = validateGroupCompanyInput(req.body);
        if (!input.ok) return res.status(400).json({ message: input.message });
        const groupId = req.user.groupId;
        const client = await getPool().connect();
        try {
            await client.query("BEGIN");
            const group = await client.query("SELECT id FROM depannhome_groups WHERE id=$1 AND is_active=TRUE FOR UPDATE", [groupId]);
            if (!group.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ message: "Groupe introuvable ou désactivé." }); }
            await lockGroupSeatAllocation(client, groupId);
            const seats = await groupSeatStatus(client, groupId);
            if (!seats) { await client.query("ROLLBACK"); return res.status(409).json({ message: "Le Créateur doit d’abord attribuer une enveloppe à ce groupe." }); }
            if (seats.companyCount >= seats.maxCompanies) { await client.query("ROLLBACK"); return res.status(409).json({ message: `Le quota de ${seats.maxCompanies} entreprise(s), principale incluse, est atteint.` }); }
            if (input.allocatedPcSeats > seats.assignablePcSeats || input.allocatedMobileSeats > seats.assignableMobileSeats) { await client.query("ROLLBACK"); return res.status(409).json({ message: "Cette répartition dépasse les postes disponibles ou inutilisés dans l’enveloppe du groupe." }); }
            const transferredPcSeats = Math.max(0, input.allocatedPcSeats - seats.availablePcSeats);
            const transferredMobileSeats = Math.max(0, input.allocatedMobileSeats - seats.availableMobileSeats);
            if (transferredPcSeats || transferredMobileSeats) {
                await client.query(`UPDATE depannhome_group_company_seat_allocations
                    SET allocated_pc_seats=allocated_pc_seats-$2,allocated_mobile_seats=allocated_mobile_seats-$3,updated_at=NOW()
                    WHERE group_id=$1 AND company_owner_id=$4`, [groupId, transferredPcSeats, transferredMobileSeats, seats.principalCompanyId]);
            }
            const user = await createUser({ username: input.username, passwordHash: await bcrypt.hash(input.password, 12), role: "admin", fullName: input.fullName, phone: input.phone, email: input.email }, client);
            await client.query("UPDATE depannhome_users SET company_name=$2,max_pc_users=1,max_technicians=0,subscription_plan='free',subscription_tier='pro',subscription_label='Rattachée au groupe',monthly_price_cents=0 WHERE id=$1", [user.id, input.companyName]);
            await client.query("INSERT INTO depannhome_billing_profiles(owner_id,company_name,phone,email) VALUES($1,$2,$3,$4) ON CONFLICT(owner_id) DO UPDATE SET company_name=EXCLUDED.company_name,phone=EXCLUDED.phone,email=EXCLUDED.email,updated_at=NOW()", [user.id, input.companyName, input.phone, input.email]);
            await createOrganization(user.id, { interfaceType: "group", licenseType: "depannhome_group" }, req.user.sub, client);
            await client.query("INSERT INTO depannhome_group_companies(group_id,company_owner_id) VALUES($1,$2)", [groupId, user.id]);
            await client.query("INSERT INTO depannhome_group_company_seat_allocations(group_id,company_owner_id,allocated_pc_seats,allocated_mobile_seats) VALUES($1,$2,$3,$4)", [groupId, user.id, input.allocatedPcSeats, input.allocatedMobileSeats]);
            await audit(client, { groupId, companyId: user.id, actorId: req.user.sub, action: "company_created", details: { companyName: input.companyName, administrator: input.username, allocatedPcSeats: input.allocatedPcSeats, allocatedMobileSeats: input.allocatedMobileSeats, transferredPcSeats, transferredMobileSeats }, ip: req.ip });
            await client.query("COMMIT");
            res.status(201).json({ companyId: String(user.id) });
        } catch (error) {
            await client.query("ROLLBACK");
            if (error.code === "23505") return res.status(409).json({ message: "Cet identifiant administrateur est déjà utilisé. Choisissez un identifiant unique." });
            throw error;
        } finally { client.release(); }
    }));
    app.get("/api/groups/companies/:companyId", requireGroupAdministrator, asyncHandler(async (req, res) => {
        const companyId = positiveId(req.params.companyId);
        if (!companyId) return res.status(400).json({ message: "Entreprise invalide." });
        const company = await groupCompanyProfile(req.user.groupId, companyId);
        if (!company) return res.status(404).json({ message: "Entreprise introuvable dans ce groupe." });
        const usage = await companySeatState(getPool(), companyId);
        res.json({ company: { ...company, activePcUsers: Number(usage?.activePcUsers) || 0, approvedPcDevices: Number(usage?.approvedPcDevices) || 0, activeMobileUsers: Number(usage?.activeMobileUsers) || 0 } });
    }));
    app.patch("/api/groups/companies/:companyId", requireGroupAdministrator, asyncHandler(async (req, res) => {
        const companyId = positiveId(req.params.companyId); const groupId = req.user.groupId;
        if (!companyId) return res.status(400).json({ message: "Entreprise invalide." });
        const client = await getPool().connect();
        try {
            await client.query("BEGIN");
            const company = await groupCompany(groupId, companyId, true, client);
            if (!company) { await client.query("ROLLBACK"); return res.status(404).json({ message: "Entreprise introuvable dans ce groupe." }); }
            await client.query("SELECT group_id FROM depannhome_group_entitlements WHERE group_id=$1 FOR UPDATE", [groupId]);
            await client.query("SELECT company_owner_id FROM depannhome_group_company_seat_allocations WHERE group_id=$1 FOR UPDATE", [groupId]);
            const seats = await groupSeatStatus(client, groupId);
            const currentAllocation = seats?.companies.find(item => String(item.id) === String(companyId));
            if (!currentAllocation) { await client.query("ROLLBACK"); return res.status(409).json({ message: "Allocation de postes introuvable." }); }
            const currentProfile = await groupCompanyProfile(groupId, companyId, client);
            const profile = validateGroupCompanyProfile(req.body, currentProfile);
            if (!profile.ok) { await client.query("ROLLBACK"); return res.status(400).json({ message: profile.message }); }
            const name = profile.companyName;
            const isActive = typeof req.body?.isActive === "boolean" ? req.body.isActive : company.isActive;
            const allocatedPcSeats = req.body?.allocatedPcSeats === undefined ? currentAllocation.allocatedPcSeats : limit(req.body.allocatedPcSeats, 1, 100);
            const allocatedMobileSeats = req.body?.allocatedMobileSeats === undefined ? currentAllocation.allocatedMobileSeats : limit(req.body.allocatedMobileSeats, 0, 500);
            if (allocatedPcSeats === null || allocatedMobileSeats === null) { await client.query("ROLLBACK"); return res.status(400).json({ message: "La répartition de postes est invalide." }); }
            const usage = await companySeatState(client, companyId);
            const requiredPcSeats = Math.max(Number(usage?.activePcUsers) || 0, Number(usage?.approvedPcDevices) || 0);
            if (allocatedPcSeats < requiredPcSeats || allocatedMobileSeats < Number(usage?.activeMobileUsers || 0)) { await client.query("ROLLBACK"); return res.status(409).json({ message: "L’allocation ne peut pas être inférieure aux postes actuellement utilisés par cette entreprise." }); }
            const addedPcSeats = Math.max(0, allocatedPcSeats - currentAllocation.allocatedPcSeats);
            const addedMobileSeats = Math.max(0, allocatedMobileSeats - currentAllocation.allocatedMobileSeats);
            const transferablePcSeats = currentAllocation.isPrincipal ? 0 : seats.transferablePrincipalPcSeats;
            const transferableMobileSeats = currentAllocation.isPrincipal ? 0 : seats.transferablePrincipalMobileSeats;
            if (addedPcSeats > seats.availablePcSeats + transferablePcSeats || addedMobileSeats > seats.availableMobileSeats + transferableMobileSeats) { await client.query("ROLLBACK"); return res.status(409).json({ message: "Cette répartition dépasse les postes disponibles ou inutilisés de l’entreprise principale." }); }
            const transferredPcSeats = Math.max(0, addedPcSeats - seats.availablePcSeats);
            const transferredMobileSeats = Math.max(0, addedMobileSeats - seats.availableMobileSeats);
            if (!isActive && String(companyId) === getAccountOwnerId(req)) { await client.query("ROLLBACK"); return res.status(400).json({ message: "Changez d’entreprise active avant de désactiver celle-ci." }); }
            if (transferredPcSeats || transferredMobileSeats) await client.query("UPDATE depannhome_group_company_seat_allocations SET allocated_pc_seats=allocated_pc_seats-$2,allocated_mobile_seats=allocated_mobile_seats-$3,updated_at=NOW() WHERE group_id=$1 AND company_owner_id=$4", [groupId, transferredPcSeats, transferredMobileSeats, seats.principalCompanyId]);
            await client.query("UPDATE depannhome_group_company_seat_allocations SET allocated_pc_seats=$3,allocated_mobile_seats=$4,updated_at=NOW() WHERE group_id=$1 AND company_owner_id=$2", [groupId, companyId, allocatedPcSeats, allocatedMobileSeats]);
            await client.query("UPDATE depannhome_group_companies SET is_active=$3,updated_at=NOW() WHERE group_id=$1 AND company_owner_id=$2", [groupId, companyId, isActive]);
            await client.query("UPDATE depannhome_users SET company_name=$2,full_name=$3,phone=$4,email=$5,is_active=$6,updated_at=NOW() WHERE id=$1 AND account_owner_id=id", [companyId, name, profile.fullName, profile.phone, profile.email, isActive]);
            await client.query(`INSERT INTO depannhome_billing_profiles(owner_id,company_name,legal_form,address,postal_code,city,phone,email,country,registration_number,siren)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                ON CONFLICT(owner_id) DO UPDATE SET company_name=EXCLUDED.company_name,legal_form=EXCLUDED.legal_form,address=EXCLUDED.address,postal_code=EXCLUDED.postal_code,city=EXCLUDED.city,phone=EXCLUDED.phone,email=EXCLUDED.email,country=EXCLUDED.country,registration_number=EXCLUDED.registration_number,siren=EXCLUDED.siren,updated_at=NOW()`,
            [companyId, name, profile.legalForm, profile.address, profile.postalCode, profile.city, profile.phone, profile.email, profile.country, profile.registrationNumber, profile.siren]);
            const allocationChanged = allocatedPcSeats !== currentAllocation.allocatedPcSeats || allocatedMobileSeats !== currentAllocation.allocatedMobileSeats;
            const profileChanged = ["companyName", "fullName", "phone", "email", "legalForm", "address", "postalCode", "city", "country", "registrationNumber", "siren"].some(key => profile[key] !== currentProfile[key]);
            await audit(client, { groupId, companyId, actorId: req.user.sub, action: allocationChanged ? "group_seats_rebalanced" : profileChanged ? "company_updated" : isActive ? "company_activated" : "company_deactivated", details: { companyName: name, previousCompanyName: company.companyName, isActive, previousIsActive: company.isActive, profileChanged, allocatedPcSeats, allocatedMobileSeats, previousAllocatedPcSeats: currentAllocation.allocatedPcSeats, previousAllocatedMobileSeats: currentAllocation.allocatedMobileSeats, transferredPcSeats, transferredMobileSeats }, ip: req.ip });
            await client.query("COMMIT");
            res.status(204).end();
        } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }));
    app.delete("/api/groups/companies/:companyId", requireGroupAdministrator, asyncHandler(async (req, res) => {
        const companyId = positiveId(req.params.companyId); const groupId = req.user.groupId;
        if (!companyId) return res.status(400).json({ message: "Entreprise invalide." });
        const client = await getPool().connect();
        try {
            await client.query("BEGIN");
            const company = await groupCompanyProfile(groupId, companyId, client, true);
            if (!company) { await client.query("ROLLBACK"); return res.status(404).json({ message: "Entreprise introuvable dans ce groupe." }); }
            if (company.isPrincipal) { await client.query("ROLLBACK"); return res.status(403).json({ message: "L’entreprise principale ne peut pas être supprimée du Groupe." }); }
            await lockGroupSeatAllocation(client, groupId);
            await audit(client, { groupId, companyId, actorId: req.user.sub, action: "company_removed", details: { companyName: company.companyName, archived: true }, ip: req.ip });
            await client.query("DELETE FROM depannhome_group_company_seat_allocations WHERE group_id=$1 AND company_owner_id=$2", [groupId, companyId]);
            await client.query("DELETE FROM depannhome_group_companies WHERE group_id=$1 AND company_owner_id=$2", [groupId, companyId]);
            await client.query("UPDATE depannhome_organizations SET interface_type='standard',license_type='depannhome_standard',updated_at=NOW() WHERE account_owner_id=$1", [companyId]);
            const archived = await client.query("UPDATE depannhome_users SET is_archived=TRUE,is_active=FALSE,archived_at=NOW(),archived_by=$2,updated_at=NOW() WHERE id=$1 AND account_owner_id=id AND is_archived=FALSE", [companyId, req.user.sub]);
            if (!archived.rowCount) { await client.query("ROLLBACK"); return res.status(409).json({ message: "Cette entreprise est déjà archivée." }); }
            await client.query("UPDATE depannhome_auth_devices SET status='rejected',session_id=NULL,verification_code_hash='',verification_code_expires_at=NULL,verification_attempts=0 WHERE user_id IN (SELECT id FROM depannhome_users WHERE account_owner_id=$1)", [companyId]);
            await client.query("INSERT INTO depannhome_account_lifecycle_audit(account_owner_id,actor_id,action,reason) VALUES($1,$2,'archived',$3)", [companyId, req.user.sub, clean(req.body?.reason, 500) || "Entreprise supprimée du pilotage Groupe par l’administrateur principal."]);
            await client.query("COMMIT");
            res.json({ removed: true, archived: true, releasedPcSeats: company.allocatedPcSeats, releasedMobileSeats: company.allocatedMobileSeats });
        } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }));
    app.put("/api/groups/active-company", requireGroupCompanySwitchAccess, asyncHandler(async (req, res) => {
        const companyId = positiveId(req.body?.companyId); const company = await groupCompany(req.user.groupId, companyId);
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

export async function configurePrincipalGroup(database, { ownerId, companyName, maxCompanies, totalPcSeats, totalMobileSeats, actorId }) {
    const membership = await database.query(`
        SELECT company.group_id AS "groupId",entitlement.principal_company_owner_id AS "principalCompanyId"
        FROM depannhome_group_companies company
        LEFT JOIN depannhome_group_entitlements entitlement ON entitlement.group_id=company.group_id
        WHERE company.company_owner_id=$1 FOR UPDATE OF company
    `, [ownerId]);
    if (membership.rows[0]?.principalCompanyId && String(membership.rows[0].principalCompanyId) !== String(ownerId)) {
        throw clientError(409, "Cette entreprise est rattachée à l’abonnement d’une autre entreprise principale.");
    }
    let groupId = membership.rows[0]?.groupId;
    if (!groupId) {
        const group = await database.query("INSERT INTO depannhome_groups(name,created_by) VALUES($1,$2) RETURNING id", [companyName, actorId]);
        groupId = group.rows[0].id;
        await database.query("INSERT INTO depannhome_group_companies(group_id,company_owner_id) VALUES($1,$2)", [groupId, ownerId]);
        await database.query("INSERT INTO depannhome_group_administrators(group_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [groupId, ownerId]);
    }
    await lockGroupSeatAllocation(database, groupId);
    const current = await groupSeatStatus(database, groupId);
    if (current && (maxCompanies < current.companyCount || totalPcSeats < current.allocatedPcSeats || totalMobileSeats < current.allocatedMobileSeats)) {
        throw clientError(409, "L’enveloppe du groupe ne peut pas être inférieure au nombre d’entreprises ou aux postes déjà répartis.");
    }
    await database.query(`
        INSERT INTO depannhome_group_entitlements(group_id,principal_company_owner_id,max_companies,total_pc_seats,total_mobile_seats)
        VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(group_id) DO UPDATE SET max_companies=EXCLUDED.max_companies,total_pc_seats=EXCLUDED.total_pc_seats,
            total_mobile_seats=EXCLUDED.total_mobile_seats,updated_at=NOW()
    `, [groupId, ownerId, maxCompanies, totalPcSeats, totalMobileSeats]);
    await database.query(`
        INSERT INTO depannhome_group_company_seat_allocations(group_id,company_owner_id,allocated_pc_seats,allocated_mobile_seats)
        VALUES($1,$2,$3,$4) ON CONFLICT(group_id,company_owner_id) DO NOTHING
    `, [groupId, ownerId, totalPcSeats, totalMobileSeats]);
    await database.query("UPDATE depannhome_users SET max_group_companies=$2 WHERE id=$1", [ownerId, maxCompanies]);
    return groupId;
}

async function lockGroupSeatAllocation(database, groupId) {
    await database.query("SELECT group_id FROM depannhome_group_entitlements WHERE group_id=$1 FOR UPDATE", [groupId]);
    await database.query("SELECT company_owner_id FROM depannhome_group_company_seat_allocations WHERE group_id=$1 FOR UPDATE", [groupId]);
}

async function groupContext(groupId, activeCompanyId) {
    const { rows } = await getPool().query(`SELECT group_data.id,group_data.name,group_data.shared_partner_directory_enabled AS "sharedPartnerDirectoryEnabled",company.company_owner_id AS id,company.is_active AS "isActive",owner.company_name AS "companyName",owner.full_name AS "administratorName",company.company_owner_id=entitlement.principal_company_owner_id AS "isPrincipal" FROM depannhome_groups group_data JOIN depannhome_group_companies company ON company.group_id=group_data.id JOIN depannhome_group_entitlements entitlement ON entitlement.group_id=group_data.id JOIN depannhome_users owner ON owner.id=company.company_owner_id WHERE group_data.id=$1 AND group_data.is_active=TRUE ORDER BY LOWER(owner.company_name),owner.id`, [groupId]);
    const group = rows[0] ? { id: String(rows[0].id), name: rows[0].name, sharedPartnerDirectoryEnabled: rows[0].sharedPartnerDirectoryEnabled } : null;
    return { group, companies: rows.map(row => ({ id: String(row.id), companyName: row.companyName || row.administratorName || "Entreprise", administratorName: row.administratorName || "", isActive: row.isActive, isPrincipal: row.isPrincipal })), activeCompanyId: String(activeCompanyId || "") };
}

async function groupCompany(groupId, companyId, lock = false, database = getPool()) { const { rows } = await database.query(`SELECT company.company_owner_id AS id,company.is_active AS "isActive",owner.company_name AS "companyName" FROM depannhome_group_companies company JOIN depannhome_users owner ON owner.id=company.company_owner_id WHERE company.group_id=$1 AND company.company_owner_id=$2${lock ? " FOR UPDATE OF company, owner" : ""}`, [groupId, companyId]); return rows[0] || null; }
async function groupCompanyProfile(groupId, companyId, database = getPool(), lock = false) { const { rows } = await database.query(`SELECT owner.id,owner.username,owner.full_name AS "fullName",COALESCE(NULLIF(profile.email,''),owner.email) AS email,COALESCE(NULLIF(profile.phone,''),owner.phone) AS phone,company.is_active AS "isActive",company.company_owner_id=entitlement.principal_company_owner_id AS "isPrincipal",allocation.allocated_pc_seats AS "allocatedPcSeats",allocation.allocated_mobile_seats AS "allocatedMobileSeats",COALESCE(NULLIF(profile.company_name,''),NULLIF(owner.company_name,''),owner.full_name,owner.username) AS "companyName",COALESCE(profile.legal_form,'') AS "legalForm",COALESCE(profile.address,'') AS address,COALESCE(profile.postal_code,'') AS "postalCode",COALESCE(profile.city,'') AS city,COALESCE(profile.country,'France') AS country,COALESCE(profile.registration_number,'') AS "registrationNumber",COALESCE(profile.siren,'') AS siren FROM depannhome_group_companies company JOIN depannhome_group_entitlements entitlement ON entitlement.group_id=company.group_id JOIN depannhome_group_company_seat_allocations allocation ON allocation.group_id=company.group_id AND allocation.company_owner_id=company.company_owner_id JOIN depannhome_users owner ON owner.id=company.company_owner_id LEFT JOIN depannhome_billing_profiles profile ON profile.owner_id=owner.id WHERE company.group_id=$1 AND company.company_owner_id=$2${lock ? " FOR UPDATE OF company, owner, allocation" : ""}`, [groupId, companyId]); return rows[0] || null; }
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
async function requireGroupAdministrator(req, res, next) { const organization = await getOrganization(getAccountOwnerId(req)); if (isCompanyAdministrator(req) && req.user?.isGroupAdministrator && req.user?.groupId && organization.interfaceType === "group" && organization.subscriptionTier === "pro") return next(); return res.status(403).json({ message: "Accès réservé au Poste Admin d’une organisation Groupe Pro." }); }
async function requireGroupCompanySwitchAccess(req, res, next) { const organization = await getOrganization(getAccountOwnerId(req)); if (hasGroupCompanySwitchAccess({ ...req.user, organization })) return next(); return res.status(403).json({ message: "Vous n’êtes pas autorisé à changer d’entreprise dans ce groupe." }); }
export function validateGroupCompanyInput(value) {
    const companyName = clean(value?.companyName, 160);
    const fullName = clean(value?.fullName, 100);
    const phone = clean(value?.phone, 30);
    const email = clean(value?.email, 160).toLowerCase();
    const username = clean(value?.username, 32).toLowerCase();
    const password = String(value?.password || "");
    const allocatedPcSeats = limit(value?.allocatedPcSeats ?? value?.maxPcUsers, 1, 100);
    const allocatedMobileSeats = limit(value?.allocatedMobileSeats ?? value?.maxTechnicians, 0, 500);
    if (!companyName) return { ok: false, message: "Le nom de l’entreprise est obligatoire." };
    if (!fullName) return { ok: false, message: "Le nom de l’administrateur principal est obligatoire." };
    if (!USERNAME_PATTERN.test(username)) return { ok: false, message: "L’identifiant administrateur doit contenir 3 à 32 caractères : lettres minuscules, chiffres, point, tiret ou souligné." };
    if (password.length < MIN_PASSWORD_LENGTH) return { ok: false, message: `Le mot de passe initial doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères.` };
    if (email && !EMAIL_PATTERN.test(email)) return { ok: false, message: "L’adresse e-mail de l’administrateur est invalide." };
    if (!allocatedPcSeats) return { ok: false, message: "Attribuez au moins un poste PC à la nouvelle entreprise." };
    if (allocatedMobileSeats === null) return { ok: false, message: "Le nombre de postes mobiles est invalide." };
    return { ok: true, companyName, fullName, phone, email, username, password, allocatedPcSeats, allocatedMobileSeats };
}
function clean(value, maximum) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximum); }
function positiveId(value) { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : 0; }
function limit(value, minimum, maximum) { const valueNumber = Number(value); return Number.isSafeInteger(valueNumber) && valueNumber >= minimum && valueNumber <= maximum ? valueNumber : null; }
function date(value) { return strictDateOnly(value); }
function tierLabel(value) { return value === "basic" ? "Basic" : value === "basic_plus" ? "Basic+" : "Pro"; }
export function groupActivationAccessError(owner, organization) { if (organization?.interfaceType === "partner") return "Un compte Partenaire gratuit ne peut pas activer le mode Groupe."; if (owner?.subscription_plan !== "paid" || owner?.subscription_tier !== "pro") return "Le mode Groupe est inclus uniquement dans l’offre Pro payante."; return ""; }
export function validateGroupCompanyProfile(value = {}, current = {}) { const profile = { companyName: clean(value.companyName ?? current.companyName, 160), fullName: clean(value.fullName ?? current.fullName, 100), email: clean(value.email ?? current.email, 160).toLowerCase(), phone: clean(value.phone ?? current.phone, 30), legalForm: clean(value.legalForm ?? current.legalForm, 100), address: clean(value.address ?? current.address, 255), postalCode: clean(value.postalCode ?? current.postalCode, 20), city: clean(value.city ?? current.city, 100), country: clean(value.country ?? current.country, 100) || "France", registrationNumber: clean(value.registrationNumber ?? current.registrationNumber, 100), siren: clean(value.siren ?? current.siren, 20) }; if (!profile.companyName) return { ok: false, message: "Le nom de l’entreprise est obligatoire." }; if (!profile.fullName) return { ok: false, message: "Le nom de l’administrateur principal est obligatoire." }; if (profile.email && !EMAIL_PATTERN.test(profile.email)) return { ok: false, message: "L’adresse e-mail de l’administrateur est invalide." }; return { ok: true, ...profile }; }
function asyncHandler(handler) { return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next); }
