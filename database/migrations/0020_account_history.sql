CREATE TABLE IF NOT EXISTS depannhome_account_audit (
    id BIGSERIAL PRIMARY KEY,
    account_owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    actor_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    action VARCHAR(40) NOT NULL,
    previous_value JSONB NOT NULL DEFAULT '{}'::jsonb,
    next_value JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS depannhome_account_audit_owner_created_idx
    ON depannhome_account_audit(account_owner_id, created_at DESC);
