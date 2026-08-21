# Connexion réelle à une plateforme de facturation électronique

## Choix par entreprise

Chaque entreprise configure sa propre connexion dans **Comptabilité → Paramètres → Plateforme choisie par cette entreprise** :

- nom de la plateforme agréée ou de l’opérateur contractuel ;
- URL HTTPS réelle de dépôt des factures UBL ;
- identifiant attribué à l’entreprise par cette plateforme ;
- clé API propre à l’entreprise, chiffrée en base ;
- activation explicite des transmissions.

Les réglages sont stockés par `owner_id`. Une entreprise ne peut ni consulter ni utiliser la connexion d’une autre entreprise. Aucun fournisseur fictif, environnement de simulation ou succès artificiel n’est disponible dans le module comptable.

## Contrat HTTP utilisé

Pour chaque facture ou avoir définitivement émis, Depann'Home Pro envoie une requête `POST` dont le corps est l’archive UBL XML immuable. La requête contient :

- `Content-Type: application/xml; charset=utf-8` ;
- `Authorization: Bearer <clé API>` ;
- `X-Company-Identifier` avec l’identifiant contractuel ;
- `X-Document-Number` avec le numéro légal de facture ;
- `X-Document-SHA256` et `Idempotency-Key` avec l’empreinte de l’UBL.

Une réponse JSON peut fournir `transmissionId` ou `id`, `status` et `message`. Sans statut reconnu, une réponse HTTP `202` est journalisée comme « en attente » et une autre réponse `2xx` comme « envoyée ». Toute réponse non `2xx`, erreur réseau ou expiration après 20 secondes est enregistrée comme un échec réel.

## Sécurité et compatibilité

Seules les URL HTTPS publiques sont acceptées. Les hôtes locaux, adresses privées, identifiants intégrés à l’URL et redirections sont refusés. La clé API n’est jamais renvoyée au navigateur.

Ce transport fonctionne avec une plateforme qui accepte directement ce contrat UBL avec authentification Bearer. Si la plateforme choisie impose OAuth 2, une enveloppe JSON, des pièces jointes Factur-X, une signature particulière, des callbacks ou un protocole différent, un adaptateur dédié à son API doit être développé avant activation. Le raccordement doit aussi couvrir, selon le contrat fournisseur, la réception, les statuts réglementaires et l’e-reporting.