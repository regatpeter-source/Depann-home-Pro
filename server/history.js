import { getAccountOwnerId, isCompanyAdministrator } from "./auth.js";
import { getPool } from "./database.js";

export const HISTORY_CATEGORIES = Object.freeze(["account", "subscription", "members", "imports", "clients", "operations", "accounting", "partners", "group"]);
export const DELETABLE_HISTORY_CATEGORIES = Object.freeze(["imports", "clients", "operations", "partners"]);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_OFFSET = 5000;

const DELETABLE_SOURCES = Object.freeze({
    import: { category: "imports", table: "depannhome_data_import_logs", ownerColumn: "owner_id" },
    client: { category: "clients", table: "depannhome_client_lifecycle_audit", ownerColumn: "owner_id" },
    collaboration: { category: "operations", table: "depannhome_collaboration_audit", ownerColumn: "owner_id" },
    mission: { category: "partners", table: "depannhome_partner_mission_history", ownerColumn: "owner_id" },
    dialogue: { category: "partners", table: "depannhome_partner_dialogue_audit", ownerColumn: "owner_id" },
    mission_item: { category: "partners", table: "depannhome_partner_mission_item_audit", ownerColumn: "owner_id" }
});

const SOURCE_QUERIES = Object.freeze({
    account: [
        `SELECT audit.id,'account' AS category,'account' AS source,audit.action,COALESCE(NULLIF(actor.full_name,''),actor.username,'Système') AS "actorName",'Compte entreprise' AS target,jsonb_build_object('previous',audit.previous_value,'next',audit.next_value) AS details,audit.created_at AS "createdAt" FROM depannhome_account_audit audit LEFT JOIN depannhome_users actor ON actor.id=audit.actor_id WHERE audit.account_owner_id=$1 AND audit.created_at >= $2 AND audit.created_at < $3 AND ($4='' OR LOWER(CONCAT_WS(' ',audit.action,actor.full_name,actor.username,audit.previous_value::text,audit.next_value::text)) LIKE '%' || $4 || '%') ORDER BY audit.created_at __ORDER__ LIMIT $5`,
        `SELECT audit.id,'account' AS category,'organization' AS source,audit.action,COALESCE(NULLIF(actor.full_name,''),actor.username,'Système') AS "actorName",'Organisation' AS target,jsonb_build_object('previous',audit.previous_value,'next',audit.next_value) AS details,audit.created_at AS "createdAt" FROM depannhome_organization_audit audit LEFT JOIN depannhome_users actor ON actor.id=audit.actor_id WHERE audit.account_owner_id=$1 AND audit.created_at >= $2 AND audit.created_at < $3 AND ($4='' OR LOWER(CONCAT_WS(' ',audit.action,actor.full_name,actor.username,audit.previous_value::text,audit.next_value::text)) LIKE '%' || $4 || '%') ORDER BY audit.created_at __ORDER__ LIMIT $5`,
        `SELECT audit.id,'account' AS category,'lifecycle' AS source,audit.action,COALESCE(NULLIF(actor.full_name,''),actor.username,'Système') AS "actorName",'Cycle de vie du compte' AS target,jsonb_build_object('reason',audit.reason) AS details,audit.created_at AS "createdAt" FROM depannhome_account_lifecycle_audit audit LEFT JOIN depannhome_users actor ON actor.id=audit.actor_id WHERE audit.account_owner_id=$1 AND audit.created_at >= $2 AND audit.created_at < $3 AND ($4='' OR LOWER(CONCAT_WS(' ',audit.action,audit.reason,actor.full_name,actor.username)) LIKE '%' || $4 || '%') ORDER BY audit.created_at __ORDER__ LIMIT $5`
    ],
    subscription: [
        `SELECT audit.id,'subscription' AS category,'trial' AS source,audit.action,COALESCE(NULLIF(actor.full_name,''),actor.username,'Système') AS "actorName",'Période d’essai' AS target,jsonb_build_object('previousEndsAt',audit.previous_ends_at,'nextEndsAt',audit.next_ends_at,'renewalCount',audit.renewal_count,'details',audit.details) AS details,audit.created_at AS "createdAt" FROM depannhome_subscription_trial_audit audit LEFT JOIN depannhome_users actor ON actor.id=audit.actor_id WHERE audit.account_owner_id=$1 AND audit.created_at >= $2 AND audit.created_at < $3 AND ($4='' OR LOWER(CONCAT_WS(' ',audit.action,actor.full_name,actor.username,audit.details::text)) LIKE '%' || $4 || '%') ORDER BY audit.created_at __ORDER__ LIMIT $5`,
        `SELECT audit.id,'subscription' AS category,'invoice' AS source,audit.action,COALESCE(NULLIF(actor.full_name,''),actor.username,'Système') AS "actorName",'Facture abonnement ' || audit.invoice_id AS target,audit.details,audit.created_at AS "createdAt" FROM depannhome_subscription_invoice_audit audit LEFT JOIN depannhome_users actor ON actor.id=audit.actor_id WHERE audit.account_owner_id=$1 AND audit.created_at >= $2 AND audit.created_at < $3 AND ($4='' OR LOWER(CONCAT_WS(' ',audit.action,audit.invoice_id::text,actor.full_name,actor.username,audit.details::text)) LIKE '%' || $4 || '%') ORDER BY audit.created_at __ORDER__ LIMIT $5`,
        `SELECT audit.id,'subscription' AS category,'credit_note' AS source,audit.action,COALESCE(NULLIF(actor.full_name,''),actor.username,'Système') AS "actorName",'Avoir abonnement ' || audit.credit_note_id AS target,audit.details,audit.created_at AS "createdAt" FROM depannhome_subscription_credit_note_audit audit LEFT JOIN depannhome_users actor ON actor.id=audit.actor_id WHERE audit.account_owner_id=$1 AND audit.created_at >= $2 AND audit.created_at < $3 AND ($4='' OR LOWER(CONCAT_WS(' ',audit.action,audit.credit_note_id::text,actor.full_name,actor.username,audit.details::text)) LIKE '%' || $4 || '%') ORDER BY audit.created_at __ORDER__ LIMIT $5`
    ],
    members: [
        `SELECT audit.id,'members' AS category,'member' AS source,audit.action,COALESCE(NULLIF(actor.full_name,''),actor.username,'Système') AS "actorName",COALESCE(NULLIF(audit.target_full_name,''),audit.target_username,'Utilisateur') AS target,audit.details,audit.created_at AS "createdAt" FROM depannhome_member_audit audit LEFT JOIN depannhome_users actor ON actor.id=audit.actor_id WHERE audit.owner_id=$1 AND audit.created_at >= $2 AND audit.created_at < $3 AND ($4='' OR LOWER(CONCAT_WS(' ',audit.action,audit.target_full_name,audit.target_username,actor.full_name,actor.username,audit.details::text)) LIKE '%' || $4 || '%') ORDER BY audit.created_at __ORDER__ LIMIT $5`
    ],
    imports: [
        `SELECT log.id,'imports' AS category,'import' AS source,'import_completed' AS action,COALESCE(NULLIF(actor.full_name,''),actor.username,'Utilisateur supprimé') AS "actorName",log.filename AS target,log.details || jsonb_build_object('dataType',log.data_type,'sourceRows',log.source_rows,'importedCount',log.imported_count,'duplicateCount',log.duplicate_count,'errorCount',log.error_count,'duplicateStrategy',log.duplicate_strategy) AS details,log.created_at AS "createdAt" FROM depannhome_data_import_logs log LEFT JOIN depannhome_users actor ON actor.id=log.user_id WHERE log.owner_id=$1 AND log.created_at >= $2 AND log.created_at < $3 AND ($4='' OR LOWER(CONCAT_WS(' ',log.filename,log.data_type,actor.full_name,actor.username,log.details::text)) LIKE '%' || $4 || '%') ORDER BY log.created_at __ORDER__ LIMIT $5`
    ],
    clients: [
        `SELECT audit.id,'clients' AS category,'client' AS source,audit.action,COALESCE(NULLIF(audit.actor_name,''),NULLIF(actor.full_name,''),actor.username,'Système') AS "actorName",audit.client_id AS target,audit.details,audit.created_at AS "createdAt" FROM depannhome_client_lifecycle_audit audit LEFT JOIN depannhome_users actor ON actor.id=audit.actor_id WHERE audit.owner_id=$1 AND audit.created_at >= $2 AND audit.created_at < $3 AND ($4='' OR LOWER(CONCAT_WS(' ',audit.action,audit.client_id,audit.actor_name,actor.full_name,actor.username,audit.details::text)) LIKE '%' || $4 || '%') ORDER BY audit.created_at __ORDER__ LIMIT $5`
    ],
    operations: [
        `SELECT audit.id,'operations' AS category,'collaboration' AS source,audit.action,COALESCE(NULLIF(actor.full_name,''),actor.username,'Système') AS "actorName",CONCAT_WS(' · ',audit.entity_type,audit.entity_id) AS target,audit.details || jsonb_build_object('actorRole',audit.actor_role,'deviceType',audit.device_type,'deviceLabel',audit.device_label) AS details,audit.created_at AS "createdAt" FROM depannhome_collaboration_audit audit LEFT JOIN depannhome_users actor ON actor.id=audit.actor_id WHERE audit.owner_id=$1 AND audit.created_at >= $2 AND audit.created_at < $3 AND ($4='' OR LOWER(CONCAT_WS(' ',audit.action,audit.entity_type,audit.entity_id,actor.full_name,actor.username,audit.details::text)) LIKE '%' || $4 || '%') ORDER BY audit.created_at __ORDER__ LIMIT $5`
    ],
    accounting: [
        `SELECT audit.id,'accounting' AS category,'accounting' AS source,audit.action,COALESCE(NULLIF(actor.full_name,''),actor.username,'Système') AS "actorName",CONCAT_WS(' · ',audit.target_type,audit.target_id) AS target,audit.details,audit.created_at AS "createdAt" FROM depannhome_accounting_audit audit LEFT JOIN depannhome_users actor ON actor.id=audit.actor_id WHERE audit.owner_id=$1 AND audit.created_at >= $2 AND audit.created_at < $3 AND ($4='' OR LOWER(CONCAT_WS(' ',audit.action,audit.target_type,audit.target_id,actor.full_name,actor.username,audit.details::text)) LIKE '%' || $4 || '%') ORDER BY audit.created_at __ORDER__ LIMIT $5`
    ],
    partners: [
        `SELECT audit.id,'partners' AS category,'mission' AS source,audit.action,COALESCE(NULLIF(actor.full_name,''),actor.username,'Système') AS "actorName",COALESCE(NULLIF(mission.mission_number,''),'Mission ' || audit.mission_id) AS target,audit.details || jsonb_build_object('status',audit.status,'actorRole',audit.actor_role) AS details,audit.created_at AS "createdAt" FROM depannhome_partner_mission_history audit JOIN depannhome_partner_missions mission ON mission.id=audit.mission_id LEFT JOIN depannhome_users actor ON actor.id=audit.actor_id WHERE audit.owner_id=$1 AND audit.created_at >= $2 AND audit.created_at < $3 AND ($4='' OR LOWER(CONCAT_WS(' ',audit.action,audit.status,mission.mission_number,actor.full_name,actor.username,audit.details::text)) LIKE '%' || $4 || '%') ORDER BY audit.created_at __ORDER__ LIMIT $5`,
        `SELECT audit.id,'partners' AS category,'dialogue' AS source,audit.action,COALESCE(NULLIF(audit.actor_name,''),NULLIF(actor.full_name,''),actor.username,'Système') AS "actorName",'Message mission ' || audit.mission_id AS target,jsonb_build_object('previous',audit.old_value,'next',audit.new_value) AS details,audit.created_at AS "createdAt" FROM depannhome_partner_dialogue_audit audit LEFT JOIN depannhome_users actor ON actor.id=audit.actor_id WHERE audit.owner_id=$1 AND audit.created_at >= $2 AND audit.created_at < $3 AND ($4='' OR LOWER(CONCAT_WS(' ',audit.action,audit.actor_name,audit.mission_id::text,audit.old_value::text,audit.new_value::text)) LIKE '%' || $4 || '%') ORDER BY audit.created_at __ORDER__ LIMIT $5`,
        `SELECT audit.id,'partners' AS category,'mission_item' AS source,audit.action,COALESCE(NULLIF(actor.full_name,''),actor.username,'Système') AS "actorName",'Élément mission ' || audit.mission_id AS target,jsonb_build_object('previous',audit.old_value,'next',audit.new_value) AS details,audit.created_at AS "createdAt" FROM depannhome_partner_mission_item_audit audit LEFT JOIN depannhome_users actor ON actor.id=audit.actor_id WHERE audit.owner_id=$1 AND audit.created_at >= $2 AND audit.created_at < $3 AND ($4='' OR LOWER(CONCAT_WS(' ',audit.action,audit.mission_id::text,actor.full_name,actor.username,audit.old_value::text,audit.new_value::text)) LIKE '%' || $4 || '%') ORDER BY audit.created_at __ORDER__ LIMIT $5`
    ],
    group: [
        `SELECT audit.id,'group' AS category,'group' AS source,audit.action,COALESCE(NULLIF(actor.full_name,''),actor.username,'Système') AS "actorName",COALESCE(NULLIF(owner.company_name,''),'Groupe') AS target,audit.details,audit.created_at AS "createdAt" FROM depannhome_group_audit audit LEFT JOIN depannhome_users actor ON actor.id=audit.actor_id LEFT JOIN depannhome_users owner ON owner.id=audit.company_owner_id WHERE audit.group_id=$1 AND audit.created_at >= $2 AND audit.created_at < $3 AND ($4='' OR LOWER(CONCAT_WS(' ',audit.action,actor.full_name,actor.username,owner.company_name,audit.details::text)) LIKE '%' || $4 || '%') ORDER BY audit.created_at __ORDER__ LIMIT $5`
    ]
});

