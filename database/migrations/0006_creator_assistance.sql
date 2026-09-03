CREATE TABLE IF NOT EXISTS depannhome_creator_support_sessions (
    id UUID PRIMARY KEY,
    created_by BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE RESTRICT,
    target_company_owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    mode VARCHAR(20) NOT NULL DEFAULT 'readonly' CHECK (mode IN ('readonly','emergency')),
    reason VARCHAR(1000) NOT NULL,
    support_request_id BIGINT REFERENCES depannhome_support_requests(id) ON DELETE SET NULL,
    consent_basis VARCHAR(30) NOT NULL CHECK (consent_basis IN ('support_request','confirmed','emergency')),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    revoked_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    revoke_reason VARCHAR(500) NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_creator_support_sessions_creator_idx ON depannhome_creator_support_sessions(created_by, created_at DESC);
CREATE INDEX IF NOT EXISTS depannhome_creator_support_sessions_company_idx ON depannhome_creator_support_sessions(target_company_owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS depannhome_creator_support_sessions_active_idx ON depannhome_creator_support_sessions(expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS depannhome_creator_recovery_actions (
    id UUID PRIMARY KEY,
    support_session_id UUID NOT NULL REFERENCES depannhome_creator_support_sessions(id) ON DELETE RESTRICT,
    created_by BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE RESTRICT,
    target_company_owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    action_type VARCHAR(50) NOT NULL CHECK (action_type IN ('restore_company','reactivate_company','reactivate_administrator','reset_administrator_2fa','revoke_company_sessions','reject_device','release_company_locks')),
    target_resource_type VARCHAR(30) NOT NULL DEFAULT '',
    target_resource_id VARCHAR(120) NOT NULL DEFAULT '',
    reason VARCHAR(1000) NOT NULL,
    previous_state JSONB NOT NULL DEFAULT '{}'::jsonb,
    new_state JSONB NOT NULL DEFAULT '{}'::jsonb,
    status VARCHAR(20) NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','failed')),
    error_message VARCHAR(500) NOT NULL DEFAULT '',
    is_emergency BOOLEAN NOT NULL DEFAULT FALSE,
    company_notified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_creator_recovery_actions_company_idx ON depannhome_creator_recovery_actions(target_company_owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS depannhome_creator_recovery_actions_session_idx ON depannhome_creator_recovery_actions(support_session_id, created_at DESC);
