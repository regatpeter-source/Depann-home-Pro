# Architecture des menus par rôle

La navigation Depann'Home Pro est déterminée par le rôle authentifié avant le premier affichage applicatif. Elle ne constitue jamais une autorisation de sécurité : les routes API restent protégées côté serveur par leurs middlewares métier.

## Source unique de visibilité

`js/config.js` exporte `MENU_ACCESS`. Chaque action rapide et chaque route de navigation y déclare explicitement les rôles autorisés.

Au démarrage, `applyRoleBasedMenus()` dans `js/navigation.js` supprime du DOM les boutons non autorisés. Ainsi, un utilisateur ne reçoit ni menu grisé, ni bouton désactivé, ni entrée de navigation inaccessible.

Toute nouvelle entrée de menu doit être ajoutée à `MENU_ACCESS` avant son utilisation dans l’interface. Une route client est également vérifiée par `canAccessRoute()` avant son rendu.

Les fonctions d’exploitation sont réparties selon leur contexte : **Portail client** se trouve dans **Clients**, **Rentabilité** dans **Devis & rapports**, et **Ressources** regroupe **Sites & équipements**, **Stock** et **Véhicules**. Le menu distinct **Automatisations** n’est plus exposé ; les responsables autorisés configurent les rappels internes depuis l’Accueil sur PC ou, sur un poste mobile, depuis **Menu → Interventions → Rappels internes**. Les catégories ne sont activées qu’à la demande de l’entreprise.

Les rôles de poste mobile (`mobile_admin`, `team_lead`, `technician`) conservent toujours les boutons **Accueil** et **Bibliothèque**, indépendamment des fonctionnalités incluses dans l’offre de l’organisation. **Gammes** et **Bibliothèque** ne sont jamais affichées dans le logiciel PC : le filtrage tient compte du type d’appareil en plus du rôle, les anciennes vues restaurées sont refusées et l’API Bibliothèque exige une session mobile. Les **Achats** sont disponibles dans toutes les offres sur tous les postes administratifs (`admin`, `pc_standard`, `accountant`) et sur `mobile_admin`, avec le même contrôle côté serveur. Tous les postes opérationnels utilisés sur mobile disposent aussi de **Signaler un problème** dans le dossier **Aide et support** ; ce formulaire crée une demande Support avec catégorie, objet, description et contexte technique non sensible.

## Matrice actuelle

| Rôle | Navigation visible |
| --- | --- |
| `admin` — Poste Admin | Toutes les fonctions opérationnelles et administratives compatibles avec les capacités activées, dont les Achats, hors bibliothèque technique : paramètres, comptabilité, groupe, réseau, sandbox, postes et importation de données. |
| `mobile_admin` — Poste Admin Mobile | Fonctions opérationnelles mobiles : clients, planning, bibliothèque, achats, devis/factures, recherche et historique. Il voit tous les clients de l’entreprise comme sur PC, peut créer et modifier une fiche client et créer un devis ou une facture depuis cette fiche ; l’archivage et la suppression d’un client restent réservés à un poste administratif. Il gère toujours le planning comme un poste PC, sans autorisation à cocher : toucher une date (vues Mois, Semaine ou Jour) ouvre la création d’un rendez-vous, et il peut modifier les rendez-vous créés sur PC. Son **Accueil** affiche uniquement le chiffre d’affaires mensuel et le planning (rendez-vous du jour et à venir) ; les rappels internes s’ouvrent via **Menu → Interventions → Rappels internes** et le bouton **Interventions** ouvre le planning. Aucun paramètre ni sécurité d’entreprise. |
| `pc_standard` — Poste administratif | Clients, planning, devis/factures, achats, missions partenaires, recherche et historique. Aucun réglage, outil d’administration ou accès à la bibliothèque technique. |
| `team_lead` / `technician` | Barre inférieure mobile limitée à **Accueil**. Le planning, la bibliothèque et les rapports restent accessibles depuis les boutons et parcours métier de l’accueil. |
| `accountant` | Devis/factures et gestion des Achats depuis Facturation ou l’entrée dédiée. |

Les entrées Groupe et Sandbox exigent en plus leurs capacités existantes (`groupAdmin` et sandbox activée). Elles sont accessibles depuis les Paramètres et restent absentes même pour un administrateur lorsque ces capacités ne sont pas disponibles.

## Sécurité côté serveur

Les règles d’interface ne remplacent pas les contrôles existants :

- gestion des utilisateurs, rôles, appareils et audit : `requireAccountAdministrator` ;
- comptabilité et facturation électronique & PDP : `requireAccountingAdministration` ;
- partenaires et connecteurs : middlewares d’administration dédiés ;
- groupe, changement d’entreprise et pilotage multi-entreprises : Poste Admin du groupe ;
- autres données métier : contrôles de rôle existants et filtrage par `owner_id`.

Un appel direct à une API administrative depuis un poste standard, mobile ou terrain reste donc refusé par le serveur.

La carte terrain applique aussi les droits côté serveur : un technicien mobile reçoit uniquement sa propre position et ses interventions, tandis que le Poste Admin Mobile et le Chef d’équipe peuvent consulter l’équipe. Sur PC, les postes autorisés choisissent les techniciens ou les équipes à afficher.

Les dossiers clients suivent la même logique : sur mobile, un Chef d’équipe ou un Technicien ne reçoit que les clients liés à un rendez-vous créé depuis un poste administratif et qui lui est affecté, sans pouvoir créer de nouveau client. Le Poste Admin Mobile n’est pas soumis à ce filtre (`hasAssignedClientScope`) : il synchronise tout le portefeuille, crée des clients, des devis et des factures, mais les routes d’archivage, de réactivation et de suppression restent refusées sur mobile.

Le planning applique la même distinction : seuls le Chef d’équipe et le Technicien dépendent de l’autorisation **Gérer le planning** et ne modifient que les rendez-vous qu’ils ont créés sur mobile. Les rendez-vous créés par le Poste Admin Mobile sont enregistrés comme administratifs (`calendarEventOrigin`, `created_device_type = 'desktop'`) : le Chef d’équipe ou le Technicien affecté reçoit donc la fiche client, comme pour un rendez-vous créé sur PC. La migration `0045` reclasse les rendez-vous déjà créés sur mobile par un Poste Admin Mobile ou un compte `admin`.
