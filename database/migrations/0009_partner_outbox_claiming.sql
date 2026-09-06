DO $$
BEGIN
	IF to_regclass('depannhome_partner_mission_outbox') IS NOT NULL THEN
		CREATE INDEX IF NOT EXISTS depannhome_partner_mission_outbox_claim_idx
			ON depannhome_partner_mission_outbox(owner_id, next_attempt_at, created_at)
			WHERE status IN ('pending','failed','processing');
	END IF;
END
$$;
