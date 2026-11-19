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

Helmet applique une CSP restrictive : ressources locales par défaut, exceptions explicites pour la cartographie et les balises Google ; scripts inline et objets interdits. Les frames sont limitées à la même origine et aux aperçus `blob:`, tandis que `frame-ancestors 'none'` interdit l’encapsulation de l’application. `style-src 'unsafe-inline'` reste nécessaire aux styles calculés de graphiques, calendriers et éditeur de documents. L’objectif suivant est de remplacer ces styles par classes/variables validées puis de retirer cette exception.

Pour Google Tag Manager (mode Aperçu / Tag Assistant), GA4 et Google Ads, la CSP reprend la liste du [guide CSP officiel de Google](https://developers.google.com/tag-platform/security/guides/csp) au lieu d’ajouter les domaines un par un à chaque erreur :

- `script-src` : hôtes Google explicites, sans joker (`www.googletagmanager.com`, `tagmanager.google.com`, `www.googleadservices.com`, `www.google.com`, `googleads.g.doubleclick.net`) ;
- `style-src` / `font-src` : badge et interface de débogage (`www.googletagmanager.com`, `tagmanager.google.com`, `fonts.googleapis.com`, `fonts.gstatic.com`) ;
- `img-src` / `connect-src` : mesures et audiences (`*.googletagmanager.com`, `*.google-analytics.com`, `*.google.com`, `*.google.fr`, `*.g.doubleclick.net`, `pagead2.googlesyndication.com`, `www.googleadservices.com`) ;
- `frame-src` : iframe technique `www.googletagmanager.com`.

CSP n’accepte pas de joker sur le domaine de premier niveau : chaque domaine Google national (`google.fr`, `google.be`, etc.) doit être ajouté explicitement si une audience étrangère le nécessite. Ne jamais remplacer ces exceptions par une ouverture globale (`*`, `https:` ou `https://*.doubleclick.net`), ni ajouter de joker dans `script-src`. Après modification de la CSP, redéployer ou redémarrer le serveur, recharger la page et relancer le diagnostic Google Tag.

Tag Assistant ne peut se connecter que si le conteneur GTM est chargé : sur la vitrine, cela exige d’avoir **accepté** les cookies de mesure et que le navigateur n’envoie pas `Do Not Track`. Les bloqueurs de publicité et le blocage des cookies tiers peuvent aussi empêcher la connexion.

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

## Assistance Créateur

Le Centre d’assistance n’usurpe jamais l’identité d’un client et ne remplace pas `request.user`. Les diagnostics passent uniquement par des routes Créateur dédiées et expurgées des secrets. Une session normale expire après 30 minutes ; le mode d’urgence expire après 10 minutes. Chaque ouverture, clôture et réparation est motivée, auditée et notifiée aux administrateurs de l’entreprise. La procédure complète figure dans [CREATOR_ASSISTANCE.md](CREATOR_ASSISTANCE.md).
