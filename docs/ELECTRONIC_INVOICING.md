# Architecture multi-plateformes de facturation électronique

Depann’Home Pro n’est ni une plateforme agréée, ni une PDP, ni une plateforme certifiée de transmission. Chaque entreprise choisit son prestataire, souscrit directement auprès de lui et possède sa connexion.

## Isolation et stockage

`depannhome_einvoice_connections` contient des connexions versionnées et strictement rattachées à `owner_id`. Une seule connexion peut être active par entreprise. Les credentials sont chiffrés en AES-256-GCM avec `SESSION_SECRET` et ne sont jamais renvoyés au navigateur. Aucun secret global de facturation électronique n’existe.

La déconnexion efface les credentials actifs mais ne supprime ni la connexion historique, ni les transmissions, ni les événements d’audit. Changer de plateforme conserve donc les références et statuts précédents.

Les anciennes configurations du transport UBL universel sont migrées vers `legacy_ubl_api`, désactivées et marquées `action_required`. Le secret chiffré est préservé pendant la migration, mais cette configuration ne peut plus transmettre : son protocole n’était pas celui d’une API fournisseur documentée.

## Adaptateurs

Chaque intégration étend `ElectronicInvoicingProvider` et implémente les opérations réellement documentées par son fournisseur :

- `connect` et `disconnect` ;
- `testConnection` ;
- `sendInvoice` et `sendCreditNote` ;
- `getTransmissionStatus` ;
- `refreshAuthentication` ;
- `getAccountInformation` ;
- `verifyWebhook` lorsque le fournisseur propose des notifications signées.

Le registre ne rend connectables que les adaptateurs effectivement enregistrés. Il n’existe plus de formulaire universel URL/clé API et aucun protocole fournisseur n’est deviné. En l’absence d’adaptateur documenté, l’interface indique : « Cette plateforme n'est pas encore intégrée à Depan’Home Pro. »

## Routes et webhooks

Les routes administratives sont sous `/api/accounting/e-invoicing`. Le serveur déduit toujours l’entreprise avec `getAccountOwnerId(request)` et filtre chaque connexion, document et transmission avec cet identifiant.

Un webhook public ne reçoit jamais de `owner_id` utilisable. Il résout la connexion par le code plateforme et le hachage SHA-256 d’un jeton opaque, puis l’adaptateur vérifie la notification fournisseur. La transmission est retrouvée avec le triplet de confiance `owner_id` résolu, `platform_code` et référence externe.

## Périmètres indépendants

La production des factures/avoirs et de leurs archives UBL/PDF reste indépendante du transport. Le grand livre, les exports comptables et la préparation FEC ne dépendent d’aucune connexion de facturation électronique.

## État des intégrations

Aucune API officielle de plateforme n’est documentée dans ce dépôt à ce jour. Par conséquent, aucun fournisseur n’est présenté comme connecté ou opérationnel. Un adaptateur ne doit être ajouté qu’avec la documentation officielle, les credentials propres à l’entreprise et des tests réels adaptés au contrat fournisseur.