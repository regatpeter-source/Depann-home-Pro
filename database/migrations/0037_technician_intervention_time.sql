CREATE TABLE IF NOT EXISTS depannhome_intervention_work_sessions (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    event_id BIGINT NOT NULL,
    technician_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT depannhome_intervention_work_session_dates_check CHECK (ended_at IS NULL OR ended_at >= started_at)
);

DO $$
BEGIN
    IF to_regclass('depannhome_calendar_events') IS NOT NULL
       AND NOT EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conname = 'depannhome_intervention_work_sessions_event_fk'
       ) THEN
        ALTER TABLE depannhome_intervention_work_sessions
            ADD CONSTRAINT depannhome_intervention_work_sessions_event_fk
            FOREIGN KEY (event_id) REFERENCES depannhome_calendar_events(id) ON DELETE CASCADE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS depannhome_intervention_work_sessions_event_idx
    ON depannhome_intervention_work_sessions(owner_id,event_id,technician_id,started_at);

CREATE UNIQUE INDEX IF NOT EXISTS depannhome_intervention_work_sessions_open_technician_idx
    ON depannhome_intervention_work_sessions(owner_id,technician_id)
    WHERE ended_at IS NULL;
