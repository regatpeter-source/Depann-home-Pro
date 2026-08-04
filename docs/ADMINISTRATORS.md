# Administrateurs (PC) d’une entreprise

## Principe

Une entreprise peut disposer de plusieurs comptes **Administrateur (PC)**. Tous utilisent le rôle applicatif `admin` et ont exactement les mêmes droits métier et d’administration dans leur entreprise : paramètres, accès, partenaires, facturation électronique & PDP et outils réservés à l’administration.

Il n’existe pas de rôle d’« administrateur principal » ni d’administrateur secondaire dans l’interface ou dans les autorisations. Le premier enregistrement utilisateur de l’entreprise reste une ancre technique de tenancy (`account_owner_id`) pour préserver l’architecture historique et l’isolation des données ; cette ancre ne confère aucun droit supplémentaire à son titulaire.

Le compte Créateur est distinct : sa capacité provient uniquement de `CREATOR_USERNAMES` et reste protégée par `requireCreator`. Un administrateur d’entreprise ne peut pas accéder aux routes ni à la console Créateur.

Le même compte peut également être utilisé sur un smartphone comme Administrateur Mobile opérationnel. Son appareil mobile suit alors le circuit normal d’autorisation des appareils administrateurs. La console Créateur et toutes ses routes restent toutefois strictement réservées à un appareil déclaré **poste PC** : elles sont absentes de l’interface mobile et refusées côté serveur.

Chaque compte Administrateur (PC), y compris le compte Créateur, peut se connecter depuis n’importe quel ordinateur, puis revenir sur son PC initial. Une seule session PC est conservée par compte : après chaque authentification réussie, le serveur attribue une nouvelle session PC et révoque immédiatement toutes les précédentes, y compris celles qui utiliseraient le même identifiant d’appareil. Le smartphone Administrateur Mobile reste indépendant de cette règle.

## Profils créables par un Administrateur (PC)

| Profil | Rôle | Administration de l’entreprise |
| --- | --- | --- |
| Administrateur (PC) | `admin` | Oui, droits complets et égaux |
| Poste PC standard | `pc_standard` | Non |
| Administrateur Mobile | `mobile_admin` | Non |
| Technicien référent / Chef d’équipe | `team_lead` | Non |
| Technicien | `technician` | Non |

Les Administrateurs (PC) sont les seuls à pouvoir créer ou promouvoir un Administrateur (PC). Les autres rôles ne peuvent pas appeler les routes de création, suppression, activation, désactivation ou changement de rôle des membres.

Les Administrateurs (PC) peuvent donc remplacer leur poste actif après leur authentification habituelle (mot de passe et 2FA d’entreprise si elle est activée), sans validation manuelle du nouvel ordinateur. Les mécanismes de validation d’appareil et de code e-mail restent inchangés pour les autres profils concernés. Les postes PC administrateur et standard sont comptabilisés dans le quota de postes PC de l’entreprise ; les chefs d’équipe comptent dans le quota technique.

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
