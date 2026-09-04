import { getPool } from "./database.js";

export async function resolveGroupCompany(userId, activeCompanyId) {
    const { rows } = await getPool().query(`
        SELECT group_data.id AS "groupId", group_data.name AS "groupName",
            company.company_owner_id AS "companyId", owner.company_name AS "companyName",
            EXISTS (
                SELECT 1 FROM depannhome_group_administrators administrator
                WHERE administrator.group_id = group_data.id AND administrator.user_id = principal.id
            ) AS "isGroupAdministrator"
        FROM depannhome_users principal
        JOIN depannhome_group_companies home_company ON home_company.company_owner_id = principal.account_owner_id AND home_company.is_active = TRUE
        JOIN depannhome_groups group_data ON group_data.id = home_company.group_id AND group_data.is_active = TRUE
        JOIN depannhome_group_companies company ON company.group_id = group_data.id AND company.is_active = TRUE
        JOIN depannhome_users owner ON owner.id = company.company_owner_id AND owner.is_active = TRUE
        JOIN depannhome_users home_owner ON home_owner.id = principal.account_owner_id AND home_owner.is_active = TRUE
        WHERE principal.id = $1
            AND home_owner.subscription_tier = 'pro'
            AND owner.subscription_tier = 'pro'
            AND (
                principal.role = 'admin'
                OR (
                    principal.role IN ('pc_standard', 'commercial', 'accountant')
                    AND principal.can_switch_group_companies = TRUE
                )
            )
        ORDER BY CASE WHEN company.company_owner_id = $2::bigint THEN 0 WHEN company.company_owner_id = principal.account_owner_id THEN 1 ELSE 2 END, company.company_owner_id
        LIMIT 1
    `, [userId, positiveId(activeCompanyId) || null]);
    return rows[0] || null;
}

function positiveId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
}
