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
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT depannhome_users_username_unique UNIQUE (username)
        )
    `);

    await database.query(`
        CREATE INDEX IF NOT EXISTS depannhome_users_username_lookup_idx
        ON depannhome_users (username)
    `);
}

export async function findUserByUsername(username) {
    const { rows } = await getPool().query(
        "SELECT id, username, password_hash, role FROM depannhome_users WHERE username = $1",
        [username]
    );

    return rows[0] || null;
}

export async function createUser({ username, passwordHash, role = "user" }) {
    const { rows } = await getPool().query(
        `INSERT INTO depannhome_users (username, password_hash, role)
         VALUES ($1, $2, $3)
         RETURNING id, username, role`,
        [username, passwordHash, role]
    );

    return rows[0];
}
