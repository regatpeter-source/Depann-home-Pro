# Ressources, portail client et rentabilité

La version 1.17 active les fonctions métier internes, sans compte auprès d’un prestataire tiers.

## Accès

Sur un poste administratif :

- **Clients → Portail client** gère les liens documentaires et les décisions de devis ;
- **Devis & rapports → Rentabilité** calcule les marges d’intervention ;
- **Ressources** regroupe **Sites & équipements**, **Stock** et **Véhicules**.

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

## Rappels internes du tableau de bord

Le moteur interne peut continuer à alimenter les rappels du tableau de bord pour :

- les devis à relancer ;
- les contrats à renouveler ;
- les maintenances à planifier ;
- le stock faible.

Il n’existe plus de menu **Automatisations** séparé. Le moteur s’exécute en arrière-plan toutes les quinze minutes ; un verrou PostgreSQL empêche les doubles exécutions et une clé de déduplication empêche les rappels en double.

## Sécurité et exploitation

Toutes les données métier sont filtrées par `owner_id`. Les ressources liées sont vérifiées contre le même client et la même entreprise. La migration `0038_all_in_one_business_suite.sql` est appliquée par le mécanisme de migrations habituel et le schéma canonique est synchronisé dans `database/schema.sql`.