export function registerHistoryRoutes(app, requireAuthentication) {
    app.get("/api/history", requireAuthentication, asyncHandler(async (request, response) => {
        if (!isCompanyAdministrator(request)) return response.status(403).json({ message: "Les historiques sont réservés au Poste Admin de cette entreprise." });
        const filters = normalizeHistoryFilters(request.query);
        if (!filters.ok) return response.status(400).json({ message: filters.message });
        const history = await getUnifiedHistory(getAccountOwnerId(request), filters, getPool(), request.user?.isGroupAdministrator ? request.user.groupId : "");
        response.json(history);
    }));
    app.post("/api/history/delete", requireAuthentication, asyncHandler(async (request, response) => {
        if (!isCompanyAdministrator(request)) return response.status(403).json({ message: "La suppression des journaux est réservée au Poste Admin de cette entreprise." });
        const deletion = normalizeHistoryDeletion(request.body);
        if (!deletion.ok) return response.status(400).json({ message: deletion.message });
        const result = await deleteOperationalHistory(getAccountOwnerId(request), request.user.sub, deletion, getPool());
        response.json(result);
    }));
}

export async function getUnifiedHistory(ownerId, filters, database = getPool(), groupId = "") {
    const categories = (filters.category === "all" ? HISTORY_CATEGORIES : [filters.category]).filter(category => category !== "group" || groupId);
    const sourceLimit = Math.min(MAX_OFFSET + MAX_LIMIT + 1, filters.offset + filters.limit + 1);
    const queries = categories.flatMap(category => SOURCE_QUERIES[category].map(sql => database.query(sql.replaceAll("__ORDER__", filters.order.toUpperCase()), [category === "group" ? groupId : ownerId, filters.dateFrom, filters.dateToExclusive, filters.search.toLowerCase(), sourceLimit])));
    const results = await Promise.all(queries);
    const allEntries = results.flatMap(result => result.rows).map(entry => ({ ...entry, id: `${entry.source}:${entry.id}`, deletable: DELETABLE_HISTORY_CATEGORIES.includes(entry.category) }));
    allEntries.sort((first, second) => filters.order === "asc" ? new Date(first.createdAt) - new Date(second.createdAt) : new Date(second.createdAt) - new Date(first.createdAt));
    const entries = allEntries.slice(filters.offset, filters.offset + filters.limit);
    return { entries, filters: { category: filters.category, search: filters.search, dateFrom: filters.dateFrom.slice(0, 10), dateTo: filters.dateTo.slice(0, 10), order: filters.order }, page: { offset: filters.offset, limit: filters.limit, hasMore: allEntries.length > filters.offset + filters.limit } };
}

