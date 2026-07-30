# Missions partenaires

Le module `server/partner-missions.js` reçoit et suit les demandes d'intervention partenaires sans modifier le runtime sortant de `server/connectors.js`. Les deux systèmes sont indépendants : un connecteur déclaratif peut continuer à servir aux appels sortants, tandis qu'un accès de réception possède sa propre clé, ses journaux et sa boîte d'envoi.

## Créer un accès partenaire

Un administrateur ouvre **Missions partenaires**, puis crée un accès. L'application fournit :

- un endpoint `POST /api/partner-intake/<partnerKey>` ;
- une clé API affichée une seule fois ;
- une URL HTTPS facultative de callback pour les retours de statut ;
- un mode d'affectation par défaut : manuel, suggéré ou automatique.

Transmettez la clé au partenaire exclusivement via un canal sûr. Seul son hash SHA-256 est conservé en base. Une clé peut être renouvelée depuis l'API administrateur. Le partenaire envoie cette clé dans `X-API-Key`.

## Contrat d'entrée et sécurité

L'endpoint est public mais limité à 120 requêtes par quinze minutes. Il accepte un objet JSON limité à 500 ko. La mission doit inclure un identifiant stable dans `missionNumber`, `missionId`, `id` ou `reference`.

Les principaux champs normalisés sont :

- client : `client.name`, `client.phone`, `client.email` ;
- intervention : `address`, `scheduledDate`, `startTime`, `endTime`, `interventionType`, `description`, `comments` ;
- dossier : `partnerReference`, `claimNumber`, `insurance`, `expert`, `manager` ;
- priorité : `priority` ou `urgency` ;
- position : `gps.latitude`, `gps.longitude` ;
- documents : `attachments` contenant seulement des data URLs JPEG, PNG, WebP ou PDF.

Toute réception est liée à l'entreprise définie par la clé partenaire. La contrainte `(owner_id, intake_id, external_mission_id)` rend l'ingestion idempotente : une nouvelle livraison de la même mission met à jour son contenu au lieu de créer un doublon.

## Traitement métier

Une mission arrive à l'état `pending_validation`. Lorsqu'un administrateur l'accepte, une transaction :

1. rapproche ou crée le client par e-mail, téléphone ou nom ;
2. ajoute une trace d'activité au dossier ;
3. crée ou actualise l'intervention calendrier ;
4. affecte le technicien choisi ou, pour un accès explicitement configuré en automatique, le technicien ayant la charge planifiée la plus basse ;
5. crée un brouillon de rapport de recherche de fuite quand le type d'intervention contient « fuite », « infiltration » ou « étanchéité » ;
6. écrit l'historique et place le retour d'acceptation dans la boîte d'envoi.

Les administrateurs reçoivent une notification persistante à chaque réception/modification. Le technicien affecté reçoit également une notification. Les techniciens ne voient que les missions qui leur sont attribuées et ne peuvent mettre à jour que les statuts terrain : `en_route`, `on_site`, `report_in_progress`, `report_completed`, `work_completed`.

## Retours partenaires et reprise

Les changements importants ajoutent une ligne dans `depannhome_partner_mission_outbox`. **Relancer les retours** transmet les callbacks HTTPS en attente. Un échec est conservé avec son erreur et une date de nouvelle tentative exponentielle ; après cinq essais il reste visible comme échec pour une reprise manuelle. Aucune URL de retour ne provoque de perte de mission : l'événement est marqué comme ignoré avec le motif conservé.

Les tables `depannhome_partner_mission_history` et `depannhome_partner_mission_outbox` assurent l'audit durable des traitements et des échanges, y compris après une reconnexion ou un redémarrage de l'application.
