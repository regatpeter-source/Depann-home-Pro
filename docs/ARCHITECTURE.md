# Depann'Home Pro — V1.0 Foundation

Cette version sépare le moteur de l'application en modules simples et stables.

## Comptabilité, facturation électronique et aides

Le module `server/accounting.js` reste indépendant de la facturation historique : ses tables, routes et connecteurs ne modifient pas les flux métier existants. Chaque requête est filtrée avec l’`owner_id` dérivé de la session afin de garantir l’isolation des entreprises.

- Les aides, règlements, paramètres comptables et journaux PDP sont persistés dans des tables dédiées.
- `financial_data` porte les remises, acomptes, conditions, options et aides appliquées à un document ; les PDF affichent le TTC, les aides et le reste à charge.
- Les exports CSV, XLSX, PDF et FEC sont préparés pour les outils comptables. Le FEC doit être contrôlé par le cabinet comptable avant dépôt réglementaire : l’application ne certifie pas à elle seule les paramétrages comptables de chaque entreprise.
- Les PDP sont des connecteurs isolés. Seul le bac à sable est fourni ; l’ajout d’un partenaire certifié consiste à enregistrer un connecteur sans modifier le cœur de la facturation. Les échecs sont journalisés et renvoyables depuis l’interface.
- Les critères de travaux, équipements, catégories de clients, localisation et dates de validité sont conservés dans les règles d’aide pour permettre l’ajout ultérieur de référentiels officiels ou régionaux.

## Assistant Connecteurs API

`server/connectors.js` fournit un runtime de plugins **déclaratifs**. Chaque connecteur stocke un manifeste versionné (informations partenaire, authentification, endpoints et mappings), une configuration et des credentials AES-256-GCM chiffrés, tous filtrés par `owner_id`.

Les paquets exportés contiennent le manifeste, le modèle de synchronisation et la documentation, mais jamais les secrets. Ils peuvent être importés puis complétés avec les credentials propres à l’entreprise. Le runtime ne charge jamais de JavaScript issu d’un paquet : il interprète uniquement les endpoints configurés, ce qui évite qu’un partenaire modifie ou exécute du code dans le cœur de Depann’Home Pro.

Les appels de test imposent HTTPS/HTTP externe, refusent les hôtes locaux et plages IPv4 privées usuelles, appliquent timeout et nouvelles tentatives, puis écrivent un journal en masquant les entêtes et valeurs sensibles. Les connecteurs restent compatibles avec une infrastructure Render à disque éphémère, car aucune installation n’écrit dans le système de fichiers.

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
- `navigation.js` : affichage familles, marques, gammes, produits, favoris, historique et paramètres.
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
