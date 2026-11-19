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

Pour Google Tag, `connect-src` autorise notamment les origines exactes `https://analytics.google.com` et `https://stats.g.doubleclick.net`. L’autorisation `https://*.analytics.google.com` couvre les sous-domaines, mais pas `https://analytics.google.com` lui-même. Ces exceptions de connexion n’autorisent pas de scripts supplémentaires et ne doivent pas être remplacées par une ouverture globale (`*`, `https:` ou `https://*.doubleclick.net`). Après modification de la CSP, redéployer ou redémarrer le serveur, recharger la page et relancer le diagnostic Google Tag.

Les blocages supplémentaires signalés pour Tag Assistant et Google Ads sont traités uniquement dans deux directives, en conservant leurs sources existantes :

- `style-src` ajoute `https://www.googletagmanager.com` pour `/debug/badge.css` et `https://fonts.googleapis.com` pour les feuilles de style Google ;
- `img-src` ajoute l’origine exacte `https://www.google.fr` pour `/ads/ga-audiences`.

Ce correctif ne modifie pas `script-src`, `connect-src`, `frame-src` ni `font-src`. `fonts.gstatic.com` n’est pas autorisé préventivement : un éventuel blocage devra être confirmé avant un ajout.

Lorsque Render affiche **Live**, recharger la page avec `Ctrl+F5` et refaire le test Tag Assistant avec `GTM-P29ZXC9C`, en vérifiant les erreurs CSP de la console. Le conteneur GTM de la vitrine n’est chargé qu’après acceptation des cookies de mesure et si le navigateur n’envoie pas `Do Not Track`. La disparition des trois blocages ne suffit pas à garantir la résolution du statut « Non connecté ».

Tag Assistant ouvre la page testée depuis `tagassistant.google.com` puis dialogue avec elle via `window.opener`. Avec `Cross-Origin-Opener-Policy: same-origin` (valeur par défaut de Helmet), le navigateur remet `window.opener` à `null` et l’aperçu reste « Non connecté ». Les pages publiques de `public/*.html`, seules à charger GTM, sont donc servies par `sendPublicPage()` avec `PUBLIC_PAGE_HEADERS` (`Cross-Origin-Opener-Policy: unsafe-none`). L’application authentifiée (`/connexion`, `/app` et `/` pour un utilisateur connecté) conserve `same-origin`. `same-origin-allow-popups` ne suffit pas, car il ne protège que les fenêtres ouvertes par le site.

`analytics-consent.js` reproduit aussi l’événement `{ "gtm.start", event: "gtm.js" }` de l’extrait officiel avant d’insérer le conteneur : sans lui, les déclencheurs « Page View » / « All Pages » ne se déclenchent pas. Après toute modification de ce script, incrémenter son paramètre `?v=` dans toutes les pages publiques (cache `/site-assets` d’un jour).

Pour l’aperçu, saisir dans Tag Assistant une URL publique (par exemple `https://depannhomepro.com/logiciel-entreprise-depannage`) ou `/` sans être connecté, car `/` sert l’application sans GTM à un utilisateur connecté. Dans l’onglet ouvert, cliquer sur **Accepter** dans le bandeau cookies, puis sur **Réessayer** dans Tag Assistant si la connexion a expiré avant le chargement de GTM.

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
