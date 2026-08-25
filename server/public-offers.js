import { sendCommercialOfferRequestEmail } from "./email.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OFFER_TYPES = new Set(["basic", "basic-plus", "pro", "unsure"]);
const TEAM_SIZES = new Set(["1", "2-5", "6-10", "11-25", "26-plus"]);

export function registerPublicOfferRoutes(app) {
    app.post("/api/public/offer-requests", asyncHandler(async (request, response) => {
        const offerRequest = sanitizeOfferRequest(request.body);
        if (!offerRequest.ok) return response.status(400).json({ message: offerRequest.message });

        // Le champ leurre est invisible pour un visiteur, mais généralement rempli par les robots.
        if (offerRequest.website) return response.status(202).json(successPayload());

        try {
            await sendCommercialOfferRequestEmail(offerRequest);
        } catch (error) {
            console.warn("[public-offer-request] email unavailable", { code: error.code || "EMAIL_ERROR" });
            return response.status(503).json({ message: "Votre demande n’a pas pu être envoyée pour le moment. Réessayez dans quelques minutes ou écrivez à support@depannhomepro.com." });
        }
        return response.status(202).json(successPayload());
    }));
}

export function sanitizeOfferRequest(value) {
    const companyName = cleanText(value?.companyName, 160);
    const contactName = cleanText(value?.contactName, 100);
    const email = cleanText(value?.email, 160).toLowerCase();
    const phone = cleanText(value?.phone, 50);
    const teamSize = TEAM_SIZES.has(value?.teamSize) ? value.teamSize : "";
    const offer = OFFER_TYPES.has(value?.offer) ? value.offer : "";
    const message = cleanMessage(value?.message, 3000);
    const website = cleanText(value?.website, 300);
    const privacyConsent = value?.privacyConsent === true;

    if (!companyName || !contactName || !phone || !teamSize || !offer) return { ok: false, message: "Renseignez toutes les informations obligatoires." };
    if (!EMAIL_PATTERN.test(email)) return { ok: false, message: "Saisissez une adresse e-mail valide." };
    if (message.length < 10) return { ok: false, message: "Décrivez votre besoin en au moins 10 caractères." };
    if (!privacyConsent) return { ok: false, message: "Votre accord est nécessaire pour traiter et répondre à votre demande." };
    return { ok: true, companyName, contactName, email, phone, teamSize, offer, message, website, privacyConsent };
}

function successPayload() {
    return { message: "Merci, votre demande d’offre a bien été envoyée. Notre équipe vous recontactera prochainement." };
}

function cleanText(value, maximumLength) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximumLength);
}

function cleanMessage(value, maximumLength) {
    return String(value || "").replace(/\r\n/g, "\n").trim().slice(0, maximumLength);
}

function asyncHandler(handler) {
    return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}
