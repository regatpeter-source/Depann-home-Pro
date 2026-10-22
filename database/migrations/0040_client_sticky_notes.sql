-- Tâches visuelles persistantes rattachées à un dossier client.
-- Chaque post-it reste affiché jusqu'à sa suppression manuelle.
CREATE TABLE IF NOT EXISTS depannhome_client_sticky_notes (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL,
    client_id VARCHAR(100) NOT NULL,
    created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    created_by_name VARCHAR(160) NOT NULL DEFAULT '',
    color VARCHAR(10) NOT NULL DEFAULT 'yellow' CHECK(color IN ('yellow','red')),
    body VARCHAR(1000) NOT NULL CHECK(CHAR_LENGTH(BTRIM(body)) BETWEEN 1 AND 1000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT depannhome_client_sticky_notes_client_fk
        FOREIGN KEY(owner_id,client_id)
        REFERENCES depannhome_clients(owner_id,client_id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS depannhome_client_sticky_notes_client_idx
    ON depannhome_client_sticky_notes(owner_id,client_id,color,created_at DESC,id DESC);
