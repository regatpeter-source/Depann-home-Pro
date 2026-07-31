# Architecture des menus par rôle

La navigation Depann’Home Pro est déterminée par le rôle authentifié avant le premier affichage applicatif. Elle ne constitue jamais une autorisation de sécurité : les routes API restent protégées côté serveur par leurs middlewares métier.

## Source unique de visibilité

`js/config.js` exporte `MENU_ACCESS`. Chaque action rapide et chaque route de navigation y déclare explicitement les rôles autorisés.

Au démarrage, `applyRoleBasedMenus()` dans `js/navigation.js` supprime du DOM les boutons non autorisés. Ainsi, un utilisateur ne reçoit ni menu grisé, ni bouton désactivé, ni entrée de navigation inaccessible.

Toute nouvelle entrée de menu doit être ajoutée à `MENU_ACCESS` avant son utilisation dans l’interface. Une route client est également vérifiée par `canAccessRoute()` avant son rendu.

## Matrice actuelle

| Rôle | Navigation visible |
| --- | --- |
| `admin` — Administrateur (PC) | Toutes les fonctions opérationnelles et administratives compatibles avec les capacités activées : paramètres, comptabilité, groupe, partenaires, sandbox, postes et outils. |
| `pc_standard` — Poste PC standard | Clients, planning, bibliothèque, devis/factures, missions partenaires, achats, recherche, photo, favoris et historique. Aucun réglage ni outil d’administration. |
| `mobile_admin` — Administrateur Mobile | Fonctions opérationnelles mobiles : clients, planning, bibliothèque, devis/factures, recherche, photo, favoris et historique. Aucun paramètre ni sécurité d’entreprise. |
| `team_lead` / `technician` | Navigation terrain : planning et bibliothèque. Les rapports nécessaires restent accessibles dans le parcours d’intervention existant. |
| `accountant` | Devis/factures et achats, conformément à l’espace comptable existant. |

Les entrées Groupe et Sandbox exigent en plus leurs capacités existantes (`groupAdmin` et sandbox activée). Elles sont donc absentes même pour un administrateur lorsque ces capacités ne sont pas disponibles.

## Sécurité côté serveur

Les règles d’interface ne remplacent pas les contrôles existants :

- gestion des utilisateurs, rôles, appareils et audit : `requireAccountAdministrator` ;
- comptabilité et facturation électronique : `requireAccountingAdministration` ;
- partenaires et connecteurs : middlewares d’administration dédiés ;
- groupe, changement d’entreprise et pilotage multi-entreprises : Administrateur (PC) du groupe ;
- autres données métier : contrôles de rôle existants et filtrage par `owner_id`.

Un appel direct à une API administrative depuis un poste standard, mobile ou terrain reste donc refusé par le serveur.
