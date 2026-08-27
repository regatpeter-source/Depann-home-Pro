# Stratégie de tests

## Validation courante

- `npm test` : tests unitaires, structurels et intégration PostgreSQL si configurée ;
- `npm run check` : tests puis vérification syntaxique de tous les modules critiques ;
- `npm run test:e2e` : parcours API/PostgreSQL comptable ciblé.

## Base d’intégration

Définir `TEST_DATABASE_URL` vers une base **dédiée**, dont le nom contient `test`. Le test crée un schéma éphémère puis le détruit. Il ne doit jamais recevoir une URL de production.

Le scénario `tests/accounting-postgresql.test.js` vérifie réellement :

- lecture et refus d’écriture du rôle Comptable ;
- création Administrateur et isolation `owner_id` ;
- persistance PostgreSQL de la ventilation client/aide/TVA/vente/banque ;
- solde nul du compte client après règlement ;
- application idempotente des migrations checksumées.

La CI démarre PostgreSQL 16 et fournit automatiquement cette URL.

## Charge autorisée

Démarrer l’application sur une base de recette puis exécuter `npm run test:load`. Par défaut, le script cible uniquement `http://127.0.0.1:3000/healthz`, avec 100 requêtes et une concurrence de 10.

Variables :

- `LOAD_TEST_URL` ;
- `LOAD_TEST_REQUESTS` ;
- `LOAD_TEST_CONCURRENCY` ;
- `LOAD_TEST_TIMEOUT_MS` ;
- `LOAD_TEST_MAX_P95_MS`.

Une cible distante exige `LOAD_TEST_ALLOW_REMOTE=true` et l’autorisation préalable du propriétaire. Ne jamais effectuer de charge sur la production pendant les heures d’exploitation. Le rapport fournit durée, erreurs et latences P50/P95/P99 ; les seuils ne constituent une référence qu’après mesure sur l’environnement cible.

## Avant déploiement

1. `npm ci` ;
2. `npm run check` ;
3. `npm run db:migrate:status` ;
4. sauvegarde vérifiée ;
5. déploiement ;
6. contrôle `/healthz`, Console Santé et parcours de connexion ;
7. contrôle d’une facture avec aide/franchise et de son règlement en recette.
