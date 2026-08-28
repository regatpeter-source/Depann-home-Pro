import { getPool } from "./database.js";
import { getAccountOwnerId } from "./auth.js";

const PURCHASE_CATEGORIES = new Set(["Matériel", "Consommables", "Loyer", "Véhicule", "Outillage", "Sous-traitance", "Services", "Assurances", "Autre"]);

export async function initializePurchases() {
    const database = getPool();
    await database.query(`
        CREATE TABLE IF NOT EXISTS depannhome_purchases (
            id BIGSERIAL PRIMARY KEY,
            owner_id BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE CASCADE,
            created_by BIGINT NOT NULL REFERENCES depannhome_users(id) ON DELETE RESTRICT,
            purchase_date DATE NOT NULL,
            category VARCHAR(40) NOT NULL DEFAULT 'Autre',
            client_id VARCHAR(100) NOT NULL DEFAULT '',
            client_name VARCHAR(160) NOT NULL DEFAULT '',
            supplier VARCHAR(160) NOT NULL DEFAULT '',
            description VARCHAR(500) NOT NULL,
            reference VARCHAR(100) NOT NULL DEFAULT '',
            amount_ht NUMERIC(12,2) NOT NULL CHECK (amount_ht >= 0),
            vat_rate NUMERIC(5,2) NOT NULL DEFAULT 20 CHECK (vat_rate >= 0 AND vat_rate <= 100),
            is_accounted BOOLEAN NOT NULL DEFAULT FALSE,
            accounted_at DATE,
            notes VARCHAR(2000) NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await database.query(`
        CREATE INDEX IF NOT EXISTS depannhome_purchases_owner_date_idx
        ON depannhome_purchases (owner_id, purchase_date DESC, id DESC)
    `);
    await database.query(`
        ALTER TABLE depannhome_purchases
        ADD COLUMN IF NOT EXISTS client_id VARCHAR(100) NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS client_name VARCHAR(160) NOT NULL DEFAULT ''
    `);
    await database.query(`
        CREATE INDEX IF NOT EXISTS depannhome_purchases_accounting_idx
        ON depannhome_purchases (owner_id, is_accounted, purchase_date DESC)
    `);
}

export function registerPurchaseRoutes(app, requireAuthentication) {
    app.get("/api/purchases", requireAuthentication, requirePurchaseReadAccess, asyncHandler(async (request, response) => {
        const clientId = cleanText(request.query?.clientId, 100);
        const { rows } = await getPool().query(`
            SELECT id, TO_CHAR(purchase_date, 'YYYY-MM-DD') AS "purchaseDate", category, client_id AS "clientId", client_name AS "clientName", supplier, description, reference,
                amount_ht::float AS "amountHt", vat_rate::float AS "vatRate", is_accounted AS "isAccounted",
                TO_CHAR(accounted_at, 'YYYY-MM-DD') AS "accountedAt", notes, created_at AS "createdAt", updated_at AS "updatedAt"
            FROM depannhome_purchases
            WHERE owner_id = $1 AND ($2 = '' OR client_id = $2)
            ORDER BY purchase_date DESC, id DESC
        `, [getAccountOwnerId(request), clientId]);
        response.json({ purchases: rows });
    }));

    app.post("/api/purchases", requireAuthentication, requirePurchaseAdministration, asyncHandler(async (request, response) => {
        const purchase = sanitizePurchase(request.body);
        if (!purchase.ok) return response.status(400).json({ message: purchase.message });
        const clientName = await resolveClientName(getAccountOwnerId(request), purchase.clientId, true);
        if (purchase.clientId && clientName === null) return response.status(400).json({ message: "Le client associé à cet achat est introuvable ou archivé." });
        const { rows } = await getPool().query(`
            INSERT INTO depannhome_purchases
                (owner_id, created_by, purchase_date, category, client_id, client_name, supplier, description, reference, amount_ht, vat_rate, is_accounted, accounted_at, notes)
            VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10,$11,$12,CASE WHEN $12 THEN CURRENT_DATE ELSE NULL END,$13)
            RETURNING id
        `, [getAccountOwnerId(request), request.user.sub, purchase.purchaseDate, purchase.category, purchase.clientId, clientName || "",
            purchase.supplier, purchase.description, purchase.reference, purchase.amountHt, purchase.vatRate, purchase.isAccounted, purchase.notes]);
        response.status(201).json({ id: rows[0].id });
    }));

    app.put("/api/purchases/:purchaseId", requireAuthentication, requirePurchaseAdministration, asyncHandler(async (request, response) => {
        const id = positiveId(request.params.purchaseId);
        const purchase = sanitizePurchase(request.body);
        if (!id) return response.status(400).json({ message: "Achat invalide." });
        if (!purchase.ok) return response.status(400).json({ message: purchase.message });
        const clientName = await resolveClientName(getAccountOwnerId(request), purchase.clientId);
        if (purchase.clientId && clientName === null) return response.status(400).json({ message: "Le client associé à cet achat est introuvable." });
        const result = await getPool().query(`
            UPDATE depannhome_purchases
            SET purchase_date=$3::date, category=$4, client_id=$5, client_name=$6, supplier=$7, description=$8, reference=$9, amount_ht=$10, vat_rate=$11,
                is_accounted=$12, accounted_at=CASE WHEN $12 THEN COALESCE(accounted_at, CURRENT_DATE) ELSE NULL END,
                notes=$13, updated_at=NOW()
            WHERE id=$1 AND owner_id=$2
        `, [id, getAccountOwnerId(request), purchase.purchaseDate, purchase.category, purchase.clientId, clientName || "", purchase.supplier, purchase.description,
            purchase.reference, purchase.amountHt, purchase.vatRate, purchase.isAccounted, purchase.notes]);
        if (!result.rowCount) return response.status(404).json({ message: "Achat introuvable." });
        response.status(204).end();
    }));

    app.patch("/api/purchases/:purchaseId/accounting", requireAuthentication, requirePurchaseAdministration, asyncHandler(async (request, response) => {
        const id = positiveId(request.params.purchaseId);
        if (!id || typeof request.body?.isAccounted !== "boolean") return response.status(400).json({ message: "Statut comptable invalide." });
        const result = await getPool().query(`
            UPDATE depannhome_purchases
            SET is_accounted=$3, accounted_at=CASE WHEN $3 THEN COALESCE(accounted_at, CURRENT_DATE) ELSE NULL END, updated_at=NOW()
            WHERE id=$1 AND owner_id=$2
        `, [id, getAccountOwnerId(request), request.body.isAccounted]);
        if (!result.rowCount) return response.status(404).json({ message: "Achat introuvable." });
        response.status(204).end();
    }));

    app.delete("/api/purchases/:purchaseId", requireAuthentication, requirePurchaseAdministration, asyncHandler(async (request, response) => {
        const id = positiveId(request.params.purchaseId);
        if (!id) return response.status(400).json({ message: "Achat invalide." });
        const result = await getPool().query(
            "DELETE FROM depannhome_purchases WHERE id=$1 AND owner_id=$2",
            [id, getAccountOwnerId(request)]
        );
        if (!result.rowCount) return response.status(404).json({ message: "Achat introuvable." });
        response.status(204).end();
    }));
}

function requirePurchaseAdministration(request, response, next) {
    if (!["admin", "pc_standard", "mobile_admin"].includes(request.user?.role)) return response.status(403).json({ message: request.user?.role === "accountant" ? "Le poste comptable administratif est en consultation uniquement." : "Les achats sont réservés aux postes administratifs et à l’Administrateur Mobile." });
    return next();
}

function requirePurchaseReadAccess(request, response, next) {
    if (["admin", "pc_standard", "accountant", "mobile_admin"].includes(request.user?.role)) return next();
    return response.status(403).json({ message: "Les achats sont réservés aux postes administratifs et à l’Administrateur Mobile." });
}

function sanitizePurchase(value) {
    const purchaseDate = sanitizeDate(value?.purchaseDate);
    const category = PURCHASE_CATEGORIES.has(value?.category) ? value.category : "Autre";
    const clientId = cleanText(value?.clientId, 100);
    const clientName = cleanText(value?.clientName, 160);
    const supplier = cleanText(value?.supplier, 160);
    const description = cleanText(value?.description, 500);
    const reference = cleanText(value?.reference, 100);
    const amountHt = nonNegativeNumber(value?.amountHt);
    const vatRate = nonNegativeNumber(value?.vatRate);
    const isAccounted = value?.isAccounted === "on";
    const notes = cleanText(value?.notes, 2000);
    if (!purchaseDate || !description) return { ok: false, message: "La date et le libellé de l’achat sont obligatoires." };
    if (amountHt === null || vatRate === null || vatRate > 100) return { ok: false, message: "Le montant HT ou la TVA est invalide." };
    return { ok: true, purchaseDate, category, clientId, clientName, supplier, description, reference, amountHt, vatRate, isAccounted, notes };
}

async function resolveClientName(ownerId, clientId, activeOnly = false) {
    if (!clientId) return "";
    const { rows } = await getPool().query(
        "SELECT client_data->>'name' AS name FROM depannhome_clients WHERE owner_id = $1 AND client_id = $2 AND ($3::boolean = FALSE OR client_status = 'active')",
        [ownerId, clientId, activeOnly]
    );
    return rows[0] ? cleanText(rows[0].name, 160) : null;
}

function sanitizeDate(value) {
    const date = String(value || "");
    return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(new Date(`${date}T12:00:00`).getTime()) ? date : "";
}

function positiveId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function nonNegativeNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 && number <= 100000000 ? Math.round(number * 100) / 100 : null;
}

function cleanText(value, maximumLength) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximumLength);
}

function asyncHandler(handler) {
    return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}
