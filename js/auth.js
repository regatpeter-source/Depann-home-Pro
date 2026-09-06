let applicationShell = "";
let deviceValidationTimer = null;

export async function initializeAuthentication({ onAuthenticated }) {
    if (!applicationShell) applicationShell = getAppRoot().innerHTML;
    const session = await request("/api/auth/session");
    if (session.ok && session.data.authenticated) {
        onAuthenticated(session.data.user);
        return;
    }

    const sessionReason = new URLSearchParams(window.location.search).get("session");
    renderAuthentication({
        onAuthenticated,
        registrationEnabled: Boolean(session.data?.registrationEnabled),
        message: session.data?.sessionReplaced
            ? "Cette session Poste Admin a été fermée car une connexion plus récente a été ouverte."
            : session.data?.deviceIdentityChanged
                ? "Le type de cet appareil a changé. Reconnectez-vous pour activer l’interface adaptée sans modifier silencieusement vos postes."
                : sessionReason === "expired"
                    ? "Votre session a expiré. Reconnectez-vous pour continuer."
                    : sessionReason === "logged-out"
                        ? "Vous êtes maintenant déconnecté."
            : session.networkError ? "Impossible de joindre le serveur." : ""
    });
}

export async function signOut() {
    return request("/api/auth/logout", { method: "POST" });
}

export function restoreApplicationShell() {
    const root = getAppRoot();
    if (!applicationShell || document.getElementById("app")) return Boolean(document.getElementById("app"));
    root.innerHTML = applicationShell;
    return Boolean(document.getElementById("app"));
}

function renderAuthentication({ onAuthenticated, registrationEnabled, message = "" }) {
    stopDeviceValidationPolling();
    const app = getAppRoot();
    app.innerHTML = `
        <main class="auth-page">
            <div class="auth-access-layout">
            <section class="auth-card">
                <div class="auth-brand">
                    <img src="assets/logo.png.png" alt="Depann'Home Pro" class="auth-logo">
                    <div>
                        <h1>Depann'Home Pro</h1>
                        <p>Connexion professionnelle</p>
                    </div>
                </div>
                <p id="authMessage" class="auth-message" aria-live="polite">${escapeHtml(message)}</p>
                <form id="loginForm" class="auth-form">
                    <label>Nom d’utilisateur<input name="username" type="text" autocomplete="username" minlength="3" maxlength="32" required></label>
                    ${passwordField("Mot de passe", "current-password")}
                    <button type="submit" class="secondary-button">Se connecter</button>
                </form>
                ${registrationEnabled ? `
                    <div class="auth-separator">ou</div>
                    <form id="signupForm" class="auth-form">
                        <label>Nouveau nom d’utilisateur<input name="username" type="text" autocomplete="username" minlength="3" maxlength="32" required></label>
                        ${passwordField("Créer un mot de passe", "new-password")}
                        <button type="submit" class="secondary-button auth-outline-button">Créer un compte</button>
                    </form>` : ""}
            </section>
            <aside class="auth-partner-card">
                <p class="eyebrow">Partenariats</p>
                <h2>Vous représentez une organisation ?</h2>
                <p>Vous êtes une assurance, un assisteur, un expert, une collectivité, un bailleur ou un donneur d’ordres ?</p>
                <p>Rejoignez le réseau Depann’Home Pro afin d’échanger automatiquement vos interventions avec les entreprises utilisant notre logiciel.</p>
                <button type="button" class="secondary-button" id="openPartnerRequest">Devenir partenaire</button>
                <p class="auth-partner-login-hint"><strong>Déjà partenaire ?</strong> Connectez-vous avec vos identifiants professionnels.</p>
            </aside>
            </div>
        </main>
    `;

    document.body.classList.remove("auth-pending");
    const status = app.querySelector("#authMessage");
    app.querySelectorAll("[data-password-toggle]").forEach(button => button.addEventListener("click", () => {
        const input = button.parentElement.querySelector("input");
        const visible = input.type === "password";
        input.type = visible ? "text" : "password";
        button.textContent = visible ? "Masquer" : "Afficher";
        button.setAttribute("aria-pressed", String(visible));
        input.focus();
    }));
    const setStatus = (text, isError = false) => {
        status.textContent = text;
        status.classList.toggle("error", isError);
    };
    app.querySelector("#openPartnerRequest")?.addEventListener("click", openPartnerRequestDialog);

    app.querySelector("#loginForm").addEventListener("submit", async event => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        setStatus("Connexion en cours...");
        const result = await request("/api/auth/login", {
            method: "POST",
            body: JSON.stringify({ username: form.get("username"), password: form.get("password"), ...getDeviceIdentity() })
        });
        if (result.data?.companyTotpRequired) {
            renderCompanyTotpVerification({ onAuthenticated, registrationEnabled, challenge: result.data.challenge, message: result.data.message });
            return;
        }
        if (result.data?.totpRequired) {
            renderCreatorTotpVerification({ onAuthenticated, registrationEnabled, challenge: result.data.challenge, message: result.data.message });
            return;
        }
        if (!result.ok) {
            if (result.data?.codeRequired) {
                renderCodeVerification({ onAuthenticated, deviceId: result.data.deviceId, message: result.data.message });
                return;
            }
            if (result.data?.approvalRequired) {
                renderDeviceValidationPending({ onAuthenticated, registrationEnabled, deviceId: result.data.deviceId, message: result.data.message });
                return;
            }
            setStatus(result.data?.message || "Impossible de se connecter.", true);
            return;
        }
        onAuthenticated(result.data.user);
    });

    app.querySelector("#signupForm")?.addEventListener("submit", async event => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        setStatus("Création du compte en cours...");
        const result = await request("/api/auth/register", {
            method: "POST",
            body: JSON.stringify({ username: form.get("username"), password: form.get("password"), ...getDeviceIdentity() })
        });
        if (!result.ok) {
            setStatus(result.data?.message || "Impossible de créer le compte.", true);
            return;
        }
        onAuthenticated(result.data.user);
    });
}

