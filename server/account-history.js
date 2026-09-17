const ACCOUNT_HISTORY_FIELDS = Object.freeze([
    "companyName", "fullName", "phone", "billingEmail", "maxPcUsers", "maxTechnicians", "maxGroupCompanies",
    "subscriptionPlan", "subscriptionTier", "subscriptionLabel", "monthlyPriceCents", "subscriptionStatus",
    "subscriptionRenewalDate", "discountLabel", "discountMode", "discountValue", "billingReference",
    "creatorNote", "quoteTemplatePolicy", "quitusTemplatePolicy", "reportTemplatePolicy", "isActive"
]);

export function accountHistorySnapshot(value = {}) {
    const normalized = {
        ...value,
        discountLabel: value.discountLabel ?? value.subscriptionDiscountLabel,
        discountMode: value.discountMode ?? value.subscriptionDiscountMode,
        discountValue: value.discountValue ?? value.subscriptionDiscountValue
    };
    return Object.fromEntries(ACCOUNT_HISTORY_FIELDS.filter(field => normalized[field] !== undefined).map(field => [field, normalized[field]]));
}

export function accountHistoryChanges(previous = {}, next = {}) {
    const previousSnapshot = accountHistorySnapshot(previous);
    const nextSnapshot = accountHistorySnapshot(next);
    const changedFields = [...new Set([...Object.keys(previousSnapshot), ...Object.keys(nextSnapshot)])]
        .filter(field => JSON.stringify(previousSnapshot[field] ?? null) !== JSON.stringify(nextSnapshot[field] ?? null));
    return {
        previousValue: Object.fromEntries(changedFields.map(field => [field, previousSnapshot[field] ?? null])),
        nextValue: Object.fromEntries(changedFields.map(field => [field, nextSnapshot[field] ?? null]))
    };
}

export async function recordAccountHistory(database, { accountOwnerId, actorId = null, action = "account_updated", previous = {}, next = {} }) {
    const changes = accountHistoryChanges(previous, next);
    if (!Object.keys(changes.nextValue).length) return false;
    await database.query(`INSERT INTO depannhome_account_audit(account_owner_id,actor_id,action,previous_value,next_value)
        VALUES($1,$2,$3,$4::jsonb,$5::jsonb)`, [accountOwnerId, actorId, action, JSON.stringify(changes.previousValue), JSON.stringify(changes.nextValue)]);
    return true;
}
