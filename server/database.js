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
            ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined
        });
    }

    return pool;
}

export async function initializeDatabase() {
    const database = getPool();

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
            company_name VARCHAR(160) NOT NULL DEFAULT '',
            max_pc_users INTEGER NOT NULL DEFAULT 1,
            max_technicians INTEGER NOT NULL DEFAULT 5,
            technician_billing_enabled BOOLEAN NOT NULL DEFAULT TRUE,
            subscription_plan VARCHAR(20) NOT NULL DEFAULT 'free',
            subscription_label VARCHAR(80) NOT NULL DEFAULT '',
            monthly_price_cents INTEGER NOT NULL DEFAULT 0,
            subscription_status VARCHAR(20) NOT NULL DEFAULT 'active',
            subscription_renewal_date DATE,
            billing_reference VARCHAR(100) NOT NULL DEFAULT '',
            creator_note VARCHAR(1000) NOT NULL DEFAULT '',
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
        ADD COLUMN IF NOT EXISTS company_name VARCHAR(160) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS max_pc_users INTEGER NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS max_technicians INTEGER NOT NULL DEFAULT 5,
        ADD COLUMN IF NOT EXISTS technician_billing_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS subscription_plan VARCHAR(20) NOT NULL DEFAULT 'free',
        ADD COLUMN IF NOT EXISTS subscription_label VARCHAR(80) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS monthly_price_cents INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(20) NOT NULL DEFAULT 'active',
        ADD COLUMN IF NOT EXISTS subscription_renewal_date DATE,
        ADD COLUMN IF NOT EXISTS billing_reference VARCHAR(100) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS creator_note VARCHAR(1000) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE
    `);
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
        CREATE INDEX IF NOT EXISTS depannhome_auth_devices_user_idx
        ON depannhome_auth_devices (user_id, status, last_seen_at DESC)
    `);
}

export async function findUserByUsername(username) {
    const { rows } = await getPool().query(
        `SELECT user_account.id, user_account.username, user_account.password_hash, user_account.role, user_account.account_owner_id,
            user_account.full_name, user_account.phone, user_account.email, user_account.is_active, owner.is_active AS account_is_active,
            owner.technician_billing_enabled AS technician_billing_enabled, owner.max_pc_users AS max_pc_users
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
            owner.technician_billing_enabled AS technician_billing_enabled, owner.max_pc_users AS max_pc_users
         FROM depannhome_users user_account
         JOIN depannhome_users owner ON owner.id = user_account.account_owner_id
         WHERE user_account.id = $1`,
        [id]
    );
    return rows[0] || null;
}

export async function createUser({ username, passwordHash, role = "admin", accountOwnerId, fullName = "", phone = "", email = "" }) {
    const { rows } = await getPool().query(
        `INSERT INTO depannhome_users (username, password_hash, role, account_owner_id, full_name, phone, email)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, username, role, account_owner_id, full_name, phone, email, is_active`,
        [username, passwordHash, role, accountOwnerId || null, fullName, phone, email]
    );
    const user = rows[0];
    if (!user.account_owner_id) {
        const { rows: updatedRows } = await getPool().query(
            "UPDATE depannhome_users SET account_owner_id = id WHERE id = $1 RETURNING id, username, role, account_owner_id, full_name, phone, email, is_active",
            [user.id]
        );
        return updatedRows[0];
    }
    return user;
}
