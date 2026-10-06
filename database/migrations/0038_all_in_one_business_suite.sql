-- Suite métier tout-en-un : portail client, parc, contrats, stock, rentabilité et automatisations internes.

DO $business_suite$
BEGIN
IF to_regclass('depannhome_users') IS NULL
   OR to_regclass('depannhome_billing_documents') IS NULL
   OR to_regclass('depannhome_calendar_events') IS NULL
   OR to_regclass('depannhome_purchases') IS NULL THEN
    RETURN;
END IF;

CREATE TABLE IF NOT EXISTS depannhome_customer_portal_links (
    id UUID PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    client_id VARCHAR(100) NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    label VARCHAR(160) NOT NULL DEFAULT '',
    document_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    allow_quote_decision BOOLEAN NOT NULL DEFAULT TRUE,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_accessed_at TIMESTAMPTZ,
    CONSTRAINT depannhome_customer_portal_links_documents_check CHECK (jsonb_typeof(document_ids)='array')
);
CREATE INDEX IF NOT EXISTS depannhome_customer_portal_links_owner_client_idx ON depannhome_customer_portal_links(owner_id,client_id,created_at DESC);
CREATE INDEX IF NOT EXISTS depannhome_customer_portal_links_expiry_idx ON depannhome_customer_portal_links(expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS depannhome_customer_portal_events (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    portal_link_id UUID NOT NULL REFERENCES depannhome_customer_portal_links(id) ON DELETE CASCADE,
    event_type VARCHAR(40) NOT NULL,
    document_id BIGINT,
    ip_hash CHAR(64) NOT NULL DEFAULT '',
    user_agent_hash CHAR(64) NOT NULL DEFAULT '',
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_customer_portal_events_link_idx ON depannhome_customer_portal_events(owner_id,portal_link_id,created_at DESC);

CREATE TABLE IF NOT EXISTS depannhome_quote_decisions (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    document_id BIGINT NOT NULL REFERENCES depannhome_billing_documents(id) ON DELETE RESTRICT,
    portal_link_id UUID NOT NULL REFERENCES depannhome_customer_portal_links(id) ON DELETE RESTRICT,
    decision VARCHAR(20) NOT NULL CHECK(decision IN ('accepted','refused')),
    signer_name VARCHAR(160) NOT NULL,
    signer_email VARCHAR(254) NOT NULL DEFAULT '',
    message VARCHAR(1000) NOT NULL DEFAULT '',
    document_sha256 CHAR(64) NOT NULL,
    evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
    decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT depannhome_quote_decisions_document_unique UNIQUE(owner_id,document_id)
);
CREATE INDEX IF NOT EXISTS depannhome_quote_decisions_client_idx ON depannhome_quote_decisions(owner_id,decided_at DESC);

CREATE TABLE IF NOT EXISTS depannhome_client_sites (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    client_id VARCHAR(100) NOT NULL,
    name VARCHAR(160) NOT NULL,
    address VARCHAR(500) NOT NULL DEFAULT '',
    postal_code VARCHAR(20) NOT NULL DEFAULT '',
    city VARCHAR(120) NOT NULL DEFAULT '',
    contact_name VARCHAR(160) NOT NULL DEFAULT '',
    contact_phone VARCHAR(50) NOT NULL DEFAULT '',
    access_notes VARCHAR(1000) NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_client_sites_owner_client_idx ON depannhome_client_sites(owner_id,client_id,name);

CREATE TABLE IF NOT EXISTS depannhome_client_equipment (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    client_id VARCHAR(100) NOT NULL,
    site_id BIGINT REFERENCES depannhome_client_sites(id) ON DELETE SET NULL,
    name VARCHAR(160) NOT NULL,
    category VARCHAR(100) NOT NULL DEFAULT '',
    brand VARCHAR(100) NOT NULL DEFAULT '',
    model VARCHAR(120) NOT NULL DEFAULT '',
    serial_number VARCHAR(160) NOT NULL DEFAULT '',
    installed_on DATE,
    warranty_ends_on DATE,
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK(status IN ('active','maintenance','retired')),
    notes VARCHAR(2000) NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_client_equipment_owner_client_idx ON depannhome_client_equipment(owner_id,client_id,site_id,status);

CREATE TABLE IF NOT EXISTS depannhome_maintenance_contracts (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    client_id VARCHAR(100) NOT NULL,
    site_id BIGINT REFERENCES depannhome_client_sites(id) ON DELETE SET NULL,
    equipment_id BIGINT REFERENCES depannhome_client_equipment(id) ON DELETE SET NULL,
    reference VARCHAR(100) NOT NULL,
    title VARCHAR(160) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK(status IN ('draft','active','suspended','expired','cancelled')),
    starts_on DATE NOT NULL,
    ends_on DATE,
    frequency_months INTEGER NOT NULL DEFAULT 12 CHECK(frequency_months BETWEEN 1 AND 120),
    next_service_on DATE,
    sla_hours INTEGER NOT NULL DEFAULT 0 CHECK(sla_hours BETWEEN 0 AND 8760),
    annual_amount_ht NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK(annual_amount_ht >= 0),
    notes VARCHAR(2000) NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT depannhome_maintenance_contracts_reference_unique UNIQUE(owner_id,reference)
);
CREATE INDEX IF NOT EXISTS depannhome_maintenance_contracts_due_idx ON depannhome_maintenance_contracts(owner_id,status,next_service_on,ends_on);

ALTER TABLE depannhome_calendar_events
    ADD COLUMN IF NOT EXISTS site_id BIGINT REFERENCES depannhome_client_sites(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS equipment_id BIGINT REFERENCES depannhome_client_equipment(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS contract_id BIGINT REFERENCES depannhome_maintenance_contracts(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS depannhome_inventory_locations (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    name VARCHAR(160) NOT NULL,
    location_type VARCHAR(20) NOT NULL CHECK(location_type IN ('warehouse','vehicle')),
    vehicle_registration VARCHAR(40) NOT NULL DEFAULT '',
    assigned_user_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT depannhome_inventory_locations_name_unique UNIQUE(owner_id,name)
);

CREATE TABLE IF NOT EXISTS depannhome_inventory_items (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    sku VARCHAR(100) NOT NULL,
    name VARCHAR(200) NOT NULL,
    unit VARCHAR(30) NOT NULL DEFAULT 'unité',
    default_unit_cost NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK(default_unit_cost >= 0),
    reorder_level NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK(reorder_level >= 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT depannhome_inventory_items_sku_unique UNIQUE(owner_id,sku)
);

CREATE TABLE IF NOT EXISTS depannhome_inventory_movements (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    item_id BIGINT NOT NULL REFERENCES depannhome_inventory_items(id) ON DELETE RESTRICT,
    location_id BIGINT NOT NULL REFERENCES depannhome_inventory_locations(id) ON DELETE RESTRICT,
    movement_type VARCHAR(20) NOT NULL CHECK(movement_type IN ('in','out','transfer_in','transfer_out','adjustment','consumption')),
    quantity NUMERIC(12,3) NOT NULL CHECK(quantity <> 0),
    unit_cost NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK(unit_cost >= 0),
    event_id BIGINT REFERENCES depannhome_calendar_events(id) ON DELETE SET NULL,
    transfer_reference UUID,
    reason VARCHAR(500) NOT NULL DEFAULT '',
    created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_inventory_movements_ledger_idx ON depannhome_inventory_movements(owner_id,item_id,location_id,created_at,id);
CREATE INDEX IF NOT EXISTS depannhome_inventory_movements_event_idx ON depannhome_inventory_movements(owner_id,event_id) WHERE event_id IS NOT NULL;

ALTER TABLE depannhome_purchases ADD COLUMN IF NOT EXISTS event_id BIGINT REFERENCES depannhome_calendar_events(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS depannhome_purchases_event_idx ON depannhome_purchases(owner_id,event_id) WHERE event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS depannhome_labor_cost_settings (
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    role VARCHAR(30) NOT NULL,
    hourly_cost NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK(hourly_cost >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(owner_id,role)
);

CREATE TABLE IF NOT EXISTS depannhome_automation_rules (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    name VARCHAR(160) NOT NULL,
    rule_type VARCHAR(40) NOT NULL CHECK(rule_type IN ('quote_follow_up','contract_renewal','maintenance_due','low_stock')),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    lead_days INTEGER NOT NULL DEFAULT 0 CHECK(lead_days BETWEEN 0 AND 365),
    configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS depannhome_automation_rules_active_idx ON depannhome_automation_rules(owner_id,is_active,rule_type);

CREATE TABLE IF NOT EXISTS depannhome_internal_reminders (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    rule_id BIGINT REFERENCES depannhome_automation_rules(id) ON DELETE SET NULL,
    reminder_type VARCHAR(40) NOT NULL,
    entity_type VARCHAR(40) NOT NULL,
    entity_id VARCHAR(100) NOT NULL,
    title VARCHAR(200) NOT NULL,
    details VARCHAR(1000) NOT NULL DEFAULT '',
    due_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','dismissed')),
    dedupe_key VARCHAR(250) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    CONSTRAINT depannhome_internal_reminders_dedupe_unique UNIQUE(owner_id,dedupe_key)
);
CREATE INDEX IF NOT EXISTS depannhome_internal_reminders_due_idx ON depannhome_internal_reminders(owner_id,status,due_at);

CREATE TABLE IF NOT EXISTS depannhome_automation_runs (
    id BIGSERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    source VARCHAR(20) NOT NULL DEFAULT 'manual',
    status VARCHAR(20) NOT NULL CHECK(status IN ('running','completed','failed')),
    created_count INTEGER NOT NULL DEFAULT 0,
    error_code VARCHAR(100) NOT NULL DEFAULT '',
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS depannhome_automation_runs_owner_idx ON depannhome_automation_runs(owner_id,started_at DESC);
END;
$business_suite$;
