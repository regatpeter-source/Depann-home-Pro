# Connexion utilisateurs : Render + PostgreSQL

L’application est désormais un **Render Web Service** Node.js. Le serveur gère les mots de passe et les sessions ; le navigateur ne reçoit jamais les identifiants de PostgreSQL ni le secret de session.

## Créer le service Web

1. Sur Render, créez ou modifiez un **Web Service** relié à ce dépôt.
2. Utilisez les paramètres suivants :
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
   - **Environment** : `Node`
3. Dans la section **Environment**, ajoutez les variables ci-dessous. Ne mettez aucun secret dans Git, dans `index.html` ou dans les fichiers JavaScript du navigateur.

| Variable | Valeur |
| --- | --- |
| `DATABASE_URL` | Référencez l’**Internal Database URL** de votre PostgreSQL Render. |
| `SESSION_SECRET` | Une valeur aléatoire d’au moins 32 caractères. Générez-la dans Render avec **Generate Value**. |
| `INITIAL_ADMIN_USERNAME` | Nom du premier administrateur, par exemple `admin`. |
| `INITIAL_ADMIN_PASSWORD` | Mot de passe fort d’au moins 12 caractères. |
| `ALLOW_PUBLIC_REGISTRATION` | `false` recommandé. Passez à `true` seulement si chaque utilisateur doit pouvoir créer son propre compte. |
| `NODE_ENV` | `production` |

Le serveur crée automatiquement les tables `depannhome_users`, `depannhome_clients`, `depannhome_calendar_events`, `depannhome_billing_profiles`, `depannhome_billing_templates`, `depannhome_billing_documents`, `depannhome_messages`, `depannhome_library_sections` et `depannhome_library_documents` au démarrage. Elles sont dédiées à Depann’Home et évitent tout conflit avec les tables de votre service VHR. Le fichier `database/schema.sql` est fourni à titre de référence ; il n’est donc pas nécessaire de l’exécuter manuellement.

## Équipe et espace entreprise

Le premier administrateur est le propriétaire de son **espace entreprise**. Dans **Paramètres → Équipe**, il peut créer un compte technicien en renseignant son nom, son téléphone, un identifiant et un mot de passe initial. Le technicien ne saisit ensuite que son identifiant et son mot de passe pour se connecter.

Chaque technicien possède une session personnelle, mais utilise les données de son espace entreprise : clients, planning, devis, factures, bibliothèque et notes. Les requêtes API déterminent cet espace côté serveur à partir du compte authentifié ; aucun identifiant d’entreprise fourni par le navigateur n’est accepté. Désactiver un technicien invalide ses accès dès sa prochaine requête. Les comptes existants avant cette mise à jour deviennent automatiquement administrateurs de leur propre espace.

