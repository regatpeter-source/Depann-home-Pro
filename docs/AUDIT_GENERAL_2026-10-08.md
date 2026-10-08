# Audit général fonctionnel — 8 octobre 2026

## Périmètre et méthode

Audit réalisé sur une installation PostgreSQL vierge et isolée (`audit_general_20261008`), avec serveur local et transports externes neutralisés. Les contrôles ont combiné la suite automatisée, les tests PostgreSQL, une navigation réelle dans l’application et des scénarios métier complets.

Les envois vers des fournisseurs externes réels (SMTP, Google, Microsoft, PDP) n’ont volontairement pas été déclenchés. Les adresses utilisées sont sous le domaine réservé `.invalid` et le Sandbox API partenaire appelle uniquement l’instance locale.

## Couverture fonctionnelle

- Authentification, identification d’appareil, session unique et rôles.
- Navigation des 11 menus principaux et des 13 rubriques Paramètres.
- Clients : création, synchronisation, recherche et ouverture immédiate du dossier.
- Planning : création, modification, statut, rattachement client et ressources.
- Devis et factures : création, conversion, émission, archives PDF/UBL et comportement d’envoi sans SMTP.
- Achats : création et rattachement client.
- Ressources : dépôt, article, stock, mouvement, véhicule, site, équipement, contrat et rattachement à une intervention.
- Missions partenaires : intake réel en Sandbox, dédoublonnage, création client, statuts, callback signé et isolation de la production.
- Quitus : validation, signature, PDF et archivage client.
- Rapports techniques : cycle `draft → submitted → ready_to_send → validated`, verrou, correction, PDF, archivage et remise en main propre.
- Comptabilité : comptabilisation de facture, virement soumis à contrôle puis approuvé, avoir, journaux et équilibre du grand livre.
- Démarrage à froid, migrations, sécurité, cache PWA et espace de travail multi-fenêtres.

## Résultats des scénarios réels

- Mission partenaire `AUDIT-MISSION-2026-001` : première réception HTTP 202, rejeux HTTP 200 sur le même identifiant, une seule fiche client créée.
- Callback Sandbox signé : HTTP 200 et journal entrant expurgé.
- Facture `FAC-2026-000001` : écriture validée à 180 €, règlement partiel de 50 € approuvé, reste 130 €.
- Avoir `AVO-2026-000001` : archive créée et écriture comptable validée.
- Grand livre après scénario : 3 pièces, 8 lignes, 2 journaux, 240 € au débit et 240 € au crédit, écart nul.
- Quitus intervention n°1 : validé, PDF officiel de 3 331 octets archivé au dossier client.
- Rapport technique n°1 : validé, PDF officiel de 5 303 octets archivé et marqué remis en main propre.

## Défauts détectés et corrigés

1. **Démarrage PostgreSQL vierge impossible** : les migrations référençaient des tables de modules avant leur initialisation. L’ordre de démarrage initialise désormais les schémas dépendants avant migrations et écoute réseau.
2. **Icônes Paramètres manquantes** : certaines rubriques affichaient littéralement `undefined`. Les icônes et le fallback sont maintenant définis.
3. **Ouverture prématurée d’un nouveau client** : le détail pouvait retourner « dossier introuvable » avant synchronisation PostgreSQL. L’ouverture attend désormais la synchronisation.
4. **Cache PWA obsolète** : les versions de cache et d’imports ES ont été coordonnées pour livrer les correctifs.
5. **Faux brouillons non enregistrés** : Clients, Planning, Facturation, Achats et Ressources conservaient parfois un indicateur sale après succès. Un signal commun efface uniquement le brouillon actif réellement persisté.
6. **Conversion de facture en erreur JavaScript** : `currentUser` était indéfini dans le champ d’attribution du chiffre d’affaires. Le rendu utilise désormais l’état de session exposé par le document.
7. **SMTP absent retourné en 500** : l’envoi renvoie maintenant un HTTP 503 explicite et transactionnel, sans modifier l’état de remise.
8. **Callbacks Sandbox bloqués en 401** : le middleware d’authentification interceptait la route publique signée. Une exception stricte autorise uniquement `POST /external-callback/:token` tout en conservant le rate-limit et le secret opaque.
9. **Drapeau Sandbox perdu après transition** : les réponses de statut annonçaient `isSandbox:false`. La transition conserve maintenant le drapeau de l’intake.
10. **Création d’avoir en erreur 500** : une date PostgreSQL native provoquait `Invalid time value` dans le PDF. Le formateur accepte maintenant les objets `Date`, les dates ISO et dégrade proprement une date invalide.

## Validation automatisée

- Suite générale initiale : 840 tests réussis sur 840.
- Intégration PostgreSQL initiale : 5 tests réussis sur 5.
- Régressions ciblées ajoutées pour le démarrage, les icônes, la synchronisation client, les brouillons, SMTP, Sandbox et les dates d’avoir.
- Diagnostics éditeur : aucun diagnostic sur les fichiers modifiés.
- Validation finale complète : `npm run check`, 847 tests réussis sur 847 et toutes les vérifications syntaxiques réussies.

## Limites volontaires et risques résiduels

- Aucun e-mail, OAuth ou échange PDP réel n’a été envoyé ; ces intégrations nécessitent une recette dédiée avec comptes de test fournisseurs.
- Les parcours mobiles ont été couverts par les tests et la logique d’interface, mais pas sur un appareil physique avec caméra et réseau intermittent réel.
- Les performances sous forte concurrence relèvent du test de charge dédié et ne sont pas chiffrées dans cet audit fonctionnel.

## Conclusion

Les parcours essentiels de création, missionnement, planification, facturation, règlement, avoir, quitus, rapport et gestion des ressources fonctionnent sur une installation propre. Les défauts reproductibles découverts pendant l’audit ont été corrigés et couverts par des régressions. Les seules validations non exécutées concernent volontairement des fournisseurs externes réels ou du matériel physique.
