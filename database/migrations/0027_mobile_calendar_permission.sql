DO $$
BEGIN
    IF to_regclass('depannhome_users') IS NOT NULL THEN
        UPDATE depannhome_users
        SET can_manage_calendar = TRUE, updated_at = NOW()
        WHERE role = 'mobile_admin';
    END IF;
END $$;