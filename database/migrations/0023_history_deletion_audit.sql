CREATE TABLE IF NOT EXISTS depannhome_history_deletion_audit (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    actor_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    deletion_mode VARCHAR(20) NOT NULL CHECK (deletion_mode IN ('selected','filtered')),
    categories JSONB NOT NULL DEFAULT '[]'::jsonb,
    deleted_count INTEGER NOT NULL DEFAULT 0 CHECK (deleted_count >= 0),
    reason VARCHAR(500) NOT NULL,
    period_from TIMESTAMPTZ,
    period_to TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_history_deletion_audit_owner_created_idx ON depannhome_history_deletion_audit(owner_id, created_at DESC);
