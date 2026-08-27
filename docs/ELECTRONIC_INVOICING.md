# Architecture multi-plateformes de facturation électronique

Depann’Home Pro n’est ni une plateforme agréée, ni une PDP, ni une plateforme certifiée de transmission. Chaque entreprise choisit son prestataire, souscrit directement auprès de lui et possède sa connexion.

## Isolation et stockage

`depannhome_einvoice_connections` contient des connexions versionnées et strictement rattachées à `owner_id`. Une seule connexion peut être active par entreprise. Les jetons délégués sont chiffrés en AES-256-GCM avec `SESSION_SECRET` et ne sont jamais renvoyés au navigateur. Le `client_secret` de l’application OAuth Depann’Home Pro reste exclusivement dans les variables d’environnement du serveur.

La déconnexion efface les credentials actifs mais ne supprime ni la connexion historique, ni les transmissions, ni les événements d’audit. Changer de plateforme conserve donc les références et statuts précédents.

Les anciennes configurations du transport UBL universel sont migrées vers `legacy_ubl_api`, désactivées et marquées `action_required`. Le secret chiffré est préservé pendant la migration, mais cette configuration ne peut plus transmettre : son protocole n’était pas celui d’une API fournisseur documentée.

## Adaptateurs

Chaque intégration étend `ElectronicInvoicingProvider` et implémente les opérations réellement documentées par son fournisseur :

- `connect` et `disconnect` ;
- `testConnection` ;
- `sendInvoice` et `sendCreditNote` ;
- `getTransmissionStatus` ;
- `refreshAuthentication` ;
- `getAccountInformation` ;
- `verifyWebhook` lorsque le fournisseur propose des notifications signées.

Le registre ne rend connectables que les adaptateurs effectivement enregistrés. Il n’existe plus de formulaire universel URL/clé API et aucun protocole fournisseur n’est deviné. En l’absence d’adaptateur documenté, l’interface indique : « Cette plateforme n'est pas encore intégrée à Depan’Home Pro. »

## SUPER PDP

SUPER PDP (`super_pdp`) est la première intégration enregistrée. Elle repose exclusivement sur les contrats officiels :

- OAuth 2.1 Authorization Code pour la délégation multi-entreprises ;
- `state` opaque lié à l’entreprise et à l’administrateur, valable dix minutes et consommé atomiquement une seule fois ;
- PKCE S256, callback exact configuré par `SUPERPDP_REDIRECT_URI` et HTTPS obligatoire en production ;
- access token et refresh token stockés uniquement sous forme chiffrée côté serveur ;
- rotation du refresh token sous verrou PostgreSQL `FOR UPDATE`, afin que deux requêtes concurrentes ne réutilisent jamais le même jeton ;
- révocation RFC 7009 lors de la déconnexion.

Le serveur consulte d’abord `/v1.beta/oauth2_sessions/me`. Une session `needs_review` est conservée en `action_required` et ne peut transmettre aucun document. Le bouton « Vérifier » permet de constater ultérieurement le passage à `verified`, puis `/v1.beta/companies/me` identifie le compte et son environnement.

Les variables suivantes doivent être renseignées dans Render ou dans un `.env` local non versionné : `SUPERPDP_CLIENT_ID`, `SUPERPDP_CLIENT_SECRET` et `SUPERPDP_REDIRECT_URI`. Le callback à déclarer est `/api/accounting/e-invoicing/oauth/callback` sur l’origine publique de l’application.

### Transmission et suivi

Les archives UBL émises par Depann’Home Pro sont déposées telles quelles avec `POST /v1.beta/invoices` en `application/xml`. La référence `id` renvoyée est conservée dans la transmission. Le dépôt `200` ne signifie pas que la facture est acceptée : SUPER PDP la traite de façon asynchrone.

L’état est relu avec `GET /v1.beta/invoices/{id}`. Les `events[]` sont cumulatifs et ne constituent pas une machine à états exclusive. Depann’Home Pro conserve le dernier code externe et traduit les événements officiels en états locaux `sent`, `accepted` ou `rejected`. SUPER PDP ne proposant pas actuellement de webhook sur cette API, l’interface utilise une interrogation explicite ; aucun webhook fournisseur n’est simulé.

