ALTER TABLE depannhome_creator_support_sessions
ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS accepted_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS declined_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS declined_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL;

-- Les sessions créées avant ce parcours comportaient déjà un consentement déclaré.
-- Elles sont conservées comme acceptées afin de ne pas invalider leur audit historique.
UPDATE depannhome_creator_support_sessions
SET accepted_at = created_at
WHERE accepted_at IS NULL;