-- Certaines pauses créées avant le modèle à intervention unique ont été
-- marquées « cancelled » sans qu'une intervention de reprise ait été créée.
-- Elles restent de vraies pauses et doivent pouvoir être déplacées sous le
-- même identifiant.
DO $$
BEGIN
    IF to_regclass('depannhome_calendar_events') IS NULL THEN RETURN; END IF;

    UPDATE depannhome_calendar_events event
    SET event_status='paused',updated_at=NOW()
    WHERE event.event_type='appointment'
        AND event.paused_at IS NOT NULL
        AND event.event_status='cancelled'
        AND NOT EXISTS (
            SELECT 1 FROM depannhome_calendar_events resumed
            WHERE resumed.owner_id=event.owner_id
                AND resumed.rescheduled_from_event_id=event.id
        );
END $$;