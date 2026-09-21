import { escapeHtml } from "./utils.js?v=44";

export function openDocumentDeliveryChoice({ label, recipient = "", printUrl, sendEmail, markHandDelivered }) {
    document.querySelector(".document-delivery-dialog")?.remove();
    const dialog = document.createElement("section");
    dialog.className = "document-delivery-dialog";
    dialog.innerHTML = `<div><header><div><p class="eyebrow">Document enregistré</p><h2>${escapeHtml(label || "Document")}</h2></div><button type="button" class="text-button" data-delivery-close>Plus tard</button></header><p>Choisissez comment ce document est remis à son destinataire.</p><p class="auth-message" aria-live="polite"></p><div class="document-delivery-actions"><button type="button" class="secondary-button" data-delivery-email>Envoyer par e-mail</button><button type="button" class="secondary-button" data-delivery-print>Imprimer / PDF</button>${markHandDelivered ? '<button type="button" class="secondary-button" data-delivery-hand>Marquer « remis en main propre »</button>' : ""}<button type="button" class="text-button" data-delivery-close>Plus tard</button></div></div>`;
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
    dialog.querySelector("[data-delivery-hand]")?.addEventListener("click", async event => {
        if (!confirm(`Confirmer la remise en main propre de « ${label} » ? Cette action ne vaut pas encaissement.`)) return;
        const button = event.currentTarget;
        const feedback = dialog.querySelector(".auth-message");
        button.disabled = true;
        feedback.classList.remove("error");
        feedback.textContent = "Enregistrement de la remise…";
        try {
            await markHandDelivered();
            close();
            alert("Document marqué comme remis en main propre.");
        } catch (error) {
            feedback.textContent = error.message || "Impossible d’enregistrer la remise en main propre.";
            feedback.classList.add("error");
            button.disabled = false;
        }
    });
}
