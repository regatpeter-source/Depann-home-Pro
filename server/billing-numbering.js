const SERIES_PREFIXES = Object.freeze({ invoice: "FAC", credit: "AVO" });

export function formatBillingNumber(seriesType, seriesYear, sequence) {
    const prefix = SERIES_PREFIXES[seriesType];
    const year = Number(seriesYear);
    const number = Number(sequence);
    if (!prefix || !Number.isInteger(year) || year < 2000 || year > 9999 || !Number.isSafeInteger(number) || number < 1) {
        throw new TypeError("Série, année ou numéro de facturation invalide.");
    }
    return `${prefix}-${year}-${String(number).padStart(6, "0")}`;
}

export async function allocateBillingNumber(database, ownerId, seriesType, seriesYear) {
    if (!database?.query) throw new TypeError("Une transaction de base de données est obligatoire.");
    if (!SERIES_PREFIXES[seriesType]) throw new TypeError("Type de série de facturation invalide.");
    const { rows } = await database.query(`
        INSERT INTO depannhome_billing_sequences (owner_id, series_type, series_year, last_number)
        VALUES ($1,$2,$3,1)
        ON CONFLICT (owner_id, series_type, series_year) DO UPDATE SET
            last_number=depannhome_billing_sequences.last_number+1,
            updated_at=NOW()
        RETURNING last_number AS number
    `, [ownerId, seriesType, seriesYear]);
    return formatBillingNumber(seriesType, seriesYear, Number(rows[0].number));
}
