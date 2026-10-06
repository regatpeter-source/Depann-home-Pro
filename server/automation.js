import { getPool } from "./database.js";
import { getAccountOwnerId } from "./auth.js";

const RULE_TYPES = new Set(["quote_follow_up", "contract_renewal", "maintenance_due", "low_stock"]);
const ADMIN_ROLES = new Set(["admin", "pc_standard", "mobile_admin"]);
let scheduler = null;

export function registerAutomationRoutes(app, requireAuthentication) {
    app.get("/api/automation/rules", requireAuthentication, requireManager, asyncHandler(async (request, response) => {
        const ownerId = getAccountOwnerId(request);
        const [rules, reminders, runs] = await Promise.all([
            getPool().query(`SELECT id,name,rule_type AS "ruleType",is_active AS "isActive",lead_days AS "leadDays",configuration,created_at AS "createdAt",updated_at AS "updatedAt" FROM depannhome_automation_rules WHERE owner_id=$1 ORDER BY name`, [ownerId]),
            getPool().query(`SELECT id,rule_id AS "ruleId",reminder_type AS "reminderType",entity_type AS "entityType",entity_id AS "entityId",title,details,due_at AS "dueAt",status,created_at AS "createdAt",completed_at AS "completedAt" FROM depannhome_internal_reminders WHERE owner_id=$1 ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END,due_at,id DESC LIMIT 300`, [ownerId]),
            getPool().query(`SELECT id,source,status,created_count AS "createdCount",error_code AS "errorCode",started_at AS "startedAt",completed_at AS "completedAt" FROM depannhome_automation_runs WHERE owner_id=$1 ORDER BY started_at DESC LIMIT 30`, [ownerId])
        ]);
        response.json({ rules: rules.rows, reminders: reminders.rows, runs: runs.rows });
    }));

    app.post("/api/automation/rules", requireAuthentication, requireManager, asyncHandler(async (request, response) => {
        const name = clean(request.body?.name, 160), ruleType = RULE_TYPES.has(request.body?.ruleType) ? request.body.ruleType : "";
        if (!name || !ruleType) return response.status(400).json({ message: "Nom ou type de règle invalide." });
        const { rows } = await getPool().query(`INSERT INTO depannhome_automation_rules(owner_id,name,rule_type,is_active,lead_days,configuration,created_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING id`, [getAccountOwnerId(request), name, ruleType, request.body?.isActive !== false, integer(request.body?.leadDays, 0, 365, 0), JSON.stringify(safeConfiguration(request.body?.configuration)), request.user.sub]);
        response.status(201).json({ id: rows[0].id });
    }));

    app.patch("/api/automation/rules/:ruleId", requireAuthentication, requireManager, asyncHandler(async (request, response) => {
        const ruleId = positiveId(request.params.ruleId), name = clean(request.body?.name, 160), ruleType = RULE_TYPES.has(request.body?.ruleType) ? request.body.ruleType : "";
        if (!ruleId || !name || !ruleType) return response.status(400).json({ message: "Règle invalide." });
        const result = await getPool().query(`UPDATE depannhome_automation_rules SET name=$3,rule_type=$4,is_active=$5,lead_days=$6,configuration=$7::jsonb,updated_at=NOW() WHERE id=$1 AND owner_id=$2`, [ruleId, getAccountOwnerId(request), name, ruleType, request.body?.isActive !== false, integer(request.body?.leadDays, 0, 365, 0), JSON.stringify(safeConfiguration(request.body?.configuration))]);
        if (!result.rowCount) return response.status(404).json({ message: "Règle introuvable." });
        response.status(204).end();
    }));

    app.delete("/api/automation/rules/:ruleId", requireAuthentication, requireManager, asyncHandler(async (request, response) => {
        const result = await getPool().query("DELETE FROM depannhome_automation_rules WHERE id=$1 AND owner_id=$2", [positiveId(request.params.ruleId), getAccountOwnerId(request)]);
        if (!result.rowCount) return response.status(404).json({ message: "Règle introuvable." });
        response.status(204).end();
    }));

    app.post("/api/automation/run", requireAuthentication, requireManager, asyncHandler(async (request, response) => {
        response.json(await runAutomationForOwner(getAccountOwnerId(request), "manual"));
    }));

    app.patch("/api/automation/reminders/:reminderId", requireAuthentication, requireManager, asyncHandler(async (request, response) => {
        const status = ["open", "done", "dismissed"].includes(request.body?.status) ? request.body.status : "";
        if (!status) return response.status(400).json({ message: "Statut invalide." });
        const result = await getPool().query("UPDATE depannhome_internal_reminders SET status=$3,completed_at=CASE WHEN $3='open' THEN NULL ELSE NOW() END WHERE id=$1 AND owner_id=$2", [positiveId(request.params.reminderId), getAccountOwnerId(request), status]);
        if (!result.rowCount) return response.status(404).json({ message: "Rappel introuvable." });
        response.status(204).end();
    }));
}

