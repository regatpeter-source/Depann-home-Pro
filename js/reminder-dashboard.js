import { escapeHtml } from "./utils.js?v=44";
import { markDesktopWorkspaceDraftSaved, restoreDesktopWorkspaceDraft } from "./desktop-workspace.js?v=6";

const RULE_DEFINITIONS = Object.freeze({
    maintenance_due: { label: "Maintenance à planifier", detail: "Prochaine visite des contrats actifs" },
    contract_renewal: { label: "Renouvellement de contrat", detail: "Date de fin des contrats actifs" },
    low_stock: { label: "Stock faible", detail: "Total au seuil de l’article ou en dessous" }
});
const MANAGER_ROLES = new Set(["admin", "pc_standard", "mobile_admin"]);

export function canAccessReminderDashboard({ role, organizationInterface, supportControl }) {
    return MANAGER_ROLES.has(role) && organizationInterface !== "partner" && supportControl !== "true";
}

export function reminderDashboardMarkup() {
    return `<section class="dashboard-card dashboard-reminders" data-dashboard-reminders aria-busy="true" tabindex="-1">
        <div class="dashboard-reminders-heading">
            <div><p class="eyebrow">Planning et ressources</p><h3>Rappels internes</h3><p class="muted">Aucun e-mail n’est envoyé et aucune intervention n’est créée ou modifiée automatiquement.</p><p class="muted">Les informations affichées correspondent à la recherche qui a créé le rappel : vérifiez la ressource avant d’agir.</p></div>
            <div class="dashboard-reminders-actions"><button type="button" class="secondary-button" data-reminders-refresh>Actualiser</button><button type="button" class="secondary-button" data-reminders-run>Rechercher maintenant</button></div>
        </div>
        <p class="auth-message" data-reminders-message aria-live="polite"></p>
        <div data-reminders-content><p class="muted">Chargement des rappels…</p></div>
        <details class="dashboard-reminders-settings">
            <summary>Configurer les rappels</summary>
            <p class="muted">Aucune règle n’est créée automatiquement. La recherche manuelle porte sur les trois catégories proposées ici ; les autres règles préexistantes ne sont pas modifiées.</p>
            <div data-reminders-rules></div>
            <form class="dashboard-reminders-form" data-reminders-create>
                <h4>Activer une nouvelle règle</h4>
                <label>Catégorie<select id="reminder-create-type" name="ruleType" required>
                    <option value="maintenance_due">Maintenance à planifier</option>
                    <option value="contract_renewal">Renouvellement de contrat</option>
                    <option value="low_stock">Stock faible</option>
                </select></label>
                <label data-reminders-lead>Jours avant l’échéance<input id="reminder-create-lead" name="leadDays" type="number" min="0" max="365" step="1" value="0" required></label>
                <p class="muted">Pour le stock, définissez le seuil sur chaque article. Chaque règle possède ses propres rappels : évitez de créer des doublons.</p>
                <button type="submit" class="secondary-button">Activer cette règle</button>
            </form>
            <p class="muted">Désactiver une règle ou changer une date ne ferme pas les rappels déjà créés : traitez-les ou ignorez-les manuellement.</p>
            <p class="muted">Les règles de stock créées ici évitent plusieurs rappels ouverts pour le même article. Après traitement, une alerte peut revenir le jour suivant si le stock reste faible.</p>
        </details>
    </section>`;
}

