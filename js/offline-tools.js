import { getOfflineQueueStatus, retryOfflineQueue } from "./offline-sync.js?v=4";
import { synchronizeClients } from "./client-sync.js?v=132";

function localDate(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function offlinePlanningRanges(date = new Date()) {
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
    const weekStart = new Date(day);
    weekStart.setDate(day.getDate() - ((day.getDay() + 6) % 7));
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    const monthStart = new Date(day.getFullYear(), day.getMonth(), 1, 12);
    monthStart.setDate(monthStart.getDate() - ((monthStart.getDay() + 6) % 7));
    const monthEnd = new Date(day.getFullYear(), day.getMonth() + 1, 0, 12);
    monthEnd.setDate(monthEnd.getDate() + 6 - ((monthEnd.getDay() + 6) % 7));
    return [
        { start: localDate(day), end: localDate(day) },
        { start: localDate(weekStart), end: localDate(weekEnd) },
        { start: localDate(monthStart), end: localDate(monthEnd) }
    ];
}

export async function prepareOfflineDay({
    now = new Date(),
    fetcher = globalThis.fetch,
    synchronize = synchronizeClients,
    queueStatus = getOfflineQueueStatus,
    onProgress = () => {}
} = {}) {
    if (globalThis.navigator?.onLine === false) throw new Error("Connectez cet appareil pour préparer la journée.");
    if ((await queueStatus()).pending) throw new Error("Synchronisez d’abord les envois terrain en attente.");

    onProgress("Synchronisation des dossiers clients…");
    const clients = await synchronize();
    if (!clients.ok) throw new Error(clients.message || "Les dossiers clients n’ont pas pu être synchronisés.");

    async function load(url, optional = false) {
        const response = await fetcher(url, { credentials: "same-origin", headers: { Accept: "application/json" } });
        if (response.headers.get("X-DepannHome-Offline") === "true") throw new Error("Le serveur n’a pas répondu : les données en cache ne peuvent pas confirmer une préparation à jour.");
        if (optional && response.status === 403) return null;
        if (!response.ok) throw new Error(`Préparation impossible (erreur ${response.status}).`);
        return response.json();
    }

    const ranges = offlinePlanningRanges(now);
    const loadedRanges = new Map();
    for (const range of ranges) {
        const url = `/api/calendar/events?start=${encodeURIComponent(range.start)}&end=${encodeURIComponent(range.end)}`;
        if (loadedRanges.has(url)) continue;
        onProgress("Préparation du planning…");
        const data = await load(url);
        if (!Array.isArray(data?.events)) throw new Error("La réponse du planning est incomplète.");
        loadedRanges.set(url, data.events);
    }
    const dayUrl = `/api/calendar/events?start=${ranges[0].start}&end=${ranges[0].end}`;
    const appointments = loadedRanges.get(dayUrl).filter(event => event.eventType === "appointment");

    onProgress("Préparation des rapports accessibles…");
    const directory = await load("/api/technical-reports", true);
    if (directory && !Array.isArray(directory.reports)) throw new Error("La liste des rapports est incomplète.");
    let reports = 0;
    if (directory) {
        for (const appointment of appointments) {
            if (!/^[1-9]\d*$/.test(String(appointment.id || ""))) throw new Error("Un identifiant d’intervention est invalide.");
            const link = await load(`/api/technical-reports/appointments/${encodeURIComponent(appointment.id)}`);
            if (!link?.appointment) throw new Error("Une intervention n’a pas pu être préparée pour les rapports.");
            if (link.report?.id) {
                const detail = await load(`/api/technical-reports/${encodeURIComponent(link.report.id)}`);
                if (!detail?.report) throw new Error("Un rapport n’a pas pu être préparé.");
                reports += 1;
            }
        }
    }
    if ((await queueStatus()).pending) throw new Error("De nouveaux envois sont apparus pendant la préparation. Synchronisez-les puis recommencez.");
    return { day: ranges[0].start, appointments: appointments.length, reports, reportsAvailable: Boolean(directory) };
}

export function initializeOfflineTools() {
    if (document.body.dataset.deviceType !== "mobile" || !["mobile_admin", "team_lead", "technician"].includes(document.body.dataset.role)) return;
    const breadcrumb = document.getElementById("breadcrumb");
    if (!breadcrumb || document.getElementById("offlineTools")) return;
    const panel = document.createElement("details");
    panel.id = "offlineTools";
    panel.className = "offline-tools";
    panel.innerHTML = `
        <summary>Mode terrain · <span data-offline-summary>Vérification…</span></summary>
        <div class="offline-tools-content">
            <p data-offline-status aria-live="polite"></p>
            <p data-offline-preparation aria-live="polite">Avant le départ, préparez la journée avec une connexion. Les données restent sur cet appareil.</p>
            <p class="offline-tools-hint">Le compteur concerne le planning, les rapports et les messages. Les dossiers clients utilisent une synchronisation distincte. Ne supprimez pas les données du navigateur avant l’envoi.</p>
            <div class="offline-tools-actions">
                <button type="button" class="secondary-button" data-offline-prepare>Préparer aujourd’hui</button>
                <button type="button" class="secondary-button" data-offline-retry>Synchroniser maintenant</button>
            </div>
        </div>`;
    breadcrumb.insertAdjacentElement("afterend", panel);
    const summary = panel.querySelector("[data-offline-summary]");
    const status = panel.querySelector("[data-offline-status]");
    const preparation = panel.querySelector("[data-offline-preparation]");
    const prepareButton = panel.querySelector("[data-offline-prepare]");
    const retryButton = panel.querySelector("[data-offline-retry]");

    async function refresh() {
        try {
            const queue = await getOfflineQueueStatus();
            if (queue.blocked) {
                summary.textContent = `${queue.pending} envoi(s) · action requise`;
                status.textContent = `Synchronisation bloquée : ${queue.blocked.message} Les données restent sur cet appareil. Réessayez ou contactez votre administrateur.`;
            } else if (queue.pending) {
                summary.textContent = `${queue.pending} envoi(s) en attente`;
                status.textContent = navigator.onLine ? "Les envois en attente seront synchronisés dans leur ordre d’enregistrement." : "Hors connexion : les envois restent sur cet appareil.";
            } else {
                summary.textContent = navigator.onLine ? "aucun envoi terrain en attente" : "hors connexion";
                status.textContent = navigator.onLine ? "Aucun envoi terrain en attente." : "Hors connexion : les données préparées restent consultables sur cet appareil.";
            }
        } catch (error) {
            console.error("[offline] Statut indisponible :", error.name || "ERROR");
            summary.textContent = "statut indisponible";
            status.textContent = "Impossible de lire la file hors ligne. Ne supprimez pas les données de cet appareil.";
        }
    }

    prepareButton.addEventListener("click", async () => {
        prepareButton.disabled = true;
        try {
            const result = await prepareOfflineDay({ onProgress: message => { preparation.textContent = message; } });
            preparation.textContent = `Journée du ${result.day} préparée : ${result.appointments} intervention(s), ${result.reports} rapport(s) existant(s).${result.reportsAvailable ? "" : " Les rapports ne sont pas accessibles avec ce compte."} Les autres dates et fonctions non préparées peuvent nécessiter une connexion.`;
        } catch (error) {
            preparation.textContent = error.message || "Préparation impossible. Vérifiez la connexion et réessayez.";
        } finally {
            prepareButton.disabled = false;
            await refresh();
        }
    });
    retryButton.addEventListener("click", async () => {
        retryButton.disabled = true;
        try {
            const result = await retryOfflineQueue();
            if (result.offline) preparation.textContent = "Connectez cet appareil pour synchroniser les envois.";
            else if (!result.ok) preparation.textContent = result.message || "Certains envois restent en attente. Consultez le statut ci-dessus.";
            else {
                const clients = await synchronizeClients();
                preparation.textContent = clients.ok ? "Synchronisation demandée pour les envois terrain et les dossiers clients." : clients.message || "Les dossiers clients restent à synchroniser.";
            }
        } catch (error) {
            console.error("[offline] Synchronisation manuelle impossible :", error.name || "ERROR");
            preparation.textContent = "Synchronisation impossible. Les données restent sur cet appareil.";
        } finally {
            retryButton.disabled = false;
            await refresh();
        }
    });
    window.addEventListener("online", refresh);
    window.addEventListener("offline", refresh);
    window.addEventListener("depannhome:offline-queue-state", event => {
        if (event.detail.state === "error" && event.detail.message) preparation.textContent = event.detail.message;
        refresh();
    });
    window.addEventListener("depannhome:offline-session-ready", refresh);
    window.addEventListener("depannhome:offline-cache-error", event => { preparation.textContent = event.detail.message; });
    refresh();
}
