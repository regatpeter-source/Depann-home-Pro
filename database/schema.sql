CREATE TABLE IF NOT EXISTS depannhome_users (
    id BIGSERIAL PRIMARY KEY,
    username VARCHAR(32) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'admin',
    account_owner_id BIGINT REFERENCES depannhome_users(id) ON DELETE CASCADE,
    full_name VARCHAR(100) NOT NULL DEFAULT '',
    phone VARCHAR(30) NOT NULL DEFAULT '',
    email VARCHAR(160) NOT NULL DEFAULT '',
    department VARCHAR(80) NOT NULL DEFAULT '',
    company_name VARCHAR(160) NOT NULL DEFAULT '',
    max_pc_users INTEGER NOT NULL DEFAULT 1,
    max_technicians INTEGER NOT NULL DEFAULT 5,
    subscription_plan VARCHAR(20) NOT NULL DEFAULT 'free',
    subscription_label VARCHAR(80) NOT NULL DEFAULT '',
    monthly_price_cents INTEGER NOT NULL DEFAULT 0,
    subscription_status VARCHAR(20) NOT NULL DEFAULT 'active',
    subscription_renewal_date DATE,
    billing_reference VARCHAR(100) NOT NULL DEFAULT '',
    creator_note VARCHAR(1000) NOT NULL DEFAULT '',
    quote_template_policy VARCHAR(30) NOT NULL DEFAULT 'company_choice',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS depannhome_users_username_lookup_idx ON depannhome_users (username);

UPDATE depannhome_users SET account_owner_id = id WHERE account_owner_id IS NULL;
UPDATE depannhome_users SET role = 'admin' WHERE role = 'user' AND account_owner_id = id;

ALTER TABLE depannhome_users
    ADD COLUMN IF NOT EXISTS company_name VARCHAR(160) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS email VARCHAR(160) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS department VARCHAR(80) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS max_pc_users INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS max_technicians INTEGER NOT NULL DEFAULT 5,
    ADD COLUMN IF NOT EXISTS subscription_plan VARCHAR(20) NOT NULL DEFAULT 'free',
    ADD COLUMN IF NOT EXISTS subscription_label VARCHAR(80) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS monthly_price_cents INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(20) NOT NULL DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS subscription_renewal_date DATE,
    ADD COLUMN IF NOT EXISTS billing_reference VARCHAR(100) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS creator_note VARCHAR(1000) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS quote_template_policy VARCHAR(30) NOT NULL DEFAULT 'company_choice';

-- Double authentification TOTP réservée au compte Créateur.
-- Le secret est chiffré côté serveur avec SESSION_SECRET avant son stockage.
CREATE TABLE IF NOT EXISTS depannhome_creator_totp (
    user_id BIGINT PRIMARY KEY REFERENCES depannhome_users(id) ON DELETE CASCADE,
    secret_ciphertext TEXT NOT NULL DEFAULT '',
    pending_secret_ciphertext TEXT NOT NULL DEFAULT '',
    pending_expires_at TIMESTAMPTZ,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    confirmed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

CREATE TABLE IF NOT EXISTS depannhome_deleted_clients (
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    client_id VARCHAR(100) NOT NULL,
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, client_id)
);

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
    siren VARCHAR(20) NOT NULL DEFAULT '',
    tax_number VARCHAR(100) NOT NULL DEFAULT '',
    bank_iban VARCHAR(80) NOT NULL DEFAULT '',
    bank_bic VARCHAR(40) NOT NULL DEFAULT '',
    payment_terms VARCHAR(500) NOT NULL DEFAULT '',
    deposit_terms VARCHAR(500) NOT NULL DEFAULT '',
    footer_note VARCHAR(1000) NOT NULL DEFAULT '',
    default_quote JSONB,
    quote_template_mode VARCHAR(20) NOT NULL DEFAULT 'integrated',
    quote_template_filename VARCHAR(255) NOT NULL DEFAULT '',
    quote_template_data BYTEA,
    quote_template_mime_type VARCHAR(150) NOT NULL DEFAULT '',
    logo_data BYTEA,
    logo_mime_type VARCHAR(50) NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE depannhome_billing_profiles
    ADD COLUMN IF NOT EXISTS default_quote JSONB,
    ADD COLUMN IF NOT EXISTS deposit_terms VARCHAR(500) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS siren VARCHAR(20) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS bank_iban VARCHAR(80) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS bank_bic VARCHAR(40) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS quote_template_mode VARCHAR(20) NOT NULL DEFAULT 'integrated',
    ADD COLUMN IF NOT EXISTS quote_template_filename VARCHAR(255) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS quote_template_data BYTEA,
    ADD COLUMN IF NOT EXISTS quote_template_mime_type VARCHAR(150) NOT NULL DEFAULT '';

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
    created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    document_type VARCHAR(10) NOT NULL CHECK (document_type IN ('quote', 'invoice')),
    document_number VARCHAR(80) NOT NULL,
    client_id VARCHAR(100),
    customer_type VARCHAR(30) NOT NULL DEFAULT 'Particulier',
    customer_name VARCHAR(160) NOT NULL DEFAULT '',
    customer_address VARCHAR(500) NOT NULL DEFAULT '',
    issue_date DATE NOT NULL,
    due_date DATE,
    status VARCHAR(30) NOT NULL DEFAULT 'draft',
    is_accounted BOOLEAN NOT NULL DEFAULT FALSE,
    accounted_at DATE,
    appointment_id BIGINT,
    source_quote_id BIGINT,
    quote_reference VARCHAR(80) NOT NULL DEFAULT '',
    lines JSONB NOT NULL DEFAULT '[]'::jsonb,
    notes VARCHAR(2000) NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT depannhome_billing_documents_owner_number_unique UNIQUE (owner_id, document_number)
);

