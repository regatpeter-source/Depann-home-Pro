# Centre d’assistance Créateur

## Objectif

Le Centre d’assistance permet au Créateur d’aider une entreprise bloquée sans connaître son mot de passe et sans se connecter à sa place. Il sépare strictement :

- le diagnostic en lecture seule ;
- les réparations explicites ;
- l’accès d’urgence (« break-glass »).

Aucun mot de passe, secret TOTP, code de vérification, jeton OAuth, clé API, IBAN ou contenu métier privé n’est renvoyé par ces API.

## Ouvrir une session

Depuis **Console Créateur > Assistance entreprises** :

1. sélectionner l’entreprise ;
2. décrire le problème ;
3. saisir la référence d’une demande Support, ou confirmer que l’entreprise a donné son accord ;
4. ouvrir la session.

Une session normale dure 30 minutes. Une session d’urgence dure 10 minutes, demande une justification plus détaillée et doit être réservée au blocage total. Les administrateurs actifs de l’entreprise sont immédiatement notifiés de l’ouverture et de la fermeture.

La session n’altère jamais `request.user` et ne donne pas accès aux routes métier de l’entreprise. Le Créateur reste identifié comme Créateur pendant toute l’intervention.

## Diagnostic disponible

La vue affiche uniquement les informations nécessaires au dépannage :

- état actif/archivé et abonnement de l’entreprise ;
- membres, rôles, activation et nombre d’authentificateurs actifs ;
- appareils, état d’approbation et dernière activité ;
- politique 2FA ;
- verrous collaboratifs actifs ;
- événements de sécurité, gestion des membres et cycle de vie récents ;
- demandes Support et réparations précédentes.

## Réparations autorisées

Chaque réparation exige un motif d’au moins 10 caractères, une confirmation, une session encore valide et produit un snapshot avant/après dans `depannhome_creator_recovery_actions` :

- restaurer une entreprise archivée ;
- réactiver une entreprise suspendue ;
- réactiver un Poste Admin dans la limite des postes souscrits ;
- réinitialiser la 2FA d’un Poste Admin, invalider sa session PC et révoquer ses appareils mobiles ;
- révoquer toutes les sessions de l’entreprise, tout en conservant l’approbation des postes PC administrateurs afin qu’ils puissent se réauthentifier ;
- révoquer un appareil précis ;
- libérer tous les verrous collaboratifs de l’entreprise.

L’approbation d’un appareil n’est volontairement pas disponible : elle reste une décision de l’entreprise et continue de suivre le circuit normal de vérification.

## Audit et contrôle

- `depannhome_creator_support_sessions` conserve le Créateur, l’entreprise, le motif, la base de consentement, le mode, l’expiration et la clôture.
- `depannhome_creator_recovery_actions` conserve l’action, la cible, le motif, le résultat, les états avant/après et l’indicateur d’urgence.
- Les actions touchant un administrateur alimentent aussi `depannhome_member_audit`.
- Les restaurations alimentent aussi `depannhome_account_lifecycle_audit`.
- Toute réparation terminée est notifiée aux Postes Admin actifs.

En cas d’erreur, l’opération métier est annulée transactionnellement et une tentative en échec est enregistrée sans détail sensible.
