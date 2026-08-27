ALTER TABLE depannhome_partner_email_messages
    ADD COLUMN IF NOT EXISTS document_text TEXT NOT NULL DEFAULT '';