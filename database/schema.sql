CREATE TABLE IF NOT EXISTS depannhome_users (
    id BIGSERIAL PRIMARY KEY,
    username VARCHAR(32) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'user',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS depannhome_users_username_lookup_idx ON depannhome_users (username);

CREATE TABLE IF NOT EXISTS depannhome_clients (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    client_id VARCHAR(100) NOT NULL,
    client_data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT depannhome_clients_owner_client_unique UNIQUE (owner_id, client_id)
);

CREATE INDEX IF NOT EXISTS depannhome_clients_owner_updated_idx
    ON depannhome_clients (owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS depannhome_billing_profiles (
    owner_id BIGINT PRIMARY KEY REFERENCES depannhome_users(id) ON DELETE CASCADE,
    company_name VARCHAR(160) NOT NULL DEFAULT '',
    legal_form VARCHAR(100) NOT NULL DEFAULT '',
    address VARCHAR(255) NOT NULL DEFAULT '',
    postal_code VARCHAR(20) NOT NULL DEFAULT '',
    city VARCHAR(100) NOT NULL DEFAULT '',
    phone VARCHAR(50) NOT NULL DEFAULT '',
    email VARCHAR(160) NOT NULL DEFAULT '',
    registration_number VARCHAR(100) NOT NULL DEFAULT '',
    tax_number VARCHAR(100) NOT NULL DEFAULT '',
    payment_terms VARCHAR(500) NOT NULL DEFAULT '',
    footer_note VARCHAR(1000) NOT NULL DEFAULT '',
    default_quote JSONB,
    logo_data BYTEA,
    logo_mime_type VARCHAR(50) NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE depannhome_billing_profiles
    ADD COLUMN IF NOT EXISTS default_quote JSONB;

CREATE TABLE IF NOT EXISTS depannhome_billing_templates (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    label VARCHAR(160) NOT NULL,
    description VARCHAR(500) NOT NULL DEFAULT '',
    unit VARCHAR(40) NOT NULL DEFAULT 'unité',
    unit_price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
    vat_rate NUMERIC(5,2) NOT NULL DEFAULT 20 CHECK (vat_rate >= 0 AND vat_rate <= 100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS depannhome_billing_templates_owner_idx
    ON depannhome_billing_templates (owner_id, LOWER(label));

CREATE TABLE IF NOT EXISTS depannhome_billing_documents (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    document_type VARCHAR(10) NOT NULL CHECK (document_type IN ('quote', 'invoice')),
    document_number VARCHAR(80) NOT NULL,
    customer_type VARCHAR(30) NOT NULL DEFAULT 'Particulier',
    customer_name VARCHAR(160) NOT NULL DEFAULT '',
    customer_address VARCHAR(500) NOT NULL DEFAULT '',
    issue_date DATE NOT NULL,
    due_date DATE,
    status VARCHAR(30) NOT NULL DEFAULT 'draft',
    lines JSONB NOT NULL DEFAULT '[]'::jsonb,
    notes VARCHAR(2000) NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT depannhome_billing_documents_owner_number_unique UNIQUE (owner_id, document_number)
);

CREATE INDEX IF NOT EXISTS depannhome_billing_documents_owner_date_idx
    ON depannhome_billing_documents (owner_id, issue_date DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS depannhome_messages (
    id BIGSERIAL PRIMARY KEY,
    sender_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    recipient_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    body VARCHAR(2000) NOT NULL,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT depannhome_messages_distinct_accounts CHECK (sender_id <> recipient_id)
);

CREATE INDEX IF NOT EXISTS depannhome_messages_recipient_idx
    ON depannhome_messages (recipient_id, created_at DESC);

CREATE INDEX IF NOT EXISTS depannhome_messages_sender_idx
    ON depannhome_messages (sender_id, created_at DESC);

CREATE TABLE IF NOT EXISTS depannhome_calendar_events (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    title VARCHAR(160) NOT NULL,
    client_name VARCHAR(160) NOT NULL DEFAULT '',
    location VARCHAR(255) NOT NULL DEFAULT '',
    event_date DATE NOT NULL,
    start_time TIME,
    end_time TIME,
    color VARCHAR(20) NOT NULL DEFAULT 'blue',
    notes VARCHAR(2000) NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT depannhome_calendar_events_color_check
        CHECK (color IN ('blue', 'green', 'orange', 'red', 'purple', 'gray')),
    CONSTRAINT depannhome_calendar_events_time_check
        CHECK (end_time IS NULL OR start_time IS NULL OR end_time >= start_time)
);

CREATE INDEX IF NOT EXISTS depannhome_calendar_events_owner_date_idx
    ON depannhome_calendar_events (owner_id, event_date, start_time);

CREATE TABLE IF NOT EXISTS depannhome_library_sections (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(80) NOT NULL,
    slug VARCHAR(100) NOT NULL,
    created_by BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE depannhome_library_sections
    DROP CONSTRAINT IF EXISTS depannhome_library_sections_slug_key;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'depannhome_library_sections_owner_slug_unique'
    ) THEN
        ALTER TABLE depannhome_library_sections
            ADD CONSTRAINT depannhome_library_sections_owner_slug_unique UNIQUE (created_by, slug);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS depannhome_library_documents (
    id BIGSERIAL PRIMARY KEY,
    section_id BIGINT NOT NULL REFERENCES depannhome_library_sections(id) ON DELETE CASCADE,
    title VARCHAR(160) NOT NULL,
    description VARCHAR(1000) NOT NULL DEFAULT '',
    original_filename VARCHAR(255) NOT NULL,
    mime_type VARCHAR(150) NOT NULL,
    file_size INTEGER NOT NULL CHECK (file_size > 0 AND file_size <= 20971520),
    file_data BYTEA NOT NULL,
    created_by BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS depannhome_library_documents_section_idx
    ON depannhome_library_documents (section_id, created_at DESC);
