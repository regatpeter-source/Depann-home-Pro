const ADVANCED_TIERS = new Set(["basic_plus", "pro"]);
const CONFIGURABLE_PC_ROLES = new Set(["pc_standard", "accountant"]);

export function hasAdvancedWorkstationTier(user) {
    return ADVANCED_TIERS.has(user?.organization?.subscriptionTier || user?.subscriptionTier || "");
}

export function hasBillingWorkspaceAccess(user) {
    if (user?.role === "admin") return true;
    if (!CONFIGURABLE_PC_ROLES.has(user?.role)) return true;
    return hasAdvancedWorkstationTier(user) && user?.canAccessBilling === true;
}

export function hasAccountingWorkspaceAccess(user) {
    if (user?.role === "admin") return true;
    return CONFIGURABLE_PC_ROLES.has(user?.role)
        && hasAdvancedWorkstationTier(user)
        && user?.canAccessAccounting === true;
}

export function hasGroupCompanySwitchAccess(user) {
    const tier = user?.organization?.subscriptionTier || user?.subscriptionTier || "";
    if (!user?.groupId || user.deviceType !== "desktop" || tier !== "pro") return false;
    if (user.role === "admin") return true;
    return CONFIGURABLE_PC_ROLES.has(user.role)
        && user.canSwitchGroupCompanies === true;
}

export function supportsConfigurablePcPermissions(role) {
    return CONFIGURABLE_PC_ROLES.has(role);
}

export function isAdvancedWorkstationTier(tier) {
    return ADVANCED_TIERS.has(tier);
}

export function hasCompanyEmailWorkspaceAccess(user) {
    if (!hasAdvancedWorkstationTier(user)) return false;
    if (["admin", "mobile_admin"].includes(user?.role)) return true;
    return user?.deviceType === "desktop"
        && CONFIGURABLE_PC_ROLES.has(user?.role)
        && user?.canAccessCompanyEmail === true;
}