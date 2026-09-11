const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function companySeatState(database, ownerId, excludedMemberId = 0, excludedDeviceId = null) {
    const normalizedExcludedDeviceId = UUID_PATTERN.test(String(excludedDeviceId || "")) ? String(excludedDeviceId) : null;
    const { rows } = await database.query(`
        SELECT
            COALESCE(allocation.allocated_pc_seats,owner.max_pc_users)::int AS "maxPcUsers",
            COALESCE(allocation.allocated_mobile_seats,owner.max_technicians)::int AS "maxMobileUsers",
            COUNT(DISTINCT member.id) FILTER(WHERE member.role IN ('admin','pc_standard','commercial','accountant') AND member.is_active AND member.id<>$2)::int AS "activePcUsers",
            COUNT(DISTINCT desktop_device.id) FILTER(WHERE desktop_device.status='approved' AND ($3::uuid IS NULL OR desktop_device.id<>$3::uuid))::int AS "approvedPcDevices",
            COUNT(DISTINCT member.id) FILTER(WHERE member.role IN ('mobile_admin','team_lead','technician') AND member.is_active AND member.id<>$2)::int
                + COUNT(DISTINCT mobile_device.id) FILTER(WHERE mobile_device.status='approved' AND ($3::uuid IS NULL OR mobile_device.id<>$3::uuid))::int AS "activeMobileUsers"
        FROM depannhome_users owner
        LEFT JOIN depannhome_group_company_seat_allocations allocation ON allocation.company_owner_id=owner.id
        LEFT JOIN depannhome_users member ON member.account_owner_id=owner.id
        LEFT JOIN depannhome_users cross_device_account ON cross_device_account.account_owner_id=owner.id
            AND cross_device_account.role IN ('admin','commercial') AND cross_device_account.is_active AND cross_device_account.id<>$2
        LEFT JOIN depannhome_auth_devices desktop_device ON desktop_device.user_id=member.id AND desktop_device.device_type='desktop'
            AND member.role IN ('admin','pc_standard','commercial','accountant')
        LEFT JOIN depannhome_auth_devices mobile_device ON mobile_device.user_id=cross_device_account.id AND mobile_device.device_type='mobile'
        WHERE owner.id=$1 AND owner.account_owner_id=owner.id
        GROUP BY owner.id,allocation.allocated_pc_seats,allocation.allocated_mobile_seats
    `, [ownerId, excludedMemberId, normalizedExcludedDeviceId]);
    return rows[0] || null;
}

export async function groupSeatStatus(database, groupId) {
    const { rows } = await database.query(`
        SELECT entitlement.principal_company_owner_id AS "principalCompanyId",entitlement.max_companies AS "maxCompanies",
            entitlement.total_pc_seats AS "totalPcSeats",entitlement.total_mobile_seats AS "totalMobileSeats",
            company.company_owner_id AS "companyId",company.is_active AS "isActive",owner.company_name AS "companyName",
            allocation.allocated_pc_seats AS "allocatedPcSeats",allocation.allocated_mobile_seats AS "allocatedMobileSeats"
        FROM depannhome_group_entitlements entitlement
        JOIN depannhome_group_companies company ON company.group_id=entitlement.group_id
        JOIN depannhome_users owner ON owner.id=company.company_owner_id
        LEFT JOIN depannhome_group_company_seat_allocations allocation
            ON allocation.group_id=company.group_id AND allocation.company_owner_id=company.company_owner_id
        WHERE entitlement.group_id=$1 ORDER BY owner.id
    `, [groupId]);
    if (!rows.length) return null;
    const companies = [];
    for (const row of rows) {
        const usage = await companySeatState(database, row.companyId);
        companies.push({
            id: String(row.companyId), companyName: row.companyName || "Entreprise", isActive: row.isActive,
            isPrincipal: String(row.companyId) === String(row.principalCompanyId),
            allocatedPcSeats: Number(row.allocatedPcSeats) || 0,
            allocatedMobileSeats: Number(row.allocatedMobileSeats) || 0,
            activePcUsers: Number(usage?.activePcUsers) || 0,
            approvedPcDevices: Number(usage?.approvedPcDevices) || 0,
            activeMobileUsers: Number(usage?.activeMobileUsers) || 0
        });
    }
    const allocatedPcSeats = companies.reduce((sum, company) => sum + company.allocatedPcSeats, 0);
    const allocatedMobileSeats = companies.reduce((sum, company) => sum + company.allocatedMobileSeats, 0);
    return {
        principalCompanyId: String(rows[0].principalCompanyId), maxCompanies: Number(rows[0].maxCompanies),
        totalPcSeats: Number(rows[0].totalPcSeats), totalMobileSeats: Number(rows[0].totalMobileSeats),
        companyCount: companies.length, allocatedPcSeats, allocatedMobileSeats,
        availableCompanies: Math.max(0, Number(rows[0].maxCompanies) - companies.length),
        availablePcSeats: Math.max(0, Number(rows[0].totalPcSeats) - allocatedPcSeats),
        availableMobileSeats: Math.max(0, Number(rows[0].totalMobileSeats) - allocatedMobileSeats), companies
    };
}

export async function subscriptionOwnerId(database, companyOwnerId) {
    const { rows } = await database.query(`
        SELECT entitlement.principal_company_owner_id AS id
        FROM depannhome_group_companies company
        JOIN depannhome_group_entitlements entitlement ON entitlement.group_id=company.group_id
        WHERE company.company_owner_id=$1
    `, [companyOwnerId]);
    return String(rows[0]?.id || companyOwnerId);
}
