# Connexions partenaires simplifiées

Le module `server/partner-connections.js` permet à deux entreprises déjà inscrites sur Depann’Home Pro de se connecter sans configurer une intégration informatique.

## Parcours utilisateur

Dans **Paramètres → Partenaires**, un administrateur peut rendre son entreprise trouvable, chercher une entreprise par nom, SIREN, SIRET ou ville, puis choisir **Demander la connexion**. L’entreprise destinataire reçoit une notification persistante et accepte ou refuse la demande avec les droits qu’elle accorde.

L’écran n’affiche jamais de clé API, URL, webhook, identifiant d’intégration ni certificat. Les valeurs éventuellement nécessaires à la compatibilité avec les modules historiques restent générées et conservées par le serveur.

## Droits et synchronisation

Chaque côté de la relation gère ses propres droits : envoi/réception d’interventions, consultation des rapports, devis et factures, messagerie et statuts. La relation peut être modifiée ou interrompue à tout moment.

Lorsqu’un rendez-vous d’intervention est créé ou modifié, Depann’Home Pro le transmet automatiquement au partenaire si les droits des deux entreprises le permettent. Le destinataire le reçoit comme une mission partenaire normale, avec une traçabilité et un dialogue dédiés. Lorsqu’un rapport de fuite est validé, son PDF est partagé automatiquement dans ce dossier lorsque l’autorisation de rapport est active.

## Sécurité

La recherche est limitée aux entreprises actives ayant accepté d’être visibles. Toutes les requêtes nécessitent une session d’administrateur et restent filtrées par `owner_id`. Les demandes, décisions, droits et synchronisations sont persistés dans des tables propres au module ; les routes API techniques et les connecteurs existants ne sont pas modifiés.