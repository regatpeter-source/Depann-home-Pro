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

export function mobileApplicationLinks() {
    let base;
    try {
        base = new URL(String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || ""));
    } catch {
        const error = new Error("Configurez PUBLIC_BASE_URL avec l’adresse publique de l’application pour partager le guide mobile.");
        error.code = "PUBLIC_BASE_URL_INVALID";
        error.status = 503;
        throw error;
    }
    const localDevelopment = process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
    if (base.username || base.password || (base.protocol !== "https:" && !(localDevelopment && base.protocol === "http:"))) {
        const error = new Error("L’adresse publique de l’application doit utiliser HTTPS, sans identifiants intégrés.");
        error.code = "PUBLIC_BASE_URL_INVALID";
        error.status = 503;
        throw error;
    }
    const installationUrl = new URL("/installer-mobile", base).href;
    const loginUrl = new URL("/connexion", base).href;
    return { installationUrl, loginUrl };
}

export function buildMobileWelcomeEmail({ recipient, name, username }) {
    const { installationUrl, loginUrl } = mobileApplicationLinks();
    return {
        recipient,
        subject: "Votre accès mobile Depann'Home Pro",
        text: `Bonjour ${name || ""},\n\nVotre accès Depann'Home Pro a été créé.\nIdentifiant : ${username}\n\nInstaller l’application sur Android ou iPhone : ${installationUrl}\nSe connecter : ${loginUrl}\n\nOuvrez le guide sur votre téléphone dans Chrome (Android) ou Safari (iPhone), puis confirmez l’ajout à l’écran d’accueil.\nVotre administrateur doit vous communiquer le mot de passe initial par un canal sécurisé distinct. Aucun mot de passe n’est envoyé dans cet e-mail.\nÀ la première connexion, l’entreprise doit autoriser votre appareil ; confirmez ensuite le code reçu par e-mail lorsque demandé.\nCe lien ne valide pas votre appareil et ne vous connecte pas automatiquement.\n`,
        html: `<p>Bonjour ${escapeHtml(name || "")},</p><p>Votre accès Depann'Home Pro a été créé.<br><strong>Identifiant :</strong> ${escapeHtml(username)}</p><p><a href="${escapeHtml(installationUrl)}">Installer l’application sur Android ou iPhone</a></p><p><a href="${escapeHtml(loginUrl)}">Se connecter</a></p><p>Ouvrez le guide sur votre téléphone dans Chrome (Android) ou Safari (iPhone), puis confirmez l’ajout à l’écran d’accueil.</p><p>Votre administrateur doit vous communiquer le mot de passe initial par un canal sécurisé distinct. Aucun mot de passe n’est envoyé dans cet e-mail.</p><p>À la première connexion, l’entreprise doit autoriser votre appareil ; confirmez ensuite le code reçu par e-mail lorsque demandé. Ce lien ne valide pas votre appareil et ne vous connecte pas automatiquement.</p>`
    };
}

