import { getPool } from "./database.js";

export async function resolveGroupCompany(userId, activeCompanyId) {
    const { rows } = await getPool().query(`
        SELECT group_data.id AS "groupId", group_data.name AS "groupName",
            company.company_owner_id AS "companyId", owner.company_name AS "companyName"
        FROM depannhome_group_administrators administrator
        JOIN depannhome_groups group_data ON group_data.id = administrator.group_id AND group_data.is_active = TRUE
        JOIN depannhome_group_companies company ON company.group_id = group_data.id AND company.is_active = TRUE
        JOIN depannhome_users owner ON owner.id = company.company_owner_id AND owner.is_active = TRUE
        WHERE administrator.user_id = $1
        ORDER BY CASE WHEN company.company_owner_id = $2::bigint THEN 0 ELSE 1 END, company.company_owner_id
        LIMIT 1
    `, [userId, positiveId(activeCompanyId) || null]);
    return rows[0] || null;
}

function positiveId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
}
