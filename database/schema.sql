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
