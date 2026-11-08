const button = document.querySelector("[data-install-mobile]");
const control = document.querySelector("[data-install-control]");
const status = document.querySelector("[data-install-status]");
let installPrompt;
let installed = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

function showInstalledState() {
    installPrompt = null;
    installed = true;
    control.hidden = true;
    status.textContent = "L’application est installée. Ouvrez son icône sur l’écran d’accueil pour vous connecter.";
}

if (installed) showInstalledState();

window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    if (installed) return;
    installPrompt = event;
    control.hidden = false;
    status.textContent = "Votre navigateur propose l’installation. Touchez le bouton pour la confirmer.";
});

button.addEventListener("click", async () => {
    if (!installPrompt) return;
    const prompt = installPrompt;
    installPrompt = null;
    button.disabled = true;
    try {
        await prompt.prompt();
        const choice = await prompt.userChoice;
        if (!installed) status.textContent = choice.outcome === "accepted"
            ? "Installation demandée. Attendez la confirmation de votre téléphone, puis ouvrez l’icône de l’application."
            : "Installation annulée. Vous pouvez utiliser le menu du navigateur ou ouvrir l’application sans l’installer.";
    } catch (error) {
        console.warn("[mobile-installation] prompt unavailable", error.name);
        status.textContent = "L’installation n’a pas pu être proposée. Utilisez le menu du navigateur et les étapes ci-dessous.";
    } finally {
        control.hidden = !installPrompt;
        button.disabled = false;
    }
});

window.addEventListener("appinstalled", showInstalledState);
