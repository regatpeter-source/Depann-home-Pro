import { escapeHtml } from "./utils.js?v=44";

let activeSettingsCard = null;

export async function renderPartnerEmailSettings(container) {
    const card = document.createElement("article");
    card.className = "brand-card full-card procedure-card partner-email-settings-card";
    card.innerHTML = '<section class="partner-email-panel"><p class="muted">Chargement de la configuration de la boîte professionnelle…</p></section>';
    container.appendChild(card);
    activeSettingsCard = card;
    await loadPartnerEmailSettings(card);
}

async function loadPartnerEmailSettings(card) {
    const result = await api("/api/partner-email");
    if (!result.ok) {
        card.innerHTML = `<section class="partner-email-panel"><p class="auth-message error">${escapeHtml(result.message || "Impossible de charger la configuration de la boîte professionnelle.")}</p></section>`;
        return;
    }
    renderSettings(card, result.data || { connections: [], oauth: {} });
}

function renderSettings(card, mailbox) {
    card.innerHTML = `<section class="partner-email-panel"><div class="form-heading"><div><p class="eyebrow">Réception de missions par e-mail</p><h2>Boîte mail professionnelle</h2></div></div><p class="muted">Microsoft 365 et Google utilisent OAuth : Depann’Home Pro ne connaît jamais votre mot de passe. Pour OVH ou un autre hébergeur, créez un mot de passe d’application IMAP/SMTP.</p><div class="form-grid partner-email-oauth-options"><label>Détection après connexion<select id="partnerEmailOauthMode"><option value="manual">Sélection manuelle</option><option value="automatic">Automatique stricte</option></select></label><label class="form-wide">Expéditeurs ou domaines autorisés<textarea id="partnerEmailOauthSenders" rows="2" placeholder="missions@partenaire.fr, partenaire.fr"></textarea></label><label class="creator-switch form-wide"><input id="partnerEmailOauthStatuses" type="checkbox"><span>Envoyer les changements de statut dans le fil d’origine.</span></label></div><div class="partner-email-provider-actions"><button class="secondary-button" data-email-oauth="microsoft" ${mailbox.oauth?.microsoft ? "" : "disabled"}>Connecter Microsoft 365</button><button class="secondary-button" data-email-oauth="google" ${mailbox.oauth?.google ? "" : "disabled"}>Connecter Google Workspace</button></div>${!mailbox.oauth?.microsoft || !mailbox.oauth?.google ? '<p class="auth-message">Les boutons désactivés nécessitent la configuration OAuth correspondante sur le serveur.</p>' : ""}<form class="client-form" id="partnerEmailImapForm"><h3>OVH ou serveur IMAP/SMTP</h3><div class="form-grid"><label>Nom affiché<input name="displayName" maxlength="160" placeholder="Service missions"></label><label>Adresse e-mail *<input name="emailAddress" type="email" required></label><label>Utilisateur IMAP/SMTP *<input name="username" required></label><label>Mot de passe d’application *<input name="password" type="password" required autocomplete="new-password"></label><label>Serveur IMAP *<input name="imapHost" required placeholder="ssl0.ovh.net"></label><label>Port IMAP<input name="imapPort" type="number" min="1" max="65535" value="993"></label><label>Serveur SMTP *<input name="smtpHost" required placeholder="ssl0.ovh.net"></label><label>Port SMTP<input name="smtpPort" type="number" min="1" max="65535" value="465"></label><label>Sécurité SMTP<select name="smtpSecure"><option value="true">TLS direct (souvent port 465)</option><option value="false">STARTTLS obligatoire (souvent port 587)</option></select></label><label>Détection<select name="selectionMode"><option value="manual">Sélection manuelle</option><option value="automatic">Automatique stricte</option></select></label><label>Seuil automatique<input name="automaticThreshold" type="number" min="70" max="100" value="80"></label><label class="form-wide">Expéditeurs ou domaines autorisés<textarea name="allowedSenders" rows="3" placeholder="missions@partenaire.fr, partenaire.fr"></textarea><small>Un expéditeur autorisé renforce le score ; il ne suffit jamais à lui seul à créer une mission.</small></label><label class="creator-switch form-wide"><input name="sendStatusUpdates" type="checkbox"><span>Répondre automatiquement au fil d’origine lors des changements de statut.</span></label></div><div class="form-actions"><button class="secondary-button">Tester et connecter</button></div><p class="auth-message" aria-live="polite"></p></form><section class="partner-email-connections"><h3>Boîtes connectées</h3>${mailbox.connections?.length ? mailbox.connections.map(emailConnectionCard).join("") : '<p class="muted">Aucune boîte professionnelle connectée.</p>'}</section></section>`;
    card.querySelector(".partner-email-oauth-options")?.insertAdjacentHTML("beforeend", '<label class="creator-switch form-wide"><input id="partnerEmailOauthAutoSearch" type="checkbox"><span>Activer la recherche automatique des missions sur cette boîte.</span></label>');
    card.querySelector("#partnerEmailImapForm .form-grid")?.insertAdjacentHTML("beforeend", '<label class="creator-switch form-wide"><input name="autoSearchEnabled" type="checkbox"><span>Activer la recherche automatique des missions sur cette boîte.</span></label>');
    const providerHelp = card.querySelector(".partner-email-panel > .muted");
    if (providerHelp) providerHelp.textContent = "Microsoft 365 et Google Workspace utilisent OAuth. Gmail personnel utilise un mot de passe d’application. OVH, Zimbra, Namecheap et les autres hébergeurs se connectent avec leurs paramètres IMAP/SMTP sécurisés.";
    const imapHeading = card.querySelector("#partnerEmailImapForm h3");
    if (imapHeading) imapHeading.textContent = "Hébergeur IMAP/SMTP (OVH, Zimbra, Namecheap…)";

    const microsoftButton = card.querySelector('[data-email-oauth="microsoft"]');
    if (microsoftButton) microsoftButton.textContent = "Connecter Microsoft (Outlook, Hotmail, Microsoft 365)";
    const emailInput = card.querySelector('#partnerEmailImapForm [name="emailAddress"]');
    if (emailInput) {
        const form = emailInput.form;
        const guidance = document.createElement("p");
        guidance.className = "auth-message form-wide";
        guidance.hidden = true;
        emailInput.closest("label")?.after(guidance);
        const refreshGuidance = () => {
            const microsoft = isMicrosoftMailbox(emailInput.value), gmail = isGmailMailbox(emailInput.value);
            guidance.hidden = !microsoft && !gmail;
            if (microsoft) guidance.textContent = microsoftButton?.disabled
                ? "Cette adresse Outlook/Hotmail personnelle est compatible, mais uniquement par OAuth. La connexion Microsoft doit d’abord être activée sur le serveur par l’administrateur."
                : "Cette adresse Outlook/Hotmail personnelle doit être connectée avec le bouton Microsoft ci-dessus, sans saisir son mot de passe ici.";
            if (gmail) {
                guidance.innerHTML = 'Gmail personnel : activez la validation en deux étapes puis créez un <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener noreferrer">mot de passe d’application Google</a>. Utilisez ce code de 16 caractères ici, jamais votre mot de passe Gmail habituel.';
                if (form?.dataset.emailPreset !== "gmail") {
                    form.elements.username.value = emailInput.value.trim();
                    form.elements.imapHost.value = "imap.gmail.com";
                    form.elements.imapPort.value = "993";
                    form.elements.smtpHost.value = "smtp.gmail.com";
                    form.elements.smtpPort.value = "465";
                    form.elements.smtpSecure.value = "true";
                    form.dataset.emailPreset = "gmail";
                }
            } else if (form?.dataset.emailPreset === "gmail") form.dataset.emailPreset = "";
        };
        emailInput.addEventListener("input", refreshGuidance);
        refreshGuidance();
    }
    const password = card.querySelector('#partnerEmailImapForm [name="password"]');
    if (password) {
        const wrapper = document.createElement("span");
        wrapper.className = "password-input";
        password.before(wrapper);
        wrapper.append(password);
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "password-toggle";
        toggle.dataset.emailPasswordToggle = "";
        toggle.textContent = "Afficher";
        toggle.setAttribute("aria-label", "Afficher le mot de passe d’application");
        toggle.setAttribute("aria-pressed", "false");
        wrapper.append(toggle);
        toggle.addEventListener("click", () => {
            const visible = password.type === "password";
            password.type = visible ? "text" : "password";
            toggle.textContent = visible ? "Masquer" : "Afficher";
            toggle.setAttribute("aria-label", `${visible ? "Masquer" : "Afficher"} le mot de passe d’application`);
            toggle.setAttribute("aria-pressed", String(visible));
            password.focus();
        });
    }

    card.querySelectorAll("[data-email-oauth]").forEach(button => button.addEventListener("click", () => beginMailboxOauth(button.dataset.emailOauth, {
        selectionMode: card.querySelector("#partnerEmailOauthMode")?.value,
        allowedSenders: card.querySelector("#partnerEmailOauthSenders")?.value,
        sendStatusUpdates: card.querySelector("#partnerEmailOauthStatuses")?.checked,
        autoSearchEnabled: card.querySelector("#partnerEmailOauthAutoSearch")?.checked
    })));
    card.querySelector("#partnerEmailImapForm")?.addEventListener("submit", async event => {
        event.preventDefault();
        const form = event.currentTarget;
        const message = form.querySelector(".auth-message");
        if (isMicrosoftMailbox(form.elements.emailAddress.value)) {
            message.textContent = "Utilisez « Connecter Microsoft » pour une adresse Outlook, Hotmail, Live ou MSN. Microsoft refuse l’authentification IMAP classique.";
            message.classList.add("error");
            return;
        }
        const button = event.submitter;
        button.disabled = true;
        const values = Object.fromEntries(new FormData(form));
        values.sendStatusUpdates = form.elements.sendStatusUpdates.checked;
        values.autoSearchEnabled = form.elements.autoSearchEnabled.checked;
        const result = await api("/api/partner-email/configuration", { method: "PUT", body: JSON.stringify(values) });
        message.textContent = result.ok ? result.data.message : result.message;
        message.classList.toggle("error", !result.ok);
        button.disabled = false;
        if (result.ok) await loadPartnerEmailSettings(card);
    });
    card.querySelectorAll("[data-email-sync]").forEach(button => button.addEventListener("click", async () => {
        button.disabled = true;
        const result = await api(`/api/partner-email/${button.dataset.emailSync}/sync`, { method: "POST" });
        alert(result.ok ? "Synchronisation terminée." : result.message);
        await loadPartnerEmailSettings(card);
    }));
        card.querySelectorAll("[data-email-auto-search]").forEach(input => input.addEventListener("change", async () => {
            input.disabled = true;
            const result = await api(`/api/partner-email/${input.dataset.emailAutoSearch}/automatic-search`, { method: "PATCH", body: JSON.stringify({ enabled: input.checked }) });
            if (!result.ok) { input.checked = !input.checked; alert(result.message); }
            input.disabled = false;
        }));
    card.querySelectorAll("[data-email-disconnect]").forEach(button => button.addEventListener("click", async () => {
        if (!confirm("Déconnecter cette boîte ? Les missions déjà créées et leur historique seront conservés.")) return;
        const result = await api(`/api/partner-email/${button.dataset.emailDisconnect}`, { method: "DELETE" });
        if (!result.ok) return alert(result.message);
        await loadPartnerEmailSettings(card);
    }));
}