export function normalizeHistoryDeletion(body = {}) {
    const reason = clean(body.reason, 500);
    if (reason.length < 10) return { ok: false, message: "Expliquez la suppression en au moins 10 caractères." };
    if (body.mode === "selected") {
        const items = [...new Set((Array.isArray(body.items) ? body.items : []).map(value => String(value || "")))].map(value => {
            const match = /^([a-z_]+):(\d+)$/.exec(value);
            const source = match?.[1] || "";
            const id = Number(match?.[2]);
            return DELETABLE_SOURCES[source] && Number.isSafeInteger(id) && id > 0 ? { source, id } : null;
        }).filter(Boolean).slice(0, 100);
        if (!items.length) return { ok: false, message: "Sélectionnez au moins un événement supprimable." };
        return { ok: true, mode: "selected", items, reason };
    }
    if (body.mode === "filtered") {
        const category = DELETABLE_HISTORY_CATEGORIES.includes(body.category) ? body.category : body.category === "all" ? "all" : "";
        const dateFrom = dateBoundary(body.dateFrom, null, false);
        const dateToExclusive = dateBoundary(body.dateTo, null, true);
        if (!category) return { ok: false, message: "Cette catégorie contient des traces légales ou de sécurité qui ne peuvent pas être supprimées." };
        if (!dateFrom || !dateToExclusive || dateFrom >= dateToExclusive) return { ok: false, message: "La période de suppression est invalide." };
        return { ok: true, mode: "filtered", category, dateFrom: dateFrom.toISOString(), dateToExclusive: dateToExclusive.toISOString(), reason };
    }
    return { ok: false, message: "Mode de suppression invalide." };
}

