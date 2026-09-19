DO $$
BEGIN
	IF to_regclass('depannhome_billing_documents') IS NOT NULL THEN
		ALTER TABLE depannhome_billing_documents
		ADD COLUMN IF NOT EXISTS follow_up_date DATE;

		IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'depannhome_billing_documents' AND column_name = 'owner_id')
			AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'depannhome_billing_documents' AND column_name = 'document_type') THEN
			CREATE INDEX IF NOT EXISTS depannhome_billing_documents_follow_up_idx
			ON depannhome_billing_documents (owner_id, follow_up_date)
			WHERE document_type = 'quote' AND follow_up_date IS NOT NULL;
		END IF;
	END IF;

	IF to_regclass('depannhome_calendar_events') IS NOT NULL THEN
		ALTER TABLE depannhome_calendar_events
		ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ,
		ADD COLUMN IF NOT EXISTS pause_reason VARCHAR(40) NOT NULL DEFAULT '',
		ADD COLUMN IF NOT EXISTS pause_note VARCHAR(1000) NOT NULL DEFAULT '',
		ADD COLUMN IF NOT EXISTS paused_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
		ADD COLUMN IF NOT EXISTS paused_by_name VARCHAR(160) NOT NULL DEFAULT '';

		CREATE INDEX IF NOT EXISTS depannhome_calendar_events_paused_idx
		ON depannhome_calendar_events (owner_id, paused_at DESC)
		WHERE paused_at IS NOT NULL;
	END IF;
END $$;
