ALTER TABLE depannhome_support_requests
    ADD COLUMN IF NOT EXISTS assistance_preference VARCHAR(20) NOT NULL DEFAULT ''
        CHECK (assistance_preference IN ('','diagnostic','control'));
