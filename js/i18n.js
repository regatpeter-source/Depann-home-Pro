import { getSettings } from "./storage.js?v=45";

const ENGLISH = new Map(Object.entries({
    "Connexion professionnelle": "Professional sign-in",
    "Nom d’utilisateur": "Username",
    "Mot de passe": "Password",
    "Afficher": "Show",
    "Afficher le mot de passe": "Show password",
    "Masquer le mot de passe": "Hide password",
    "Se connecter": "Sign in",
    "Partenariats": "Partnerships",
    "Vous représentez une organisation ?": "Do you represent an organization?",
    "Vous êtes une assurance, un assisteur, un expert, une collectivité, un bailleur ou un donneur d’ordres ?": "Are you an insurer, assistance provider, expert, local authority, landlord, or principal?",
    "Rejoignez le réseau Depann’Home Pro afin d’échanger automatiquement vos interventions avec les entreprises utilisant notre logiciel.": "Join the Depann’Home Pro network to exchange jobs automatically with companies using our software.",
    "Connectez-vous avec vos identifiants professionnels.": "Sign in with your professional credentials.",
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
    "Non": "No",
    "Poste": "Workstation",
    "Entreprise active": "Active company",
    "Connexion en temps réel": "Real-time connection",
    "Actualiser les données partagées": "Refresh shared data",
    "Nouvelles notes client": "New client notes",
    "Nouvelles notifications partenaires": "New partner notifications",
    "Nouveaux rendez-vous aujourd'hui": "New appointments today",
    "Tous": "All",
    "Tous les documents": "All documents",
    "Clients actifs": "Active clients",
    "Clients archivés": "Archived clients",
    "Saisir votre recherche": "Enter your search",
    "Nom du client": "Client name",
    "Adresse complète": "Full address",
    "Adresse d'intervention ou atelier": "Job site or workshop address",
    "Ville": "City",
    "Téléphone": "Phone",
    "Adresse e-mail": "Email address",
    "Type de client": "Client type",
    "Particulier": "Individual",
    "Professionnel": "Business",
    "Autre": "Other",
    "Dossiers créés": "Files created",
    "Prendre un client d'une autre entreprise": "Take over a client from another company",
    "Sélectionner une entreprise": "Select a company",
    "Sélectionner un client": "Select a client",
    "Sélectionnez d'abord une entreprise": "Select a company first",
    "Chargement impossible": "Unable to load",
    "Actualisation en cours…": "Refreshing…",
    "Synchronisation en cours…": "Synchronizing…",
    "Hors ligne : les dossiers déjà consultés restent disponibles.": "Offline: previously viewed files remain available.",
    "Dossiers d'intervention actualisés.": "Job files refreshed.",
    "Dossiers clients synchronisés.": "Client files synchronized.",
    "Synchronisation impossible pour le moment.": "Unable to synchronize right now.",
    "Comptabilisation impossible.": "Unable to post this document.",
    "Enregistrement impossible.": "Unable to save.",
    "Règlement impossible.": "Unable to record the payment.",
    "Création de l’avoir impossible.": "Unable to create the credit note.",
    "Création de l'avoir impossible.": "Unable to create the credit note.",
    "Suppression impossible.": "Unable to delete.",
    "Mise à jour impossible.": "Unable to update.",
    "Ajout impossible.": "Unable to add.",
    "Modification impossible.": "Unable to edit.",
    "Transmission impossible.": "Unable to transmit.",
    "Autorisation impossible.": "Unable to authorize.",
    "Vérification impossible.": "Unable to verify.",
    "Rapprochement impossible.": "Unable to reconcile.",
    "Diagnostic impossible.": "Unable to run diagnostics.",
    "Envoi impossible.": "Unable to send.",
    "Validation impossible.": "Unable to validate.",
    "Réorganisation impossible.": "Unable to reorder.",
    "Remplacement impossible.": "Unable to replace.",
    "Action impossible.": "Unable to complete this action.",
    "Cette entreprise ne possède aucun client actif à reprendre.": "This company has no active client to take over.",
    "Ajoutez au moins une autre entreprise active au groupe pour reprendre un client.": "Add at least one other active company to the group to take over a client.",
    "Montant de franchise prévu (€)": "Expected deductible amount (€)",
    "À renseigner uniquement si différent de l'adresse de facturation": "Complete only if different from the billing address",
    "Accès, panne récurrente, historique, consignes client...": "Access, recurring issue, history, client instructions...",
    "Confirmé": "Confirmed",
    "À préparer": "To prepare",
    "Urgent": "Urgent",
    "Personnel": "Personal",
    "Indisponible": "Unavailable",
    "Tâche interne": "Internal task",
    "Vacances": "Vacation",
    "Arrêt": "Leave",
    "Indisponibilité": "Unavailability",
    "Jour précédent": "Previous day",
    "Jour suivant": "Next day",
    "Vue du planning": "Schedule view",
    "Statuts des interventions": "Job statuses",
    "Période invalide": "Invalid period",
    "Aucun autre rendez-vous ce jour.": "No other appointments today.",
    "Choisissez une date pour visualiser les créneaux du planning.": "Choose a date to view available schedule slots.",
    "Corrigez les conflits de la période avant de l'ajouter au planning.": "Resolve period conflicts before adding it to the schedule.",
    "Sélectionnez au moins une photo de l'intervention.": "Select at least one job photo.",
    "Travaux prévus, matériel à prévoir, consignes d'accès…": "Planned work, required equipment, access instructions…",
    "Mise en pause…": "Pausing…",
    "Enregistrement…": "Saving…",
    "Ajout des photos…": "Adding photos…",
    "Tableau de bord": "Dashboard",
    "Journal des ventes": "Sales journal",
    "Règlements": "Payments",
    "Avoirs": "Credit notes",
    "TVA": "VAT",
    "Export comptable": "Accounting export",
    "Export FEC": "FEC export",
    "Contrôle comptable": "Accounting review",
    "Facturation électronique & PDP": "E-invoicing & PDP",
    "Chiffre d'affaires": "Revenue",
    "Encaissements": "Payments received",
    "À encaisser": "Outstanding",
    "Impayés": "Overdue",
    "Achats HT": "Purchases excl. tax",
    "Nom de la structure": "Business name",
    "Forme juridique / activité": "Legal form / activity",
    "Montant fixe (€ HT)": "Fixed amount (€ excl. tax)",
    "Pourcentage (%)": "Percentage (%)",
    "Acompte attendu": "Expected deposit",
    "Conditions particulières": "Special terms",
    "Commentaires": "Comments",
    "Aides financières": "Financial aid",
    "Aides": "Aid",
    "Remises": "Discounts",
    "Montant de la remise": "Discount amount",
    "Montant de la remise attendu": "Expected discount amount",
    "Comptabilisée": "Posted",
    "Écriture validée": "Entry validated",
    "Solde restant :": "Remaining balance:",
    "Factures à comptabiliser": "Invoices to post",
    "Virement": "Bank transfer",
    "Carte bancaire": "Card",
    "Chèque": "Cheque",
    "Espèces": "Cash",
    "Import à confirmer": "Import to confirm",
    "Planification en pause": "Scheduling paused",
    "Confirmer la sélection": "Confirm selection",
    "Rédigez votre réponse au partenaire…": "Write your reply to the partner…",
    "Aucun partenaire connecté n'est autorisé à recevoir des missions.": "No connected partner is authorized to receive missions.",
    "Chargement de la configuration de la boîte professionnelle…": "Loading professional mailbox configuration…",
    "Chargement de l'espace e-mail de l'entreprise…": "Loading company email workspace…",
    "Active": "Active",
    "Suspendue": "Suspended",
    "Prête à être créée": "Ready to be created",
    "Configuration plateforme en attente": "Platform configuration pending",
    "Connecter Microsoft (Outlook, Hotmail, Microsoft 365)": "Connect Microsoft (Outlook, Hotmail, Microsoft 365)",
    "Google Workspace · bientôt disponible": "Google Workspace · coming soon",
    "Connexion OAuth": "OAuth connection",
    "Bientôt disponible": "Coming soon",
    "Afficher le mot de passe d'application": "Show app password",
    "Masquer le mot de passe d'application": "Hide app password",
    "Masquer": "Hide",
    "Adresse copiée": "Address copied",
    "Notes d'intervention": "Job notes",
    "Les notes d'intervention sont disponibles dans la fiche de chaque client.": "Job notes are available in each client file.",
    "Aucune note d'intervention pour ce client.": "No job notes for this client.",
    "Ajouter la note": "Add note",
    "Services": "Services",
    "Incidents": "Incidents",
    "Performance": "Performance",
    "Tâches": "Tasks",
    "Tests & déploiements": "Tests & deployments",
    "Diagnostic": "Diagnostics",
    "Incidents critiques": "Critical incidents",
    "Alertes à examiner": "Alerts to review",
    "Contrôles actifs": "Active checks",
    "Modules mesurés sur 24 h": "Modules measured over 24 hours",
    "Centre de contrôle Créateur": "Creator control center",
    "Santé du système": "System health",
    "Services et modules existants": "Existing services and modules",
    "Contrôles automatiques": "Automated checks",
    "Détection dédupliquée": "Deduplicated detection",
    "Agrégation anonyme sur 24 heures": "Anonymous aggregation over 24 hours",
    "Exécutions observées": "Observed runs",
    "Corrélation version / incidents": "Version / incident correlation",
    "Diagnostic manuel sécurisé": "Secure manual diagnostics",
    "Aucune donnée métier n'est créée, modifiée ou supprimée.": "No business data is created, changed, or deleted.",
    "Contrôles en lecture seule en cours…": "Read-only checks in progress…",
    "Serveur / API": "Server / API",
    "Base de données": "Database",
    "Authentification": "Authentication",
    "Facturation": "Billing",
    "Facturation électronique": "E-invoicing",
    "Services externes": "External services",
    "Facturation abonnements": "Subscription billing",
    "Synchronisation e-mail": "Email synchronization",
    "Connexions": "Connections",
    "Disponibles": "Available",
    "En attente": "Pending",
    "Configuré": "Configured",
    "Échecs": "Failures",
    "Taux d'erreur": "Error rate",
    "Latence maximale": "Maximum latency",
    "Dernier état": "Latest status",
    "Ancienneté (min)": "Age (min)",
    "OPÉRATIONNEL": "OPERATIONAL",
    "AVERTISSEMENT": "WARNING",
    "SERVICE INDISPONIBLE": "SERVICE UNAVAILABLE",
    "EN COURS": "ONGOING",
    "SOUS SURVEILLANCE": "MONITORING",
    "RÉSOLU": "RESOLVED",
    "Informations générales": "General information",
    "Données récupérées automatiquement": "Automatically retrieved data",
    "Rapport de recherche de fuite": "Leak detection report",
    "Photo de présentation du logement": "Property overview photo",
    "État des lieux": "Initial inspection",
    "Constats à l'arrivée": "Findings on arrival",
    "Observations visuelles": "Visual observations",
    "Désordres et anomalies visibles": "Visible damage and anomalies",
    "Contrôle d'humidité": "Moisture inspection",
    "Mesures et zones contrôlées": "Measurements and inspected areas",
    "Manomètre de pression": "Pressure gauge",
    "Contrôles de pression": "Pressure checks",
    "Matériels techniques utilisés": "Technical equipment used",
    "Sélectionnez les équipements employés": "Select the equipment used",
    "Test d'étanchéité à l'eau claire / colorant": "Clear water / dye leak test",
    "Essais réalisés": "Tests performed",
    "Mise en charge": "Pressure testing",
    "Mise sous pression ou en charge": "Pressurization or load testing",
    "Mise en sécurité": "Safety measures",
    "Mesures de prévention": "Preventive measures",
    "Contrôle ventilation": "Ventilation check",
    "Vérifications de ventilation": "Ventilation checks",
    "Conclusion": "Conclusion",
    "Diagnostic et synthèse": "Diagnosis and summary",
    "Préconisations": "Recommendations",
    "Travaux et conseils": "Work and advice",
    "À rédiger": "To write",
    "Terminés à corriger": "Completed — needs review",
    "À envoyer": "To send",
    "Envoyés": "Sent",
    "Terminer": "Complete",
    "Corriger": "Review",
    "Valider définitivement et envoyer": "Finalize and send",
    "Demander une correction": "Request changes",
    "Remettre en brouillon": "Return to draft",
    "Annuler la création du rapport": "Cancel report creation",
    "Enregistré automatiquement": "Saved automatically",
    "Ouverture de l'éditeur de rapport…": "Opening report editor…",
    "Technicien": "Technician",
    "Dossier": "File",
    "Ajouter la photo extérieure du logement": "Add an exterior property photo",
    "Prendre une photo": "Take a photo",
    "Module ignoré": "Module skipped",
    "Il ne figurera pas dans le PDF final tant qu'il n'est pas réactivé.": "It will not appear in the final PDF until re-enabled.",
    "Aucune observation": "No observations",
    "Ajoutez uniquement les constats utiles à cette intervention.": "Add only findings relevant to this job.",
    "+ Ajouter une observation": "+ Add an observation",
    "Copies originales conservées": "Original copies retained",
    "Commentaires de l'administration": "Administration comments",
    "Client absent": "Client absent",
    "Accès impossible": "Access unavailable",
    "Informations manquantes": "Missing information",
    "Matériel indisponible": "Equipment unavailable",
    "En attente d'autorisation": "Awaiting authorization",
    "Intervention reportée": "Job postponed",
    "Informations complémentaires demandées": "Additional information requested",
    "Autre difficulté": "Other issue",
    "Quitus": "Completion certificate",
    "Franchise": "Deductible",
    "Photo d'intervention": "Job photo",
    "Reçue": "Received",
    "Acceptée": "Accepted",
    "Refusée": "Rejected",
    "Affectée": "Assigned",
    "En route": "On the way",
    "Sur site": "On site",
    "Rapport en cours": "Report in progress",
    "Rapport terminé": "Report completed",
    "Rapport validé": "Report approved",
    "Devis envoyé": "Quote sent",
    "Devis accepté": "Quote accepted",
    "Travaux terminés": "Work completed",
    "Facture envoyée": "Invoice sent",
    "Clôturée": "Closed",
    "Statut non renseigné": "Status not provided",
    "Chargement de la conversation…": "Loading conversation…",
    "Conversation indisponible.": "Conversation unavailable.",
    "Aucun document lié à cette mission pour le moment.": "No documents linked to this mission yet.",
    "Ajouter des photos": "Add photos",
    "Sélectionnez au moins une photo d'intervention.": "Select at least one job photo.",
    "Aucun fichier sélectionné.": "No file selected.",
    "Visible au partenaire": "Visible to partner",
    "Interne uniquement": "Internal only",
    "Reçu de l'entreprise partenaire": "Received from partner company",
    "Visible par l'entreprise destinataire": "Visible to recipient company",
    "Interne à votre entreprise": "Internal to your company",
    "Envoyer aussi par e-mail au partenaire": "Also email the partner",
    "Partager avec le partenaire": "Share with partner",
    "Console Créateur": "Creator console",
    "Administration plateforme": "Platform administration",
    "Sélectionnez une organisation ou créez-en une.": "Select an organization or create one."
    ,"Aucun canal e-mail n’est configuré": "No email channel is configured"
    ,"Aucune boîte n'est encore connectée. Un Poste Admin peut la configurer dans Paramètres > Entreprise · Boîte mail.": "No mailbox is connected yet. An Admin Workstation can configure it under Settings > Company · Mailbox."
    ,"Connexion Gmail professionnelle temporairement indisponible.": "Professional Gmail connection is temporarily unavailable."
    ,"Hébergeur IMAP/SMTP (OVH, Zimbra, Namecheap…)": "IMAP/SMTP provider (OVH, Zimbra, Namecheap…)"
    ,"Copie impossible. Sélectionnez l'adresse manuellement.": "Copy failed. Select the address manually."
    ,"Ex. Intervention volet roulant": "Example: roller shutter repair"
    ,"Ex : Mme Martin, Résidence Les Pins": "Example: Ms Martin, Les Pins Residence"
    ,"Ex. Dépann'Home Services": "Example: Depann'Home Services"
    ,"Ex. SASU – dépannage à domicile": "Example: SASU – home repair service"
    ,"Ex. Moteur à contrôler, accès par le portail arrière…": "Example: motor to inspect, access through the rear gate…"
    ,"Ex. 4 volets Somfy RTS, portail FAAC 740...": "Example: 4 Somfy RTS shutters, FAAC 740 gate..."
    ,"Ex. admin, dépannage, Léa…": "Example: admin, repair, Lea…"
    ,"Rechercher un numéro ou un client": "Search by number or client"
    ,"Supprimer retire uniquement la proposition : l'e-mail reste dans la boîte connectée.": "Delete removes only the suggestion; the email remains in the connected mailbox."
    ,"Bonjour,\n\nRédigez votre réponse au partenaire…": "Hello,\n\nWrite your reply to the partner…"
    ,"Sélectionnez au moins un membre pour vérifier les conflits de la période.": "Select at least one team member to check period conflicts."
    ,"Surveillance en lecture seule": "Read-only monitoring"
    ,"Exécute uniquement des lectures légères : base, files d'échec, configuration et métriques.": "Runs lightweight read-only checks only: database, failure queues, configuration, and metrics."
    ,"Informations complémentaires": "Additional information"
    ,"Aucune information complémentaire.": "No additional information."
    ,"Sélectionnez les photos du technicien à envoyer au partenaire.": "Select the technician's photos to send to the partner."
    ,"Les photos ajoutées depuis la fiche d'intervention du technicien apparaîtront ici.": "Photos added from the technician's job sheet will appear here."
    ,"Sélectionnez des fichiers PDF, JPEG, PNG ou WebP. Les dossiers complets ne sont pas importés.": "Select PDF, JPEG, PNG, or WebP files. Entire folders are not imported."
    ,"Chaque fichier doit être inférieur ou égal à 5 Mo.": "Each file must be 5 MB or smaller."
    ,"Aucun fichier exploitable n'a été déposé. Ouvrez le dossier puis sélectionnez les fichiers utiles.": "No usable file was dropped. Open the folder, then select the relevant files."
    ,"Envoi des photos impossible.": "Unable to send photos."
    ,"Message impossible à envoyer.": "Unable to send the message."
    ,"Visibilité impossible à modifier.": "Unable to change visibility."
    ,"Chaque PDF ci-dessous correspond à une version validée et reste conservé sans modification.": "Each PDF below is a validated version and remains unchanged."
    ,"Réf. dossier assureur non renseignée": "Insurer file reference not provided"
    ,"Sinistre non renseigné": "Claim not provided"
    ,"Client non renseigné": "Client not provided"
    ,"Adresse non renseignée": "Address not provided"
    ,"Téléphone non renseigné": "Phone number not provided"
    ,"E-mail non renseigné": "Email not provided"
    ,"Date non renseignée": "Date not provided"
    ,"Aucune donnée": "No data"
    ,"Aucun document trouvé.": "No documents found."
    ,"Aucun fichier": "No files"
    ,"Aucune mission": "No missions"
    ,"Aucun client": "No clients"
    ,"Aucune intervention": "No jobs"
    ,"Aucune facture": "No invoices"
    ,"Aucun devis": "No quotes"
    ,"Sélectionnez": "Select"
    ,"Valider": "Validate"
    ,"Ajouter": "Add"
    ,"Archiver": "Archive"
    ,"Réactiver": "Reactivate"
    ,"Dupliquer": "Duplicate"
    ,"Consulter": "View"
    ,"Détails": "Details"
    ,"Nom": "Name"
    ,"Prénom": "First name"
    ,"Adresse": "Address"
    ,"Date": "Date"
    ,"Montant": "Amount"
    ,"Description": "Description"
    ,"Référence": "Reference"
    ,"Type": "Type"
    ,"Actions": "Actions"
    ,"Créé le": "Created on"
    ,"Dernière mise à jour": "Last updated"
    ,"Lecture seule": "Read-only"
    ,"Obligatoire": "Required"
    ,"Facultatif": "Optional"
    ,"Sélection en cours…": "Selecting…"
    ,"Préparation…": "Preparing…"
    ,"Envoi…": "Sending…"
    ,"Suppression…": "Deleting…"
    ,"Connexion…": "Connecting…"
    ,"Aucune donnée métier n'est créée, modifiée ou supprimée.": "No business data is created, changed, or deleted."
    ,"Nouvelle mission reçue": "New mission received"
    ,"Nouvelle mission partenaire": "New partner mission"
    ,"Nouvelle intervention partenaire": "New partner job"
    ,"Mission partenaire mise à jour": "Partner mission updated"
    ,"Mission acceptée": "Mission accepted"
    ,"Mission réactivée pour correction": "Mission reopened for correction"
    ,"Le client a été créé automatiquement dans votre base de données. Vous pouvez commencer l’intervention immédiatement.": "The client was created automatically in your database. You can start the job immediately."
    ,"Client existant détecté. La mission a été rattachée automatiquement à sa fiche.": "Existing client detected. The mission was linked to their file automatically."
    ,"Mise à jour du dossier": "File updated"
    ,"Document ajouté au dossier": "Document added to file"
    ,"Problème signalé sur un dossier": "Issue reported on a file"
    ,"Nouveau message de dossier": "New file message"
    ,"Une pièce jointe a été ajoutée.": "An attachment was added."
    ,"Problème signalé par le partenaire": "Issue reported by the partner"
    ,"Nouveau message partenaire": "New partner message"
    ,"Problème signalé par l’entreprise exécutante": "Issue reported by the service company"
    ,"Nouveau message de l’entreprise exécutante": "New message from the service company"
    ,"Nouvel échange partagé par le partenaire": "New conversation shared by the partner"
    ,"Un échange précédemment interne vient d’être partagé.": "A previously internal conversation has just been shared."
    ,"Nouvelle note": "New note"
    ,"Dossier client": "Client file"
    ,"Verrouillage repris par l’administration": "Lock taken over by administration"
    ,"Demande de connexion partenaire": "Partner connection request"
    ,"Connexion partenaire acceptée": "Partner connection accepted"
    ,"Connexion partenaire refusée": "Partner connection rejected"
    ,"Connexion partenaire interrompue": "Partner connection disconnected"
    ,"Nouvelle demande de partenariat": "New partnership request"
    ,"Nouvelle demande Support": "New Support request"
    ,"Nouvelle demande d’offre ou de postes": "New plan or workstation request"
    ,"Fiche client créée automatiquement.": "Client file created automatically."
    ,"Mission rattachée à une fiche client existante.": "Mission linked to an existing client file."
    ,"Rendez-vous planifié.": "Appointment scheduled."
    ,"Technicien affecté.": "Technician assigned."
    ,"Rapport créé.": "Report created."
    ,"Réponse envoyée dans le fil e-mail d’origine.": "Reply sent in the original email thread."
    ,"Mission reçue.": "Mission received."
    ,"Mission en attente de validation.": "Mission awaiting review."
    ,"Mission acceptée.": "Mission accepted."
    ,"Technicien en route.": "Technician on the way."
    ,"Technicien arrivé sur site.": "Technician arrived on site."
    ,"Rapport en cours.": "Report in progress."
    ,"Rapport terminé.": "Report completed."
    ,"Rapport validé.": "Report approved."
    ,"Devis créé.": "Quote created."
    ,"Devis envoyé.": "Quote sent."
    ,"Devis accepté.": "Quote accepted."
    ,"Travaux terminés.": "Work completed."
    ,"Facture créée.": "Invoice created."
    ,"Facture envoyée.": "Invoice sent."
    ,"Mission refusée.": "Mission rejected."
    ,"Mission annulée.": "Mission cancelled."
    ,"Mission clôturée : le fil est désormais en lecture seule.": "Mission closed: the conversation is now read-only."
    ,"Informations du dossier mises à jour.": "File information updated."
    ,"Dossier mis à jour.": "File updated."
    ,"À confirmer": "To confirm"
    ,"Faible": "Low"
    ,"Normale": "Normal"
    ,"Haute": "High"
    ,"Urgente": "Urgent"
    ,"Non affecté": "Unassigned"
    ,"Même suivi, mêmes cartes et même Centre de mission pour les demandes reçues par votre boîte professionnelle.": "The same tracking, cards, and Mission Center for requests received through your professional mailbox."
    ,"Reprendre les informations enregistrées après l'appel du client": "Resume the information saved after calling the client"
    ,"Planification en pause": "Scheduling paused"
    ,"Envoi en cours…": "Sending…"
    ,"Activation…": "Activating…"
    ,"Mise à jour…": "Updating…"
    ,"Aperçu PDF chargé.": "PDF preview loaded."
    ,"Enregistrement de la correction…": "Saving corrections…"
    ,"Les devis et factures sont accessibles depuis le rendez-vous ou la fiche du client concerné.": "Quotes and invoices are available from the relevant appointment or client file."
    ,"Aucune ligne préenregistrée pour le moment.": "No saved line items yet."
    ,"Le client doit cocher « Lu et approuvé » avant de signer.": "The client must check “Read and approved” before signing."
    ,"Le client doit signer le quitus.": "The client must sign the completion certificate."
    ,"La création de devis et factures est désactivée par l’administrateur.": "Quote and invoice creation has been disabled by the administrator."
    ,"Un technicien peut créer un devis ou une facture uniquement depuis l’intervention qui lui est attribuée.": "A technician can create a quote or invoice only from their assigned job."
    ,"Renseignez la description de la ligne avant de la préenregistrer.": "Enter the line description before saving it."
    ,"Impossible d’enregistrer cette ligne sur ce poste.": "Unable to save this line item on this workstation."
    ,"Autorisez l’ouverture de la fenêtre SUPER PDP dans votre navigateur.": "Allow the SUPER PDP window to open in your browser."
    ,"Ce rapport doit d’abord être corrigé sur un poste administratif.": "This report must first be reviewed on an administrative workstation."
    ,"Une ou plusieurs photos n’ont pas pu être supprimées.": "One or more photos could not be deleted."
    ,"Impossible d’enregistrer le rapport. Restez sur cette page et réessayez.": "Unable to save the report. Stay on this page and try again."
}));

