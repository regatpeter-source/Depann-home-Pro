# Développer et exploiter un connecteur API

## Principe

Un connecteur Depann'Home Pro est un **plugin déclaratif** : il contient un manifeste, des endpoints, un mapping et des paramètres par entreprise. Aucun fichier JavaScript externe n'est chargé ni exécuté par le serveur de production.

Cette règle maintient le cœur applicatif stable, empêche l'exécution de code issu d'un partenaire et fonctionne sur Render, dont le système de fichiers est éphémère.

## Paquet exporté

Un paquet JSON généré par l'assistant contient :

- `manifest.json` : informations, connexion, endpoints et mappings ;
- `config.json` : réglages non sensibles ;
- `connector.js` : représentation du manifeste destinée aux développeurs ;
- `sync.js` : modèle de mapping pour une future synchronisation métier ;
- `README.md` : documentation et historique du paquet ;
- `logs/README.md` : politique de journalisation.

Les secrets ne sont jamais exportés. Après un import, ils doivent être renseignés dans l'assistant avant activation.

## Manifeste

Le manifeste comprend :

- `general` : nom, logo HTTPS, description, version, auteur et site ;
- `connection` : type d'authentification, URL de base/test/production, timeout, tentatives et fréquence ;
- `endpoints` : nom, méthode, chemin, paramètres, headers, corps et réponse attendue ;
- `mappings` : association entre champs de l'API et champs Depann'Home Pro.

Les chemins d'endpoint commencent obligatoirement par `/`. Les URLs doivent être HTTP(S) externes : `localhost`, les boucles locales et les plages IPv4 privées usuelles sont refusés.

## Sécurité

- Tous les connecteurs et journaux sont systématiquement filtrés par `owner_id`.
- Les credentials sont chiffrés AES-256-GCM à partir de `SESSION_SECRET`.
- Le client n'obtient que l'indication `hasCredentials`, jamais les valeurs secrètes.
- Les logs masquent les clés API, tokens, mots de passe et en-têtes `Authorization`.
- Les tests appliquent timeout et nombre maximal de nouvelles tentatives configurés.
- Les appels de test doivent rester sur des environnements partenaires contrôlés.

## Cycle de vie

1. Créer le connecteur avec l'assistant.
2. Décrire les endpoints et mappings.
3. Ajouter les secrets dans la configuration locale de l'entreprise.
4. Tester chaque endpoint et contrôler la réponse JSON ainsi que le journal.
5. Activer le connecteur lorsque les tests sont validés.
6. Exporter un paquet pour le versionner ou le partager sans secret.

## Extension métier future

Le runtime fournit déjà le contrat de transport, le mapping et le journal. Avant de synchroniser automatiquement des missions, clients ou factures vers les tables métier, ajouter un adaptateur explicitement versionné qui définit : validation de schéma, idempotence, résolution des doublons, stratégie de conflits et transaction PostgreSQL. Cela évite qu'une réponse partenaire incomplète ne crée ou n'écrase des données opérationnelles.
