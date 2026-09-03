import { getSettings } from "./storage.js?v=45";

const ENGLISH = new Map(Object.entries({
    "Connexion professionnelle": "Professional sign-in",
    "Nom d’utilisateur": "Username",
    "Mot de passe": "Password",
    "Afficher": "Show",
    "Se connecter": "Sign in",
    "Partenariats": "Partnerships",
    "Vous représentez une organisation ?": "Do you represent an organization?",
    "Devenir partenaire": "Become a partner",
    "Déjà partenaire ?": "Already a partner?",
    "Assistant de dépannage professionnel": "Professional troubleshooting assistant",
    "Rechercher un module, un client ou une intervention...": "Search for a module, client or appointment...",
    "Rechercher une marque, une gamme ou un produit...": "Search for a brand, range or product...",
    "Accueil": "Home",
    "Recherche": "Search",
    "Magasin": "Store",
    "Clients": "Clients",
    "Messages": "Messages",
    "Devis & rapports": "Quotes & reports",
    "Devis, factures & rapports de fuite": "Quotes, invoices & leak reports",
    "Comptabilité": "Accounting",
    "Achats": "Purchases",
    "Missions": "Missions",
    "Missions partenaires": "Partner missions",
    "E-mail": "Email",
    "Espace e-mail": "Email workspace",
    "Planning": "Schedule",
    "Bibliothèque": "Library",
    "Paramètres": "Settings",
    "Actualiser": "Refresh",
    "Actualisation…": "Refreshing…",
    "Actualisé ✓": "Refreshed ✓",
    "Déconnexion": "Sign out",
    "Notifications": "Notifications",
    "Fermer": "Close",
    "Ouvrir": "Open",
    "Enregistrer": "Save",
    "Réinitialiser": "Reset",
    "Supprimer": "Delete",
    "Modifier": "Edit",
    "Annuler": "Cancel",
    "Confirmer": "Confirm",
    "Continuer": "Continue",
    "Retour": "Back",
    "Précédente": "Previous",
    "Suivante": "Next",
    "Aujourd’hui": "Today",
    "Mois": "Month",
    "Semaine": "Week",
    "Jour": "Day",
    "Heure": "Time",
    "Toute la journée": "All day",
    "Aucune notification selon les choix de ce poste.": "No notifications match this workstation's preferences.",
    "Tout marquer comme lu": "Mark all as read",
    "Supprimer les notifications lues": "Delete read notifications",
    "Collaboration": "Collaboration",
    "Application administrative": "Administrative application",
    "Personnalisez l’affichage et le fonctionnement de votre espace de travail.": "Customize the appearance and behavior of your workspace.",
    "Taille de l'historique (max)": "History size (max)",
    "Thème": "Theme",
    "Standard (clair)": "Standard (light)",
    "Sombre": "Dark",
    "Densité de l’interface": "Interface density",
    "Confortable": "Comfortable",
    "Compacte": "Compact",
    "Police": "Font",
    "Langue": "Language",
    "Montrer l'état hors-ligne": "Show offline status",
    "Réduire les animations": "Reduce animations",
    "Notifications sur ce poste": "Notifications on this workstation",
    "Choisissez uniquement les alertes utiles à ce poste administratif. Les éléments désactivés restent conservés et peuvent être réaffichés plus tard.": "Choose only the alerts useful on this administrative workstation. Disabled items remain stored and can be displayed again later.",
    "Nouvelle mission partenaire": "New partner mission",
    "Échanges et mises à jour des missions": "Mission conversations and updates",
    "Création et mise à jour des rendez-vous": "Appointment creation and updates",
    "Rapports techniques": "Technical reports",
    "Devis, factures et règlements": "Quotes, invoices and payments",
    "Notes et messages des dossiers clients": "Client file notes and messages",
    "Connexions et demandes partenaires": "Partner connections and requests",
    "Sécurité, support et informations système": "Security, support and system information",
    "Suivi opérationnel": "Operational monitoring",
    "Réseau Depann’Home Pro": "Depann’Home Pro Network",
    "Connecteurs externes": "External connectors",
    "Missions reçues": "Received missions",
    "Missions envoyées": "Sent missions",
    "Nouvelle mission": "New mission",
    "Messagerie": "Messaging",
    "Notifications partenaires": "Partner notifications",
    "À valider": "To review",
    "Envoyées": "Sent",
    "Connexions API": "API connections",
    "Toutes les missions": "All missions",
    "Tous les statuts": "All statuses",
    "Statut": "Status",
    "Client, référence, adresse": "Client, reference, address",
    "Sélectionner": "Select",
    "Tout sélectionner": "Select all",
    "Supprimer la sélection": "Delete selection",
    "Détail": "Details",
    "Ouvrir la conversation": "Open conversation",
    "Accepter": "Accept",
    "Refuser": "Reject",
    "À planifier": "To schedule",
    "Aucun descriptif transmis.": "No description provided.",
    "Client non renseigné": "Client not provided",
    "Adresse non renseignée": "Address not provided",
    "Partenaire": "Partner",
    "Intervention": "Job",
    "Missions partenaires par e-mail": "Partner missions by email",
    "Boîte mail professionnelle": "Professional mailbox",
    "Rechercher les e-mails": "Search emails",
    "Canaux e-mail": "Email channels",
    "Réception par e-mail inactive": "Email reception inactive",
    "Aucun canal e-mail n’est configuré": "No email channel is configured",
    "Configurer la réception e-mail": "Configure email reception",
    "Répondre à l’e-mail": "Reply by email",
    "Répondre dans le fil d’origine": "Reply in the original thread",
    "Message": "Message",
    "Envoyer par e-mail": "Send by email",
    "Aucun document sélectionné.": "No document selected.",
    "Mon planning": "My schedule",
    "Planning professionnel": "Professional schedule",
    "Interventions terrain": "Field jobs",
    "+ Nouveau rendez-vous": "+ New appointment",
    "+ Planifier une intervention": "+ Schedule a job",
    "+ Nouvelle tâche": "+ New task",
    "Équipe affichée": "Displayed team",
    "Filtrer les utilisateurs": "Filter users",
    "Toute l’équipe": "Entire team",
    "Mise à jour du planning…": "Updating schedule…",
    "Chargement du planning…": "Loading schedule…",
    "Rendez-vous": "Appointment",
    "Tâche": "Task",
    "Planifiée": "Planned",
    "Confirmée": "Confirmed",
    "En cours": "In progress",
    "Terminée": "Completed",
    "Annulée": "Cancelled",
    "Clients & interventions": "Clients & jobs",
    "Nouveau client": "New client",
    "Rechercher un client": "Search clients",
    "Coordonnées": "Contact details",
    "Historique": "History",
    "Documents": "Documents",
    "Devis": "Quotes",
    "Factures": "Invoices",
    "Facture": "Invoice",
    "Avoir": "Credit note",
    "Brouillon": "Draft",
    "Validé": "Validated",
    "Payée": "Paid",
    "Impayée": "Unpaid",
    "Créer": "Create",
    "Télécharger": "Download",
    "Aperçu": "Preview",
    "Imprimer": "Print",
    "Envoyer": "Send",
    "Entreprise": "Company",
    "Équipe": "Team",
    "Interface & notifications": "Interface & notifications",
    "Personnalisation": "Customization",
    "Support": "Support",
    "Recherche globale": "Global search",
    "Aucun résultat": "No results",
    "Chargement…": "Loading…",
    "Erreur": "Error",
    "Oui": "Yes",
    "Non": "No"
}));

