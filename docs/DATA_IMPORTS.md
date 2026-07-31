# Importation de données

L’outil **Paramètres → Outils → Importation de données** est réservé aux administrateurs connectés depuis un poste PC. Il permet de reprendre une base existante sans ressaisie manuelle.

## Périmètre de la première version

- fichiers Excel `.xlsx` et CSV `.csv` ;
- clients ;
- devis ;
- factures ;
- rapports d’intervention historiques.

Les utilisateurs, techniciens, rendez-vous, partenaires, paramètres de l’entreprise, planning et données comptables restent volontairement hors périmètre.

## Parcours sécurisé

1. L’administrateur choisit le type de données et le fichier.
2. Le serveur lit le fichier sans créer de donnée métier.
3. L’administrateur associe les colonnes détectées aux champs Depann’Home Pro.
4. Un aperçu affiche les enregistrements, erreurs et doublons.
5. L’administrateur sélectionne la stratégie de doublons et confirme.
6. Les lignes valides sont importées indépendamment : une erreur n’annule pas les autres lignes.
7. Le résultat est conservé dans le journal des imports.

Les sessions d’analyse sont rattachées à l’entreprise active et à leur auteur, puis expirent après une heure. Le fichier binaire n’est pas stocké : seules les valeurs analysées nécessaires au parcours sont conservées temporairement.

## Formats et correspondances

Les intitulés de colonnes sont libres. L’assistant propose des rapprochements courants, notamment :

- `Nom`, `Entreprise` ou `Société` vers le nom client ;
- `Téléphone portable`, `Téléphone fixe` ou `Mobile` vers le téléphone ;
- `Mail` vers l’e-mail ;
- `Adresse complète` vers l’adresse ;
- `Référence`, `Numéro`, `Date`, `Désignation`, `Quantité`, `Prix` et `TVA` pour les documents.

Les CSV séparés par virgules, points-virgules ou tabulations sont détectés automatiquement. Les cellules entre guillemets et les retours à la ligne Windows sont pris en charge.

## Doublons et intégrité

- Les clients sont rapprochés à partir du nom et du téléphone ou de l’e-mail.
- Les devis et factures utilisent le numéro du document, unique dans une entreprise.
- Les rapports historiques utilisent titre, date et client.
- Les doublons peuvent être ignorés, uniquement exclus de l’import, ou mis à jour.

Un devis ou une facture doit disposer d’un numéro, d’une date d’émission et d’au moins une ligne contenant une désignation et un prix unitaire. Les rapports importés restent en brouillon, sans rendez-vous artificiel, sans média ni validation automatique.

Chaque import est journalisé avec la date, le type, le fichier, le nombre de lignes source, les éléments importés, doublons et erreurs. Toutes les requêtes sont isolées par `owner_id`, y compris dans le contexte d’un groupe multi-entreprises.

## Limites

- 10 Mo par fichier ;
- 10 000 lignes analysées au maximum ;
- seule la première feuille d’un classeur Excel est lue.

L’architecture par type de données et champs de destination permet l’ajout ultérieur de nouveaux formats et adaptateurs, sans ouvrir les types volontairement exclus de cette première version.
