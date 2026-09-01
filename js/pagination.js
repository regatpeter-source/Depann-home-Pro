export const BUSINESS_PAGE_SIZES = [10, 20, 30, 100];

export function pageSizeOptions(selected, itemLabel = "éléments") {
    return BUSINESS_PAGE_SIZES.map(size => `<option value="${size}" ${Number(selected) === size ? "selected" : ""}>${size} ${itemLabel}</option>`).join("");
}

export function paginateItems(items, state) {
    const pageSize = BUSINESS_PAGE_SIZES.includes(Number(state.pageSize)) ? Number(state.pageSize) : 20;
    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(1, Number(state.page) || 1), totalPages);
    const start = (page - 1) * pageSize;
    Object.assign(state, { page, pageSize });
    return { items: items.slice(start, start + pageSize), page, pageSize, start, total, totalPages };
}

export function renderBusinessPagination(node, pagination, options = {}) {
    if (!node) return;
    const singular = options.singular || "élément";
    const plural = options.plural || `${singular}s`;
    const first = pagination.total ? pagination.start + 1 : 0;
    const last = Math.min(pagination.start + pagination.pageSize, pagination.total);
    const pages = paginationPages(pagination.page, pagination.totalPages);
    node.innerHTML = `<span>${first}–${last} sur ${pagination.total} ${pagination.total > 1 ? plural : singular}</span><div><button type="button" class="secondary-button" data-business-page="${pagination.page - 1}" ${pagination.page <= 1 ? "disabled" : ""}>Précédente</button>${pages.map(page => page === "…" ? '<span class="business-page-gap" aria-hidden="true">…</span>' : `<button type="button" class="secondary-button${page === pagination.page ? " active" : ""}" data-business-page="${page}" ${page === pagination.page ? 'aria-current="page"' : ""}>${page}</button>`).join("")}<button type="button" class="secondary-button" data-business-page="${pagination.page + 1}" ${pagination.page >= pagination.totalPages ? "disabled" : ""}>Suivante</button></div>`;
    node.querySelectorAll("[data-business-page]:not([disabled])").forEach(button => button.addEventListener("click", () => options.onPageChange?.(Number(button.dataset.businessPage))));
}

export function paginationPages(current, total) {
    if (total <= 7) return Array.from({ length: total }, (_value, index) => index + 1);
    const pages = [...new Set([1, 2, current - 1, current, current + 1, total - 1, total].filter(page => page >= 1 && page <= total))].sort((first, second) => first - second);
    return pages.flatMap((page, index) => index && page - pages[index - 1] > 1 ? ["…", page] : [page]);
}
