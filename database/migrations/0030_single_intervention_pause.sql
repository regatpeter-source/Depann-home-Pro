-- La pause devient un état métier distinct. Les reprises créées après cette
-- migration déplacent la même intervention et conservent donc son identifiant.
DO $$
BEGIN
    IF to_regclass('depannhome_calendar_events') IS NULL THEN RETURN; END IF;

    ALTER TABLE depannhome_calendar_events
        DROP CONSTRAINT IF EXISTS depannhome_calendar_events_status_check;
    ALTER TABLE depannhome_calendar_events
        ADD CONSTRAINT depannhome_calendar_events_status_check
        CHECK (event_status IN ('planned','confirmed','in_progress','completed','cancelled','paused'));

    UPDATE depannhome_calendar_events event
    SET event_status='paused',updated_at=NOW()
    WHERE event.event_type='appointment'
        AND event.paused_at IS NOT NULL
        AND event.event_status IN ('planned','confirmed','in_progress','cancelled')
        AND NOT EXISTS (
            SELECT 1 FROM depannhome_calendar_events resumed
            WHERE resumed.owner_id=event.owner_id
                AND resumed.rescheduled_from_event_id=event.id
        );
END $$;