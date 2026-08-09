import crypto from "node:crypto";
import { getPool } from "./database.js";
import { deliverPartnerMissionOutbox, transitionPartnerMissionStatus } from "./partner-missions.js";
import {
    decryptSandboxSecret, encryptSandboxSecret, redactSandboxValue, SANDBOX_FAULTS,
    SANDBOX_PARTNER, sandboxHash, sandboxMissionPayload, sandboxStatus
} from "./partner-api-sandbox-policy.js";

export async function initializePartnerApiSandbox() {
    const db = getPool();
    await db.query(`CREATE TABLE IF NOT EXISTS depannhome_partner_api_sandboxes (
        id BIGSERIAL PRIMARY KEY,
        owner_id BIGINT NOT NULL UNIQUE REFERENCES depannhome_users(id) ON DELETE CASCADE,
        intake_id BIGINT NOT NULL UNIQUE REFERENCES depannhome_partner_intakes(id) ON DELETE CASCADE,
        api_key_cipher TEXT NOT NULL,
        callback_token_hash VARCHAR(64) NOT NULL UNIQUE,
        fault_mode VARCHAR(30) NOT NULL DEFAULT 'none',
        created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS depannhome_partner_api_sandbox_logs (
        id BIGSERIAL PRIMARY KEY,
        sandbox_id BIGINT NOT NULL REFERENCES depannhome_partner_api_sandboxes(id) ON DELETE CASCADE,
        owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
        direction VARCHAR(20) NOT NULL, method VARCHAR(12) NOT NULL DEFAULT 'POST', endpoint VARCHAR(1000) NOT NULL,
        http_status INTEGER, event_type VARCHAR(80) NOT NULL DEFAULT '', request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        response_payload JSONB NOT NULL DEFAULT '{}'::jsonb, error_message VARCHAR(1000) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.query("CREATE INDEX IF NOT EXISTS depannhome_partner_api_sandbox_logs_owner_idx ON depannhome_partner_api_sandbox_logs(owner_id,created_at DESC)");
}

export function registerPartnerApiSandboxRoutes(app, requireCreator) {
    app.post("/api/partner-sandbox/external-callback/:token", asyncHandler(receiveCallback));
    app.use("/api/creator/partner-api-sandbox", requireCreator);
    app.get("/api/creator/partner-api-sandbox", asyncHandler(async (_req, res) => res.json({ sandboxes: await listSandboxes(), partner: SANDBOX_PARTNER })));
    app.post("/api/creator/partner-api-sandbox/provision", asyncHandler(async (req, res) => {
        const ownerId = positiveId(req.body?.ownerId);
        if (!ownerId || !(await accountOwner(ownerId))) return res.status(404).json({ message: "Organisation cible introuvable." });
        const existing = await sandboxForOwner(ownerId);
        if (existing) return res.json({ sandbox: await publicSandbox(existing, false), created: false });
        const apiKey = crypto.randomBytes(32).toString("base64url");
        const callbackToken = crypto.randomBytes(32).toString("base64url");
        const partnerKey = `${SANDBOX_PARTNER.keyPrefix}-${ownerId}`.slice(0, 64);
        const callbackUrl = absoluteUrl(`/api/partner-sandbox/external-callback/${callbackToken}`);
        const connection = await getPool().connect();
        try {
            await connection.query("BEGIN");
            const intakeResult = await connection.query(`INSERT INTO depannhome_partner_intakes
                (owner_id,partner_key,partner_name,api_key_hash,callback_url,assignment_mode,rules,enabled,is_sandbox,created_by)
                VALUES($1,$2,$3,$4,$5,'manual',$6::jsonb,TRUE,TRUE,$7) RETURNING id`,
            [ownerId, partnerKey, SANDBOX_PARTNER.name, sandboxHash(apiKey), callbackUrl, JSON.stringify({ sandbox: true, managedBy: "creator_partner_api_sandbox" }), req.user.sub]);
            const { rows } = await connection.query(`INSERT INTO depannhome_partner_api_sandboxes
                (owner_id,intake_id,api_key_cipher,callback_token_hash,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *`,
            [ownerId, intakeResult.rows[0].id, encryptSandboxSecret(apiKey, masterSecret()), sandboxHash(callbackToken), req.user.sub]);
            await connection.query("COMMIT");
            res.status(201).json({ sandbox: { ...await publicSandbox(rows[0], false), apiKey }, created: true });
        } catch (error) {
            await connection.query("ROLLBACK");
            if (error.code === "23505") return res.status(409).json({ message: "La Sandbox existe déjà ou son identifiant partenaire est utilisé." });
            throw error;
        } finally { connection.release(); }
    }));
    app.post("/api/creator/partner-api-sandbox/:ownerId/rotate-key", asyncHandler(async (req, res) => {
        const sandbox = await requiredSandbox(req.params.ownerId); const apiKey = crypto.randomBytes(32).toString("base64url");
        await getPool().query("UPDATE depannhome_partner_intakes SET api_key_hash=$2,updated_at=NOW() WHERE id=$1", [sandbox.intake_id, sandboxHash(apiKey)]);
        await getPool().query("UPDATE depannhome_partner_api_sandboxes SET api_key_cipher=$2,updated_at=NOW() WHERE id=$1", [sandbox.id, encryptSandboxSecret(apiKey, masterSecret())]);
        res.json({ apiKey, message: "Clé API Sandbox renouvelée. L’ancienne clé est immédiatement invalide." });
    }));
    app.post("/api/creator/partner-api-sandbox/:ownerId/send", asyncHandler(async (req, res) => {
        const sandbox = await requiredSandbox(req.params.ownerId);
        const scenario = SANDBOX_FAULTS.has(req.body?.scenario) ? req.body.scenario : "none";
        const payload = req.body?.payload && typeof req.body.payload === "object" ? req.body.payload : sandboxMissionPayload();
        const result = await sendMission(req, sandbox, payload, scenario);
        res.status(result.ok ? 200 : 422).json(result);
    }));
    app.post("/api/creator/partner-api-sandbox/:ownerId/status", asyncHandler(async (req, res) => {
        const sandbox = await requiredSandbox(req.params.ownerId); const missionId = positiveId(req.body?.missionId); const status = sandboxStatus(req.body?.status);
        if (!missionId || !status) return res.status(400).json({ message: "Mission ou statut Sandbox invalide." });
        const allowed = await getPool().query("SELECT mission.id FROM depannhome_partner_missions mission JOIN depannhome_partner_intakes intake ON intake.id=mission.intake_id WHERE mission.id=$1 AND mission.owner_id=$2 AND intake.is_sandbox=TRUE", [missionId, sandbox.owner_id]);
        if (!allowed.rowCount) return res.status(404).json({ message: "Mission Sandbox introuvable." });
        const mission = await transitionPartnerMissionStatus({ ownerId: sandbox.owner_id, missionId, status, actorId: req.user.sub, actorRole: "creator", actorName: req.user.fullName || req.user.username, details: { sandbox: true, externalStatus: req.body.status }, ip: req.ip });
        const delivery = await deliverPartnerMissionOutbox(sandbox.owner_id, { sandboxOnly: true });
        res.json({ mission, delivery });
    }));
    app.patch("/api/creator/partner-api-sandbox/:ownerId/fault", asyncHandler(async (req, res) => {
        const sandbox = await requiredSandbox(req.params.ownerId); const mode = SANDBOX_FAULTS.has(req.body?.mode) ? req.body.mode : "none";
        await getPool().query("UPDATE depannhome_partner_api_sandboxes SET fault_mode=$2,updated_at=NOW() WHERE id=$1", [sandbox.id, mode]);
        res.json({ mode });
    }));
    app.get("/api/creator/partner-api-sandbox/:ownerId", asyncHandler(async (req, res) => {
        const sandbox = await requiredSandbox(req.params.ownerId);
        res.json({ sandbox: await publicSandbox(sandbox, false), missions: await sandboxMissions(sandbox.owner_id), logs: await sandboxLogs(sandbox.owner_id) });
    }));
    app.delete("/api/creator/partner-api-sandbox/:ownerId", asyncHandler(async (req, res) => {
        const sandbox = await requiredSandbox(req.params.ownerId); await resetSandbox(sandbox); res.status(204).end();
    }));
}

async function sendMission(req, sandbox, inputPayload, scenario) {
    const intake = (await getPool().query("SELECT partner_key FROM depannhome_partner_intakes WHERE id=$1 AND is_sandbox=TRUE", [sandbox.intake_id])).rows[0];
    if (!intake) throw clientError(409, "Connexion API Sandbox absente.");
    const apiKey = decryptSandboxSecret(sandbox.api_key_cipher, masterSecret());
    const payload = scenario === "400" || scenario === "missing_mission" ? { ...inputPayload, missionNumber: "", missionId: "", id: "", reference: "" } : inputPayload;
    const endpointPath = scenario === "404" ? `/api/partner-intake-introuvable/${intake.partner_key}` : `/api/partner-intake/${intake.partner_key}`;
    const endpoint = absoluteUrl(endpointPath); const headers = { "Content-Type": "application/json", "X-API-Key": scenario === "401" ? "invalid-sandbox-key" : apiKey };
    if (["403", "500", "timeout", "unavailable"].includes(scenario)) headers["X-Partner-Sandbox-Fault"] = scenario;
    const body = scenario === "invalid_json" ? "{invalid-json" : JSON.stringify(payload);
    const attempts = scenario === "duplicate" ? 2 : 1; const responses = [];
    for (let index = 0; index < attempts; index += 1) {
        let status = 0, responsePayload = {}, errorMessage = "";
        try {
            const response = await fetch(endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(scenario === "timeout" ? 1200 : 10_000) });
            status = response.status; responsePayload = await response.json().catch(() => ({ message: "Réponse non JSON." }));
        } catch (error) { errorMessage = error.name === "TimeoutError" ? "Délai d’attente Sandbox dépassé." : String(error.message || "Serveur indisponible."); }
        await logExchange(sandbox, "outbound", endpointPath, status || null, payload, responsePayload, errorMessage, "mission_submission");
        responses.push({ status, data: responsePayload, error: errorMessage });
    }
    const expected = scenario === "none" || scenario === "duplicate";
    return { ok: expected ? responses.every(item => [200, 202].includes(item.status)) : responses.some(item => item.status >= 400 || item.error), scenario, endpoint: endpointPath, responses };
}

async function receiveCallback(req, res) {
    const tokenHash = sandboxHash(req.params.token); const { rows } = await getPool().query("SELECT * FROM depannhome_partner_api_sandboxes WHERE callback_token_hash=$1", [tokenHash]); const sandbox = rows[0];
    if (!sandbox) return res.status(404).json({ message: "Webhook Sandbox introuvable." });
    const mode = sandbox.fault_mode || "none";
    if (mode === "timeout") { await new Promise(resolve => setTimeout(resolve, 2500)); await logExchange(sandbox, "inbound", req.originalUrl, 504, req.body, {}, "Délai webhook Sandbox simulé.", req.headers["x-depannhome-event"]); return res.status(504).json({ message: "Délai webhook Sandbox simulé." }); }
    if (mode === "500" || mode === "unavailable") { await logExchange(sandbox, "inbound", req.originalUrl, 500, req.body, {}, "Erreur webhook Sandbox simulée.", req.headers["x-depannhome-event"]); return res.status(500).json({ message: "Erreur webhook Sandbox simulée." }); }
    await logExchange(sandbox, "inbound", req.originalUrl, 200, req.body, { received: true }, "", req.headers["x-depannhome-event"]);
    res.json({ received: true, sandbox: true });
}

async function listSandboxes() {
    const { rows } = await getPool().query(`SELECT sandbox.*,COALESCE(NULLIF(profile.company_name,''),NULLIF(owner.company_name,''),owner.full_name,owner.username) AS "ownerName",intake.partner_key,intake.callback_url,intake.enabled
        FROM depannhome_partner_api_sandboxes sandbox JOIN depannhome_users owner ON owner.id=sandbox.owner_id LEFT JOIN depannhome_billing_profiles profile ON profile.owner_id=owner.id JOIN depannhome_partner_intakes intake ON intake.id=sandbox.intake_id ORDER BY "ownerName"`);
    return Promise.all(rows.map(row => publicSandbox(row, false)));
}
async function sandboxForOwner(ownerId) { const { rows } = await getPool().query("SELECT sandbox.*,intake.partner_key,intake.callback_url,intake.enabled FROM depannhome_partner_api_sandboxes sandbox JOIN depannhome_partner_intakes intake ON intake.id=sandbox.intake_id WHERE sandbox.owner_id=$1", [ownerId]); return rows[0] || null; }
async function requiredSandbox(ownerId) { const sandbox = await sandboxForOwner(positiveId(ownerId)); if (!sandbox) throw clientError(404, "Sandbox API introuvable pour cette organisation."); return sandbox; }
async function publicSandbox(row, includeSecret) { const owner = row.ownerName || (await accountOwner(row.owner_id))?.name || "Organisation"; return { id: row.id, ownerId: row.owner_id, ownerName: owner, intakeId: row.intake_id, partner: SANDBOX_PARTNER, partnerKey: row.partner_key, endpoint: `/api/partner-intake/${row.partner_key}`, callbackUrl: row.callback_url, enabled: row.enabled !== false, faultMode: row.fault_mode || "none", apiKey: includeSecret ? decryptSandboxSecret(row.api_key_cipher, masterSecret()) : "", createdAt: row.created_at, updatedAt: row.updated_at }; }
async function accountOwner(ownerId) { const { rows } = await getPool().query("SELECT id,COALESCE(NULLIF(company_name,''),full_name,username) AS name FROM depannhome_users WHERE id=$1 AND account_owner_id=id", [ownerId]); return rows[0] || null; }
async function sandboxMissions(ownerId) { const { rows } = await getPool().query(`SELECT mission.id,mission.mission_number AS "internalMissionNumber",mission.external_mission_id AS "externalMissionId",mission.partner_reference AS "partnerReference",mission.status,mission.priority,mission.client_id AS "clientId",mission.mapped_data AS "mappedData",mission.created_at AS "createdAt",mission.updated_at AS "updatedAt" FROM depannhome_partner_missions mission JOIN depannhome_partner_intakes intake ON intake.id=mission.intake_id WHERE mission.owner_id=$1 AND intake.is_sandbox=TRUE ORDER BY mission.created_at DESC LIMIT 100`, [ownerId]); return rows; }
async function sandboxLogs(ownerId) { const { rows } = await getPool().query(`SELECT id,direction,method,endpoint,http_status AS "httpStatus",event_type AS "eventType",request_payload AS "requestPayload",response_payload AS "responsePayload",error_message AS "errorMessage",created_at AS "createdAt" FROM depannhome_partner_api_sandbox_logs WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 200`, [ownerId]); return rows; }
async function logExchange(sandbox, direction, endpoint, status, requestPayload, responsePayload, errorMessage, eventType) { await getPool().query(`INSERT INTO depannhome_partner_api_sandbox_logs(sandbox_id,owner_id,direction,endpoint,http_status,event_type,request_payload,response_payload,error_message) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`, [sandbox.id, sandbox.owner_id, direction, String(endpoint).slice(0, 1000), status, String(eventType || "").slice(0, 80), JSON.stringify(redactSandboxValue(requestPayload || {})), JSON.stringify(redactSandboxValue(responsePayload || {})), String(errorMessage || "").slice(0, 1000)]); }
async function resetSandbox(sandbox) {
    const connection = await getPool().connect();
    try { await connection.query("BEGIN"); const clients = await connection.query("SELECT DISTINCT client_id FROM depannhome_partner_missions WHERE owner_id=$1 AND intake_id=$2 AND client_id<>''", [sandbox.owner_id, sandbox.intake_id]); await connection.query("DELETE FROM depannhome_partner_missions WHERE owner_id=$1 AND intake_id=$2", [sandbox.owner_id, sandbox.intake_id]); for (const row of clients.rows) await connection.query(`DELETE FROM depannhome_clients WHERE owner_id=$1 AND client_id=$2 AND client_data->>'isSandbox'='true'
        AND NOT EXISTS(SELECT 1 FROM depannhome_partner_missions WHERE owner_id=$1 AND client_id=$2)
        AND NOT EXISTS(SELECT 1 FROM depannhome_calendar_events WHERE owner_id=$1 AND client_id=$2)
        AND NOT EXISTS(SELECT 1 FROM depannhome_billing_documents WHERE owner_id=$1 AND client_id=$2)
        AND NOT EXISTS(SELECT 1 FROM depannhome_technical_reports WHERE owner_id=$1 AND client_id=$2)`, [sandbox.owner_id, row.client_id]); await connection.query("DELETE FROM depannhome_partner_api_sandboxes WHERE id=$1", [sandbox.id]); await connection.query("DELETE FROM depannhome_partner_intakes WHERE id=$1 AND owner_id=$2 AND is_sandbox=TRUE", [sandbox.intake_id, sandbox.owner_id]); await connection.query("COMMIT"); } catch (error) { await connection.query("ROLLBACK"); throw error; } finally { connection.release(); }
}
function absoluteUrl(pathname) { const base = String(process.env.PARTNER_SANDBOX_BASE_URL || `http://127.0.0.1:${Number(process.env.PORT || 3000)}`).replace(/\/+$/, ""); const url = new URL(pathname, `${base}/`); if (!/^https?:$/.test(url.protocol)) throw new Error("PARTNER_SANDBOX_BASE_URL doit utiliser HTTP ou HTTPS."); return url.toString(); }
function masterSecret() { const secret = process.env.SESSION_SECRET; if (!secret || secret.length < 32) throw new Error("SESSION_SECRET est requis pour chiffrer les identifiants Sandbox."); return secret; }
function positiveId(value) { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : 0; }
function clientError(status, message) { const error = new Error(message); error.status = status; return error; }
function asyncHandler(handler) { return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(error => error.status ? res.status(error.status).json({ message: error.message }) : next(error)); }
