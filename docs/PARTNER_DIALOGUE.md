# Dialogue collaboratif partenaire

Chaque mission reçue dispose d’un fil privé, persistant et chronologique. Le module `server/partner-dialogue.js` est distinct de `server/messages.js`, qui reste réservé aux notes internes associées aux dossiers clients.

## Participants et accès

- Les administrateurs voient tous les fils de leur entreprise.
- Un technicien ne voit et ne publie que dans les missions qui lui sont affectées.
- L’organisme partenaire accède uniquement aux missions créées par **son propre accès d’intégration**, avec la même clé fournie lors de la création de l’accès (`X-API-Key`). Il n’obtient ni cookie Depann'Home Pro ni accès au flux SSE interne.
- Les experts ou gestionnaires d’un organisme utilisent l’accès API de cet organisme et sont identifiés dans le message avec `authorName`. Leur organisation reste strictement limitée aux missions de cet accès partenaire.

Toutes les requêtes vérifient simultanément la clé, l’accès partenaire, le dossier et l’entreprise propriétaire. Les réponses d’autorisation ne révèlent pas l’existence d’un dossier inaccessible.

## Confidentialité et partage sélectif

Chaque contenu de mission est **interne par défaut**. Le registre `depannhome_partner_mission_items` référence les devis, factures, rapports et photos sans dupliquer leurs données métier ; seul un élément dont `partner_visible` est activé apparaît dans l’espace externe, son historique et son téléchargement protégé. Le retrait de cette visibilité masque immédiatement l’élément et l’entrée de journal correspondante pour le partenaire.

Les messages conservent leur contrôle de partage existant. Les pièces jointes (PDF et photos) possèdent également leur propre visibilité : elles restent privées même si le message parent est partagé, jusqu’à ce qu’un utilisateur les rende explicitement visibles. Un fichier ne peut pas être partagé depuis un message interne : il faut d’abord partager le message ou créer un message dédié, pour ne jamais révéler de commentaire interne.

Chaque mission porte `billing_mode` :

- `direct_client` : la prestation est facturée au client final ; les devis, factures, paiements et informations comptables restent privés et le serveur refuse leur partage partenaire.
- `principal` : la facturation est destinée à l’entreprise donneuse d’ordre ; les devis et factures associés sont enregistrés comme contenus partagés et ajoutés automatiquement au journal. Revenir au mode `direct_client` révoque immédiatement ce partage.

Les rapports et leurs photos restent internes jusqu’à leur partage volontaire. Un rapport partagé doit être validé afin que le partenaire reçoive uniquement son PDF final.

## Accès selon le poste

Le **Réseau Depann'Home Pro** (annuaire, recherche d’entreprise, demandes de partenariat, connexions, droits de synchronisation, partenaires officiels et accès API) est réservé aux postes PC `admin` et `pc_standard` (Secrétariat). Ces rôles peuvent consulter, créer, accepter, refuser et administrer les connexions entre entreprises.

Les rôles `technician` et `team_lead` ne voient jamais l’annuaire, les recherches, les paramètres réseau ou les actions de gestion de partenaires. Ils accèdent uniquement à leurs missions partenaires affectées (`assigned_technician_id`), à leur dialogue, ainsi qu’aux rapports, photos et documents rattachés aux interventions auxquelles ils sont affectés. Les filtres sont appliqués par les API SQL ; masquer les entrées dans l’interface n’est donc pas le seul contrôle de sécurité.

## API partenaire

Les routes externes exigent l’en-tête `X-API-Key` :

- `GET /api/partner-dialogue/external/missions/:externalMissionId` : résumé, messages et documents liés ;
- `POST /api/partner-dialogue/external/missions/:externalMissionId/messages` : nouveau message ou difficulté ;
- `GET /api/partner-dialogue/external/missions/:externalMissionId/attachments/:attachmentId` : téléchargement d’une pièce jointe du fil.

Le corps d’un message peut contenir `authorName`, `body`, `kind` (`message` ou `issue`), `issueType`, `replyToId` et jusqu’à cinq pièces jointes encodées en data URL. Seuls JPEG, PNG, WebP et PDF sont acceptés, dans la limite de 5 Mo par fichier.

## Événements et notifications

La réception, l’acceptation et les changements de statut de mission ajoutent automatiquement une entrée système : planification, affectation, arrivée sur site, rapport, devis, facture et clôture sont ainsi conservés dans le même historique.

Un message, une pièce jointe, une difficulté ou une mise à jour notifie les administrateurs et le technicien affecté dans le centre de notifications persistant, disponible sur PC et mobile. Le partenaire reçoit un événement dans la boîte d’envoi déjà utilisée par la mission ; il est transmis au callback HTTPS configuré et reste relançable depuis l’interface.

À l’état `closed`, les APIs interne et partenaire refusent les nouveaux messages tout en conservant l’historique en lecture seule. Les pièces jointes sont stockées dans une table dédiée au fil et ne consomment pas les limites de documents du dossier client.
