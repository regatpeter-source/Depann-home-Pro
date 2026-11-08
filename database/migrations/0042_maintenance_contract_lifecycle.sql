ALTER TABLE depannhome_maintenance_contracts
    ALTER COLUMN status SET DEFAULT 'draft',
    ADD COLUMN IF NOT EXISTS service_description VARCHAR(5000) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS billing_interval_months INTEGER NOT NULL DEFAULT 12
        CHECK (billing_interval_months BETWEEN 1 AND 120),
    ADD COLUMN IF NOT EXISTS billing_amount_ht NUMERIC(12,2) NOT NULL DEFAULT 0
        CHECK (billing_amount_ht >= 0),
    ADD COLUMN IF NOT EXISTS billing_vat_rate NUMERIC(5,2) NOT NULL DEFAULT 20
        CHECK (billing_vat_rate BETWEEN 0 AND 100),
    ADD COLUMN IF NOT EXISTS next_invoice_on DATE;

CREATE INDEX IF NOT EXISTS depannhome_maintenance_contracts_invoice_due_idx
    ON depannhome_maintenance_contracts(owner_id,status,next_invoice_on);

CREATE TABLE IF NOT EXISTS depannhome_maintenance_contract_templates (
    owner_id BIGINT PRIMARY KEY REFERENCES depannhome_users(id) ON DELETE CASCADE,
    introduction TEXT NOT NULL DEFAULT '',
    scope TEXT NOT NULL DEFAULT '',
    exclusions TEXT NOT NULL DEFAULT '',
    payment_terms TEXT NOT NULL DEFAULT '',
    renewal_terms TEXT NOT NULL DEFAULT '',
    cancellation_terms TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS depannhome_maintenance_contract_documents (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    contract_id BIGINT NOT NULL REFERENCES depannhome_maintenance_contracts(id) ON DELETE CASCADE,
    document_kind VARCHAR(20) NOT NULL CHECK(document_kind IN ('generated','signed')),
    file_name VARCHAR(255) NOT NULL,
    mime_type VARCHAR(100) NOT NULL CHECK(mime_type='application/pdf'),
    pdf_data BYTEA NOT NULL,
    sha256 CHAR(64) NOT NULL,
    snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_maintenance_contract_documents_owner_idx
    ON depannhome_maintenance_contract_documents(owner_id,contract_id,created_at DESC,id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS depannhome_maintenance_contract_signed_document_idx
    ON depannhome_maintenance_contract_documents(owner_id,contract_id)
    WHERE document_kind='signed';

CREATE TABLE IF NOT EXISTS depannhome_contract_invoice_drafts (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    contract_id BIGINT NOT NULL REFERENCES depannhome_maintenance_contracts(id) ON DELETE CASCADE,
    period_start DATE NOT NULL,
    billing_document_id BIGINT NOT NULL REFERENCES depannhome_billing_documents(id) ON DELETE RESTRICT,
    amount_ht NUMERIC(12,2) NOT NULL CHECK(amount_ht >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(owner_id,contract_id,period_start),
    UNIQUE(owner_id,billing_document_id)
);
