# Architecture des menus par rôle

La navigation Depann'Home Pro est déterminée par le rôle authentifié avant le premier affichage applicatif. Elle ne constitue jamais une autorisation de sécurité : les routes API restent protégées côté serveur par leurs middlewares métier.

## Source unique de visibilité

`js/config.js` exporte `MENU_ACCESS`. Chaque action rapide et chaque route de navigation y déclare explicitement les rôles autorisés.

Au démarrage, `applyRoleBasedMenus()` dans `js/navigation.js` supprime du DOM les boutons non autorisés. Ainsi, un utilisateur ne reçoit ni menu grisé, ni bouton désactivé, ni entrée de navigation inaccessible.

Toute nouvelle entrée de menu doit être ajoutée à `MENU_ACCESS` avant son utilisation dans l’interface. Une route client est également vérifiée par `canAccessRoute()` avant son rendu.

Les rôles de poste mobile (`mobile_admin`, `team_lead`, `technician`) conservent toujours les boutons **Accueil** et **Bibliothèque**, indépendamment des fonctionnalités incluses dans l’offre de l’organisation. Aucun poste PC n’accède à la Bibliothèque. Les **Achats** sont disponibles dans toutes les offres sur tous les postes PC (`admin`, `pc_standard`, `accountant`) et sur `mobile_admin`, avec le même contrôle côté serveur.

## Matrice actuelle

| Rôle | Navigation visible |
| --- | --- |
| `admin` — Administrateur (PC) | Toutes les fonctions opérationnelles et administratives compatibles avec les capacités activées, dont les Achats, hors bibliothèque technique : paramètres, comptabilité, groupe, réseau, sandbox, postes et importation de données. |
| `pc_standard` — Poste PC standard | Clients, planning, devis/factures, achats, missions partenaires, recherche et historique. Aucun réglage, outil d’administration ou accès à la bibliothèque technique. |
| `mobile_admin` — Administrateur Mobile | Fonctions opérationnelles mobiles : clients, planning, bibliothèque, achats, devis/factures, recherche et historique. Aucun paramètre ni sécurité d’entreprise. |
| `team_lead` / `technician` | Barre inférieure mobile limitée à **Accueil**. Le planning, la bibliothèque et les rapports restent accessibles depuis les boutons et parcours métier de l’accueil. |
| `accountant` | Devis/factures et gestion des Achats depuis Facturation ou l’entrée dédiée. |

Les entrées Groupe et Sandbox exigent en plus leurs capacités existantes (`groupAdmin` et sandbox activée). Elles sont accessibles depuis les Paramètres et restent absentes même pour un administrateur lorsque ces capacités ne sont pas disponibles.

## Sécurité côté serveur

Les règles d’interface ne remplacent pas les contrôles existants :

- gestion des utilisateurs, rôles, appareils et audit : `requireAccountAdministrator` ;
- comptabilité et facturation électronique & PDP : `requireAccountingAdministration` ;
- partenaires et connecteurs : middlewares d’administration dédiés ;
- groupe, changement d’entreprise et pilotage multi-entreprises : Administrateur (PC) du groupe ;
- autres données métier : contrôles de rôle existants et filtrage par `owner_id`.

Un appel direct à une API administrative depuis un poste standard, mobile ou terrain reste donc refusé par le serveur.
