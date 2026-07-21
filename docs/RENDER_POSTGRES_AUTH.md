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

Le serveur crée automatiquement les tables `depannhome_users`, `depannhome_library_sections` et `depannhome_library_documents` au démarrage. Elles sont dédiées à Depann’Home et évitent tout conflit avec les tables de votre service VHR. Le fichier `database/schema.sql` est fourni à titre de référence ; il n’est donc pas nécessaire de l’exécuter manuellement.

## Bibliothèque personnelle

Chaque utilisateur connecté peut créer ses propres sections métier (par exemple **Serrurerie**, **Interphonie** ou **Alarmes**) et y déposer des documents. Les PDF, fichiers Office, fichiers texte et images sont acceptés, avec une limite de **5 fichiers** et **20 Mo par fichier** à chaque envoi.

Les fichiers sont stockés dans PostgreSQL pour rester disponibles après les redéploiements Render. Ils utilisent donc l’espace de votre base de données : surveillez sa capacité et privilégiez des PDF optimisés. Une section et ses documents ne sont visibles, téléchargeables ou supprimables que par le compte qui les a créés. Même un autre utilisateur connecté ne peut pas ouvrir un document à partir de son lien direct.

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
