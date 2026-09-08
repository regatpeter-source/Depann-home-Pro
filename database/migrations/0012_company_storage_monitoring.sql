DO $$
BEGIN
    IF to_regclass('depannhome_organizations') IS NOT NULL THEN
        ALTER TABLE depannhome_organizations
            ADD COLUMN IF NOT EXISTS storage_quota_bytes BIGINT NOT NULL DEFAULT 2147483648;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='depannhome_organizations_storage_quota_check') THEN
            ALTER TABLE depannhome_organizations
                ADD CONSTRAINT depannhome_organizations_storage_quota_check
                CHECK(storage_quota_bytes BETWEEN 10485760 AND 10995116277760);
        END IF;
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS depannhome_storage_snapshots (
    account_owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    captured_on DATE NOT NULL DEFAULT CURRENT_DATE,
    usage_bytes BIGINT NOT NULL CHECK(usage_bytes >= 0),
    breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(account_owner_id,captured_on)
);

CREATE INDEX IF NOT EXISTS depannhome_storage_snapshots_owner_date_idx
    ON depannhome_storage_snapshots(account_owner_id,captured_on DESC);