export async function deleteOperationalHistory(ownerId, actorId, deletion, database = getPool()) {
    const connection = await database.connect();
    try {
        await connection.query("BEGIN");
        let deletedCount = 0;
        const categories = new Set();
        if (deletion.mode === "selected") {
            for (const [source, definition] of Object.entries(DELETABLE_SOURCES)) {
                const ids = deletion.items.filter(item => item.source === source).map(item => item.id);
                if (!ids.length) continue;
                const result = await connection.query(`DELETE FROM ${definition.table} WHERE ${definition.ownerColumn}=$1 AND id=ANY($2::bigint[])`, [ownerId, ids]);
                deletedCount += result.rowCount || 0;
                categories.add(definition.category);
            }
        } else {
            for (const definition of Object.values(DELETABLE_SOURCES)) {
                if (deletion.category !== "all" && definition.category !== deletion.category) continue;
                const result = await connection.query(`DELETE FROM ${definition.table} WHERE ${definition.ownerColumn}=$1 AND created_at >= $2::timestamptz AND created_at < $3::timestamptz`, [ownerId, deletion.dateFrom, deletion.dateToExclusive]);
                deletedCount += result.rowCount || 0;
                categories.add(definition.category);
            }
        }
        await connection.query(`INSERT INTO depannhome_history_deletion_audit(owner_id,actor_id,deletion_mode,categories,deleted_count,reason,period_from,period_to)
            VALUES($1,$2,$3,$4::jsonb,$5,$6,$7::timestamptz,$8::timestamptz)`, [ownerId, actorId, deletion.mode, JSON.stringify([...categories]), deletedCount, deletion.reason, deletion.dateFrom || null, deletion.dateToExclusive || null]);
        await connection.query("COMMIT");
        return { deletedCount, protectedCategories: HISTORY_CATEGORIES.filter(category => !DELETABLE_HISTORY_CATEGORIES.includes(category)) };
    } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
    } finally { connection.release(); }
}

