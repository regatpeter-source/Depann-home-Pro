# Centre d’assistance Créateur

## Objectif

Le Centre d’assistance permet au Créateur d’aider une entreprise bloquée sans connaître son mot de passe et sans se connecter à sa place. Il sépare strictement :

- le diagnostic en lecture seule ;
- la prise en main sécurisée après consentement explicite ;
- les réparations explicites ;
- l’accès d’urgence (« break-glass »).

Aucun mot de passe, secret TOTP, code de vérification, jeton OAuth, clé API ou IBAN n’est renvoyé par les API de diagnostic. Les données métier ne deviennent accessibles qu’après le consentement distinct de prise en main et restent limitées aux modules autorisés.

## Ouvrir une session

Depuis **Console Créateur > Assistance entreprises** :

1. sélectionner l’entreprise ;
2. décrire le problème ;
3. saisir la référence d’une demande Support, ou confirmer que l’entreprise a donné son accord ;
4. ouvrir la session.

Une session normale dure 30 minutes. Une session d’urgence dure 10 minutes, demande une justification plus détaillée et doit être réservée au blocage total. Les administrateurs actifs de l’entreprise sont immédiatement notifiés de l’ouverture et de la fermeture.

La prise en main est une portée distincte que l’entreprise doit accepter explicitement. Le mode d’urgence ne donne jamais accès à la navigation déléguée. Le Créateur reste identifié comme Créateur pendant toute l’intervention.

## Prise en main sécurisée

Après acceptation, le Créateur peut entrer dans un contexte temporaire imposé par le serveur et naviguer dans l’entreprise sans connaître ni remplacer les identifiants d’un salarié. Un bandeau permanent indique l’entreprise, le motif, le temps restant et permet de quitter immédiatement.

La première version autorise la consultation des espaces métier et les corrections sur les clients, le planning et les rapports techniques. Elle bloque côté serveur les comptes et appareils, la 2FA, les Paramètres, le Groupe, les imports, les connecteurs et secrets OAuth, la boîte e-mail, la comptabilité, les abonnements ainsi que les autres écritures non explicitement autorisées.

Chaque requête API est enregistrée dans `depannhome_creator_support_activity` avec la session, le Créateur réel, l’entreprise, la méthode, le chemin, le résultat et l’heure, sans enregistrer le contenu métier ni les secrets. L’entreprise peut retirer l’accès depuis sa demande active ; la requête suivante replace automatiquement le Créateur dans son propre compte.

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
