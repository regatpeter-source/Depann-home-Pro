-- Essais d'abonnement de 15 jours, renouvelables uniquement par le Créateur.
ALTER TABLE depannhome_users
    ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS trial_renewal_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE depannhome_users DROP CONSTRAINT IF EXISTS depannhome_users_trial_renewal_count_check;
ALTER TABLE depannhome_users ADD CONSTRAINT depannhome_users_trial_renewal_count_check CHECK (trial_renewal_count >= 0);
CREATE INDEX IF NOT EXISTS depannhome_users_active_trial_end_idx
    ON depannhome_users(trial_ends_at)
    WHERE trial_ends_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS depannhome_subscription_trial_audit (
    id BIGSERIAL PRIMARY KEY,
    account_owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    actor_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    action VARCHAR(20) NOT NULL CHECK (action IN ('activated','renewed','expired','ended','converted')),
    previous_ends_at TIMESTAMPTZ,
    next_ends_at TIMESTAMPTZ,
    renewal_count INTEGER NOT NULL DEFAULT 0 CHECK (renewal_count >= 0),
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_subscription_trial_audit_owner_idx
    ON depannhome_subscription_trial_audit(account_owner_id, created_at DESC);
