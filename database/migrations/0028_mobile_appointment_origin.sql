DO $$
BEGIN
    IF to_regclass('depannhome_calendar_events') IS NOT NULL THEN
        ALTER TABLE depannhome_calendar_events
            ADD COLUMN IF NOT EXISTS created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
            ADD COLUMN IF NOT EXISTS created_device_type VARCHAR(10) NOT NULL DEFAULT 'desktop';

        UPDATE depannhome_calendar_events
        SET created_device_type = 'desktop'
        WHERE created_device_type NOT IN ('desktop', 'mobile');

        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'depannhome_calendar_events_created_device_type_check'
        ) THEN
            ALTER TABLE depannhome_calendar_events
                ADD CONSTRAINT depannhome_calendar_events_created_device_type_check
                CHECK (created_device_type IN ('desktop', 'mobile'));
        END IF;

        CREATE INDEX IF NOT EXISTS depannhome_calendar_events_admin_client_idx
            ON depannhome_calendar_events (owner_id, client_id)
            WHERE created_device_type = 'desktop' AND client_id <> '';
    END IF;
END $$;
