import { sendSupportRequestEmail } from "./email.js";

const MAX_SUPPORT_MESSAGE_LENGTH = 4000;

export function registerSupportRoutes(app, requireAuthentication) {
    app.post("/api/support/requests", requireAuthentication, asyncHandler(async (request, response) => {
        const message = cleanMessage(request.body?.message);
        if (message.length < 10) {
            return response.status(400).json({ message: "Décrivez votre demande en au moins 10 caractères." });
        }

        await sendSupportRequestEmail({
            senderName: cleanText(request.user?.fullName, 100),
            senderEmail: cleanText(request.user?.email, 160),
            senderUsername: cleanText(request.user?.username, 32),
            message
        });
        response.status(202).json({ message: "Votre message est envoyé et sera traité dans les meilleurs délais." });
    }));
}

function cleanMessage(value) {
    return String(value || "").replace(/\r\n/g, "\n").trim().slice(0, MAX_SUPPORT_MESSAGE_LENGTH);
}

function cleanText(value, maximumLength) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximumLength);
}

function asyncHandler(handler) {
    return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}