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
            company_name VARCHAR(160) NOT NULL DEFAULT '',
            max_pc_users INTEGER NOT NULL DEFAULT 1,
            max_technicians INTEGER NOT NULL DEFAULT 5,
            technician_billing_enabled BOOLEAN NOT NULL DEFAULT TRUE,
            can_create_billing BOOLEAN NOT NULL DEFAULT TRUE,
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
        ADD COLUMN IF NOT EXISTS company_name VARCHAR(160) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS max_pc_users INTEGER NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS max_technicians INTEGER NOT NULL DEFAULT 5,
        ADD COLUMN IF NOT EXISTS technician_billing_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS can_create_billing BOOLEAN NOT NULL DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS subscription_plan VARCHAR(20) NOT NULL DEFAULT 'free',
        ADD COLUMN IF NOT EXISTS subscription_label VARCHAR(80) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS monthly_price_cents INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(20) NOT NULL DEFAULT 'active',
        ADD COLUMN IF NOT EXISTS subscription_renewal_date DATE,
        ADD COLUMN IF NOT EXISTS billing_reference VARCHAR(100) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS creator_note VARCHAR(1000) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS quote_template_policy VARCHAR(30) NOT NULL DEFAULT 'company_choice',
        ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE
    `);
    if (!billingPermissionColumn.length) {
        await database.query(`
            UPDATE depannhome_users technician
            SET can_create_billing = owner.technician_billing_enabled
            FROM depannhome_users owner
            WHERE technician.role = 'technician' AND owner.id = technician.account_owner_id
        `);
    }
    await database.query("UPDATE depannhome_users SET account_owner_id = id WHERE account_owner_id IS NULL");
    await database.query("UPDATE depannhome_users SET role = 'admin' WHERE role = 'user' AND account_owner_id = id");

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
        UPDATE depannhome_auth_devices device
        SET device_type = 'desktop'
        FROM depannhome_users account
        WHERE account.id = device.user_id AND account.role NOT IN ('admin', 'mobile_admin') AND device.device_type = 'mobile'
    `);
    await database.query(`
        WITH duplicate_mobile_devices AS (
            SELECT device.id,
                ROW_NUMBER() OVER (PARTITION BY device.user_id ORDER BY device.last_seen_at DESC, device.created_at DESC) AS mobile_rank
            FROM depannhome_auth_devices device
            JOIN depannhome_users account ON account.id = device.user_id
            WHERE account.role IN ('admin', 'mobile_admin') AND device.device_type = 'mobile' AND device.status <> 'rejected'
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
}

export async function findUserByUsername(username) {
    const { rows } = await getPool().query(
        `SELECT user_account.id, user_account.username, user_account.password_hash, user_account.role, user_account.account_owner_id,
            user_account.full_name, user_account.phone, user_account.email, user_account.is_active, owner.is_active AS account_is_active,
            user_account.can_create_billing, owner.max_pc_users AS max_pc_users
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
            user_account.full_name, user_account.phone, user_account.email, user_account.is_active, owner.is_active AS account_is_active,
            user_account.can_create_billing, owner.max_pc_users AS max_pc_users
         FROM depannhome_users user_account
         JOIN depannhome_users owner ON owner.id = user_account.account_owner_id
         WHERE user_account.id = $1`,
        [id]
    );
    return rows[0] || null;
}

export async function createUser({ username, passwordHash, role = "admin", accountOwnerId, fullName = "", phone = "", email = "", department = "" }) {
    const { rows } = await getPool().query(
        `INSERT INTO depannhome_users (username, password_hash, role, account_owner_id, full_name, phone, email, department)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, username, role, account_owner_id, full_name, phone, email, department, is_active`,
        [username, passwordHash, role, accountOwnerId || null, fullName, phone, email, department]
    );
    const user = rows[0];
    if (!user.account_owner_id) {
        const { rows: updatedRows } = await getPool().query(
            "UPDATE depannhome_users SET account_owner_id = id WHERE id = $1 RETURNING id, username, role, account_owner_id, full_name, phone, email, department, is_active",
            [user.id]
        );
        return updatedRows[0];
    }
    return user;
}