CREATE INDEX IF NOT EXISTS depannhome_billing_documents_owner_date_idx
    ON depannhome_billing_documents (owner_id, issue_date DESC, created_at DESC);

ALTER TABLE depannhome_billing_documents
    ADD COLUMN IF NOT EXISTS is_accounted BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS accounted_at DATE,
    ADD COLUMN IF NOT EXISTS created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS client_id VARCHAR(100),
    ADD COLUMN IF NOT EXISTS appointment_id BIGINT,
    ADD COLUMN IF NOT EXISTS source_quote_id BIGINT,
    ADD COLUMN IF NOT EXISTS quote_reference VARCHAR(80) NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS depannhome_billing_documents_accounting_idx
    ON depannhome_billing_documents (owner_id, document_type, is_accounted, issue_date DESC);

CREATE INDEX IF NOT EXISTS depannhome_billing_documents_appointment_idx
    ON depannhome_billing_documents (owner_id, appointment_id);

CREATE INDEX IF NOT EXISTS depannhome_billing_documents_client_idx
    ON depannhome_billing_documents (owner_id, client_id);

-- Comptabilité & Facturation électronique : données strictement isolées par owner_id.
ALTER TABLE depannhome_billing_documents ADD COLUMN IF NOT EXISTS financial_data JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE depannhome_billing_documents DROP CONSTRAINT IF EXISTS depannhome_billing_documents_document_type_check;
ALTER TABLE depannhome_billing_documents ADD CONSTRAINT depannhome_billing_documents_document_type_check CHECK (document_type IN ('quote', 'invoice', 'credit'));