export function mountReminderDashboard(section, { openResources = null, openPlanning = null } = {}) {
    if (!section) return;
    const message = section.querySelector("[data-reminders-message]");
    const content = section.querySelector("[data-reminders-content]");
    const rulesHost = section.querySelector("[data-reminders-rules]");
    const createForm = section.querySelector("[data-reminders-create]");
    const ruleDrafts = new Map();
    let data = null;
    let busy = false;
    let createBaseline = createValues();

    function createValues() {
        return { ruleType: createForm.elements.ruleType.value, leadDays: createForm.elements.leadDays.value };
    }

    function hasUnsavedChanges() {
        const current = createValues();
        return ruleDrafts.size > 0 || current.ruleType !== createBaseline.ruleType || current.leadDays !== createBaseline.leadDays;
    }

    function trackRuleDraft(event) {
        const form = event.target.closest("[data-reminder-rule]");
        if (!form || !data) return;
        const rule = data.rules.find(item => String(item.id) === form.dataset.reminderRule);
        if (!rule) return;
        const draft = {
            ruleType: rule.ruleType,
            leadDays: form.elements.leadDays?.value,
            isActive: form.elements.isActive.checked
        };
        if (draft.isActive !== rule.isActive || (draft.leadDays !== undefined && draft.leadDays !== String(rule.leadDays))) {
            ruleDrafts.set(String(rule.id), draft);
        } else {
            ruleDrafts.delete(String(rule.id));
        }
    }

    function showMessage(text, error = false) {
        message.textContent = text;
        message.classList.toggle("error", error);
    }

    function setBusy(value) {
        busy = value;
        section.setAttribute("aria-busy", String(value));
        section.querySelectorAll("button").forEach(button => { button.disabled = value || (!data && !button.hasAttribute("data-reminders-refresh")); });
        section.querySelectorAll("input, select").forEach(control => {
            control.disabled = value || !data || (control === createForm.elements.leadDays && createForm.elements.ruleType.value === "low_stock");
        });
    }

    function updateLeadVisibility() {
        const lowStock = createForm.elements.ruleType.value === "low_stock";
        const field = createForm.querySelector("[data-reminders-lead]");
        field.hidden = lowStock;
        createForm.elements.leadDays.disabled = busy || !data || lowStock;
        createForm.elements.leadDays.required = !lowStock;
    }

    async function load() {
        const next = await requestJson("/api/automation/dashboard");
        if (!Array.isArray(next?.rules) || !Array.isArray(next?.reminders) || !Array.isArray(next?.runs)
            || next.rules.some(rule => !validId(rule.id) || typeof rule.name !== "string" || typeof rule.isActive !== "boolean"
                || !Object.hasOwn(RULE_DEFINITIONS, rule.ruleType)
                || !Number.isInteger(rule.leadDays) || rule.leadDays < 0 || rule.leadDays > 365
                || !rule.configuration || typeof rule.configuration !== "object" || Array.isArray(rule.configuration))
            || next.reminders.some(reminder => !validId(reminder.id) || !["open", "done", "dismissed"].includes(reminder.status)
                || typeof reminder.title !== "string" || typeof reminder.details !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(String(reminder.dueDate || "")))
            || next.runs.some(run => !["running", "completed", "failed"].includes(run.status)
                || !Number.isInteger(run.createdCount) || run.createdCount < 0)) {
            throw new Error("Les données de rappels sont incomplètes. Actualisez ou contactez le support.");
        }
        if (!section.isConnected) return;
        for (const [id, draft] of ruleDrafts) {
            const rule = next.rules.find(item => String(item.id) === id);
            if (!rule || rule.ruleType !== draft.ruleType) {
                throw new Error("Une règle en cours de modification a été supprimée ou changée. Vos saisies restent affichées : vérifiez-les avant de quitter.");
            }
        }
        data = next;
        renderData();
    }

    function renderData() {
        const open = data.reminders.filter(reminder => reminder.status === "open");
        const closed = data.reminders.filter(reminder => reminder.status !== "open")
            .sort((a, b) => String(b.completedAt || b.createdAt || "").localeCompare(String(a.completedAt || a.createdAt || "")));
        const lastRun = data.runs[0];
        const lastRunText = lastRun
            ? lastRun.status === "completed"
                ? `Dernière recherche : ${dateTimeLabel(lastRun.completedAt || lastRun.startedAt)} · ${Number(lastRun.createdCount)} rappel(s) créé(s), toutes catégories exécutées confondues.`
                : lastRun.status === "failed"
                    ? `Dernière recherche en échec (${dateTimeLabel(lastRun.startedAt)}). Réessayez ou contactez le support.`
                    : `Recherche en cours depuis ${dateTimeLabel(lastRun.startedAt)}.`
            : "Aucune recherche effectuée pour cette entreprise.";
        content.innerHTML = `<p class="muted">${escapeHtml(lastRunText)}</p>
            ${data.reminders.length === 300 ? '<p class="muted">Affichage limité aux 300 premiers rappels, ouverts en priorité. Traitez les rappels affichés pour accéder aux suivants.</p>' : ""}
            <div class="dashboard-reminders-list">${open.map(reminder => reminderHtml(reminder, openResources, openPlanning)).join("") || '<p class="muted">Aucun rappel ouvert parmi les données chargées.</p>'}</div>
            ${closed.length ? `<details class="dashboard-reminders-history"><summary>Rappels traités ou ignorés (${closed.length} affiché(s))</summary><div class="dashboard-reminders-list">${closed.map(reminder => reminderHtml(reminder, openResources, openPlanning)).join("")}</div></details>` : ""}`;
        rulesHost.innerHTML = data.rules.length
            ? data.rules.map(ruleHtml).join("")
            : '<p class="muted">Aucune règle configurée pour cette entreprise.</p>';
        rulesHost.querySelectorAll("[data-reminder-rule]").forEach(form => {
            const draft = ruleDrafts.get(form.dataset.reminderRule);
            if (!draft) return;
            if (form.elements.leadDays) form.elements.leadDays.value = draft.leadDays;
            form.elements.isActive.checked = draft.isActive;
        });
    }

    async function perform(action, successMessage, { mutation = true, onSaved = null } = {}) {
        if (busy) return;
        rulesHost.querySelectorAll("[data-reminder-rule]").forEach(form => trackRuleDraft({ target: form }));
        setBusy(true);
        showMessage("");
        let completed = false;
        try {
            const result = await action();
            completed = result?.skipped !== true;
            if (onSaved) {
                onSaved();
                if (!hasUnsavedChanges()) markDesktopWorkspaceDraftSaved();
            }
            await load();
            if (section.isConnected) showMessage(typeof successMessage === "function" ? successMessage(result) : successMessage);
        } catch (error) {
            if (section.isConnected) {
                const detail = error instanceof Error ? error.message : "Erreur inattendue.";
                showMessage(completed && mutation ? `Action enregistrée, mais actualisation impossible : ${detail}` : detail, true);
                if (!data) content.innerHTML = '<p class="auth-message error">Les rappels sont indisponibles. Utilisez « Actualiser » pour réessayer.</p>';
            }
        } finally {
            if (section.isConnected) setBusy(false);
        }
    }

    createForm.elements.ruleType.addEventListener("change", updateLeadVisibility);
    section.addEventListener("input", trackRuleDraft);
    section.addEventListener("change", trackRuleDraft);
    updateLeadVisibility();
    section.addEventListener("click", event => {
        const button = event.target.closest("button");
        if (!button || !section.contains(button) || busy) return;
        if (button.hasAttribute("data-reminders-refresh")) {
            void perform(async () => null, "Rappels actualisés.", { mutation: false });
        } else if (button.hasAttribute("data-reminders-run")) {
            void perform(async () => {
                const result = await requestJson("/api/automation/dashboard/run", { method: "POST" });
                if (result?.skipped !== true && (result?.status !== "completed" || !Number.isInteger(result.createdCount) || result.createdCount < 0)) {
                    throw new Error("Résultat de recherche inattendu. Actualisez avant de réessayer.");
                }
                return result;
            }, result => {
                if (result?.skipped === true) return "Une recherche est déjà en cours. Actualisez dans quelques instants.";
                return `Recherche terminée : ${result.createdCount} nouveau(x) rappel(s).`;
            });
        } else if (button.hasAttribute("data-reminder-status")) {
            const id = button.dataset.reminderId;
            const status = button.dataset.reminderStatus;
            if (!data.reminders.some(reminder => String(reminder.id) === id) || !["open", "done", "dismissed"].includes(status)) return;
            void perform(() => requestJson(`/api/automation/reminders/${encodeURIComponent(id)}`, { method: "PATCH", body: { status } }), "État du rappel enregistré.");
        } else if (button.hasAttribute("data-reminder-resource") && openResources) {
            const reminder = data.reminders.find(item => String(item.id) === button.dataset.reminderId);
            if (reminder?.entityType === "inventory_item") openResources({ tab: "inventory" });
            else if (reminder?.entityType === "maintenance_contract" && reminder.clientId) openResources({ tab: "assets", clientId: reminder.clientId });
        } else if (button.hasAttribute("data-reminder-planning") && openPlanning) {
            const reminder = data.reminders.find(item => String(item.id) === button.dataset.reminderId);
            if (reminder?.reminderType === "maintenance_due") openPlanning(reminder.dueDate);
        }
    });
    section.addEventListener("submit", event => {
        const form = event.target;
        if (!(form instanceof HTMLFormElement)) return;
        if (busy || !data) {
            event.preventDefault();
            return;
        }
        if (form === createForm) {
            event.preventDefault();
            const type = form.elements.ruleType.value;
            const definition = RULE_DEFINITIONS[type];
            const leadDays = type === "low_stock" ? 0 : Number(form.elements.leadDays.value);
            if (!definition || !validLeadDays(leadDays)) {
                showMessage("Choisissez une catégorie et un délai entier entre 0 et 365 jours.", true);
                return;
            }
            const configuration = type === "low_stock" ? { preventOpenDuplicates: true } : {};
            void perform(() => requestJson("/api/automation/rules", {
                method: "POST", body: { name: definition.label, ruleType: type, isActive: true, leadDays, configuration }
            }), "Règle activée. La prochaine recherche aura lieu automatiquement ou peut être lancée maintenant.", { onSaved: () => {
                createForm.reset();
                updateLeadVisibility();
                createBaseline = createValues();
            } });
        } else if (form.hasAttribute("data-reminder-rule")) {
            event.preventDefault();
            const rule = data.rules.find(item => String(item.id) === form.dataset.reminderRule);
            if (!rule) return;
            const leadDays = rule.ruleType === "low_stock" ? rule.leadDays : Number(form.elements.leadDays.value);
            if (!validLeadDays(leadDays)) {
                showMessage("Le délai doit être un nombre entier entre 0 et 365 jours.", true);
                return;
            }
            void perform(() => requestJson(`/api/automation/rules/${encodeURIComponent(rule.id)}`, {
                method: "PATCH",
                body: { name: rule.name, ruleType: rule.ruleType, isActive: form.elements.isActive.checked, leadDays, configuration: rule.configuration }
            }), "Règle enregistrée. Les rappels existants restent visibles jusqu’à leur traitement.", { onSaved: () => { ruleDrafts.delete(String(rule.id)); } });
        }
    });
    setBusy(true);
    void performInitialLoad();

    async function performInitialLoad() {
        try {
            await load();
            if (section.isConnected && restoreDesktopWorkspaceDraft()) {
                updateLeadVisibility();
                rulesHost.querySelectorAll("[data-reminder-rule]").forEach(form => trackRuleDraft({ target: form }));
            }
        } catch (error) {
            if (section.isConnected) {
                showMessage(error instanceof Error ? error.message : "Chargement impossible.", true);
                content.innerHTML = '<p class="auth-message error">Les rappels sont indisponibles. Utilisez « Actualiser » pour réessayer.</p>';
            }
        } finally {
            if (section.isConnected) setBusy(false);
        }
    }
}

