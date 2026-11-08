export function getActiveCompanyId(user) {
    return String(user?.activeCompanyId || user?.accountOwnerId || user?.id || "");
}

export function getSessionDisplayName(user) {
    return String(user?.fullName || "").trim() || String(user?.username || "").trim();
}

export function sessionAccessIdentity(user) {
    return JSON.stringify({
        id: String(user?.id || ""),
        activeCompanyId: getActiveCompanyId(user),
        role: String(user?.role || ""),
        deviceType: String(user?.deviceType || ""),
        canManageCalendar: user?.canManageCalendar === true,
        supportSessionId: String(user?.supportSessionId || "")
    });
}