export async function sendMobileWelcomeEmail(values) {
    const result = await sendEmail(buildMobileWelcomeEmail(values));
    if (!result.accepted?.length) {
        const error = new Error("Le service d’envoi a refusé l’e-mail d’accueil mobile.");
        error.code = "SMTP_RECIPIENT_REJECTED";
        throw error;
    }
    return result;
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

export async function sendCustomerPortalLinkEmail({ recipient, recipientName, url, expiresAt, documentLabels }) {
    const greeting = recipientName ? `Bonjour ${recipientName},` : "Bonjour,";
    const documents = documentLabels.join(", ");
    const expiry = new Date(expiresAt).toLocaleDateString("fr-FR");
    const safeUrl = escapeHtml(url);
    return sendEmail({
        recipient,
        subject: "Vos documents Depann'Home Pro",
        text: `${greeting}\n\nVos documents sont disponibles sur le portail client sécurisé jusqu’au ${expiry} :\n${url}\n\nDocuments : ${documents}\n\nCordialement,`,
        html: `<p>${escapeHtml(greeting)}</p><p>Vos documents sont disponibles sur le portail client sécurisé jusqu’au ${escapeHtml(expiry)}.</p><p><a href="${safeUrl}">Consulter mes documents</a></p><p>Documents : ${escapeHtml(documents)}</p><p>Cordialement,</p>`
    });
}

export async function sendCustomerQuoteDecisionEmail({ recipient, documentNumber, clientName, decision, signerName, signerEmail, message, decidedAt }) {
    const decisionLabel = decision === "accepted" ? "accepté" : "refusé";
    const details = [
        `Devis : ${documentNumber}`,
        `Client : ${clientName}`,
        `Décision : ${decisionLabel}`,
        `Nom saisi : ${signerName}`,
        `E-mail saisi : ${signerEmail || "non renseigné"}`,
        `Date : ${new Date(decidedAt).toLocaleString("fr-FR")}`,
        `Message : ${message || "aucun"}`
    ].join("\n");
    return sendEmail({
        recipient,
        subject: `Décision client sur le devis ${documentNumber}`,
        text: `Une décision a été enregistrée dans le portail client.\n\n${details}\n\nCette décision par clic ne constitue pas une signature électronique certifiée.`,
        html: `<p>Une décision a été enregistrée dans le portail client.</p><p><strong>Devis :</strong> ${escapeHtml(documentNumber)}<br><strong>Client :</strong> ${escapeHtml(clientName)}<br><strong>Décision :</strong> ${escapeHtml(decisionLabel)}<br><strong>Nom saisi :</strong> ${escapeHtml(signerName)}<br><strong>E-mail saisi :</strong> ${escapeHtml(signerEmail || "non renseigné")}<br><strong>Date :</strong> ${escapeHtml(new Date(decidedAt).toLocaleString("fr-FR"))}<br><strong>Message :</strong> ${escapeHtml(message || "aucun")}</p><p>Cette décision par clic ne constitue pas une signature électronique certifiée.</p>`
    });
}

export async function sendSupportRequestEmail({ senderName, senderEmail, senderUsername, message }) {
    const sender = senderName || senderUsername || "Technicien";
    const contact = senderEmail || "E-mail non renseigné";
    await sendEmail({
        recipient: supportRecipient(),
        subject: `Demande support Depann'Home Pro — ${sender}`,
        text: `Nouvelle demande de support\n\nTechnicien : ${sender}\nIdentifiant : ${senderUsername || "Non renseigné"}\nE-mail : ${contact}\n\nMessage :\n${message}`,
        html: `<p><strong>Nouvelle demande de support</strong></p><p><strong>Technicien :</strong> ${escapeHtml(sender)}<br><strong>Identifiant :</strong> ${escapeHtml(senderUsername || "Non renseigné")}<br><strong>E-mail :</strong> ${escapeHtml(contact)}</p><p><strong>Message :</strong><br>${escapeHtml(message).replace(/\n/g, "<br>")}</p>`,
        attachments: []
    });
}

export async function sendPartnershipRequestEmail({ requestId, companyName, organizationType, contactName, contactRole, email, phone, website, message }) {
    const websiteLabel = website || "Non renseigné";
    await sendEmail({
        recipient: supportRecipient(),
        replyTo: email,
        subject: `Demande de partenariat Depann'Home Pro — ${companyName}`,
        text: `Nouvelle demande de partenariat\n\nRéférence : #${requestId}\nOrganisation : ${companyName}\nType : ${organizationType}\nContact : ${contactName}\nFonction : ${contactRole}\nE-mail : ${email}\nTéléphone : ${phone}\nSite internet : ${websiteLabel}\n\nProjet ou besoin :\n${message}`,
        html: `<p><strong>Nouvelle demande de partenariat</strong></p><p><strong>Référence :</strong> #${escapeHtml(requestId)}<br><strong>Organisation :</strong> ${escapeHtml(companyName)}<br><strong>Type :</strong> ${escapeHtml(organizationType)}<br><strong>Contact :</strong> ${escapeHtml(contactName)}<br><strong>Fonction :</strong> ${escapeHtml(contactRole)}<br><strong>E-mail :</strong> ${escapeHtml(email)}<br><strong>Téléphone :</strong> ${escapeHtml(phone)}<br><strong>Site internet :</strong> ${escapeHtml(websiteLabel)}</p><p><strong>Projet ou besoin :</strong><br>${escapeHtml(message).replace(/\n/g, "<br>")}</p>`
    });
}

export async function sendSubscriptionChangeRequestEmail({ requestId, companyName, contactName, email, currentTier, requestedTier, requestedPcSeats, requestedMobileSeats, message }) {
    const contact = contactName || "Non renseigné";
    const contactEmail = email || "Non renseigné";
    const companyMessage = message || "Aucun message complémentaire";
    await sendEmail({
        recipient: supportRecipient(),
        ...(email ? { replyTo: email } : {}),
        subject: `Demande d’offre ou de postes — ${companyName}`,
        text: `Nouvelle demande d’offre ou de postes\n\nRéférence : #${requestId}\nEntreprise : ${companyName}\nContact : ${contact}\nE-mail : ${contactEmail}\nOffre actuelle : ${currentTier}\nOffre demandée : ${requestedTier}\nPostes administratifs demandés : ${requestedPcSeats}\nPostes mobiles demandés : ${requestedMobileSeats}\n\nMessage :\n${companyMessage}`,
        html: `<p><strong>Nouvelle demande d’offre ou de postes</strong></p><p><strong>Référence :</strong> #${escapeHtml(requestId)}<br><strong>Entreprise :</strong> ${escapeHtml(companyName)}<br><strong>Contact :</strong> ${escapeHtml(contact)}<br><strong>E-mail :</strong> ${escapeHtml(contactEmail)}<br><strong>Offre actuelle :</strong> ${escapeHtml(currentTier)}<br><strong>Offre demandée :</strong> ${escapeHtml(requestedTier)}<br><strong>Postes administratifs demandés :</strong> ${escapeHtml(requestedPcSeats)}<br><strong>Postes mobiles demandés :</strong> ${escapeHtml(requestedMobileSeats)}</p><p><strong>Message :</strong><br>${escapeHtml(companyMessage).replace(/\n/g, "<br>")}</p>`
    });
}

export async function sendCommercialOfferRequestEmail({ companyName, contactName, email, phone, teamSize, offer, message }) {
    const offerLabel = ({ "demo-15-days": "Démo gratuite 15 jours", basic: "Basic", "basic-plus": "Basic+", pro: "Pro", partnership: "Demande de partenariat", unsure: "À conseiller" })[offer] || "À conseiller";
    const teamSizeLabel = ({ "1": "1 personne", "2-5": "2 à 5 personnes", "6-10": "6 à 10 personnes", "11-25": "11 à 25 personnes", "26-plus": "26 personnes ou plus" })[teamSize] || "Non renseigné";
    await sendEmail({
        recipient: supportRecipient(),
        replyTo: email,
        subject: `Demande d’offre Depann'Home Pro — ${companyName}`,
        text: `Nouvelle demande d’offre depuis depannhomepro.com\n\nEntreprise : ${companyName}\nContact : ${contactName}\nE-mail : ${email}\nTéléphone : ${phone}\nTaille de l’équipe : ${teamSizeLabel}\nOffre envisagée : ${offerLabel}\n\nBesoin :\n${message}`,
        html: `<p><strong>Nouvelle demande d’offre depuis depannhomepro.com</strong></p><p><strong>Entreprise :</strong> ${escapeHtml(companyName)}<br><strong>Contact :</strong> ${escapeHtml(contactName)}<br><strong>E-mail :</strong> ${escapeHtml(email)}<br><strong>Téléphone :</strong> ${escapeHtml(phone)}<br><strong>Taille de l’équipe :</strong> ${escapeHtml(teamSizeLabel)}<br><strong>Offre envisagée :</strong> ${escapeHtml(offerLabel)}</p><p><strong>Besoin :</strong><br>${escapeHtml(message).replace(/\n/g, "<br>")}</p>`
    });
}

export async function sendEmail({ recipient, replyTo, subject, text, html, attachments = [], inReplyTo, references, headers }) {
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
        attachments,
        ...(inReplyTo ? { inReplyTo } : {}),
        ...(references ? { references } : {}),
        ...(headers ? { headers } : {})
    });
}

function supportRecipient() {
    const recipient = String(process.env.SUPPORT_EMAIL || "").trim();
    if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
        const error = new Error("L’adresse e-mail du support n’est pas configurée.");
        error.code = "SUPPORT_EMAIL_NOT_CONFIGURED";
        throw error;
    }
    return recipient;
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" })[character]);
}
