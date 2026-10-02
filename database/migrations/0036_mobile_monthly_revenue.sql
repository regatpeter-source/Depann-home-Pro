ALTER TABLE depannhome_billing_documents
    ADD COLUMN IF NOT EXISTS created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS created_by_name VARCHAR(160) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS revenue_assignee_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS revenue_assignee_name VARCHAR(160) NOT NULL DEFAULT '';

DROP TRIGGER IF EXISTS depannhome_billing_document_immutable ON depannhome_billing_documents;

DO $migration$
BEGIN
IF (SELECT COUNT(*)=6 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='depannhome_billing_documents' AND column_name IN ('owner_id','document_type','appointment_id','created_by','revenue_assignee_id','revenue_assignee_name')) THEN
WITH candidates AS (
    SELECT document.id,
        COALESCE(
            mobile_creator.id,
            (SELECT member.id
             FROM depannhome_calendar_assignments assignment
             JOIN depannhome_users member ON member.id=assignment.technician_id
             WHERE assignment.event_id=document.appointment_id
               AND member.account_owner_id=document.owner_id
               AND member.role IN ('mobile_admin','team_lead','technician')
             ORDER BY assignment.is_primary DESC,assignment.id
             LIMIT 1)
        ) AS assignee_id
    FROM depannhome_billing_documents document
    LEFT JOIN depannhome_users mobile_creator ON mobile_creator.id=document.created_by
        AND mobile_creator.account_owner_id=document.owner_id
        AND mobile_creator.role IN ('mobile_admin','team_lead','technician')
    WHERE document.document_type='invoice' AND document.revenue_assignee_id IS NULL
)
UPDATE depannhome_billing_documents document
SET revenue_assignee_id=candidate.assignee_id,
    revenue_assignee_name=COALESCE(NULLIF(member.full_name,''),member.username,'')
FROM candidates candidate
JOIN depannhome_users member ON member.id=candidate.assignee_id
WHERE document.id=candidate.id;
END IF;
END $migration$;

DO $migration$
BEGIN
IF (SELECT COUNT(*)=6 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='depannhome_billing_documents' AND column_name IN ('owner_id','document_type','financial_data','revenue_assignee_id','revenue_assignee_name','id')) THEN
UPDATE depannhome_billing_documents credit
SET revenue_assignee_id=invoice.revenue_assignee_id,
    revenue_assignee_name=invoice.revenue_assignee_name
FROM depannhome_billing_documents invoice
WHERE credit.document_type='credit'
  AND credit.revenue_assignee_id IS NULL
  AND COALESCE(credit.financial_data->>'sourceInvoiceId','') ~ '^[0-9]+$'
  AND invoice.id=(credit.financial_data->>'sourceInvoiceId')::bigint
  AND invoice.owner_id=credit.owner_id;
END IF;
END $migration$;

DO $migration$
BEGIN
IF (SELECT COUNT(*)=4 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='depannhome_billing_documents' AND column_name IN ('owner_id','revenue_assignee_id','issue_date','issued_at')) THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS depannhome_billing_documents_revenue_assignee_idx ON depannhome_billing_documents(owner_id,revenue_assignee_id,issue_date DESC) WHERE issued_at IS NOT NULL';
END IF;
END $migration$;

CREATE OR REPLACE FUNCTION depannhome_protect_issued_billing_document() RETURNS trigger AS $$
BEGIN
    IF TG_OP='DELETE' AND OLD.issued_at IS NOT NULL THEN RAISE EXCEPTION 'Un document émis ne peut pas être supprimé.'; END IF;
    IF TG_OP='UPDATE' AND OLD.issued_at IS NOT NULL AND ROW(NEW.owner_id,NEW.created_by,NEW.created_by_name,NEW.revenue_assignee_id,NEW.revenue_assignee_name,NEW.document_type,NEW.document_number,NEW.client_id,NEW.customer_type,NEW.customer_name,NEW.customer_address,NEW.issue_date,NEW.due_date,NEW.appointment_id,NEW.source_quote_id,NEW.correction_source_id,NEW.correction_kind,NEW.quote_reference,NEW.vat_regime,NEW.issuer_tax_number,NEW.legal_data,NEW.issued_at,NEW.finalized_by,NEW.legal_snapshot,NEW.structured_data,NEW.structured_mime_type,NEW.structured_sha256,NEW.pdf_data,NEW.pdf_sha256,NEW.lines,NEW.notes,NEW.financial_data,NEW.created_at)
        IS DISTINCT FROM ROW(OLD.owner_id,OLD.created_by,OLD.created_by_name,OLD.revenue_assignee_id,OLD.revenue_assignee_name,OLD.document_type,OLD.document_number,OLD.client_id,OLD.customer_type,OLD.customer_name,OLD.customer_address,OLD.issue_date,OLD.due_date,OLD.appointment_id,OLD.source_quote_id,OLD.correction_source_id,OLD.correction_kind,OLD.quote_reference,OLD.vat_regime,OLD.issuer_tax_number,OLD.legal_data,OLD.issued_at,OLD.finalized_by,OLD.legal_snapshot,OLD.structured_data,OLD.structured_mime_type,OLD.structured_sha256,OLD.pdf_data,OLD.pdf_sha256,OLD.lines,OLD.notes,OLD.financial_data,OLD.created_at)
    THEN RAISE EXCEPTION 'Les données légales d’un document émis sont immuables.'; END IF;
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END; $$ LANGUAGE plpgsql;

DO $migration$
BEGIN
IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='depannhome_billing_documents' AND column_name='issued_at') THEN
    EXECUTE 'CREATE TRIGGER depannhome_billing_document_immutable BEFORE UPDATE OR DELETE ON depannhome_billing_documents FOR EACH ROW EXECUTE FUNCTION depannhome_protect_issued_billing_document()';
END IF;
END $migration$;
