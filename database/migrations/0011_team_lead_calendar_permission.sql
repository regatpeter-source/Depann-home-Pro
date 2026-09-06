DO $$
BEGIN
    IF to_regclass('depannhome_users') IS NOT NULL THEN
        ALTER TABLE depannhome_users
            ADD COLUMN IF NOT EXISTS can_manage_calendar BOOLEAN NOT NULL DEFAULT FALSE;

        UPDATE depannhome_users
        SET can_manage_calendar = TRUE
        WHERE role = 'team_lead';
    END IF;
END
$$;