const originalText = new WeakMap();
const originalAttributes = new WeakMap();
const ATTRIBUTES = ["placeholder", "title", "aria-label"];
const SKIPPED_TAGS = new Set(["SCRIPT", "STYLE", "CODE", "PRE", "TEXTAREA"]);
let language = "fr";
let observer = null;
let translating = false;

export function translateInterfaceText(value) {
    const text = String(value || "");
    const trimmed = text.trim();
    const exact = ENGLISH.get(trimmed);
    if (exact) return text.replace(trimmed, exact);
    const patterns = [
        [/^Chargement des (.+)…$/, "Loading $1…"],
        [/^Impossible de charger (.+)\.$/, "Unable to load $1."],
        [/^Aucun(?:e)? (.+)\.$/, "No $1."],
        [/^(\d+) notification(s?) non lue(s?)$/, "$1 unread notification$2"],
        [/^(\d+) mission(s?)$/, "$1 mission$2"],
        [/^Étape (\d+) sur (\d+)$/, "Step $1 of $2"]
    ];
    for (const [pattern, replacement] of patterns) if (pattern.test(trimmed)) return text.replace(trimmed, trimmed.replace(pattern, replacement));
    return text;
}

function translateTextNode(node) {
    if (!originalText.has(node)) originalText.set(node, node.nodeValue);
    const source = originalText.get(node);
    const next = language === "en" ? translateInterfaceText(source) : source;
    if (node.nodeValue !== next) node.nodeValue = next;
}

function translateElement(element) {
    if (SKIPPED_TAGS.has(element.tagName) || element.closest("[data-no-translate]")) return;
    if (!originalAttributes.has(element)) originalAttributes.set(element, Object.fromEntries(ATTRIBUTES.filter(name => element.hasAttribute(name)).map(name => [name, element.getAttribute(name)])));
    const attributes = originalAttributes.get(element);
    Object.entries(attributes).forEach(([name, source]) => element.setAttribute(name, language === "en" ? translateInterfaceText(source) : source));
    element.childNodes.forEach(child => {
        if (child.nodeType === Node.TEXT_NODE) translateTextNode(child);
        else if (child.nodeType === Node.ELEMENT_NODE) translateElement(child);
    });
}

export function applyInterfaceLanguage(nextLanguage = getSettings().lang || "fr") {
    language = nextLanguage === "en" ? "en" : "fr";
    document.documentElement.lang = language;
    translating = true;
    translateElement(document.body);
    translating = false;
}

export function initializeInterfaceLanguage() {
    applyInterfaceLanguage();
    if (!observer) {
        observer = new MutationObserver(records => {
            if (translating) return;
            translating = true;
            records.forEach(record => record.addedNodes.forEach(node => {
                if (node.nodeType === Node.TEXT_NODE) translateTextNode(node);
                else if (node.nodeType === Node.ELEMENT_NODE) translateElement(node);
            }));
            translating = false;
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }
    window.addEventListener("depannhome:settings-changed", event => applyInterfaceLanguage(event.detail?.lang));
}
