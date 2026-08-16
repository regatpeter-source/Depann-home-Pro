import crypto from "node:crypto";
import { getPool } from "./database.js";
import { getAccountOwnerId } from "./auth.js";
import { listClientsForOwner } from "./clients.js";
import { createEmptyLeakContent } from "./leak-report-template.js";
import { createNotification } from "./collaboration.js";
import { recordMissionDialogueEvent } from "./partner-dialogue.js";

const PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const STATUSES = new Set(["received", "pending_validation", "accepted", "rejected", "assigned", "scheduled", "en_route", "on_site", "report_in_progress", "report_completed", "report_validated", "quote_sent", "quote_accepted", "work_completed", "invoice_sent", "closed", "cancelled"]);
const ASSIGNMENT_MODES = new Set(["manual", "suggested", "automatic"]);
const BILLING_MODES = new Set(["direct_client", "principal"]);
const PARTNER_MANAGEMENT_ROLES = new Set(["admin", "pc_standard", "mobile_admin"]);
const MAX_PAYLOAD_BYTES = 20 * 1024 * 1024;
const MAX_RETRY_ATTEMPTS = 5;
const CLIENT_ID_PATTERN = /^client-[a-zA-Z0-9-]+$/;

export async function initializePartnerMissions() {
    const db = getPool();
    await db.query(`CREATE TABLE IF NOT EXISTS depannhome_partner_intakes (
        id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
        partner_key VARCHAR(64) NOT NULL, partner_name VARCHAR(160) NOT NULL, api_key_hash VARCHAR(128) NOT NULL,
        callback_url VARCHAR(1000) NOT NULL DEFAULT '', assignment_mode VARCHAR(20) NOT NULL DEFAULT 'manual',
        rules JSONB NOT NULL DEFAULT '{}'::jsonb, enabled BOOLEAN NOT NULL DEFAULT TRUE, is_sandbox BOOLEAN NOT NULL DEFAULT FALSE, created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT depannhome_partner_intakes_owner_key_unique UNIQUE(owner_id, partner_key),
        CONSTRAINT depannhome_partner_intakes_api_key_unique UNIQUE(api_key_hash)
    )`);
    await db.query("ALTER TABLE depannhome_partner_intakes ADD COLUMN IF NOT EXISTS is_sandbox BOOLEAN NOT NULL DEFAULT FALSE");
    await db.query("CREATE INDEX IF NOT EXISTS depannhome_partner_intakes_owner_sandbox_idx ON depannhome_partner_intakes(owner_id,is_sandbox,updated_at DESC)");
    await db.query(`CREATE TABLE IF NOT EXISTS depannhome_partner_missions (
        id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
        intake_id BIGINT NOT NULL REFERENCES depannhome_partner_intakes(id) ON DELETE RESTRICT, external_mission_id VARCHAR(160) NOT NULL,
        mission_number VARCHAR(32) NOT NULL DEFAULT '', source_mission_number VARCHAR(64) NOT NULL DEFAULT '', intervention_number VARCHAR(64) NOT NULL DEFAULT '', deleted_at TIMESTAMPTZ,
        partner_reference VARCHAR(160) NOT NULL DEFAULT '', status VARCHAR(30) NOT NULL DEFAULT 'received', priority VARCHAR(20) NOT NULL DEFAULT 'normal',
        billing_mode VARCHAR(30) NOT NULL DEFAULT 'direct_client' CHECK (billing_mode IN ('direct_client','principal')),
        planning_draft JSONB NOT NULL DEFAULT '{}'::jsonb,
        source_data JSONB NOT NULL DEFAULT '{}'::jsonb, mapped_data JSONB NOT NULL DEFAULT '{}'::jsonb, validation_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
        client_id VARCHAR(100) NOT NULL DEFAULT '', calendar_event_id BIGINT REFERENCES depannhome_calendar_events(id) ON DELETE SET NULL,
        technical_report_id BIGINT REFERENCES depannhome_technical_reports(id) ON DELETE SET NULL, assigned_technician_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
        scheduled_date DATE, scheduled_start_time TIME, scheduled_end_time TIME, retry_count INTEGER NOT NULL DEFAULT 0, next_retry_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT depannhome_partner_missions_unique UNIQUE(owner_id, intake_id, external_mission_id)
    )`);
    await db.query("ALTER TABLE depannhome_partner_missions ADD COLUMN IF NOT EXISTS billing_mode VARCHAR(30) NOT NULL DEFAULT 'direct_client'");
    await db.query("ALTER TABLE depannhome_partner_missions ADD COLUMN IF NOT EXISTS planning_draft JSONB NOT NULL DEFAULT '{}'::jsonb");
    await db.query("ALTER TABLE depannhome_partner_missions ADD COLUMN IF NOT EXISTS mission_number VARCHAR(32) NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ");
    await db.query("ALTER TABLE depannhome_partner_missions ADD COLUMN IF NOT EXISTS source_mission_number VARCHAR(64) NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS intervention_number VARCHAR(64) NOT NULL DEFAULT ''");
    await db.query("UPDATE depannhome_partner_missions SET mission_number='MP-' || TO_CHAR(created_at AT TIME ZONE 'Europe/Paris','YYYY') || '-' || LPAD(id::text,6,'0') WHERE mission_number=''");
    await db.query("UPDATE depannhome_partner_missions SET source_mission_number=CASE WHEN source_mission_number='' THEN mission_number ELSE source_mission_number END,intervention_number=CASE WHEN intervention_number='' THEN 'INT-' || TO_CHAR(created_at AT TIME ZONE 'Europe/Paris','YYYY') || '-' || LPAD(id::text,6,'0') ELSE intervention_number END WHERE source_mission_number='' OR intervention_number=''");
    await db.query("CREATE UNIQUE INDEX IF NOT EXISTS depannhome_partner_missions_number_unique ON depannhome_partner_missions(mission_number) WHERE mission_number<>''");
    await db.query("ALTER TABLE depannhome_partner_missions DROP CONSTRAINT IF EXISTS depannhome_partner_missions_billing_mode_check");
    await db.query("ALTER TABLE depannhome_partner_missions ADD CONSTRAINT depannhome_partner_missions_billing_mode_check CHECK (billing_mode IN ('direct_client','principal'))");
    await db.query("CREATE INDEX IF NOT EXISTS depannhome_partner_missions_owner_status_idx ON depannhome_partner_missions(owner_id, status, created_at DESC)");
    await db.query("UPDATE depannhome_calendar_events event SET client_id=mission.client_id FROM depannhome_partner_missions mission WHERE mission.calendar_event_id=event.id AND mission.owner_id=event.owner_id AND event.client_id='' AND mission.client_id<>''");
    await db.query(`CREATE TABLE IF NOT EXISTS depannhome_partner_mission_history (
        id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
        mission_id BIGINT NOT NULL REFERENCES depannhome_partner_missions(id) ON DELETE CASCADE, status VARCHAR(30) NOT NULL, action VARCHAR(80) NOT NULL,
        actor_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL, actor_role VARCHAR(30) NOT NULL DEFAULT '', details JSONB NOT NULL DEFAULT '{}'::jsonb,
        ip_address VARCHAR(100) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.query("CREATE INDEX IF NOT EXISTS depannhome_partner_mission_history_mission_idx ON depannhome_partner_mission_history(mission_id, created_at DESC)");
    await db.query(`CREATE TABLE IF NOT EXISTS depannhome_partner_mission_outbox (
        id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
        mission_id BIGINT NOT NULL REFERENCES depannhome_partner_missions(id) ON DELETE CASCADE, event_type VARCHAR(80) NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb, status VARCHAR(20) NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        last_error VARCHAR(1000) NOT NULL DEFAULT '', next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), delivered_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.query("CREATE INDEX IF NOT EXISTS depannhome_partner_mission_outbox_pending_idx ON depannhome_partner_mission_outbox(status, next_attempt_at)");
}

export function registerPartnerMissionRoutes(app, requireAuthentication) {
    app.post("/api/partner-intake/:partnerKey", asyncHandler(receiveMission));
    app.use("/api/partner-missions", requireAuthentication, requireMissionAccess);
    app.get("/api/partner-missions", asyncHandler(async (req, res) => {
        const ownerId = getAccountOwnerId(req);
        await getPool().query("UPDATE depannhome_partner_missions SET planning_draft='{}'::jsonb WHERE owner_id=$1 AND status NOT IN ('received','pending_validation') AND planning_draft<>'{}'::jsonb", [ownerId]);
        res.json(await missionDashboard(ownerId, req));
    }));
    app.get("/api/partner-missions/intakes", requireAdministration, asyncHandler(async (req, res) => res.json({ intakes: await intakes(getAccountOwnerId(req)) })));
    app.use("/api/partner-missions/:missionId", asyncHandler(requireProductionMission));
    app.get("/api/partner-missions/:missionId", asyncHandler(async (req, res) => { const mission = await findMission(getAccountOwnerId(req), positiveId(req.params.missionId), req); if (!mission) return res.status(404).json({ message: "Mission introuvable." }); res.json({ mission, history: await history(mission.id), technicians: canManagePartnerMissions(req) ? await technicians(getAccountOwnerId(req)) : [] }); }));
    app.post("/api/partner-missions/:missionId/accept", requireAdministration, asyncHandler(async (req, res) => { const mission = await acceptMission(req, positiveId(req.params.missionId)); await getPool().query("UPDATE depannhome_partner_missions SET planning_draft='{}'::jsonb WHERE id=$1 AND owner_id=$2", [mission.id, getAccountOwnerId(req)]); mission.planningDraft = {}; await notifyManagedMissionSource(getAccountOwnerId(req), mission, "Mission acceptée"); res.json({ mission }); }));
    app.post("/api/partner-missions/:missionId/reject", requireAdministration, asyncHandler(async (req, res) => { const mission = await changeStatus(req, positiveId(req.params.missionId), "rejected", { reason: clean(req.body?.reason, 500) }); res.json({ mission }); }));
    app.post("/api/partner-missions/:missionId/close", requireAdministration, asyncHandler(async (req, res) => { const mission = await changeStatus(req, positiveId(req.params.missionId), "closed", { reason: clean(req.body?.reason, 500) }); res.json({ mission }); }));
    app.post("/api/partner-missions/:missionId/reopen", requireAdministration, asyncHandler(async (req, res) => res.json({ mission: await reopenClosedMission(req, positiveId(req.params.missionId)) })));
    app.post("/api/partner-missions/:missionId/archive-closed", requireAdministration, asyncHandler(async (req, res) => res.json({ mission: await archiveClosedMission(req, positiveId(req.params.missionId)) })));
    app.post("/api/partner-missions/:missionId/assign", requireAdministration, asyncHandler(async (req, res) => { const mission = await assignMission(req, positiveId(req.params.missionId)); res.json({ mission }); }));
    app.patch("/api/partner-missions/:missionId/planning-draft", requireAdministration, asyncHandler(async (req, res) => {
        const id = positiveId(req.params.missionId);
        const draft = sanitizePlanningDraft(req.body);
        if (!id) return res.status(400).json({ message: "Mission invalide." });
        if (draft.startTime && draft.endTime && draft.endTime <= draft.startTime) return res.status(400).json({ message: "L’heure de fin doit être postérieure à l’heure de début." });
        const ownerId = getAccountOwnerId(req);
        if (draft.assignedTechnicianIds.length) {
            const members = await getPool().query("SELECT id FROM depannhome_users WHERE account_owner_id=$1 AND is_active=TRUE AND id=ANY($2::bigint[])", [ownerId, draft.assignedTechnicianIds]);
            if (members.rowCount !== draft.assignedTechnicianIds.length) return res.status(400).json({ message: "Un membre sélectionné ne fait plus partie de l’entreprise." });
        }
        const { rows } = await getPool().query("UPDATE depannhome_partner_missions SET planning_draft=$3::jsonb,updated_at=NOW() WHERE id=$1 AND owner_id=$2 AND status IN ('received','pending_validation') RETURNING status", [id, ownerId, JSON.stringify(draft)]);
        if (!rows[0]) return res.status(409).json({ message: "Cette mission ne peut plus être mise en pause." });
        res.json({ planningDraft: draft, message: "Planification mise en pause." });
    }));
    app.patch("/api/partner-missions/:missionId/billing-mode", requireAdministration, asyncHandler(async (req, res) => { const billingMode = BILLING_MODES.has(req.body?.billingMode) ? req.body.billingMode : ""; if (!billingMode) return res.status(400).json({ message: "Type de facturation invalide." }); const mission = await updateBillingMode(req, positiveId(req.params.missionId), billingMode); res.json({ mission }); }));
    app.post("/api/partner-missions/:missionId/status", requireMissionAccess, asyncHandler(async (req, res) => { const status = String(req.body?.status || ""); if (!STATUSES.has(status)) return res.status(400).json({ message: "Statut de mission invalide." }); const mission = await changeStatus(req, positiveId(req.params.missionId), status, { note: clean(req.body?.note, 1000) }); res.json({ mission }); }));
    app.post("/api/partner-missions/archive-terminal", requireAdministration, asyncHandler(async (req, res) => res.json(await archiveTerminalMissions(req))));
    app.post("/api/partner-missions/outbox/retry", requireAdministration, asyncHandler(async (req, res) => res.json(await deliverOutbox(getAccountOwnerId(req)))));
    app.post("/api/partner-missions/intakes", requireAdministration, asyncHandler(async (req, res) => { const intake = sanitizeIntake(req.body); if (!intake.ok) return res.status(400).json({ message: intake.message }); const key = crypto.randomBytes(32).toString("base64url"); const { rows } = await getPool().query("INSERT INTO depannhome_partner_intakes(owner_id,partner_key,partner_name,api_key_hash,callback_url,assignment_mode,rules,created_by) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING id", [getAccountOwnerId(req), intake.key, intake.name, hash(key), intake.callbackUrl, intake.assignmentMode, JSON.stringify(intake.rules), req.user.sub]); res.status(201).json({ id: rows[0].id, partnerKey: intake.key, apiKey: key, endpoint: `/api/partner-intake/${intake.key}` }); }));
    app.patch("/api/partner-missions/intakes/:intakeId", requireAdministration, asyncHandler(async (req, res) => { const intake = sanitizeIntake(req.body); if (!intake.ok) return res.status(400).json({ message: intake.message }); const result = await getPool().query("UPDATE depannhome_partner_intakes SET partner_key=$3,partner_name=$4,callback_url=$5,assignment_mode=$6,rules=$7::jsonb,enabled=$8,updated_at=NOW() WHERE id=$1 AND owner_id=$2", [positiveId(req.params.intakeId), getAccountOwnerId(req), intake.key, intake.name, intake.callbackUrl, intake.assignmentMode, JSON.stringify(intake.rules), req.body?.enabled !== false]); if (!result.rowCount) return res.status(404).json({ message: "Partenaire introuvable." }); res.json({ message: "Connexion API enregistrée." }); }));
    app.delete("/api/partner-missions/intakes/:intakeId", requireAdministration, asyncHandler(async (req, res) => { const result = await getPool().query("DELETE FROM depannhome_partner_intakes intake WHERE intake.id=$1 AND intake.owner_id=$2 AND NOT EXISTS(SELECT 1 FROM depannhome_partner_missions mission WHERE mission.intake_id=intake.id)", [positiveId(req.params.intakeId), getAccountOwnerId(req)]); if (!result.rowCount) return res.status(409).json({ message: "Cette connexion est introuvable ou possède déjà des missions. Désactivez-la dans ce cas pour préserver l’historique." }); res.status(204).end(); }));
    app.post("/api/partner-missions/intakes/:intakeId/test", requireAdministration, asyncHandler(async (req, res) => { const { rows } = await getPool().query("SELECT partner_name,partner_key,callback_url,enabled FROM depannhome_partner_intakes WHERE id=$1 AND owner_id=$2", [positiveId(req.params.intakeId), getAccountOwnerId(req)]); const intake = rows[0]; if (!intake) return res.status(404).json({ message: "Partenaire introuvable." }); if (!intake.enabled) return res.status(409).json({ message: "Activez cette connexion avant son contrôle." }); res.json({ ok: true, endpoint: `/api/partner-intake/${intake.partner_key}`, callbackConfigured: Boolean(intake.callback_url), message: intake.callback_url ? "Connexion API prête : endpoint et URL de retour configurés." : "Endpoint API prêt. Ajoutez une URL de retour pour recevoir les changements de statut." }); }));
    app.post("/api/partner-missions/intakes/:intakeId/rotate-key", requireAdministration, asyncHandler(async (req, res) => { const key = crypto.randomBytes(32).toString("base64url"); const result = await getPool().query("UPDATE depannhome_partner_intakes SET api_key_hash=$3, updated_at=NOW() WHERE id=$1 AND owner_id=$2", [positiveId(req.params.intakeId), getAccountOwnerId(req), hash(key)]); if (!result.rowCount) return res.status(404).json({ message: "Partenaire introuvable." }); res.json({ apiKey: key }); }));
}

async function receiveMission(req, res) {
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : null;
    if (!body || Buffer.byteLength(JSON.stringify(body)) > MAX_PAYLOAD_BYTES) return res.status(400).json({ message: "Mission invalide ou trop volumineuse." });
    const key = clean(req.headers["x-api-key"], 300); const partnerKey = clean(req.params.partnerKey, 64).toLowerCase();
    if (!key) return res.status(401).json({ message: "Clé API partenaire manquante." });
    const { rows } = await getPool().query("SELECT intake.* FROM depannhome_partner_intakes intake JOIN depannhome_users owner ON owner.id=intake.owner_id WHERE intake.partner_key=$1 AND intake.enabled=TRUE AND owner.is_active=TRUE AND owner.is_archived=FALSE", [partnerKey]); const intake = rows[0];
    if (!intake || !safeEqual(hash(key), intake.api_key_hash)) return res.status(401).json({ message: "Partenaire ou clé API invalide." });
    if (intake.is_sandbox) {
        const fault = clean(req.headers["x-partner-sandbox-fault"], 30);
        if (fault === "403") return res.status(403).json({ message: "Accès Sandbox refusé pour ce scénario." });
        if (fault === "500") return res.status(500).json({ message: "Erreur Sandbox simulée." });
        if (fault === "unavailable") return res.status(503).json({ message: "Endpoint Sandbox temporairement indisponible." });
        if (fault === "timeout") { await new Promise(resolve => setTimeout(resolve, 2500)); return res.status(504).json({ message: "Délai Sandbox simulé." }); }
    }
    const mapped = mapPayload(body); mapped.clientName ||= clientNameFromPayload(body); if (!mapped.externalMissionId) return res.status(400).json({ message: "Le numéro de mission partenaire est obligatoire." });
    mapped.isSandbox = Boolean(intake.is_sandbox);
    const db = getPool(); const connection = await db.connect();
    try {
        await connection.query("BEGIN");
        tracePartnerClient("transaction_started", { flow: "partner_intake", ownerId: intake.owner_id, persistenceMode: "transaction" });
        const { rows: created } = await connection.query(`INSERT INTO depannhome_partner_missions(owner_id,intake_id,external_mission_id,partner_reference,status,priority,source_data,mapped_data,validation_errors,scheduled_date,scheduled_start_time,scheduled_end_time) VALUES($1,$2,$3,$4,'pending_validation',$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::date,$10::time,$11::time) ON CONFLICT(owner_id,intake_id,external_mission_id) DO UPDATE SET source_data=EXCLUDED.source_data,mapped_data=EXCLUDED.mapped_data,priority=EXCLUDED.priority,updated_at=NOW() RETURNING id,client_id,(xmax=0) AS inserted`, [intake.owner_id, intake.id, mapped.externalMissionId, mapped.partnerReference, mapped.priority, JSON.stringify(body), JSON.stringify(mapped), JSON.stringify(mapped.errors), mapped.date || null, mapped.startTime || null, mapped.endTime || null]);
        const mission = created[0];
        await ensureBusinessMissionNumber(connection, mission.id);
        const client = await provisionPartnerMissionClient(connection, intake.owner_id, mapped, req, mission.client_id);
        tracePartnerClient("provision_completed", { flow: "partner_intake", ownerId: intake.owner_id, missionId: mission.id, clientId: client.id, created: client.created });
        await connection.query("UPDATE depannhome_partner_missions SET client_id=$3,updated_at=NOW() WHERE id=$1 AND owner_id=$2", [mission.id, intake.owner_id, client.id]);
        await writeHistory(connection, intake.owner_id, mission.id, "pending_validation", mission.inserted ? "received" : "updated", null, "partner", { partnerKey, externalMissionId: mapped.externalMissionId, clientId: client.id, clientCreated: client.created }, req.ip);
        await connection.query("COMMIT");
        tracePartnerClient("transaction_committed", { flow: "partner_intake", ownerId: intake.owner_id, missionId: mission.id, clientId: client.id });
        await traceCommittedPartnerClient(intake.owner_id, client.id, { flow: "partner_intake", missionId: mission.id });
        await recordMissionDialogueEvent({ ownerId: intake.owner_id, missionId: mission.id, status: mission.inserted ? "received" : "pending_validation", action: mission.inserted ? "received" : "updated", details: { clientId: client.id, clientCreated: client.created }, actorName: intake.partner_name });
        if (mission.inserted) await recordMissionDialogueEvent({ ownerId: intake.owner_id, missionId: mission.id, status: "pending_validation", action: client.created ? "client_created" : "client_matched", details: { clientId: client.id }, actorName: intake.partner_name });
        if (!intake.is_sandbox) await notifyReceptionAdmins(intake.owner_id, mission.id, mapped, client.created, mission.inserted);
        res.status(mission.inserted ? 202 : 200).json({ accepted: true, missionId: mission.id, clientId: client.id, clientCreated: client.created, status: "pending_validation" });
    } catch (error) { tracePartnerClient("transaction_failed", { flow: "partner_intake", ownerId: intake?.owner_id || null, error: error.message }); try { await connection.query("ROLLBACK"); tracePartnerClient("transaction_rolled_back", { flow: "partner_intake", ownerId: intake?.owner_id || null }); } catch (rollbackError) { tracePartnerClient("transaction_rollback_failed", { flow: "partner_intake", ownerId: intake?.owner_id || null, error: rollbackError.message }); } throw error; } finally { connection.release(); }
}

async function acceptMission(req, id) { const ownerId = getAccountOwnerId(req); const db = getPool(), connection = await db.connect(); try { await connection.query("BEGIN"); tracePartnerClient("transaction_started", { flow: "mission_acceptance", ownerId, missionId: id, persistenceMode: "transaction" }); const mission = await lockMission(connection, ownerId, id); if (!mission) throw clientError(404, "Mission introuvable."); if (!["received", "pending_validation", "accepted"].includes(mission.status)) throw clientError(409, "Cette mission ne peut plus être acceptée."); const values = mission.mappedData; const technicianId = optionalId(req.body?.technicianId) || mission.assignedTechnicianId || (await selectTechnician(connection, ownerId, mission, mission.assignmentMode)); const clientId = await upsertClient(connection, ownerId, values, req, mission.client_id); tracePartnerClient("provision_completed", { flow: "mission_acceptance", ownerId, missionId: id, clientId, operation: mission.client_id ? "repaired_or_updated_linked_client" : "created_or_matched_client" }); const schedule = scheduleValues(req.body, mission); const eventId = await upsertCalendar(connection, ownerId, mission, values, technicianId, schedule, clientId); const reportId = await ensureLeakReport(connection, ownerId, mission, values, clientId, eventId, technicianId); const status = technicianId ? "scheduled" : "accepted"; const { rows } = await connection.query("UPDATE depannhome_partner_missions SET status=$3,client_id=$4,calendar_event_id=$5,technical_report_id=$6,assigned_technician_id=$7,scheduled_date=$8::date,scheduled_start_time=$9::time,scheduled_end_time=$10::time,updated_at=NOW() WHERE id=$1 AND owner_id=$2 RETURNING *", [id, ownerId, status, clientId, eventId, reportId || null, technicianId || null, schedule.date || null, schedule.startTime || null, schedule.endTime || null]); await writeHistory(connection, ownerId, id, status, "accepted", req.user.sub, req.user.role, { clientId, eventId, reportId, technicianId }, req.ip); await enqueue(connection, ownerId, id, "mission_accepted", { status, clientId, eventId, reportId }); await connection.query("COMMIT"); tracePartnerClient("transaction_committed", { flow: "mission_acceptance", ownerId, missionId: id, clientId }); await traceCommittedPartnerClient(ownerId, clientId, { flow: "mission_acceptance", missionId: id }); const actorName = req.user.fullName || req.user.username; await recordMissionDialogueEvent({ ownerId, missionId: id, status: "accepted", action: "accepted", details: { clientId, eventId, reportId }, actorName }); if (technicianId) await recordMissionDialogueEvent({ ownerId, missionId: id, status: "assigned", action: "assigned", details: { technicianId }, actorName }); if (schedule.date) await recordMissionDialogueEvent({ ownerId, missionId: id, status: "scheduled", action: "scheduled", details: { clientId, eventId, startTime: schedule.startTime }, actorName }); await notifyUsers(ownerId, rows[0], values, technicianId, "Mission acceptée"); return publicMission(rows[0]); } catch (error) { tracePartnerClient("transaction_failed", { flow: "mission_acceptance", ownerId, missionId: id, error: error.message }); try { await connection.query("ROLLBACK"); tracePartnerClient("transaction_rolled_back", { flow: "mission_acceptance", ownerId, missionId: id }); } catch (rollbackError) { tracePartnerClient("transaction_rollback_failed", { flow: "mission_acceptance", ownerId, missionId: id, error: rollbackError.message }); } throw error; } finally { connection.release(); } }
async function assignMission(req, id) { const mission = await findMission(getAccountOwnerId(req), id); if (!mission) throw clientError(404, "Mission introuvable."); return acceptMission({ ...req, body: { ...req.body, technicianId: req.body?.technicianId || mission.assignedTechnicianId } }, id); }
async function changeStatus(req, id, status, details) { const ownerId = getAccountOwnerId(req); if (!id) throw clientError(400, "Mission invalide."); const allowedTechnicianStatuses = new Set(["en_route", "on_site", "report_in_progress", "report_completed", "work_completed"]); if (isFieldUser(req) && !allowedTechnicianStatuses.has(status)) throw clientError(403, "Ce statut est réservé à l’administration."); return transitionPartnerMissionStatus({ ownerId, missionId: id, status, actorId: req.user.sub, actorRole: req.user.role, actorName: req.user.fullName || req.user.username, details, ip: req.ip, assignedTechnicianId: isFieldUser(req) ? req.user.sub : null }); }

export async function transitionPartnerMissionStatus({ ownerId, missionId, status, actorId = null, actorRole = "", actorName = "API partenaire", details = {}, ip = "", assignedTechnicianId = null }) {
    if (!ownerId || !missionId || !STATUSES.has(status)) throw clientError(400, "Mission ou statut invalide.");
    const { rows } = await getPool().query("UPDATE depannhome_partner_missions SET status=$3,updated_at=NOW() WHERE id=$1 AND owner_id=$2 AND ($4::bigint IS NULL OR assigned_technician_id=$4) RETURNING *", [missionId, ownerId, status, assignedTechnicianId]);
    if (!rows[0]) throw clientError(404, "Mission introuvable.");
    await writeHistory(getPool(), ownerId, missionId, status, "status_changed", actorId, actorRole, details, ip);
    await enqueue(getPool(), ownerId, missionId, "mission_status_changed", { status, ...details });
    await recordMissionDialogueEvent({ ownerId, missionId, status, action: "status_changed", details, actorName });
    if (rows[0].assigned_technician_id) await notifyUsers(ownerId, rows[0], rows[0].mapped_data || {}, rows[0].assigned_technician_id, `Mission : ${statusLabel(status)}`);
    const mission = publicMission(rows[0]);
    await notifyManagedMissionSource(ownerId, mission, `Mission : ${statusLabel(status)}`);
    return mission;
}

async function reopenClosedMission(req, id) {
    const ownerId = getAccountOwnerId(req);
    const { rows } = await getPool().query("UPDATE depannhome_partner_missions SET status=CASE WHEN calendar_event_id IS NULL THEN 'accepted' ELSE 'scheduled' END,updated_at=NOW() WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL AND status='closed' RETURNING *", [id, ownerId]);
    if (!rows[0]) throw clientError(409, "Seule une mission clôturée encore visible peut être rouverte.");
    const mission = publicMission(rows[0]); const details = { previousStatus: "closed", restoredStatus: mission.status, reason: clean(req.body?.reason, 500) };
    await writeHistory(getPool(), ownerId, id, mission.status, "reopened", req.user.sub, req.user.role, details, req.ip);
    await enqueue(getPool(), ownerId, id, "mission_status_changed", { status: mission.status, ...details });
    await recordMissionDialogueEvent({ ownerId, missionId: id, status: mission.status, action: "reopened", details, actorName: req.user.fullName || req.user.username });
    await notifyManagedMissionSource(ownerId, mission, "Mission rouverte");
    return mission;
}

async function archiveClosedMission(req, id) {
    const ownerId = getAccountOwnerId(req);
    const { rows } = await getPool().query("UPDATE depannhome_partner_missions SET deleted_at=NOW(),updated_at=NOW() WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL AND status='closed' RETURNING *", [id, ownerId]);
    if (!rows[0]) throw clientError(409, "Seule une mission clôturée encore visible peut être supprimée.");
    await writeHistory(getPool(), ownerId, id, "closed", "archived", req.user.sub, req.user.role, { reason: clean(req.body?.reason, 500) }, req.ip);
    return publicMission(rows[0]);
}

async function archiveTerminalMissions(req) {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(positiveId).filter(Boolean).slice(0, 100) : [];
    if (!ids.length) throw clientError(400, "Sélectionnez au moins une mission à supprimer.");
    const result = await getPool().query("UPDATE depannhome_partner_missions SET deleted_at=NOW(),updated_at=NOW() WHERE owner_id=$1 AND id=ANY($2::bigint[]) AND deleted_at IS NULL AND status IN ('rejected','cancelled')", [getAccountOwnerId(req), ids]);
    return { deletedCount: result.rowCount || 0 };
}

async function updateBillingMode(req, id, billingMode) { const ownerId = getAccountOwnerId(req); if (!id) throw clientError(400, "Mission invalide."); const { rows } = await getPool().query("UPDATE depannhome_partner_missions SET billing_mode=$3,updated_at=NOW() WHERE id=$1 AND owner_id=$2 RETURNING *", [id, ownerId, billingMode]); if (!rows[0]) throw clientError(404, "Mission introuvable."); await writeHistory(getPool(), ownerId, id, rows[0].status, "billing_mode_changed", req.user.sub, req.user.role, { billingMode }, req.ip); if (billingMode === "principal") { const { sharePrincipalBillingDocuments } = await import("./partner-dialogue.js"); await sharePrincipalBillingDocuments(ownerId, id); } else { const { hideDirectClientBillingDocuments } = await import("./partner-dialogue.js"); await hideDirectClientBillingDocuments(ownerId, id); } return publicMission(rows[0]); }

async function missionDashboard(ownerId, request) { await reconcileMissionClients(ownerId, request); const [missionRows, intakeRows, techRows, outbox] = await Promise.all([getPool().query(`SELECT mission.*, intake.partner_name AS "partnerName", intake.partner_key AS "partnerKey", intake.is_sandbox AS "isSandbox", technician.full_name AS "technicianName" FROM depannhome_partner_missions mission JOIN depannhome_partner_intakes intake ON intake.id=mission.intake_id LEFT JOIN depannhome_users technician ON technician.id=mission.assigned_technician_id WHERE mission.owner_id=$1 AND mission.deleted_at IS NULL AND intake.is_sandbox=FALSE ORDER BY mission.updated_at DESC LIMIT 200`, [ownerId]), intakes(ownerId), canManagePartnerMissions(request) ? technicians(ownerId) : Promise.resolve([]), getPool().query("SELECT count(*)::int AS count FROM depannhome_partner_mission_outbox outbox JOIN depannhome_partner_missions mission ON mission.id=outbox.mission_id JOIN depannhome_partner_intakes intake ON intake.id=mission.intake_id WHERE outbox.owner_id=$1 AND outbox.status='failed' AND intake.is_sandbox=FALSE", [ownerId])]); return { missions: missionRows.rows.map(publicMission), intakes: intakeRows, technicians: techRows, failedDeliveries: outbox.rows[0].count, statuses: [...STATUSES] }; }
async function reconcileMissionClients(ownerId, request) {
    const database = getPool(); const connection = await database.connect();
    try {
        await connection.query("BEGIN");
        const { rows: missions } = await connection.query(`
            SELECT mission.id,mission.client_id,mission.mapped_data
            FROM depannhome_partner_missions mission
            JOIN depannhome_partner_intakes intake ON intake.id=mission.intake_id
            LEFT JOIN depannhome_clients client ON client.owner_id=mission.owner_id AND client.client_id=mission.client_id
            WHERE mission.owner_id=$1 AND mission.deleted_at IS NULL AND intake.is_sandbox=FALSE
                AND (mission.client_id='' OR client.client_id IS NULL)
            FOR UPDATE OF mission
        `, [ownerId]);
        for (const mission of missions) {
            const client = await provisionPartnerMissionClient(connection, ownerId, mission.mapped_data || {}, request, mission.client_id);
            await connection.query("UPDATE depannhome_partner_missions SET client_id=$3,updated_at=NOW() WHERE id=$1 AND owner_id=$2", [mission.id, ownerId, client.id]);
            await connection.query("UPDATE depannhome_calendar_events SET client_id=$3,updated_at=NOW() WHERE owner_id=$1 AND partner_mission_id=$2", [ownerId, mission.id, client.id]);
        }
        await connection.query("COMMIT");
    } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
    } finally { connection.release(); }
}
async function intakes(ownerId) { const { rows } = await getPool().query("SELECT id,partner_key AS \"partnerKey\",partner_name AS \"partnerName\",callback_url AS \"callbackUrl\",assignment_mode AS \"assignmentMode\",rules,enabled,created_at AS \"createdAt\",updated_at AS \"updatedAt\" FROM depannhome_partner_intakes WHERE owner_id=$1 AND is_sandbox=FALSE ORDER BY partner_name", [ownerId]); return rows; }
async function findMission(ownerId, id, request = null) { if (!id) return null; const { rows } = await getPool().query("SELECT mission.*, intake.partner_name AS \"partnerName\", intake.partner_key AS \"partnerKey\", intake.assignment_mode AS \"assignmentMode\", intake.is_sandbox AS \"isSandbox\", technician.full_name AS \"technicianName\" FROM depannhome_partner_missions mission JOIN depannhome_partner_intakes intake ON intake.id=mission.intake_id LEFT JOIN depannhome_users technician ON technician.id=mission.assigned_technician_id WHERE mission.id=$1 AND mission.owner_id=$2 AND intake.is_sandbox=FALSE", [id, ownerId]); return rows[0] ? publicMission(rows[0]) : null; }
async function lockMission(connection, ownerId, id) { const { rows } = await connection.query("SELECT mission.*, intake.assignment_mode AS \"assignmentMode\" FROM depannhome_partner_missions mission JOIN depannhome_partner_intakes intake ON intake.id=mission.intake_id WHERE mission.id=$1 AND mission.owner_id=$2 AND intake.is_sandbox=FALSE FOR UPDATE", [id, ownerId]); return rows[0] ? { ...rows[0], mappedData: rows[0].mapped_data || {} } : null; }
async function history(id) { const { rows } = await getPool().query("SELECT history.status,history.action,history.actor_role AS \"actorRole\",history.details,history.created_at AS \"createdAt\",COALESCE(user_account.full_name,user_account.username,'Partenaire') AS \"actorName\" FROM depannhome_partner_mission_history history LEFT JOIN depannhome_users user_account ON user_account.id=history.actor_id WHERE history.mission_id=$1 ORDER BY history.created_at DESC", [id]); return rows; }
async function technicians(ownerId) { const { rows } = await getPool().query("SELECT id,COALESCE(full_name,username) AS \"fullName\",department,phone FROM depannhome_users WHERE account_owner_id=$1 AND role IN ('technician','team_lead','mobile_admin') AND is_active=TRUE ORDER BY full_name", [ownerId]); return rows; }

