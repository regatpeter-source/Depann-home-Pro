import { getSessionDisplayName } from "./session-context.js?v=1";

export function updateDesktopGreeting(user, root = document) {
    const greeting = root.getElementById("desktopGreeting");
    const name = root.getElementById("desktopGreetingName");
    const defaultName = root.getElementById("desktopGreetingDefault");
    const companyContext = root.getElementById("desktopGreetingCompanyContext");
    const company = root.getElementById("desktopGreetingCompany");
    if (!greeting || !name || !defaultName || !companyContext || !company) {
        console.error("Le bandeau d’accueil du poste PC est introuvable.");
        return;
    }

    const displayName = user ? getSessionDisplayName(user) : "";
    const companyName = user ? String(user.activeCompanyName || "").trim() : "";
    if (name.textContent !== displayName) name.textContent = displayName;
    if (company.textContent !== companyName) company.textContent = companyName;
    name.title = displayName;
    company.title = companyName;
    name.hidden = !displayName;
    defaultName.hidden = !user || Boolean(displayName);
    companyContext.hidden = !companyName;
    greeting.hidden = !user || user.deviceType === "mobile";
}
