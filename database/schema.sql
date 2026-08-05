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

-- Annonce unique administrée par le Créateur et diffusée à toutes les entreprises.
CREATE TABLE IF NOT EXISTS depannhome_platform_announcements (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    message VARCHAR(2000) NOT NULL DEFAULT '',
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    updated_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Gestion des accès : les journaux restent conservés après suppression d’un
-- membre, grâce aux références d’auteur et de cible annulables.
CREATE TABLE IF NOT EXISTS depannhome_member_audit (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    actor_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    target_user_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    target_username VARCHAR(32) NOT NULL DEFAULT '',
    target_full_name VARCHAR(100) NOT NULL DEFAULT '',
    action VARCHAR(60) NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_member_audit_owner_created_idx ON depannhome_member_audit (owner_id, created_at DESC);

UPDATE depannhome_users SET account_owner_id = id WHERE account_owner_id IS NULL;
UPDATE depannhome_users SET role = 'admin' WHERE role = 'user' AND account_owner_id = id;

-- Mode Groupe optionnel. Chaque société reste un propriétaire de compte existant ;
-- les données métier restent donc isolées par owner_id sans migration des données.
CREATE TABLE IF NOT EXISTS depannhome_groups (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(160) NOT NULL,
    shared_partner_directory_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS depannhome_group_companies (
    group_id BIGINT NOT NULL REFERENCES depannhome_groups(id) ON DELETE CASCADE,
    company_owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE RESTRICT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(group_id, company_owner_id), UNIQUE(company_owner_id)
);
CREATE TABLE IF NOT EXISTS depannhome_group_administrators (
    group_id BIGINT NOT NULL REFERENCES depannhome_groups(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(group_id, user_id)
);
CREATE TABLE IF NOT EXISTS depannhome_group_audit (
    id BIGSERIAL PRIMARY KEY, group_id BIGINT NOT NULL REFERENCES depannhome_groups(id) ON DELETE CASCADE,
    company_owner_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    actor_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    action VARCHAR(80) NOT NULL, details JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_address VARCHAR(100) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Rôle mobile dédié : compte rattaché à l’entreprise, jamais propriétaire du compte.
-- Son appareil utilise le flux existant d’autorisation et de code e-mail.

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

-- Double authentification optionnelle des entreprises. La politique appartient
-- à l’entreprise ; les authentificateurs restent individuels pour permettre
-- ultérieurement plusieurs appareils et des méthodes de secours.
CREATE TABLE IF NOT EXISTS depannhome_company_totp_policies (
    owner_id BIGINT PRIMARY KEY REFERENCES depannhome_users(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    enabled_at TIMESTAMPTZ,
    enabled_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS depannhome_company_totp_authenticators (
    id UUID PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    label VARCHAR(100) NOT NULL DEFAULT 'Application d’authentification',
    secret_ciphertext TEXT NOT NULL DEFAULT '',
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active')),
    pending_expires_at TIMESTAMPTZ,
    confirmed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_company_totp_authenticators_user_idx
    ON depannhome_company_totp_authenticators (user_id, status, updated_at DESC);
CREATE TABLE IF NOT EXISTS depannhome_company_totp_challenges (
    id UUID PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    purpose VARCHAR(20) NOT NULL CHECK (purpose IN ('login', 'enrollment')),
    device JSONB NOT NULL DEFAULT '{}'::jsonb,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_company_totp_challenges_user_idx
    ON depannhome_company_totp_challenges (user_id, purpose, expires_at DESC);

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

-- Comptabilité et facturation électronique compatible PDP : préparation et transmission via le connecteur choisi par l'entreprise, données isolées par owner_id.
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

-- Moteur générique de rapports techniques. Le type leak_detection est le premier
-- modèle livré ; content stocke aussi l'ordre, les titres et les copies de
-- sections, tandis que media permet l’ajout de futurs modèles sans modifier
-- les dossiers clients ni leurs limites de pièces jointes.
CREATE TABLE IF NOT EXISTS depannhome_technical_reports (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    appointment_id BIGINT REFERENCES depannhome_calendar_events(id) ON DELETE SET NULL,
    client_id VARCHAR(100) NOT NULL DEFAULT '', report_type VARCHAR(40) NOT NULL DEFAULT 'leak_detection',
    title VARCHAR(160) NOT NULL DEFAULT 'Rapport de recherche de fuite', report_date DATE NOT NULL DEFAULT CURRENT_DATE,
    content JSONB NOT NULL DEFAULT '{}'::jsonb, media JSONB NOT NULL DEFAULT '[]'::jsonb,
    status VARCHAR(30) NOT NULL DEFAULT 'draft', submitted_at TIMESTAMPTZ, validated_at TIMESTAMPTZ,
    validated_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    pdf_data BYTEA, pdf_filename VARCHAR(255) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_technical_reports_owner_updated_idx ON depannhome_technical_reports (owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS depannhome_technical_reports_owner_appointment_idx ON depannhome_technical_reports (owner_id, appointment_id);

CREATE TABLE IF NOT EXISTS depannhome_technical_report_corrections (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    report_id BIGINT NOT NULL REFERENCES depannhome_technical_reports(id) ON DELETE CASCADE,
    section_key VARCHAR(40) NOT NULL, comment VARCHAR(2000) NOT NULL,
    requested_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    resolved_at TIMESTAMPTZ, resolved_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_technical_report_corrections_report_idx ON depannhome_technical_report_corrections (owner_id, report_id, created_at DESC);

CREATE TABLE IF NOT EXISTS depannhome_technical_report_library (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    category VARCHAR(40) NOT NULL, label VARCHAR(160) NOT NULL, content JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_technical_report_library_owner_idx ON depannhome_technical_report_library (owner_id, category, LOWER(label));

-- Importations de données : les fichiers sont analysés côté serveur, puis seule
-- une session temporaire par entreprise/utilisateur est conservée avant validation.
CREATE TABLE IF NOT EXISTS depannhome_data_import_sessions (
    id UUID PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE, data_type VARCHAR(20) NOT NULL,
    filename VARCHAR(255) NOT NULL, columns JSONB NOT NULL DEFAULT '[]'::jsonb, rows JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS depannhome_data_import_logs (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    user_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL, data_type VARCHAR(20) NOT NULL,
    filename VARCHAR(255) NOT NULL, source_rows INTEGER NOT NULL DEFAULT 0, imported_count INTEGER NOT NULL DEFAULT 0,
    duplicate_count INTEGER NOT NULL DEFAULT 0, error_count INTEGER NOT NULL DEFAULT 0,
    duplicate_strategy VARCHAR(20) NOT NULL DEFAULT 'skip', details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_data_import_logs_owner_created_idx ON depannhome_data_import_logs(owner_id, created_at DESC);

-- Collaboration réutilisable : le verrou est persistant et expirant. Les événements
-- temps réel SSE sont un transport ; l’audit et les notifications restent disponibles
-- après déconnexion, redémarrage ou perte de réseau.
CREATE TABLE IF NOT EXISTS depannhome_collaboration_locks (
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    entity_type VARCHAR(40) NOT NULL, entity_id VARCHAR(120) NOT NULL,
    locked_by BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL, device_type VARCHAR(20) NOT NULL DEFAULT 'desktop', device_label VARCHAR(100) NOT NULL DEFAULT '',
    PRIMARY KEY (owner_id, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS depannhome_collaboration_locks_expiry_idx ON depannhome_collaboration_locks (expires_at);

CREATE TABLE IF NOT EXISTS depannhome_collaboration_notifications (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    recipient_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    event_type VARCHAR(80) NOT NULL, entity_type VARCHAR(40) NOT NULL DEFAULT '', entity_id VARCHAR(120) NOT NULL DEFAULT '',
    title VARCHAR(200) NOT NULL, body VARCHAR(2000) NOT NULL DEFAULT '', payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    read_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_collaboration_notifications_recipient_idx ON depannhome_collaboration_notifications (recipient_id, read_at, created_at DESC);

CREATE TABLE IF NOT EXISTS depannhome_collaboration_audit (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    entity_type VARCHAR(40) NOT NULL, entity_id VARCHAR(120) NOT NULL, action VARCHAR(80) NOT NULL,
    actor_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL, actor_role VARCHAR(30) NOT NULL DEFAULT '',
    ip_address VARCHAR(100) NOT NULL DEFAULT '', device_type VARCHAR(20) NOT NULL DEFAULT '', device_label VARCHAR(100) NOT NULL DEFAULT '',
    details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_collaboration_audit_entity_idx ON depannhome_collaboration_audit (owner_id, entity_type, entity_id, created_at DESC);

-- Réception de missions partenaires : l'endpoint public porte un identifiant
-- non secret et une clé API uniquement conservée sous forme de hash SHA-256.
CREATE TABLE IF NOT EXISTS depannhome_partner_intakes (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    partner_key VARCHAR(64) NOT NULL, partner_name VARCHAR(160) NOT NULL, api_key_hash VARCHAR(128) NOT NULL,
    callback_url VARCHAR(1000) NOT NULL DEFAULT '', assignment_mode VARCHAR(20) NOT NULL DEFAULT 'manual',
    rules JSONB NOT NULL DEFAULT '{}'::jsonb, enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT depannhome_partner_intakes_owner_key_unique UNIQUE(owner_id, partner_key),
    CONSTRAINT depannhome_partner_intakes_api_key_unique UNIQUE(api_key_hash)
);
CREATE TABLE IF NOT EXISTS depannhome_partner_missions (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    intake_id BIGINT NOT NULL REFERENCES depannhome_partner_intakes(id) ON DELETE RESTRICT, external_mission_id VARCHAR(160) NOT NULL,
    partner_reference VARCHAR(160) NOT NULL DEFAULT '', status VARCHAR(30) NOT NULL DEFAULT 'received', priority VARCHAR(20) NOT NULL DEFAULT 'normal',
    source_data JSONB NOT NULL DEFAULT '{}'::jsonb, mapped_data JSONB NOT NULL DEFAULT '{}'::jsonb, validation_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
    client_id VARCHAR(100) NOT NULL DEFAULT '', calendar_event_id BIGINT REFERENCES depannhome_calendar_events(id) ON DELETE SET NULL,
    technical_report_id BIGINT REFERENCES depannhome_technical_reports(id) ON DELETE SET NULL, assigned_technician_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    scheduled_date DATE, scheduled_start_time TIME, scheduled_end_time TIME, retry_count INTEGER NOT NULL DEFAULT 0, next_retry_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT depannhome_partner_missions_unique UNIQUE(owner_id, intake_id, external_mission_id)
);
CREATE INDEX IF NOT EXISTS depannhome_partner_missions_owner_status_idx ON depannhome_partner_missions(owner_id, status, created_at DESC);
CREATE TABLE IF NOT EXISTS depannhome_partner_mission_history (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    mission_id BIGINT NOT NULL REFERENCES depannhome_partner_missions(id) ON DELETE CASCADE, status VARCHAR(30) NOT NULL, action VARCHAR(80) NOT NULL,
    actor_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL, actor_role VARCHAR(30) NOT NULL DEFAULT '', details JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_address VARCHAR(100) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_partner_mission_history_mission_idx ON depannhome_partner_mission_history(mission_id, created_at DESC);
CREATE TABLE IF NOT EXISTS depannhome_partner_mission_outbox (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    mission_id BIGINT NOT NULL REFERENCES depannhome_partner_missions(id) ON DELETE CASCADE, event_type VARCHAR(80) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb, status VARCHAR(20) NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
    last_error VARCHAR(1000) NOT NULL DEFAULT '', next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), delivered_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_partner_mission_outbox_pending_idx ON depannhome_partner_mission_outbox(status, next_attempt_at);

-- Fil collaboratif strictement rattaché à une mission partenaire. Les fichiers
-- sont séparés des dossiers clients pour conserver les limites métier existantes.
CREATE TABLE IF NOT EXISTS depannhome_partner_dialogue_messages (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    mission_id BIGINT NOT NULL REFERENCES depannhome_partner_missions(id) ON DELETE CASCADE,
    sender_type VARCHAR(20) NOT NULL, sender_user_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    sender_name VARCHAR(160) NOT NULL DEFAULT '', organization_name VARCHAR(160) NOT NULL DEFAULT '',
    kind VARCHAR(20) NOT NULL DEFAULT 'message', issue_type VARCHAR(60) NOT NULL DEFAULT '',
    body VARCHAR(4000) NOT NULL DEFAULT '', reply_to_id BIGINT REFERENCES depannhome_partner_dialogue_messages(id) ON DELETE SET NULL,
    partner_visible BOOLEAN NOT NULL DEFAULT FALSE, event_type VARCHAR(80) NOT NULL DEFAULT '', immutable BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE depannhome_partner_dialogue_messages
    ADD COLUMN IF NOT EXISTS partner_visible BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS event_type VARCHAR(80) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS immutable BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE INDEX IF NOT EXISTS depannhome_partner_dialogue_messages_mission_idx ON depannhome_partner_dialogue_messages(owner_id, mission_id, created_at, id);
CREATE TABLE IF NOT EXISTS depannhome_partner_dialogue_attachments (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    mission_id BIGINT NOT NULL REFERENCES depannhome_partner_missions(id) ON DELETE CASCADE,
    message_id BIGINT NOT NULL REFERENCES depannhome_partner_dialogue_messages(id) ON DELETE CASCADE,
    attachment_type VARCHAR(40) NOT NULL DEFAULT 'document', filename VARCHAR(255) NOT NULL, mime_type VARCHAR(150) NOT NULL,
    file_size INTEGER NOT NULL CHECK(file_size > 0 AND file_size <= 5242880), file_data BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_partner_dialogue_attachments_message_idx ON depannhome_partner_dialogue_attachments(message_id);
-- Les entrées ne sont jamais supprimées par le journal : toute modification de
-- visibilité est tracée avec l’auteur, l’horodatage et les valeurs avant/après.
CREATE TABLE IF NOT EXISTS depannhome_partner_dialogue_audit (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    mission_id BIGINT NOT NULL REFERENCES depannhome_partner_missions(id) ON DELETE CASCADE,
    message_id BIGINT NOT NULL REFERENCES depannhome_partner_dialogue_messages(id) ON DELETE CASCADE,
    action VARCHAR(60) NOT NULL, actor_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    actor_name VARCHAR(160) NOT NULL DEFAULT '', old_value JSONB NOT NULL DEFAULT '{}'::jsonb,
    new_value JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_partner_dialogue_audit_message_idx ON depannhome_partner_dialogue_audit(owner_id, mission_id, message_id, created_at DESC);

-- Connexions simples entre entreprises Depann'Home Pro. Les secrets éventuels
-- restent internes au serveur : l'utilisateur ne configure ni clé, ni URL, ni webhook.
CREATE TABLE IF NOT EXISTS depannhome_partner_directory (
    owner_id BIGINT PRIMARY KEY REFERENCES depannhome_users(id) ON DELETE CASCADE,
    is_listed BOOLEAN NOT NULL DEFAULT FALSE, visibility_explicit BOOLEAN NOT NULL DEFAULT FALSE,
    description VARCHAR(1000) NOT NULL DEFAULT '', trades JSONB NOT NULL DEFAULT '[]'::jsonb,
    supported_brands JSONB NOT NULL DEFAULT '[]'::jsonb, specialties JSONB NOT NULL DEFAULT '[]'::jsonb,
    service_area VARCHAR(500) NOT NULL DEFAULT '', service_radius_km INTEGER NOT NULL DEFAULT 0,
    departments JSONB NOT NULL DEFAULT '[]'::jsonb, opening_hours VARCHAR(1000) NOT NULL DEFAULT '',
    share_phone BOOLEAN NOT NULL DEFAULT FALSE, share_email BOOLEAN NOT NULL DEFAULT FALSE,
    website VARCHAR(500) NOT NULL DEFAULT '', accepts_partner_missions BOOLEAN NOT NULL DEFAULT FALSE,
    latitude NUMERIC(9,6), longitude NUMERIC(9,6), creator_suspended BOOLEAN NOT NULL DEFAULT FALSE,
    creator_note VARCHAR(1000) NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Chaque propriétaire d’entreprise est inscrit automatiquement au registre interne.
-- La visibilité reste strictement désactivée tant que l’entreprise ne la confirme pas.
CREATE OR REPLACE FUNCTION depannhome_register_partner_directory() RETURNS trigger AS $$
BEGIN
    IF NEW.account_owner_id = NEW.id THEN
        INSERT INTO depannhome_partner_directory(owner_id,is_listed,visibility_explicit)
        VALUES(NEW.id,FALSE,FALSE) ON CONFLICT(owner_id) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS depannhome_partner_directory_registration ON depannhome_users;
CREATE TRIGGER depannhome_partner_directory_registration
AFTER INSERT OR UPDATE OF account_owner_id ON depannhome_users
FOR EACH ROW EXECUTE FUNCTION depannhome_register_partner_directory();
CREATE INDEX IF NOT EXISTS depannhome_partner_directory_search_idx ON depannhome_partner_directory(is_listed,creator_suspended,updated_at DESC);
CREATE TABLE IF NOT EXISTS depannhome_partner_connections (
    id BIGSERIAL PRIMARY KEY, company_low_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    company_high_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    requester_owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE RESTRICT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending', permissions_for_low JSONB NOT NULL DEFAULT '{}'::jsonb,
    permissions_for_high JSONB NOT NULL DEFAULT '{}'::jsonb, requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    responded_at TIMESTAMPTZ, responded_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    disconnected_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT depannhome_partner_connections_pair_unique UNIQUE(company_low_id, company_high_id),
    CONSTRAINT depannhome_partner_connections_pair_check CHECK(company_low_id < company_high_id),
    CONSTRAINT depannhome_partner_connections_state_check CHECK(status IN ('pending','connected','refused','disconnected'))
);
CREATE INDEX IF NOT EXISTS depannhome_partner_connections_company_idx ON depannhome_partner_connections(company_low_id, company_high_id, status, updated_at DESC);
CREATE TABLE IF NOT EXISTS depannhome_partner_connection_sync_log (
    id BIGSERIAL PRIMARY KEY, connection_id BIGINT NOT NULL REFERENCES depannhome_partner_connections(id) ON DELETE CASCADE,
    source_owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    target_owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    source_event_id BIGINT REFERENCES depannhome_calendar_events(id) ON DELETE SET NULL,
    target_mission_id BIGINT REFERENCES depannhome_partner_missions(id) ON DELETE SET NULL,
    event_type VARCHAR(60) NOT NULL, details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_partner_connection_sync_source_event_idx ON depannhome_partner_connection_sync_log(source_owner_id, source_event_id, created_at DESC);

-- Demandes publiques de partenariat : aucune session ni autorisation n’est créée
-- au dépôt. Une demande acceptée est reliée à une fiche officielle, laquelle
-- prépare les futurs contrats, connecteurs, permissions et espaces partenaires.
CREATE TABLE IF NOT EXISTS depannhome_official_partners (
    id BIGSERIAL PRIMARY KEY,
    request_id BIGINT UNIQUE,
    company_name VARCHAR(160) NOT NULL,
    organization_type VARCHAR(40) NOT NULL,
    contact_name VARCHAR(100) NOT NULL DEFAULT '',
    contact_role VARCHAR(100) NOT NULL DEFAULT '',
    email VARCHAR(160) NOT NULL DEFAULT '',
    phone VARCHAR(50) NOT NULL DEFAULT '',
    website VARCHAR(500) NOT NULL DEFAULT '',
    status VARCHAR(30) NOT NULL DEFAULT 'pending_setup',
    permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
    connector_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    partner_account_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT depannhome_official_partners_status_check CHECK (status IN ('pending_setup', 'active', 'inactive'))
);
CREATE TABLE IF NOT EXISTS depannhome_partner_requests (
    id BIGSERIAL PRIMARY KEY,
    company_name VARCHAR(160) NOT NULL, organization_type VARCHAR(40) NOT NULL,
    contact_name VARCHAR(100) NOT NULL, contact_role VARCHAR(100) NOT NULL,
    email VARCHAR(160) NOT NULL, phone VARCHAR(50) NOT NULL, website VARCHAR(500) NOT NULL DEFAULT '',
    message VARCHAR(4000) NOT NULL, status VARCHAR(30) NOT NULL DEFAULT 'new',
    administrative_notes VARCHAR(4000) NOT NULL DEFAULT '',
    official_partner_id BIGINT REFERENCES depannhome_official_partners(id) ON DELETE SET NULL,
    submitted_ip VARCHAR(100) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT depannhome_partner_requests_status_check CHECK (status IN ('new', 'under_review', 'contacted', 'accepted', 'refused'))
);
ALTER TABLE depannhome_official_partners ADD COLUMN IF NOT EXISTS request_id BIGINT UNIQUE;
ALTER TABLE depannhome_official_partners
    ADD COLUMN IF NOT EXISTS partner_type VARCHAR(30) NOT NULL DEFAULT 'credentials',
    ADD COLUMN IF NOT EXISTS logo_url VARCHAR(1000) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS description VARCHAR(2000) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS activity_category VARCHAR(160) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS api_url VARCHAR(1000) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS documentation_url VARCHAR(1000) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS sandbox_url VARCHAR(1000) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS connector_state VARCHAR(30) NOT NULL DEFAULT 'development',
    ADD COLUMN IF NOT EXISTS connector_secret_ciphertext TEXT NOT NULL DEFAULT '';
ALTER TABLE depannhome_official_partners DROP CONSTRAINT IF EXISTS depannhome_official_partners_partner_type_check;
ALTER TABLE depannhome_official_partners ADD CONSTRAINT depannhome_official_partners_partner_type_check CHECK (partner_type IN ('depannhome_company','credentials','oauth'));
ALTER TABLE depannhome_official_partners DROP CONSTRAINT IF EXISTS depannhome_official_partners_connector_state_check;
ALTER TABLE depannhome_official_partners ADD CONSTRAINT depannhome_official_partners_connector_state_check CHECK (connector_state IN ('development','beta','available','disabled'));
CREATE TABLE IF NOT EXISTS depannhome_official_partner_connections (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    official_partner_id BIGINT NOT NULL REFERENCES depannhome_official_partners(id) ON DELETE CASCADE,
    status VARCHAR(30) NOT NULL DEFAULT 'connected', credentials_ciphertext TEXT NOT NULL DEFAULT '',
    connected_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT depannhome_official_partner_connections_unique UNIQUE(owner_id, official_partner_id),
    CONSTRAINT depannhome_official_partner_connections_status_check CHECK (status IN ('connected', 'disconnected'))
);
CREATE TABLE IF NOT EXISTS depannhome_official_partner_oauth_states (
    state VARCHAR(128) PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    official_partner_id BIGINT NOT NULL REFERENCES depannhome_official_partners(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE depannhome_partner_requests ADD COLUMN IF NOT EXISTS official_partner_id BIGINT REFERENCES depannhome_official_partners(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS depannhome_partner_requests_status_created_idx ON depannhome_partner_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS depannhome_official_partners_status_idx ON depannhome_official_partners(status, created_at DESC);

ALTER TABLE depannhome_library_documents ADD COLUMN IF NOT EXISTS owner_id BIGINT REFERENCES depannhome_users(id) ON DELETE CASCADE;
UPDATE depannhome_library_documents document SET owner_id = section.owner_id FROM depannhome_library_sections section WHERE document.section_id = section.id AND document.owner_id IS NULL;
ALTER TABLE depannhome_library_documents ALTER COLUMN owner_id SET NOT NULL;
