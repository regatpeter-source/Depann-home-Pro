import { getPool } from "./database.js";
import { getAccountOwnerId } from "./auth.js";
import { hasInternalBusinessWorkspaceAccess } from "./workstation-permissions.js";

const RULE_TYPES = new Set(["quote_follow_up", "contract_renewal", "maintenance_due", "low_stock"]);
const DASHBOARD_RULE_TYPES = ["contract_renewal", "maintenance_due", "low_stock"];
const ADMIN_ROLES = new Set(["admin", "pc_standard", "mobile_admin"]);
let scheduler = null;

export function registerAutomationRoutes(app, requireAuthentication) {
    app.get("/api/automation/rules", requireAuthentication, requireManager, asyncHandler(async (request, response) => {
        response.json(await loadAutomationOverview(getAccountOwnerId(request)));
    }));

    app.get("/api/automation/dashboard", requireAuthentication, requireManager, asyncHandler(async (request, response) => {
        response.json(await loadAutomationOverview(getAccountOwnerId(request), DASHBOARD_RULE_TYPES));
    }));

    app.post("/api/automation/rules", requireAuthentication, requireManager, asyncHandler(async (request, response) => {
        const name = clean(request.body?.name, 160), ruleType = RULE_TYPES.has(request.body?.ruleType) ? request.body.ruleType : "";
        if (!name || !ruleType || !validRuleOptions(request.body)) return response.status(400).json({ message: "Nom, type, délai ou état de la règle invalide." });
        const { rows } = await getPool().query(`INSERT INTO depannhome_automation_rules(owner_id,name,rule_type,is_active,lead_days,configuration,created_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING id`, [getAccountOwnerId(request), name, ruleType, request.body?.isActive !== false, integer(request.body?.leadDays, 0, 365, 0), JSON.stringify(safeConfiguration(request.body?.configuration)), request.user.sub]);
        response.status(201).json({ id: rows[0].id });
    }));

    app.patch("/api/automation/rules/:ruleId", requireAuthentication, requireManager, asyncHandler(async (request, response) => {
        const ruleId = positiveId(request.params.ruleId), name = clean(request.body?.name, 160), ruleType = RULE_TYPES.has(request.body?.ruleType) ? request.body.ruleType : "";
        if (!ruleId || !name || !ruleType || !validRuleOptions(request.body)) return response.status(400).json({ message: "Règle invalide." });
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

    app.post("/api/automation/dashboard/run", requireAuthentication, requireManager, asyncHandler(async (request, response) => {
        response.json(await runAutomationForOwner(getAccountOwnerId(request), "manual", DASHBOARD_RULE_TYPES));
    }));

    app.patch("/api/automation/reminders/:reminderId", requireAuthentication, requireManager, asyncHandler(async (request, response) => {
        const status = ["open", "done", "dismissed"].includes(request.body?.status) ? request.body.status : "";
        if (!status) return response.status(400).json({ message: "Statut invalide." });
        const result = await getPool().query("UPDATE depannhome_internal_reminders SET status=$3::varchar,completed_at=CASE WHEN $3::varchar='open' THEN NULL ELSE NOW() END WHERE id=$1 AND owner_id=$2", [positiveId(request.params.reminderId), getAccountOwnerId(request), status]);
        if (!result.rowCount) return response.status(404).json({ message: "Rappel introuvable." });
        response.status(204).end();
    }));
}

async function loadAutomationOverview(ownerId, types = null) {
    const database = await getPool().connect();
    let releaseError;
    try {
        await database.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const rules = await database.query(`SELECT id,name,rule_type AS "ruleType",is_active AS "isActive",lead_days AS "leadDays",configuration,created_at AS "createdAt",updated_at AS "updatedAt" FROM depannhome_automation_rules WHERE owner_id=$1 AND ($2::text[] IS NULL OR rule_type=ANY($2::text[])) ORDER BY name`, [ownerId, types]);
        const reminders = await database.query(`SELECT reminder.id,reminder.rule_id AS "ruleId",reminder.reminder_type AS "reminderType",reminder.entity_type AS "entityType",reminder.entity_id AS "entityId",reminder.title,reminder.details,reminder.due_at AS "dueAt",TO_CHAR(reminder.due_at,'YYYY-MM-DD') AS "dueDate",reminder.status,reminder.created_at AS "createdAt",reminder.completed_at AS "completedAt",contract.client_id AS "clientId"
            FROM depannhome_internal_reminders reminder
            LEFT JOIN depannhome_maintenance_contracts contract ON reminder.entity_type='maintenance_contract' AND contract.id::text=reminder.entity_id AND contract.owner_id=reminder.owner_id
            WHERE reminder.owner_id=$1 AND ($2::text[] IS NULL OR reminder.reminder_type=ANY($2::text[]))
            ORDER BY CASE reminder.status WHEN 'open' THEN 0 ELSE 1 END,reminder.due_at,reminder.id DESC LIMIT 300`, [ownerId, types]);
        const runs = await database.query(`SELECT id,source,status,created_count AS "createdCount",error_code AS "errorCode",started_at AS "startedAt",completed_at AS "completedAt" FROM depannhome_automation_runs WHERE owner_id=$1 ORDER BY started_at DESC,id DESC LIMIT 30`, [ownerId]);
        await database.query("COMMIT");
        return { rules: rules.rows, reminders: reminders.rows, runs: runs.rows };
    } catch (error) {
        try {
            await database.query("ROLLBACK");
        } catch (rollbackError) {
            releaseError = rollbackError;
            console.error("[automation] annulation de la lecture impossible", rollbackError.code || rollbackError.name || "ERROR");
        }
        throw error;
    } finally {
        database.release(releaseError);
    }
}

export async function runAutomationForOwner(ownerId, source = "scheduler", types = null) {
    const database = await getPool().connect();
    let runId = 0;
    let releaseError;
    let workError;
    let transactionOpen = false;
    try {
        const lockKey = 845_091_000 + Number(ownerId) % 100000;
        const lock = await database.query("SELECT pg_try_advisory_lock($1) AS locked", [lockKey]);
        if (!lock.rows[0].locked) return { skipped: true, reason: "already_running" };
        try {
            const run = await database.query("INSERT INTO depannhome_automation_runs(owner_id,source,status) VALUES($1,$2,'running') RETURNING id", [ownerId, source]);
            runId = run.rows[0].id;
            await database.query("BEGIN");
            transactionOpen = true;
            const rules = await database.query(`SELECT id,name,rule_type AS "ruleType",lead_days AS "leadDays",configuration FROM depannhome_automation_rules WHERE owner_id=$1 AND is_active=TRUE AND ($2::text[] IS NULL OR rule_type=ANY($2::text[])) ORDER BY id`, [ownerId, types]);
            let created = 0;
            for (const rule of rules.rows) created += await executeRule(database, ownerId, rule);
            await database.query("UPDATE depannhome_automation_runs SET status='completed',created_count=$2,completed_at=NOW() WHERE id=$1", [runId, created]);
            await database.query("COMMIT");
            transactionOpen = false;
            return { runId, createdCount: created, status: "completed" };
        } catch (error) {
            workError = error;
            if (transactionOpen) {
                try {
                    await database.query("ROLLBACK");
                } catch (rollbackError) {
                    releaseError = rollbackError;
                    console.error("[automation] annulation de la recherche impossible", rollbackError.code || rollbackError.name || "ERROR");
                }
            }
            if (runId && !releaseError) {
                try {
                    await database.query("UPDATE depannhome_automation_runs SET status='failed',error_code=$2,completed_at=NOW() WHERE id=$1", [runId, clean(error.code || error.name || "ERROR", 100)]);
                } catch (recordError) {
                    console.error("[automation] impossible de journaliser l’échec", recordError.code || recordError.name || "ERROR");
                }
            }
            throw error;
        } finally {
            if (!releaseError) {
                try {
                    const unlock = await database.query("SELECT pg_advisory_unlock($1) AS unlocked", [lockKey]);
                    if (!unlock.rows[0].unlocked) throw new Error("Verrou des rappels non libéré.");
                } catch (error) {
                    releaseError = error;
                    if (!workError) throw error;
                    console.error("[automation] libération du verrou impossible", error.code || error.name || "ERROR");
                }
            }
        }
    } finally { database.release(releaseError); }
}

async function executeRule(database, ownerId, rule) {
    const targets = await loadTargets(database, ownerId, rule);
    let created = 0;
    for (const target of targets) {
        const dedupeKey = `${rule.id}:${rule.ruleType}:${target.entityType}:${target.entityId}:${target.dedupeDate}`;
        const preventOpenDuplicates = rule.ruleType === "low_stock" && rule.configuration?.preventOpenDuplicates === true;
        const result = await database.query(`INSERT INTO depannhome_internal_reminders(owner_id,rule_id,reminder_type,entity_type,entity_id,title,details,due_at,dedupe_key)
            SELECT $1::bigint,$2::bigint,$3::varchar,$4::varchar,$5::varchar,$6::varchar,$7::varchar,$8::timestamptz,$9::varchar
            WHERE NOT EXISTS (
                SELECT 1 FROM depannhome_internal_reminders existing
                WHERE existing.owner_id=$1 AND existing.rule_id=$2 AND existing.reminder_type=$3
                    AND existing.entity_type=$4 AND existing.entity_id=$5
                    AND (existing.due_at::date=$8::timestamptz::date OR ($10::boolean AND existing.status='open'))
            )
            ON CONFLICT(owner_id,dedupe_key) DO NOTHING`, [ownerId, rule.id, rule.ruleType, target.entityType, String(target.entityId), target.title, target.details, target.dueAt, dedupeKey, preventOpenDuplicates]);
        created += result.rowCount;
    }
    return created;
}

async function loadTargets(database, ownerId, rule) {
    if (rule.ruleType === "quote_follow_up") {
        const { rows } = await database.query(`SELECT document.id AS "entityId",'billing_document' AS "entityType",('Relancer le devis '||document.document_number) AS title,('Client : '||document.customer_name) AS details,COALESCE(document.follow_up_date,CURRENT_DATE)::timestamptz AS "dueAt",TO_CHAR(COALESCE(document.follow_up_date,CURRENT_DATE),'YYYY-MM-DD') AS "dedupeDate" FROM depannhome_billing_documents document LEFT JOIN depannhome_quote_decisions decision ON decision.owner_id=document.owner_id AND decision.document_id=document.id WHERE document.owner_id=$1 AND document.document_type='quote' AND document.status NOT IN ('cancelled','refused') AND decision.id IS NULL AND COALESCE(document.follow_up_date,document.issue_date)<=CURRENT_DATE+$2::integer`, [ownerId, rule.leadDays]);
        return rows;
    }
    if (rule.ruleType === "contract_renewal") {
        const { rows } = await database.query(`SELECT id AS "entityId",'maintenance_contract' AS "entityType",('Renouveler le contrat '||reference) AS title,title AS details,ends_on::timestamptz AS "dueAt",TO_CHAR(ends_on,'YYYY-MM-DD') AS "dedupeDate" FROM depannhome_maintenance_contracts WHERE owner_id=$1 AND status='active' AND ends_on IS NOT NULL AND ends_on<=CURRENT_DATE+$2::integer`, [ownerId, rule.leadDays]);
        return rows;
    }
    if (rule.ruleType === "maintenance_due") {
        const { rows } = await database.query(`SELECT id AS "entityId",'maintenance_contract' AS "entityType",('Maintenance à planifier : '||reference) AS title,title AS details,next_service_on::timestamptz AS "dueAt",TO_CHAR(next_service_on,'YYYY-MM-DD') AS "dedupeDate" FROM depannhome_maintenance_contracts WHERE owner_id=$1 AND status='active' AND next_service_on IS NOT NULL AND next_service_on<=CURRENT_DATE+$2::integer`, [ownerId, rule.leadDays]);
        return rows;
    }
    if (rule.ruleType === "low_stock") {
        const { rows } = await database.query(`SELECT item.id AS "entityId",'inventory_item' AS "entityType",LEFT('Stock faible : '||item.name,200) AS title,('Référence '||item.sku||' · disponible '||COALESCE(SUM(movement.quantity),0)::text||' '||item.unit) AS details,NOW() AS "dueAt",TO_CHAR(CURRENT_DATE,'YYYY-MM-DD') AS "dedupeDate" FROM depannhome_inventory_items item LEFT JOIN depannhome_inventory_movements movement ON movement.owner_id=item.owner_id AND movement.item_id=item.id WHERE item.owner_id=$1 AND item.is_active=TRUE GROUP BY item.id HAVING COALESCE(SUM(movement.quantity),0)<=item.reorder_level ORDER BY item.id`, [ownerId]);
        return rows;
    }
    return [];
}

export async function executeAutomationCycle() {
    const { rows } = await getPool().query("SELECT DISTINCT owner_id FROM depannhome_automation_rules WHERE is_active=TRUE ORDER BY owner_id");
    for (const row of rows) {
        try {
            await runAutomationForOwner(row.owner_id, "scheduler");
        } catch (error) {
            console.warn("[automation] exécution d’une entreprise indisponible", row.owner_id, error.code || error.name || "ERROR");
        }
    }
}

export function startAutomationScheduler() {
    if (scheduler) return;
    const execute = () => executeAutomationCycle().catch(error => console.warn("[automation] recherche des entreprises indisponible", error.code || error.name || "ERROR"));
    scheduler = setInterval(() => void execute(), 15 * 60 * 1000);
    scheduler.unref?.();
    void execute();
}

function safeConfiguration(value) { const input = value && typeof value === "object" && !Array.isArray(value) ? value : {}; return Object.fromEntries(Object.entries(input).filter(([key, item]) => /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key) && ["string", "number", "boolean"].includes(typeof item)).slice(0, 20)); }
function validRuleOptions(body) {
    const active = body?.isActive;
    const value = body?.leadDays;
    const lead = value === undefined || value === null || value === "" ? 0 : Number(value);
    return (active === undefined || typeof active === "boolean")
        && (value === undefined || value === null || value === "" || typeof value === "number" || typeof value === "string")
        && Number.isInteger(lead) && lead >= 0 && lead <= 365;
}
function positiveId(value) { const number = Number(value); return Number.isSafeInteger(number) && number > 0 ? number : 0; }
function integer(value, minimum, maximum, fallback) { const number = Number(value); return Number.isInteger(number) && number >= minimum && number <= maximum ? number : fallback; }
function clean(value, maximum) { return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum); }
function requireManager(request, response, next) {
    return ADMIN_ROLES.has(request.user?.role) && hasInternalBusinessWorkspaceAccess(request.user)
        ? next()
        : response.status(403).json({ message: "Rappels réservés aux responsables de l’entreprise, hors interface Partenaire et prise en main Support." });
}
function asyncHandler(handler) { return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next); }
