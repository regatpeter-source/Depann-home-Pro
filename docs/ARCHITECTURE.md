# Depann'Home Pro — V1.0 Foundation

Cette version sépare le moteur de l'application en modules simples et stables.

## Comptabilité, facturation électronique & PDP et aides

Le module `server/accounting.js` reste indépendant de la facturation historique : ses tables, routes et connecteurs ne modifient pas les flux métier existants. Chaque requête est filtrée avec l’`owner_id` dérivé de la session afin de garantir l’isolation des entreprises.

- Les aides, règlements, paramètres comptables et journaux PDP sont persistés dans des tables dédiées.
- `financial_data` porte les remises, acomptes, conditions, options et aides appliquées à un document. Dans l’éditeur de devis ou de facture, les aides configurées sont affichées comme lignes de **primes et aides**, déduites du reste à charge pour toute personne autorisée à créer ou modifier ce document ; les PDF affichent le TTC, les aides et le reste à charge.
- Les exports CSV, XLSX, PDF et FEC sont préparés pour les outils comptables. Le FEC doit être contrôlé par le cabinet comptable avant dépôt réglementaire : l’application ne certifie pas à elle seule les paramétrages comptables de chaque entreprise.
- Depann'Home Pro est un logiciel métier compatible avec la facturation électronique. Il prépare les factures électroniques et permet leur transmission via une Plateforme de Dématérialisation Partenaire (PDP) choisie par votre entreprise. Depann'Home Pro n'est pas une PDP agréée par l'État.
- Les PDP sont des connecteurs isolés. Seul un connecteur de test est fourni ; l’ajout d’une PDP choisie par l’entreprise consiste à enregistrer un connecteur sans modifier le cœur de la facturation. Les échecs sont journalisés et renvoyables depuis l’interface.
- Les critères de travaux, équipements, catégories de clients, localisation et dates de validité sont conservés dans les règles d’aide pour permettre l’ajout ultérieur de référentiels officiels ou régionaux.

## Registre des prestataires externes

`server/connectors.js` fournit un registre de prestataires externes et un runtime de plugins **déclaratifs**, réservé au compte Créateur. Chaque connecteur stocke un manifeste versionné (informations partenaire, authentification, endpoints et mappings), une configuration et des credentials AES-256-GCM chiffrés dans l’espace plateforme. Les entreprises ne voient ni les connecteurs ni leurs réglages techniques.

Les paquets exportés contiennent le manifeste, le modèle de synchronisation et la documentation, mais jamais les secrets. Ils peuvent être importés puis complétés avec les credentials propres à l’entreprise. Le runtime ne charge jamais de JavaScript issu d’un paquet : il interprète uniquement les endpoints configurés, ce qui évite qu’un partenaire modifie ou exécute du code dans le cœur de Depann'Home Pro.

Les appels de test imposent HTTPS/HTTP externe, refusent les hôtes locaux et plages IPv4 privées usuelles, appliquent timeout et nouvelles tentatives, puis écrivent un journal en masquant les entêtes et valeurs sensibles. Les connecteurs restent compatibles avec une infrastructure Render à disque éphémère, car aucune installation n’écrit dans le système de fichiers.

## Réception des missions partenaires

`server/partner-missions.js` est volontairement séparé des connecteurs déclaratifs sortants. Il fournit des endpoints publics limités par débit, authentifiés par une clé partenaire dont seul le hash est conservé. Un identifiant de mission stable garantit le dédoublonnage par entreprise et partenaire ; la charge brute, la donnée normalisée et chaque transition sont conservées dans PostgreSQL.

Après validation administrative, une transaction rapproche le client, planifie l’intervention, affecte le technicien et crée le brouillon du rapport de fuite lorsque nécessaire. Les notifications réutilisent le centre de collaboration persistant. Les callbacks de statut sont ajoutés à une boîte d’envoi durable, relançable depuis l’interface ; les erreurs et nouvelles tentatives restent auditées. Les techniciens ne voient que leurs missions attribuées. Les détails du contrat d’intégration figurent dans `docs/PARTNER_MISSIONS.md`.

## Dialogue collaboratif par dossier partenaire

`server/partner-dialogue.js` conserve un fil privé, chronologique et strictement rattaché à une mission partenaire. Il ne réutilise pas les notes client internes : messages, incidents et pièces jointes résident dans des tables dédiées et sont isolés par `owner_id` et `mission_id`. Les accès internes suivent les droits de la mission ; l’accès externe passe uniquement par la clé API de l’organisme qui a créé cette mission. Les changements métier ajoutent des événements système au fil, tandis que les messages et fichiers génèrent des notifications persistantes et un callback partenaire relançable. Voir `docs/PARTNER_DIALOGUE.md`.

## Connexions partenaires simplifiées

