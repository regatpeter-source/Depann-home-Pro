# Dialogue collaboratif partenaire

Chaque mission reçue dispose d’un fil privé, persistant et chronologique. Le module `server/partner-dialogue.js` est distinct de `server/messages.js`, qui reste réservé aux notes internes associées aux dossiers clients.

## Participants et accès

- Les administrateurs voient tous les fils de leur entreprise.
- Un technicien ne voit et ne publie que dans les missions qui lui sont affectées.
- L’organisme partenaire accède uniquement aux missions créées par **son propre accès d’intégration**, avec la même clé fournie lors de la création de l’accès (`X-API-Key`). Il n’obtient ni cookie Depann’Home ni accès au flux SSE interne.
- Les experts ou gestionnaires d’un organisme utilisent l’accès API de cet organisme et sont identifiés dans le message avec `authorName`. Leur organisation reste strictement limitée aux missions de cet accès partenaire.

Toutes les requêtes vérifient simultanément la clé, l’accès partenaire, le dossier et l’entreprise propriétaire. Les réponses d’autorisation ne révèlent pas l’existence d’un dossier inaccessible.

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
