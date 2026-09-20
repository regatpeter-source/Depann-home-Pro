const DEDICATED_MOBILE_ROLES = new Set(["mobile_admin", "team_lead", "technician"]);

export function isDedicatedMobileSession(user) {
    return user?.deviceType === "mobile" && DEDICATED_MOBILE_ROLES.has(user?.role);
}

export function canEditAssignedClients(user) {
    return isDedicatedMobileSession(user) && user?.canManageCalendar === true;
}

export async function hasAdministrativeClientAssignment(database, ownerId, clientId, userId) {
    const { rows } = await database.query(`
        SELECT EXISTS (
            SELECT 1
            FROM depannhome_clients client
            JOIN depannhome_calendar_events event
                ON event.owner_id = client.owner_id AND event.client_id = client.client_id
            WHERE client.owner_id = $1 AND client.client_id = $2
                AND event.created_device_type = 'desktop'
                AND (
                    event.assigned_technician_id = $3::bigint
                    OR EXISTS (
                        SELECT 1 FROM depannhome_calendar_assignments assignment
                        WHERE assignment.event_id = event.id AND assignment.technician_id = $3::bigint
                    )
                )
        ) AS allowed
    `, [ownerId, clientId, userId]);
    return rows[0]?.allowed === true;
}