function ruleHtml(rule) {
    const definition = RULE_DEFINITIONS[rule.ruleType];
    const label = definition.label;
    const detail = definition.detail;
    return `<form class="dashboard-reminders-rule" data-reminder-rule="${escapeHtml(String(rule.id))}">
        <div><strong>${escapeHtml(rule.name)}</strong><small>${escapeHtml(`${label} · ${detail}`)}</small></div>
        ${rule.ruleType === "low_stock" ? '<span class="muted">Seuil par article</span>' : `<label>Jours avant<input id="reminder-rule-${escapeHtml(String(rule.id))}-lead" type="number" name="leadDays" min="0" max="365" step="1" value="${rule.leadDays}" required></label>`}
        <label class="dashboard-reminders-check"><input id="reminder-rule-${escapeHtml(String(rule.id))}-active" type="checkbox" name="isActive" ${rule.isActive ? "checked" : ""}> Active</label>
        <button type="submit" class="secondary-button">Enregistrer</button>
    </form>`;
}

function reminderHtml(reminder, openResources, openPlanning) {
    const label = reminder.reminderType === "low_stock" ? "Constaté le" : "Échéance";
    const canOpen = openResources && (reminder.entityType === "inventory_item" || (reminder.entityType === "maintenance_contract" && reminder.clientId));
    const actions = reminder.status === "open"
        ? `<button type="button" class="secondary-button" data-reminder-id="${escapeHtml(String(reminder.id))}" data-reminder-status="done">Traité</button><button type="button" class="secondary-button" data-reminder-id="${escapeHtml(String(reminder.id))}" data-reminder-status="dismissed">Ignorer</button>`
        : `<span class="muted">${reminder.status === "done" ? "Traité" : "Ignoré"}</span><button type="button" class="secondary-button" data-reminder-id="${escapeHtml(String(reminder.id))}" data-reminder-status="open">Rouvrir</button>`;
    return `<article class="dashboard-reminder">
        <div><strong>${escapeHtml(reminder.title)}</strong><small>${escapeHtml(reminder.details)}</small><small>${label} : ${escapeHtml(dateLabel(reminder.dueDate))}</small></div>
        <div class="dashboard-reminders-actions">${openPlanning && reminder.reminderType === "maintenance_due" ? `<button type="button" class="secondary-button" data-reminder-id="${escapeHtml(String(reminder.id))}" data-reminder-planning>Ouvrir le planning</button>` : ""}${canOpen ? `<button type="button" class="secondary-button" data-reminder-id="${escapeHtml(String(reminder.id))}" data-reminder-resource>Ouvrir la ressource</button>` : ""}${actions}</div>
    </article>`;
}

