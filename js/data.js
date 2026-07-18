import { DATA_VERSION } from "./config.js?v=44";
import { slugify, normalizeText } from "./utils.js?v=44";

export async function loadDatabase() {
    const [databaseResponse, manifestResponse] = await Promise.all([
        fetch(`data/database.json?v=${DATA_VERSION}`, { cache: "no-store" }),
        fetch(`assets/notices/manifest.json?v=${DATA_VERSION}`, { cache: "no-store" }).catch(() => null)
    ]);

    if (!databaseResponse.ok) {
        throw new Error(`Chargement impossible (${databaseResponse.status})`);
    }

    const rawDatabase = await databaseResponse.json();
    const manifest = manifestResponse?.ok ? await manifestResponse.json() : [];

    return normalizeDatabase(rawDatabase, manifest);
}

export function normalizeDatabase(rawDatabase, noticeManifest = []) {
    const normalized = {
        brands: normalizeBrands(rawDatabase.brands || [])
    };

    attachDocumentsFromManifest(normalized, noticeManifest);

    return normalized;
}

function normalizeBrands(brands = []) {
    return brands.map((brand, index) => normalizeBrand(brand, index));
}

function normalizeBrand(brand, index) {
    if (typeof brand === "string") {
        return {
            id: slugify(brand),
            name: brand,
            categories: []
        };
    }

    return {
        id: brand.id || slugify(brand.name || `marque-${index + 1}`),
        name: brand.name || `Marque ${index + 1}`,
        categories: normalizeCategories(brand.categories || [])
    };
}

function normalizeCategories(categories = []) {
    return categories.map((category, index) => {
        if (typeof category === "string") {
            return {
                id: slugify(category),
                name: category,
                categories: [],
                products: []
            };
        }

        return {
            id: category.id || slugify(category.name || `categorie-${index + 1}`),
            name: category.name || `Catégorie ${index + 1}`,
            categories: normalizeCategories(category.categories || []),
            products: normalizeProducts(category.products || [])
        };
    });
}

function normalizeProducts(products = []) {
    return products.map((product, index) => {
        if (typeof product === "string") {
            return {
                name: product,
                reference: "",
                keywords: [],
                documents: [],
                photos: [],
                displayAsVisualGallery: false,
                previewDirectory: "",
                noticeUrl: ""
            };
        }

        return {
            name: product.name || `Produit ${index + 1}`,
            reference: product.reference || "",
            keywords: Array.isArray(product.keywords) ? product.keywords : [],
            documents: Array.isArray(product.documents) ? product.documents : [],
            photos: Array.isArray(product.photos) ? product.photos : [],
            displayAsVisualGallery: product.displayAsVisualGallery === true,
            previewDirectory: typeof product.previewDirectory === "string" ? product.previewDirectory : "",
            noticeUrl: typeof product.noticeUrl === "string" ? product.noticeUrl : ""
        };
    });
}

function isImagePath(filePath) {
    return /\.(png|jpe?g|webp|svg)$/i.test(filePath);
}

function isRemoteControlImage(entry) {
    return isImagePath(entry.path) && /\b(keypad|smoove|situo|telis|telecommande)\b/i.test(entry.product || entry.reference || entry.path);
}

function compactText(value) {
    return normalizeText(value).replace(/\s+/g, "");
}

function normalizeEntryText(entry) {
    const raw = normalizeText(entry.product || entry.reference || "");
    return raw
        .replace(/^\d+[a-z]?/, "")
        .replace(/^[0-9]+/, "")
        .replace(/^c\s+/i, "")
        .replace(/^cl\s+/i, "")
        .replace(/\b(fr|web|pdf|notice|notices|utilisation|installation|moteur|coulissant|portail|utilisati)\b/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function tokenizeText(value) {
    return normalizeText(value)
        .replace(/\s+/g, " ")
        .trim()
        .split(" ")
        .filter(Boolean);
}

function hasTokenMatch(entryText, normalizedProduct) {
    const entryTokens = tokenizeText(entryText);
    const productTokens = tokenizeText(normalizedProduct);
    const matched = entryTokens.filter(token => productTokens.includes(token));
    return matched.length >= Math.min(2, entryTokens.length);
}

function imageEntryMatchesProduct(entryText, normalizedProduct) {
    if (!entryText) return false;

    const brandMatch = normalizedProduct.includes("somfy") && entryText.includes("somfy");
    const ioMatch = normalizedProduct.includes("io") && entryText.includes("io");
    const rtsMatch = normalizedProduct.includes("rts") && entryText.includes("rts");
    const keypadMatch = normalizedProduct.includes("io") && entryText.includes("keypad");
    const smooveMatch = normalizedProduct.includes("io") && entryText.includes("smoove");
    const situoMatch = normalizedProduct.includes("rts") && entryText.includes("situo");

    if (brandMatch && (ioMatch || rtsMatch || keypadMatch || smooveMatch || situoMatch)) {
        return true;
    }

    if (ioMatch && entryText.includes("io")) return true;
    if (rtsMatch && entryText.includes("rts")) return true;

    return false;
}

function getNoticeKeywords(entry) {
    const entryText = normalizeEntryText(entry);
    return entryText
        .split(/\s+/)
        .filter(token => Boolean(token) && !["notice", "notices", "installation", "utilisation", "utilisation", "pdf", "fr", "web", "moteur", "coulissant", "slidymoove", "sld3000"].includes(token));
}

function attachDocumentsFromManifest(database, manifest = []) {
    const items = Array.isArray(manifest) ? manifest : [];

    database.brands.forEach(brand => {
        brand.categories.forEach(category => {
            category.products.forEach(product => {
                const normalizedProduct = normalizeText(`${brand.name} ${category.name} ${product.name} ${product.reference || ""}`);
                const compactProduct = compactText(normalizedProduct);
                const canMatchRemoteControlImages = brand.id === "volets-roulants" && category.id === "somfy";

                const matchedEntries = items.filter(entry => {
                    const normalizedEntry = normalizeEntryText(entry);
                    if (!normalizedEntry) return false;

                    if (!canMatchRemoteControlImages && isRemoteControlImage(entry)) {
                        return false;
                    }

                    const compactEntry = compactText(normalizedEntry);

                    if (normalizedProduct.includes(normalizedEntry) || normalizedEntry.includes(normalizedProduct)) {
                        return true;
                    }

                    if (compactProduct.includes(compactEntry) || compactEntry.includes(compactProduct)) {
                        return true;
                    }

                    if (hasTokenMatch(normalizedEntry, normalizedProduct)) {
                        return true;
                    }

                    if (canMatchRemoteControlImages && isImagePath(entry.path)) {
                        return imageEntryMatchesProduct(normalizedEntry, normalizedProduct);
                    }

                    return false;
                });

                const matchedDocuments = matchedEntries
                    .filter(entry => !isImagePath(entry.path))
                    .map(entry => entry.path);

                const matchedPhotos = matchedEntries
                    .filter(entry => isImagePath(entry.path))
                    .map(entry => entry.path);

                const matchedKeywords = matchedEntries
                    .flatMap(getNoticeKeywords)
                    .filter(Boolean);

                if (matchedDocuments.length) {
                    product.documents = Array.from(new Set([...(product.documents || []), ...matchedDocuments]));
                }

                if (matchedPhotos.length) {
                    product.photos = Array.from(new Set([...(product.photos || []), ...matchedPhotos]));
                }

                if (matchedKeywords.length) {
                    product.keywords = Array.from(new Set([...(product.keywords || []), ...matchedKeywords]));
                }
            });
        });
    });
}

