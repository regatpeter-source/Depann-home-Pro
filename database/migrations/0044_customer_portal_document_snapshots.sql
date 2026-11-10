CREATE TABLE IF NOT EXISTS depannhome_customer_portal_document_snapshots (
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    portal_link_id UUID NOT NULL REFERENCES depannhome_customer_portal_links(id) ON DELETE CASCADE,
    document_id BIGINT NOT NULL REFERENCES depannhome_billing_documents(id) ON DELETE RESTRICT,
    document_type VARCHAR(10) NOT NULL CHECK (document_type IN ('quote','invoice')),
    document_number VARCHAR(80) NOT NULL,
    filename VARCHAR(160) NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    pdf_data BYTEA NOT NULL,
    pdf_sha256 CHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (portal_link_id, document_id)
);

CREATE INDEX IF NOT EXISTS depannhome_customer_portal_document_snapshots_owner_idx
    ON depannhome_customer_portal_document_snapshots(owner_id, portal_link_id);