La messagerie est exclusivement rattachée à une **fiche client** : elle n’existe plus comme écran général dans l’application administrateur ou technicien. Chaque membre de l’entreprise peut consulter les notes du dossier, en ajouter et modifier uniquement celles dont il est l’auteur. Pour l’administrateur comme pour le technicien, le bouton **Clients** affiche un badge lorsqu’un ou plusieurs dossiers ont reçu une note d’un autre membre depuis leur dernière consultation ; son clic ouvre directement le premier dossier concerné et positionne la messagerie sur cette note. Lorsqu’un administrateur crée ou modifie un rendez-vous — depuis le planning ou une fiche client — un aperçu affiche immédiatement les créneaux de la journée et signale visuellement un chevauchement. Le serveur refuse également l’enregistrement si le créneau chevauche un autre rendez-vous de l’entreprise. Les cartes de rendez-vous affichent directement le nom, le téléphone et l’adresse du client dans les vues mois, semaine et jour, pour l’administrateur comme le technicien. Sur téléphone, un technicien ouvre directement le planning et voit une navigation terrain réduite aux outils utiles en intervention. Lorsqu’il ouvre **Agenda**, il peut consulter le planning en vues **mois**, **semaine** ou **jour**, mais ne peut ni créer, ni modifier, ni supprimer un rendez-vous. L’administrateur peut affecter un rendez-vous à un technicien actif de son entreprise depuis la liste déroulante **Technicien affecté** ; cette attribution apparaît dans le planning. Depuis le détail d’un rendez-vous lié à un client, le technicien accède directement à la fiche client, à la création d’un **devis** ou d’une **facture**, aux **notes d’intervention**, ainsi qu’au dépôt de documents et de photos (caméra comprise). La fiche client technicien affiche aussi **Y aller** lorsque l’adresse est renseignée : ce lien ouvre la navigation native du smartphone avec l’adresse du client préremplie. Dans **Clients**, il peut uniquement rechercher et consulter un dossier utile à l’intervention (coordonnées, équipements, consignes et fichiers), sans le créer, modifier ou supprimer. Les fichiers déposés sont ajoutés par une route dédiée, limitée aux pièces jointes du dossier ; elle n’autorise pas la modification des données client. Seuls les administrateurs peuvent modifier ou supprimer les documents existants et les paramètres de facturation. Ces règles sont appliquées à la fois dans l’interface et par l’API. Les paramètres et la bibliothèque restent centrés sur l’administration sur ordinateur.

## Devis et factures de l’entreprise

L’onglet **Devis & factures** est privé à chaque espace entreprise. Chaque utilisateur autorisé peut y enregistrer le nom, les coordonnées, les identifiants légaux, les conditions de règlement et un logo de sa structure. Le logo accepte les formats PNG, JPEG ou WebP jusqu’à 2 Mo et reste stocké de façon privée dans PostgreSQL.

L’utilisateur peut créer des lignes préenregistrées (prestation, fourniture, unité, prix HT et TVA), puis les insérer dans ses devis et factures. Il peut aussi cocher **« Utiliser comme modèle de base »** lors de l’enregistrement d’un devis : ses lignes, TVA, conditions, catégorie et statut sont alors automatiquement proposés dans les futurs devis, tandis que le client, le numéro et les dates restent toujours vides et nouveaux. Les documents sont classés par destinataire : **Particulier**, **Professionnel**, **Magasin** ou **Autre**. Les montants HT, TVA et TTC sont calculés dans l’application. Tous les profils, lignes modèles, logos et documents sont filtrés côté serveur par compte : un autre utilisateur ne peut pas les lire ou les modifier, même en appelant l’API directement.

Sur la fiche d’un client, les devis et factures associés sont proposés avec deux actions : **E-mail**, qui prépare un brouillon dans l’application de messagerie de l’appareil, et **Imprimer / PDF**, qui ouvre une mise en page propre à imprimer ou enregistrer au format PDF via le navigateur. La fiche présente aussi un **historique** daté : création ou modification du dossier, ajout/suppression de fichiers, nouveaux rendez-vous, devis et factures. Cet historique fait partie du dossier client privé et se synchronise avec les autres appareils du même compte.

## Notes internes synchronisées

Les **notes d’intervention** sont synchronisées dans PostgreSQL uniquement entre les membres de la même entreprise et restent rattachées à leur dossier client. Le badge **Clients** est vérifié au chargement, au retour dans l’application et toutes les 30 secondes. Ouvrir un dossier marque ses notes comme consultées uniquement sur l’appareil et pour le membre concerné.

## Planning professionnel

Le planning est partagé avec les membres de l’espace entreprise et synchronisé avec PostgreSQL. Il propose une vue mensuelle, une navigation par mois, des rendez-vous modifiables et six codes couleurs : intervention, confirmé, à préparer, urgent, personnel et indisponible.

Chaque rendez-vous peut contenir un titre, un client, un lieu, une date, des horaires et des notes. Il reste inaccessible aux autres comptes, y compris par appel direct à l’API.

## Synchronisation des dossiers clients

