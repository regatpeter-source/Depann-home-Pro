DO $$
BEGIN
    IF to_regclass('depannhome_calendar_events') IS NOT NULL THEN
        UPDATE depannhome_calendar_events event
        SET event_status = 'cancelled', updated_at = NOW()
        WHERE event.event_type = 'appointment'
            AND event.paused_at IS NOT NULL
            AND event.event_status IN ('planned', 'confirmed', 'in_progress')
            AND NOT EXISTS (
                SELECT 1
                FROM depannhome_calendar_events resumed
                WHERE resumed.owner_id = event.owner_id
                    AND resumed.rescheduled_from_event_id = event.id
            );
    END IF;
END $$;