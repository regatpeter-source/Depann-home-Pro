CREATE TABLE IF NOT EXISTS depannhome_technical_report_originals (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    report_id BIGINT NOT NULL REFERENCES depannhome_technical_reports(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision > 0),
    title VARCHAR(160) NOT NULL,
    report_date DATE NOT NULL,
    content JSONB NOT NULL,
    media JSONB NOT NULL,
    pdf_data BYTEA NOT NULL,
    pdf_filename VARCHAR(255) NOT NULL,
    document_mime_type VARCHAR(150) NOT NULL DEFAULT 'application/pdf',
    pdf_sha256 CHAR(64) NOT NULL,
    validated_at TIMESTAMPTZ NOT NULL,
    validated_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    reopened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reopened_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    UNIQUE (owner_id, report_id, revision)
);

CREATE INDEX IF NOT EXISTS depannhome_technical_report_originals_report_idx
    ON depannhome_technical_report_originals (owner_id, report_id, revision DESC);

CREATE OR REPLACE FUNCTION depannhome_protect_technical_report_original() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Une copie originale de rapport ne peut pas être modifiée ou supprimée.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS depannhome_technical_report_original_immutable ON depannhome_technical_report_originals;
CREATE TRIGGER depannhome_technical_report_original_immutable
    BEFORE UPDATE OR DELETE ON depannhome_technical_report_originals
    FOR EACH ROW EXECUTE FUNCTION depannhome_protect_technical_report_original();
