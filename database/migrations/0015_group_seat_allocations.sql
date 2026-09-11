ALTER TABLE depannhome_users
ADD COLUMN IF NOT EXISTS max_pc_users INTEGER NOT NULL DEFAULT 1,
ADD COLUMN IF NOT EXISTS max_technicians INTEGER NOT NULL DEFAULT 5,
ADD COLUMN IF NOT EXISTS max_group_companies INTEGER NOT NULL DEFAULT 1,
ADD COLUMN IF NOT EXISTS subscription_plan VARCHAR(20) NOT NULL DEFAULT 'free',
ADD COLUMN IF NOT EXISTS subscription_tier VARCHAR(20) NOT NULL DEFAULT 'pro',
ADD COLUMN IF NOT EXISTS subscription_label VARCHAR(80) NOT NULL DEFAULT '',
ADD COLUMN IF NOT EXISTS monthly_price_cents INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE depannhome_users DROP CONSTRAINT IF EXISTS depannhome_users_max_group_companies_check;
ALTER TABLE depannhome_users ADD CONSTRAINT depannhome_users_max_group_companies_check
CHECK(max_group_companies BETWEEN 1 AND 100);

CREATE TABLE IF NOT EXISTS depannhome_groups (
    id BIGSERIAL PRIMARY KEY, name VARCHAR(160) NOT NULL,
    shared_partner_directory_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS depannhome_group_companies (
    group_id BIGINT NOT NULL REFERENCES depannhome_groups(id) ON DELETE CASCADE,
    company_owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE RESTRICT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(group_id,company_owner_id), UNIQUE(company_owner_id)
);

CREATE TABLE IF NOT EXISTS depannhome_group_entitlements (
    group_id BIGINT PRIMARY KEY REFERENCES depannhome_groups(id) ON DELETE CASCADE,
    principal_company_owner_id BIGINT NOT NULL UNIQUE REFERENCES depannhome_users(id) ON DELETE RESTRICT,
    max_companies INTEGER NOT NULL CHECK(max_companies BETWEEN 1 AND 100),
    total_pc_seats INTEGER NOT NULL CHECK(total_pc_seats BETWEEN 1 AND 1000),
    total_mobile_seats INTEGER NOT NULL CHECK(total_mobile_seats BETWEEN 0 AND 5000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS depannhome_group_company_seat_allocations (
    group_id BIGINT NOT NULL REFERENCES depannhome_groups(id) ON DELETE CASCADE,
    company_owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
    allocated_pc_seats INTEGER NOT NULL CHECK(allocated_pc_seats BETWEEN 1 AND 100),
    allocated_mobile_seats INTEGER NOT NULL CHECK(allocated_mobile_seats BETWEEN 0 AND 500),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(group_id, company_owner_id),
    UNIQUE(company_owner_id)
);

INSERT INTO depannhome_group_entitlements(group_id,principal_company_owner_id,max_companies,total_pc_seats,total_mobile_seats)
SELECT grouped.group_id,grouped.principal_company_owner_id,grouped.company_count,
    GREATEST(1,grouped.total_pc_seats),GREATEST(0,grouped.total_mobile_seats)
FROM (
    SELECT company.group_id,
        COALESCE((SELECT principal.account_owner_id FROM depannhome_groups group_data JOIN depannhome_users principal ON principal.id=group_data.created_by WHERE group_data.id=company.group_id LIMIT 1),MIN(company.company_owner_id)) AS principal_company_owner_id,
        COUNT(*)::integer AS company_count,
        SUM(owner.max_pc_users)::integer AS total_pc_seats,
        SUM(owner.max_technicians)::integer AS total_mobile_seats
    FROM depannhome_group_companies company
    JOIN depannhome_users owner ON owner.id=company.company_owner_id
    GROUP BY company.group_id
) grouped
ON CONFLICT(group_id) DO NOTHING;

INSERT INTO depannhome_group_company_seat_allocations(group_id,company_owner_id,allocated_pc_seats,allocated_mobile_seats)
SELECT company.group_id,company.company_owner_id,owner.max_pc_users,owner.max_technicians
FROM depannhome_group_companies company
JOIN depannhome_users owner ON owner.id=company.company_owner_id
ON CONFLICT(group_id,company_owner_id) DO NOTHING;

UPDATE depannhome_users owner
SET max_group_companies=entitlement.max_companies,
    max_pc_users=entitlement.total_pc_seats,
    max_technicians=entitlement.total_mobile_seats,
    monthly_price_cents=CASE owner.subscription_tier
        WHEN 'basic' THEN entitlement.total_pc_seats*2000+entitlement.total_mobile_seats*500
        WHEN 'basic_plus' THEN entitlement.total_pc_seats*3500+entitlement.total_mobile_seats*800
        ELSE entitlement.total_pc_seats*7000+entitlement.total_mobile_seats*1500
    END,
    updated_at=NOW()
FROM depannhome_group_entitlements entitlement
WHERE owner.id=entitlement.principal_company_owner_id;

UPDATE depannhome_users owner
SET subscription_plan='free',subscription_label='Rattachée au groupe',monthly_price_cents=0,updated_at=NOW()
FROM depannhome_group_companies company
JOIN depannhome_group_entitlements entitlement ON entitlement.group_id=company.group_id
WHERE owner.id=company.company_owner_id AND owner.id<>entitlement.principal_company_owner_id;

DO $$
BEGIN
    IF to_regclass('depannhome_subscription_invoices') IS NOT NULL THEN
        UPDATE depannhome_subscription_invoices invoice
        SET status='cancelled',last_error='Annulée automatiquement : abonnement rattaché à l’entreprise principale du groupe.',updated_at=NOW()
        WHERE invoice.status IN ('pending','failed') AND invoice.invoice_kind='cycle'
            AND EXISTS(
                SELECT 1 FROM depannhome_group_companies company
                JOIN depannhome_group_entitlements entitlement ON entitlement.group_id=company.group_id
                WHERE company.company_owner_id=invoice.account_owner_id
                    AND entitlement.principal_company_owner_id<>invoice.account_owner_id
            );
    END IF;
END $$;

CREATE OR REPLACE FUNCTION depannhome_validate_group_seat_allocation() RETURNS trigger AS $$
DECLARE
    entitlement depannhome_group_entitlements%ROWTYPE;
    allocated_pc INTEGER;
    allocated_mobile INTEGER;
    active_pc INTEGER;
    approved_pc INTEGER;
    active_mobile INTEGER;
    approved_mobile INTEGER;
BEGIN
    SELECT * INTO entitlement FROM depannhome_group_entitlements WHERE group_id=NEW.group_id FOR UPDATE;
    IF entitlement.group_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM depannhome_group_companies company
        WHERE company.group_id=NEW.group_id AND company.company_owner_id=NEW.company_owner_id
    ) THEN
        RAISE EXCEPTION 'L’entreprise et l’allocation doivent appartenir au même groupe.' USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(SUM(allocated_pc_seats),0),COALESCE(SUM(allocated_mobile_seats),0)
    INTO allocated_pc,allocated_mobile
    FROM depannhome_group_company_seat_allocations
    WHERE group_id=NEW.group_id AND company_owner_id<>NEW.company_owner_id;
    IF allocated_pc+NEW.allocated_pc_seats>entitlement.total_pc_seats
        OR allocated_mobile+NEW.allocated_mobile_seats>entitlement.total_mobile_seats THEN
        RAISE EXCEPTION 'La répartition dépasse l’enveloppe de postes du groupe.' USING ERRCODE='23514';
    END IF;
    SELECT COUNT(*) FILTER(WHERE is_active AND role IN ('admin','pc_standard','commercial','accountant'))::integer,
        COUNT(*) FILTER(WHERE is_active AND role IN ('mobile_admin','team_lead','technician'))::integer
    INTO active_pc,active_mobile FROM depannhome_users WHERE account_owner_id=NEW.company_owner_id;
    SELECT COUNT(DISTINCT device.id) FILTER(WHERE device.status='approved' AND device.device_type='desktop' AND member.role IN ('admin','pc_standard','commercial','accountant'))::integer,
        COUNT(DISTINCT device.id) FILTER(WHERE device.status='approved' AND device.device_type='mobile' AND member.role IN ('admin','commercial'))::integer
    INTO approved_pc,approved_mobile FROM depannhome_users member
    LEFT JOIN depannhome_auth_devices device ON device.user_id=member.id
    WHERE member.account_owner_id=NEW.company_owner_id AND member.is_active;
    IF NEW.allocated_pc_seats<GREATEST(active_pc,approved_pc)
        OR NEW.allocated_mobile_seats<active_mobile+approved_mobile THEN
        RAISE EXCEPTION 'L’allocation ne peut pas être inférieure aux postes actuellement utilisés.' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS depannhome_group_seat_allocation_limit ON depannhome_group_company_seat_allocations;
CREATE TRIGGER depannhome_group_seat_allocation_limit
BEFORE INSERT OR UPDATE ON depannhome_group_company_seat_allocations
FOR EACH ROW EXECUTE FUNCTION depannhome_validate_group_seat_allocation();

CREATE OR REPLACE FUNCTION depannhome_validate_group_entitlement() RETURNS trigger AS $$
DECLARE
    company_count INTEGER;
    allocated_pc INTEGER;
    allocated_mobile INTEGER;
BEGIN
    SELECT COUNT(*)::integer INTO company_count FROM depannhome_group_companies WHERE group_id=NEW.group_id;
    SELECT COALESCE(SUM(allocated_pc_seats),0),COALESCE(SUM(allocated_mobile_seats),0)
    INTO allocated_pc,allocated_mobile FROM depannhome_group_company_seat_allocations WHERE group_id=NEW.group_id;
    IF NEW.max_companies<company_count OR NEW.total_pc_seats<allocated_pc OR NEW.total_mobile_seats<allocated_mobile THEN
        RAISE EXCEPTION 'L’enveloppe du groupe ne peut pas être inférieure à sa répartition actuelle.' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS depannhome_group_entitlement_limit ON depannhome_group_entitlements;
CREATE TRIGGER depannhome_group_entitlement_limit
BEFORE UPDATE ON depannhome_group_entitlements
FOR EACH ROW EXECUTE FUNCTION depannhome_validate_group_entitlement();
