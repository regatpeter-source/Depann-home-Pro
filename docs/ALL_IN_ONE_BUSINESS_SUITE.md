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
3. Envoyer le lien au client par e-mail si son adresse est renseignée et si l’envoi est sélectionné, ou copier le lien affiché une seule fois pour le transmettre manuellement.
4. Révoquer le lien à tout moment depuis le même écran.

Le serveur conserve uniquement un condensat SHA-256 du jeton et archive, pour chaque lien, les PDF exacts qui seront présentés au client. Les accès sont datés et pseudonymisés. Le client doit ouvrir le PDF avant de pouvoir accepter ou refuser un devis finalisé ; les brouillons et devis annulés ne peuvent pas recevoir de décision. La décision définitive est horodatée et liée à l’empreinte du PDF archivé ; le statut du devis est mis à jour en conséquence. Une notification e-mail est envoyée à l’adresse de l’entreprise configurée dans sa fiche de facturation. Si elle échoue, son état est visible dans **Liens et décisions** et l’envoi peut être relancé. Une décision par clic ne constitue pas une signature électronique certifiée. La décision ne modifie pas les données légales d’une facture émise.

## Sites, équipements et contrats

La fiche de parc est structurée par client :

- sites et coordonnées d’accès ;
- équipements, références, garanties et état ;
- contrats, fréquence, SLA, prochaine maintenance et échéance ;
- liaison d’une intervention à un site, un équipement et un contrat du même client.

### Documents, renouvellement et facturation des contrats

Dans **Ressources → Sites & équipements**, un responsable peut personnaliser les clauses du modèle de contrat de son entreprise, puis générer un PDF de projet contenant les coordonnées, le périmètre et les échéances. Le modèle fourni est un point de départ à compléter et à faire vérifier : il ne constitue pas un conseil juridique ni un contrat validé pour votre activité. Chaque PDF généré est conservé avec son empreinte SHA-256 et un instantané des informations utilisées.

La signature se fait en dehors de Depann’Home Pro. Après signature, importez le PDF signé pour l’archiver ; l’empreinte est conservée et un seul exemplaire signé peut être archivé par contrat. Cet archivage ne certifie pas la signature et n’active pas le contrat. Vérifiez le document et modifiez le statut manuellement après signature.

Un contrat actif ou arrivé à échéance peut être renouvelé manuellement : l’action crée un nouveau contrat en brouillon, sans modifier l’ancien ni le rendre actif. Les rappels de renouvellement existants restent des rappels internes ; ils ne reconduisent pas le contrat.

La fiche peut définir un montant, une périodicité et une première date de facturation. Lorsqu’une échéance est due, un responsable ayant accès à la facturation peut créer un brouillon de facture. Une contrainte d’unicité et un verrou transactionnel empêchent de créer deux brouillons pour la même échéance. Le brouillon reste modifiable dans **Devis & factures** ; son émission, son envoi et le contrôle de son taux de TVA restent manuels. Aucune facture n’est émise ou envoyée automatiquement.

## Stock, dépôts et véhicules

Créer d’abord les emplacements et articles, puis enregistrer les mouvements. Le stock disponible est la somme du journal immuable des mouvements. Une sortie ne peut pas rendre le stock négatif, sauf dérogation explicite d’un administrateur accompagnée d’un motif. Les consommations peuvent être affectées à une intervention.

L’écran **Stock** affiche les quantités par emplacement et signale les articles actifs dont le total est au seuil d’alerte ou en dessous. Le total inclut les emplacements inactifs, identifiés dans l’affichage. Les postes administratifs autorisés peuvent transférer un article entre deux emplacements actifs ; le transfert est atomique et vérifie la quantité disponible à la source. L’écran **Véhicules** affiche le stock embarqué. Les soldes tiennent compte de tous les mouvements, même si seuls les 200 derniers figurent dans l’historique.

## Rentabilité d’intervention

Le calcul versionné agrège :

- le chiffre d’affaires HT des factures et avoirs émis liés à l’intervention ;
- le temps des sessions technicien valorisé par le coût horaire du rôle ;
- les pièces consommées ;
- les achats explicitement affectés.

Configurer les coûts horaires chargés, puis affecter si nécessaire les achats à l’intervention depuis l’écran **Rentabilité**.

## Rappels internes du tableau de bord

Les responsables `admin`, `pc_standard` et `mobile_admin` des interfaces Standard et Groupe disposent du panneau **Rappels internes**. Il n’est pas accessible sur l’interface Partenaire ni pendant une prise en main Support. Sur PC, il se trouve à l’**Accueil** ; sur le poste Admin Mobile, ouvrir **Menu → Interventions → Rappels internes**. L’accueil mobile conserve son accès habituel au planning.

Aucune règle n’est créée automatiquement. Dans **Configurer les rappels**, activer les catégories souhaitées :

- **Maintenance à planifier** : prochaine visite des contrats actifs ;
- **Renouvellement de contrat** : date de fin des contrats actifs ;
- **Stock faible** : total de l’article actif au seuil ou en dessous.

Pour les contrats, régler un délai de 0 à 365 jours avant l’échéance. Les dates, ainsi que le statut du contrat, se modifient manuellement dans **Ressources → Sites & équipements**, après sélection du client. Pour le stock, définir le seuil de chaque article dans **Ressources → Stock** ; il s’applique au total de l’entreprise. Les règles peuvent être désactivées et réactivées. Chaque règle possède ses propres rappels : évitez de créer plusieurs règles identiques si elles ne sont pas souhaitées.

Utiliser **Rechercher maintenant** pour lancer une recherche sans attendre. Tant que le serveur fonctionne, les règles actives sont également recherchées environ toutes les quinze minutes. Les rappels sont internes : aucun e-mail n’est envoyé et aucune intervention n’est créée ou modifiée. Une connexion au serveur est nécessaire pour les consulter et les gérer.

Les boutons permettent de marquer un rappel **Traité**, de l’**Ignorer** ou de le rouvrir dans l’historique affiché. Une maintenance peut ouvrir le planning à la date concernée ; les liens vers les ressources sont disponibles lorsque le poste y a accès. Les informations du rappel sont un instantané : vérifiez la ressource avant d’agir. Désactiver une règle, changer une date ou réapprovisionner un article ne ferme pas les rappels existants. Pour les règles de stock créées depuis ce panneau, un rappel ouvert empêche les répétitions ouvertes pour cet article et cette règle ; après traitement, il peut revenir le jour suivant si le stock reste faible.

L’écran affiche au maximum 300 rappels, en donnant la priorité à ceux qui sont ouverts ; ce n’est pas un historique exhaustif. Les règles préexistantes de relance de devis sont conservées et peuvent continuer à être exécutées par l’ordonnanceur et l’ancienne API. Elles ne sont ni affichées ni exécutées par la recherche manuelle de ce panneau.

## Sécurité et exploitation

Toutes les données métier sont filtrées par `owner_id`. Les ressources liées sont vérifiées contre le même client et la même entreprise. Les migrations `0038_all_in_one_business_suite.sql`, `0042_maintenance_contract_lifecycle.sql` et `0044_customer_portal_document_snapshots.sql` sont appliquées par le mécanisme habituel ; le schéma canonique est synchronisé dans `database/schema.sql`.
