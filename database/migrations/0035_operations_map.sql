CREATE TABLE IF NOT EXISTS depannhome_technician_locations (
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    latitude DOUBLE PRECISION NOT NULL CHECK(latitude BETWEEN -90 AND 90),
    longitude DOUBLE PRECISION NOT NULL CHECK(longitude BETWEEN -180 AND 180),
    accuracy_meters DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK(accuracy_meters BETWEEN 0 AND 50000),
    recorded_at TIMESTAMPTZ NOT NULL,
    sharing_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(owner_id,user_id)
);

CREATE INDEX IF NOT EXISTS depannhome_technician_locations_updated_idx
    ON depannhome_technician_locations(owner_id,updated_at DESC);

CREATE TABLE IF NOT EXISTS depannhome_map_geocodes (
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    address_hash CHAR(64) NOT NULL,
    address VARCHAR(500) NOT NULL,
    latitude DOUBLE PRECISION NOT NULL CHECK(latitude BETWEEN -90 AND 90),
    longitude DOUBLE PRECISION NOT NULL CHECK(longitude BETWEEN -180 AND 180),
    provider VARCHAR(30) NOT NULL DEFAULT 'nominatim',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(owner_id,address_hash)
);