## Catalogue Créateur

La console Créateur contient un catalogue distinct des connexions d’entreprise. Il permet de suivre le code technique d’une plateforme, sa documentation API officielle HTTPS, son authentification, les capacités prévues et le cycle de développement de son adaptateur.

Une fiche de catalogue ne contient aucun credential d’entreprise, n’exécute aucun appel externe et ne génère aucun code. Le statut « Déployé » est refusé tant qu’un adaptateur portant le même code n’est pas réellement enregistré dans le serveur. Les entreprises continuent de fournir séparément leurs propres identifiants chiffrés.

### Sandbox SUPER PDP réservé au Créateur

La Console Créateur propose un banc de test distinct fondé sur le `quick_start.js` officiel de SUPER PDP. Il reçoit les deux couples Client Credentials des entreprises fictives vendeur et acheteur, les chiffre avec `SESSION_SECRET` dans `depannhome_creator_super_pdp_sandbox` et ne les renvoie jamais au navigateur. Cette table n’est pas une connexion d’entreprise et n’est jamais consultée par les routes comptables.

Le scénario obtient deux jetons courts, vérifie les deux sociétés avec `/v1.beta/companies/me`, exige que chacune déclare `env: sandbox`, génère le fichier UBL officiel, le valide avec `/v1.beta/validation_reports`, l’envoie puis vérifie son traitement vendeur et sa réception acheteur. Il n’émet volontairement pas l’événement de paiement `fr:212`. Le test est borné dans le temps et un verrou empêche deux exécutions concurrentes pour le même Créateur.

Ce banc de test ne remplace pas l’application Authorization Code multi-tenant configurée par les variables `SUPERPDP_*`. Ses Client Credentials fictifs ne peuvent donc jamais connecter ni représenter une entreprise cliente de Depann’Home Pro.

### Utilisation depuis la Console Créateur

La fiche d’une organisation dans la Console Créateur expose l’état de sa connexion et ses dernières transmissions avec le même adaptateur `super_pdp`. Cette vue est strictement en lecture seule : elle ne sélectionne jamais les colonnes de credentials chiffrés, de renouvellement ou de webhook, et ne permet ni connexion, ni déconnexion, ni transmission au nom d’une entreprise cliente.

La Console Créateur dispose en plus d’un espace SUPER PDP propre à la plateforme Depann’Home Pro, stocké dans `depannhome_creator_super_pdp_connection`. Cette identité sert à la facturation des abonnements et reste totalement distincte du compte administrateur/Créateur qui peut aussi réaliser des interventions, devis et factures métier. Son état OAuth temporaire utilise également une table dédiée. Le callback public reste identique à celui déclaré chez SUPER PDP, mais l’état opaque consommé une seule fois détermine sans ambiguïté le coffre destinataire.

Les factures d’abonnement sont visibles dans cet espace. Leur transmission structurée reste désactivée tant qu’une archive UBL conforme n’est pas produite et archivée avec ces documents ; le PDF envoyé par e-mail n’est jamais présenté comme une facture électronique transmise par SUPER PDP.

## Routes et webhooks

Les routes administratives sont sous `/api/accounting/e-invoicing`. Le serveur déduit toujours l’entreprise avec `getAccountOwnerId(request)` et filtre chaque connexion, document et transmission avec cet identifiant.

Un webhook public ne reçoit jamais de `owner_id` utilisable. Il résout la connexion par le code plateforme et le hachage SHA-256 d’un jeton opaque, puis l’adaptateur vérifie la notification fournisseur. La transmission est retrouvée avec le triplet de confiance `owner_id` résolu, `platform_code` et référence externe.

## Périmètres indépendants

La production des factures/avoirs et de leurs archives UBL/PDF reste indépendante du transport. Le grand livre, les exports comptables et la préparation FEC ne dépendent d’aucune connexion de facturation électronique.

## État des intégrations

SUPER PDP est intégrée à partir de sa documentation officielle et de sa spécification OpenAPI `v1.beta`. Elle devient utilisable uniquement après configuration de l’application OAuth serveur et autorisation réussie de l’entreprise. Les autres fournisseurs restent non opérationnels tant qu’un adaptateur fondé sur leur propre API officielle n’a pas été développé et testé.