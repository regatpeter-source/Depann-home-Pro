# Depann'Home Pro — V1.0 Foundation

Cette version sépare le moteur de l'application en modules simples et stables.

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

Les dossiers clients et leurs pièces jointes sont enregistrés localement pour fonctionner hors ligne, puis synchronisés avec PostgreSQL dans la table privée `depannhome_clients`. Chaque compte ne peut récupérer que ses propres dossiers, devis, factures, photos et documents.

Une modification est envoyée immédiatement lorsqu’un réseau est disponible. En mode hors ligne, elle est mise en attente puis synchronisée au retour de la connexion, au retour de l’application au premier plan et lors d’une vérification automatique toutes les 30 secondes. Le bouton **Synchroniser** de l’écran Clients permet aussi de lancer l’opération manuellement.

La prise de photo utilise un champ fichier compatible caméra mobile (`capture="environment"`) quand le navigateur le permet. Évitez les photos trop lourdes et privilégiez des documents compressés.
