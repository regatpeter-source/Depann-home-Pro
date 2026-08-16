let pdfJsPromise = null;

function loadPdfJs() {
    if (!pdfJsPromise) {
        pdfJsPromise = import("/vendor/pdfjs/build/pdf.min.mjs?v=5.4.54").then(pdfjs => {
            pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/build/pdf.worker.min.mjs?v=5.4.54";
            return pdfjs;
        });
    }
    return pdfJsPromise;
}

export async function renderLivePdfPreview(blob, container, signal) {
    if (signal?.aborted) throw abortError();
    const pdfjs = await loadPdfJs();
    const loadingTask = pdfjs.getDocument({
        data: new Uint8Array(await blob.arrayBuffer()),
        standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
        cMapUrl: "/vendor/pdfjs/cmaps/",
        cMapPacked: true,
        wasmUrl: "/vendor/pdfjs/wasm/"
    });
    const abort = () => loadingTask.destroy();
    signal?.addEventListener("abort", abort, { once: true });
    try {
        const pdf = await loadingTask.promise;
        const documentNode = document.createElement("div");
        documentNode.className = "pdf-live-document";
        const availableWidth = Math.max(320, container.clientWidth - 28);
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
            if (signal?.aborted) throw abortError();
            const page = await pdf.getPage(pageNumber);
            const initialViewport = page.getViewport({ scale: 1 });
            const viewport = page.getViewport({ scale: availableWidth / initialViewport.width });
            const pageNode = document.createElement("section");
            pageNode.className = "pdf-live-page";
            pageNode.dataset.pdfPage = String(pageNumber);
            const canvas = document.createElement("canvas");
            canvas.width = Math.floor(viewport.width * pixelRatio);
            canvas.height = Math.floor(viewport.height * pixelRatio);
            canvas.style.width = `${Math.floor(viewport.width)}px`;
            canvas.style.height = `${Math.floor(viewport.height)}px`;
            canvas.setAttribute("aria-label", `Page ${pageNumber} sur ${pdf.numPages}`);
            pageNode.append(canvas);
            documentNode.append(pageNode);
            await page.render({ canvasContext: canvas.getContext("2d"), viewport, transform: pixelRatio === 1 ? null : [pixelRatio, 0, 0, pixelRatio, 0, 0] }).promise;
        }
        if (signal?.aborted) throw abortError();
        const position = capturePdfPosition(container);
        container.replaceChildren(documentNode);
        restorePdfPosition(container, position);
    } catch (error) {
        if (signal?.aborted) throw abortError();
        throw error;
    } finally {
        signal?.removeEventListener("abort", abort);
    }
}

function capturePdfPosition(container) {
    const pages = [...container.querySelectorAll(".pdf-live-page")];
    const scrollTop = container.scrollTop;
    const page = pages.find(item => item.offsetTop + item.offsetHeight > scrollTop) || pages.at(-1);
    if (!page) return { pageNumber: 1, pageProgress: 0, scrollRatio: 0 };
    return {
        pageNumber: Number(page.dataset.pdfPage) || 1,
        pageProgress: Math.max(0, (scrollTop - page.offsetTop) / Math.max(page.offsetHeight, 1)),
        scrollRatio: scrollTop / Math.max(container.scrollHeight - container.clientHeight, 1)
    };
}

function restorePdfPosition(container, position) {
    const page = container.querySelector(`[data-pdf-page="${position.pageNumber}"]`);
    if (page) container.scrollTop = page.offsetTop + page.offsetHeight * position.pageProgress;
    else container.scrollTop = (container.scrollHeight - container.clientHeight) * position.scrollRatio;
}

function abortError() {
    return new DOMException("Actualisation remplacée", "AbortError");
}