function emailConnectionCard(connection) {
    const mode = connection.selectionMode === "automatic" ? `Automatique · seuil ${connection.automaticThreshold}` : "Sélection manuelle";
    return `<article class="partner-email-connection"><div><strong>${escapeHtml(connection.displayName || connection.emailAddress)}</strong><p>${escapeHtml(connection.emailAddress)} · ${escapeHtml(mode)}</p><small>${connection.lastError ? escapeHtml(connection.lastError) : connection.lastSyncAt ? `Dernière synchronisation : ${escapeHtml(formatDate(connection.lastSyncAt))}` : "Jamais synchronisée"}</small><label class="creator-switch"><input type="checkbox" data-email-auto-search="${connection.id}" ${connection.autoSearchEnabled ? "checked" : ""}><span>Recherche automatique des missions</span></label></div><div class="partner-card-actions"><button class="secondary-button" data-email-sync="${connection.id}">Synchroniser</button><button class="danger-button" data-email-disconnect="${connection.id}">Déconnecter</button></div></article>`;
}

async function beginMailboxOauth(provider, settings) {
    const result = await api(`/api/partner-email/oauth/${provider}/authorize`, { method: "POST", body: JSON.stringify({ selectionMode: settings.selectionMode || "manual", sendStatusUpdates: Boolean(settings.sendStatusUpdates), autoSearchEnabled: Boolean(settings.autoSearchEnabled), allowedSenders: settings.allowedSenders || "" }) });
    if (!result.ok) return alert(result.message);
    const popup = window.open(result.data.authorizationUrl, "depannhome-mail-oauth", "popup,width=620,height=760");
    if (!popup) alert("Autorisez les fenêtres contextuelles pour connecter la boîte professionnelle.");
}

window.addEventListener("message", event => {
    if (event.origin !== window.location.origin || event.data?.type !== "depannhome:partner-email-oauth") return;
    alert(event.data.message);
    if (event.data.success && activeSettingsCard?.isConnected) loadPartnerEmailSettings(activeSettingsCard);
});

function formatDate(value) {
    return value ? new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)).replace(/:/g, " h ") : "Date inconnue";
}

function isMicrosoftMailbox(value) {
    const domain = String(value || "").toLowerCase().split("@").pop();
    return /^(?:(?:outlook|hotmail|live)\.[a-z.]+|msn\.com)$/.test(domain);
}

function isGmailMailbox(value) {
    return String(value || "").trim().toLowerCase().endsWith("@gmail.com");
}

async function api(url, options = {}) {
    try {
        const response = await fetch(url, { credentials: "same-origin", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
        const data = response.status === 204 ? null : await response.json().catch(() => null);
        return { ok: response.ok, data, message: data?.message || "Serveur indisponible." };
    } catch {
        return { ok: false, message: "Serveur indisponible." };
    }
}