`server/partner-connections.js` est le parcours sans configuration destiné aux entreprises déjà inscrites sur Depann'Home Pro. Dans **Paramètres → Réseau Depann'Home Pro**, l’onglet **Mes partenaires** regroupe les connexions actives et les accès API externes ; l’onglet **Annuaire Depann'Home Pro** regroupe la visibilité, la recherche et les demandes bilatérales. Les rendez-vous autorisés sont automatiquement répliqués en mission partenaire dans l’espace destinataire ; les rapports validés sont ajoutés au dossier partagé lorsque le droit correspondant est accordé. Les Missions partenaires restent uniquement opérationnelles. Voir `docs/PARTNER_CONNECTIONS.md`.

## Rapports techniques

`server/technical-reports.js` fournit un moteur de rapports extensible lié aux interventions du planning. Le premier modèle, `leak_detection`, est édité par `js/leak-report-wizard.js` sous la forme d’un éditeur plein écran, optimisé pour le smartphone. Les informations client, intervention et technicien sont générées automatiquement ; chaque module métier peut contenir autant d’observations libres et de photos que nécessaire dans les limites globales de sécurité du rapport. Les données et médias du rapport sont isolés par `owner_id`; les techniciens n’accèdent qu’aux interventions qui leur sont affectées.

Le contenu est normalisé par `server/leak-report-template.js`. Le schéma actuel ajoute une liste `observations` par module, avec un identifiant stable, le constat et la date de création. Les **matériels techniques utilisés** sont configurés dans `DEFAULT_MATERIALS`, complétés dynamiquement par les éléments de bibliothèque de catégorie `materials`, puis exposés à l’éditeur par l’API. Ils sont persistés dans `methods.materials` : chaque matériel sélectionné porte un identifiant, un libellé (ou un nom libre pour « Autre matériel ») et ses propres observations. Chaque photo peut référencer une observation par `observationId` et un matériel par `materialId`. Les rapports antérieurs restent pris en charge : leurs champs historiques sont conservés et leurs anciens moyens techniques sont migrés vers des matériels dédiés.

L’éditeur enregistre automatiquement les brouillons, permet d’ignorer un module inutilisé, de prévisualiser le PDF temporaire et de revenir immédiatement à l’édition. Pour chaque ajout ou remplacement de photo, l’utilisateur choisit explicitement **Prendre une photo** (caméra arrière lorsque le navigateur le permet) ou **Choisir dans la galerie** (sélection multiple). L’image est ramenée côté navigateur à 1 920 px maximum et compressée avant transfert. Les miniatures peuvent être agrandies, légendées, remplacées, supprimées et déplacées : leur `sortOrder` est persisté avec le rapport et détermine l’ordre PDF.

La première page du PDF est la couverture : références d’intervention, numéro de service, bénéficiaire, lieu, sinistre/assurance, date et **Technicien : nom**, suivis du titre **Rapport de recherche de fuite** et de la photo extérieure du logement. Les modules renseignés commencent ensuite en page 2 avec l’état des lieux. Chaque matériel sélectionné génère ensuite sa propre page, titrée avec son nom et limitée à ses seules observations et photos ; aucun matériel non sélectionné n’apparaît. La conclusion est toujours l’avant-dernière section et les préconisations la dernière. Les champs historiques, relevés et signatures restent rendus afin de conserver la lisibilité des rapports antérieurs.

Le rendu PDF est uniformisé par `server/leak-report-template.js` : en-tête d’entreprise, titre centré, séparateur coloré, pied de page et pagination sont apposés à toutes les pages. Sur PC, l’administrateur peut ouvrir **Modifier le modèle de rapport** depuis l’espace Devis/Factures ou la liste des rapports ; ce bouton mène à **Paramètres → Rapports → Modèle de rapport**. Le gabarit est enregistré une seule fois par entreprise dans `depannhome_billing_profiles.report_template` : logos principal et secondaire, identité et coordonnées, textes, couleurs, police et éléments du pied de page. `GET` et `PUT /api/technical-reports/template` sont réservés à l’administration du rapport. La dernière version est appliquée à tous les brouillons, prévisualisations et futurs PDF de l’entreprise ; un PDF déjà validé reste archivé et immuable. Ces préférences ne modifient pas les règles de verrouillage, validation ou archivage.

Le PDF recalcule la pagination automatiquement. L’envoi, la validation définitive, les demandes de correction et la réouverture conservent les droits existants. La validation génère le PDF officiel, l’archive au dossier client et synchronise immédiatement son historique local. L’historique affiche le rapport validé comme les devis, factures et quitus, avec les actions **Visualiser**, **Imprimer / PDF** et **Envoyer par e-mail**. La mission partenaire associée est également synchronisée.

