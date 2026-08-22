const PARTNER_MISSION_ASSIGNMENT_ROLES = Object.freeze(["mobile_admin", "team_lead", "technician"]);

export async function validateAssignedCompanyMembers(database, ownerId, memberIds, allowedRoles = []) {
    const requestedIds = Array.isArray(memberIds) ? memberIds : [];
    const ids = [...new Set(requestedIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
    if (!ids.length) return "";
    if (ids.length !== requestedIds.length) return assignmentError();
    const roles = Array.isArray(allowedRoles) ? allowedRoles : [];
    const { rowCount } = await database.query(`
        SELECT 1
        FROM depannhome_users
        WHERE id = ANY($1::bigint[])
            AND account_owner_id = $2
            AND is_active = TRUE
            AND (cardinality($3::text[]) = 0 OR role = ANY($3::text[]))
    `, [ids, ownerId, roles]);
    return rowCount === ids.length ? "" : assignmentError();
}

export function assignmentError() {
    return "Un membre sélectionné est inactif ou rattaché à une autre entreprise.";
}

export { PARTNER_MISSION_ASSIGNMENT_ROLES };