async function upsertClient(connection, ownerId, data, req, linkedClientId = "") { return (await provisionPartnerMissionClient(connection, ownerId, data, req, linkedClientId)).id; }

export async function provisionPartnerMissionClient(connection, ownerId, data, req = {}, linkedClientId = "") {
    tracePartnerClient("provision_called", { ownerId });
    const { rows } = await connection.query("SELECT client_id,client_data FROM depannhome_clients WHERE owner_id=$1 FOR UPDATE", [ownerId]);
    const row = rows.find(item => String(item.client_id) === String(linkedClientId || ""));
    const now = new Date().toISOString();
    const clientId = row?.client_id || (CLIENT_ID_PATTERN.test(String(linkedClientId || "")) ? String(linkedClientId) : `client-${crypto.randomUUID()}`);
    const old = row?.client_data || {};
    const attachments = mergeAttachments(old.attachments, data.attachments);
    const activity = mergePartnerMissionActivityHistory(old.activityHistory, data, req, now);
    const client = { ...old, id: clientId, isSandbox: Boolean(data.isSandbox || old.isSandbox), name: data.clientName || old.name || "Client partenaire", firstName: data.firstName || old.firstName || "", lastName: data.lastName || old.lastName || "", address: data.address || old.address || "", interventionAddress: data.interventionAddress || old.interventionAddress || data.address || "", city: data.city || old.city || "", phone: data.phone || old.phone || "", email: data.email || old.email || "", insurance: data.insurance || old.insurance || "", principal: data.principal || old.principal || "", claimNumber: data.claimNumber || old.claimNumber || "", expert: data.expert || old.expert || "", manager: data.manager || old.manager || "", gps: data.gps || old.gps || "", notes: mergeText(old.notes, data.description, data.comments), attachments, activityHistory: activity, createdAt: old.createdAt || now, updatedAt: now };
    const saved = await connection.query("INSERT INTO depannhome_clients(owner_id,client_id,client_data,updated_at) VALUES($1,$2,$3::jsonb,NOW()) ON CONFLICT(owner_id,client_id) DO UPDATE SET client_data=EXCLUDED.client_data,updated_at=NOW() RETURNING client_id", [ownerId, clientId, JSON.stringify(client)]);
    if (saved.rows[0]?.client_id !== clientId) throw new Error("La fiche client partenaire n’a pas pu être enregistrée.");
    tracePartnerClient("upsert_succeeded", { ownerId, clientId, operation: row ? "update_existing_match" : "insert_new", rowCount: saved.rowCount });
    const verification = await connection.query("SELECT client_id FROM depannhome_clients WHERE owner_id=$1 AND client_id=$2", [ownerId, clientId]);
    if (!verification.rows[0]) throw new Error("La fiche client partenaire est absente de la base de données de l’entreprise destinataire.");
    tracePartnerClient("sql_verification", { ownerId, clientId, exists: Boolean(verification.rows[0]) });
    return { id: clientId, created: !row };
}

