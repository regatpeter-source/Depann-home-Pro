export async function initializeAuthentication({ onAuthenticated }) {
    const session = await request("/api/auth/session");
    if (session.ok && session.data.authenticated) {
        onAuthenticated(session.data.user);
        return;
    }

    renderAuthentication({
        onAuthenticated,
        registrationEnabled: Boolean(session.data?.registrationEnabled),
        message: session.networkError ? "Impossible de joindre le serveur." : ""
    });
}

export async function signOut() {
    await request("/api/auth/logout", { method: "POST" });
}

function renderAuthentication({ onAuthenticated, registrationEnabled, message = "" }) {
    const app = getAppRoot();
    app.innerHTML = `
        <main class="auth-page">
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

    app.querySelector("#loginForm").addEventListener("submit", async event => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        setStatus("Connexion en cours...");
        const result = await request("/api/auth/login", {
            method: "POST",
            body: JSON.stringify({ username: form.get("username"), password: form.get("password"), ...getDeviceIdentity() })
        });
        if (!result.ok) {
            if (result.data?.codeRequired) {
                renderCodeVerification({ onAuthenticated, deviceId: result.data.deviceId, message: result.data.message });
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

function renderCodeVerification({ onAuthenticated, deviceId, message }) {
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

function getDeviceIdentity() {
    const key = "depannHomePro:deviceId";
    let deviceId = localStorage.getItem(key);
    if (!deviceId || !/^[0-9a-f-]{36}$/i.test(deviceId)) {
        deviceId = crypto.randomUUID();
        localStorage.setItem(key, deviceId);
    }
    const deviceType = window.matchMedia("(pointer: coarse)").matches ? "mobile" : "desktop";
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
