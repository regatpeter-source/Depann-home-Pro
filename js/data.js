import { DATA_VERSION } from "./config.js?v=77";
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
                const normalizedProduct = normalizeText(`${product.name} ${product.reference || ""}`);
                const compactProduct = compactText(normalizedProduct);
                const manufacturerPath = `assets/notices/${category.id}/`;
                const familyPath = category.id === "nice"
                    ? `${manufacturerPath}${brand.id === "portails" ? "portail" : "volet-roulant"}/`
                    : manufacturerPath;
                const hasExplicitNiceDocuments = category.id === "nice" && product.documents.length > 0;

                const matchedEntries = items.filter(entry => {
                    if (hasExplicitNiceDocuments) {
                        return false;
                    }

                    if (!entry.path.startsWith(familyPath)) {
                        return false;
                    }

                    const normalizedEntry = normalizeEntryText(entry);
                    if (!normalizedEntry) return false;

                    if (isImagePath(entry.path)) {
                        return false;
                    }

                    const compactEntry = compactText(normalizedEntry);
                    const entryTokens = tokenizeText(normalizedEntry);
                    const hasMultipleTokens = entryTokens.length > 1;

                    if (hasMultipleTokens && normalizedProduct.includes(normalizedEntry)) {
                        return true;
                    }

                    if (hasMultipleTokens && compactProduct.includes(compactEntry)) {
                        return true;
                    }

                    if (hasMultipleTokens && hasTokenMatch(normalizedEntry, normalizedProduct)) {
                        return true;
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

