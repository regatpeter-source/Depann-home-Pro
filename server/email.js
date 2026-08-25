import nodemailer from "nodemailer";

export function isEmailDeliveryConfigured() {
    return ["BREVO_SMTP_HOST", "BREVO_SMTP_USER", "BREVO_SMTP_PASSWORD", "BREVO_SMTP_FROM"].every(name => {
        const value = String(process.env[name] || "");
        return value && !/votre|remplacez|choisissez/i.test(value);
    });
}

export async function sendDeviceVerificationCode({ recipient, name, code }) {
    return sendEmail({
        recipient,
        subject: "Code de connexion Depann'Home Pro",
        text: `Bonjour ${name || ""},\n\nVotre code de validation Depann'Home Pro est : ${code}\n\nIl expire dans 10 minutes. Ne le communiquez à personne.\n`,
        html: `<p>Bonjour ${escapeHtml(name || "")},</p><p>Votre code de validation Depann'Home Pro est :</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px">${code}</p><p>Il expire dans 10 minutes. Ne le communiquez à personne.</p>`
    });
}

export async function sendDocumentEmail({ recipient, recipientName, documentLabel, attachment }) {
    const greeting = recipientName ? `Bonjour ${recipientName},` : "Bonjour,";
    return sendEmail({
        recipient,
        subject: `${documentLabel} - Depann'Home Pro`,
        text: `${greeting}\n\nVeuillez trouver ${documentLabel.toLowerCase()} en pièce jointe.\n\nCordialement,`,
        html: `<p>${escapeHtml(greeting)}</p><p>Veuillez trouver ${escapeHtml(documentLabel.toLowerCase())} en pièce jointe.</p><p>Cordialement,</p>`,
        attachments: [attachment]
    });
}

export async function sendSupportRequestEmail({ senderName, senderEmail, senderUsername, message }) {
    const recipient = String(process.env.SUPPORT_EMAIL || "").trim();
    if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
        const error = new Error("L’adresse e-mail du support n’est pas configurée.");
        error.code = "SUPPORT_EMAIL_NOT_CONFIGURED";
        throw error;
    }

    const sender = senderName || senderUsername || "Technicien";
    const contact = senderEmail || "E-mail non renseigné";
    await sendEmail({
        recipient,
        subject: `Demande support Depann'Home Pro — ${sender}`,
        text: `Nouvelle demande de support\n\nTechnicien : ${sender}\nIdentifiant : ${senderUsername || "Non renseigné"}\nE-mail : ${contact}\n\nMessage :\n${message}`,
        html: `<p><strong>Nouvelle demande de support</strong></p><p><strong>Technicien :</strong> ${escapeHtml(sender)}<br><strong>Identifiant :</strong> ${escapeHtml(senderUsername || "Non renseigné")}<br><strong>E-mail :</strong> ${escapeHtml(contact)}</p><p><strong>Message :</strong><br>${escapeHtml(message).replace(/\n/g, "<br>")}</p>`,
        attachments: []
    });
}

export async function sendCommercialOfferRequestEmail({ companyName, contactName, email, phone, teamSize, offer, message }) {
    const offerLabel = ({ basic: "Basic", "basic-plus": "Basic+", pro: "Pro", unsure: "À conseiller" })[offer] || "À conseiller";
    const teamSizeLabel = ({ "1": "1 personne", "2-5": "2 à 5 personnes", "6-10": "6 à 10 personnes", "11-25": "11 à 25 personnes", "26-plus": "26 personnes ou plus" })[teamSize] || "Non renseigné";
    await sendEmail({
        recipient: "support@depannhomepro.com",
        replyTo: email,
        subject: `Demande d’offre Depann'Home Pro — ${companyName}`,
        text: `Nouvelle demande d’offre depuis depannhomepro.com\n\nEntreprise : ${companyName}\nContact : ${contactName}\nE-mail : ${email}\nTéléphone : ${phone}\nTaille de l’équipe : ${teamSizeLabel}\nOffre envisagée : ${offerLabel}\n\nBesoin :\n${message}`,
        html: `<p><strong>Nouvelle demande d’offre depuis depannhomepro.com</strong></p><p><strong>Entreprise :</strong> ${escapeHtml(companyName)}<br><strong>Contact :</strong> ${escapeHtml(contactName)}<br><strong>E-mail :</strong> ${escapeHtml(email)}<br><strong>Téléphone :</strong> ${escapeHtml(phone)}<br><strong>Taille de l’équipe :</strong> ${escapeHtml(teamSizeLabel)}<br><strong>Offre envisagée :</strong> ${escapeHtml(offerLabel)}</p><p><strong>Besoin :</strong><br>${escapeHtml(message).replace(/\n/g, "<br>")}</p>`
    });
}

async function sendEmail({ recipient, replyTo, subject, text, html, attachments = [] }) {
    if (!isEmailDeliveryConfigured()) {
        const error = new Error("L’envoi d’e-mails n’est pas configuré. Renseignez Brevo SMTP dans les variables d’environnement.");
        error.code = "SMTP_NOT_CONFIGURED";
        throw error;
    }

    const transporter = nodemailer.createTransport({
        host: process.env.BREVO_SMTP_HOST,
        port: Number(process.env.BREVO_SMTP_PORT || 587),
        secure: process.env.BREVO_SMTP_SECURE === "true",
        auth: { user: process.env.BREVO_SMTP_USER, pass: process.env.BREVO_SMTP_PASSWORD },
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 30_000
    });
    return transporter.sendMail({
        from: process.env.BREVO_SMTP_FROM,
        to: recipient,
        ...(replyTo ? { replyTo } : {}),
        subject,
        text,
        html,
        attachments
    });
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" })[character]);
}
