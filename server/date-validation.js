const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function strictDateOnly(value, { allowTimestamp = false } = {}) {
    const source = String(value || "");
    const text = allowTimestamp ? source.slice(0, 10) : source;
    const match = DATE_ONLY_PATTERN.exec(text);
    if (!match) return "";
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? text : "";
}

export function isFutureDateOnly(value, today = new Date(), timeZone = process.env.BUSINESS_TIME_ZONE || "Europe/Paris") {
    const date = strictDateOnly(value);
    if (!date) return false;
    const parts = Object.fromEntries(new Intl.DateTimeFormat("fr-FR", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(today).map(part => [part.type, part.value]));
    const current = `${parts.year}-${parts.month}-${parts.day}`;
    return date > current;
}
