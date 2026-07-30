# Collaboration et verrouillage intelligent

## Objectif et périmètre

Le module `server/collaboration.js` est un socle commun aux ressources collaboratives de Depann'Home Pro. Il est actuellement intégré aux rapports techniques, avec les types prévus `technical_report`, `billing_document`, `client` et `calendar_event`.

Il ne réalise pas de coédition caractère par caractère. Un utilisateur ouvre un rapport en modification, obtient un verrou exclusif et les autres utilisateurs consultent la même ressource en lecture seule.

## Verrous

Les verrous sont conservés dans PostgreSQL dans `depannhome_collaboration_locks` : ils survivent donc à un redémarrage applicatif et ne dépendent pas de la mémoire du processus.

- Acquisition : `POST /api/collaboration/locks/:entityType/:entityId/acquire`
- Pulsation d’activité : toutes les 30 secondes depuis l’éditeur.
- Expiration automatique : 15 minutes sans activité.
- Libération : fermeture de l’éditeur, déconnexion, fermeture de page (best effort avec `sendBeacon`) ou expiration.
- Reprise forcée : réservée au rôle `admin`, après confirmation dans l’interface.

Chaque écriture d’un rapport vérifie que l’auteur détient encore ce verrou. Ainsi, un ancien écran ou une requête concurrente ne peut pas contourner la lecture seule affichée dans le navigateur.

## Temps réel et notifications

Le navigateur ouvre un flux Server-Sent Events authentifié sur `/api/collaboration/stream`. Il reçoit immédiatement les événements de verrouillage, sauvegarde, photo, statut, correction, validation et remise en brouillon. Les notifications importantes sont aussi stockées dans `depannhome_collaboration_notifications` et restent disponibles après une déconnexion.

SSE ne sert pas de source de vérité : PostgreSQL reste la référence. En cas de coupure réseau, le témoin devient ambre/rouge, le navigateur se reconnecte automatiquement, et les verrouillages expirent sans activité.

Le flux SSE est diffusé par l’instance Node courante. Pour un déploiement horizontal multi-instances, remplacer la diffusion mémoire par PostgreSQL `LISTEN/NOTIFY`, Redis Pub/Sub ou un service de diffusion géré. Les verrous, l’audit et les notifications n’exigent aucun changement pour cette évolution.

## Audit

`depannhome_collaboration_audit` enregistre les ouvertures de verrou, fermetures, reprises forcées, sauvegardes, photos et changements de statut. Chaque entrée comprend l’utilisateur, son rôle, l’horodatage, l’adresse IP fournie par Express (`trust proxy` activé), le type d’appareil et son identifiant navigateur.
