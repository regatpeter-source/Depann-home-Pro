import { escapeHtml } from "./utils.js?v=44";
import { synchronizeClients } from "./client-sync.js?v=126";

let activeSettingsCard = null;
let pendingMailboxOauth = false;
let mailboxOauthRefreshTimer = null;
const MAILBOX_OAUTH_STORAGE_KEY = "depannhome:partner-email-oauth-result";
const mailboxSearchDate = new Date();
let mailboxSearchFrom = localDateValue(new Date(mailboxSearchDate.getFullYear(), mailboxSearchDate.getMonth(), 1));
let mailboxSearchTo = localDateValue(mailboxSearchDate);

export async function renderPartnerEmailSettings(container) {
    const card = document.createElement("article");
    card.className = "brand-card full-card procedure-card partner-email-settings-card";
    card.innerHTML = '<section class="partner-email-panel"><p class="muted">Chargement de la configuration de la boîte professionnelle…</p></section>';
    container.appendChild(card);
    activeSettingsCard = card;
    await loadPartnerEmailSettings(card);
}

export async function renderCompanyEmailWorkspace(container) {
    const card = document.createElement("article");
    card.className = "brand-card full-card procedure-card partner-email-settings-card";
    card.innerHTML = '<section class="partner-email-panel"><p class="muted">Chargement de l’espace e-mail de l’entreprise…</p></section>';
    container.appendChild(card);
    await loadCompanyEmailWorkspace(card);
}

async function loadCompanyEmailWorkspace(card) {
    const result = await api("/api/partner-email");
    if (!result.ok) {
        card.innerHTML = `<section class="partner-email-panel"><p class="auth-message error">${escapeHtml(result.message || "Impossible de charger l’espace e-mail de l’entreprise.")}</p></section>`;
        return;
    }
    const connections = Array.isArray(result.data?.connections) ? result.data.connections : [];
    const panel = card.querySelector(".partner-email-panel");
    panel.innerHTML = `<div class="form-heading"><div><p class="eyebrow">Messagerie professionnelle</p><h2>Espace e-mail de l’entreprise</h2></div></div><p class="muted">Consultez directement les boîtes connectées. Les messages ordinaires restent chez leur fournisseur et ne sont pas enregistrés dans Depann’Home Pro.</p><div class="partner-email-connections"></div>`;
    const list = panel.querySelector(".partner-email-connections");
    if (!connections.length) {
        list.innerHTML = '<p class="auth-message">Aucune boîte n’est encore connectée. Un Poste Admin peut la configurer dans Paramètres &gt; Entreprise · Boîte mail.</p>';
        return;
    }
    const configuration = canConfigureMailbox();
    list.innerHTML = connections.map(connection => emailConnectionCard(connection, { configuration, candidateReview: true })).join("");
    connections.forEach(connection => {
        const row = list.querySelector(`[data-email-connection-card="${connection.id}"]`);
        const status = row?.querySelector("small");
        const settings = row?.querySelector(".partner-email-connection-settings");
        const criteria = document.createElement("section");
        criteria.className = "partner-email-criteria-summary";
        criteria.innerHTML = `<strong>Critères enregistrés pour cette boîte</strong><span><b>Expéditeurs / domaines :</b> ${escapeHtml((connection.allowedSenders || []).join(", ") || "Tous les expéditeurs")}</span><span><b>Mots-clés :</b> ${escapeHtml((connection.requiredKeywords || []).join(", ") || "Aucun")}</span>`;
        status?.after(criteria);
        if (settings) {
            settings.open = true;
            const summary = settings.querySelector("summary");
            if (summary) summary.textContent = "Modifier les critères enregistrés, le mode et la recherche automatique";
            const help = document.createElement("p");
            help.className = "muted";
            help.textContent = "Les critères enregistrés s’appliquent aux prochaines recherches manuelles et automatiques de cette boîte.";
            settings.querySelector("summary")?.after(help);
        }
    });
    bindMailboxConnectionControls(card, result.data, { configuration, candidateReview: true, reload: () => loadCompanyEmailWorkspace(card) });
}

async function loadPartnerEmailSettings(card) {
    const result = await api("/api/partner-email");
    if (!result.ok) {
        card.innerHTML = `<section class="partner-email-panel"><p class="auth-message error">${escapeHtml(result.message || "Impossible de charger la configuration de la boîte professionnelle.")}</p></section>`;
        return null;
    }
    renderSettings(card, result.data || { connections: [], oauth: {} });
    return result.data || { connections: [], oauth: {} };
}

