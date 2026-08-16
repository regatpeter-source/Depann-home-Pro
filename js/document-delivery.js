import { escapeHtml } from "./utils.js?v=44";

export function openDocumentDeliveryChoice({ label, recipient = "", printUrl, sendEmail }) {
    document.querySelector(".document-delivery-dialog")?.remove();
    const dialog = document.createElement("section");
    dialog.className = "document-delivery-dialog";
    dialog.innerHTML = `<div><header><div><p class="eyebrow">Document enregistré</p><h2>${escapeHtml(label || "Document")}</h2></div><button type="button" class="text-button" data-delivery-close>Plus tard</button></header><p>Souhaitez-vous envoyer ce document par e-mail ou l’ouvrir pour l’imprimer ?</p><p class="auth-message" aria-live="polite"></p><div class="document-delivery-actions"><button type="button" class="secondary-button" data-delivery-email>Envoyer par e-mail</button><button type="button" class="secondary-button" data-delivery-print>Imprimer / PDF</button><button type="button" class="text-button" data-delivery-close>Plus tard</button></div></div>`;
    document.body.append(dialog);
    const close = () => dialog.remove();
    dialog.querySelectorAll("[data-delivery-close]").forEach(button => button.addEventListener("click", close));
    dialog.addEventListener("click", event => { if (event.target === dialog) close(); });
    dialog.querySelector("[data-delivery-print]").addEventListener("click", () => {
        const popup = window.open(printUrl, "_blank");
        if (!popup) return alert("Autorisez les fenêtres pop-up pour ouvrir le document.");
        close();
    });
    dialog.querySelector("[data-delivery-email]").addEventListener("click", async event => {
        const destination = window.prompt("Adresse e-mail du destinataire :", recipient);
        if (destination === null) return;
        const email = destination.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return alert("Saisissez une adresse e-mail valide.");
        if (!confirm(`Envoyer « ${label} » à ${email} ?`)) return;
        const button = event.currentTarget;
        const feedback = dialog.querySelector(".auth-message");
        button.disabled = true;
        feedback.classList.remove("error");
        feedback.textContent = "Envoi en cours…";
        try {
            await sendEmail(email);
            close();
            alert("Document envoyé par e-mail.");
        } catch (error) {
            feedback.textContent = error.message || "Impossible d’envoyer le document par e-mail.";
            feedback.classList.add("error");
            button.disabled = false;
        }
    });
}
