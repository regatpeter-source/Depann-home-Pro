DO $$
DECLARE
    role_constraint RECORD;
BEGIN
    IF to_regclass('depannhome_users') IS NULL OR NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'depannhome_users'
          AND column_name = 'role'
    ) THEN
        RETURN;
    END IF;

    FOR role_constraint IN
        SELECT constraint_item.conname
        FROM pg_constraint constraint_item
        WHERE constraint_item.conrelid = 'depannhome_users'::regclass
          AND constraint_item.contype = 'c'
          AND (
              constraint_item.conname = 'depannhome_users_role_check'
              OR (
                  cardinality(constraint_item.conkey) = 1
                  AND EXISTS (
                      SELECT 1
                      FROM pg_attribute column_item
                      WHERE column_item.attrelid = constraint_item.conrelid
                        AND column_item.attnum = ANY(constraint_item.conkey)
                        AND column_item.attname = 'role'
                  )
              )
          )
    LOOP
        EXECUTE format('ALTER TABLE depannhome_users DROP CONSTRAINT %I', role_constraint.conname);
    END LOOP;

    ALTER TABLE depannhome_users
        ALTER COLUMN role SET DEFAULT 'admin';

    ALTER TABLE depannhome_users
        ADD CONSTRAINT depannhome_users_role_check
        CHECK (role IN ('admin','pc_standard','commercial','mobile_admin','team_lead','technician','accountant'))
        NOT VALID;

    IF NOT EXISTS (
        SELECT 1
        FROM depannhome_users
        WHERE role NOT IN ('admin','pc_standard','commercial','mobile_admin','team_lead','technician','accountant')
    ) THEN
        ALTER TABLE depannhome_users
            VALIDATE CONSTRAINT depannhome_users_role_check;
    END IF;
END
$$;
