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

## Restauration

Une restauration directe sur `DATABASE_URL` est refusée. Définissez `RESTORE_DATABASE_URL` vers une base cible vide et distincte, puis lancez :

`npm run db:restore -- chemin/depannhome-....dump --confirm-restore`

La commande vérifie le manifeste et le SHA-256 avant `pg_restore --clean --if-exists --exit-on-error`.

Après restauration :

1. exécuter `npm run db:migrate:status` sur la cible ;
2. exécuter `npm run check` et un test fonctionnel en staging ;
3. vérifier les comptes, factures, écritures, pièces archivées et journaux ;
4. effectuer la bascule d’URL sous fenêtre de maintenance ;
5. conserver l’ancienne base en lecture seule jusqu’à validation.

## Test de reprise

Effectuer au minimum chaque trimestre une restauration sur une base temporaire. Consigner date, sauvegarde, durée, checksum, résultat des contrôles et décision de destruction de la cible. Une sauvegarde non restaurée périodiquement ne constitue pas une preuve de reprise.
