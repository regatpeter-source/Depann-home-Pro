export const state = {
    brand: null,
    category: null,
    product: null,
    procedure: null,
    view: "home"
};

export function resetSelection(level = "all") {
    if (level === "all") state.brand = null;
    if (["all", "brand"].includes(level)) state.category = null;
    if (["all", "brand", "category"].includes(level)) state.product = null;
    if (["all", "brand", "category", "product"].includes(level)) state.procedure = null;
}
