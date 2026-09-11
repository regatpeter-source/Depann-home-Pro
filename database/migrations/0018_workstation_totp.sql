-- Versionne les structures de double authentification propres aux comptes PC.
-- Elles étaient auparavant créées uniquement par l'initialisation dynamique.
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
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS depannhome_company_totp_challenges_user_idx
    ON depannhome_company_totp_challenges (user_id, purpose, expires_at DESC);

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

CREATE INDEX IF NOT EXISTS depannhome_member_audit_owner_created_idx
    ON depannhome_member_audit (owner_id, created_at DESC);