function openPartnerRequestDialog() {
    const modal = document.createElement("div");
    modal.className = "auth-partner-modal";
    modal.innerHTML = `
        <section role="dialog" aria-modal="true" aria-labelledby="partnerRequestTitle">
            <button type="button" class="text-button auth-partner-close" aria-label="Fermer">Fermer</button>
            <p class="eyebrow">Partenariat Depann’Home Pro</p>
            <h2 id="partnerRequestTitle">Devenir partenaire</h2>
            <p class="muted">Présentez votre organisation et votre besoin. Cette demande ne crée pas de compte de connexion.</p>
            <form id="partnerRequestForm" class="auth-partner-form">
                <div class="form-grid">
                    <label>Nom de l’entreprise *<input name="companyName" maxlength="160" required autocomplete="organization"></label>
                    <label>Type d’organisation *<select name="organizationType" required><option value="">Sélectionnez…</option><option value="insurance">Assurance</option><option value="assistance_company">Société d’assistance</option><option value="expert">Expert</option><option value="claims_manager">Gestionnaire de sinistres</option><option value="local_authority">Collectivité</option><option value="landlord">Bailleur</option><option value="franchise_network">Réseau de franchise</option><option value="private_company">Entreprise privée</option><option value="other">Autre</option></select></label>
                    <label>Nom du contact *<input name="contactName" maxlength="100" required autocomplete="name"></label>
                    <label>Fonction *<input name="contactRole" maxlength="100" required autocomplete="organization-title"></label>
                    <label>Adresse e-mail *<input name="email" type="email" maxlength="160" required autocomplete="email"></label>
                    <label>Téléphone *<input name="phone" type="tel" maxlength="50" required autocomplete="tel"></label>
                    <label class="form-wide">Site internet <input name="website" type="url" maxlength="500" placeholder="https://www.exemple.fr" autocomplete="url"></label>
                    <label class="form-wide">Décrivez votre projet ou votre besoin *<textarea name="message" rows="6" maxlength="4000" minlength="10" required></textarea></label>
                </div>
                <p class="auth-message" aria-live="polite" data-partner-request-message></p>
                <div class="form-actions"><button type="submit" class="secondary-button">Envoyer ma demande</button></div>
            </form>
        </section>
    `;
    const close = () => modal.remove();
    modal.querySelector(".auth-partner-close").addEventListener("click", close);
    modal.addEventListener("click", event => { if (event.target === modal) close(); });
    modal.querySelector("#partnerRequestForm").addEventListener("submit", async event => {
        event.preventDefault();
        const form = event.currentTarget;
        const feedback = form.querySelector("[data-partner-request-message]");
        const submit = form.querySelector('button[type="submit"]');
        submit.disabled = true;
        feedback.textContent = "Envoi de votre demande…";
        feedback.classList.remove("error");
        const result = await request("/api/partner-requests", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
        if (!result.ok) {
            feedback.textContent = result.data?.message || "Impossible d’envoyer votre demande. Réessayez dans quelques instants.";
            feedback.classList.add("error");
            submit.disabled = false;
            return;
        }
        form.innerHTML = `<section class="auth-partner-confirmation"><h3>Merci pour votre demande de partenariat.</h3><p>Notre équipe va étudier votre demande et vous recontactera dans les meilleurs délais.</p></section>`;
    });
    document.body.appendChild(modal);
    modal.querySelector("input")?.focus();
}

function renderDeviceValidationPending({ onAuthenticated, registrationEnabled, deviceId, message }) {
    stopDeviceValidationPolling();
    const app = getAppRoot();
    app.innerHTML = `
        <main class="auth-page"><section class="auth-card auth-validation-card">
            <div class="auth-brand"><img src="assets/logo.png.png" alt="Depann'Home Pro" class="auth-logo"><div><h1>Depann'Home Pro</h1><p>Validation de l’appareil</p></div></div>
            <div class="auth-validation-pending" role="status" aria-live="polite"><span class="auth-validation-spinner" aria-hidden="true"></span><div><strong>En attente de validation</strong><p id="authMessage" class="auth-message">${escapeHtml(message || "En attente de la validation de l’administrateur…")}</p><p class="muted">Dès que l’administrateur envoie le code, sa saisie s’affichera automatiquement ici.</p></div></div>
            <button type="button" class="secondary-button auth-outline-button" id="backToAuthentication">Retour à la connexion</button>
        </section></main>`;
    const status = app.querySelector("#authMessage");
    app.querySelector("#backToAuthentication").addEventListener("click", () => renderAuthentication({ onAuthenticated, registrationEnabled }));
    const checkStatus = async () => {
        const result = await request("/api/auth/device-validation-status", { method: "POST", body: JSON.stringify({ deviceId }) });
        if (!result.ok) {
            if (!result.networkError) {
                status.textContent = result.data?.message || "Impossible de vérifier la validation de l’appareil.";
                status.classList.add("error");
            }
            return;
        }
        if (result.data?.codeRequired) {
            stopDeviceValidationPolling();
            renderCodeVerification({ onAuthenticated, deviceId, message: result.data.message });
            return;
        }
        if (result.data?.rejected) {
            stopDeviceValidationPolling();
            status.textContent = result.data.message;
            status.classList.add("error");
            return;
        }
        status.textContent = result.data?.message || "En attente de la validation de l’administrateur…";
    };
    deviceValidationTimer = window.setInterval(checkStatus, 3_000);
}

function renderCodeVerification({ onAuthenticated, deviceId, message }) {
    stopDeviceValidationPolling();
    const app = getAppRoot();
    app.innerHTML = `
        <main class="auth-page"><section class="auth-card">
            <div class="auth-brand"><img src="assets/logo.png.png" alt="Depann'Home Pro" class="auth-logo"><div><h1>Depann'Home Pro</h1><p>Validation de l’appareil</p></div></div>
            <p id="authMessage" class="auth-message" aria-live="polite">${escapeHtml(message)}</p>
            <form id="deviceCodeForm" class="auth-form">
                <label>Code reçu par e-mail<input name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus></label>
                <button type="submit" class="secondary-button">Valider l’appareil</button>
            </form>
        </section></main>`;
    const status = app.querySelector("#authMessage");
    app.querySelector("#deviceCodeForm").addEventListener("submit", async event => {
        event.preventDefault();
        status.textContent = "Vérification du code…";
        status.classList.remove("error");
        const code = new FormData(event.currentTarget).get("code");
        const result = await request("/api/auth/verify-device-code", { method: "POST", body: JSON.stringify({ deviceId, code }) });
        if (!result.ok) { status.textContent = result.data?.message || "Impossible de valider le code."; status.classList.add("error"); return; }
        onAuthenticated(result.data.user);
    });
}

function renderCreatorTotpVerification({ onAuthenticated, registrationEnabled, challenge, message }) {
    stopDeviceValidationPolling();
    const app = getAppRoot();
    app.innerHTML = `
        <main class="auth-page"><section class="auth-card">
            <div class="auth-brand"><img src="assets/logo.png.png" alt="Depann'Home Pro" class="auth-logo"><div><h1>Depann'Home Pro</h1><p>Vérification en deux étapes</p></div></div>
            <p id="authMessage" class="auth-message" aria-live="polite">${escapeHtml(message || "Saisissez le code affiché dans Google Authenticator.")}</p>
            <form id="creatorTotpForm" class="auth-form">
                <label>Code Google Authenticator<input name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus placeholder="000000"></label>
                <button type="submit" class="secondary-button">Vérifier et se connecter</button>
            </form>
            <button type="button" class="secondary-button auth-outline-button" id="backToAuthentication">Retour à la connexion</button>
        </section></main>`;
    const status = app.querySelector("#authMessage");
    app.querySelector("#backToAuthentication").addEventListener("click", () => renderAuthentication({ onAuthenticated, registrationEnabled }));
    app.querySelector("#creatorTotpForm").addEventListener("submit", async event => {
        event.preventDefault();
        const submittedForm = event.currentTarget;
        status.textContent = "Vérification du code…";
        status.classList.remove("error");
        const code = new FormData(submittedForm).get("code");
        const result = await request("/api/auth/verify-creator-totp", { method: "POST", body: JSON.stringify({ challenge, code }) });
        if (!result.ok) {
            status.textContent = result.data?.message || "Impossible de vérifier le code de sécurité.";
            status.classList.add("error");
            submittedForm.elements.code.select();
            return;
        }
        onAuthenticated(result.data.user);
    });
}

function renderCompanyTotpVerification({ onAuthenticated, registrationEnabled, challenge, message }) {
    stopDeviceValidationPolling();
    const app = getAppRoot();
    app.innerHTML = `
        <main class="auth-page"><section class="auth-card">
            <div class="auth-brand"><img src="assets/logo.png.png" alt="Depann'Home Pro" class="auth-logo"><div><h1>Depann'Home Pro</h1><p>Vérification en deux étapes</p></div></div>
            <p id="authMessage" class="auth-message" aria-live="polite">${escapeHtml(message || "Saisissez le code affiché dans votre application d’authentification.")}</p>
            <form id="companyTotpForm" class="auth-form">
                <label>Code d’authentification<input name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus placeholder="000000"></label>
                <button type="submit" class="secondary-button">Vérifier et se connecter</button>
            </form>
            <button type="button" class="secondary-button auth-outline-button" id="backToAuthentication">Retour à la connexion</button>
        </section></main>`;
    const status = app.querySelector("#authMessage");
    app.querySelector("#backToAuthentication").addEventListener("click", () => renderAuthentication({ onAuthenticated, registrationEnabled }));
    app.querySelector("#companyTotpForm").addEventListener("submit", async event => {
        event.preventDefault();
        const submittedForm = event.currentTarget;
        status.textContent = "Vérification du code…";
        status.classList.remove("error");
        const code = new FormData(submittedForm).get("code");
        const result = await request("/api/auth/verify-company-totp", { method: "POST", body: JSON.stringify({ challenge, code }) });
        if (!result.ok) {
            status.textContent = result.data?.message || "Impossible de vérifier le code de sécurité.";
            status.classList.add("error");
            submittedForm.elements.code.select();
            return;
        }
        onAuthenticated(result.data.user);
    });
}

function stopDeviceValidationPolling() {
    if (!deviceValidationTimer) return;
    window.clearInterval(deviceValidationTimer);
    deviceValidationTimer = null;
}

export function getDeviceIdentity() {
    const key = "depannHomePro:deviceId";
    let deviceId = localStorage.getItem(key);
    if (!deviceId || !/^[0-9a-f-]{36}$/i.test(deviceId)) {
        deviceId = crypto.randomUUID();
        localStorage.setItem(key, deviceId);
    }
    const deviceType = window.matchMedia("(pointer: coarse)").matches || /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent)
        ? "mobile"
        : "desktop";
    return { deviceId, deviceLabel: navigator.userAgent.slice(0, 100), deviceType };
}

function passwordField(label, autocomplete) {
    return `<label>${label}<span class="password-input"><input name="password" type="password" autocomplete="${autocomplete}" minlength="12" required><button type="button" class="password-toggle" data-password-toggle aria-label="Afficher le mot de passe" aria-pressed="false">Afficher</button></span></label>`;
}

async function request(url, options = {}) {
    try {
        const response = await fetch(url, {
            credentials: "same-origin",
            headers: { "Content-Type": "application/json", ...(options.headers || {}) },
            ...options
        });
        const data = response.status === 204 ? null : await response.json().catch(() => null);
        return { ok: response.ok, data };
    } catch {
        return { ok: false, data: null, networkError: true };
    }
}

function getAppRoot() {
    return document.getElementById("authRoot") || document.body;
}

function escapeHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
