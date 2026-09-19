DO $$
BEGIN
    IF to_regclass('depannhome_calendar_events') IS NOT NULL THEN
        ALTER TABLE depannhome_calendar_events
        ADD COLUMN IF NOT EXISTS rescheduled_from_event_id BIGINT REFERENCES depannhome_calendar_events(id) ON DELETE SET NULL;

        CREATE UNIQUE INDEX IF NOT EXISTS depannhome_calendar_events_rescheduled_from_idx
        ON depannhome_calendar_events (rescheduled_from_event_id)
        WHERE rescheduled_from_event_id IS NOT NULL;
    END IF;
END $$;
