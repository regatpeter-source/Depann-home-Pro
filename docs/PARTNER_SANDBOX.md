# Sandbox des missions partenaires

## Objet

Le module **Sandbox partenaires** est un laboratoire local réservé à un Poste Admin. Il sert aux démonstrations, à la recette et aux développements de connecteurs, sans partenaire externe ni communication Internet.

Il est **désactivé par défaut** et n’est jamais exposé en production. Pour une instance de développement ou de recette, définissez `PARTNER_SANDBOX_ENABLED=true` avec un `NODE_ENV` différent de `production`. En production, les routes Sandbox retournent `404` et aucune entrée de navigation ou d’annuaire n’est affichée.

Son activation prépare immédiatement :

- le partenaire fictif **AssurTest Démo** (assurance, connecteur et API simulés) ;
- une mission réaliste pour Jean Martin avec intervention, rendez-vous et technicien fictif ;
- la chronologie d’ingestion, planification et notification ;
- trois messages partenaires, trois messages internes masqués et le bouton de bascule de visibilité ;
- un devis, un rapport, trois photos fictives et une facture ;
- les traces d’appels du connecteur API local simulé.

## Isolation

Toutes les données du module sont contenues exclusivement dans `depannhome_partner_sandbox_sessions`. Le module ne lit ni n’écrit les tables réelles suivantes :

- `depannhome_partner_missions` et ses tables de dialogue / outbox ;
- `depannhome_clients` ;
- `depannhome_calendar_events` ;
- `depannhome_billing_documents` ;
- `depannhome_technical_reports`.

Chaque ligne est scindée par `owner_id` et n’est accessible qu’à l’administrateur propriétaire du compte. La suppression de la Sandbox efface la seule ligne dédiée au compte ; une nouvelle activation repart d’un environnement propre.

## Simulateur local

Les boutons de simulation modifient uniquement l’instantané Sandbox et ajoutent les événements métier attendus à sa chronologie. Les retours API sont enregistrés dans un journal local : création, modification, acceptation, refus, annulation, demande d’informations et changement de visibilité des messages. Aucun `fetch` sortant n’est exécuté par le serveur.

## Scénario de connexion partenaire

Dans **Paramètres → Réseau Depann'Home Pro → Annuaire Depann'Home Pro**, l’annuaire de démonstration propose **AssurTest Démo** avec sa fiche (type, statut, description, connecteur et API simulés). La demande suit les étapes visibles « demande envoyée » puis « connexion acceptée ». L’acceptation active automatiquement le connecteur simulé, sans URL, clé API, OAuth ou autre paramétrage.

Le panneau de test de la connexion propose la génération/réception de mission, la consultation des échanges, de la chronologie et du dossier généré, une réponse partenaire et la déconnexion. Une déconnexion désactive uniquement le connecteur simulé ; l’historique de démonstration est conservé pour une reconnexion ultérieure.