function renderSettings(card, mailbox) {
    card.innerHTML = `<section class="partner-email-panel"><div class="form-heading"><div><p class="eyebrow">Réception de missions par e-mail</p><h2>Boîte mail professionnelle</h2></div></div><p class="muted">Microsoft 365 et Google utilisent OAuth : Depann’Home Pro ne connaît jamais votre mot de passe. Pour OVH ou un autre hébergeur, créez un mot de passe d’application IMAP/SMTP.</p><div class="form-grid partner-email-oauth-options"><label>Détection après connexion<select id="partnerEmailOauthMode"><option value="manual">Sélection manuelle</option><option value="automatic">Automatique stricte</option></select></label><label class="form-wide">Expéditeurs ou domaines autorisés<textarea id="partnerEmailOauthSenders" rows="2" placeholder="missions@partenaire.fr, partenaire.fr"></textarea></label><label class="creator-switch form-wide"><input id="partnerEmailOauthStatuses" type="checkbox"><span>Envoyer les changements de statut dans le fil d’origine.</span></label></div><div class="partner-email-provider-actions"><button class="secondary-button" data-email-oauth="microsoft" ${mailbox.oauth?.microsoft ? "" : "disabled"}>Connecter Microsoft 365</button><button class="secondary-button" data-email-oauth="google" ${mailbox.oauth?.google ? "" : "disabled"}>Connecter Google Workspace</button></div>${!mailbox.oauth?.microsoft || !mailbox.oauth?.google ? '<p class="auth-message">Les boutons désactivés nécessitent la configuration OAuth correspondante sur le serveur.</p>' : ""}<form class="client-form" id="partnerEmailImapForm"><h3>OVH ou serveur IMAP/SMTP</h3><div class="form-grid"><label>Nom affiché<input name="displayName" maxlength="160" placeholder="Service missions"></label><label>Adresse e-mail *<input name="emailAddress" type="email" required></label><label>Utilisateur IMAP/SMTP *<input name="username" required></label><label>Mot de passe d’application *<input name="password" type="password" required autocomplete="new-password"></label><label>Serveur IMAP *<input name="imapHost" required placeholder="ssl0.ovh.net"></label><label>Port IMAP<input name="imapPort" type="number" min="1" max="65535" value="993"></label><label>Serveur SMTP *<input name="smtpHost" required placeholder="ssl0.ovh.net"></label><label>Port SMTP<input name="smtpPort" type="number" min="1" max="65535" value="465"></label><label>Sécurité SMTP<select name="smtpSecure"><option value="true">TLS direct (souvent port 465)</option><option value="false">STARTTLS obligatoire (souvent port 587)</option></select></label><label>Détection<select name="selectionMode"><option value="manual">Sélection manuelle</option><option value="automatic">Automatique stricte</option></select></label><label>Seuil automatique<input name="automaticThreshold" type="number" min="70" max="100" value="80"></label><label class="form-wide">Expéditeurs ou domaines autorisés<textarea name="allowedSenders" rows="3" placeholder="missions@partenaire.fr, partenaire.fr"></textarea><small>Un expéditeur autorisé renforce le score ; il ne suffit jamais à lui seul à créer une mission.</small></label><label class="creator-switch form-wide"><input name="sendStatusUpdates" type="checkbox"><span>Répondre automatiquement au fil d’origine lors des changements de statut.</span></label></div><div class="form-actions"><button class="secondary-button">Tester et connecter</button></div><p class="auth-message" aria-live="polite"></p></form><section class="partner-email-connections"><h3>Boîtes connectées</h3>${mailbox.connections?.length ? mailbox.connections.map(emailConnectionCard).join("") : '<p class="muted">Aucune boîte professionnelle connectée.</p>'}</section></section>`;
    card.querySelector(".form-heading")?.insertAdjacentHTML("afterend", '<p class="auth-message" data-email-settings-feedback aria-live="polite" hidden></p>');
    card.querySelector(".partner-email-panel > .muted")?.insertAdjacentHTML("afterend", '<aside class="auth-message" data-google-oauth-disclosure><strong>Avant de connecter Google Workspace</strong><br>Avec votre autorisation, Depann’Home Pro pourra lire les messages et pièces jointes de la boîte Gmail sélectionnée afin de les afficher et de créer des missions, puis envoyer depuis cette boîte uniquement les réponses ou mises à jour demandées. Depann’Home Pro ne modifie, ne déplace, ne supprime aucun message Gmail et ne le marque jamais comme lu. Vous pourrez révoquer cet accès à tout moment. <a href="/confidentialite#messagerie" target="_blank" rel="noopener noreferrer">Consulter la politique de confidentialité</a>.</aside>');
    card.querySelector(".partner-email-oauth-options")?.insertAdjacentHTML("beforeend", '<label class="creator-switch form-wide"><input id="partnerEmailOauthAutoSearch" type="checkbox"><span>Activer la recherche automatique des missions sur cette boîte.</span></label>');
    card.querySelector("#partnerEmailOauthSenders")?.closest("label")?.insertAdjacentHTML("beforeend", "<small>Si la liste est renseignée, seuls ces expéditeurs seront recherchés, en mode manuel comme automatique. Laissez vide pour rechercher tous les expéditeurs.</small>");
    card.querySelector("#partnerEmailOauthSenders")?.closest("label")?.insertAdjacentHTML("afterend", '<label class="form-wide">Mots-clés obligatoires pour une mission<textarea id="partnerEmailOauthKeywords" rows="2" placeholder="mission partenaire IMH"></textarea><small>Séparez les expressions alternatives par une virgule ou une ligne. Sans correspondance, l’e-mail ne sera pas proposé.</small></label>');
    card.querySelector("#partnerEmailImapForm .form-grid")?.insertAdjacentHTML("beforeend", '<label class="creator-switch form-wide"><input name="autoSearchEnabled" type="checkbox"><span>Activer la recherche automatique des missions sur cette boîte.</span></label>');
    card.querySelector('#partnerEmailImapForm [name="allowedSenders"]')?.closest("label")?.insertAdjacentHTML("beforeend", "<small>Liste facultative mais stricte dans les recherches manuelles et automatiques.</small>");
    card.querySelector('#partnerEmailImapForm [name="allowedSenders"]')?.closest("label")?.insertAdjacentHTML("afterend", '<label class="form-wide">Mots-clés obligatoires pour une mission<textarea name="requiredKeywords" rows="2" placeholder="mission partenaire IMH"></textarea><small>Séparez les expressions alternatives par une virgule ou une ligne.</small></label>');
    const providerHelp = card.querySelector(".partner-email-panel > .muted");
    if (providerHelp) providerHelp.textContent = "L’adresse Depann’Home Pro reçoit les missions sans configuration. Microsoft reste disponible par OAuth. Gmail personnel, OVH, Zimbra, Namecheap et les autres hébergeurs restent disponibles avec leurs paramètres IMAP/SMTP sécurisés.";
    const imapHeading = card.querySelector("#partnerEmailImapForm h3");
    if (imapHeading) imapHeading.textContent = "Hébergeur IMAP/SMTP (OVH, Zimbra, Namecheap…)";

    const microsoftButton = card.querySelector('[data-email-oauth="microsoft"]');
    if (microsoftButton) microsoftButton.textContent = "Connecter Microsoft (Outlook, Hotmail, Microsoft 365)";
    const googleButton = card.querySelector('[data-email-oauth="google"]');
    if (googleButton) {
        googleButton.disabled = true;
        googleButton.textContent = "Google Workspace · bientôt disponible";
        googleButton.setAttribute("aria-describedby", "partnerEmailGoogleSoon");
    }
    const googleDisclosure = card.querySelector("[data-google-oauth-disclosure]");
    if (googleDisclosure) {
        googleDisclosure.id = "partnerEmailGoogleSoon";
        googleDisclosure.innerHTML = "<strong>Connexion Google Workspace bientôt disponible</strong><br>Cette connexion est temporairement désactivée. Utilisez dès maintenant l’adresse de réception Depann’Home Pro ci-dessus, ou configurez une boîte Gmail personnelle avec un mot de passe d’application dans le formulaire IMAP/SMTP ci-dessous.";
    }
    const providerActions = card.querySelector(".partner-email-provider-actions");
    providerActions?.insertAdjacentHTML("beforebegin", inboundAddressSection(mailbox));
    bindInboundAddressControls(card);
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

    card.querySelectorAll('[data-email-oauth="microsoft"]').forEach(button => button.addEventListener("click", () => beginMailboxOauth(button.dataset.emailOauth, {
        selectionMode: card.querySelector("#partnerEmailOauthMode")?.value,
        allowedSenders: card.querySelector("#partnerEmailOauthSenders")?.value,
        requiredKeywords: card.querySelector("#partnerEmailOauthKeywords")?.value,
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
        if (result.ok) {
            await loadPartnerEmailSettings(card);
            showSettingsFeedback(card, result.data.message);
            dispatchMailboxChanged("connection");
        }
    });
    bindMailboxConnectionControls(card, mailbox, { configuration: true, reload: () => loadPartnerEmailSettings(card) });
}

function inboundAddressSection(mailbox) {
    if (mailbox?.inboundAvailable !== true) return '<article class="partner-email-inbound-card"><div><p class="eyebrow">Réception simplifiée</p><h3>Adresse de réception Depann’Home Pro · bientôt disponible</h3><p>Cette fonctionnalité est temporairement désactivée. Microsoft et les boîtes IMAP/SMTP (Gmail personnel, OVH, Zimbra, Namecheap…) restent disponibles.</p><small>Aucune adresse dédiée n’est actuellement créée ni exposée.</small></div><div class="partner-email-inbound-actions"><button type="button" class="primary-button" disabled>Créer mon adresse · bientôt disponible</button></div></article>';
    const address = mailbox?.inboundAddress;
    const configured = mailbox?.inboundConfigured === true;
    const status = address?.enabled ? "Active" : address ? "Suspendue" : configured ? "Prête à être créée" : "Configuration plateforme en attente";
    return `<article class="partner-email-inbound-card"><div><p class="eyebrow">Recommandé · sans configuration de boîte</p><h3>Adresse de réception Depann’Home Pro</h3><p>Communiquez cette adresse aux donneurs d’ordre. Chaque e-mail et ses pièces jointes suivent exactement l’analyse actuelle : extraction PDF/Word/Excel, OCR, proposition de mission et création ou rapprochement de la fiche client.</p>${address ? `<div class="partner-email-inbound-address"><code>${escapeHtml(address.emailAddress)}</code><button type="button" class="secondary-button" data-email-copy-inbound="${escapeHtml(address.emailAddress)}">Copier l’adresse</button></div>` : ""}<small>État : ${escapeHtml(status)}. Aucun DNS, OAuth ni serveur mail n’est à configurer par votre entreprise.</small></div><div class="partner-email-inbound-actions">${address ? `<button type="button" class="secondary-button" data-email-toggle-inbound="${address.enabled ? "false" : "true"}">${address.enabled ? "Suspendre" : "Réactiver"}</button><button type="button" class="danger-button" data-email-rotate-inbound>Renouveler l’adresse</button>` : `<button type="button" class="primary-button" data-email-create-inbound ${configured ? "" : "disabled"}>Créer mon adresse</button>`}</div><p class="auth-message" data-email-inbound-feedback aria-live="polite"></p></article>`;
}

function bindInboundAddressControls(card) {
    card.querySelector("[data-email-copy-inbound]")?.addEventListener("click", async event => {
        const button = event.currentTarget;
        try { await navigator.clipboard.writeText(button.dataset.emailCopyInbound); button.textContent = "Adresse copiée"; }
        catch { showInboundFeedback(card, "Copie impossible. Sélectionnez l’adresse manuellement.", true); }
    });
    card.querySelector("[data-email-create-inbound]")?.addEventListener("click", event => changeInboundAddress(card, event.currentTarget, "/api/partner-email/inbound-address", { method: "POST", body: "{}" }));
    card.querySelector("[data-email-toggle-inbound]")?.addEventListener("click", event => changeInboundAddress(card, event.currentTarget, "/api/partner-email/inbound-address", { method: "PATCH", body: JSON.stringify({ enabled: event.currentTarget.dataset.emailToggleInbound === "true" }) }));
    card.querySelector("[data-email-rotate-inbound]")?.addEventListener("click", event => {
        if (!confirm("Renouveler cette adresse ? L’ancienne cessera immédiatement de recevoir les missions.")) return;
        changeInboundAddress(card, event.currentTarget, "/api/partner-email/inbound-address", { method: "POST", body: JSON.stringify({ rotate: true }) });
    });
}

async function changeInboundAddress(card, button, url, options) {
    button.disabled = true;
    showInboundFeedback(card, "Mise à jour de l’adresse…");
    const result = await api(url, options);
    if (!result.ok) { button.disabled = false; return showInboundFeedback(card, result.message, true); }
    dispatchMailboxChanged("inbound-address");
    await loadPartnerEmailSettings(card);
}

function showInboundFeedback(card, message, error = false) {
    const target = card.querySelector("[data-email-inbound-feedback]");
    if (!target) return;
    target.textContent = message;
    target.classList.toggle("error", error);
}

function emailConnectionCard(connection, { configuration = true, candidateReview = false } = {}) {
    const mode = connection.selectionMode === "automatic" ? `Automatique · seuil ${connection.automaticThreshold}` : "Sélection manuelle";
    const connectionState = connection.lastError ? escapeHtml(connection.lastError) : connection.verifiedAt ? connection.lastSyncAt ? `Connexion vérifiée · dernière synchronisation : ${escapeHtml(formatDate(connection.lastSyncAt))}` : `Connexion vérifiée le ${escapeHtml(formatDate(connection.verifiedAt))}` : "Connexion non vérifiée : reconnectez cette boîte pour tester réellement l’accès aux e-mails.";
    const settings = configuration ? `<details class="partner-email-connection-settings"><summary>Critères, mode et recherche automatique</summary><div class="form-grid"><label>Mode de traitement<select data-email-selection-mode><option value="manual" ${connection.selectionMode !== "automatic" ? "selected" : ""}>Sélection manuelle dans Missions partenaires</option><option value="automatic" ${connection.selectionMode === "automatic" ? "selected" : ""}>Création automatique stricte</option></select></label><label>Seuil automatique<input type="number" min="70" max="100" data-email-automatic-threshold value="${escapeHtml(connection.automaticThreshold || 80)}"></label><label class="form-wide">Expéditeurs ou domaines autorisés<textarea rows="2" data-email-allowed-senders placeholder="missions@partenaire.fr, partenaire.fr">${escapeHtml((connection.allowedSenders || []).join(", "))}</textarea></label><label class="form-wide">Mots-clés obligatoires pour une mission<textarea rows="2" data-email-required-keywords placeholder="mission partenaire IMH">${escapeHtml((connection.requiredKeywords || []).join(", "))}</textarea><small>Chaque expression peut contenir plusieurs mots. Séparez les alternatives par une virgule ou une ligne.</small></label><label class="creator-switch form-wide"><input type="checkbox" data-email-send-statuses ${connection.sendStatusUpdates ? "checked" : ""}><span>Envoyer les changements de statut dans le fil d’origine</span></label><label class="creator-switch form-wide"><input type="checkbox" data-email-auto-search ${connection.autoSearchEnabled ? "checked" : ""}><span>Rechercher automatiquement les nouvelles missions toutes les 10 minutes</span></label><div class="form-actions form-wide"><button type="button" class="secondary-button" data-email-save-settings="${connection.id}">Enregistrer les critères de recherche</button></div></div></details>` : `<p class="partner-email-mode-summary">Mode : ${escapeHtml(mode)} · Mots-clés : <strong>${escapeHtml((connection.requiredKeywords || []).join(", ") || "aucun filtre")}</strong> · Recherche automatique : <strong>${connection.autoSearchEnabled ? "activée" : "désactivée"}</strong></p>`;
    return `<article class="partner-email-connection" data-email-connection-card="${connection.id}"><div class="partner-email-connection-main"><strong>${escapeHtml(connection.displayName || connection.emailAddress)}</strong><p>${escapeHtml(connection.emailAddress)} · ${escapeHtml(mode)}</p><small>${connectionState}</small>${settings}<div class="partner-email-sync-period"><label>Du<input type="date" data-email-sync-from value="${escapeHtml(mailboxSearchFrom)}"></label><label>Au<input type="date" data-email-sync-to value="${escapeHtml(mailboxSearchTo)}"></label><button type="button" class="secondary-button" data-email-sync="${connection.id}">Rechercher les missions</button></div><p class="auth-message" data-email-feedback aria-live="polite"></p>${candidateReview ? `<section class="partner-email-search-results" data-email-search-results="${connection.id}"></section>` : ""}</div><div class="partner-card-actions"><button type="button" class="secondary-button" data-email-browse="${connection.id}">Consulter les e-mails</button>${canOpenPartnerMissions() ? '<button type="button" class="secondary-button" data-email-open-missions>Voir les missions détectées</button>' : ""}${configuration ? `<button type="button" class="danger-button" data-email-disconnect="${connection.id}">Déconnecter</button>` : ""}</div></article>`;
}

function bindMailboxConnectionControls(card, mailbox, { configuration = false, candidateReview = false, reload = null } = {}) {
    const connections = Array.isArray(mailbox?.connections) ? mailbox.connections : [];
    if (candidateReview) connections.forEach(connection => renderEmailSearchResults(card, connection, mailbox?.candidates || []));
    card.querySelectorAll("[data-email-browse]").forEach(button => button.addEventListener("click", () => {
        const connection = connections.find(item => String(item.id) === button.dataset.emailBrowse);
        if (connection) openMailboxBrowser(card, connection);
    }));
    card.querySelectorAll("[data-email-open-missions]").forEach(button => button.addEventListener("click", () => window.dispatchEvent(new CustomEvent("depannhome:open-partner-email-missions"))));
    card.querySelectorAll("[data-email-sync]").forEach(button => button.addEventListener("click", async () => {
        const row = button.closest("[data-email-connection-card]");
        const from = row?.querySelector("[data-email-sync-from]")?.value || "";
        const to = row?.querySelector("[data-email-sync-to]")?.value || "";
        const periodError = validateMailboxSearchPeriod(from, to);
        if (periodError) return showMailboxFeedback(row, periodError, true);
        mailboxSearchFrom = from; mailboxSearchTo = to; button.disabled = true;
        showMailboxFeedback(row, "Recherche des missions en cours…");
        const result = await api(`/api/partner-email/${button.dataset.emailSync}/sync`, { method: "POST", body: JSON.stringify({ from, to }) });
        button.disabled = false;
        if (!result.ok) return showMailboxFeedback(row, result.message, true);
        const summary = mailboxSyncSummary(result.data, from, to);
        showMailboxFeedback(row, summary);
        dispatchMailboxChanged("sync", { connectionId: button.dataset.emailSync, stats: result.data });
        if (candidateReview) await refreshEmailSearchResults(card, button.dataset.emailSync, true);
        if (reload) window.setTimeout(reload, 1200);
    }));
    if (!configuration) return;
    card.querySelectorAll("[data-email-save-settings]").forEach(button => button.addEventListener("click", async () => {
        const row = button.closest("[data-email-connection-card]");
        const payload = {
            selectionMode: row.querySelector("[data-email-selection-mode]").value,
            automaticThreshold: Number(row.querySelector("[data-email-automatic-threshold]").value),
            allowedSenders: row.querySelector("[data-email-allowed-senders]").value,
            requiredKeywords: row.querySelector("[data-email-required-keywords]").value,
            sendStatusUpdates: row.querySelector("[data-email-send-statuses]").checked,
            autoSearchEnabled: row.querySelector("[data-email-auto-search]").checked
        };
        button.disabled = true;
        const result = await api(`/api/partner-email/${button.dataset.emailSaveSettings}/settings`, { method: "PATCH", body: JSON.stringify(payload) });
        button.disabled = false;
        showMailboxFeedback(row, result.ok ? result.data.message : result.message, !result.ok);
        if (result.ok) { dispatchMailboxChanged("settings"); if (reload) window.setTimeout(reload, 800); }
    }));
    card.querySelectorAll("[data-email-disconnect]").forEach(button => button.addEventListener("click", async () => {
        if (!confirm("Déconnecter cette boîte ? Les missions déjà créées et leur historique seront conservés.")) return;
        const result = await api(`/api/partner-email/${button.dataset.emailDisconnect}`, { method: "DELETE" });
        if (!result.ok) return alert(result.message);
        dispatchMailboxChanged("connection");
        if (reload) await reload();
    }));
}

function showMailboxFeedback(row, message, error = false) { const target = row?.querySelector("[data-email-feedback]"); if (!target) return; target.textContent = message; target.classList.toggle("error", error); }
function showSettingsFeedback(card, message, error = false) { const target = card?.querySelector("[data-email-settings-feedback]"); if (!target) return; target.hidden = false; target.textContent = message; target.classList.toggle("error", error); }
function mailboxSyncSummary(stats, from, to) { return `${Number(stats?.fetched) || 0} e-mail(s) lu(s) du ${formatShortDate(from)} au ${formatShortDate(to)} · ${Number(stats?.candidates) || 0} mission(s) à confirmer · ${Number(stats?.imported) || 0} créée(s) automatiquement.${stats?.limited ? " Plus de 500 e-mails ont été trouvés : réduisez la période." : ""}`; }
function validateMailboxSearchPeriod(from, to) { if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return "Sélectionnez une date de début et une date de fin."; const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000; if (days < 0) return "La date de fin doit être postérieure ou égale à la date de début."; return days > 30 ? "Sélectionnez une période maximale de 31 jours." : ""; }
function dispatchMailboxChanged(reason, detail = {}) { window.dispatchEvent(new CustomEvent("depannhome:partner-email-changed", { detail: { reason, ...detail } })); }

async function refreshEmailSearchResults(card, connectionId, focus = false) {
    const result = await api("/api/partner-email");
    if (!result.ok) return showMailboxFeedback(card.querySelector(`[data-email-connection-card="${connectionId}"]`), result.message, true);
    const connection = (result.data?.connections || []).find(item => String(item.id) === String(connectionId));
    if (!connection) return;
    const results = renderEmailSearchResults(card, connection, result.data?.candidates || []);
    if (focus) results?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderEmailSearchResults(card, connection, candidates) {
    const results = card.querySelector(`[data-email-search-results="${connection.id}"]`);
    if (!results) return null;
    const matching = (Array.isArray(candidates) ? candidates : []).filter(candidate => String(candidate.connectionId) === String(connection.id));
    if (!matching.length) {
        results.innerHTML = '<p class="auth-message">Aucune mission en attente pour cette boîte. En mode automatique, les missions conformes sont envoyées directement dans Missions partenaires.</p>';
        return results;
    }
    const checked = connection.selectionMode === "manual" ? "checked" : "";
    results.innerHTML = `<div class="partner-email-search-heading"><div><p class="eyebrow">Missions trouvées</p><h3>${matching.length} proposition(s) à valider</h3></div><label><input type="checkbox" data-email-select-all ${checked}> Tout sélectionner</label></div><div class="partner-email-search-list">${matching.map(candidate => emailSearchCandidate(candidate, checked)).join("")}</div><div class="form-actions partner-email-search-actions"><button type="button" class="primary-button" data-email-import-selection>Valider la sélection vers Missions partenaires</button><button type="button" class="danger-button" data-email-ignore-selection>Supprimer la sélection</button></div><p class="auth-message" data-email-results-feedback aria-live="polite"></p>`;
    const choices = () => [...results.querySelectorAll("[data-email-candidate-choice]")];
    results.querySelector("[data-email-select-all]")?.addEventListener("change", event => choices().forEach(choice => { choice.checked = event.currentTarget.checked; }));
    choices().forEach(choice => choice.addEventListener("change", () => { const selectAll = results.querySelector("[data-email-select-all]"); selectAll.checked = choices().every(item => item.checked); selectAll.indeterminate = !selectAll.checked && choices().some(item => item.checked); }));
    results.querySelector("[data-email-import-selection]")?.addEventListener("click", event => processEmailCandidateSelection(card, connection.id, results, event.currentTarget, "import"));
    results.querySelector("[data-email-ignore-selection]")?.addEventListener("click", event => processEmailCandidateSelection(card, connection.id, results, event.currentTarget, "ignore"));
    return results;
}

function emailSearchCandidate(candidate, checked) {
    const sender = candidate.senderName ? `${candidate.senderName} <${candidate.senderAddress}>` : candidate.senderAddress || "Expéditeur inconnu";
    const excerpt = String(candidate.bodyText || "").replace(/\s+/g, " ").trim().slice(0, 240);
    const reasons = Array.isArray(candidate.classificationReasons) ? candidate.classificationReasons.join(" · ") : "";
    return `<label class="partner-email-search-candidate"><input type="checkbox" data-email-candidate-choice value="${escapeHtml(candidate.id)}" ${checked}><span><strong>${escapeHtml(candidate.subject || "Sans objet")}</strong><small>${escapeHtml(sender)} · ${escapeHtml(formatDate(candidate.receivedAt))} · score ${escapeHtml(candidate.classificationScore || 0)}/100</small>${excerpt ? `<p>${escapeHtml(excerpt)}${String(candidate.bodyText || "").length > 240 ? "…" : ""}</p>` : ""}${reasons ? `<small>${escapeHtml(reasons)}</small>` : ""}${candidate.attachments?.length ? `<small>📎 ${candidate.attachments.length} pièce(s) jointe(s)</small>` : ""}</span></label>`;
}

async function processEmailCandidateSelection(card, connectionId, results, button, action) {
    const ids = [...results.querySelectorAll("[data-email-candidate-choice]:checked")].map(choice => Number(choice.value)).filter(Number.isSafeInteger);
    const feedback = results.querySelector("[data-email-results-feedback]");
    if (!ids.length) { feedback.textContent = "Sélectionnez au moins une proposition."; feedback.classList.add("error"); return; }
    button.disabled = true;
    feedback.textContent = action === "import" ? "Validation vers Missions partenaires…" : "Suppression des propositions…";
    feedback.classList.remove("error");
    const result = await api(`/api/partner-email/candidates/${action}`, { method: "POST", body: JSON.stringify({ ids }) });
    button.disabled = false;
    if (!result.ok) { feedback.textContent = result.message; feedback.classList.add("error"); return; }
    if (action === "import") {
        await synchronizeClients({ forceFull: true }).catch(() => {});
        (result.data?.results || []).forEach(item => { if (item?.clientId) window.dispatchEvent(new CustomEvent("depannhome:partner-client-provisioned", { detail: { clientId: item.clientId } })); });
    }
    dispatchMailboxChanged(action === "import" ? "candidate-import" : "candidate-ignore", { connectionId, ids });
    await refreshEmailSearchResults(card, connectionId);
    const row = card.querySelector(`[data-email-connection-card="${connectionId}"]`);
    showMailboxFeedback(row, action === "import" ? `${ids.length} mission(s) envoyée(s) dans Missions partenaires → E-mail.` : `${ids.length} proposition(s) supprimée(s).`);
}

async function openMailboxBrowser(card, connection, offset = 0) {
    let browser = card.querySelector(".partner-mailbox-browser");
    if (!browser) {
        browser = document.createElement("section");
        browser.className = "partner-mailbox-browser";
        card.querySelector(".partner-email-panel")?.appendChild(browser);
    }
    const requestMarker = {};
    browser.mailboxRequestMarker = requestMarker;
    browser.innerHTML = `<div class="partner-mailbox-heading"><div><p class="eyebrow">Consultation à la demande</p><h3>${escapeHtml(connection.displayName || connection.emailAddress)}</h3><p class="muted">Les messages restent chez votre fournisseur. Le contenu et les pièces jointes ne sont chargés qu’à votre demande.</p></div><button type="button" class="secondary-button" data-mailbox-close>Fermer</button></div><p class="muted">Chargement de la boîte de réception…</p>`;
    bindMailboxClose(browser);
    browser.scrollIntoView({ behavior: "smooth", block: "start" });
    const result = await api(`/api/partner-email/${connection.id}/inbox?offset=${Math.max(0, offset)}&limit=30`);
    if (!browser.isConnected || browser.mailboxRequestMarker !== requestMarker) return;
    if (!result.ok) {
        browser.insertAdjacentHTML("beforeend", `<p class="auth-message error">${escapeHtml(result.message)}</p>`);
        bindMailboxClose(browser);
        return;
    }
    const inbox = result.data || { messages: [] };
    const messages = Array.isArray(inbox.messages) ? inbox.messages : [];
    browser.innerHTML = `<div class="partner-mailbox-heading"><div><p class="eyebrow">Boîte de réception</p><h3>${escapeHtml(connection.displayName || connection.emailAddress)}</h3><p class="muted">Lecture directe, sans copie permanente dans Depann’Home Pro.</p></div><button type="button" class="secondary-button" data-mailbox-close>Fermer</button></div><div class="partner-mailbox-layout"><div class="partner-mailbox-list"><div class="partner-mailbox-list-heading"><strong>${messages.length ? `${inbox.offset + 1}–${inbox.offset + messages.length}` : "Aucun message"}${Number.isFinite(inbox.total) ? ` sur ${inbox.total}` : ""}</strong><button type="button" class="text-button" data-mailbox-refresh>Actualiser</button></div>${messages.length ? messages.map(mailboxMessageButton).join("") : '<p class="auth-message">La boîte de réception est vide.</p>'}<div class="partner-mailbox-pagination"><button type="button" class="secondary-button" data-mailbox-page="${Math.max(0, inbox.offset - inbox.limit)}" ${inbox.hasPrevious ? "" : "disabled"}>Précédents</button><button type="button" class="secondary-button" data-mailbox-page="${inbox.offset + inbox.limit}" ${inbox.hasMore ? "" : "disabled"}>Suivants</button></div></div><article class="partner-mailbox-message"><p class="muted">Sélectionnez un e-mail pour consulter son contenu.</p></article></div>`;
    bindMailboxClose(browser);
    browser.querySelector("[data-mailbox-refresh]")?.addEventListener("click", () => openMailboxBrowser(card, connection, inbox.offset));
    browser.querySelectorAll("[data-mailbox-page]").forEach(button => button.addEventListener("click", () => openMailboxBrowser(card, connection, Number(button.dataset.mailboxPage))));
    browser.querySelectorAll("[data-mailbox-message]").forEach(button => button.addEventListener("click", () => loadMailboxMessage(browser, connection.id, button.dataset.mailboxMessage, button)));
}

function mailboxMessageButton(message) {
    const sender = message.from?.name || message.from?.address || "Expéditeur inconnu";
    return `<button type="button" class="partner-mailbox-row ${message.isRead ? "" : "unread"}" data-mailbox-message="${escapeHtml(message.id)}"><span class="partner-mailbox-row-top"><strong>${escapeHtml(sender)}</strong><time>${escapeHtml(formatDate(message.receivedAt))}</time></span><span class="partner-mailbox-subject">${escapeHtml(message.subject || "Sans objet")}</span>${message.preview ? `<small>${escapeHtml(message.preview)}</small>` : ""}<span class="partner-mailbox-indicators">${message.isRead ? "Lu" : "Non lu"}${message.hasAttachments ? " · 📎 Pièce jointe" : ""}</span></button>`;
}

async function loadMailboxMessage(browser, connectionId, messageRef, selectedButton) {
    const requestMarker = {};
    browser.messageRequestMarker = requestMarker;
    browser.querySelectorAll("[data-mailbox-message]").forEach(button => button.classList.toggle("selected", button === selectedButton));
    const panel = browser.querySelector(".partner-mailbox-message");
    panel.innerHTML = '<p class="muted">Chargement du message…</p>';
    const result = await api(`/api/partner-email/${connectionId}/messages/${encodeURIComponent(messageRef)}`);
    if (!browser.isConnected || browser.messageRequestMarker !== requestMarker) return;
    if (!result.ok) {
        panel.innerHTML = `<p class="auth-message error">${escapeHtml(result.message)}</p>`;
        return;
    }
    const message = result.data;
    const recipients = (message.to || []).map(mailboxAddressLabel).filter(Boolean).join(", ");
    const copies = (message.cc || []).map(mailboxAddressLabel).filter(Boolean).join(", ");
    const attachments = (message.attachments || []).map(attachment => attachment.downloadable
        ? `<label class="partner-mailbox-mission-attachment"><input type="checkbox" data-mailbox-mission-attachment value="${escapeHtml(attachment.id)}" checked><span>${escapeHtml(attachment.filename)} · ${escapeHtml(formatBytes(attachment.size))}</span><button type="button" class="secondary-button" data-mailbox-attachment="${escapeHtml(attachment.id)}" data-mailbox-attachment-name="${escapeHtml(attachment.filename)}">Télécharger</button></label>`
        : `<span class="partner-mailbox-attachment-disabled">${escapeHtml(attachment.filename)} · ${escapeHtml(formatBytes(attachment.size))} — format ou taille non autorisé</span>`).join("");
    const replyRecipient = mailboxAddressLabel(message.from);
    panel.innerHTML = `<header><p class="eyebrow">Message reçu le ${escapeHtml(formatDate(message.receivedAt))}</p><h3>${escapeHtml(message.subject || "Sans objet")}</h3><dl><dt>De</dt><dd>${escapeHtml(replyRecipient || "Expéditeur inconnu")}</dd><dt>À</dt><dd>${escapeHtml(recipients || "Destinataire non indiqué")}</dd>${copies ? `<dt>Copie</dt><dd>${escapeHtml(copies)}</dd>` : ""}</dl></header><pre class="partner-mailbox-body">${escapeHtml(message.bodyText || "Ce message ne contient pas de texte consultable.")}</pre>${message.bodyTruncated ? '<p class="auth-message">Le corps de ce message très volumineux a été limité à 512 Ko.</p>' : ""}${message.attachmentsUnavailable ? '<p class="auth-message error">Le message est accessible, mais Microsoft n’a pas permis de charger ses pièces jointes. Réessayez ou reconnectez la boîte Microsoft si le problème persiste.</p>' : ""}${attachments ? `<div class="partner-mailbox-attachments"><strong>Pièces jointes</strong><div>${attachments}</div><small>Cliquez sur un document pour le télécharger avec son nom d’origine.</small></div>` : ""}${replyRecipient ? `<form class="partner-mailbox-reply" data-mailbox-reply><header><span class="partner-email-reply-icon" aria-hidden="true">↩</span><div><p class="eyebrow">Réponse sécurisée</p><h4>Répondre dans le fil d’origine</h4></div></header><p class="partner-email-reply-recipient"><strong>Destinataire</strong><span>${escapeHtml(replyRecipient)}</span></p><label>Votre message<textarea name="body" rows="6" maxlength="10000" required placeholder="Bonjour,&#10;&#10;Rédigez votre réponse…"></textarea><small data-mailbox-reply-count>0 / 10 000 caractères</small></label><div class="form-actions partner-email-reply-actions"><span>Envoyé depuis la boîte connectée</span><button type="submit" class="primary-button">Envoyer la réponse</button></div><p class="auth-message" data-mailbox-reply-feedback aria-live="polite"></p></form>` : '<p class="auth-message">Cet e-mail ne contient aucune adresse permettant d’y répondre.</p>'}`;
    const missionImport = `<section class="partner-mailbox-mission-import"><h4>Créer une mission partenaire</h4><p>Le corps du mail et les documents cochés seront analysés pour créer ou rattacher automatiquement la fiche client.</p><button type="button" class="primary-button" data-mailbox-import-mission>Envoyer ce mail dans Missions partenaires</button><p class="auth-message" data-mailbox-import-feedback aria-live="polite"></p></section>`;
    const replyElement = panel.querySelector("[data-mailbox-reply]");
    if (replyElement) replyElement.insertAdjacentHTML("beforebegin", missionImport); else panel.insertAdjacentHTML("beforeend", missionImport);
    panel.querySelectorAll("[data-mailbox-attachment]").forEach(button => button.addEventListener("click", () => downloadMailboxAttachment(button, connectionId, message.id)));
    panel.querySelector("[data-mailbox-import-mission]")?.addEventListener("click", event => importMailboxMission(event.currentTarget, connectionId, message));
    const replyForm = panel.querySelector("[data-mailbox-reply]");
    replyForm?.elements.body.addEventListener("input", () => { replyForm.querySelector("[data-mailbox-reply-count]").textContent = `${replyForm.elements.body.value.length.toLocaleString("fr-FR")} / 10 000 caractères`; });
    replyForm?.addEventListener("submit", event => submitMailboxReply(event, connectionId, message.id));
}

async function importMailboxMission(button, connectionId, message) {
    const panel = button.closest(".partner-mailbox-message");
    const feedback = panel.querySelector("[data-mailbox-import-feedback]");
    const attachmentIds = [...panel.querySelectorAll("[data-mailbox-mission-attachment]:checked")].map(input => input.value);
    button.disabled = true;
    const label = button.textContent;
    button.textContent = "Analyse du mail et des documents…";
    feedback.textContent = "Création de la mission et de la fiche client…";
    feedback.classList.remove("error");
    const result = await api(`/api/partner-email/${connectionId}/messages/${encodeURIComponent(message.id)}/import`, { method: "POST", body: JSON.stringify({ attachmentIds }) });
    if (!result.ok) {
        button.disabled = false;
        button.textContent = label;
        feedback.textContent = result.message;
        feedback.classList.add("error");
        return;
    }
    await synchronizeClients({ forceFull: true }).catch(() => {});
    if (result.data?.clientId) window.dispatchEvent(new CustomEvent("depannhome:partner-client-provisioned", { detail: { clientId: result.data.clientId } }));
    dispatchMailboxChanged("mailbox-import", { connectionId, missionId: result.data?.missionId, clientId: result.data?.clientId });
    button.textContent = result.data?.reanalyzed ? "Mission partenaire actualisée" : "Mission partenaire créée";
    feedback.textContent = result.data.message;
}

async function downloadMailboxAttachment(button, connectionId, messageRef) {
    const filename = button.dataset.mailboxAttachmentName || "document";
    const originalLabel = button.textContent;
    button.disabled = true; button.textContent = "Téléchargement…";
    try {
        const response = await fetch(`/api/partner-email/${connectionId}/messages/${encodeURIComponent(messageRef)}/attachments/${encodeURIComponent(button.dataset.mailboxAttachment)}`, { credentials: "same-origin" });
        if (!response.ok) { const error = await response.json().catch(() => null); throw new Error(error?.message || "Cette pièce jointe est momentanément indisponible."); }
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement("a"); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { alert(error.message); }
    finally { button.disabled = false; button.textContent = originalLabel; }
}

async function submitMailboxReply(event, connectionId, messageRef) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = event.submitter || form.querySelector('[type="submit"]');
    const feedback = form.querySelector("[data-mailbox-reply-feedback]");
    const body = form.elements.body.value.trim();
    if (!body) return;
    button.disabled = true;
    const originalLabel = button.textContent; button.textContent = "Envoi en cours…";
    feedback.textContent = "Envoi de la réponse…";
    feedback.classList.remove("error");
    const result = await api(`/api/partner-email/${connectionId}/messages/${encodeURIComponent(messageRef)}/reply`, { method: "POST", body: JSON.stringify({ body }) });
    button.disabled = false;
    button.textContent = originalLabel;
    feedback.textContent = result.ok ? result.data.message : result.message;
    feedback.classList.toggle("error", !result.ok);
    if (result.ok) { form.elements.body.value = ""; dispatchMailboxChanged("reply", { connectionId }); }
}

function bindMailboxClose(browser) {
    browser.querySelector("[data-mailbox-close]")?.addEventListener("click", () => browser.remove());
}

function mailboxAddressLabel(value) {
    if (!value) return "";
    return value.name && value.address ? `${value.name} <${value.address}>` : value.name || value.address || "";
}

function formatBytes(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) return `${bytes} o`;
    if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} Ko`;
    return `${(bytes / (1024 * 1024)).toFixed(1).replace(".0", "")} Mo`;
}

async function beginMailboxOauth(provider, settings) {
    const result = await api(`/api/partner-email/oauth/${provider}/authorize`, { method: "POST", body: JSON.stringify({ selectionMode: settings.selectionMode || "manual", sendStatusUpdates: Boolean(settings.sendStatusUpdates), autoSearchEnabled: Boolean(settings.autoSearchEnabled), allowedSenders: settings.allowedSenders || "", requiredKeywords: settings.requiredKeywords || "" }) });
    if (!result.ok) return alert(result.message);
    const popup = window.open(result.data.authorizationUrl, "depannhome-mail-oauth", "popup,width=620,height=760");
    if (!popup) return alert("Autorisez les fenêtres contextuelles pour connecter la boîte professionnelle.");
    pendingMailboxOauth = true;
    showSettingsFeedback(activeSettingsCard, "Autorisation Microsoft en cours…");
}

async function handleMailboxOauthResult(payload) {
    if (payload?.type !== "depannhome:partner-email-oauth") return;
    if (!pendingMailboxOauth) return;
    pendingMailboxOauth = false;
    window.clearTimeout(mailboxOauthRefreshTimer);
    if (!payload.success) {
        if (activeSettingsCard?.isConnected) showSettingsFeedback(activeSettingsCard, payload.message || "Connexion de la boîte impossible.", true);
        else alert(payload.message || "Connexion de la boîte impossible.");
        return;
    }
    if (activeSettingsCard?.isConnected) {
        await loadPartnerEmailSettings(activeSettingsCard);
        showSettingsFeedback(activeSettingsCard, payload.message || "Boîte professionnelle connectée et vérifiée.");
    }
    dispatchMailboxChanged("connection");
}

window.addEventListener("message", event => {
    if (event.origin !== window.location.origin || event.data?.type !== "depannhome:partner-email-oauth") return;
    void handleMailboxOauthResult(event.data);
});

window.addEventListener("storage", event => {
    if (event.key !== MAILBOX_OAUTH_STORAGE_KEY || !event.newValue) return;
    try { void handleMailboxOauthResult(JSON.parse(event.newValue)); }
    catch { /* Un résultat OAuth invalide est ignoré. */ }
});

window.addEventListener("focus", () => {
    if (!pendingMailboxOauth || !activeSettingsCard?.isConnected) return;
    window.clearTimeout(mailboxOauthRefreshTimer);
    mailboxOauthRefreshTimer = window.setTimeout(() => {
        if (pendingMailboxOauth && activeSettingsCard?.isConnected) void loadPartnerEmailSettings(activeSettingsCard);
    }, 500);
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

function canOpenPartnerMissions() { return ["admin", "pc_standard", "mobile_admin"].includes(document.body.dataset.role); }
function canConfigureMailbox() { return document.body.dataset.role === "admin" && document.body.dataset.deviceType === "desktop"; }
function localDateValue(value) { const offset = value.getTimezoneOffset() * 60000; return new Date(value.getTime() - offset).toISOString().slice(0, 10); }
function formatShortDate(value) { return new Intl.DateTimeFormat("fr-FR").format(new Date(`${value}T12:00:00`)); }

async function api(url, options = {}) {
    try {
        const response = await fetch(url, { credentials: "same-origin", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
        const data = response.status === 204 ? null : await response.json().catch(() => null);
        return { ok: response.ok, data, message: data?.message || "Serveur indisponible." };
    } catch {
        return { ok: false, message: "Serveur indisponible." };
    }
}