const originalText = new WeakMap();
const originalAttributes = new WeakMap();
const ATTRIBUTES = ["placeholder", "title", "aria-label"];
const SKIPPED_TAGS = new Set(["SCRIPT", "STYLE", "CODE", "PRE", "TEXTAREA"]);
const FRAGMENTS = new Map(Object.entries({
    "missions": "missions",
    "planning": "schedule",
    "clients": "clients",
    "entreprises du groupe": "group companies",
    "notes d'intervention": "job notes",
    "notifications": "notifications",
    "conversation": "conversation",
    "documents": "documents",
    "document": "document",
    "fichier": "file",
    "fichiers": "files",
    "rapport": "report",
    "rapports": "reports",
    "configuration de la boîte professionnelle": "professional mailbox configuration",
    "espace e-mail de l'entreprise": "company email workspace",
    "module comptable": "accounting module",
    "indicateurs": "indicators",
    "demandes Support": "Support requests",
    "organisations": "organizations",
    "notifications partenaires": "partner notifications",
    "photo": "photo",
    "photos": "photos",
    "client": "client",
    "adresse": "address",
    "sinistre": "claim",
    "téléphone": "phone number",
    "e-mail": "email",
    "date": "date",
    "statut": "status"
}));
const DYNAMIC_PATTERNS = [
    [/^Chargement (?:de |des |du |de la |de l')?(.+)…$/, (_, subject) => `Loading ${translateFragment(subject, "content")}…`],
    [/^Mise à jour (?:de |des |du |de la |de l')?(.+)…$/, (_, subject) => `Updating ${translateFragment(subject, "content")}…`],
    [/^Impossible de charger (?:de |des |du |de la |de l')?(.+)\.$/, (_, subject) => `Unable to load ${translateFragment(subject, "content")}.`],
    [/^Aucun(?:e)? (.+)\.$/, (_, subject) => `No ${translateFragment(subject, "items to display")}.`],
    [/^(\d+) notification(?:s)? non lue(?:s)?$/, (_, count) => `${count} unread notification${count === "1" ? "" : "s"}`],
    [/^(\d+) mission(?:s)?$/, (_, count) => `${count} mission${count === "1" ? "" : "s"}`],
    [/^(\d+) document(?:s)?$/, (_, count) => `${count} document${count === "1" ? "" : "s"}`],
    [/^(\d+) jour(?:s)?$/, (_, count) => `${count} day${count === "1" ? "" : "s"}`],
    [/^(\d+) intervention(?:s)? créée(?:s)?$/, (_, count) => `${count} job${count === "1" ? "" : "s"} created`],
    [/^(\d+) dossier(?:s)? trouvé(?:s)?$/, (_, count) => `${count} file${count === "1" ? "" : "s"} found`],
    [/^(\d+) jour(?:s)? en conflit\s*:$/, (_, count) => `${count} conflicting day${count === "1" ? "" : "s"}:`],
    [/^Étape (\d+) sur (\d+)$/, "Step $1 of $2"],
    [/^Reçue le (.+)$/, (_, date) => `Received on ${translateDateWords(date)}`],
    [/^Créé le (.+)$/, (_, date) => `Created on ${translateDateWords(date)}`],
    [/^Modifié le (.+)$/, (_, date) => `Updated on ${translateDateWords(date)}`],
    [/^Actualisé à (.+)$/, "Updated at $1"],
    [/^Enregistré à (.+)$/, "Saved at $1"],
    [/^Appeler (.+)$/, "Call $1"],
    [/^Écrire à (.+)$/, "Email $1"],
    [/^Y aller vers (.+)$/, "Navigate to $1"],
    [/^Ajouter un événement le (.+)$/, "Add an event on $1"],
    [/^Mission : (.+)$/, (_, status) => `Mission: ${translateInterfaceText(status)}`],
    [/^(.+) a partagé l’intervention « (.+) »\.$/, "$1 shared the job “$2”."],
    [/^(.+) a transmis la mission « (.+) »\.$/, "$1 sent the mission “$2”."],
    [/^L’entreprise « (.+) » souhaite établir une connexion afin d’échanger des interventions\.$/, "$1 would like to connect and exchange jobs."],
    [/^(.+) a accepté votre demande de connexion\.$/, "$1 accepted your connection request."],
    [/^(.+) a refusé votre demande de connexion\.$/, "$1 rejected your connection request."],
    [/^(.+) a interrompu la connexion partenaire\.$/, "$1 disconnected the partner connection."],
    [/^Le rapport #(\d+) a été validé et son PDF a été archivé\.$/, "Report #$1 was approved and its PDF was archived."],
    [/^Le rapport #(\d+) a été remis en brouillon\.(?:.+)?$/, "Report #$1 was returned to draft."],
    [/^(.+) partagé avec le partenaire\.$/, (_, item) => `${translateFragment(item, "Document")} shared with the partner.`],
    [/^Supprimer la sélection \((\d+)\)$/, "Delete selection ($1)"],
    [/^(\d[\d\s]*) \/ (\d[\d\s]*) caractères$/, "$1 / $2 characters"],
    [/^(.+) non renseignée?\.?$/, (_, subject) => `${translateFragment(subject, "Information")} not provided`],
    [/^Envoyer « (.+) » à (.+) \?$/, "Send “$1” to $2?"],
    [/^Transmettre ce document à (.+) \?$/, "Send this document to $1?"],
    [/^Supprimer (?:définitivement )?(?:ce|cet|cette|la|le) .+\?$/, "Are you sure you want to delete this item?"],
    [/^Annuler (?:ce|cet|cette|la|le) .+\?$/, "Are you sure you want to cancel this item?"],
    [/^Déconnecter (?:ce|cet|cette|la|le|l’|l') .+\?$/, "Are you sure you want to disconnect it?"],
    [/^Réactiver (?:ce|cet|cette|la|le) .+\?$/, "Are you sure you want to reactivate it?"],
    [/^(.+) impossible\.$/, "This action could not be completed."],
    [/^Ex(?:\.|emple)?\s*:\s*(.+)$/, "Example: $1"],
    [/^Ex\.\s+(.+)$/, "Example: $1"]
];
const DATE_WORDS = new Map(Object.entries({
    lundi: "Monday", mardi: "Tuesday", mercredi: "Wednesday", jeudi: "Thursday", vendredi: "Friday", samedi: "Saturday", dimanche: "Sunday",
    lun: "Mon", mar: "Tue", mer: "Wed", jeu: "Thu", ven: "Fri", sam: "Sat", dim: "Sun",
    janvier: "January", février: "February", mars: "March", avril: "April", mai: "May", juin: "June", juillet: "July", août: "August", septembre: "September", octobre: "October", novembre: "November", décembre: "December"
}));
let language = "fr";
let observer = null;
let translating = false;
let nativeDialogsWrapped = false;

function translateFragment(value, fallback = "") {
    const source = String(value || "").trim();
    return FRAGMENTS.get(source) || FRAGMENTS.get(source.toLocaleLowerCase("fr")) || ENGLISH.get(source) || fallback || source;
}

function translateDateWords(value) {
    let translated = String(value || "");
    DATE_WORDS.forEach((translation, french) => { translated = translated.replace(new RegExp(`\\b${french}\\b`, "gi"), translation); });
    return translated;
}

export function translateInterfaceText(value) {
    const text = String(value || "");
    const trimmed = text.trim();
    const exact = ENGLISH.get(trimmed);
    if (exact) return text.replace(trimmed, exact);
    for (const separator of ["\n", " · "]) {
        if (!trimmed.includes(separator)) continue;
        const parts = trimmed.split(separator);
        const translatedParts = parts.map(part => translateInterfaceText(part));
        if (translatedParts.some((part, index) => part !== parts[index])) return text.replace(trimmed, translatedParts.join(separator));
    }
    for (const [pattern, replacement] of DYNAMIC_PATTERNS) if (pattern.test(trimmed)) return text.replace(trimmed, trimmed.replace(pattern, replacement));
    if (/\d/.test(trimmed)) {
        const translatedDate = translateDateWords(trimmed);
        if (translatedDate !== trimmed) return text.replace(trimmed, translatedDate);
    }
    return text;
}

function translateTextNode(node, refreshSource = false) {
    if (!originalText.has(node)) originalText.set(node, node.nodeValue);
    else if (refreshSource) {
        const source = originalText.get(node);
        const expected = language === "en" ? translateInterfaceText(source) : source;
        if (node.nodeValue !== expected) originalText.set(node, node.nodeValue);
    }
    const source = originalText.get(node);
    const next = language === "en" ? translateInterfaceText(source) : source;
    if (node.nodeValue !== next) node.nodeValue = next;
}

function translateAttribute(element, name, refreshSource = false) {
    if (!originalAttributes.has(element)) originalAttributes.set(element, {});
    const attributes = originalAttributes.get(element);
    if (!(name in attributes)) attributes[name] = element.getAttribute(name);
    else if (refreshSource) {
        const expected = language === "en" ? translateInterfaceText(attributes[name]) : attributes[name];
        if (element.getAttribute(name) !== expected) attributes[name] = element.getAttribute(name);
    }
    const next = language === "en" ? translateInterfaceText(attributes[name]) : attributes[name];
    if (element.getAttribute(name) !== next) element.setAttribute(name, next);
}

function translateElement(element) {
    if (element.closest("[data-no-translate]")) return;
    ATTRIBUTES.filter(name => element.hasAttribute(name)).forEach(name => translateAttribute(element, name));
    const attributes = originalAttributes.get(element) || {};
    if (element.tagName === "INPUT" && ["button", "submit", "reset"].includes(element.type) && element.hasAttribute("value")) {
        if (!attributes.value) attributes.value = element.getAttribute("value");
        element.value = language === "en" ? translateInterfaceText(attributes.value) : attributes.value;
    }
    if (SKIPPED_TAGS.has(element.tagName)) return;
    element.childNodes.forEach(child => {
        if (child.nodeType === Node.TEXT_NODE) translateTextNode(child);
        else if (child.nodeType === Node.ELEMENT_NODE) translateElement(child);
    });
}

function wrapNativeDialogs() {
    if (nativeDialogsWrapped || typeof window === "undefined") return;
    nativeDialogsWrapped = true;
    ["alert", "confirm", "prompt"].forEach(name => {
        const original = window[name]?.bind(window);
        if (!original) return;
        window[name] = (message, ...args) => original(language === "en" ? translateInterfaceText(message) : message, ...args);
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
    wrapNativeDialogs();
    applyInterfaceLanguage();
    if (!observer) {
        observer = new MutationObserver(records => {
            if (translating) return;
            translating = true;
            records.forEach(record => {
                if (record.type === "characterData") translateTextNode(record.target, true);
                else if (record.type === "attributes") translateAttribute(record.target, record.attributeName, true);
                else record.addedNodes.forEach(node => {
                    if (node.nodeType === Node.TEXT_NODE) translateTextNode(node);
                    else if (node.nodeType === Node.ELEMENT_NODE) translateElement(node);
                });
            });
            translating = false;
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES });
    }
    window.addEventListener("depannhome:settings-changed", event => applyInterfaceLanguage(event.detail?.lang));
}
