import pg from "pg";

const { Pool } = pg;

let pool;

export function getPool() {
    if (!pool) {
        if (!process.env.DATABASE_URL) {
            throw new Error("La variable DATABASE_URL est requise.");
        }

        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
            application_name: "depann-home-pro",
            max: 5,
            idleTimeoutMillis: 30_000,
            connectionTimeoutMillis: 8_000,
            query_timeout: 8_000,
            statement_timeout: 8_000,
            lock_timeout: 5_000
        });
    }

    return pool;
}

export async function initializeDatabase() {
    const database = getPool();
    const { rows: billingPermissionColumn } = await database.query(`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'depannhome_users' AND column_name = 'can_create_billing'
    `);
    const { rows: workstationBillingPermissionColumn } = await database.query(`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'depannhome_users' AND column_name = 'can_access_billing'
    `);

    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_users (
            id BIGSERIAL PRIMARY KEY,
            username VARCHAR(32) NOT NULL,
            password_hash TEXT NOT NULL,
            role VARCHAR(20) NOT NULL DEFAULT 'user',
            account_owner_id BIGINT REFERENCES depannhome_users(id) ON DELETE CASCADE,
            full_name VARCHAR(100) NOT NULL DEFAULT '',
            phone VARCHAR(30) NOT NULL DEFAULT '',
            email VARCHAR(160) NOT NULL DEFAULT '',
            department VARCHAR(80) NOT NULL DEFAULT '',
            departments JSONB NOT NULL DEFAULT '[]'::jsonb,
            company_name VARCHAR(160) NOT NULL DEFAULT '',
            max_pc_users INTEGER NOT NULL DEFAULT 1,
            max_technicians INTEGER NOT NULL DEFAULT 5,
            technician_billing_enabled BOOLEAN NOT NULL DEFAULT TRUE,
            can_create_billing BOOLEAN NOT NULL DEFAULT TRUE,
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
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT depannhome_users_username_unique UNIQUE (username)
        )
    `);
    await database.query(`
        ALTER TABLE depannhome_users
        ADD COLUMN IF NOT EXISTS account_owner_id BIGINT REFERENCES depannhome_users(id) ON DELETE CASCADE,
        ADD COLUMN IF NOT EXISTS full_name VARCHAR(100) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS phone VARCHAR(30) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS email VARCHAR(160) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS department VARCHAR(80) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS departments JSONB NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS company_name VARCHAR(160) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS max_pc_users INTEGER NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS max_technicians INTEGER NOT NULL DEFAULT 5,
        ADD COLUMN IF NOT EXISTS technician_billing_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS can_create_billing BOOLEAN NOT NULL DEFAULT TRUE,
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
        ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS archived_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL
    `);
    const tierMigration = await database.query("UPDATE depannhome_users SET subscription_tier='pro' WHERE subscription_tier IS NULL OR subscription_tier NOT IN ('basic','basic_plus','pro')");
    if (tierMigration.rowCount) console.info(`[database] ${tierMigration.rowCount} compte(s) migré(s) vers l’offre Pro.`);
    await database.query("ALTER TABLE depannhome_users DROP CONSTRAINT IF EXISTS depannhome_users_subscription_tier_check");
    await database.query("ALTER TABLE depannhome_users ADD CONSTRAINT depannhome_users_subscription_tier_check CHECK(subscription_tier IN ('basic','basic_plus','pro'))");
    if (!billingPermissionColumn.length) {
        await database.query(`
            UPDATE depannhome_users technician
            SET can_create_billing = owner.technician_billing_enabled
            FROM depannhome_users owner
            WHERE technician.role = 'technician' AND owner.id = technician.account_owner_id
        `);
    }
    if (!workstationBillingPermissionColumn.length) {
        await database.query("UPDATE depannhome_users SET can_access_billing = TRUE WHERE role IN ('pc_standard', 'accountant')");
    }
    await database.query("UPDATE depannhome_users SET account_owner_id = id WHERE account_owner_id IS NULL");
    await database.query("UPDATE depannhome_users SET role = 'admin' WHERE role = 'user' AND account_owner_id = id");
    await database.query(`
        UPDATE depannhome_users
        SET departments = jsonb_build_array(department)
        WHERE department <> '' AND (jsonb_typeof(departments) <> 'array' OR jsonb_array_length(departments) = 0)
    `);

    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_organizations (
            id BIGSERIAL PRIMARY KEY,
            account_owner_id BIGINT NOT NULL UNIQUE REFERENCES depannhome_users(id) ON DELETE CASCADE,
            interface_type VARCHAR(20) NOT NULL DEFAULT 'standard',
            organization_type VARCHAR(40) NOT NULL DEFAULT 'troubleshooting_company',
            license_type VARCHAR(30) NOT NULL DEFAULT 'depannhome_standard',
            license_features JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT depannhome_organizations_interface_check CHECK (interface_type IN ('partner','standard','group')),
            CONSTRAINT depannhome_organizations_type_check CHECK (organization_type IN ('troubleshooting_company','leak_detection_company','locksmith','plumber','property_manager','real_estate_agency','insurance','expert','principal','partner_platform','other')),
            CONSTRAINT depannhome_organizations_license_check CHECK (license_type IN ('partner_portal','depannhome_standard','depannhome_group'))
        )
    `);
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_organization_audit (
            id BIGSERIAL PRIMARY KEY,
            account_owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            actor_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
            action VARCHAR(40) NOT NULL,
            previous_value JSONB NOT NULL DEFAULT '{}'::jsonb,
            next_value JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_organization_audit_owner_created_idx ON depannhome_organization_audit(account_owner_id, created_at DESC)");
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_users_owner_archive_idx ON depannhome_users(account_owner_id, is_archived, updated_at DESC)");
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_account_lifecycle_audit (
            id BIGSERIAL PRIMARY KEY,
            account_owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            actor_id BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
            action VARCHAR(30) NOT NULL CHECK (action IN ('archived', 'restored')),
            reason VARCHAR(500) NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_account_lifecycle_audit_owner_idx ON depannhome_account_lifecycle_audit(account_owner_id, created_at DESC)");

    await database.query(`
        CREATE INDEX IF NOT EXISTS depannhome_users_username_lookup_idx
        ON depannhome_users (username)
    `);
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_auth_devices (
            id UUID PRIMARY KEY,
            user_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            label VARCHAR(100) NOT NULL DEFAULT '',
            device_type VARCHAR(10) NOT NULL DEFAULT 'desktop' CHECK (device_type IN ('mobile', 'desktop')),
            status VARCHAR(20) NOT NULL DEFAULT 'approval_pending',
            verification_code_hash TEXT NOT NULL DEFAULT '',
            verification_code_expires_at TIMESTAMPTZ,
            verification_attempts INTEGER NOT NULL DEFAULT 0,
            verified_at TIMESTAMPTZ,
            approved_at TIMESTAMPTZ,
            approved_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
            session_id UUID,
            last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT depannhome_auth_devices_status_check CHECK (status IN ('approval_pending', 'code_pending', 'approved', 'rejected'))
        )
    `);
    await database.query(`
        ALTER TABLE depannhome_auth_devices
        ADD COLUMN IF NOT EXISTS device_type VARCHAR(10) NOT NULL DEFAULT 'desktop'
    `);
    await database.query(`
        ALTER TABLE depannhome_auth_devices
        ADD COLUMN IF NOT EXISTS session_id UUID
    `);
    await database.query(`
        UPDATE depannhome_auth_devices device
        SET status = 'rejected', session_id = NULL, verification_code_hash = '', verification_code_expires_at = NULL
        FROM depannhome_users account
        WHERE account.id = device.user_id AND device.status <> 'rejected' AND (
            (account.role IN ('mobile_admin', 'team_lead', 'technician') AND device.device_type <> 'mobile')
            OR (account.role IN ('pc_standard', 'accountant') AND device.device_type <> 'desktop')
        )
    `);
    await database.query(`
        WITH duplicate_mobile_devices AS (
            SELECT device.id,
                ROW_NUMBER() OVER (PARTITION BY device.user_id ORDER BY device.last_seen_at DESC, device.created_at DESC) AS mobile_rank
            FROM depannhome_auth_devices device
            JOIN depannhome_users account ON account.id = device.user_id
            WHERE ((account.role IN ('admin', 'commercial') AND device.device_type = 'mobile') OR account.role IN ('mobile_admin', 'team_lead', 'technician'))
                AND device.status <> 'rejected'
        )
        UPDATE depannhome_auth_devices device
        SET status = 'rejected', verification_code_hash = '', verification_code_expires_at = NULL
        FROM duplicate_mobile_devices duplicate
        WHERE device.id = duplicate.id AND duplicate.mobile_rank > 1
    `);
    await database.query(`
        CREATE INDEX IF NOT EXISTS depannhome_auth_devices_user_idx
        ON depannhome_auth_devices (user_id, status, last_seen_at DESC)
    `);
    await database.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS depannhome_auth_devices_one_active_mobile_per_user_idx
        ON depannhome_auth_devices (user_id)
        WHERE device_type = 'mobile' AND status <> 'rejected'
    `);
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_creator_totp (
            user_id BIGINT PRIMARY KEY REFERENCES depannhome_users(id) ON DELETE CASCADE,
            secret_ciphertext TEXT NOT NULL DEFAULT '',
            pending_secret_ciphertext TEXT NOT NULL DEFAULT '',
            pending_expires_at TIMESTAMPTZ,
            enabled BOOLEAN NOT NULL DEFAULT FALSE,
            confirmed_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_company_totp_policies (
            owner_id BIGINT PRIMARY KEY REFERENCES depannhome_users(id) ON DELETE CASCADE,
            enabled BOOLEAN NOT NULL DEFAULT FALSE,
            enabled_at TIMESTAMPTZ,
            enabled_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await database.query(`
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
        )
    `);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_company_totp_authenticators_user_idx ON depannhome_company_totp_authenticators (user_id, status, updated_at DESC)");
    await database.query(`
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
        )
    `);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_company_totp_challenges_user_idx ON depannhome_company_totp_challenges (user_id, purpose, expires_at DESC)");
    await database.query(`
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
        )
    `);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_member_audit_owner_created_idx ON depannhome_member_audit (owner_id, created_at DESC)");
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_platform_announcements (
            id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
            message VARCHAR(2000) NOT NULL DEFAULT '',
            is_active BOOLEAN NOT NULL DEFAULT FALSE,
            updated_by BIGINT REFERENCES depannhome_users(id) ON DELETE SET NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await database.query(`
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
        )
    `);
    await database.query(`ALTER TABLE depannhome_subscription_change_requests
        ADD COLUMN IF NOT EXISTS requested_pc_seats INTEGER,
        ADD COLUMN IF NOT EXISTS requested_mobile_seats INTEGER`);
    await database.query("CREATE INDEX IF NOT EXISTS depannhome_subscription_change_requests_owner_idx ON depannhome_subscription_change_requests(owner_id, created_at DESC)");
}

export async function findUserByUsername(username) {
    const { rows } = await getPool().query(
        `SELECT user_account.id, user_account.username, user_account.password_hash, user_account.role, user_account.account_owner_id,
            user_account.full_name, user_account.phone, user_account.email, user_account.department, user_account.departments, user_account.is_active, owner.is_active AS account_is_active,
            user_account.can_create_billing, user_account.can_access_billing, user_account.can_access_accounting, user_account.can_access_company_email, user_account.can_switch_group_companies,
            owner.max_pc_users AS max_pc_users, owner.max_technicians AS max_technicians, owner.monthly_price_cents AS monthly_price_cents
         FROM depannhome_users user_account
         JOIN depannhome_users owner ON owner.id = user_account.account_owner_id
         WHERE user_account.username = $1`,
        [username]
    );

    return rows[0] || null;
}

export async function findUserById(id) {
    const { rows } = await getPool().query(
        `SELECT user_account.id, user_account.username, user_account.password_hash, user_account.role, user_account.account_owner_id,
            user_account.full_name, user_account.phone, user_account.email, user_account.department, user_account.departments, user_account.is_active, owner.is_active AS account_is_active,
            user_account.can_create_billing, user_account.can_access_billing, user_account.can_access_accounting, user_account.can_access_company_email, user_account.can_switch_group_companies,
            owner.max_pc_users AS max_pc_users, owner.max_technicians AS max_technicians, owner.monthly_price_cents AS monthly_price_cents
         FROM depannhome_users user_account
         JOIN depannhome_users owner ON owner.id = user_account.account_owner_id
         WHERE user_account.id = $1`,
        [id]
    );
    return rows[0] || null;
}

export async function createUser({ username, passwordHash, role = "admin", accountOwnerId, fullName = "", phone = "", email = "", department = "", departments = [], canCreateBilling = false, canAccessBilling = false, canAccessAccounting = false, canAccessCompanyEmail = false, canSwitchGroupCompanies = false }, database = getPool()) {
    const { rows } = await database.query(
        `INSERT INTO depannhome_users (username, password_hash, role, account_owner_id, full_name, phone, email, department, departments, can_create_billing, can_access_billing, can_access_accounting, can_access_company_email, can_switch_group_companies)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14)
         RETURNING id, username, role, account_owner_id, full_name, phone, email, department, departments, can_create_billing, can_access_billing, can_access_accounting, can_access_company_email, can_switch_group_companies, is_active`,
        [username, passwordHash, role, accountOwnerId || null, fullName, phone, email, department, JSON.stringify(departments), canCreateBilling, canAccessBilling, canAccessAccounting, canAccessCompanyEmail, canSwitchGroupCompanies]
    );
    const user = rows[0];
    if (!user.account_owner_id) {
        const { rows: updatedRows } = await database.query(
            "UPDATE depannhome_users SET account_owner_id = id WHERE id = $1 RETURNING id, username, role, account_owner_id, full_name, phone, email, department, departments, can_create_billing, can_access_billing, can_access_accounting, can_access_company_email, can_switch_group_companies, is_active",
            [user.id]
        );
        return updatedRows[0];
    }
    return user;
}
