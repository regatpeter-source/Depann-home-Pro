# Sécurité et supervision

## Secrets

- Stocker les secrets uniquement dans les variables d’environnement de l’hébergeur.
- `SESSION_SECRET` doit être aléatoire, unique à l’environnement et contenir au moins 32 caractères.
- Ne jamais copier un secret de production vers le développement ou les tests.
- Les mots de passe de récupération Créateur doivent être retirés immédiatement après usage.
- Restreindre l’accès à `DATABASE_URL`, aux secrets OAuth, SMTP et au tableau de bord Santé.

### Rotation

Les données AES-256-GCM existantes sont dérivées de `SESSION_SECRET`. Une rotation non préparée rendrait TOTP et identifiants chiffrés illisibles. Procédure actuelle :

1. sauvegarde vérifiée et fenêtre de maintenance ;
2. inventorier/révoquer les connexions OAuth, SMTP/IMAP et connecteurs ;
3. réinitialiser les authentificateurs TOTP concernés ;
4. remplacer `SESSION_SECRET` ;
5. reconnecter les fournisseurs et réenrôler TOTP ;
6. invalider les sessions/appareils et contrôler Santé.

Ne jamais changer cette variable silencieusement. Une future migration vers un coffre de clés versionné devra précéder la rotation sans réenrôlement.

## CSRF et CSP

Les écritures HTTP navigateur sont refusées lorsque `Origin` ou `Sec-Fetch-Site` indique un appel intersite. Les endpoints externes authentifiés (intake partenaire, dialogue externe, webhooks PDP et Sandbox) sont explicitement exemptés.

Helmet applique une CSP : scripts, connexions et workers locaux uniquement ; scripts inline, objets et frames interdits. `style-src 'unsafe-inline'` reste nécessaire aux styles calculés de graphiques, calendriers et éditeur de documents. L’objectif suivant est de remplacer ces styles par classes/variables validées puis de retirer cette exception.

## TOTP

Les codes ne sont jamais persistés. Les secrets sont chiffrés par AES-256-GCM. Les défis Créateur et entreprise expirent, sont consommables une fois et limités à cinq échecs. Les succès et échecs sont journalisés dans `depannhome_security_events` avec IP et user-agent hachés.

## Supervision et incidents

`/healthz` expose uniquement l’état public. La Console Créateur expose les contrôles détaillés : base, migrations, fraîcheur des sauvegardes, files en erreur, ordonnanceurs et métriques HTTP agrégées.

En cas d’incident :

1. qualifier impact et périmètre sans copier de données personnelles dans les tickets ;
2. préserver journaux, commit et horodatages ;
3. révoquer les secrets compromis et isoler l’intégration ;
4. restaurer sur une cible séparée si l’intégrité DB est douteuse ;
5. contrôler les audits métier et sécurité ;
6. documenter cause, correction, validation et mesures préventives.

Les journaux applicatifs ne doivent jamais contenir cookie, token, mot de passe, IBAN, adresse ou corps métier complet.
