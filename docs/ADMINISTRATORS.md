# Postes Admin d’une entreprise

## Principe

Une entreprise peut disposer de plusieurs **Postes Admin**. Tous utilisent le rôle applicatif `admin` et ont exactement les mêmes droits métier et d’administration dans leur entreprise : paramètres, accès, partenaires, facturation électronique & PDP et outils réservés à l’administration.

La Console Créateur dispose d’une boîte **Notifications** persistante avec compteur. Elle agrège les demandes d’offre ou de postes et les messages Support provenant des entreprises internes, ainsi que les demandes de partenariat provenant d’organisations externes. Chaque notification ouvre directement le panneau de traitement correspondant et reste comptabilisée tant que son suivi est nouveau ou en cours d’étude.

Il n’existe pas de rôle d’« administrateur principal » ni d’administrateur secondaire dans l’interface ou dans les autorisations. Le premier enregistrement utilisateur de l’entreprise reste une ancre technique de tenancy (`account_owner_id`) pour préserver l’architecture historique et l’isolation des données ; cette ancre ne confère aucun droit supplémentaire à son titulaire.

Le compte Créateur est distinct : sa capacité provient uniquement de `CREATOR_USERNAMES` et reste protégée par `requireCreator`. Un administrateur d’entreprise ne peut pas accéder aux routes ni à la console Créateur.

Le Centre d’assistance Créateur ne transforme pas le Créateur en Poste Admin de l’entreprise. Il fournit une vue technique temporaire en lecture seule et des réparations séparées, motivées et auditables. Les Postes Admin actifs sont notifiés de l’ouverture, de la fermeture et de chaque réparation. Voir [CREATOR_ASSISTANCE.md](CREATOR_ASSISTANCE.md).

Le même compte peut également être utilisé sur un smartphone comme Poste Admin Mobile opérationnel. Chaque téléphone ou tablette approuvé consomme un **poste mobile** inclus dans l’offre, sans consommer de poste administratif. Le rôle dédié `mobile_admin` consomme lui aussi un poste mobile. L’appareil suit le circuit normal d’autorisation. La console Créateur et toutes ses routes restent toutefois strictement réservées à un appareil déclaré **poste administratif** : elles sont absentes de l’interface mobile et refusées côté serveur.

Chaque Poste Admin, y compris le compte Créateur, peut se connecter depuis n’importe quel ordinateur, puis revenir sur son poste administratif initial. Une seule session de poste administratif est conservée par compte : après chaque authentification réussie, le serveur attribue une nouvelle session de poste administratif et révoque immédiatement toutes les précédentes, y compris celles qui utiliseraient le même identifiant d’appareil. Le Poste Admin Mobile reste indépendant de cette règle.

## Profils créables par un Poste Admin

| Profil | Rôle | Administration de l’entreprise |
| --- | --- | --- |
| Poste Admin | `admin` | Oui, droits complets et égaux |
| Poste Admin Mobile | `mobile_admin` | Non |
| Poste administratif | `pc_standard` | Non |
| Chef d’équipe | `team_lead` | Non |
| Technicien | `technician` | Non |

Les Postes Admin sont les seuls à pouvoir créer ou promouvoir un Poste Admin. Les autres rôles ne peuvent pas appeler les routes de création, suppression, activation, désactivation ou changement de rôle des membres. L’ancien rôle technique `accountant` reste pris en charge pour les comptes existants, sous le libellé Poste administratif, mais il ne peut plus être créé ni attribué.

Les Postes Admin peuvent donc remplacer leur poste actif après leur authentification habituelle (mot de passe et 2FA d’entreprise si elle est activée), sans validation manuelle du nouvel ordinateur. Les mécanismes de validation d’appareil et de code e-mail restent inchangés pour les autres profils concernés. Les Postes Admin et Postes administratifs sont comptabilisés dans le quota de postes administratifs de l’entreprise ; les chefs d’équipe comptent dans le quota mobile.

## Autorisations des postes administratifs

Avec une offre **Basic+** ou **Pro**, la création d’un Poste administratif propose trois autorisations indépendantes :

- **Facturation** : accès à l’espace des devis et factures selon les autorisations du poste ; les paramètres et actions strictement administratives restent réservés aux Postes Admin ;
- **Comptabilité** : accès au module Comptabilité, à la facturation électronique et aux PDP ;
- **Entreprises du même groupe** : affichée uniquement lorsque l’entreprise appartient à un groupe, elle permet de changer de société active.

Ces autorisations sont stockées sur le compte, vérifiées par les API et modifiables depuis **Paramètres > Utilisateurs**. Sur l’offre Basic, elles ne sont ni proposées ni honorées pour un Poste administratif. Les Postes Admin disposent toujours de tous les accès disponibles dans l’offre active et, lorsqu’ils appartiennent à un groupe, de la sélection de ses entreprises sans case restrictive.

Une sélection d’entreprise ne transforme jamais un Poste administratif en Poste Admin. Son rôle et ses autorisations restent identiques ; seul l’`account_owner_id` actif change après validation de l’appartenance au groupe.

## Continuité administrative

Le serveur garantit qu’au moins un Poste Admin actif reste présent dans chaque entreprise. La désactivation, suppression ou rétrogradation d’un Poste Admin est refusée si elle retirerait le dernier accès d’administration actif.

L’ancre technique de l’entreprise ne peut pas être supprimée isolément car elle porte les clés de rattachement des données existantes. Cela ne crée pas de hiérarchie de droits : les autres administrateurs peuvent réaliser les mêmes opérations de gestion. La suppression complète de cette ancre reste la suppression de l’entreprise, action réservée au Créateur.

## Journal de sécurité

`depannhome_member_audit` conserve les opérations de gestion des accès, y compris après suppression d’un membre :

- création d’un administrateur ou d’un autre membre ;
- activation et désactivation d’un administrateur ;
- changement de rôle ;
- suppression d’un administrateur ou d’un autre membre.

Chaque ligne contient l’entreprise concernée, l’auteur, la cible (identifiant et nom conservés), l’action, les détails utiles et l’horodatage. Les lectures et écritures sont filtrées par `owner_id`.
