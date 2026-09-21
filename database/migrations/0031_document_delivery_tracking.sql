ALTER TABLE depannhome_billing_documents
    ADD COLUMN IF NOT EXISTS delivery_method VARCHAR(20) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS delivered_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS delivered_by_name VARCHAR(160) NOT NULL DEFAULT '';
ALTER TABLE depannhome_billing_documents DROP CONSTRAINT IF EXISTS depannhome_billing_documents_delivery_method_check;
ALTER TABLE depannhome_billing_documents ADD CONSTRAINT depannhome_billing_documents_delivery_method_check CHECK (delivery_method IN ('','email','hand_delivered'));
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='depannhome_billing_documents' AND column_name='is_email_sent')
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='depannhome_billing_documents' AND column_name='sent_at') THEN
        EXECUTE 'UPDATE depannhome_billing_documents SET delivery_method=''email'',delivered_at=COALESCE(delivered_at,sent_at),delivered_by_name=CASE WHEN delivered_by_name='''' THEN ''Envoi historique'' ELSE delivered_by_name END WHERE is_email_sent=TRUE AND delivery_method=''''';
    END IF;
END $$;

ALTER TABLE depannhome_technical_reports
    ADD COLUMN IF NOT EXISTS delivery_method VARCHAR(20) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS delivered_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS delivered_by_name VARCHAR(160) NOT NULL DEFAULT '';
ALTER TABLE depannhome_technical_reports DROP CONSTRAINT IF EXISTS depannhome_technical_reports_delivery_method_check;
ALTER TABLE depannhome_technical_reports ADD CONSTRAINT depannhome_technical_reports_delivery_method_check CHECK (delivery_method IN ('','email','hand_delivered'));
