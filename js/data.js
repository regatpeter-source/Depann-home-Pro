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
                noticeUrl: ""
            };
        }

        return {
            name: product.name || `Produit ${index + 1}`,
            reference: product.reference || "",
            keywords: Array.isArray(product.keywords) ? product.keywords : [],
            documents: Array.isArray(product.documents) ? product.documents : [],
            noticeUrl: typeof product.noticeUrl === "string" ? product.noticeUrl : ""
        };
    });
}

function attachDocumentsFromManifest(database, manifest = []) {
    const items = Array.isArray(manifest) ? manifest : [];

    database.brands.forEach(brand => {
        brand.categories.forEach(category => {
            category.products.forEach(product => {
                const normalizedProduct = normalizeText(`${brand.name} ${category.name} ${product.name} ${product.reference || ""}`);

                const matchedDocuments = items.filter(entry => {
                    const normalizedEntry = normalizeText(entry.product || entry.reference || "");
                    return normalizedEntry && normalizedProduct.includes(normalizedEntry);
                }).map(entry => entry.path);

                if (matchedDocuments.length) {
                    product.documents = Array.from(new Set([...(product.documents || []), ...matchedDocuments]));
                }
            });
        });
    });
}

