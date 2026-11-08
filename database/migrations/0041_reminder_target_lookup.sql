CREATE INDEX IF NOT EXISTS depannhome_internal_reminders_target_idx
    ON depannhome_internal_reminders(owner_id,rule_id,reminder_type,entity_type,entity_id,due_at);