CREATE TABLE IF NOT EXISTS depannhome_accounting_aids (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    name VARCHAR(160) NOT NULL, description VARCHAR(1000) NOT NULL DEFAULT '', aid_type VARCHAR(40) NOT NULL DEFAULT 'custom',
    calculation_mode VARCHAR(20) NOT NULL DEFAULT 'fixed', amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    auto_apply BOOLEAN NOT NULL DEFAULT FALSE, rules JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_accounting_aids_owner_idx ON depannhome_accounting_aids (owner_id, auto_apply, LOWER(name));

CREATE TABLE IF NOT EXISTS depannhome_accounting_settlements (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    document_id BIGINT NOT NULL REFERENCES depannhome_billing_documents(id) ON DELETE CASCADE, settlement_date DATE NOT NULL,
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0), method VARCHAR(40) NOT NULL DEFAULT 'Virement',
    reference VARCHAR(160) NOT NULL DEFAULT '', notes VARCHAR(1000) NOT NULL DEFAULT '',
    created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_accounting_settlements_owner_document_idx ON depannhome_accounting_settlements (owner_id, document_id, settlement_date DESC);

CREATE TABLE IF NOT EXISTS depannhome_accounting_settings (
    owner_id BIGINT PRIMARY KEY REFERENCES depannhome_users(id) ON DELETE CASCADE,
    chart_config JSONB NOT NULL DEFAULT '{}'::jsonb, aid_engine_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    pdp_provider VARCHAR(60) NOT NULL DEFAULT 'sandbox', pdp_identifier VARCHAR(160) NOT NULL DEFAULT '',
    pdp_api_secret TEXT NOT NULL DEFAULT '', pdp_enabled BOOLEAN NOT NULL DEFAULT FALSE, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS depannhome_einvoice_transmissions (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    document_id BIGINT NOT NULL REFERENCES depannhome_billing_documents(id) ON DELETE CASCADE, provider VARCHAR(60) NOT NULL,
    remote_id VARCHAR(160) NOT NULL DEFAULT '', status VARCHAR(30) NOT NULL DEFAULT 'draft', message VARCHAR(1000) NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0, last_attempt_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_einvoice_transmissions_owner_idx ON depannhome_einvoice_transmissions (owner_id, status, updated_at DESC);

-- Assistant Connecteurs API : plugins déclaratifs isolés par entreprise, sans exécution de code tiers.
CREATE TABLE IF NOT EXISTS depannhome_api_connectors (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    connector_key VARCHAR(64) NOT NULL, manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
    configuration JSONB NOT NULL DEFAULT '{}'::jsonb, encrypted_credentials TEXT NOT NULL DEFAULT '', enabled BOOLEAN NOT NULL DEFAULT FALSE,
    created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT depannhome_api_connectors_owner_key_unique UNIQUE (owner_id, connector_key)
);
CREATE INDEX IF NOT EXISTS depannhome_api_connectors_owner_updated_idx ON depannhome_api_connectors (owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS depannhome_api_connector_logs (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    connector_id BIGINT NOT NULL REFERENCES depannhome_api_connectors(id) ON DELETE CASCADE,
    action VARCHAR(40) NOT NULL, status VARCHAR(20) NOT NULL, endpoint_name VARCHAR(160) NOT NULL DEFAULT '',
    request_summary JSONB NOT NULL DEFAULT '{}'::jsonb, response_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
    message VARCHAR(1000) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_api_connector_logs_owner_connector_idx ON depannhome_api_connector_logs (owner_id, connector_id, created_at DESC);

-- Factures d’abonnement émises par la plateforme aux entreprises clientes.
CREATE TABLE IF NOT EXISTS depannhome_subscription_billing_profile (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    company_name VARCHAR(160) NOT NULL DEFAULT '',
    legal_form VARCHAR(100) NOT NULL DEFAULT '',
    address VARCHAR(255) NOT NULL DEFAULT '',
    postal_code VARCHAR(20) NOT NULL DEFAULT '',
    city VARCHAR(100) NOT NULL DEFAULT '',
    phone VARCHAR(50) NOT NULL DEFAULT '',
    email VARCHAR(160) NOT NULL DEFAULT '',
    registration_number VARCHAR(100) NOT NULL DEFAULT '',
    tax_number VARCHAR(100) NOT NULL DEFAULT '',
    bank_iban VARCHAR(34) NOT NULL DEFAULT '',
    bank_bic VARCHAR(11) NOT NULL DEFAULT '',
    vat_rate NUMERIC(5,2) NOT NULL DEFAULT 20 CHECK (vat_rate >= 0 AND vat_rate <= 100),
    payment_terms VARCHAR(500) NOT NULL DEFAULT '',
    footer_note VARCHAR(1000) NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS depannhome_subscription_invoices (
    id BIGSERIAL PRIMARY KEY,
    account_owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    billing_period DATE NOT NULL,
    invoice_number VARCHAR(80) NOT NULL UNIQUE,
    recipient_name VARCHAR(160) NOT NULL,
    recipient_email VARCHAR(160) NOT NULL,
    recipient_address VARCHAR(500) NOT NULL DEFAULT '',
    subscription_label VARCHAR(80) NOT NULL DEFAULT '',
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    vat_rate NUMERIC(5,2) NOT NULL CHECK (vat_rate >= 0 AND vat_rate <= 100),
    issue_date DATE NOT NULL,
    due_date DATE NOT NULL,
    issuer_profile JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
    sent_at TIMESTAMPTZ,
    last_error VARCHAR(1000) NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT depannhome_subscription_invoices_owner_period_unique UNIQUE (account_owner_id, billing_period)
);

CREATE INDEX IF NOT EXISTS depannhome_subscription_invoices_status_idx
    ON depannhome_subscription_invoices (status, created_at);

CREATE TABLE IF NOT EXISTS depannhome_purchases (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    created_by BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE RESTRICT,
    purchase_date DATE NOT NULL,
    category VARCHAR(40) NOT NULL DEFAULT 'Autre',
    client_id VARCHAR(100) NOT NULL DEFAULT '',
    client_name VARCHAR(160) NOT NULL DEFAULT '',
    supplier VARCHAR(160) NOT NULL DEFAULT '',
    description VARCHAR(500) NOT NULL,
    reference VARCHAR(100) NOT NULL DEFAULT '',
    amount_ht NUMERIC(12,2) NOT NULL CHECK (amount_ht >= 0),
    vat_rate NUMERIC(5,2) NOT NULL DEFAULT 20 CHECK (vat_rate >= 0 AND vat_rate <= 100),
    is_accounted BOOLEAN NOT NULL DEFAULT FALSE,
    accounted_at DATE,
    notes VARCHAR(2000) NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS depannhome_purchases_owner_date_idx
    ON depannhome_purchases (owner_id, purchase_date DESC, id DESC);

ALTER TABLE depannhome_purchases
    ADD COLUMN IF NOT EXISTS client_id VARCHAR(100) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS client_name VARCHAR(160) NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS depannhome_purchases_accounting_idx
    ON depannhome_purchases (owner_id, is_accounted, purchase_date DESC);

CREATE TABLE IF NOT EXISTS depannhome_messages (
    id BIGSERIAL PRIMARY KEY,
    sender_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    recipient_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    client_id VARCHAR(100),
    body VARCHAR(2000) NOT NULL,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE depannhome_messages
    DROP CONSTRAINT IF EXISTS depannhome_messages_distinct_accounts;

ALTER TABLE depannhome_messages
    ADD COLUMN IF NOT EXISTS client_id VARCHAR(100),
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS depannhome_messages_recipient_idx
    ON depannhome_messages (recipient_id, created_at DESC);

CREATE INDEX IF NOT EXISTS depannhome_messages_sender_idx
    ON depannhome_messages (sender_id, created_at DESC);

CREATE INDEX IF NOT EXISTS depannhome_messages_client_idx
    ON depannhome_messages (recipient_id, client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS depannhome_calendar_events (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    assigned_technician_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    title VARCHAR(160) NOT NULL,
    client_name VARCHAR(160) NOT NULL DEFAULT '',
    location VARCHAR(255) NOT NULL DEFAULT '',
    event_date DATE NOT NULL,
    start_time TIME,
    end_time TIME,
    color VARCHAR(20) NOT NULL DEFAULT 'blue',
    event_type VARCHAR(20) NOT NULL DEFAULT 'appointment',
    quitus_status VARCHAR(20) NOT NULL DEFAULT 'pending',
    quitus_signed_by VARCHAR(160) NOT NULL DEFAULT '',
    quitus_signature TEXT NOT NULL DEFAULT '',
    quitus_signed_at TIMESTAMPTZ,
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

ALTER TABLE depannhome_calendar_events
    ADD COLUMN IF NOT EXISTS assigned_technician_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL;

ALTER TABLE depannhome_calendar_events
ADD COLUMN IF NOT EXISTS event_type VARCHAR(20) NOT NULL DEFAULT 'appointment';

-- Types gérés par l’application : appointment, task, vacation, sick_leave, unavailable.

ALTER TABLE depannhome_calendar_events
ADD COLUMN IF NOT EXISTS quitus_status VARCHAR(20) NOT NULL DEFAULT 'pending',
ADD COLUMN IF NOT EXISTS quitus_signed_by VARCHAR(160) NOT NULL DEFAULT '',
ADD COLUMN IF NOT EXISTS quitus_signature TEXT NOT NULL DEFAULT '',
ADD COLUMN IF NOT EXISTS quitus_signed_at TIMESTAMPTZ;

-- Un rendez-vous peut réunir plusieurs techniciens. Le champ historique
-- assigned_technician_id reste le technicien référent pour compatibilité.
CREATE TABLE IF NOT EXISTS depannhome_calendar_assignments (
    event_id BIGINT NOT NULL REFERENCES depannhome_calendar_events(id) ON DELETE CASCADE,
    technician_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (event_id, technician_id)
);

CREATE INDEX IF NOT EXISTS depannhome_calendar_assignments_technician_idx
    ON depannhome_calendar_assignments (technician_id, event_id);

INSERT INTO depannhome_calendar_assignments (event_id, technician_id, is_primary)
SELECT id, assigned_technician_id, TRUE
FROM depannhome_calendar_events
WHERE assigned_technician_id IS NOT NULL
ON CONFLICT (event_id, technician_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS depannhome_library_sections (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(80) NOT NULL,
    slug VARCHAR(100) NOT NULL,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    created_by BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE depannhome_library_sections ADD COLUMN IF NOT EXISTS owner_id BIGINT REFERENCES depannhome_users(id) ON DELETE CASCADE;
UPDATE depannhome_library_sections SET owner_id = created_by WHERE owner_id IS NULL;
ALTER TABLE depannhome_library_sections ALTER COLUMN owner_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS depannhome_library_sections_owner_slug_unique ON depannhome_library_sections (owner_id, slug);

CREATE TABLE IF NOT EXISTS depannhome_library_documents (
    id BIGSERIAL PRIMARY KEY,
    section_id BIGINT NOT NULL REFERENCES depannhome_library_sections(id) ON DELETE CASCADE,
    title VARCHAR(160) NOT NULL,
    description VARCHAR(1000) NOT NULL DEFAULT '',
    original_filename VARCHAR(255) NOT NULL,
    mime_type VARCHAR(150) NOT NULL,
    file_size INTEGER NOT NULL CHECK (file_size > 0 AND file_size <= 20971520),
    file_data BYTEA NOT NULL,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    created_by BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS depannhome_library_documents_section_idx
    ON depannhome_library_documents (section_id, created_at DESC);

ALTER TABLE depannhome_library_documents ADD COLUMN IF NOT EXISTS owner_id BIGINT REFERENCES depannhome_users(id) ON DELETE CASCADE;
UPDATE depannhome_library_documents document SET owner_id = section.owner_id FROM depannhome_library_sections section WHERE document.section_id = section.id AND document.owner_id IS NULL;
ALTER TABLE depannhome_library_documents ALTER COLUMN owner_id SET NOT NULL;
