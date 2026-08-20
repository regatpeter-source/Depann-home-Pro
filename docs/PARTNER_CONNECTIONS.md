# Connexions partenaires simplifiées

Le module `server/partner-connections.js` permet à deux entreprises déjà inscrites sur Depann'Home Pro de se connecter sans configurer une intégration informatique.

## Réseau professionnel Depann'Home Pro

Chaque compte entreprise est automatiquement enregistré dans le registre interne `depannhome_partner_directory` par un déclencheur PostgreSQL. Cette inscription ne publie aucune fiche : la visibilité est désactivée par défaut, y compris lors de la migration des fiches historiques qui n’avaient pas encore confirmé leur choix.

Dans **Paramètres → Réseau Depann'Home Pro**, l’administrateur contrôle la visibilité et les seuls éléments publiables : description, métiers, marques, spécialités, zone/rayon/départements, horaires, site, acceptation des missions, et éventuellement téléphone ou e-mail professionnel. Les coordonnées légales, le nom et le logo sont lus directement depuis le profil de facturation ; toute mise à jour y est donc immédiatement reflétée sans double saisie. Les informations bancaires, identifiants, utilisateurs, clients, documents et données d’intervention ne sont jamais projetés dans l’annuaire.

Les coordonnées géographiques sont facultatives. Si elles sont renseignées par l’entreprise et que le demandeur autorise sa position, une recherche par rayon kilométrique peut être évaluée localement par le serveur. Sans coordonnées, les recherches par nom, métier, marque, département, commune, code postal et spécialité restent disponibles.

Le compte Créateur dispose du registre complet, de statistiques globales, et peut corriger une fiche, la suspendre ou la retirer du réseau. Retirer une fiche ne supprime ni le compte entreprise ni les connexions déjà établies.

## Parcours utilisateur

Dans **Paramètres → Réseau Depann'Home Pro**, l’onglet **Annuaire Depann'Home Pro** permet de rendre son entreprise trouvable, chercher une entreprise par nom, SIREN, SIRET ou ville, puis choisir **Demander la connexion**. L’entreprise destinataire reçoit une notification persistante et accepte ou refuse la demande avec les droits qu’elle accorde. Après acceptation, elle apparaît automatiquement dans l’onglet **Mes partenaires**.

L’onglet **Mes partenaires** regroupe aussi les accès API externes : création, modification, activation, suppression lorsqu’aucune mission n’est attachée, renouvellement de clé et contrôle de préparation de l’endpoint. Les clés restent affichées uniquement lors de leur création ou renouvellement. Les partenaires Depann'Home Pro ne nécessitent aucun paramétrage technique.

Le **Portail Partenaire gratuit** accède uniquement au Réseau Depann’Home Pro : annuaire, recherche, demandes et connexions entre entreprises utilisatrices. Il ne charge ni n’affiche les partenaires officiels, les accès API, les connecteurs externes ou le sandbox associé. Ces intégrations sont réservées aux donneurs d’ordre, par exemple les assurances et plateformes externes, et sont également refusées par les routes serveur.

## Droits et synchronisation

Chaque côté de la relation gère ses propres droits : envoi/réception d’interventions, consultation des rapports, devis et factures, messagerie et statuts. La relation peut être modifiée ou interrompue à tout moment.

Lorsqu’un rendez-vous d’intervention est créé ou modifié, Depann'Home Pro le transmet automatiquement au partenaire si les droits des deux entreprises le permettent. Le destinataire le reçoit comme une mission partenaire normale, avec une traçabilité et un dialogue dédiés. Lorsqu’un rapport de fuite est validé, son PDF est partagé automatiquement dans ce dossier lorsque l’autorisation de rapport est active.

## Sécurité

La recherche est limitée aux entreprises actives ayant explicitement accepté d’être visibles et qui ne sont pas suspendues par le Créateur. Toutes les requêtes nécessitent une session d’administrateur et restent filtrées par `owner_id`. Les demandes, décisions, droits et synchronisations sont persistés dans des tables propres au module ; les routes API techniques et les connecteurs existants ne sont pas modifiés.