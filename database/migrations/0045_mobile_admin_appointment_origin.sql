DO $$
BEGIN
    IF to_regclass('depannhome_calendar_events') IS NOT NULL
        AND to_regclass('depannhome_users') IS NOT NULL
        AND EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'depannhome_calendar_events' AND column_name = 'created_by'
        ) THEN
        UPDATE depannhome_calendar_events event
        SET created_device_type = 'desktop'
        FROM depannhome_users creator
        WHERE creator.id = event.created_by
            AND creator.role IN ('admin', 'mobile_admin')
            AND event.created_device_type = 'mobile';
    END IF;
END $$;