function validId(value) { return /^[1-9]\d*$/.test(String(value)); }
function validLeadDays(value) { return Number.isInteger(value) && value >= 0 && value <= 365; }
function dateLabel(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return "Date indisponible";
    const date = new Date(`${value}T12:00:00`);
    return Number.isNaN(date.getTime()) ? "Date indisponible" : new Intl.DateTimeFormat("fr-FR", { dateStyle: "short" }).format(date);
}
function dateTimeLabel(value) {
    const date = new Date(value || "");
    return Number.isNaN(date.getTime()) ? "date inconnue" : new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(date);
}
async function requestJson(url, options = {}) {
    const method = options.method || "GET";
    let response;
    try {
        response = await fetch(url, {
            method, credentials: "same-origin", cache: method === "GET" ? "no-store" : undefined,
            headers: options.body ? { "Content-Type": "application/json" } : undefined,
            body: options.body ? JSON.stringify(options.body) : undefined
        });
    } catch {
        throw new Error("Connexion impossible. Vérifiez le réseau puis actualisez.");
    }
    if (response.status === 204) return null;
    let payload;
    try { payload = await response.json(); } catch { throw new Error("Réponse du serveur illisible."); }
    if (!response.ok) throw new Error(payload?.message || `Opération impossible (${response.status}).`);
    return payload;
}