export function normalizeHistoryFilters(query = {}, now = new Date()) {
    if (query.category && query.category !== "all" && !HISTORY_CATEGORIES.includes(query.category)) return { ok: false, message: "La catégorie d’historique est invalide." };
    const category = HISTORY_CATEGORIES.includes(query.category) ? query.category : "all";
    const order = query.order === "asc" ? "asc" : "desc";
    const limit = integer(query.limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
    const offset = integer(query.offset, 0, MAX_OFFSET, 0);
    const defaultFrom = new Date(now); defaultFrom.setUTCFullYear(defaultFrom.getUTCFullYear() - 1);
    const dateFrom = dateBoundary(query.dateFrom, defaultFrom, false);
    const dateTo = dateBoundary(query.dateTo, now, false);
    const dateToExclusive = dateBoundary(query.dateTo, now, true);
    if (!dateFrom || !dateTo || !dateToExclusive || dateFrom > dateTo) return { ok: false, message: "La période d’historique est invalide." };
    return { ok: true, category, order, limit, offset, search: clean(query.search, 120), dateFrom: dateFrom.toISOString(), dateTo: dateTo.toISOString(), dateToExclusive: dateToExclusive.toISOString() };
}

function dateBoundary(value, fallback, nextDay) {
    if (!value) return fallback ? new Date(fallback) : null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return null;
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
    if (nextDay) date.setUTCDate(date.getUTCDate() + 1);
    return date;
}
function integer(value, minimum, maximum, fallback) { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback; }
function clean(value, maximum) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximum); }
function asyncHandler(handler) { return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next); }
