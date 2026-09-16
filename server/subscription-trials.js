import { getPool } from "./database.js";

export const SUBSCRIPTION_TRIAL_DAYS = 15;

export function trialDaysRemaining(endsAt, now = new Date()) {
    const end = new Date(endsAt).getTime();
    const current = new Date(now).getTime();
    if (!Number.isFinite(end) || !Number.isFinite(current)) return 0;
    return Math.max(0, Math.ceil((end - current) / 86_400_000));
}

export function nextTrialEnd(previousEnd, now = new Date(), days = SUBSCRIPTION_TRIAL_DAYS) {
    const current = new Date(now);
    if (Number.isNaN(current.getTime()) || !Number.isInteger(days) || days <= 0) throw new TypeError("Période d’essai invalide.");
    const previous = previousEnd ? new Date(previousEnd) : null;
    const base = previous && !Number.isNaN(previous.getTime()) && previous > current ? previous : current;
    return new Date(base.getTime() + days * 86_400_000);
}

export async function activateOrRenewSubscriptionTrial(accountOwnerId, actorId, database = getPool()) {
    const connection = typeof database.connect === "function" ? await database.connect() : database;
    const ownsConnection = connection !== database;
    try {
        await connection.query("BEGIN");
        const { rows } = await connection.query(`
            SELECT id,username,is_archived,subscription_plan,subscription_status,trial_started_at,trial_ends_at,trial_renewal_count
            FROM depannhome_users WHERE id=$1 AND account_owner_id=id FOR UPDATE
        `, [accountOwnerId]);
        const owner = rows[0];
        if (!owner) throw trialError(404, "Entreprise introuvable.");
        if (owner.is_archived) throw trialError(409, "Réactivez l’entreprise avant de démarrer ou renouveler son essai.");
        if (owner.subscription_plan !== "paid") throw trialError(409, "Un essai concerne uniquement une offre payante Depann’Home Pro.");

        const now = new Date();
        const firstActivation = !owner.trial_started_at;
        const action = firstActivation ? "activated" : "renewed";
        const nextEnd = nextTrialEnd(owner.trial_ends_at, now);
        const renewalCount = firstActivation ? 0 : Number(owner.trial_renewal_count || 0) + 1;
        const updated = await connection.query(`
            UPDATE depannhome_users
            SET subscription_status='trial',is_active=TRUE,
                trial_started_at=COALESCE(trial_started_at,NOW()),trial_ends_at=$2,trial_renewal_count=$3,updated_at=NOW()
            WHERE id=$1
            RETURNING trial_started_at AS "trialStartedAt",trial_ends_at AS "trialEndsAt",trial_renewal_count AS "trialRenewalCount",subscription_status AS "subscriptionStatus",is_active AS "isActive"
        `, [accountOwnerId, nextEnd.toISOString(), renewalCount]);
        const cancelled = await connection.query(`
            UPDATE depannhome_subscription_invoices
            SET status='cancelled',last_error='Facture annulée : période d’essai sans facturation.',updated_at=NOW()
            WHERE account_owner_id=$1 AND status IN ('pending','failed')
            RETURNING id
        `, [accountOwnerId]);
        await connection.query(`
            INSERT INTO depannhome_subscription_trial_audit(account_owner_id,actor_id,action,previous_ends_at,next_ends_at,renewal_count,details)
            VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
        `, [accountOwnerId, actorId || null, action, owner.trial_ends_at || null, nextEnd.toISOString(), renewalCount, JSON.stringify({ durationDays: SUBSCRIPTION_TRIAL_DAYS, cancelledInvoiceIds: cancelled.rows.map(invoice => String(invoice.id)) })]);
        await connection.query("COMMIT");
        return { ...updated.rows[0], action, daysRemaining: trialDaysRemaining(nextEnd, now), cancelledInvoiceCount: cancelled.rowCount };
    } catch (error) {
        await connection.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        if (ownsConnection) connection.release();
    }
}

export async function expireSubscriptionTrials(database = getPool(), accountOwnerId = null) {
    const { rows } = await database.query(`
        WITH expired AS (
            UPDATE depannhome_users
            SET subscription_status='suspended',is_active=FALSE,updated_at=NOW()
            WHERE account_owner_id=id AND subscription_status='trial' AND is_archived=FALSE
                AND trial_ends_at IS NOT NULL AND trial_ends_at<=NOW()
                AND ($1::bigint IS NULL OR id=$1)
            RETURNING id,trial_ends_at,trial_renewal_count
        ), audit AS (
            INSERT INTO depannhome_subscription_trial_audit(account_owner_id,action,previous_ends_at,renewal_count,details)
            SELECT id,'expired',trial_ends_at,trial_renewal_count,'{"automatic":true}'::jsonb FROM expired
            RETURNING account_owner_id
        )
        SELECT account_owner_id AS "accountOwnerId" FROM audit
    `, [accountOwnerId]);
    return rows.map(row => String(row.accountOwnerId));
}

export async function convertTrialToPaidSubscription(accountOwnerId, actorId, database = getPool()) {
    const connection = typeof database.connect === "function" ? await database.connect() : database;
    const ownsConnection = connection !== database;
    try {
        await connection.query("BEGIN");
        const { rows } = await connection.query(`
            SELECT id,is_archived,subscription_plan,subscription_status,trial_started_at,trial_ends_at,trial_renewal_count
            FROM depannhome_users WHERE id=$1 AND account_owner_id=id FOR UPDATE
        `, [accountOwnerId]);
        const owner = rows[0];
        if (!owner) throw trialError(404, "Entreprise introuvable.");
        if (owner.is_archived) throw trialError(409, "Réactivez l’entreprise avant de démarrer son abonnement payant.");
        if (owner.subscription_plan !== "paid" || !owner.trial_started_at) throw trialError(409, "Cette entreprise ne possède aucun essai convertible en abonnement payant.");
        if (!['trial', 'suspended'].includes(owner.subscription_status)) throw trialError(409, "L’abonnement de cette entreprise est déjà dans un autre état.");

        const updated = await connection.query(`
            UPDATE depannhome_users
            SET subscription_status='active',is_active=TRUE,subscription_renewal_date=CURRENT_DATE,updated_at=NOW()
            WHERE id=$1
            RETURNING subscription_status AS "subscriptionStatus",is_active AS "isActive",TO_CHAR(subscription_renewal_date,'YYYY-MM-DD') AS "subscriptionRenewalDate"
        `, [accountOwnerId]);
        await connection.query(`
            INSERT INTO depannhome_subscription_trial_audit(account_owner_id,actor_id,action,previous_ends_at,renewal_count,details)
            VALUES($1,$2,'converted',$3,$4,$5::jsonb)
        `, [accountOwnerId, actorId || null, owner.trial_ends_at || null, Number(owner.trial_renewal_count || 0), JSON.stringify({ previousSubscriptionStatus: owner.subscription_status, billingStartsOn: updated.rows[0].subscriptionRenewalDate })]);
        await connection.query("COMMIT");
        return updated.rows[0];
    } catch (error) {
        await connection.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        if (ownsConnection) connection.release();
    }
}

function trialError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}
