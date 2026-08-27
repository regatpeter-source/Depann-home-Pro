DO $$
BEGIN
    IF to_regclass('depannhome_partner_email_messages') IS NOT NULL THEN
        ALTER TABLE depannhome_partner_email_messages
            ADD COLUMN IF NOT EXISTS document_text TEXT NOT NULL DEFAULT '';
    END IF;
END
$$;