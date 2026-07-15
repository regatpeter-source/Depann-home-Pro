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

- `data/database.json` pour ajouter marques, catégories, produits, procédures, modes d'emploi, documents, photos et vidéos ;
- `css/style.css` pour améliorer le design ;
- `assets/` pour ajouter logo, photos, PDF ou autres médias.

## Rôle des modules JS

- `app.js` : point d'entrée de l'application.
- `clients.js` : base clients locale, formulaire, liste, détail, modification, suppression et pièces jointes.
- `config.js` : version, clés de stockage, constantes.
- `data.js` : chargement et normalisation de `database.json`.
- `navigation.js` : affichage marques, catégories, produits, procédures, favoris, historique et paramètres.
- `search.js` : recherche globale.
- `state.js` : état de navigation courant.
- `storage.js` : favoris et historique en localStorage.
- `ui.js` : composants d'interface réutilisables.
- `utils.js` : helpers génériques.

## Note notices constructeur

Les notices officielles peuvent être référencées dans les champs `documents`, mais les contenus copiés mot pour mot ne doivent pas être intégrés directement sans autorisation.

## Données clients

Les clients sont stockés localement dans le navigateur avec `localStorage`, sous la clé `depannHomePro:clients`.
Ces données restent sur l'appareil de l'utilisateur et ne sont pas envoyées vers un serveur.
Chaque fiche client peut aussi contenir des pièces jointes locales : devis, factures, photos et autres documents.
La prise de photo utilise un champ fichier compatible caméra mobile (`capture="environment"`) quand le navigateur le permet.

Important : comme les fichiers sont enregistrés en local dans le navigateur, il faut éviter les photos trop lourdes et privilégier des documents compressés.
