# Gestion tout-en-un

La version 1.17 active six fonctions internes, sans compte auprès d’un prestataire tiers.

## Accès

Sur un poste administratif, ouvrir **Gestion tout-en-un** puis choisir le sous-menu voulu. Chaque sous-menu peut rester ouvert dans l’espace de travail ou être détaché en faisant glisser son onglet avec le clic gauche hors de la fenêtre, directement vers le second écran.

## Portail client et décisions de devis

1. Choisir un client et les documents à partager.
2. Définir la durée du lien (1 à 90 jours).
3. Copier le lien affiché une seule fois et le transmettre au client.
4. Révoquer le lien à tout moment depuis le même écran.

Le serveur conserve uniquement un condensat SHA-256 du jeton. Les accès sont datés et pseudonymisés. Un client peut consulter ses PDF et accepter ou refuser un devis. La décision est définitive, horodatée et liée à l’empreinte du document ; elle ne modifie pas les données légales d’une facture émise.

## Sites, équipements et contrats

La fiche de parc est structurée par client :

- sites et coordonnées d’accès ;
- équipements, références, garanties et état ;
- contrats, fréquence, SLA, prochaine maintenance et échéance ;
- liaison d’une intervention à un site, un équipement et un contrat du même client.

## Stock, dépôts et véhicules

Créer d’abord les emplacements et articles, puis enregistrer les mouvements. Le stock disponible est la somme du journal immuable des mouvements. Une sortie ne peut pas rendre le stock négatif, sauf dérogation explicite d’un administrateur accompagnée d’un motif. Les consommations peuvent être affectées à une intervention.

L’API prend aussi en charge les transferts atomiques entre dépôt et véhicule via `POST /api/business-suite/inventory/transfers`.

## Rentabilité d’intervention

Le calcul versionné agrège :

- le chiffre d’affaires HT des factures et avoirs émis liés à l’intervention ;
- le temps des sessions technicien valorisé par le coût horaire du rôle ;
- les pièces consommées ;
- les achats explicitement affectés.

Configurer les coûts horaires chargés, puis affecter si nécessaire les achats à l’intervention depuis l’écran **Rentabilité**.

## Automatisations internes

Les règles disponibles créent des rappels internes pour :

- les devis à relancer ;
- les contrats à renouveler ;
- les maintenances à planifier ;
- le stock faible.

Le moteur s’exécute toutes les quinze minutes et peut être déclenché manuellement. Un verrou PostgreSQL empêche les doubles exécutions et une clé de déduplication empêche les rappels en double.

## Sécurité et exploitation

Toutes les données métier sont filtrées par `owner_id`. Les ressources liées sont vérifiées contre le même client et la même entreprise. La migration `0038_all_in_one_business_suite.sql` est appliquée par le mécanisme de migrations habituel et le schéma canonique est synchronisé dans `database/schema.sql`.
