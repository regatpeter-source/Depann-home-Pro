DO $$
BEGIN
    IF to_regclass('depannhome_billing_templates') IS NOT NULL THEN
        ALTER TABLE depannhome_billing_templates
            ADD COLUMN IF NOT EXISTS section VARCHAR(80) NOT NULL DEFAULT 'Autres';

        CREATE INDEX IF NOT EXISTS depannhome_billing_templates_owner_section_idx
            ON depannhome_billing_templates (owner_id, LOWER(section), LOWER(label));
    END IF;
END
$$;
