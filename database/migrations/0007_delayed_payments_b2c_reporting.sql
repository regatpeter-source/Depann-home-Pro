CREATE TABLE IF NOT EXISTS depannhome_delayed_payment_declarations (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    document_id BIGINT NOT NULL REFERENCES depannhome_billing_documents(id) ON DELETE RESTRICT,
    declared_payment_date DATE NOT NULL,
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    method VARCHAR(40) NOT NULL CHECK (method IN ('Chèque','Virement')),
    reference VARCHAR(160) NOT NULL,
    notes VARCHAR(1000) NOT NULL DEFAULT '',
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    declared_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    declared_by_name VARCHAR(160) NOT NULL DEFAULT '',
    reviewed_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    reviewed_by_name VARCHAR(160) NOT NULL DEFAULT '',
    reviewed_at TIMESTAMPTZ,
    review_note VARCHAR(1000) NOT NULL DEFAULT '',
    bank_evidence_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
    settlement_id BIGINT UNIQUE REFERENCES depannhome_accounting_settlements(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_delayed_payments_owner_status_idx ON depannhome_delayed_payment_declarations(owner_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS depannhome_delayed_payments_document_idx ON depannhome_delayed_payment_declarations(owner_id,document_id,status);

CREATE OR REPLACE FUNCTION depannhome_protect_reviewed_delayed_payment() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' AND OLD.status <> 'pending' THEN
        RAISE EXCEPTION 'Une déclaration de règlement contrôlée est immuable.';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status <> 'pending' AND ROW(NEW.owner_id,NEW.document_id,NEW.declared_payment_date,NEW.amount,NEW.method,NEW.reference,NEW.notes,NEW.status,NEW.declared_by,NEW.declared_by_name,NEW.reviewed_by,NEW.reviewed_by_name,NEW.reviewed_at,NEW.review_note,NEW.bank_evidence_confirmed,NEW.settlement_id,NEW.created_at)
        IS DISTINCT FROM ROW(OLD.owner_id,OLD.document_id,OLD.declared_payment_date,OLD.amount,OLD.method,OLD.reference,OLD.notes,OLD.status,OLD.declared_by,OLD.declared_by_name,OLD.reviewed_by,OLD.reviewed_by_name,OLD.reviewed_at,OLD.review_note,OLD.bank_evidence_confirmed,OLD.settlement_id,OLD.created_at)
    THEN
        RAISE EXCEPTION 'Une déclaration de règlement contrôlée est immuable.';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS depannhome_delayed_payment_immutable ON depannhome_delayed_payment_declarations;
CREATE TRIGGER depannhome_delayed_payment_immutable BEFORE UPDATE OR DELETE ON depannhome_delayed_payment_declarations FOR EACH ROW EXECUTE FUNCTION depannhome_protect_reviewed_delayed_payment();

CREATE TABLE IF NOT EXISTS depannhome_billing_acquittances (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    document_id BIGINT NOT NULL UNIQUE REFERENCES depannhome_billing_documents(id) ON DELETE RESTRICT,
    final_settlement_id BIGINT NOT NULL REFERENCES depannhome_accounting_settlements(id) ON DELETE RESTRICT,
    paid_date DATE NOT NULL,
    payment_snapshot JSONB NOT NULL,
    source_pdf_sha256 CHAR(64) NOT NULL,
    pdf_data BYTEA NOT NULL,
    pdf_sha256 CHAR(64) NOT NULL,
    filename VARCHAR(255) NOT NULL,
    created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_billing_acquittances_owner_idx ON depannhome_billing_acquittances(owner_id,created_at DESC);

CREATE OR REPLACE FUNCTION depannhome_protect_billing_acquittance() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Une copie acquittée archivée est immuable.';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS depannhome_billing_acquittance_immutable ON depannhome_billing_acquittances;
CREATE TRIGGER depannhome_billing_acquittance_immutable BEFORE UPDATE OR DELETE ON depannhome_billing_acquittances FOR EACH ROW EXECUTE FUNCTION depannhome_protect_billing_acquittance();

CREATE TABLE IF NOT EXISTS depannhome_b2c_report_batches (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL CHECK (period_end >= period_start),
    status VARCHAR(30) NOT NULL DEFAULT 'prepared_local' CHECK (status = 'prepared_local'),
    transaction_count INTEGER NOT NULL DEFAULT 0 CHECK (transaction_count >= 0),
    collection_count INTEGER NOT NULL DEFAULT 0 CHECK (collection_count >= 0),
    payload JSONB NOT NULL,
    payload_sha256 CHAR(64) NOT NULL,
    created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_b2c_report_batches_owner_idx ON depannhome_b2c_report_batches(owner_id,created_at DESC);

CREATE TABLE IF NOT EXISTS depannhome_b2c_report_events (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    batch_id BIGINT NOT NULL REFERENCES depannhome_b2c_report_batches(id) ON DELETE RESTRICT,
    actor_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    event_type VARCHAR(40) NOT NULL CHECK (event_type IN ('prepared_local','downloaded_local')),
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_b2c_report_events_batch_idx ON depannhome_b2c_report_events(owner_id,batch_id,created_at);

CREATE OR REPLACE FUNCTION depannhome_protect_b2c_report_archive() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Un lot e-reporting préparé est immuable.';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS depannhome_b2c_report_batch_immutable ON depannhome_b2c_report_batches;
CREATE TRIGGER depannhome_b2c_report_batch_immutable BEFORE UPDATE OR DELETE ON depannhome_b2c_report_batches FOR EACH ROW EXECUTE FUNCTION depannhome_protect_b2c_report_archive();
DROP TRIGGER IF EXISTS depannhome_b2c_report_event_immutable ON depannhome_b2c_report_events;
CREATE TRIGGER depannhome_b2c_report_event_immutable BEFORE UPDATE OR DELETE ON depannhome_b2c_report_events FOR EACH ROW EXECUTE FUNCTION depannhome_protect_b2c_report_archive();
