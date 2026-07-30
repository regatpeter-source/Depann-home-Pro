# Rapports techniques

## Moteur générique

Le module `server/technical-reports.js` est un moteur de rapports rattachés à une intervention (`appointment_id`). Chaque rapport porte un `report_type`, un contenu structuré JSON et des médias propres : il peut donc accueillir de nouveaux modèles sans modifier les dossiers clients.

Le premier modèle est `leak_detection`, destiné aux recherches de fuite en plomberie, chauffage, PAC, CVC et réseaux hydrauliques. Il contient les sections couverture, état des lieux, installation, contrôle visuel, mesures initiales, méthodes de recherche, localisation, travaux, contrôle final, conclusion et signatures.

## Accès et cycle de vie

- Un rapport est toujours créé depuis une intervention de planning.
- Un technicien ne peut consulter ou créer que les rapports d’une intervention qui lui est affectée. Il peut modifier son rapport tant qu’il n’est pas validé.
- L’administration accède à l’ensemble des rapports de l’entreprise, peut demander une correction par section, valider ou remettre un document validé en brouillon.
- Le cycle est `draft`, `submitted`, `in_correction`, puis `validated`.
- La validation génère un PDF et verrouille le rapport. Le retour en brouillon enlève le PDF courant afin que toute nouvelle validation génère une version à jour.

## Synchronisation et photos

L’éditeur effectue un enregistrement immédiat, déclenché après une courte temporisation pendant la saisie. Les données sont ensuite visibles via les rafraîchissements partagés déjà présents dans l’application. Il ne s’agit pas d’un canal WebSocket/SSE : la collaboration est donc quasi temps réel lors des sauvegardes et des actualisations, pas une coédition caractère par caractère.

Les photos sont conservées dans le rapport, séparément des pièces jointes habituelles du dossier client. La limite actuelle est de 40 images de 4 Mo maximum par rapport. Les photos comportent une légende et une annotation textuelle. Le navigateur mobile peut ouvrir la caméra avec `capture="environment"`.

## Archivage

À la validation, le PDF est stocké dans PostgreSQL dans le rapport, puis ajouté au dossier client comme pièce jointe de type `Rapport fuite`, ainsi qu’à l’historique d’activité. Cet archivage est transactionnel : en cas d’échec d’ajout au dossier client, le rapport reste non validé.

Le stockage reste compatible avec les systèmes de fichiers éphémères, notamment Render. Les limites des pièces jointes client s’appliquent également au PDF d’archive ; les galeries restent dans le rapport afin de ne pas alourdir le JSONB client.
