import { normalizeText } from "./utils.js";

export function getSearchResults(database, query) {
    const results = [];

    database.brands.forEach((brand, brandIndex) => {
        if (matches(brand.name, query)) {
            results.push({
                icon: "🏷️",
                title: brand.name,
                subtitle: "Marque",
                ref: { type: "brand", brandIndex }
            });
        }

        brand.categories.forEach((category, categoryIndex) => {
            if (matches(`${brand.name} ${category.name}`, query)) {
                results.push({
                    icon: "📂",
                    title: category.name,
                    subtitle: `${brand.name} · Catégorie`,
                    ref: { type: "category", brandIndex, categoryIndex }
                });
            }

            category.products.forEach((product, productIndex) => {
                if (matches(`${brand.name} ${category.name} ${product.name}`, query)) {
                    results.push({
                        icon: "🔧",
                        title: product.name,
                        subtitle: `${brand.name} · ${category.name}`,
                        ref: { type: "product", brandIndex, categoryIndex, productIndex }
                    });
                }

                product.procedures.forEach((procedure, procedureIndex) => {
                    const searchable = [
                        brand.name,
                        category.name,
                        product.name,
                        procedure.title,
                        procedure.duration,
                        procedure.difficulty,
                        ...procedure.tools,
                        ...procedure.requirements,
                        ...procedure.steps,
                        ...procedure.notes
                    ].join(" ");

                    if (matches(searchable, query)) {
                        results.push({
                            icon: "📄",
                            title: procedure.title,
                            subtitle: `${brand.name} · ${product.name}`,
                            ref: { type: "procedure", brandIndex, categoryIndex, productIndex, procedureIndex }
                        });
                    }
                });
            });
        });
    });

    return results.slice(0, 40);
}

export function matches(value, query) {
    return normalizeText(value).includes(normalizeText(query));
}
