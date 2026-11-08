# Exploitation PostgreSQL

## Migrations versionnées

Les migrations SQL immuables résident dans `database/migrations/`. Leur nom suit `NNNN_description.sql`. Au démarrage, l’application :

1. crée `depannhome_schema_migrations` si nécessaire ;
2. prend un verrou consultatif PostgreSQL global ;
3. vérifie le SHA-256 de chaque migration déjà appliquée ;
4. applique chaque nouvelle migration dans une transaction ;
5. refuse de démarrer si une migration historique a été modifiée.

Commandes :

- `npm run db:migrate:status` : état, code 2 si une migration attend ;
- `npm run db:migrate` : application manuelle avant déploiement.

Les migrations sont **forward-only**. Ne modifiez jamais un fichier appliqué et n’effectuez pas de retour arrière destructif automatique : créez une migration corrective et restaurez une sauvegarde sur une base séparée si nécessaire.

## Sauvegarde

Prérequis : `pg_dump` et `pg_restore` de version au moins égale à celle du serveur, disponibles dans `PATH`.

`npm run db:backup` produit dans `DATABASE_BACKUP_PATH` :

- un `.dump` PostgreSQL au format custom, compressé ;
- un manifeste `.dump.json` contenant taille, date et SHA-256 ;
- une entrée `depannhome_backup_history` après vérification par `pg_restore --list`.

Planification recommandée : quotidienne, rétention quotidienne 7 jours, hebdomadaire 5 semaines, mensuelle 12 mois. Le stockage doit être chiffré, distinct de la base et à accès restreint.

Le contrôle **Santé → Base de données → Sauvegarde** consulte exclusivement les exécutions vérifiées inscrites dans `depannhome_backup_history`. Il ne peut pas détecter les sauvegardes automatiques proposées directement par l’hébergeur PostgreSQL. Une alerte signifie donc « aucune preuve de sauvegarde applicative récente », pas nécessairement « aucune sauvegarde n’existe chez l’hébergeur ». Sur un hébergement à système de fichiers éphémère, ne laissez jamais `DATABASE_BACKUP_PATH` sur `./backups` : exécutez la routine depuis un service planifié disposant de `pg_dump` et `pg_restore`, vers un stockage durable chiffré distinct.

## Restauration

Renseignez `DATABASE_URL` avec la source et `RESTORE_DATABASE_URL` avec une base cible vide et distincte, puis lancez :

`npm run db:restore -- chemin/depannhome-....dump --confirm-restore`

La commande vérifie le manifeste et le SHA-256, se connecte aux deux bases et refuse une cible dont le nom PostgreSQL réel est identique à celui de la source, même si les URL ou les serveurs diffèrent. Par prudence, deux bases de même nom sur des serveurs distincts sont également refusées. La cible est contrôlée pour détecter les schémas et objets utilisateurs ; toute erreur de contrôle bloque la restauration. Les URL ne doivent utiliser que le paramètre `sslmode` ; les certificats libpq éventuels sont indiqués via `PGSSLROOTCERT`, `PGSSLCERT` et `PGSSLKEY`.

`pg_restore` utilise `--single-transaction --exit-on-error` sans `--clean` : une erreur annule la transaction au lieu de supprimer des objets préexistants. Utilisez malgré tout une base et un compte isolés, sans trafic applicatif concurrent, et vérifiez que le routage DNS ou du proxy ne change pas entre le contrôle et la restauration. Les contrôles de catalogue ne remplacent ni l’isolation de la cible ni la confiance dans l’origine de l’archive.

Après restauration :

1. exécuter `npm run db:migrate:status` sur la cible ;
2. exécuter `npm run check` et un test fonctionnel en staging ;
3. vérifier les comptes, factures, écritures, pièces archivées et journaux ;
4. effectuer la bascule d’URL sous fenêtre de maintenance ;
5. conserver l’ancienne base en lecture seule jusqu’à validation.

## Test de reprise

Effectuer au minimum chaque trimestre une restauration sur une base temporaire. Consigner date, sauvegarde, durée, checksum, résultat des contrôles et décision de destruction de la cible. Une sauvegarde non restaurée périodiquement ne constitue pas une preuve de reprise.

Le test automatisé facultatif `tests/restore-roundtrip-postgresql.test.js` crée sa propre instance PostgreSQL temporaire sur l’interface locale, sauvegarde des données fictives, les restaure et vérifie aussi le refus d’une cible non vide ainsi que l’annulation d’une restauration en échec. Pour l’exécuter, définir `TEST_RESTORE_ROUND_TRIP=1` et `TEST_POSTGRES_BIN_DIRECTORY` avec le chemin absolu du répertoire contenant `initdb`, `pg_ctl`, `pg_dump` et `pg_restore`, puis lancer `node --test tests/restore-roundtrip-postgresql.test.js`. Ce test ne remplace pas un exercice de reprise avec une sauvegarde réelle de l’entreprise.
