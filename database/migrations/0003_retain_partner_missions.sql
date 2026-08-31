DO $$
BEGIN
    IF to_regclass('depannhome_partner_missions') IS NOT NULL THEN
        UPDATE depannhome_partner_missions
        SET deleted_at = NULL,
            updated_at = NOW()
        WHERE deleted_at IS NOT NULL;

        IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conname = 'depannhome_partner_missions_retained_check'
              AND conrelid = 'depannhome_partner_missions'::regclass
        ) THEN
            ALTER TABLE depannhome_partner_missions
                ADD CONSTRAINT depannhome_partner_missions_retained_check
                CHECK (deleted_at IS NULL);
        END IF;
    END IF;
END
$$;
