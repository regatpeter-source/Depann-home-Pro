# Mode Groupe / Multi-entreprises

Le mode Groupe est **optionnel**. Une entreprise qui ne l’active pas continue d’utiliser exactement son périmètre historique : son `account_owner_id` reste son contexte métier, sans table de données partagée ni changement de droits.

## Cloisonnement

Une société d’un groupe est un compte entreprise existant ou nouvellement créé. Le groupe ne déplace ni ne fusionne les clients, interventions, calendriers, utilisateurs, documents, factures, achats, partenaires, exports ou statistiques détaillées.

Les tables `depannhome_group_companies` associent les propriétaires de compte indépendants à un groupe. Pour un Administrateur Groupe, le serveur valide à chaque requête la société active, son appartenance au groupe, l’activité du groupe et l’autorisation de l’administrateur. `getAccountOwnerId(request)` renvoie alors exclusivement cette société active. Les endpoints métier existants conservent ainsi leurs filtres `owner_id` usuels.

Les comptes administrateurs, techniciens, comptables et utilisateurs qui ne figurent pas dans `depannhome_group_administrators` ne peuvent pas sélectionner une autre entreprise ni utiliser les routes Groupe.

## Administrateur Groupe

L’activation ajoute l’Administrateur (PC) qui active le groupe à `depannhome_group_administrators`. Son rôle applicatif reste `admin` : ce choix préserve les règles existantes de validation d’appareils, de postes PC et de gestion d’équipe. Le privilège de groupe est une capacité distincte, déterminée côté serveur par la table d’appartenance.

Un Administrateur Groupe peut :

- créer, renommer, activer et désactiver des sociétés du groupe ;
- désactiver le mode Groupe et dissoudre ses liaisons multi-entreprises ;
- sélectionner une société active sans déconnexion ;
- consulter des indicateurs agrégés et par société, filtrés par période ;
- consulter les 100 dernières actions Groupe.

Le changement de société émet un nouveau cookie de session HTTP-only, puis l’interface se recharge afin d’éliminer les données en mémoire de la société précédente.

## Annuler le mode Groupe

Depuis **Groupe & entreprises**, l’Administrateur Groupe peut choisir **Désactiver le mode Groupe**. L’action est confirmée deux fois, puis elle supprime le groupe, ses membres administrateurs et ses liaisons de sociétés.

Elle ne supprime aucune entreprise ni aucune donnée métier : chaque société conserve ses utilisateurs, clients, planning, documents, devis, factures et paramètres, et redevient simplement indépendante. La session de l’administrateur est automatiquement replacée sur son entreprise d’origine.

## Audit et évolutions futures

Les activations, créations, modifications, changements d’état et bascules de société sont stockés dans `depannhome_group_audit` avec l’auteur, la société concernée, l’adresse IP et l’horodatage.

Le champ `shared_partner_directory_enabled` prépare un annuaire partenaire commun, mais aucune donnée partenaire n’est partagée aujourd’hui. Le même modèle pourra accueillir plus tard le partage contrôlé de techniciens, catalogues, bibliothèques, documents, planning consolidé, achats Groupe et permissions avancées, sans affaiblir le filtre par entreprise active.