export async function traceCommittedPartnerClient(ownerId, clientId, context = {}) {
    if (!partnerClientTraceEnabled() || !ownerId || !clientId) return;
    try {
        tracePartnerClient("post_persistence_verification_started", { ...context, ownerId, clientId });
        const { rows } = await getPool().query("SELECT client_id FROM depannhome_clients WHERE owner_id=$1 AND client_id=$2", [ownerId, clientId]);
        tracePartnerClient("committed_sql_verification", { ...context, ownerId, clientId, exists: Boolean(rows[0]) });
        const clientsApiPayload = await listClientsForOwner(ownerId);
        tracePartnerClient("clients_api_verification", { ...context, ownerId, clientId, returned: clientsApiPayload.clients.some(client => String(client?.id) === String(clientId)), returnedClientCount: clientsApiPayload.clients.length, cursor: clientsApiPayload.cursor });
    } catch (error) {
        tracePartnerClient("post_commit_verification_failed", { ...context, ownerId, clientId, error: error.message });
    }
}

function partnerClientTraceEnabled() { return process.env.PARTNER_CLIENT_TRACE !== "false"; }
export function tracePartnerClient(step, details) { if (partnerClientTraceEnabled()) console.log("[partner-client-trace]", JSON.stringify({ at: new Date().toISOString(), step, ...details })); }

