export const CLIENT_STATUS_ACTIVE = "active";
export const CLIENT_STATUS_ARCHIVED = "archived";

export function normalizeClientStatus(value) {
    return value === CLIENT_STATUS_ARCHIVED ? CLIENT_STATUS_ARCHIVED : CLIENT_STATUS_ACTIVE;
}

export function clientLifecycleDecision(summary = {}, client = {}) {
    const dependencies = Object.fromEntries(Object.entries(summary).map(([key, value]) => [key, Math.max(0, Number(value) || 0)]));
    const attachments = Array.isArray(client?.attachments) ? client.attachments.length : 0;
    const significantActivities = (Array.isArray(client?.activityHistory) ? client.activityHistory : [])
        .filter(activity => !["client", "profile"].includes(String(activity?.type || ""))).length;
    const totalDependencies = Object.values(dependencies).reduce((total, count) => total + count, 0) + attachments + significantActivities;
    return {
        canDeletePermanently: totalDependencies === 0,
        mustArchive: totalDependencies > 0,
        totalDependencies,
        dependencies: { ...dependencies, attachments, activityHistory: significantActivities }
    };
}

export function clientIsSelectable(client) {
    return normalizeClientStatus(client?.clientStatus) === CLIENT_STATUS_ACTIVE;
}
