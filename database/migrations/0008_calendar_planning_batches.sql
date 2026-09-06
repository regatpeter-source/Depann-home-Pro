ALTER TABLE depannhome_calendar_events
ADD COLUMN IF NOT EXISTS planning_batch_id UUID;

CREATE INDEX IF NOT EXISTS depannhome_calendar_events_planning_batch_idx
ON depannhome_calendar_events(owner_id, planning_batch_id)
WHERE planning_batch_id IS NOT NULL;