import nodemailer from "nodemailer";

function smtpConfigured() {
    return ["BREVO_SMTP_HOST", "BREVO_SMTP_USER", "BREVO_SMTP_PASSWORD", "BREVO_SMTP_FROM"].every(name => {
        const value = String(process.env[name] || "");
        return value && !/votre|remplacez|choisissez/i.test(value);
    });
}

export async function sendDeviceVerificationCode({ recipient, name, code }) {
    await sendEmail({
        recipient,
        subject: "Code de connexion Depann'Home Pro",
        text: `Bonjour ${name || ""},\n\nVotre code de validation Depann'Home Pro est : ${code}\n\nIl expire dans 10 minutes. Ne le communiquez à personne.\n`,
        html: `<p>Bonjour ${escapeHtml(name || "")},</p><p>Votre code de validation Depann'Home Pro est :</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px">${code}</p><p>Il expire dans 10 minutes. Ne le communiquez à personne.</p>`
    });
}

export async function sendDocumentEmail({ recipient, recipientName, documentLabel, attachment }) {
    const greeting = recipientName ? `Bonjour ${recipientName},` : "Bonjour,";
    await sendEmail({
        recipient,
        subject: `${documentLabel} - Depann'Home Pro`,
        text: `${greeting}\n\nVeuillez trouver ${documentLabel.toLowerCase()} en pièce jointe.\n\nCordialement,`,
        html: `<p>${escapeHtml(greeting)}</p><p>Veuillez trouver ${escapeHtml(documentLabel.toLowerCase())} en pièce jointe.</p><p>Cordialement,</p>`,
        attachments: [attachment]
    });
}

async function sendEmail({ recipient, subject, text, html, attachments = [] }) {
    if (!smtpConfigured()) {
        const error = new Error("L’envoi d’e-mails n’est pas configuré. Renseignez Brevo SMTP dans les variables d’environnement.");
        error.code = "SMTP_NOT_CONFIGURED";
        throw error;
    }

    const transporter = nodemailer.createTransport({
        host: process.env.BREVO_SMTP_HOST,
        port: Number(process.env.BREVO_SMTP_PORT || 587),
        secure: process.env.BREVO_SMTP_SECURE === "true",
        auth: { user: process.env.BREVO_SMTP_USER, pass: process.env.BREVO_SMTP_PASSWORD }
    });
    await transporter.sendMail({
        from: process.env.BREVO_SMTP_FROM,
        to: recipient,
        subject,
        text,
        html,
        attachments
    });
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" })[character]);
}