export async function runAutomationForOwner(ownerId, source = "scheduler") {
    const database = await getPool().connect();
    let runId = 0;
    try {
        const lockKey = 845_091_000 + Number(ownerId) % 100000;
        const lock = await database.query("SELECT pg_try_advisory_lock($1) AS locked", [lockKey]);
        if (!lock.rows[0].locked) return { skipped: true, reason: "already_running" };
        try {
            const run = await database.query("INSERT INTO depannhome_automation_runs(owner_id,source,status) VALUES($1,$2,'running') RETURNING id", [ownerId, source]);
            runId = run.rows[0].id;
            const rules = await database.query(`SELECT id,name,rule_type AS "ruleType",lead_days AS "leadDays",configuration FROM depannhome_automation_rules WHERE owner_id=$1 AND is_active=TRUE ORDER BY id`, [ownerId]);
            let created = 0;
            for (const rule of rules.rows) created += await executeRule(database, ownerId, rule);
            await database.query("UPDATE depannhome_automation_runs SET status='completed',created_count=$2,completed_at=NOW() WHERE id=$1", [runId, created]);
            return { runId, createdCount: created, status: "completed" };
        } catch (error) {
            if (runId) await database.query("UPDATE depannhome_automation_runs SET status='failed',error_code=$2,completed_at=NOW() WHERE id=$1", [runId, clean(error.code || error.name || "ERROR", 100)]).catch(() => {});
            throw error;
        } finally { await database.query("SELECT pg_advisory_unlock($1)", [lockKey]).catch(() => {}); }
    } finally { database.release(); }
}

async function executeRule(database, ownerId, rule) {
    const targets = await loadTargets(database, ownerId, rule);
    let created = 0;
    for (const target of targets) {
        const result = await database.query(`INSERT INTO depannhome_internal_reminders(owner_id,rule_id,reminder_type,entity_type,entity_id,title,details,due_at,dedupe_key)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(owner_id,dedupe_key) DO NOTHING`, [ownerId, rule.id, rule.ruleType, target.entityType, String(target.entityId), target.title, target.details, target.dueAt, `${rule.id}:${rule.ruleType}:${target.entityType}:${target.entityId}:${String(target.dedupeDate || target.dueAt).slice(0, 10)}`]);
        created += result.rowCount;
    }
    return created;
}

async function loadTargets(database, ownerId, rule) {
    if (rule.ruleType === "quote_follow_up") {
        const { rows } = await database.query(`SELECT document.id AS "entityId",'billing_document' AS "entityType",('Relancer le devis '||document.document_number) AS title,('Client : '||document.customer_name) AS details,COALESCE(document.follow_up_date,CURRENT_DATE)::timestamptz AS "dueAt",COALESCE(document.follow_up_date,CURRENT_DATE) AS "dedupeDate" FROM depannhome_billing_documents document LEFT JOIN depannhome_quote_decisions decision ON decision.owner_id=document.owner_id AND decision.document_id=document.id WHERE document.owner_id=$1 AND document.document_type='quote' AND document.status NOT IN ('cancelled','refused') AND decision.id IS NULL AND COALESCE(document.follow_up_date,document.issue_date)<=CURRENT_DATE+$2::integer`, [ownerId, rule.leadDays]);
        return rows;
    }
    if (rule.ruleType === "contract_renewal") {
        const { rows } = await database.query(`SELECT id AS "entityId",'maintenance_contract' AS "entityType",('Renouveler le contrat '||reference) AS title,title AS details,ends_on::timestamptz AS "dueAt",ends_on AS "dedupeDate" FROM depannhome_maintenance_contracts WHERE owner_id=$1 AND status='active' AND ends_on IS NOT NULL AND ends_on<=CURRENT_DATE+$2::integer`, [ownerId, rule.leadDays]);
        return rows;
    }
    if (rule.ruleType === "maintenance_due") {
        const { rows } = await database.query(`SELECT id AS "entityId",'maintenance_contract' AS "entityType",('Maintenance à planifier : '||reference) AS title,title AS details,next_service_on::timestamptz AS "dueAt",next_service_on AS "dedupeDate" FROM depannhome_maintenance_contracts WHERE owner_id=$1 AND status='active' AND next_service_on IS NOT NULL AND next_service_on<=CURRENT_DATE+$2::integer`, [ownerId, rule.leadDays]);
        return rows;
    }
    if (rule.ruleType === "low_stock") {
        const { rows } = await database.query(`SELECT item.id AS "entityId",'inventory_item' AS "entityType",('Stock faible : '||item.name) AS title,('Référence '||item.sku||' · disponible '||COALESCE(SUM(movement.quantity),0)::text||' '||item.unit) AS details,NOW() AS "dueAt",CURRENT_DATE AS "dedupeDate" FROM depannhome_inventory_items item LEFT JOIN depannhome_inventory_movements movement ON movement.owner_id=item.owner_id AND movement.item_id=item.id WHERE item.owner_id=$1 AND item.is_active=TRUE GROUP BY item.id HAVING COALESCE(SUM(movement.quantity),0)<=item.reorder_level`, [ownerId]);
        return rows;
    }
    return [];
}

export function startAutomationScheduler() {
    if (scheduler) return;
    const execute = async () => {
        try {
            const { rows } = await getPool().query("SELECT DISTINCT owner_id FROM depannhome_automation_rules WHERE is_active=TRUE");
            for (const row of rows) await runAutomationForOwner(row.owner_id, "scheduler");
        } catch (error) { console.warn("[automation] exécution indisponible", error.code || error.name || "ERROR"); }
    };
    scheduler = setInterval(() => void execute(), 15 * 60 * 1000);
    scheduler.unref?.();
    void execute();
}

function safeConfiguration(value) { const input = value && typeof value === "object" && !Array.isArray(value) ? value : {}; return Object.fromEntries(Object.entries(input).filter(([key, item]) => /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key) && ["string", "number", "boolean"].includes(typeof item)).slice(0, 20)); }
function positiveId(value) { const number = Number(value); return Number.isSafeInteger(number) && number > 0 ? number : 0; }
function integer(value, minimum, maximum, fallback) { const number = Number(value); return Number.isInteger(number) && number >= minimum && number <= maximum ? number : fallback; }
function clean(value, maximum) { return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum); }
function requireManager(request, response, next) { return ADMIN_ROLES.has(request.user?.role) ? next() : response.status(403).json({ message: "Fonction réservée aux responsables." }); }
function asyncHandler(handler) { return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next); }
