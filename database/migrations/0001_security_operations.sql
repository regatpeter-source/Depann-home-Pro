CREATE TABLE IF NOT EXISTS depannhome_security_events (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT,
    user_id BIGINT,
    event_type VARCHAR(80) NOT NULL,
    outcome VARCHAR(20) NOT NULL CHECK(outcome IN ('success','failure','blocked','information')),
    ip_hash CHAR(64) NOT NULL DEFAULT '',
    user_agent_hash CHAR(64) NOT NULL DEFAULT '',
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS depannhome_security_events_type_time_idx
    ON depannhome_security_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS depannhome_security_events_user_time_idx
    ON depannhome_security_events(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS depannhome_creator_totp_challenges (
    id UUID PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    device JSONB NOT NULL DEFAULT '{}'::jsonb,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS depannhome_creator_totp_challenges_user_idx
    ON depannhome_creator_totp_challenges(user_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS depannhome_backup_history (
    id BIGSERIAL PRIMARY KEY,
    backup_id UUID NOT NULL UNIQUE,
    filename VARCHAR(255) NOT NULL,
    file_size BIGINT NOT NULL CHECK(file_size >= 0),
    sha256 CHAR(64) NOT NULL,
    database_name VARCHAR(160) NOT NULL DEFAULT '',
    status VARCHAR(20) NOT NULL CHECK(status IN ('created','verified','failed','restored')),
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS depannhome_backup_history_created_idx
    ON depannhome_backup_history(created_at DESC);