Les médias techniques restent dans les tables dédiées du rapport afin de ne pas dépasser les limites des dossiers clients. À la validation administrative, PDFKit produit le PDF, qui est conservé dans le rapport et archivé au dossier client dans la même transaction. Les demandes de correction sont associées à une section précise.

`server/collaboration.js` apporte un verrou exclusif persistant par ressource, une pulsation d’activité et une expiration après 15 minutes d’inactivité. Le détenteur peut modifier le rapport ; les autres utilisateurs le consultent en lecture seule, avec le nom, rôle et temps d’ouverture de l’éditeur actif. Les écritures sont contrôlées côté serveur, et l’administrateur peut reprendre un verrou avec un motif audité. Un flux SSE natif diffuse les événements métier importants (verrou, sauvegarde, photo, statut, correction, validation), sans coédition caractère par caractère. Les notifications et l’audit sont stockés en PostgreSQL. Voir `docs/COLLABORATION.md` pour l’extension à d’autres entités.

## Structure

```text
Depann-home-Pro/
├── index.html
├── manifest.json
├── service-worker.js
├── assets/
│   └── logo.png.png
├── css/
│   └── style.css
├── data/
│   └── database.json
├── docs/
│   └── ARCHITECTURE.md
└── js/
    ├── app.js
    ├── clients.js
    ├── config.js
    ├── data.js
    ├── navigation.js
    ├── search.js
    ├── state.js
    ├── storage.js
    ├── ui.js
    └── utils.js
```

## Règle d'évolution

Le moteur JavaScript doit rester stable. Les futures évolutions métier doivent en priorité passer par :

- `data/database.json` pour ajouter familles, marques, gammes et produits ; les fiches techniques pourront être ajoutées progressivement ;
- `css/style.css` pour améliorer le design ;
- `assets/` pour ajouter logo, photos, PDF ou autres médias.

## Rôle des modules JS

- `app.js` : point d'entrée de l'application.
- `clients.js` : base clients locale, formulaire, liste, détail, modification, suppression et pièces jointes.
- `config.js` : version, clés de stockage, constantes.
- `data.js` : chargement et normalisation de `database.json`.
- `navigation.js` : affichage familles, marques, gammes, produits, favoris, historique et Paramètres. Les Paramètres sont un hub à cartes qui sépare les réglages d’entreprise (modèles de documents, réseau, utilisateurs, sécurité, groupe, personnalisation et importation de données) des fonctions métier quotidiennes du menu principal.
- `search.js` : recherche globale dans les familles, marques, gammes et produits.
- `state.js` : état de navigation courant.
- `storage.js` : favoris et historique en localStorage.
- `ui.js` : composants d'interface réutilisables.
- `utils.js` : helpers génériques.

## Note notices constructeur

Les notices officielles peuvent être référencées dans les champs `documents`, mais les contenus copiés mot pour mot ne doivent pas être intégrés directement sans autorisation.

## Données clients

Les dossiers clients et leurs pièces jointes sont enregistrés localement pour fonctionner hors ligne, puis synchronisés avec PostgreSQL dans la table privée `depannhome_clients`. Les données sont isolées par **espace entreprise** : l’administrateur et les techniciens qu’il crée partagent les mêmes dossiers, devis, planning, notes et documents ; les autres entreprises ne peuvent pas y accéder.

Un technicien possède son propre identifiant et mot de passe, mais son nom et son téléphone sont renseignés uniquement par l’administrateur au moment de la création. L’identité du technicien reste disponible pour attribuer les nouvelles activités dans l’historique client. Sur mobile, l’interface technicien privilégie directement le planning, les clients, la prise de photo et les notes ; les outils d’administration restent accessibles sur ordinateur à l’administrateur. Les clients sont pour lui un annuaire d’intervention en **consultation uniquement** : il peut rechercher et ouvrir un dossier, sans créer, modifier, supprimer ni ajouter des fichiers. La messagerie technicien est limitée aux **notes d’intervention** présentes dans le dossier client : il peut en ajouter et modifier uniquement celles dont il est l’auteur, sans modifier les données du dossier.

Une modification est envoyée immédiatement lorsqu’un réseau est disponible. En mode hors ligne, elle est mise en attente puis synchronisée au retour de la connexion, au retour de l’application au premier plan et lors d’une vérification automatique silencieuse toutes les 90 secondes. Après le premier chargement, cette vérification ne télécharge que les dossiers créés, modifiés ou supprimés depuis la synchronisation précédente. Le bouton **Synchroniser** de l’écran Clients permet aussi de lancer l’opération manuellement.

La prise de photo utilise un champ fichier compatible caméra mobile (`capture="environment"`) quand le navigateur le permet. Évitez les photos trop lourdes et privilégiez des documents compressés.
