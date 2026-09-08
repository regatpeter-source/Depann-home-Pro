import { getPool } from "./database.js";

export const DEFAULT_STORAGE_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
const MIN_STORAGE_QUOTA_BYTES = 10 * 1024 * 1024;
const MAX_STORAGE_QUOTA_BYTES = 10 * 1024 * 1024 * 1024 * 1024;

export async function loadCreatorStorageUsage(database = getPool()) {
    const usageResult = await database.query(`
        WITH storage_items AS (
            SELECT owner_id, 'library' AS category, COALESCE(SUM(file_size),0)::bigint AS bytes, COUNT(*)::integer AS items FROM depannhome_library_documents GROUP BY owner_id
            UNION ALL
            SELECT owner_id, 'dialogue_attachments', COALESCE(SUM(file_size),0)::bigint, COUNT(*)::integer FROM depannhome_partner_dialogue_attachments GROUP BY owner_id
            UNION ALL
            SELECT owner_id, 'email_attachments', COALESCE(SUM(file_size),0)::bigint, COUNT(*)::integer FROM depannhome_partner_email_attachments GROUP BY owner_id
            UNION ALL
            SELECT owner_id, 'document_templates', COALESCE(SUM(octet_length(source_data)),0)::bigint, COUNT(*)::integer FROM depannhome_document_templates GROUP BY owner_id
            UNION ALL
            SELECT owner_id, 'billing_documents', COALESCE(SUM(COALESCE(octet_length(pdf_data),0)+COALESCE(octet_length(structured_data),0)+pg_column_size(lines)+pg_column_size(legal_data)+pg_column_size(legal_snapshot)+pg_column_size(financial_data)),0)::bigint, COUNT(*)::integer FROM depannhome_billing_documents GROUP BY owner_id
            UNION ALL
            SELECT owner_id, 'company_profile', COALESCE(SUM(COALESCE(octet_length(quote_template_data),0)+COALESCE(octet_length(quitus_template_data),0)+COALESCE(octet_length(report_file_template_data),0)+COALESCE(octet_length(report_secondary_logo_data),0)+COALESCE(octet_length(logo_data),0)),0)::bigint, COUNT(*)::integer FROM depannhome_billing_profiles GROUP BY owner_id
            UNION ALL
            SELECT owner_id, 'technical_reports', COALESCE(SUM(COALESCE(octet_length(pdf_data),0)+pg_column_size(content)+pg_column_size(media)),0)::bigint, COUNT(*)::integer FROM depannhome_technical_reports GROUP BY owner_id
            UNION ALL
            SELECT owner_id, 'report_originals', COALESCE(SUM(octet_length(pdf_data)+pg_column_size(content)+pg_column_size(media)),0)::bigint, COUNT(*)::integer FROM depannhome_technical_report_originals GROUP BY owner_id
            UNION ALL
            SELECT owner_id, 'clients', COALESCE(SUM(pg_column_size(client_data)),0)::bigint, COUNT(*)::integer FROM depannhome_clients GROUP BY owner_id
            UNION ALL
            SELECT owner_id, 'partner_missions', COALESCE(SUM(pg_column_size(source_data)+pg_column_size(mapped_data)+pg_column_size(planning_draft)),0)::bigint, COUNT(*)::integer FROM depannhome_partner_missions GROUP BY owner_id
            UNION ALL
            SELECT owner_id, 'email_messages', COALESCE(SUM(octet_length(body_text)+octet_length(document_text)+pg_column_size(recipients)),0)::bigint, COUNT(*)::integer FROM depannhome_partner_email_messages GROUP BY owner_id
            UNION ALL
            SELECT owner_id, 'temporary_imports', COALESCE(SUM(pg_column_size(columns)+pg_column_size(rows)),0)::bigint, COUNT(*)::integer FROM depannhome_data_import_sessions GROUP BY owner_id
            UNION ALL
            SELECT account_owner_id AS owner_id, 'subscription_credits', COALESCE(SUM(octet_length(pdf_data)),0)::bigint, COUNT(*)::integer FROM depannhome_subscription_credit_notes GROUP BY account_owner_id
        ), owner_usage AS (
            SELECT owner_id, SUM(bytes)::bigint AS usage_bytes, SUM(items)::integer AS item_count,
                jsonb_object_agg(category, jsonb_build_object('bytes',bytes,'items',items)) AS breakdown
            FROM storage_items GROUP BY owner_id
        )
        SELECT owner.id AS "accountId",
            COALESCE(NULLIF(profile.company_name,''),NULLIF(owner.company_name,''),NULLIF(owner.full_name,''),owner.username) AS "companyName",
            owner.username AS "ownerUsername", owner.is_archived AS "isArchived",
            COALESCE(usage.usage_bytes,0)::bigint AS "usageBytes", COALESCE(usage.item_count,0)::integer AS "itemCount",
            COALESCE(usage.breakdown,'{}'::jsonb) AS breakdown,
            COALESCE(organization.storage_quota_bytes,$1)::bigint AS "quotaBytes"
        FROM depannhome_users owner
        LEFT JOIN depannhome_billing_profiles profile ON profile.owner_id=owner.id
        LEFT JOIN depannhome_organizations organization ON organization.account_owner_id=owner.id
        LEFT JOIN owner_usage usage ON usage.owner_id=owner.id
        WHERE owner.account_owner_id=owner.id
        ORDER BY CASE WHEN COALESCE(organization.storage_quota_bytes,$1)>0 THEN COALESCE(usage.usage_bytes,0)::numeric/COALESCE(organization.storage_quota_bytes,$1) ELSE 0 END DESC,
            LOWER(COALESCE(NULLIF(profile.company_name,''),NULLIF(owner.company_name,''),NULLIF(owner.full_name,''),owner.username))
    `, [DEFAULT_STORAGE_QUOTA_BYTES]);

    const accounts = usageResult.rows.map(normalizeStorageAccount);
    await saveDailySnapshots(database, accounts);
    const baselines = await loadThirtyDayBaselines(database, accounts.map(account => account.accountId));
    const databaseResult = await database.query("SELECT pg_database_size(current_database())::bigint AS bytes");

    for (const account of accounts) {
        const baseline = baselines.get(String(account.accountId));
        account.growth30dBytes = baseline === undefined ? null : account.usageBytes - baseline;
    }

    const totalUsageBytes = accounts.reduce((total, account) => total + account.usageBytes, 0);
    return {
        accounts,
        summary: {
            trackedUsageBytes: totalUsageBytes,
            databaseBytes: toSafeBytes(databaseResult.rows[0]?.bytes),
            warningCount: accounts.filter(account => account.alertLevel === "warning").length,
            criticalCount: accounts.filter(account => account.alertLevel === "critical").length
        },
        measuredAt: new Date().toISOString()
    };
}

