import { DATA_VERSION } from "./config.js?v=44";
import { slugify } from "./utils.js?v=44";

export async function loadDatabase() {
    const response = await fetch(`data/database.json?v=${DATA_VERSION}`, { cache: "no-store" });

    if (!response.ok) {
        throw new Error(`Chargement impossible (${response.status})`);
    }

    return normalizeDatabase(await response.json());
}

export function normalizeDatabase(rawDatabase) {
    const sourceBrands = rawDatabase.brands || [];
    const embeddedBrands = sourceBrands.flatMap(brand =>
        (brand.categories || []).filter(category => category.id && Array.isArray(category.categories))
    );

    const prioritizedBrands = [...sourceBrands, ...embeddedBrands].map((brand, brandIndex) => ({
        __order: brandIndex,
        id: brand.id || slugify(brand.name || `marque-${brandIndex + 1}`),
        name: brand.name || `Marque ${brandIndex + 1}`,
        categories: normalizeCategories((brand.categories || []).filter(category => !category.id || !Array.isArray(category.categories)))
    }));

    prioritizedBrands.sort((a, b) => {
        const aIsServistores = a.id === "servistores";
        const bIsServistores = b.id === "servistores";

        if (aIsServistores && !bIsServistores) return -1;
        if (!aIsServistores && bIsServistores) return 1;
        return a.__order - b.__order;
    });

    return {
        brands: prioritizedBrands.map(({ __order, ...brand }) => brand)
    };
}

function normalizeCategories(categories = []) {
    return categories.map(category => {
        if (typeof category === "string") {
            return {
                name: category,
                products: []
            };
        }

        return {
            name: category.name || "Catégorie sans nom",
            products: normalizeProducts(category.products)
        };
    });
}

function normalizeProducts(products = []) {
    return products.map(product => ({
        name: product.name || "Produit sans nom",
        procedures: normalizeProcedures(product.procedures)
    }));
}

function normalizeProcedures(procedures = []) {
    return procedures.map(procedure => ({
        title: procedure.title || "Procédure sans titre",
        duration: procedure.duration || "Non renseigné",
        difficulty: procedure.difficulty || "Non renseignée",
        tools: Array.isArray(procedure.tools) ? procedure.tools : [],
        requirements: Array.isArray(procedure.requirements) ? procedure.requirements : [],
        steps: Array.isArray(procedure.steps) ? procedure.steps : [],
        notes: Array.isArray(procedure.notes) ? procedure.notes : [],
        photos: Array.isArray(procedure.photos) ? procedure.photos : [],
        documents: Array.isArray(procedure.documents) ? procedure.documents : [],
        videos: Array.isArray(procedure.videos) ? procedure.videos : []
    }));
}

export function countProcedures(database) {
    return database.brands.reduce((totalBrands, brand) => {
        return totalBrands + brand.categories.reduce((totalCategories, category) => {
            return totalCategories + category.products.reduce((totalProducts, product) => {
                return totalProducts + product.procedures.length;
            }, 0);
        }, 0);
    }, 0);
}