async function upsertCalendar(connection, ownerId, mission, data, technicianId, schedule, clientId = "") { if (!schedule.date) return null; const notes = [`Mission partenaire : ${mission.partner_reference || data.interventionType || "Intervention"}`, data.description, data.comments, data.gps?.latitude ? `GPS : ${data.gps.latitude}, ${data.gps.longitude}` : ""].filter(Boolean).join("\n").slice(0, 2000); const title = `${data.interventionType || "Intervention"} · ${data.priority === "urgent" ? "URGENT · " : ""}${data.clientName}`.slice(0, 160); if (mission.calendar_event_id) { await connection.query("UPDATE depannhome_calendar_events SET assigned_technician_id=$3,title=$4,client_id=$5,client_name=$6,location=$7,event_date=$8::date,start_time=$9::time,end_time=$10::time,event_origin='partner_mission',partner_mission_id=$11,notes=$12,updated_at=NOW() WHERE id=$1 AND owner_id=$2", [mission.calendar_event_id, ownerId, technicianId || null, title, clientId, data.clientName, data.address, schedule.date, schedule.startTime || null, schedule.endTime || null, mission.id, notes]); return mission.calendar_event_id; } const { rows } = await connection.query("INSERT INTO depannhome_calendar_events(owner_id,assigned_technician_id,title,client_id,client_name,location,event_date,start_time,end_time,color,event_type,event_origin,partner_mission_id,notes) VALUES($1,$2,$3,$4,$5,$6,$7::date,$8::time,$9::time,$10,'appointment','partner_mission',$11,$12) RETURNING id", [ownerId, technicianId || null, title, clientId, data.clientName, data.address, schedule.date, schedule.startTime || null, schedule.endTime || null, data.priority === "urgent" ? "red" : data.priority === "high" ? "orange" : "blue", mission.id, notes]); if (technicianId) await connection.query("INSERT INTO depannhome_calendar_assignments(event_id,technician_id,is_primary) VALUES($1,$2,TRUE) ON CONFLICT DO NOTHING", [rows[0].id, technicianId]); return rows[0].id; }
async function ensureLeakReport(connection, ownerId, mission, data, clientId, eventId, technicianId) { if (!isLeak(data.interventionType) || !eventId) return null; if (mission.technical_report_id) return mission.technical_report_id; const year = new Date(mission.created_at || Date.now()).getFullYear(); const snapshot = { companyName: "", interventionNumber: mission.intervention_number || `INT-${year}-${String(mission.id).padStart(6, "0")}`, interventionReference: mission.source_mission_number || mission.mission_number || `MP-${year}-${String(mission.id).padStart(6, "0")}`, interventionType: data.interventionType, date: data.date, time: data.startTime, clientName: data.clientName, clientAddress: data.address, clientPhone: data.phone, clientEmail: data.email, technicianName: "", insurance: data.insurance, claimNumber: data.claimNumber, expert: data.expert, manager: data.manager }; const content = createEmptyLeakContent(snapshot); const { rows } = await connection.query("INSERT INTO depannhome_technical_reports(owner_id,created_by,appointment_id,client_id,report_type,title,report_date,content) VALUES($1,$2,$3,$4,'leak_detection','Rapport de recherche de fuite',$5::date,$6::jsonb) RETURNING id", [ownerId, technicianId || null, eventId, clientId, data.date || new Date().toISOString().slice(0, 10), JSON.stringify(content)]); return rows[0].id; }
async function selectTechnician(connection, ownerId, mission, mode) { if (mode !== "automatic") return null; const { rows } = await connection.query(`SELECT user_account.id FROM depannhome_users user_account WHERE user_account.account_owner_id=$1 AND user_account.role IN ('technician','team_lead','mobile_admin') AND user_account.is_active=TRUE ORDER BY (SELECT count(*) FROM depannhome_calendar_assignments assignment JOIN depannhome_calendar_events event ON event.id=assignment.event_id WHERE assignment.technician_id=user_account.id AND event.event_date>=CURRENT_DATE) ASC, user_account.id LIMIT 1`, [ownerId]); return rows[0]?.id || null; }
function scheduleValues(body, mission) { return { date: validDate(body?.date || mission.scheduled_date || mission.mappedData?.date), startTime: validTime(body?.startTime || mission.scheduled_start_time || mission.mappedData?.startTime), endTime: validTime(body?.endTime || mission.scheduled_end_time || mission.mappedData?.endTime) }; }
async function notifyReceptionAdmins(ownerId, missionId, data, clientCreated, inserted) { const title = inserted ? "Nouvelle mission reçue" : "Mission partenaire mise à jour"; const body = clientCreated ? "Le client a été créé automatiquement dans votre base de données. Vous pouvez commencer l’intervention immédiatement." : "Client existant détecté. La mission a été rattachée automatiquement à sa fiche."; const { rows } = await getPool().query("SELECT id FROM depannhome_users WHERE account_owner_id=$1 AND role IN ('admin','pc_standard','mobile_admin') AND is_active=TRUE", [ownerId]); await Promise.all(rows.map(row => createNotification(ownerId, row.id, "partner_mission_received", { entityType: "partner_mission", entityId: String(missionId) }, title, body, { missionId, priority: data.priority, clientCreated: Boolean(clientCreated) }))); }
async function notifyAdmins(ownerId, missionId, data, title) { const { rows } = await getPool().query("SELECT id FROM depannhome_users WHERE account_owner_id=$1 AND role IN ('admin','pc_standard','mobile_admin') AND is_active=TRUE", [ownerId]); await Promise.all(rows.map(row => createNotification(ownerId, row.id, "partner_mission_received", { entityType: "partner_mission", entityId: String(missionId) }, title, `${data.clientName || "Client"} · ${data.address || "Adresse non renseignée"}`, { missionId, priority: data.priority }))); }
async function notifyUsers(ownerId, mission, data, technicianId, title) { await notifyAdmins(ownerId, mission.id, data, title); }
async function notifyManagedMissionSource(ownerId, mission, title) { const { rows } = await getPool().query(`SELECT connection.company_low_id AS "lowId",connection.company_high_id AS "highId" FROM depannhome_partner_missions mission JOIN depannhome_partner_intakes intake ON intake.id=mission.intake_id JOIN depannhome_partner_connections connection ON intake.partner_key=('connection-' || connection.id::text) AND connection.status='connected' WHERE mission.owner_id=$1 AND mission.id=$2`, [ownerId, mission.id]); const connection = rows[0]; if (!connection) return; const sourceOwnerId = Number(connection.lowId) === Number(ownerId) ? Number(connection.highId) : Number(connection.lowId); const recipients = await getPool().query("SELECT id FROM depannhome_users WHERE account_owner_id=$1 AND role IN ('admin','pc_standard','mobile_admin') AND is_active=TRUE", [sourceOwnerId]); await Promise.all(recipients.rows.map(row => createNotification(sourceOwnerId, row.id, "partner_mission_status", { entityType: "partner_mission", entityId: String(mission.id) }, title, `${mission.partnerName || "Partenaire"} · ${statusLabel(mission.status)}`, { missionId: mission.id, status: mission.status, calendarEventId: mission.calendarEventId }))); }
async function enqueue(connection, ownerId, missionId, type, payload) { await connection.query("INSERT INTO depannhome_partner_mission_outbox(owner_id,mission_id,event_type,payload) VALUES($1,$2,$3,$4::jsonb)", [ownerId, missionId, type, JSON.stringify(payload)]); }
async function deliverOutbox(ownerId, sandboxOnly = false) { const { rows } = await getPool().query(`SELECT outbox.*, intake.callback_url AS "callbackUrl", mission.external_mission_id AS "externalMissionId" FROM depannhome_partner_mission_outbox outbox JOIN depannhome_partner_missions mission ON mission.id=outbox.mission_id JOIN depannhome_partner_intakes intake ON intake.id=mission.intake_id JOIN depannhome_users owner ON owner.id=outbox.owner_id WHERE outbox.owner_id=$1 AND owner.is_active=TRUE AND owner.is_archived=FALSE AND intake.is_sandbox=$2 AND outbox.status IN ('pending','failed') AND outbox.next_attempt_at<=NOW() ORDER BY outbox.created_at LIMIT 30`, [ownerId, sandboxOnly]); let delivered = 0; for (const item of rows) { if (!item.callbackUrl) { await getPool().query("UPDATE depannhome_partner_mission_outbox SET status='skipped',last_error='Aucune URL de retour configurée.' WHERE id=$1", [item.id]); continue; } try { const response = await fetch(item.callbackUrl, { method: "POST", headers: { "Content-Type": "application/json", "X-DepannHome-Event": item.event_type }, body: JSON.stringify({ event: item.event_type, missionId: item.externalMissionId, ...item.payload }), signal: AbortSignal.timeout(15000) }); if (!response.ok) throw new Error(`HTTP ${response.status}`); await getPool().query("UPDATE depannhome_partner_mission_outbox SET status='delivered',attempts=attempts+1,delivered_at=NOW(),last_error='' WHERE id=$1", [item.id]); delivered += 1; } catch (error) { const attempts = item.attempts + 1, status = attempts >= MAX_RETRY_ATTEMPTS ? "failed" : "pending"; await getPool().query("UPDATE depannhome_partner_mission_outbox SET status=$2,attempts=$3,last_error=$4,next_attempt_at=NOW()+($5::text || ' minutes')::interval WHERE id=$1", [item.id, status, attempts, clean(error.message, 1000), String(Math.min(60, 2 ** attempts))]); } } return { processed: rows.length, delivered }; }
export async function deliverPartnerMissionOutbox(ownerId, options = {}) { return deliverOutbox(ownerId, options.sandboxOnly === true); }
async function writeHistory(connection, ownerId, missionId, status, action, actorId, actorRole, details, ip) { await connection.query("INSERT INTO depannhome_partner_mission_history(owner_id,mission_id,status,action,actor_id,actor_role,details,ip_address) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)", [ownerId, missionId, status, action, actorId || null, actorRole || "", JSON.stringify(details || {}), String(ip || "").slice(0, 100)]); }
function mapPayload(value) { const client = value.client && typeof value.client === "object" ? value.client : value.customer && typeof value.customer === "object" ? value.customer : {}; const address = value.address && typeof value.address === "object" ? value.address : {}; const source = { ...value, ...client }; const date = validDate(value.scheduledDate || value.date || value.requestedWindow?.date || ""); const priority = priorityOf(value.urgency || value.priority); const firstName = clean(source.firstName || source.firstname || source.prenom || source["prénom"], 100); const lastName = clean(source.lastName || source.lastname || source.nom, 100); return { externalMissionId: clean(value.missionNumber || value.missionId || value.id || value.reference, 160), partnerReference: clean(value.partnerReference || value.caseNumber || value.reference, 160), date, startTime: validTime(value.startTime || value.requestedWindow?.startTime), endTime: validTime(value.endTime || value.requestedWindow?.endTime), priority, interventionType: clean(value.interventionType || value.type || value.serviceType, 160), clientName: clean(source.name || source.fullName || [firstName, lastName].filter(Boolean).join(" "), 160), firstName, lastName, address: clean(typeof value.address === "string" ? value.address : address.street || value.location, 255), interventionAddress: clean(value.interventionAddress || value.workAddress || value.location, 255), city: clean(source.city || address.city, 100), phone: clean(source.phone || source.mobile, 50), email: clean(source.email, 160), insurance: clean(value.insurance || value.insurer, 160), principal: clean(value.principal || value.orderingParty || value.donor || value.manager, 160), claimNumber: clean(value.claimNumber || value.claim || value.sinisterNumber, 160), expert: clean(value.expert, 160), manager: clean(value.manager || value.caseManager, 160), description: clean(value.description || value.problemDescription || value.breakdownDescription, 2000), comments: clean(value.comments || value.notes, 2000), gps: value.gps && typeof value.gps === "object" ? { latitude: clean(value.gps.latitude, 30), longitude: clean(value.gps.longitude, 30) } : {}, attachments: Array.isArray(value.attachments) ? value.attachments.slice(0, 5) : [], errors: [] }; }
function sanitizeIntake(value) { const name = clean(value?.partnerName, 160), key = slug(value?.partnerKey || name), callbackUrl = safeUrl(value?.callbackUrl); const assignmentMode = ASSIGNMENT_MODES.has(value?.assignmentMode) ? value.assignmentMode : "manual"; return name && key ? { ok: true, name, key, callbackUrl, assignmentMode, rules: value?.rules && typeof value.rules === "object" ? value.rules : {} } : { ok: false, message: "Nom et identifiant partenaire obligatoires." }; }
function sanitizePlanningDraft(value) {
    const assignedTechnicianIds = [...new Set((Array.isArray(value?.assignedTechnicianIds) ? value.assignedTechnicianIds : []).map(optionalId).filter(Boolean))].slice(0, 30);
    const assignedTechnicianId = optionalId(value?.assignedTechnicianId);
    if (assignedTechnicianId && !assignedTechnicianIds.includes(assignedTechnicianId)) assignedTechnicianIds.unshift(assignedTechnicianId);
    return {
        title: clean(value?.title, 160),
        location: clean(value?.location, 255),
        date: validDate(value?.date),
        startTime: validTime(value?.startTime),
        endTime: validTime(value?.endTime),
        color: ["blue", "green", "orange", "red", "purple", "gray"].includes(value?.color) ? value.color : "blue",
        notes: clean(value?.notes, 2000),
        assignedTechnicianId: assignedTechnicianId || assignedTechnicianIds[0] || 0,
        assignedTechnicianIds,
        billingMode: BILLING_MODES.has(value?.billingMode) ? value.billingMode : "direct_client",
        pausedAt: new Date().toISOString()
    };
}
export async function ensureBusinessMissionNumber(connection, missionId) { const { rows } = await connection.query("UPDATE depannhome_partner_missions SET mission_number=CASE WHEN mission_number='' THEN 'MP-' || TO_CHAR(created_at AT TIME ZONE 'Europe/Paris','YYYY') || '-' || LPAD(id::text,6,'0') ELSE mission_number END,source_mission_number=CASE WHEN source_mission_number='' THEN 'MP-' || TO_CHAR(created_at AT TIME ZONE 'Europe/Paris','YYYY') || '-' || LPAD(id::text,6,'0') ELSE source_mission_number END,intervention_number=CASE WHEN intervention_number='' THEN 'INT-' || TO_CHAR(created_at AT TIME ZONE 'Europe/Paris','YYYY') || '-' || LPAD(id::text,6,'0') ELSE intervention_number END WHERE id=$1 RETURNING source_mission_number AS \"missionNumber\"", [missionId]); return rows[0]?.missionNumber || ""; }
function publicMission(row) { const year = new Date(row.created_at || Date.now()).getFullYear(); const generated = row.mission_number || `MP-${year}-${String(row.id).padStart(6, "0")}`; return { id: row.id, intakeId: row.intake_id, sourceType: String(row.partnerKey || row.partner_key || "").startsWith("connection-") ? "depannhome_network" : "external_connector", isSandbox: Boolean(row.isSandbox || row.is_sandbox), missionNumber: row.source_mission_number || generated, internalMissionNumber: generated, interventionNumber: row.intervention_number || `INT-${year}-${String(row.id).padStart(6, "0")}`, externalMissionId: row.external_mission_id, partnerReference: row.partner_reference, partnerName: row.partnerName, status: row.status, priority: row.priority, billingMode: row.billing_mode || "direct_client", planningDraft: row.planning_draft || row.planningDraft || {}, mappedData: row.mapped_data || row.mappedData || {}, validationErrors: row.validation_errors || [], clientId: row.client_id, calendarEventId: row.calendar_event_id, technicalReportId: row.technical_report_id, assignedTechnicianId: row.assigned_technician_id, technicianName: row.technicianName, scheduledDate: row.scheduled_date, scheduledStartTime: row.scheduled_start_time, scheduledEndTime: row.scheduled_end_time, createdAt: row.created_at, updatedAt: row.updated_at }; }
function isFieldUser(req) { return false; }
function canManagePartnerMissions(req) { return PARTNER_MANAGEMENT_ROLES.has(req?.user?.role); }
function requireMissionAccess(req, res, next) { if (canManagePartnerMissions(req)) return next(); return res.status(403).json({ message: "Les missions partenaires sont réservées à l’administration." }); }
async function requireProductionMission(req, res, next) { const missionId = positiveId(req.params.missionId); if (!missionId) return next(); const result = await getPool().query("SELECT mission.id FROM depannhome_partner_missions mission JOIN depannhome_partner_intakes intake ON intake.id=mission.intake_id WHERE mission.id=$1 AND mission.owner_id=$2 AND intake.is_sandbox=FALSE", [missionId, getAccountOwnerId(req)]); return result.rowCount ? next() : res.status(404).json({ message: "Mission introuvable." }); }
function requireAdministration(req, res, next) { if (canManagePartnerMissions(req)) return next(); return res.status(403).json({ message: "Cette action est réservée aux postes PC autorisés." }); }
function mergeAttachments(existing, incoming) { const base = Array.isArray(existing) ? existing : []; const added = (Array.isArray(incoming) ? incoming : []).filter(item => /^data:(image\/(jpeg|png|webp)|application\/(pdf|msword|vnd\.openxmlformats-officedocument\.wordprocessingml\.document|vnd\.ms-excel|vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet)|text\/plain);base64,[A-Za-z0-9+/=]+$/.test(String(item?.dataUrl || ""))).map(item => ({ id: `file-${crypto.randomUUID()}`, type: "Document partenaire", name: clean(item.name, 255) || "document-partenaire", mime: clean(item.mime, 150), size: Number(item.size) || 0, dataUrl: item.dataUrl, createdAt: new Date().toISOString() })); return [...base, ...added].slice(0, 30); }
function mergePartnerMissionActivityHistory(history, data, req, createdAt) {
    const detail = `${data.partnerReference || data.externalMissionId} · ${data.interventionType}`.slice(0, 500);
    const activities = Array.isArray(history) ? history : [];
    const duplicate = activities.some(activity => activity?.type === "partner_mission"
        && activity?.label === "Mission partenaire reçue"
        && String(activity?.detail || "") === detail);
    if (duplicate) return activities.slice(0, 150);
    return [{ id: `activity-${crypto.randomUUID()}`, type: "partner_mission", label: "Mission partenaire reçue", detail, actorName: req.user?.fullName || "API partenaire", createdAt }, ...activities].slice(0, 150);
}
function mergeText(...values) { return values.filter(Boolean).map(value => String(value).trim()).filter(Boolean).join("\n").slice(0, 2000); }
function isLeak(value) { return /fuite|infiltration|etancheite/i.test(String(value || "")); }
function priorityOf(value) { const raw = String(value || "").toLowerCase(); return /urgent|critique|critical/.test(raw) ? "urgent" : /high|haute|élevée/.test(raw) ? "high" : /low|faible/.test(raw) ? "low" : "normal"; }
function statusLabel(value) {
    return ({ received: "reçue", pending_validation: "en attente de validation", accepted: "acceptée", rejected: "refusée", assigned: "technicien affecté", scheduled: "rendez-vous planifié", en_route: "technicien en route", on_site: "technicien sur site", report_in_progress: "rapport en cours", report_completed: "rapport terminé", report_validated: "rapport validé", quote_sent: "devis envoyé", quote_accepted: "devis accepté", work_completed: "travaux terminés", invoice_sent: "facture envoyée", closed: "clôturée", cancelled: "annulée" })[value] || "statut mis à jour";
}
function validDate(value) { const text = String(value || "").slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(new Date(`${text}T12:00:00`).getTime()) ? text : ""; }
function validTime(value) { const text = String(value || "").slice(0, 5); return /^([01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : ""; }
function optionalId(value) { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : 0; }
function positiveId(value) { return optionalId(value); }
function clean(value, max) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, max); }
function clientNameFromPayload(value) { const client = value?.client && typeof value.client === "object" ? value.client : value?.customer && typeof value.customer === "object" ? value.customer : value || {}; return clean(client.fullName || client.name || [client.firstName || client.firstname || client.prenom || client["prénom"], client.lastName || client.lastname || client.nom].filter(Boolean).join(" "), 160); }
function slug(value) { return clean(value, 160).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64); }
function safeUrl(value) { try { const url = new URL(clean(value, 1000)); const host = url.hostname.toLowerCase(); const privateHost = ["localhost", "0.0.0.0", "::1"].includes(host) || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host); return /^https?:$/.test(url.protocol) && !privateHost ? url.toString() : ""; } catch { return ""; } }
function hash(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function safeEqual(first, second) { const a = Buffer.from(String(first)), b = Buffer.from(String(second)); return a.length === b.length && crypto.timingSafeEqual(a, b); }
function clientError(status, message) { const error = new Error(message); error.status = status; return error; }
function asyncHandler(handler) { return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(error => error.status ? res.status(error.status).json({ message: error.message }) : next(error)); }
