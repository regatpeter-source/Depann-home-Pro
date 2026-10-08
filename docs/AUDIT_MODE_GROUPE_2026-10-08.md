# Audit du mode Groupe / Multi-entreprises — 8 octobre 2026

## Conclusion

Le mode Groupe est fonctionnel après correction d’un défaut critique de cycle de vie. L’audit confirme le cloisonnement des sociétés par `account_owner_id`, la facturation centralisée sur l’entreprise principale, les allocations de postes, les permissions de bascule, la consolidation, la traçabilité et la conservation des données lors d’un retrait ou d’une dissolution.

**Résultat final : conforme après correction.**

## Environnement

- Windows, Node.js 24.13.0, PostgreSQL.
- Schéma isolé : `audit_general_20261008`.
- Serveur local : `http://127.0.0.1:3108`.
- SMTP, SUPER PDP, OAuth et services partenaires neutralisés ou redirigés vers la boucle locale.
- Aucune donnée de production utilisée.

## Parcours réalisés

### Activation et enveloppe

- Activation réelle du mode Groupe depuis une entreprise Pro payante.
- Passage de l’interface Standard à Groupe et renouvellement de session.
- Attribution Créateur de 3 sociétés, 4 postes PC et 6 postes mobiles.
- Vérification de la facture globale portée uniquement par l’entreprise principale.
- Contrôle du détail de facturation par société et de la réserve non attribuée dans le moteur de facturation.

### Création et administration des sociétés

- Création de deux filiales juridiquement indépendantes.
- Transfert automatique des sièges inutilisés de la principale.
- Rejet d’un identifiant administrateur dupliqué (`409`).
- Rejet d’un mot de passe trop court (`400`).
- Rejet du dépassement du nombre de sociétés (`409`).
- Modification de la raison sociale, des coordonnées légales et des allocations.
- Rejet d’une allocation sous l’usage actif (`409`).
- Rejet d’une allocation supérieure à l’enveloppe (`409`).
- Désactivation/réactivation d’une filiale et refus de bascule vers une filiale inactive.

### Cloisonnement et bascule

- Bascule réelle entre principale et filiale avec émission d’un nouveau cookie puis rechargement complet.
- Fermeture des vues de l’ancienne société après bascule.
- Client créé dans la principale invisible dans la filiale.
- Copie volontaire du client vers une filiale : nouvelle fiche indépendante, sans fichiers ni historique source.
- Rejet de la copie en doublon (`409`).
- Rejet d’une société inconnue, inactive ou extérieure au groupe (`404`).

### Rôles et autorisations

- Administrateur Groupe : administration, dashboard, audit et bascule autorisés.
- Administrateur de filiale : bascule autorisée, administration Groupe, dashboard consolidé et audit refusés (`403`).
- Poste `pc_standard` sans délégation : contexte et bascule refusés (`403`).
- Même poste après autorisation « Entreprises du même groupe » : contexte et bascule autorisés, rôle métier conservé, dashboard Groupe toujours refusé (`403`).
- Restrictions des postes mobiles et conservation des droits Facturation/Comptabilité vérifiées par les gardes applicatifs et les tests automatisés.

### Dashboard, audit et facturation

- Facture métier de 120 € TTC créée dans la principale.
- Consolidation exacte : 1 facture, 120 € TTC, ventilation correcte par société.
- Filtres société et période vérifiés.
- Dates invalides ou inversées rejetées (`400`).
- Société non autorisée rejetée (`404`).
- Journal Groupe vérifié : activation, création, modification, réallocation, bascule, copie client, désactivation, réactivation et retrait.

### Retrait et dissolution

- Suppression d’une filiale : compte archivé, appareils rejetés, sessions effacées et sièges restitués.
- Entreprise principale non supprimable (`403`).
- Dissolution complète du Groupe : liens et enveloppe supprimés, interfaces restaurées en Standard.
- Sociétés, utilisateurs, clients et facture conservés après dissolution.
- Connexion autonome de la filiale encore possible avant nettoyage final.
- Toutes les filiales temporaires ont ensuite été archivées dans le schéma isolé.

## Défaut corrigé

### Désactivation possible de l’entreprise principale

**Gravité : critique.**

Lorsque l’Administrateur Groupe travaillait dans une filiale, un appel direct à `PATCH /api/groups/companies/:companyId` pouvait désactiver l’entreprise principale. L’interface ne proposait pas cette action, mais le serveur ne protégeait que l’entreprise active. Le compte porteur de l’abonnement devenait inactif et la session Groupe était invalidée.

Correction dans `server/groups.js` : refus serveur systématique (`403`) de désactiver l’allocation marquée `isPrincipal` tant que le Groupe existe. Une régression a été ajoutée dans `tests/group-seat-allocation.test.js`.

Validation réelle après redémarrage :

- appel de désactivation de la principale depuis une filiale ;
- réponse `403` ;
- message explicite ;
- principale et groupe toujours actifs.

## Validation automatisée

- Tests Groupe ciblés : **27/27 réussis**.
- Suite complète : **849/849 réussis**, 0 échec, 0 test ignoré.
- Diagnostics VS Code sur les fichiers modifiés : aucun problème.
- Contrôle de syntaxe inclus dans la suite et validation API réelle après redémarrage.

## Limites de l’audit

- Aucun e-mail réel n’a été envoyé : SMTP volontairement dirigé vers `127.0.0.1:9`.
- Aucun appel SUPER PDP ou OAuth externe n’a été réalisé.
- Les scénarios ont utilisé exclusivement le schéma PostgreSQL isolé d’audit.
