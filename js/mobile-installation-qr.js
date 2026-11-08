export async function renderMobileInstallationQr(container) {
    container.classList.add("mobile-installation-qr");
    container.innerHTML = '<p class="auth-message" role="status" aria-live="polite">Préparation du QR code d’installation…</p>';
    const feedback = container.querySelector(".auth-message");
    try {
        const response = await fetch("/api/auth/mobile-installation", { credentials: "same-origin", cache: "no-store" });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.message || "Le QR code d’installation est indisponible.");
        const url = new URL(payload.installationUrl);
        const safeProtocol = url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
        if (!safeProtocol || url.username || url.password || url.pathname !== "/installer-mobile"
            || url.search || url.hash || typeof payload.qrCodeDataUrl !== "string" || !payload.qrCodeDataUrl.startsWith("data:image/png;base64,")) {
            throw new Error("Le QR code d’installation reçu est invalide.");
        }
        const image = document.createElement("img");
        image.src = payload.qrCodeDataUrl;
        image.alt = "QR code pour ouvrir le guide d’installation Depann’Home Pro sur votre téléphone";
        image.width = 260;
        image.height = 260;
        const link = document.createElement("a");
        link.href = url.href;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = url.href;
        feedback.textContent = "Scannez ce QR code avec l’appareil photo de votre téléphone. Il ouvre uniquement le guide : aucun compte n’est connecté ou autorisé.";
        container.append(image, link);
    } catch (error) {
        console.warn("[mobile-installation-qr] unavailable", error.name);
        feedback.textContent = error.message || "Le QR code d’installation est indisponible.";
        feedback.classList.add("error");
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "secondary-button";
        retry.textContent = "Réessayer le QR code";
        retry.addEventListener("click", () => renderMobileInstallationQr(container));
        container.appendChild(retry);
    }
}

export function showMobileInstallationQr() {
    const dialog = document.createElement("dialog");
    dialog.className = "device-management-dialog";
    dialog.setAttribute("aria-label", "Installer l’application mobile par QR code");
    dialog.innerHTML = '<div class="device-management-heading"><div><p class="eyebrow">Application mobile</p><h2>Installer sur un téléphone</h2><p class="muted">L’e-mail et la validation habituelle de l’appareil restent obligatoires.</p></div><button type="button" class="secondary-button" data-close-mobile-qr>Fermer</button></div><div data-mobile-qr></div>';
    dialog.querySelector("[data-close-mobile-qr]").addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    document.body.appendChild(dialog);
    dialog.showModal();
    void renderMobileInstallationQr(dialog.querySelector("[data-mobile-qr]"));
}