export async function updateCompanyStorageQuota(accountId, quotaBytes, database = getPool()) {
    const normalizedQuota = normalizeStorageQuota(quotaBytes);
    if (!normalizedQuota) return null;
    const { rows } = await database.query(`
        UPDATE depannhome_organizations organization
        SET storage_quota_bytes=$2,updated_at=NOW()
        FROM depannhome_users owner
        WHERE organization.account_owner_id=$1 AND owner.id=$1 AND owner.account_owner_id=owner.id
        RETURNING organization.account_owner_id AS "accountId",organization.storage_quota_bytes AS "quotaBytes"
    `, [accountId, normalizedQuota]);
    return rows[0] ? { accountId: String(rows[0].accountId), quotaBytes: toSafeBytes(rows[0].quotaBytes) } : null;
}

export function normalizeStorageQuota(value) {
    const bytes = Number(value);
    return Number.isSafeInteger(bytes) && bytes >= MIN_STORAGE_QUOTA_BYTES && bytes <= MAX_STORAGE_QUOTA_BYTES ? bytes : 0;
}

export function storageAlertLevel(usageBytes, quotaBytes) {
    if (!quotaBytes) return "unknown";
    const ratio = usageBytes / quotaBytes;
    if (ratio >= 0.95) return "critical";
    if (ratio >= 0.8) return "warning";
    return "normal";
}

function normalizeStorageAccount(row) {
    const usageBytes = toSafeBytes(row.usageBytes);
    const quotaBytes = toSafeBytes(row.quotaBytes) || DEFAULT_STORAGE_QUOTA_BYTES;
    return {
        ...row,
        accountId: String(row.accountId),
        usageBytes,
        quotaBytes,
        itemCount: Number(row.itemCount) || 0,
        usagePercent: Math.round((usageBytes / quotaBytes) * 1000) / 10,
        alertLevel: storageAlertLevel(usageBytes, quotaBytes),
        breakdown: row.breakdown && typeof row.breakdown === "object" ? row.breakdown : {}
    };
}

async function saveDailySnapshots(database, accounts) {
    if (!accounts.length) return;
    await database.query(`
        INSERT INTO depannhome_storage_snapshots(account_owner_id,captured_on,usage_bytes,breakdown)
        SELECT item.account_id,CURRENT_DATE,item.usage_bytes,item.breakdown
        FROM jsonb_to_recordset($1::jsonb) AS item(account_id bigint,usage_bytes bigint,breakdown jsonb)
        ON CONFLICT(account_owner_id,captured_on) DO UPDATE
        SET usage_bytes=EXCLUDED.usage_bytes,breakdown=EXCLUDED.breakdown,captured_at=NOW()
    `, [JSON.stringify(accounts.map(account => ({ account_id: account.accountId, usage_bytes: account.usageBytes, breakdown: account.breakdown }))) ]);
}

async function loadThirtyDayBaselines(database, accountIds) {
    if (!accountIds.length) return new Map();
    const { rows } = await database.query(`
        SELECT DISTINCT ON(account_owner_id) account_owner_id AS "accountId",usage_bytes AS "usageBytes"
        FROM depannhome_storage_snapshots
        WHERE account_owner_id=ANY($1::bigint[]) AND captured_on<=CURRENT_DATE-30
        ORDER BY account_owner_id,captured_on DESC
    `, [accountIds]);
    return new Map(rows.map(row => [String(row.accountId), toSafeBytes(row.usageBytes)]));
}

function toSafeBytes(value) {
    const bytes = Number(value) || 0;
    return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0;
}
