CREATE TABLE IF NOT EXISTS depannhome_offline_operations (
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    operation_id UUID NOT NULL,
    method VARCHAR(10) NOT NULL,
    path TEXT NOT NULL,
    response_status INTEGER,
    response_type TEXT NOT NULL DEFAULT '',
    response_body TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    PRIMARY KEY (owner_id, user_id, operation_id)
);

CREATE INDEX IF NOT EXISTS depannhome_offline_operations_created_idx
    ON depannhome_offline_operations(created_at);