Les dossiers clients, devis, factures, photos et autres pièces jointes sont maintenant synchronisés automatiquement entre les appareils connectés au **même compte**. Une modification est envoyée à PostgreSQL dès que le réseau est disponible. Hors ligne, elle est conservée sur l’appareil dans une file d’attente et synchronisée automatiquement au prochain retour du réseau.

Le bouton **Synchroniser** de l’écran Clients permet de lancer cette opération manuellement. La dernière modification d’un même dossier est prioritaire ; évitez donc de modifier exactement le même client hors ligne sur deux appareils en même temps. Les pièces jointes peuvent occuper l’espace de la base de données : conservez des fichiers compressés et raisonnables.

## Bibliothèque personnelle

Chaque utilisateur connecté peut créer ses propres sections métier (par exemple **Serrurerie**, **Interphonie** ou **Alarmes**) et y déposer des documents. Les PDF, fichiers Office, fichiers texte et images sont acceptés, avec une limite de **5 fichiers** et **20 Mo par fichier** à chaque envoi.

Les fichiers sont stockés dans PostgreSQL pour rester disponibles après les redéploiements Render. Ils utilisent donc l’espace de votre base de données : surveillez sa capacité et privilégiez des PDF optimisés. Une section et ses documents ne sont visibles, téléchargeables ou supprimables que par le compte qui les a créés. Même un autre utilisateur connecté ne peut pas ouvrir un document à partir de son lien direct.

## Recherche privée par mots-clés

La barre de recherche globale inclut le catalogue, les éléments privés du compte connecté et uniquement ceux-ci :

- les sections, titres, descriptions et noms de fichiers de sa bibliothèque personnelle ;
- ses clients enregistrés sur l’appareil ;
- les équipements, notes, coordonnées et noms de ses devis, factures ou pièces jointes locales.

Les clients et leurs fichiers locaux sont séparés par compte sur le navigateur actuel ; ils ne sont pas encore synchronisés entre plusieurs appareils. La recherche ne lit pas le texte à l’intérieur des PDF ou documents Office : ajoutez des mots-clés utiles au **titre**, à la **description** ou au **nom du fichier** lors de l’ajout.

## Premier déploiement

Au premier démarrage, le serveur crée le compte indiqué par `INITIAL_ADMIN_USERNAME` et `INITIAL_ADMIN_PASSWORD`, seulement s’il n’existe pas déjà. Ensuite, retirez `INITIAL_ADMIN_PASSWORD` de Render ou remplacez-le par une valeur non sensible : le serveur ne réinitialise jamais un administrateur existant.

Par défaut, l’inscription est fermée. Pour créer d’autres comptes sans rendre l’inscription publique, vous pouvez temporairement définir `ALLOW_PUBLIC_REGISTRATION=true`, créer les comptes voulus, puis revenir immédiatement à `false`. Une interface d’administration dédiée pourra être ajoutée ensuite.

## Sécurité appliquée

- mots de passe hachés avec `bcrypt` (12 tours) ;
- session JWT de 12 heures stockée dans un cookie `httpOnly`, `Secure` en production et `SameSite=Lax` ;
- limitation de 20 requêtes d’authentification par 15 minutes et par adresse IP ;
- les chemins `/data/` et `/assets/` sont refusés sans session valide ;
- le service worker ne met pas les catalogues, images ou PDF protégés en cache hors-ligne.

La connexion protège les ressources servies par ce Web Service. N’exposez pas simultanément le même dossier `assets/` via un Render Static Site ou un autre hébergement public, sinon cet autre hébergement contournerait la protection.

## Développement local

Copiez `.env.example` vers `.env`, puis remplacez les valeurs d’exemple. Utilisez une URL PostgreSQL locale ou externe appropriée. Installez les dépendances, puis démarrez le serveur avec le script `dev`.

Le serveur écoute sur `PORT` (ou `3000` localement). Les données catalogue et notices sont volontairement inaccessibles tant que la connexion n’est pas établie.
