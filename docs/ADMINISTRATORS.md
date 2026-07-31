# Administrateurs (PC) d’une entreprise

## Principe

Une entreprise peut disposer de plusieurs comptes **Administrateur (PC)**. Tous utilisent le rôle applicatif `admin` et ont exactement les mêmes droits métier et d’administration dans leur entreprise : paramètres, accès, partenaires, facturation électronique et outils réservés à l’administration.

Il n’existe pas de rôle d’« administrateur principal » ni d’administrateur secondaire dans l’interface ou dans les autorisations. Le premier enregistrement utilisateur de l’entreprise reste une ancre technique de tenancy (`account_owner_id`) pour préserver l’architecture historique et l’isolation des données ; cette ancre ne confère aucun droit supplémentaire à son titulaire.

Le compte Créateur est distinct : sa capacité provient uniquement de `CREATOR_USERNAMES` et reste protégée par `requireCreator`. Un administrateur d’entreprise ne peut pas accéder aux routes ni à la console Créateur.

## Profils créables par un Administrateur (PC)

| Profil | Rôle | Administration de l’entreprise |
| --- | --- | --- |
| Administrateur (PC) | `admin` | Oui, droits complets et égaux |
| Poste PC standard | `pc_standard` | Non |
| Administrateur Mobile | `mobile_admin` | Non |
| Technicien référent / Chef d’équipe | `team_lead` | Non |
| Technicien | `technician` | Non |

Les Administrateurs (PC) sont les seuls à pouvoir créer ou promouvoir un Administrateur (PC). Les autres rôles ne peuvent pas appeler les routes de création, suppression, activation, désactivation ou changement de rôle des membres.

Les mécanismes actuels de première connexion sont conservés : validation de l’appareil, activation par l’administrateur et code e-mail quand le flux concerné l’exige. Les postes PC administrateur et standard sont comptabilisés dans le quota de postes PC de l’entreprise ; les chefs d’équipe comptent dans le quota technique.

## Continuité administrative

Le serveur garantit qu’au moins un Administrateur (PC) actif reste présent dans chaque entreprise. La désactivation, suppression ou rétrogradation d’un administrateur est refusée si elle retirerait le dernier administrateur actif.

L’ancre technique de l’entreprise ne peut pas être supprimée isolément car elle porte les clés de rattachement des données existantes. Cela ne crée pas de hiérarchie de droits : les autres administrateurs peuvent réaliser les mêmes opérations de gestion. La suppression complète de cette ancre reste la suppression de l’entreprise, action réservée au Créateur.

## Journal de sécurité

`depannhome_member_audit` conserve les opérations de gestion des accès, y compris après suppression d’un membre :

- création d’un administrateur ou d’un autre membre ;
- activation et désactivation d’un administrateur ;
- changement de rôle ;
- suppression d’un administrateur ou d’un autre membre.

Chaque ligne contient l’entreprise concernée, l’auteur, la cible (identifiant et nom conservés), l’action, les détails utiles et l’horodatage. Les lectures et écritures sont filtrées par `owner_id`.
