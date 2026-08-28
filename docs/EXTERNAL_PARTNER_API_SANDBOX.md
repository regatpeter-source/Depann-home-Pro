# Sandbox d’entreprise partenaire externe

## Finalité

La console Créateur peut provisionner l’entreprise fictive **Dépann'Home Test Services** pour tester une intégration partenaire de bout en bout. Ce banc de recette n’est pas un raccourci métier : une mission réussie effectue un véritable appel HTTP vers le même endpoint public que les partenaires externes :

- `POST /api/partner-intake/:partnerKey` ;
- header `X-API-Key` ;
- payload JSON partenaire standard ;
- authentification par hash, mapping, idempotence, création/rattachement du client, numéro interne, historique et erreurs du pipeline de production ;
- changement de statut par le service métier commun ;
- callback HTTP par l’outbox de production avec ses tentatives et relances.

Le partenaire fictif ne fait pas partie du Réseau Depann’Home Pro interne. Il est classé comme connecteur API externe Sandbox.

## Premier test

1. Ouvrir **Console Créateur → 🧪 Sandbox API partenaire**.
2. Choisir l’organisation destinataire puis **Provisionner automatiquement**.
3. Ouvrir le banc de test. La console affiche l’endpoint, la clé de test et le webhook. Ces informations sont réservées au Créateur.
4. Conserver **Succès normal**, puis cliquer sur **Envoyer une mission test**.
5. Sur le poste de l’entreprise destinataire, se connecter avec un Poste Admin, Poste administratif ou Poste Admin Mobile, ouvrir **Missions partenaires**, puis cliquer sur **🧪 API Sandbox**. Vérifier la mission `DHTS-*` dans cette boîte de réception séparée. Le même envoi répété avec le scénario `duplicate` conserve une seule mission.
6. Cliquer successivement sur **Accepter**, **En cours** et **Terminer**. Chaque action écrit l’historique et déclenche un callback HTTP réel.
7. Contrôler le journal API expurgé.
8. Utiliser **Réinitialiser** pour supprimer uniquement les artefacts de cette Sandbox.

Pour un essai depuis un second poste administratif, ouvrir l’URL réseau habituelle de l’application, se connecter avec le compte Créateur, puis utiliser la même console. Aucun second serveur ni seconde base n’est requis.

Si le journal indique `HTTP 404` et que l’ancienne configuration affiche `votre-service.onrender.com`, remplacer `PARTNER_SANDBOX_BASE_URL` par l’adresse HTTPS réelle du service Render, redéployer, puis cliquer sur **Régénérer le webhook** avant de renvoyer une mission.

## Identifiants et sécurité

La clé API est générée aléatoirement et affichée uniquement à sa création ou à sa rotation. Sa copie d’authentification est conservée sous forme de hash SHA-256 dans `depannhome_partner_intakes`. La copie nécessaire au simulateur d’entreprise externe est chiffrée en AES-256-GCM avec une clé dérivée de `SESSION_SECRET`. La rotation invalide immédiatement l’ancienne clé.

Les appels serveur utilisent `PARTNER_SANDBOX_BASE_URL` comme origine de confiance, jamais le header HTTP `Host`. En local, la valeur par défaut est `http://127.0.0.1:PORT`. Sur Render ou une recette distante, configurez l’URL HTTPS publique du service.

Le token de callback n’est conservé que sous forme de hash. Les journaux remplacent les clés, tokens, secrets et autorisations par `[REDACTED]`; les e-mails, téléphones et adresses de test sont également masqués.

Les URLs privées restent interdites pour les partenaires ordinaires. Le webhook local est créé uniquement par le serveur pour ce partenaire marqué `is_sandbox`; aucune URL privée saisie par un utilisateur n’est acceptée.

## Isolation

L’isolation repose sur plusieurs barrières cumulatives :

- `depannhome_partner_intakes.is_sandbox=TRUE` ;
- propriétaire `owner_id` obligatoire sur les configurations, missions, clients et logs ;
- exclusion explicite des intakes et missions Sandbox des tableaux partenaires de production ;
- clients générés marqués `client_data.isSandbox=true` et exclus de la synchronisation/liste client ordinaire ;
- aucune notification métier de production lors d’une réception Sandbox ;
- logs dans `depannhome_partner_api_sandbox_logs` ;
- suppression bornée à l’intake Sandbox et aux clients test qui ne sont référencés par aucune autre mission.

Le reset ne supprime jamais un client de production, une connexion du réseau interne ou une mission d’un autre intake.

## Scénarios d’erreur

Le sélecteur de scénario couvre :

- succès normal ;
- doublon/idempotence ;
- `400`, mission manquante et JSON invalide ;
- `401` (clé invalide) ;
- `403` ;
- `404` ;
- `500` ;
- timeout ;
- endpoint indisponible.

Pour les actions de statut, les scénarios `500`, `timeout` et `unavailable` s’appliquent au webhook. L’événement reste alors dans l’outbox réelle afin de tester les relances.

## Tables

- `depannhome_partner_api_sandboxes` : configuration isolée, secret chiffré et défaut webhook actif ;
- `depannhome_partner_api_sandbox_logs` : échanges HTTP expurgés ;
- tables réelles réutilisées : `depannhome_partner_intakes`, `depannhome_partner_missions`, `depannhome_partner_mission_history` et `depannhome_partner_mission_outbox`.

## Validation automatisée

`tests/partner-api-sandbox.test.js` contrôle l’identité fictive, le contrat de payload, la stabilité nécessaire aux doublons, le chiffrement, l’échec avec une mauvaise clé maîtresse, le hash, l’expurgation récursive, le masquage des coordonnées, les transitions de statut et la présence de tous les scénarios d’erreur. Le test est exécuté par `npm test` et `npm run check`.
