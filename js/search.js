import { normalizeText } from "./utils.js?v=44";
import { getSearchableClients } from "./clients.js?v=58";

const STOP_WORDS = new Set(["a", "au", "aux", "ce", "ces", "d", "de", "des", "du", "en", "et", "la", "le", "les", "pour", "sur", "un", "une"]);

export function getSearchResults(database, query) {
    const results = [];
    const documentPaths = new Set();

    database.brands.forEach((brand, brandIndex) => {
        if (matches(brand.name, query)) {
            results.push({
                title: brand.name,
                subtitle: "Gamme",
                ref: { type: "brand", brandIndex }
            });
        }

        brand.categories.forEach((category, categoryIndex) => {
            if (matches(category.name, query)) {
                results.push({
                    title: category.name,
                    subtitle: `${brand.name} · Marque`,
                    ref: { type: "category", brandIndex, categoryIndex }
                });
            }

            category.products.forEach((product, productIndex) => {
                const ref = { type: "product", brandIndex, categoryIndex, productIndex };
                const searchable = [
                    brand.name,
                    category.name,
                    product.name,
                    product.reference,
                    ...(Array.isArray(product.keywords) ? product.keywords : [])
                ].join(" ");

                if (matches(searchable, query)) {
                    results.push({
                        title: product.name,
                        subtitle: `${brand.name} · ${category.name}`,
                        ref,
                        score: 10
                    });
                }

                (Array.isArray(product.documents) ? product.documents : []).forEach(documentPath => {
                    if (documentPaths.has(documentPath) || !matches(`${brand.name} ${category.name} ${product.name} ${documentPath}`, query)) {
                        return;
                    }

                    documentPaths.add(documentPath);
                    results.push({
                        type: "document",
                        title: formatDocumentTitle(documentPath),
                        subtitle: `${brand.name} · ${category.name} · ${product.name}`,
                        documentPath,
                        ref,
                        score: 100
                    });
                });
            });
        });
    });

    getSearchableClients().forEach(client => {
        const clientSearchable = [
            client.name,
            client.type,
            client.phone,
            client.email,
            client.address,
            client.city,
            client.equipment,
            client.notes
        ].join(" ");

        if (matches(clientSearchable, query)) {
            results.push({
                type: "client",
                title: client.name,
                subtitle: [client.type, client.city || client.address].filter(Boolean).join(" · ") || "Client",
                clientId: client.id,
                score: 70
            });
        }

        client.attachments.forEach(attachment => {
            if (!matches(`${client.name} ${attachment.type} ${attachment.name}`, query)) return;
            results.push({
                type: "clientAttachment",
                title: attachment.name,
                subtitle: `${attachment.type} · Client : ${client.name}`,
                clientId: client.id,
                score: 90
            });
        });
    });

    return results
        .sort((first, second) => (second.score || 0) - (first.score || 0))
        .slice(0, 40);
}

export function matches(value, query) {
    const queryTokens = getSearchTokens(query);
    if (!queryTokens.length) return false;

    const valueTokens = getSearchTokens(value);
    return queryTokens.every(queryToken => valueTokens.some(valueToken => tokensMatch(valueToken, queryToken)));
}

function getSearchTokens(value) {
    return normalizeText(value)
        .replace(/[^a-z0-9]+/g, " ")
        .split(/\s+/)
        .filter(token => token.length > 1 && !STOP_WORDS.has(token));
}

function tokensMatch(valueToken, queryToken) {
    if (valueToken.includes(queryToken) || queryToken.includes(valueToken)) return true;

    const valueStem = getStem(valueToken);
    const queryStem = getStem(queryToken);
    return valueStem.length >= 4 && queryStem.length >= 4 && (valueStem.startsWith(queryStem) || queryStem.startsWith(valueStem));
}

function getStem(token) {
    return token
        .replace(/(ations?|ements?|ions?|er|ez|es|s)$/i, "")
        .replace(/(.)\1+$/i, "$1");
}

function formatDocumentTitle(documentPath) {
    const fileName = String(documentPath || "").split("/").pop() || documentPath;
    return fileName
        .replace(/\.pdf$/i, "")
        .replace(/[_-]+/g, " ")
        .replace(/\b(ajouter|inversion|remplacer|supprimer|programmer)(une|du|des|la|le)\b/gi, "$1 $2")
        .replace(/\s+/g, " ")
        .trim();
}
