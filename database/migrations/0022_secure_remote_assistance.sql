ALTER TABLE depannhome_creator_support_sessions
    ADD COLUMN IF NOT EXISTS access_scope VARCHAR(20) NOT NULL DEFAULT 'diagnostic',
    ADD COLUMN IF NOT EXISTS control_started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS control_last_seen_at TIMESTAMPTZ;

ALTER TABLE depannhome_creator_support_sessions
    DROP CONSTRAINT IF EXISTS depannhome_creator_support_sessions_access_scope_check;

ALTER TABLE depannhome_creator_support_sessions
    ADD CONSTRAINT depannhome_creator_support_sessions_access_scope_check
    CHECK (access_scope IN ('diagnostic','control'));

CREATE TABLE IF NOT EXISTS depannhome_creator_support_activity (
    id BIGSERIAL PRIMARY KEY,
    support_session_id UUID NOT NULL REFERENCES depannhome_creator_support_sessions(id) ON DELETE CASCADE,
    creator_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE RESTRICT,
    target_company_owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    method VARCHAR(10) NOT NULL,
    path VARCHAR(300) NOT NULL,
    status_code INTEGER NOT NULL DEFAULT 0,
    outcome VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending','success','failure','blocked')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS depannhome_creator_support_activity_session_created_idx
    ON depannhome_creator_support_activity(support_session_id,created_at DESC);
CREATE INDEX IF NOT EXISTS depannhome_creator_support_activity_company_created_idx
    ON depannhome_creator_support_activity(target_company_owner_id,created_at DESC);
