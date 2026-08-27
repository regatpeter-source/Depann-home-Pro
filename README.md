# Depann Home Pro

## Génération automatique des notices

L'application importe automatiquement les fichiers de notices déposés dans `assets/notices/`.

### Scripts disponibles

- `npm run generate-notice-manifest`
  - génère le fichier `assets/notices/manifest.json` à partir des fichiers présents dans `assets/notices/`

- `npm run watch-notice-manifest`
  - surveille en continu `assets/notices/`
  - regénère automatiquement `assets/notices/manifest.json` à chaque ajout, suppression ou modification de fichier

### Utilisation recommandée

1. Copier les fichiers de notices dans `assets/notices/` ou dans un sous-dossier.
2. Lancer `npm run watch-notice-manifest` pendant le développement.
3. L'application associera ensuite ces notices aux produits quand les références correspondent.

### Structure des notices

Le manifeste contient des entrées de la forme :

```json
{
  "path": "assets/notices/somfy/mon-fichier.pdf",
  "reference": "oximo 50 rts",
  "product": "oximo 50 rts"
}
```

Le script de surveillance le met à jour automatiquement.

## Exploitation et qualité

- `docs/DATABASE_OPERATIONS.md` : migrations, sauvegarde, restauration et test de reprise.
- `docs/SECURITY_OPERATIONS.md` : secrets, TOTP, CSRF, CSP, supervision et réponse aux incidents.
- `docs/TESTING.md` : tests unitaires, API/PostgreSQL, CI et charge autorisée.
