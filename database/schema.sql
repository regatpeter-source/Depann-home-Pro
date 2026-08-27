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
    departments JSONB NOT NULL DEFAULT '[]'::jsonb,
    company_name VARCHAR(160) NOT NULL DEFAULT '',
    max_pc_users INTEGER NOT NULL DEFAULT 1,
    max_technicians INTEGER NOT NULL DEFAULT 5,
    can_access_billing BOOLEAN NOT NULL DEFAULT FALSE,
    can_access_accounting BOOLEAN NOT NULL DEFAULT FALSE,
    can_access_company_email BOOLEAN NOT NULL DEFAULT FALSE,
    can_switch_group_companies BOOLEAN NOT NULL DEFAULT FALSE,
    subscription_plan VARCHAR(20) NOT NULL DEFAULT 'free',
    subscription_tier VARCHAR(20) NOT NULL DEFAULT 'pro' CHECK (subscription_tier IN ('basic','basic_plus','pro')),
    subscription_label VARCHAR(80) NOT NULL DEFAULT '',
    monthly_price_cents INTEGER NOT NULL DEFAULT 0,
    subscription_discount_label VARCHAR(160) NOT NULL DEFAULT '',
    subscription_discount_mode VARCHAR(20) NOT NULL DEFAULT 'fixed',
    subscription_discount_value NUMERIC(10,2) NOT NULL DEFAULT 0,
    subscription_status VARCHAR(20) NOT NULL DEFAULT 'active',
    subscription_renewal_date DATE,
    billing_reference VARCHAR(100) NOT NULL DEFAULT '',
    creator_note VARCHAR(1000) NOT NULL DEFAULT '',
    quote_template_policy VARCHAR(30) NOT NULL DEFAULT 'company_choice',
    quitus_template_policy VARCHAR(30) NOT NULL DEFAULT 'company_choice',
    report_template_policy VARCHAR(30) NOT NULL DEFAULT 'company_choice',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    is_archived BOOLEAN NOT NULL DEFAULT FALSE,
    archived_at TIMESTAMPTZ,
    archived_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
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

