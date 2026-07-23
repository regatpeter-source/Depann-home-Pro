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
                <p class="muted">Connectez-vous pour accéder à l’application.</p>
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
            body: JSON.stringify({ username: form.get("username"), password: form.get("password") })
        });
        if (!result.ok) {
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
            body: JSON.stringify({ username: form.get("username"), password: form.get("password") })
        });
        if (!result.ok) {
            setStatus(result.data?.message || "Impossible de créer le compte.", true);
            return;
        }
        onAuthenticated(result.data.user);
    });
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
