import { normalizeText } from "./utils.js?v=44";

export function getSearchResults(database, query) {
    const results = [];

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
                        ref: { type: "product", brandIndex, categoryIndex, productIndex }
                    });
                }
            });
        });
    });

    return results.slice(0, 40);
}

export function matches(value, query) {
    return normalizeText(value).includes(normalizeText(query));
}