-- Demandes d'évolution ou de rétrogradation : l'entreprise propose, le
-- Créateur traite. Le forfait actif n'est jamais modifié automatiquement.
CREATE TABLE IF NOT EXISTS depannhome_subscription_change_requests (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    requested_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    current_tier VARCHAR(20) NOT NULL CHECK (current_tier IN ('basic','basic_plus','pro')),
    requested_tier VARCHAR(20) NOT NULL CHECK (requested_tier IN ('basic','basic_plus','pro')),
    requested_pc_seats INTEGER CHECK (requested_pc_seats IS NULL OR requested_pc_seats BETWEEN 1 AND 100),
    requested_mobile_seats INTEGER CHECK (requested_mobile_seats IS NULL OR requested_mobile_seats BETWEEN 0 AND 500),
    status VARCHAR(20) NOT NULL DEFAULT 'new' CHECK (status IN ('new','under_review','accepted','refused','cancelled')),
    company_message VARCHAR(1000) NOT NULL DEFAULT '',
    creator_note VARCHAR(2000) NOT NULL DEFAULT '',
    resolved_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_subscription_change_requests_owner_idx ON depannhome_subscription_change_requests(owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS depannhome_support_requests (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    requested_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    sender_name VARCHAR(100) NOT NULL DEFAULT '', sender_email VARCHAR(160) NOT NULL DEFAULT '', sender_username VARCHAR(32) NOT NULL DEFAULT '',
    message VARCHAR(4000) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'new' CHECK (status IN ('new','under_review','answered','closed')),
    creator_note VARCHAR(2000) NOT NULL DEFAULT '',
    handled_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL, handled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_support_requests_status_created_idx ON depannhome_support_requests(status,created_at DESC);

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
    ADD COLUMN IF NOT EXISTS departments JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS max_pc_users INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS max_technicians INTEGER NOT NULL DEFAULT 5,
    ADD COLUMN IF NOT EXISTS can_access_billing BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS can_access_accounting BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS can_access_company_email BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS can_switch_group_companies BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS subscription_plan VARCHAR(20) NOT NULL DEFAULT 'free',
    ADD COLUMN IF NOT EXISTS subscription_tier VARCHAR(20) NOT NULL DEFAULT 'pro',
    ADD COLUMN IF NOT EXISTS subscription_label VARCHAR(80) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS monthly_price_cents INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS subscription_discount_label VARCHAR(160) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS subscription_discount_mode VARCHAR(20) NOT NULL DEFAULT 'fixed',
    ADD COLUMN IF NOT EXISTS subscription_discount_value NUMERIC(10,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(20) NOT NULL DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS subscription_renewal_date DATE,
    ADD COLUMN IF NOT EXISTS billing_reference VARCHAR(100) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS creator_note VARCHAR(1000) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS quote_template_policy VARCHAR(30) NOT NULL DEFAULT 'company_choice',
    ADD COLUMN IF NOT EXISTS quitus_template_policy VARCHAR(30) NOT NULL DEFAULT 'company_choice',
    ADD COLUMN IF NOT EXISTS report_template_policy VARCHAR(30) NOT NULL DEFAULT 'company_choice',
    ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS archived_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL;
UPDATE depannhome_users SET departments = jsonb_build_array(department)
WHERE department <> '' AND jsonb_array_length(departments) = 0;
UPDATE depannhome_users SET subscription_tier='pro' WHERE subscription_tier IS NULL OR subscription_tier NOT IN ('basic','basic_plus','pro');
ALTER TABLE depannhome_users DROP CONSTRAINT IF EXISTS depannhome_users_subscription_tier_check;
ALTER TABLE depannhome_users ADD CONSTRAINT depannhome_users_subscription_tier_check CHECK(subscription_tier IN ('basic','basic_plus','pro'));
CREATE INDEX IF NOT EXISTS depannhome_users_owner_archive_idx ON depannhome_users(account_owner_id, is_archived, updated_at DESC);

CREATE TABLE IF NOT EXISTS depannhome_account_lifecycle_audit (
    id BIGSERIAL PRIMARY KEY,
    account_owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    actor_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    action VARCHAR(30) NOT NULL CHECK (action IN ('archived', 'restored')),
    reason VARCHAR(500) NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_account_lifecycle_audit_owner_idx ON depannhome_account_lifecycle_audit(account_owner_id, created_at DESC);

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
    client_status VARCHAR(20) NOT NULL DEFAULT 'active' CONSTRAINT depannhome_clients_status_check CHECK (client_status IN ('active', 'archived')),
    archived_at TIMESTAMPTZ,
    archived_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT depannhome_clients_owner_client_unique UNIQUE (owner_id, client_id)
);

CREATE INDEX IF NOT EXISTS depannhome_clients_owner_updated_idx
    ON depannhome_clients (owner_id, updated_at DESC);
ALTER TABLE depannhome_clients ADD COLUMN IF NOT EXISTS client_status VARCHAR(20) NOT NULL DEFAULT 'active';
ALTER TABLE depannhome_clients ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE depannhome_clients ADD COLUMN IF NOT EXISTS archived_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL;
UPDATE depannhome_clients SET client_status='active' WHERE client_status NOT IN ('active','archived');
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='depannhome_clients_status_check') THEN ALTER TABLE depannhome_clients ADD CONSTRAINT depannhome_clients_status_check CHECK (client_status IN ('active','archived')); END IF; END $$;
CREATE INDEX IF NOT EXISTS depannhome_clients_owner_status_updated_idx ON depannhome_clients (owner_id, client_status, updated_at DESC);

CREATE TABLE IF NOT EXISTS depannhome_deleted_clients (
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    client_id VARCHAR(100) NOT NULL,
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, client_id)
);

CREATE TABLE IF NOT EXISTS depannhome_client_lifecycle_audit (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    client_id VARCHAR(100) NOT NULL, action VARCHAR(30) NOT NULL,
    actor_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL, actor_name VARCHAR(160) NOT NULL DEFAULT '',
    details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_client_lifecycle_audit_client_idx ON depannhome_client_lifecycle_audit (owner_id, client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS depannhome_billing_profiles (
    owner_id BIGINT PRIMARY KEY REFERENCES depannhome_users(id) ON DELETE CASCADE,
    company_name VARCHAR(160) NOT NULL DEFAULT '',
    legal_form VARCHAR(100) NOT NULL DEFAULT '',
    address VARCHAR(255) NOT NULL DEFAULT '',
    postal_code VARCHAR(20) NOT NULL DEFAULT '',
    city VARCHAR(100) NOT NULL DEFAULT '',
    phone VARCHAR(50) NOT NULL DEFAULT '',
    secondary_phone VARCHAR(50) NOT NULL DEFAULT '',
    email VARCHAR(160) NOT NULL DEFAULT '',
    country VARCHAR(100) NOT NULL DEFAULT 'France',
    registration_number VARCHAR(100) NOT NULL DEFAULT '',
    siren VARCHAR(20) NOT NULL DEFAULT '',
    tax_number VARCHAR(100) NOT NULL DEFAULT '',
    vat_regime VARCHAR(20) NOT NULL DEFAULT 'standard' CHECK (vat_regime IN ('standard','franchise')),
    bank_iban VARCHAR(80) NOT NULL DEFAULT '',
    bank_bic VARCHAR(40) NOT NULL DEFAULT '',
    payment_terms VARCHAR(500) NOT NULL DEFAULT '',
    deposit_terms VARCHAR(500) NOT NULL DEFAULT '',
    early_payment_discount_terms VARCHAR(500) NOT NULL DEFAULT 'Aucun escompte pour paiement anticipé.',
    late_payment_penalty_terms VARCHAR(1000) NOT NULL DEFAULT 'Pénalités de retard exigibles au taux de trois fois le taux d’intérêt légal à compter du jour suivant la date d’échéance.',
    recovery_indemnity_cents INTEGER NOT NULL DEFAULT 4000 CHECK (recovery_indemnity_cents >= 0),
    vat_on_debits BOOLEAN NOT NULL DEFAULT FALSE,
    footer_note VARCHAR(1000) NOT NULL DEFAULT '',
    default_quote JSONB,
    quote_template_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    quote_template_mode VARCHAR(20) NOT NULL DEFAULT 'integrated',
    quote_template_filename VARCHAR(255) NOT NULL DEFAULT '',
    quote_template_data BYTEA,
    quote_template_mime_type VARCHAR(150) NOT NULL DEFAULT '',
    quitus_template_mode VARCHAR(20) NOT NULL DEFAULT 'integrated',
    quitus_template JSONB NOT NULL DEFAULT '{}'::jsonb,
    quitus_template_filename VARCHAR(255) NOT NULL DEFAULT '',
    quitus_template_data BYTEA,
    quitus_template_mime_type VARCHAR(150) NOT NULL DEFAULT '',
    report_file_template_mode VARCHAR(20) NOT NULL DEFAULT 'integrated',
    report_file_template_filename VARCHAR(255) NOT NULL DEFAULT '',
    report_file_template_data BYTEA,
    report_file_template_mime_type VARCHAR(150) NOT NULL DEFAULT '',
    report_template JSONB NOT NULL DEFAULT '{}'::jsonb,
    report_secondary_logo_data BYTEA,
    report_secondary_logo_mime_type VARCHAR(50) NOT NULL DEFAULT '',
    logo_data BYTEA,
    logo_mime_type VARCHAR(50) NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE depannhome_billing_profiles
    ADD COLUMN IF NOT EXISTS default_quote JSONB,
    ADD COLUMN IF NOT EXISTS quote_template_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS secondary_phone VARCHAR(50) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS country VARCHAR(100) NOT NULL DEFAULT 'France',
    ADD COLUMN IF NOT EXISTS deposit_terms VARCHAR(500) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS siren VARCHAR(20) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS vat_regime VARCHAR(20) NOT NULL DEFAULT 'standard',
    ADD COLUMN IF NOT EXISTS bank_iban VARCHAR(80) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS bank_bic VARCHAR(40) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS early_payment_discount_terms VARCHAR(500) NOT NULL DEFAULT 'Aucun escompte pour paiement anticipé.',
    ADD COLUMN IF NOT EXISTS late_payment_penalty_terms VARCHAR(1000) NOT NULL DEFAULT 'Pénalités de retard exigibles au taux de trois fois le taux d’intérêt légal à compter du jour suivant la date d’échéance.',
    ADD COLUMN IF NOT EXISTS recovery_indemnity_cents INTEGER NOT NULL DEFAULT 4000,
    ADD COLUMN IF NOT EXISTS vat_on_debits BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS quote_template_mode VARCHAR(20) NOT NULL DEFAULT 'integrated',
    ADD COLUMN IF NOT EXISTS quote_template_filename VARCHAR(255) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS quote_template_data BYTEA,
    ADD COLUMN IF NOT EXISTS quote_template_mime_type VARCHAR(150) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS quitus_template_mode VARCHAR(20) NOT NULL DEFAULT 'integrated',
    ADD COLUMN IF NOT EXISTS quitus_template JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS quitus_template_filename VARCHAR(255) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS quitus_template_data BYTEA,
    ADD COLUMN IF NOT EXISTS quitus_template_mime_type VARCHAR(150) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS report_file_template_mode VARCHAR(20) NOT NULL DEFAULT 'integrated',
    ADD COLUMN IF NOT EXISTS report_file_template_filename VARCHAR(255) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS report_file_template_data BYTEA,
    ADD COLUMN IF NOT EXISTS report_file_template_mime_type VARCHAR(150) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS report_template JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS report_secondary_logo_data BYTEA,
    ADD COLUMN IF NOT EXISTS report_secondary_logo_mime_type VARCHAR(50) NOT NULL DEFAULT '';

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

-- Modèles personnalisés versionnés. Une seule version peut être active par
-- entreprise et type de document ; les anciens fichiers restent conservés.
CREATE TABLE IF NOT EXISTS depannhome_document_templates (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    document_type VARCHAR(20) NOT NULL CHECK (document_type IN ('quote','invoice','quitus','report')),
    version INTEGER NOT NULL CHECK (version > 0),
    status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
    name VARCHAR(160) NOT NULL DEFAULT '',
    source_filename VARCHAR(255) NOT NULL DEFAULT '',
    source_mime_type VARCHAR(100) NOT NULL DEFAULT '',
    source_data BYTEA NOT NULL,
    source_hash VARCHAR(64) NOT NULL,
    definition JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    activated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(owner_id, document_type, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS depannhome_document_templates_active_idx
    ON depannhome_document_templates(owner_id, document_type) WHERE status='active';
CREATE INDEX IF NOT EXISTS depannhome_document_templates_owner_idx
    ON depannhome_document_templates(owner_id, document_type, version DESC);

CREATE INDEX IF NOT EXISTS depannhome_billing_templates_owner_idx
    ON depannhome_billing_templates (owner_id, LOWER(label));

CREATE TABLE IF NOT EXISTS depannhome_billing_documents (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    created_by_name VARCHAR(160) NOT NULL DEFAULT '',
    document_type VARCHAR(10) NOT NULL CHECK (document_type IN ('quote', 'invoice')),
    document_number VARCHAR(80) NOT NULL,
    client_id VARCHAR(100),
    customer_type VARCHAR(30) NOT NULL DEFAULT 'Particulier',
    customer_name VARCHAR(160) NOT NULL DEFAULT '',
    customer_address VARCHAR(500) NOT NULL DEFAULT '',
    issue_date DATE NOT NULL,
    due_date DATE,
    status VARCHAR(30) NOT NULL DEFAULT 'draft',
    is_email_sent BOOLEAN NOT NULL DEFAULT FALSE,
    sent_at TIMESTAMPTZ,
    is_accounted BOOLEAN NOT NULL DEFAULT FALSE,
    accounted_at DATE,
    appointment_id BIGINT,
    source_quote_id BIGINT,
    correction_source_id BIGINT,
    correction_kind VARCHAR(20) NOT NULL DEFAULT 'none' CHECK (correction_kind IN ('none', 'replacement', 'amendment')),
    quote_reference VARCHAR(80) NOT NULL DEFAULT '',
    vat_regime VARCHAR(20) NOT NULL DEFAULT 'standard' CHECK (vat_regime IN ('standard','franchise')),
    issuer_tax_number VARCHAR(100) NOT NULL DEFAULT '',
    legal_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    issued_at TIMESTAMPTZ,
    finalized_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    legal_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    structured_data BYTEA,
    structured_mime_type VARCHAR(150) NOT NULL DEFAULT '',
    structured_sha256 CHAR(64),
    pdf_data BYTEA,
    pdf_sha256 VARCHAR(64),
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
    ADD COLUMN IF NOT EXISTS created_by_name VARCHAR(160) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS client_id VARCHAR(100),
    ADD COLUMN IF NOT EXISTS appointment_id BIGINT,
    ADD COLUMN IF NOT EXISTS source_quote_id BIGINT,
    ADD COLUMN IF NOT EXISTS is_email_sent BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS correction_source_id BIGINT,
    ADD COLUMN IF NOT EXISTS correction_kind VARCHAR(20) NOT NULL DEFAULT 'none',
    ADD COLUMN IF NOT EXISTS quote_reference VARCHAR(80) NOT NULL DEFAULT '';
ALTER TABLE depannhome_billing_documents
    ADD COLUMN IF NOT EXISTS vat_regime VARCHAR(20) NOT NULL DEFAULT 'standard',
    ADD COLUMN IF NOT EXISTS issuer_tax_number VARCHAR(100) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS legal_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS issued_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS finalized_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS legal_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS structured_data BYTEA,
    ADD COLUMN IF NOT EXISTS structured_mime_type VARCHAR(150) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS structured_sha256 CHAR(64),
    ADD COLUMN IF NOT EXISTS pdf_data BYTEA,
    ADD COLUMN IF NOT EXISTS pdf_sha256 VARCHAR(64);

CREATE INDEX IF NOT EXISTS depannhome_billing_documents_accounting_idx
    ON depannhome_billing_documents (owner_id, document_type, is_accounted, issue_date DESC);

CREATE INDEX IF NOT EXISTS depannhome_billing_documents_appointment_idx
    ON depannhome_billing_documents (owner_id, appointment_id);

CREATE INDEX IF NOT EXISTS depannhome_billing_documents_client_idx
    ON depannhome_billing_documents (owner_id, client_id);

CREATE INDEX IF NOT EXISTS depannhome_billing_documents_correction_idx
    ON depannhome_billing_documents (owner_id, correction_source_id);

UPDATE depannhome_billing_documents document
SET created_by_name = COALESCE(NULLIF(creator.full_name, ''), creator.username, '')
FROM depannhome_users creator
WHERE document.created_by = creator.id AND document.created_by_name = '';

-- Comptabilité et facturation électronique compatible PDP : préparation et transmission via le connecteur choisi par l'entreprise, données isolées par owner_id.
ALTER TABLE depannhome_billing_documents ADD COLUMN IF NOT EXISTS financial_data JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE depannhome_billing_documents DROP CONSTRAINT IF EXISTS depannhome_billing_documents_document_type_check;
ALTER TABLE depannhome_billing_documents ADD CONSTRAINT depannhome_billing_documents_document_type_check CHECK (document_type IN ('quote', 'invoice', 'credit'));

CREATE TABLE IF NOT EXISTS depannhome_billing_sequences (
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    series_type VARCHAR(10) NOT NULL CHECK (series_type IN ('invoice','credit')),
    series_year INTEGER NOT NULL CHECK (series_year >= 2000),
    last_number BIGINT NOT NULL DEFAULT 0 CHECK (last_number >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, series_type, series_year)
);

CREATE OR REPLACE FUNCTION depannhome_protect_issued_billing_document() RETURNS trigger AS $$
BEGIN
    IF TG_OP='DELETE' AND OLD.issued_at IS NOT NULL THEN RAISE EXCEPTION 'Un document émis ne peut pas être supprimé.'; END IF;
    IF TG_OP='UPDATE' AND OLD.issued_at IS NOT NULL AND ROW(NEW.owner_id,NEW.created_by,NEW.created_by_name,NEW.document_type,NEW.document_number,NEW.client_id,NEW.customer_type,NEW.customer_name,NEW.customer_address,NEW.issue_date,NEW.due_date,NEW.appointment_id,NEW.source_quote_id,NEW.correction_source_id,NEW.correction_kind,NEW.quote_reference,NEW.vat_regime,NEW.issuer_tax_number,NEW.legal_data,NEW.issued_at,NEW.finalized_by,NEW.legal_snapshot,NEW.structured_data,NEW.structured_mime_type,NEW.structured_sha256,NEW.pdf_data,NEW.pdf_sha256,NEW.lines,NEW.notes,NEW.financial_data,NEW.created_at)
        IS DISTINCT FROM ROW(OLD.owner_id,OLD.created_by,OLD.created_by_name,OLD.document_type,OLD.document_number,OLD.client_id,OLD.customer_type,OLD.customer_name,OLD.customer_address,OLD.issue_date,OLD.due_date,OLD.appointment_id,OLD.source_quote_id,OLD.correction_source_id,OLD.correction_kind,OLD.quote_reference,OLD.vat_regime,OLD.issuer_tax_number,OLD.legal_data,OLD.issued_at,OLD.finalized_by,OLD.legal_snapshot,OLD.structured_data,OLD.structured_mime_type,OLD.structured_sha256,OLD.pdf_data,OLD.pdf_sha256,OLD.lines,OLD.notes,OLD.financial_data,OLD.created_at)
    THEN RAISE EXCEPTION 'Les données légales d’un document émis sont immuables.'; END IF;
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS depannhome_billing_document_immutable ON depannhome_billing_documents;
CREATE TRIGGER depannhome_billing_document_immutable BEFORE UPDATE OR DELETE ON depannhome_billing_documents FOR EACH ROW EXECUTE FUNCTION depannhome_protect_issued_billing_document();

CREATE TABLE IF NOT EXISTS depannhome_accounting_aids (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    name VARCHAR(160) NOT NULL, description VARCHAR(1000) NOT NULL DEFAULT '', aid_type VARCHAR(40) NOT NULL DEFAULT 'custom',
    calculation_mode VARCHAR(20) NOT NULL DEFAULT 'fixed', amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    auto_apply BOOLEAN NOT NULL DEFAULT FALSE, rules JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_accounting_aids_owner_idx ON depannhome_accounting_aids (owner_id, auto_apply, LOWER(name));
UPDATE depannhome_accounting_aids SET auto_apply=FALSE WHERE auto_apply=TRUE;

CREATE TABLE IF NOT EXISTS depannhome_accounting_settlements (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    document_id BIGINT NOT NULL REFERENCES depannhome_billing_documents(id) ON DELETE RESTRICT, settlement_date DATE NOT NULL,
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0), method VARCHAR(40) NOT NULL DEFAULT 'Virement',
    reference VARCHAR(160) NOT NULL DEFAULT '', notes VARCHAR(1000) NOT NULL DEFAULT '',
    created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_accounting_settlements_owner_document_idx ON depannhome_accounting_settlements (owner_id, document_id, settlement_date DESC);
ALTER TABLE depannhome_accounting_settlements DROP CONSTRAINT IF EXISTS depannhome_accounting_settlements_document_id_fkey;
ALTER TABLE depannhome_accounting_settlements ADD CONSTRAINT depannhome_accounting_settlements_document_id_fkey FOREIGN KEY(document_id) REFERENCES depannhome_billing_documents(id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS depannhome_accounting_settings (
    owner_id BIGINT PRIMARY KEY REFERENCES depannhome_users(id) ON DELETE CASCADE,
    chart_config JSONB NOT NULL DEFAULT '{}'::jsonb, aid_engine_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    pdp_provider VARCHAR(60) NOT NULL DEFAULT '', pdp_platform_name VARCHAR(160) NOT NULL DEFAULT '',
    pdp_api_url VARCHAR(1000) NOT NULL DEFAULT '', pdp_identifier VARCHAR(160) NOT NULL DEFAULT '',
    pdp_api_secret TEXT NOT NULL DEFAULT '', pdp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    journal_config JSONB NOT NULL DEFAULT '{}'::jsonb, fec_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE depannhome_accounting_settings ADD COLUMN IF NOT EXISTS journal_config JSONB NOT NULL DEFAULT '{}'::jsonb, ADD COLUMN IF NOT EXISTS fec_config JSONB NOT NULL DEFAULT '{}'::jsonb, ADD COLUMN IF NOT EXISTS pdp_platform_name VARCHAR(160) NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS pdp_api_url VARCHAR(1000) NOT NULL DEFAULT '';
ALTER TABLE depannhome_accounting_settings ALTER COLUMN pdp_provider SET DEFAULT '';
UPDATE depannhome_accounting_settings SET pdp_provider='',pdp_enabled=FALSE,pdp_api_secret='' WHERE pdp_provider='sandbox';
DROP TABLE IF EXISTS depannhome_accounting_sandbox_sessions;

-- Grand livre persistant : les pièces métier restent les sources uniques ; les
-- écritures validées en sont des instantanés numérotés, isolés par owner_id.
CREATE TABLE IF NOT EXISTS depannhome_accounting_journals (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    journal_type VARCHAR(30) NOT NULL CHECK(journal_type IN ('sales','bank','general','purchase')),
    code VARCHAR(10) NOT NULL, label VARCHAR(100) NOT NULL, description VARCHAR(300) NOT NULL DEFAULT '',
    is_active BOOLEAN NOT NULL DEFAULT TRUE, next_sequence BIGINT NOT NULL DEFAULT 1 CHECK(next_sequence>0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(owner_id,journal_type), UNIQUE(owner_id,code), UNIQUE(owner_id,id)
);
CREATE TABLE IF NOT EXISTS depannhome_accounting_entries (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    journal_id BIGINT NOT NULL, journal_code VARCHAR(10) NOT NULL, journal_label VARCHAR(100) NOT NULL,
    entry_number VARCHAR(80) NOT NULL, entry_date DATE NOT NULL, piece_reference VARCHAR(160) NOT NULL,
    piece_date DATE NOT NULL, description VARCHAR(300) NOT NULL, source_type VARCHAR(30) NOT NULL,
    source_id VARCHAR(120) NOT NULL, client_id VARCHAR(100) NOT NULL DEFAULT '', appointment_id BIGINT,
    status VARCHAR(20) NOT NULL DEFAULT 'validated' CHECK(status='validated'), validated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY(owner_id,journal_id) REFERENCES depannhome_accounting_journals(owner_id,id) ON DELETE RESTRICT,
    UNIQUE(owner_id,entry_number), UNIQUE(owner_id,source_type,source_id), UNIQUE(owner_id,id)
);
CREATE INDEX IF NOT EXISTS depannhome_accounting_entries_owner_date_idx ON depannhome_accounting_entries(owner_id,entry_date,validated_at,id);
CREATE INDEX IF NOT EXISTS depannhome_accounting_entries_client_idx ON depannhome_accounting_entries(owner_id,client_id,entry_date DESC);
CREATE TABLE IF NOT EXISTS depannhome_accounting_entry_lines (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    entry_id BIGINT NOT NULL, line_number INTEGER NOT NULL CHECK(line_number>0), account_number VARCHAR(20) NOT NULL CHECK(account_number ~ '^[0-9]{3,20}$'),
    account_label VARCHAR(160) NOT NULL, auxiliary_number VARCHAR(40) NOT NULL DEFAULT '', auxiliary_label VARCHAR(160) NOT NULL DEFAULT '',
    debit NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK(debit>=0), credit NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK(credit>=0),
    lettering VARCHAR(40) NOT NULL DEFAULT '', lettering_date DATE, currency_amount NUMERIC(14,2), currency_code VARCHAR(3) NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), FOREIGN KEY(owner_id,entry_id) REFERENCES depannhome_accounting_entries(owner_id,id) ON DELETE RESTRICT,
    UNIQUE(owner_id,entry_id,line_number), CHECK((debit>0 AND credit=0) OR (credit>0 AND debit=0)), CHECK(lettering_date IS NULL OR lettering<>'')
);
CREATE INDEX IF NOT EXISTS depannhome_accounting_entry_lines_account_idx ON depannhome_accounting_entry_lines(owner_id,account_number,entry_id);
CREATE TABLE IF NOT EXISTS depannhome_accounting_allocations (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    settlement_id BIGINT NOT NULL REFERENCES depannhome_accounting_settlements(id) ON DELETE RESTRICT,
    document_id BIGINT NOT NULL REFERENCES depannhome_billing_documents(id) ON DELETE RESTRICT,
    amount NUMERIC(14,2) NOT NULL CHECK(amount>0), lettering VARCHAR(40) NOT NULL DEFAULT '', lettering_date DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(owner_id,settlement_id), CHECK(lettering_date IS NULL OR lettering<>'')
);
CREATE TABLE IF NOT EXISTS depannhome_accounting_audit (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    actor_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL, action VARCHAR(80) NOT NULL,
    target_type VARCHAR(40) NOT NULL, target_id VARCHAR(120) NOT NULL, details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_accounting_audit_owner_created_idx ON depannhome_accounting_audit(owner_id,created_at DESC);
CREATE TABLE IF NOT EXISTS depannhome_accounting_exports (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    actor_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL, export_type VARCHAR(20) NOT NULL CHECK(export_type IN ('csv','xlsx','fec')),
    period_start DATE, period_end DATE, entry_count INTEGER NOT NULL DEFAULT 0, line_count INTEGER NOT NULL DEFAULT 0,
    validation_summary JSONB NOT NULL DEFAULT '{}'::jsonb, file_hash VARCHAR(64) NOT NULL, filename VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_accounting_exports_owner_created_idx ON depannhome_accounting_exports(owner_id,created_at DESC);

CREATE TABLE IF NOT EXISTS depannhome_einvoice_transmissions (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    document_id BIGINT NOT NULL REFERENCES depannhome_billing_documents(id) ON DELETE CASCADE, provider VARCHAR(160) NOT NULL,
    remote_id VARCHAR(160) NOT NULL DEFAULT '', status VARCHAR(30) NOT NULL DEFAULT 'draft', message VARCHAR(1000) NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0, last_attempt_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE depannhome_einvoice_transmissions ALTER COLUMN provider TYPE VARCHAR(160);
CREATE INDEX IF NOT EXISTS depannhome_einvoice_transmissions_owner_idx ON depannhome_einvoice_transmissions (owner_id, status, updated_at DESC);
DELETE FROM depannhome_einvoice_transmissions WHERE provider='sandbox' OR remote_id LIKE 'sandbox-%';

-- Catalogue Créateur des projets d'intégration. Ces fiches documentaires ne
-- rendent jamais une plateforme opérationnelle sans adaptateur serveur enregistré.
CREATE TABLE IF NOT EXISTS depannhome_einvoice_platform_catalog (
    id BIGSERIAL PRIMARY KEY, platform_code VARCHAR(60) NOT NULL UNIQUE, platform_label VARCHAR(160) NOT NULL,
    documentation_url VARCHAR(1000) NOT NULL DEFAULT '', authentication_type VARCHAR(40) NOT NULL DEFAULT 'provider_specific',
    lifecycle_status VARCHAR(40) NOT NULL DEFAULT 'documentation_required' CHECK(lifecycle_status IN ('documentation_required','specification_review','development','validation','deployed','suspended')),
    planned_capabilities JSONB NOT NULL DEFAULT '{}'::jsonb, notes VARCHAR(4000) NOT NULL DEFAULT '',
    created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL, updated_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_einvoice_platform_catalog_status_idx ON depannhome_einvoice_platform_catalog(lifecycle_status,platform_label);

-- Connexions de facturation électronique propres à chaque entreprise. Une
-- connexion conserve son fournisseur historique même lorsqu'elle est désactivée.
CREATE TABLE IF NOT EXISTS depannhome_einvoice_connections (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    platform_code VARCHAR(60) NOT NULL, platform_label VARCHAR(160) NOT NULL,
    environment VARCHAR(20) NOT NULL DEFAULT 'production' CHECK(environment IN ('sandbox','production')),
    status VARCHAR(30) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','connected','invalid','expired','disconnected','action_required')),
    active BOOLEAN NOT NULL DEFAULT FALSE, encrypted_credentials TEXT NOT NULL DEFAULT '',
    connection_metadata JSONB NOT NULL DEFAULT '{}'::jsonb, external_account_id VARCHAR(200) NOT NULL DEFAULT '',
    external_account_label VARCHAR(200) NOT NULL DEFAULT '', token_expires_at TIMESTAMPTZ,
    refresh_metadata JSONB NOT NULL DEFAULT '{}'::jsonb, webhook_token_hash CHAR(64),
    last_connected_at TIMESTAMPTZ, last_checked_at TIMESTAMPTZ, disconnected_at TIMESTAMPTZ,
    created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_einvoice_connections_owner_idx ON depannhome_einvoice_connections(owner_id,updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS depannhome_einvoice_connections_owner_active_unique ON depannhome_einvoice_connections(owner_id) WHERE active=TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS depannhome_einvoice_connections_webhook_unique ON depannhome_einvoice_connections(webhook_token_hash) WHERE webhook_token_hash IS NOT NULL;

-- Identifiants des deux entreprises fictives du test officiel SUPER PDP.
-- Ce coffre est réservé au Créateur et totalement distinct des connexions OAuth des entreprises clientes.
CREATE TABLE IF NOT EXISTS depannhome_creator_super_pdp_sandbox (
    creator_id BIGINT PRIMARY KEY REFERENCES depannhome_users(id) ON DELETE CASCADE,
    encrypted_credentials TEXT NOT NULL,
    test_status VARCHAR(20) NOT NULL DEFAULT 'configured' CHECK(test_status IN ('configured','running','passed','failed')),
    last_test_result JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_tested_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Connexion SUPER PDP propre à la plateforme Depann'Home Pro. Elle ne dépend
-- d'aucun compte entreprise, même lorsque l'utilisateur possède aussi un rôle administrateur.
CREATE TABLE IF NOT EXISTS depannhome_creator_super_pdp_connection (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(id), platform_code VARCHAR(60) NOT NULL DEFAULT 'super_pdp', platform_label VARCHAR(160) NOT NULL DEFAULT 'SUPER PDP',
    environment VARCHAR(20) NOT NULL DEFAULT 'production' CHECK(environment IN ('sandbox','production')),
    status VARCHAR(30) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','connected','invalid','expired','disconnected','action_required')),
    encrypted_credentials TEXT NOT NULL DEFAULT '', connection_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    external_account_id VARCHAR(200) NOT NULL DEFAULT '', external_account_label VARCHAR(200) NOT NULL DEFAULT '', token_expires_at TIMESTAMPTZ,
    refresh_metadata JSONB NOT NULL DEFAULT '{}'::jsonb, last_connected_at TIMESTAMPTZ, last_checked_at TIMESTAMPTZ, disconnected_at TIMESTAMPTZ,
    created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS depannhome_creator_super_pdp_oauth_states (
    id BIGSERIAL PRIMARY KEY, created_by BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    state_hash CHAR(64) NOT NULL UNIQUE, encrypted_context TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_creator_super_pdp_oauth_states_creator_idx ON depannhome_creator_super_pdp_oauth_states(created_by,expires_at);
-- Les états OAuth sont opaques, temporaires, liés à l'entreprise et à
-- l'administrateur initiateur. DELETE ... RETURNING garantit leur usage unique.
CREATE TABLE IF NOT EXISTS depannhome_einvoice_oauth_states (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    created_by BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    platform_code VARCHAR(60) NOT NULL, state_hash CHAR(64) NOT NULL UNIQUE,
    encrypted_context TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_einvoice_oauth_states_owner_idx ON depannhome_einvoice_oauth_states(owner_id,platform_code,expires_at);
DELETE FROM depannhome_einvoice_oauth_states WHERE expires_at<=NOW();
ALTER TABLE depannhome_einvoice_transmissions
    ADD COLUMN IF NOT EXISTS connection_id BIGINT REFERENCES depannhome_einvoice_connections(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS platform_code VARCHAR(60) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS document_type VARCHAR(20) NOT NULL DEFAULT 'invoice',
    ADD COLUMN IF NOT EXISTS external_status VARCHAR(80) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS transmitted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS status_checked_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS depannhome_einvoice_transmissions_owner_document_idx ON depannhome_einvoice_transmissions(owner_id,document_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS depannhome_einvoice_transmissions_external_idx ON depannhome_einvoice_transmissions(platform_code,remote_id) WHERE remote_id<>'';
CREATE TABLE IF NOT EXISTS depannhome_einvoice_events (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    connection_id BIGINT REFERENCES depannhome_einvoice_connections(id) ON DELETE SET NULL,
    transmission_id BIGINT REFERENCES depannhome_einvoice_transmissions(id) ON DELETE SET NULL,
    actor_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL, event_type VARCHAR(60) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT '', message VARCHAR(1000) NOT NULL DEFAULT '',
    details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_einvoice_events_owner_idx ON depannhome_einvoice_events(owner_id,created_at DESC);

-- L'ancien transport UBL universel n'est pas considéré comme une intégration.
-- Ses données sont conservées une seule fois pour permettre une reconnexion.
INSERT INTO depannhome_einvoice_connections(owner_id,platform_code,platform_label,environment,status,active,encrypted_credentials,connection_metadata,external_account_id)
SELECT settings.owner_id,'legacy_ubl_api',COALESCE(NULLIF(settings.pdp_platform_name,''),'Ancienne configuration UBL'),'production','action_required',FALSE,
       settings.pdp_api_secret,jsonb_build_object('legacyApiUrl',settings.pdp_api_url,'migration','depannhome_accounting_settings'),settings.pdp_identifier
FROM depannhome_accounting_settings settings
WHERE (settings.pdp_platform_name<>'' OR settings.pdp_api_url<>'' OR settings.pdp_identifier<>'' OR settings.pdp_api_secret<>'')
  AND NOT EXISTS (SELECT 1 FROM depannhome_einvoice_connections connection WHERE connection.owner_id=settings.owner_id AND connection.platform_code='legacy_ubl_api');
UPDATE depannhome_accounting_settings settings SET pdp_provider='',pdp_platform_name='',pdp_api_url='',pdp_identifier='',pdp_api_secret='',pdp_enabled=FALSE
WHERE EXISTS (SELECT 1 FROM depannhome_einvoice_connections connection WHERE connection.owner_id=settings.owner_id AND connection.platform_code='legacy_ubl_api');

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
    vat_regime VARCHAR(20) NOT NULL DEFAULT 'standard' CHECK (vat_regime IN ('standard','franchise')),
    bank_iban VARCHAR(34) NOT NULL DEFAULT '',
    bank_bic VARCHAR(11) NOT NULL DEFAULT '',
    vat_rate NUMERIC(5,2) NOT NULL DEFAULT 20 CHECK (vat_rate >= 0 AND vat_rate <= 100),
    payment_terms VARCHAR(500) NOT NULL DEFAULT '',
    footer_note VARCHAR(1000) NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE depannhome_subscription_billing_profile
    ADD COLUMN IF NOT EXISTS vat_regime VARCHAR(20) NOT NULL DEFAULT 'standard';

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
    net_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (net_amount_cents >= 0),
    vat_rate NUMERIC(5,2) NOT NULL CHECK (vat_rate >= 0 AND vat_rate <= 100),
    lines JSONB NOT NULL DEFAULT '[]'::jsonb,
    financial_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    subscription_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    invoice_kind VARCHAR(30) NOT NULL DEFAULT 'cycle' CHECK (invoice_kind IN ('cycle','proration_debit')),
    proration_context JSONB NOT NULL DEFAULT '{}'::jsonb,
    issue_date DATE NOT NULL,
    due_date DATE NOT NULL,
    issuer_profile JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
    sent_at TIMESTAMPTZ,
    last_error VARCHAR(1000) NOT NULL DEFAULT '',
    payment_status VARCHAR(20) NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'paid')),
    paid_date DATE,
    paid_at TIMESTAMPTZ,
    paid_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    paid_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (paid_amount_cents >= 0),
    payment_reference VARCHAR(160) NOT NULL DEFAULT '',
    receipt_delivery_status VARCHAR(20) NOT NULL DEFAULT 'not_sent' CHECK (receipt_delivery_status IN ('not_sent', 'pending', 'sending', 'sent', 'failed')),
    receipt_sent_at TIMESTAMPTZ,
    receipt_last_error VARCHAR(1000) NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE depannhome_subscription_invoices ADD COLUMN IF NOT EXISTS subscription_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE depannhome_subscription_invoices ADD COLUMN IF NOT EXISTS invoice_kind VARCHAR(30) NOT NULL DEFAULT 'cycle';
ALTER TABLE depannhome_subscription_invoices ADD COLUMN IF NOT EXISTS proration_context JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE depannhome_subscription_invoices DROP CONSTRAINT IF EXISTS depannhome_subscription_invoices_kind_check;
ALTER TABLE depannhome_subscription_invoices ADD CONSTRAINT depannhome_subscription_invoices_kind_check CHECK (invoice_kind IN ('cycle','proration_debit'));
ALTER TABLE depannhome_subscription_invoices DROP CONSTRAINT IF EXISTS depannhome_subscription_invoices_status_check;
ALTER TABLE depannhome_subscription_invoices ADD CONSTRAINT depannhome_subscription_invoices_status_check CHECK (status IN ('pending','sending','sent','failed','cancelled'));
ALTER TABLE depannhome_subscription_invoices DROP CONSTRAINT IF EXISTS depannhome_subscription_invoices_owner_period_unique;
DROP INDEX IF EXISTS depannhome_subscription_invoices_active_owner_period_idx;
CREATE UNIQUE INDEX depannhome_subscription_invoices_active_owner_period_idx ON depannhome_subscription_invoices(account_owner_id,billing_period) WHERE status<>'cancelled' AND invoice_kind='cycle';

CREATE INDEX IF NOT EXISTS depannhome_subscription_invoices_status_idx
    ON depannhome_subscription_invoices (status, created_at);

-- Une série annuelle transactionnelle garantit des numéros uniques, chronologiques et sans rupture.
-- Les anciennes factures conservent définitivement le numéro reçu lors de leur émission.
CREATE TABLE IF NOT EXISTS depannhome_subscription_invoice_sequences (
    series_year INTEGER PRIMARY KEY CHECK (series_year >= 2020),
    last_number BIGINT NOT NULL DEFAULT 0 CHECK (last_number >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO depannhome_subscription_invoice_sequences (series_year, last_number)
SELECT parts[1]::INTEGER, MAX(parts[2]::BIGINT)
FROM depannhome_subscription_invoices
CROSS JOIN LATERAL regexp_matches(invoice_number, '^DHP-([0-9]{4})-([0-9]{6})$') AS parsed(parts)
GROUP BY parts[1]
ON CONFLICT (series_year) DO UPDATE
SET last_number = GREATEST(depannhome_subscription_invoice_sequences.last_number, EXCLUDED.last_number),
    updated_at = NOW();

CREATE TABLE IF NOT EXISTS depannhome_subscription_invoice_audit (
    id BIGSERIAL PRIMARY KEY,
    invoice_id BIGINT NOT NULL REFERENCES depannhome_subscription_invoices(id) ON DELETE CASCADE,
    account_owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    actor_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    action VARCHAR(40) NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS depannhome_subscription_invoice_audit_invoice_idx
    ON depannhome_subscription_invoice_audit (invoice_id, created_at DESC);

ALTER TABLE depannhome_subscription_invoices ADD COLUMN IF NOT EXISTS paid_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (paid_amount_cents >= 0);
UPDATE depannhome_subscription_invoices SET paid_amount_cents=net_amount_cents WHERE payment_status='paid' AND paid_amount_cents=0;

CREATE TABLE IF NOT EXISTS depannhome_subscription_credit_note_sequences (
    series_year INTEGER PRIMARY KEY CHECK (series_year >= 2020), last_number BIGINT NOT NULL DEFAULT 0 CHECK (last_number >= 0), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS depannhome_subscription_credit_notes (
    id BIGSERIAL PRIMARY KEY,
    source_invoice_id BIGINT NOT NULL REFERENCES depannhome_subscription_invoices(id) ON DELETE RESTRICT,
    account_owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE RESTRICT,
    credit_number VARCHAR(80) NOT NULL UNIQUE, source_invoice_number VARCHAR(80) NOT NULL, source_invoice_date DATE NOT NULL, issue_date DATE NOT NULL,
    credit_kind VARCHAR(20) NOT NULL CHECK (credit_kind IN ('full','partial')), reason VARCHAR(1000) NOT NULL CHECK (CHAR_LENGTH(reason) >= 10),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0), tax_base_cents INTEGER NOT NULL CHECK (tax_base_cents >= 0),
    vat_amount_cents INTEGER NOT NULL CHECK (vat_amount_cents >= 0), vat_rate NUMERIC(5,2) NOT NULL CHECK (vat_rate >= 0 AND vat_rate <= 100),
    recipient_name VARCHAR(160) NOT NULL, recipient_email VARCHAR(160) NOT NULL, recipient_address VARCHAR(500) NOT NULL DEFAULT '',
    issuer_profile JSONB NOT NULL, lines JSONB NOT NULL DEFAULT '[]'::jsonb, financial_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    pdf_data BYTEA NOT NULL, pdf_sha256 CHAR(64) NOT NULL, created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    delivery_status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending','sending','sent','failed')),
    sent_at TIMESTAMPTZ, last_error VARCHAR(1000) NOT NULL DEFAULT '',
    refund_status VARCHAR(20) NOT NULL DEFAULT 'not_required' CHECK (refund_status IN ('not_required','pending','refunded')),
    refunded_date DATE, refunded_at TIMESTAMPTZ, refunded_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    refund_reference VARCHAR(160) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_subscription_credit_notes_invoice_idx ON depannhome_subscription_credit_notes(source_invoice_id,issue_date,id);
ALTER TABLE depannhome_subscription_credit_notes ADD COLUMN IF NOT EXISTS source_invoice_date DATE;
UPDATE depannhome_subscription_credit_notes credit SET source_invoice_date=invoice.issue_date FROM depannhome_subscription_invoices invoice WHERE credit.source_invoice_id=invoice.id AND credit.source_invoice_date IS NULL;
ALTER TABLE depannhome_subscription_credit_notes ALTER COLUMN source_invoice_date SET NOT NULL;
INSERT INTO depannhome_subscription_credit_note_sequences(series_year,last_number)
SELECT parts[1]::INTEGER,MAX(parts[2]::BIGINT) FROM depannhome_subscription_credit_notes
CROSS JOIN LATERAL regexp_matches(credit_number,'^AVO-DHP-([0-9]{4})-([0-9]{6})$') AS parsed(parts) GROUP BY parts[1]
ON CONFLICT(series_year) DO UPDATE SET last_number=GREATEST(depannhome_subscription_credit_note_sequences.last_number,EXCLUDED.last_number),updated_at=NOW();
CREATE TABLE IF NOT EXISTS depannhome_subscription_credit_note_audit (
    id BIGSERIAL PRIMARY KEY, credit_note_id BIGINT NOT NULL REFERENCES depannhome_subscription_credit_notes(id) ON DELETE RESTRICT,
    account_owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE RESTRICT, actor_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    action VARCHAR(50) NOT NULL, details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_subscription_credit_note_audit_credit_idx ON depannhome_subscription_credit_note_audit(credit_note_id,created_at DESC);
CREATE OR REPLACE FUNCTION depannhome_protect_subscription_credit_note() RETURNS trigger AS $$ BEGIN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Un avoir émis ne peut pas être supprimé.'; END IF;
     IF ROW(NEW.source_invoice_id,NEW.account_owner_id,NEW.credit_number,NEW.source_invoice_number,NEW.source_invoice_date,NEW.issue_date,NEW.credit_kind,NEW.reason,NEW.amount_cents,NEW.tax_base_cents,NEW.vat_amount_cents,NEW.vat_rate,NEW.recipient_name,NEW.recipient_email,NEW.recipient_address,NEW.issuer_profile,NEW.lines,NEW.financial_data,NEW.pdf_data,NEW.pdf_sha256,NEW.created_by,NEW.created_at)
         IS DISTINCT FROM ROW(OLD.source_invoice_id,OLD.account_owner_id,OLD.credit_number,OLD.source_invoice_number,OLD.source_invoice_date,OLD.issue_date,OLD.credit_kind,OLD.reason,OLD.amount_cents,OLD.tax_base_cents,OLD.vat_amount_cents,OLD.vat_rate,OLD.recipient_name,OLD.recipient_email,OLD.recipient_address,OLD.issuer_profile,OLD.lines,OLD.financial_data,OLD.pdf_data,OLD.pdf_sha256,OLD.created_by,OLD.created_at)
    THEN RAISE EXCEPTION 'Les données légales d’un avoir émis sont immuables.'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS depannhome_subscription_credit_note_immutable ON depannhome_subscription_credit_notes;
CREATE TRIGGER depannhome_subscription_credit_note_immutable BEFORE UPDATE OR DELETE ON depannhome_subscription_credit_notes FOR EACH ROW EXECUTE FUNCTION depannhome_protect_subscription_credit_note();

CREATE TABLE IF NOT EXISTS depannhome_subscription_proration_events (
    id BIGSERIAL PRIMARY KEY,
    account_owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE RESTRICT,
    change_fingerprint CHAR(64) NOT NULL UNIQUE,
    effective_date DATE NOT NULL,
    cycle_start_date DATE NOT NULL,
    cycle_end_date DATE NOT NULL,
    total_days INTEGER NOT NULL CHECK (total_days > 0),
    remaining_days INTEGER NOT NULL CHECK (remaining_days >= 0),
    old_net_amount_cents INTEGER NOT NULL CHECK (old_net_amount_cents >= 0),
    new_net_amount_cents INTEGER NOT NULL CHECK (new_net_amount_cents >= 0),
    prorata_delta_cents INTEGER NOT NULL,
    source_invoice_id BIGINT REFERENCES depannhome_subscription_invoices(id) ON DELETE RESTRICT,
    generated_invoice_id BIGINT REFERENCES depannhome_subscription_invoices(id) ON DELETE RESTRICT,
    generated_credit_note_id BIGINT REFERENCES depannhome_subscription_credit_notes(id) ON DELETE RESTRICT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','created','skipped')),
    actor_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_subscription_proration_events_owner_idx ON depannhome_subscription_proration_events(account_owner_id,effective_date DESC,id DESC);

-- Observabilité interne réservée au Créateur, sans corps de requête, secret,
-- coordonnée client ni donnée bancaire.
CREATE TABLE IF NOT EXISTS depannhome_health_incidents (
    id BIGSERIAL PRIMARY KEY, fingerprint CHAR(64) NOT NULL UNIQUE, module VARCHAR(60) NOT NULL,
    severity VARCHAR(20) NOT NULL CHECK(severity IN ('information','warning','important','critical')),
    error_type VARCHAR(100) NOT NULL DEFAULT '', route VARCHAR(240) NOT NULL DEFAULT '', technical_message VARCHAR(500) NOT NULL DEFAULT '',
    status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK(status IN ('open','monitoring','resolved')),
    occurrence_count INTEGER NOT NULL DEFAULT 1, affected_scope_hashes JSONB NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_array_length(affected_scope_hashes)<=100),
    deployment_version VARCHAR(120) NOT NULL DEFAULT '', first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ, resolution_note VARCHAR(1000) NOT NULL DEFAULT '', updated_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS depannhome_health_incidents_status_idx ON depannhome_health_incidents(status,severity,last_seen_at DESC);
CREATE TABLE IF NOT EXISTS depannhome_health_check_results (
    id BIGSERIAL PRIMARY KEY, check_key VARCHAR(100) NOT NULL, module VARCHAR(60) NOT NULL,
    status VARCHAR(20) NOT NULL CHECK(status IN ('pass','warning','fail','unavailable')),
    severity VARCHAR(20) NOT NULL CHECK(severity IN ('information','warning','important','critical')),
    message VARCHAR(500) NOT NULL DEFAULT '', latency_ms INTEGER, details JSONB NOT NULL DEFAULT '{}'::jsonb, checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_health_checks_key_time_idx ON depannhome_health_check_results(check_key,checked_at DESC);
CREATE TABLE IF NOT EXISTS depannhome_health_http_metrics (
    bucket_start TIMESTAMPTZ NOT NULL, module VARCHAR(60) NOT NULL, route VARCHAR(240) NOT NULL, method VARCHAR(10) NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 0, server_error_count INTEGER NOT NULL DEFAULT 0,
    duration_total_ms BIGINT NOT NULL DEFAULT 0, duration_max_ms INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(bucket_start,module,route,method)
);
CREATE INDEX IF NOT EXISTS depannhome_health_http_metrics_time_idx ON depannhome_health_http_metrics(bucket_start DESC);
CREATE TABLE IF NOT EXISTS depannhome_health_scheduler_runs (
    id BIGSERIAL PRIMARY KEY, scheduler_key VARCHAR(100) NOT NULL, source VARCHAR(30) NOT NULL DEFAULT 'scheduled',
    status VARCHAR(20) NOT NULL CHECK(status IN ('started','completed','failed','skipped')), duration_ms INTEGER,
    summary JSONB NOT NULL DEFAULT '{}'::jsonb, started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS depannhome_health_scheduler_runs_key_time_idx ON depannhome_health_scheduler_runs(scheduler_key,started_at DESC);
CREATE TABLE IF NOT EXISTS depannhome_health_deployments (
    id BIGSERIAL PRIMARY KEY, version VARCHAR(120) NOT NULL UNIQUE, commit_sha VARCHAR(80) NOT NULL DEFAULT '',
    environment VARCHAR(30) NOT NULL DEFAULT 'production', test_status VARCHAR(20) NOT NULL DEFAULT 'unknown' CHECK(test_status IN ('unknown','passed','failed')),
    tests_passed INTEGER NOT NULL DEFAULT 0, tests_failed INTEGER NOT NULL DEFAULT 0, deployed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
    client_id VARCHAR(100) NOT NULL,
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

DELETE FROM depannhome_messages
WHERE client_id IS NULL OR BTRIM(client_id) = '';

ALTER TABLE depannhome_messages
    ALTER COLUMN client_id SET NOT NULL;

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
    client_id VARCHAR(100) NOT NULL DEFAULT '',
    client_name VARCHAR(160) NOT NULL DEFAULT '',
    location VARCHAR(255) NOT NULL DEFAULT '',
    event_date DATE NOT NULL,
    start_time TIME,
    end_time TIME,
    color VARCHAR(20) NOT NULL DEFAULT 'blue',
    event_type VARCHAR(20) NOT NULL DEFAULT 'appointment',
    event_origin VARCHAR(30) NOT NULL DEFAULT 'standard',
    partner_connection_id BIGINT,
    partner_mission_id BIGINT,
    quitus_status VARCHAR(20) NOT NULL DEFAULT 'pending',
    quitus_signed_by VARCHAR(160) NOT NULL DEFAULT '',
    quitus_signature TEXT NOT NULL DEFAULT '',
    quitus_observations VARCHAR(2000) NOT NULL DEFAULT '',
    quitus_approved BOOLEAN NOT NULL DEFAULT FALSE,
    quitus_signed_at TIMESTAMPTZ,
    quitus_performed_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    quitus_performed_by_name VARCHAR(160) NOT NULL DEFAULT '',
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
    ADD COLUMN IF NOT EXISTS client_id VARCHAR(100) NOT NULL DEFAULT '';

ALTER TABLE depannhome_calendar_events
ADD COLUMN IF NOT EXISTS event_type VARCHAR(20) NOT NULL DEFAULT 'appointment';

ALTER TABLE depannhome_calendar_events
ADD COLUMN IF NOT EXISTS event_origin VARCHAR(30) NOT NULL DEFAULT 'standard',
ADD COLUMN IF NOT EXISTS partner_connection_id BIGINT,
ADD COLUMN IF NOT EXISTS partner_mission_id BIGINT;

UPDATE depannhome_calendar_events
SET event_origin = 'standard'
WHERE event_origin IS NULL OR event_origin NOT IN ('standard', 'partner_mission');

CREATE INDEX IF NOT EXISTS depannhome_calendar_events_partner_origin_idx
ON depannhome_calendar_events (owner_id, event_origin, partner_connection_id);

-- Types gérés par l’application : appointment, task, vacation, sick_leave, unavailable.

ALTER TABLE depannhome_calendar_events
ADD COLUMN IF NOT EXISTS quitus_status VARCHAR(20) NOT NULL DEFAULT 'pending',
ADD COLUMN IF NOT EXISTS quitus_signed_by VARCHAR(160) NOT NULL DEFAULT '',
ADD COLUMN IF NOT EXISTS quitus_signature TEXT NOT NULL DEFAULT '',
ADD COLUMN IF NOT EXISTS quitus_observations VARCHAR(2000) NOT NULL DEFAULT '',
ADD COLUMN IF NOT EXISTS quitus_approved BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS quitus_signed_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS quitus_performed_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS quitus_performed_by_name VARCHAR(160) NOT NULL DEFAULT '';

UPDATE depannhome_calendar_events event
SET quitus_performed_by = COALESCE(event.quitus_performed_by, event.assigned_technician_id),
    quitus_performed_by_name = COALESCE(NULLIF(event.quitus_performed_by_name, ''), NULLIF(member.full_name, ''), member.username, '')
FROM depannhome_users member
WHERE event.quitus_status = 'validated' AND event.assigned_technician_id = member.id
    AND event.quitus_performed_by_name = '';

CREATE OR REPLACE FUNCTION depannhome_protect_validated_quitus() RETURNS trigger AS $$
BEGIN
    IF OLD.quitus_signed_at IS NOT NULL AND ROW(NEW.quitus_status,NEW.quitus_signed_by,NEW.quitus_signature,NEW.quitus_observations,NEW.quitus_approved,NEW.quitus_signed_at,NEW.quitus_performed_by,NEW.quitus_performed_by_name)
        IS DISTINCT FROM ROW(OLD.quitus_status,OLD.quitus_signed_by,OLD.quitus_signature,OLD.quitus_observations,OLD.quitus_approved,OLD.quitus_signed_at,OLD.quitus_performed_by,OLD.quitus_performed_by_name)
    THEN RAISE EXCEPTION 'Un quitus validé est immuable.'; END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS depannhome_validated_quitus_immutable ON depannhome_calendar_events;
CREATE TRIGGER depannhome_validated_quitus_immutable BEFORE UPDATE ON depannhome_calendar_events FOR EACH ROW EXECUTE FUNCTION depannhome_protect_validated_quitus();

-- Un élément du planning peut réunir plusieurs membres. Les noms de colonnes
-- historiques restent conservés pour compatibilité, mais acceptent tout utilisateur actif de l’entreprise.
CREATE TABLE IF NOT EXISTS depannhome_calendar_assignments (
    event_id BIGINT NOT NULL REFERENCES depannhome_calendar_events(id) ON DELETE CASCADE,
    technician_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (event_id, technician_id)
);

CREATE INDEX IF NOT EXISTS depannhome_calendar_assignments_technician_idx
    ON depannhome_calendar_assignments (technician_id, event_id);

UPDATE depannhome_calendar_events event
SET assigned_technician_id = NULL
FROM depannhome_users member
WHERE member.id = event.assigned_technician_id
    AND member.account_owner_id <> event.owner_id;

DELETE FROM depannhome_calendar_assignments assignment
USING depannhome_calendar_events event, depannhome_users member
WHERE event.id = assignment.event_id AND member.id = assignment.technician_id
    AND member.account_owner_id <> event.owner_id;

INSERT INTO depannhome_calendar_assignments (event_id, technician_id, is_primary)
SELECT id, assigned_technician_id, TRUE
FROM depannhome_calendar_events
WHERE assigned_technician_id IS NOT NULL
ON CONFLICT (event_id, technician_id) DO NOTHING;

CREATE OR REPLACE FUNCTION depannhome_validate_calendar_event_assignment() RETURNS trigger AS $$
BEGIN
    IF NEW.assigned_technician_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM depannhome_users member
        WHERE member.id = NEW.assigned_technician_id AND member.account_owner_id = NEW.owner_id
            AND member.is_active = TRUE
    ) THEN
        RAISE EXCEPTION 'Le membre affecté doit être actif et rattaché à la même entreprise.' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS depannhome_calendar_event_assignment_company ON depannhome_calendar_events;
CREATE TRIGGER depannhome_calendar_event_assignment_company BEFORE INSERT OR UPDATE OF owner_id, assigned_technician_id ON depannhome_calendar_events FOR EACH ROW EXECUTE FUNCTION depannhome_validate_calendar_event_assignment();

CREATE OR REPLACE FUNCTION depannhome_validate_calendar_assignment_company() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM depannhome_calendar_events event
        JOIN depannhome_users member ON member.id = NEW.technician_id
        WHERE event.id = NEW.event_id AND member.account_owner_id = event.owner_id
            AND member.is_active = TRUE
    ) THEN
        RAISE EXCEPTION 'Le membre affecté doit être actif et rattaché à la même entreprise.' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS depannhome_calendar_assignment_company ON depannhome_calendar_assignments;
CREATE TRIGGER depannhome_calendar_assignment_company BEFORE INSERT OR UPDATE ON depannhome_calendar_assignments FOR EACH ROW EXECUTE FUNCTION depannhome_validate_calendar_assignment_company();

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
    created_by_name VARCHAR(160) NOT NULL DEFAULT '',
    appointment_id BIGINT REFERENCES depannhome_calendar_events(id) ON DELETE SET NULL,
    client_id VARCHAR(100) NOT NULL DEFAULT '', report_type VARCHAR(40) NOT NULL DEFAULT 'leak_detection',
    title VARCHAR(160) NOT NULL DEFAULT 'Rapport de recherche de fuite', report_date DATE NOT NULL DEFAULT CURRENT_DATE,
    content JSONB NOT NULL DEFAULT '{}'::jsonb, media JSONB NOT NULL DEFAULT '[]'::jsonb,
    status VARCHAR(30) NOT NULL DEFAULT 'draft', -- draft, submitted (terminé à corriger), in_correction, ready_to_send, validated
    submitted_at TIMESTAMPTZ, validated_at TIMESTAMPTZ,
    validated_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    proofread_at TIMESTAMPTZ, proofread_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    proofread_fingerprint VARCHAR(64) NOT NULL DEFAULT '',
    pdf_data BYTEA, pdf_filename VARCHAR(255) NOT NULL DEFAULT '', document_mime_type VARCHAR(150) NOT NULL DEFAULT 'application/pdf', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE depannhome_technical_reports ADD COLUMN IF NOT EXISTS created_by_name VARCHAR(160) NOT NULL DEFAULT '';
ALTER TABLE depannhome_technical_reports ADD COLUMN IF NOT EXISTS proofread_at TIMESTAMPTZ;
ALTER TABLE depannhome_technical_reports ADD COLUMN IF NOT EXISTS proofread_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL;
ALTER TABLE depannhome_technical_reports ADD COLUMN IF NOT EXISTS proofread_fingerprint VARCHAR(64) NOT NULL DEFAULT '';
ALTER TABLE depannhome_technical_reports ADD COLUMN IF NOT EXISTS document_mime_type VARCHAR(150) NOT NULL DEFAULT 'application/pdf';
UPDATE depannhome_technical_reports report
SET created_by_name=COALESCE(
    NULLIF(report.content->'snapshot'->>'technicianName',''),
    (SELECT COALESCE(NULLIF(creator.full_name,''),creator.username,'') FROM depannhome_users creator WHERE creator.id=report.created_by),
    ''
)
WHERE report.created_by_name='';
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
    rules JSONB NOT NULL DEFAULT '{}'::jsonb, enabled BOOLEAN NOT NULL DEFAULT TRUE, is_sandbox BOOLEAN NOT NULL DEFAULT FALSE,
    created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT depannhome_partner_intakes_owner_key_unique UNIQUE(owner_id, partner_key),
    CONSTRAINT depannhome_partner_intakes_api_key_unique UNIQUE(api_key_hash)
);
ALTER TABLE depannhome_partner_intakes ADD COLUMN IF NOT EXISTS is_sandbox BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS depannhome_partner_intakes_owner_sandbox_idx ON depannhome_partner_intakes(owner_id,is_sandbox,updated_at DESC);
CREATE TABLE IF NOT EXISTS depannhome_partner_missions (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    intake_id BIGINT NOT NULL REFERENCES depannhome_partner_intakes(id) ON DELETE RESTRICT, external_mission_id VARCHAR(160) NOT NULL,
    mission_number VARCHAR(32) NOT NULL DEFAULT '', source_mission_number VARCHAR(64) NOT NULL DEFAULT '', intervention_number VARCHAR(64) NOT NULL DEFAULT '', deleted_at TIMESTAMPTZ,
    partner_reference VARCHAR(160) NOT NULL DEFAULT '', status VARCHAR(30) NOT NULL DEFAULT 'received', priority VARCHAR(20) NOT NULL DEFAULT 'normal',
    billing_mode VARCHAR(30) NOT NULL DEFAULT 'direct_client' CHECK (billing_mode IN ('direct_client','principal')),
    planning_draft JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_data JSONB NOT NULL DEFAULT '{}'::jsonb, mapped_data JSONB NOT NULL DEFAULT '{}'::jsonb, validation_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
    client_id VARCHAR(100) NOT NULL DEFAULT '', calendar_event_id BIGINT REFERENCES depannhome_calendar_events(id) ON DELETE SET NULL,
    technical_report_id BIGINT REFERENCES depannhome_technical_reports(id) ON DELETE SET NULL, assigned_technician_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    scheduled_date DATE, scheduled_start_time TIME, scheduled_end_time TIME, retry_count INTEGER NOT NULL DEFAULT 0, next_retry_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT depannhome_partner_missions_unique UNIQUE(owner_id, intake_id, external_mission_id)
);
CREATE INDEX IF NOT EXISTS depannhome_partner_missions_owner_status_idx ON depannhome_partner_missions(owner_id, status, created_at DESC);
UPDATE depannhome_partner_missions mission
SET assigned_technician_id = NULL
FROM depannhome_users member
WHERE member.id = mission.assigned_technician_id
    AND (member.account_owner_id <> mission.owner_id OR member.role NOT IN ('mobile_admin','team_lead','technician'));
CREATE OR REPLACE FUNCTION depannhome_validate_partner_mission_assignment() RETURNS trigger AS $$
BEGIN
    IF NEW.assigned_technician_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM depannhome_users member
        WHERE member.id = NEW.assigned_technician_id AND member.account_owner_id = NEW.owner_id
            AND member.is_active = TRUE AND member.role IN ('mobile_admin','team_lead','technician')
    ) THEN
        RAISE EXCEPTION 'Le membre affecté à la mission doit être un poste mobile actif de la même entreprise.' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS depannhome_partner_mission_assignment_company ON depannhome_partner_missions;
CREATE TRIGGER depannhome_partner_mission_assignment_company BEFORE INSERT OR UPDATE OF owner_id, assigned_technician_id ON depannhome_partner_missions FOR EACH ROW EXECUTE FUNCTION depannhome_validate_partner_mission_assignment();
ALTER TABLE depannhome_partner_missions ADD COLUMN IF NOT EXISTS planning_draft JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE depannhome_partner_missions ADD COLUMN IF NOT EXISTS source_mission_number VARCHAR(64) NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS intervention_number VARCHAR(64) NOT NULL DEFAULT '';
UPDATE depannhome_partner_missions SET source_mission_number=CASE WHEN source_mission_number='' THEN mission_number ELSE source_mission_number END, intervention_number=CASE WHEN intervention_number='' THEN 'INT-' || TO_CHAR(created_at AT TIME ZONE 'Europe/Paris','YYYY') || '-' || LPAD(id::text,6,'0') ELSE intervention_number END WHERE source_mission_number='' OR intervention_number='';
CREATE UNIQUE INDEX IF NOT EXISTS depannhome_partner_missions_number_unique ON depannhome_partner_missions(mission_number) WHERE mission_number<>'';
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

-- Boîtes professionnelles rattachées à Missions partenaires. Les jetons OAuth
-- et mots de passe d'application sont chiffrés en AES-256-GCM côté serveur.
CREATE TABLE IF NOT EXISTS depannhome_partner_email_connections (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    provider VARCHAR(20) NOT NULL CHECK(provider IN ('google','microsoft','imap')), email_address VARCHAR(254) NOT NULL,
    display_name VARCHAR(160) NOT NULL DEFAULT '', encrypted_credentials TEXT NOT NULL,
    server_configuration JSONB NOT NULL DEFAULT '{}'::jsonb, selection_mode VARCHAR(20) NOT NULL DEFAULT 'manual' CHECK(selection_mode IN ('manual','automatic')),
    allowed_senders JSONB NOT NULL DEFAULT '[]'::jsonb, required_keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
    automatic_threshold INTEGER NOT NULL DEFAULT 80 CHECK(automatic_threshold BETWEEN 70 AND 100),
    send_status_updates BOOLEAN NOT NULL DEFAULT FALSE, auto_search_enabled BOOLEAN NOT NULL DEFAULT FALSE, enabled BOOLEAN NOT NULL DEFAULT TRUE,
    last_uid BIGINT NOT NULL DEFAULT 0, last_sync_at TIMESTAMPTZ, last_error VARCHAR(500) NOT NULL DEFAULT '',
    created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT depannhome_partner_email_owner_address_unique UNIQUE(owner_id,email_address)
);
ALTER TABLE depannhome_partner_email_connections ADD COLUMN IF NOT EXISTS required_keywords JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS depannhome_partner_email_connections_auto_search_idx ON depannhome_partner_email_connections(auto_search_enabled,enabled,last_sync_at);
CREATE TABLE IF NOT EXISTS depannhome_partner_email_messages (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    connection_id BIGINT NOT NULL REFERENCES depannhome_partner_email_connections(id) ON DELETE CASCADE,
    uid BIGINT NOT NULL, message_id VARCHAR(500) NOT NULL, in_reply_to VARCHAR(500) NOT NULL DEFAULT '', references_header TEXT NOT NULL DEFAULT '',
    sender_address VARCHAR(254) NOT NULL, sender_name VARCHAR(160) NOT NULL DEFAULT '', recipients JSONB NOT NULL DEFAULT '[]'::jsonb,
    subject VARCHAR(500) NOT NULL DEFAULT '', body_text TEXT NOT NULL DEFAULT '', received_at TIMESTAMPTZ NOT NULL,
    classification_score INTEGER NOT NULL DEFAULT 0, classification_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
    status VARCHAR(20) NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate','processing','imported','ignored','rejected')),
    mission_id BIGINT REFERENCES depannhome_partner_missions(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), processed_at TIMESTAMPTZ,
    CONSTRAINT depannhome_partner_email_message_unique UNIQUE(owner_id,connection_id,message_id)
);
CREATE INDEX IF NOT EXISTS depannhome_partner_email_messages_queue_idx ON depannhome_partner_email_messages(owner_id,status,received_at DESC);
CREATE TABLE IF NOT EXISTS depannhome_partner_email_attachments (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    email_message_id BIGINT NOT NULL REFERENCES depannhome_partner_email_messages(id) ON DELETE CASCADE,
    filename VARCHAR(255) NOT NULL, mime_type VARCHAR(150) NOT NULL, file_size INTEGER NOT NULL CHECK(file_size>0 AND file_size<=5242880),
    content_id VARCHAR(255) NOT NULL DEFAULT '', file_data BYTEA NOT NULL, selected BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS depannhome_partner_email_oauth_states (
    state_hash CHAR(64) PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    actor_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE, provider VARCHAR(20) NOT NULL,
    encrypted_context TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partenaire API fictif géré par le Créateur. Le secret d'appel est chiffré,
-- sa copie d'authentification reste hachée dans l'intake et les journaux sont expurgés.
CREATE TABLE IF NOT EXISTS depannhome_partner_api_sandboxes (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL UNIQUE REFERENCES depannhome_users(id) ON DELETE CASCADE,
    intake_id BIGINT NOT NULL UNIQUE REFERENCES depannhome_partner_intakes(id) ON DELETE CASCADE,
    api_key_cipher TEXT NOT NULL, callback_token_hash VARCHAR(64) NOT NULL UNIQUE,
    fault_mode VARCHAR(30) NOT NULL DEFAULT 'none', created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS depannhome_partner_api_sandbox_logs (
    id BIGSERIAL PRIMARY KEY, sandbox_id BIGINT NOT NULL REFERENCES depannhome_partner_api_sandboxes(id) ON DELETE CASCADE,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    direction VARCHAR(20) NOT NULL, method VARCHAR(12) NOT NULL DEFAULT 'POST', endpoint VARCHAR(1000) NOT NULL,
    http_status INTEGER, event_type VARCHAR(80) NOT NULL DEFAULT '', request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    response_payload JSONB NOT NULL DEFAULT '{}'::jsonb, error_message VARCHAR(1000) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_partner_api_sandbox_logs_owner_idx ON depannhome_partner_api_sandbox_logs(owner_id,created_at DESC);

-- Fil collaboratif strictement rattaché à une mission partenaire. Les fichiers
-- sont séparés des dossiers clients pour conserver les limites métier existantes.
CREATE TABLE IF NOT EXISTS depannhome_partner_dialogue_messages (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    mission_id BIGINT NOT NULL REFERENCES depannhome_partner_missions(id) ON DELETE CASCADE,
    sender_type VARCHAR(20) NOT NULL, sender_user_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    sender_name VARCHAR(160) NOT NULL DEFAULT '', organization_name VARCHAR(160) NOT NULL DEFAULT '',
    kind VARCHAR(20) NOT NULL DEFAULT 'message', issue_type VARCHAR(60) NOT NULL DEFAULT '',
    body VARCHAR(4000) NOT NULL DEFAULT '', reply_to_id BIGINT REFERENCES depannhome_partner_dialogue_messages(id) ON DELETE SET NULL,
    partner_visible BOOLEAN NOT NULL DEFAULT FALSE, receiver_visible BOOLEAN NOT NULL DEFAULT TRUE,
    event_type VARCHAR(80) NOT NULL DEFAULT '', immutable BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE depannhome_partner_dialogue_messages
    ADD COLUMN IF NOT EXISTS partner_visible BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS receiver_visible BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS event_type VARCHAR(80) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS immutable BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
UPDATE depannhome_partner_dialogue_messages message
SET organization_name=COALESCE(NULLIF(profile.company_name,''),NULLIF(owner.company_name,''),NULLIF(owner.full_name,''),owner.username)
FROM depannhome_users owner
LEFT JOIN depannhome_billing_profiles profile ON profile.owner_id=owner.id
WHERE message.owner_id=owner.id AND message.sender_type='internal'
    AND message.organization_name IN ('','Votre entreprise');
CREATE INDEX IF NOT EXISTS depannhome_partner_dialogue_messages_mission_idx ON depannhome_partner_dialogue_messages(owner_id, mission_id, created_at, id);
CREATE TABLE IF NOT EXISTS depannhome_partner_dialogue_attachments (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    mission_id BIGINT NOT NULL REFERENCES depannhome_partner_missions(id) ON DELETE CASCADE,
    message_id BIGINT NOT NULL REFERENCES depannhome_partner_dialogue_messages(id) ON DELETE CASCADE,
    attachment_type VARCHAR(40) NOT NULL DEFAULT 'document', filename VARCHAR(255) NOT NULL, mime_type VARCHAR(150) NOT NULL,
    file_size INTEGER NOT NULL CHECK (file_size > 0 AND file_size <= 5242880), file_data BYTEA NOT NULL,
    partner_visible BOOLEAN NOT NULL DEFAULT FALSE, receiver_visible BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_partner_dialogue_attachments_message_idx ON depannhome_partner_dialogue_attachments(message_id);
ALTER TABLE depannhome_partner_dialogue_attachments
    ADD COLUMN IF NOT EXISTS partner_visible BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS receiver_visible BOOLEAN NOT NULL DEFAULT TRUE;
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

-- Les contenus mission sont internes par défaut : devis, factures, rapports et
-- photos ne sont exposés au partenaire que par une décision explicite.
CREATE TABLE IF NOT EXISTS depannhome_partner_mission_items (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    mission_id BIGINT NOT NULL REFERENCES depannhome_partner_missions(id) ON DELETE CASCADE,
    source_type VARCHAR(30) NOT NULL, source_id VARCHAR(120) NOT NULL, source_item_id VARCHAR(120) NOT NULL DEFAULT '',
    label VARCHAR(255) NOT NULL DEFAULT '', details JSONB NOT NULL DEFAULT '{}'::jsonb,
    partner_visible BOOLEAN NOT NULL DEFAULT FALSE, dialogue_message_id BIGINT REFERENCES depannhome_partner_dialogue_messages(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT depannhome_partner_mission_items_unique UNIQUE(mission_id, source_type, source_id, source_item_id)
);
CREATE INDEX IF NOT EXISTS depannhome_partner_mission_items_visibility_idx ON depannhome_partner_mission_items(owner_id, mission_id, partner_visible, updated_at DESC);
CREATE TABLE IF NOT EXISTS depannhome_partner_mission_item_audit (
    id BIGSERIAL PRIMARY KEY, owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    mission_id BIGINT NOT NULL REFERENCES depannhome_partner_missions(id) ON DELETE CASCADE,
    item_id BIGINT NOT NULL REFERENCES depannhome_partner_mission_items(id) ON DELETE CASCADE,
    action VARCHAR(60) NOT NULL, actor_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    old_value JSONB NOT NULL DEFAULT '{}'::jsonb, new_value JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
    availability_status VARCHAR(30) NOT NULL DEFAULT 'available' CHECK (availability_status IN ('available', 'unavailable', 'temporarily_unavailable')),
    commercial_name VARCHAR(160) NOT NULL DEFAULT '', region VARCHAR(100) NOT NULL DEFAULT '',
    regions JSONB NOT NULL DEFAULT '[]'::jsonb, coverage_mode VARCHAR(20) NOT NULL DEFAULT 'custom',
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
ALTER TABLE depannhome_partner_directory
    ADD COLUMN IF NOT EXISTS availability_status VARCHAR(30) NOT NULL DEFAULT 'available',
    ADD COLUMN IF NOT EXISTS commercial_name VARCHAR(160) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS region VARCHAR(100) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS regions JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS coverage_mode VARCHAR(20) NOT NULL DEFAULT 'custom';
ALTER TABLE depannhome_partner_directory DROP CONSTRAINT IF EXISTS depannhome_partner_directory_availability_status_check;
ALTER TABLE depannhome_partner_directory ADD CONSTRAINT depannhome_partner_directory_availability_status_check CHECK (availability_status IN ('available','unavailable','temporarily_unavailable'));
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

-- Organisation unifiée : couche additive liée au compte propriétaire existant.
-- Les tables métier continuent de cibler owner_id/account_owner_id : changer
-- l’interface ou la licence ne déplace donc aucune donnée.
CREATE TABLE IF NOT EXISTS depannhome_organizations (
    id BIGSERIAL PRIMARY KEY,
    account_owner_id BIGINT NOT NULL UNIQUE REFERENCES depannhome_users(id) ON DELETE CASCADE,
    interface_type VARCHAR(20) NOT NULL DEFAULT 'standard',
    organization_type VARCHAR(40) NOT NULL DEFAULT 'troubleshooting_company',
    license_type VARCHAR(30) NOT NULL DEFAULT 'depannhome_standard',
    license_features JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT depannhome_organizations_interface_check CHECK (interface_type IN ('partner','standard','group')),
    CONSTRAINT depannhome_organizations_type_check CHECK (organization_type IN ('troubleshooting_company','leak_detection_company','locksmith','plumber','property_manager','real_estate_agency','insurance','expert','principal','partner_platform','other')),
    CONSTRAINT depannhome_organizations_license_check CHECK (license_type IN ('partner_portal','depannhome_standard','depannhome_group'))
);
INSERT INTO depannhome_organizations(account_owner_id,interface_type,organization_type,license_type)
SELECT id,'standard','troubleshooting_company','depannhome_standard' FROM depannhome_users WHERE account_owner_id=id
ON CONFLICT(account_owner_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS depannhome_organization_audit (
    id BIGSERIAL PRIMARY KEY,
    account_owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    actor_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    action VARCHAR(40) NOT NULL,
    previous_value JSONB NOT NULL DEFAULT '{}'::jsonb,
    next_value JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_organization_audit_owner_created_idx ON depannhome_organization_audit(account_owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS depannhome_organizations_interface_idx ON depannhome_organizations(interface_type, license_type);

ALTER TABLE depannhome_library_documents ADD COLUMN IF NOT EXISTS owner_id BIGINT REFERENCES depannhome_users(id) ON DELETE CASCADE;
UPDATE depannhome_library_documents document SET owner_id = section.owner_id FROM depannhome_library_sections section WHERE document.section_id = section.id AND document.owner_id IS NULL;
ALTER TABLE depannhome_library_documents ALTER COLUMN owner_id SET NOT NULL;
