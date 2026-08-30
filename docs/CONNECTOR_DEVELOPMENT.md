# Développer et exploiter un connecteur API

## Principe

Un connecteur Depann'Home Pro est un **plugin déclaratif** du registre de prestataires externes, administré uniquement depuis la **Console Créateur**. Il contient un manifeste, des endpoints, un mapping et les paramètres sécurisés de la plateforme. Aucun fichier JavaScript externe n'est chargé ni exécuté par le serveur de production.

Cette règle maintient le cœur applicatif stable, empêche l'exécution de code issu d'un partenaire et fonctionne sur Render, dont le système de fichiers est éphémère.

## Paquet exporté

Un paquet JSON généré par l'assistant contient :

- `manifest.json` : informations, connexion, endpoints et mappings ;
- `config.json` : réglages non sensibles ;
- `connector.js` : représentation du manifeste destinée aux développeurs ;
- `sync.js` : modèle de mapping pour une future synchronisation métier ;
- `README.md` : documentation et historique du paquet ;
- `logs/README.md` : politique de journalisation.

Les secrets ne sont jamais exportés. Après un import, le Créateur les renseigne dans le registre avant activation. Les entreprises clientes n’ont aucun accès à cet écran ni à ces valeurs.

## Manifeste

Le manifeste comprend :

- `general` : nom, logo HTTPS, description, version, auteur et site ;
- `connection` : type d'authentification, URL de base/test/production, timeout, tentatives et fréquence ;
- `endpoints` : nom, méthode, chemin, paramètres, headers, corps et réponse attendue ;
- `mappings` : association entre champs de l'API et champs Depann'Home Pro.

### OAuth 2.0 pour assurances et donneurs d’ordre

Le type `oauth2` utilise le flux serveur-à-serveur `client_credentials`. La configuration accepte :

- `tokenUrl` : endpoint de jeton de l’assurance ;
- `tokenAuthMethod` : `body` pour transmettre les identifiants dans le formulaire, ou `basic` pour HTTP Basic ;
- `scope` et `audience` : facultatifs, selon le contrat du partenaire ;
- `tenantHeaderName` : facultatif, par exemple `x-tenant-id`.

Les secrets `clientId`, `clientSecret` et `tenantId` sont chiffrés côté serveur. Le jeton est conservé uniquement en mémoire jusqu’à son expiration, renouvelé avec une marge de sécurité et renouvelé une fois immédiatement si l’API répond `401`.

Un endpoint peut être associé à `mission_accepted` ou `mission_status_changed`. Son chemin, ses paramètres, ses headers et son corps JSON acceptent des variables telles que `{mission_order_id}`, `{missionId}`, `{externalMissionId}`, `{event}` et `{status}`. Les valeurs insérées dans le chemin sont encodées.

Pour relier automatiquement une source de missions à un connecteur sortant, utilisez le même identifiant normalisé pour `partnerKey` et `connectorKey`. Le champ facultatif `rules.outboundConnectorKey` de la source permet de cibler une autre clé. Lorsqu’aucun endpoint événementiel correspondant n’est actif, l’URL de callback historique reste utilisée.

Les chemins d'endpoint commencent obligatoirement par `/`. Les URLs doivent être HTTP(S) externes : `localhost`, les boucles locales et les plages IPv4 privées usuelles sont refusés.

## Sécurité

- Tous les connecteurs et journaux sont systématiquement isolés dans l’espace du compte Créateur (`owner_id`).
- Les routes du registre exigent une session Créateur ; un administrateur d’entreprise ne peut ni consulter ni modifier un connecteur.
- Les credentials sont chiffrés AES-256-GCM à partir de `SESSION_SECRET`.
- Le client n'obtient que l'indication `hasCredentials`, jamais les valeurs secrètes.
- Les logs masquent les clés API, tokens, mots de passe et en-têtes `Authorization`.
- Les tests appliquent timeout et nombre maximal de nouvelles tentatives configurés.
- Les redirections automatiques sont refusées pour empêcher qu’un endpoint autorisé ne redirige vers une cible privée.
- Les identifiants de tenant sont masqués dans les journaux au même titre que les tokens et secrets.
- Les appels de test doivent rester sur des environnements partenaires contrôlés.

## Cycle de vie

1. Créer le connecteur avec l'assistant.
2. Décrire les endpoints et mappings.
3. Ajouter les secrets dans la configuration sécurisée de la plateforme. Pour OAuth 2.0, renseigner Client ID, Client Secret et, si nécessaire, l’identifiant tenant.
4. Tester chaque endpoint et contrôler la réponse JSON ainsi que le journal.
5. Associer les endpoints aux événements métier, utiliser la même clé que la source de missions, puis activer le connecteur lorsque les tests sont validés.
6. Exporter un paquet pour le versionner ou le partager sans secret.

## Extension métier future

Le runtime fournit déjà le contrat de transport, le mapping et le journal. Avant de synchroniser automatiquement des missions, clients ou factures vers les tables métier, ajouter un adaptateur explicitement versionné qui définit : validation de schéma, idempotence, résolution des doublons, stratégie de conflits et transaction PostgreSQL. Cela évite qu'une réponse partenaire incomplète ne crée ou n'écrase des données opérationnelles.
