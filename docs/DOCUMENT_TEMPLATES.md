# Modèles personnalisés de documents

Le système gère quatre modèles indépendants par entreprise : `quote`, `invoice`, `quitus` et `report`.

## Règle de rendu

- Sans version personnalisée active, le renderer natif historique est utilisé sans modification.
- Avec une version active, seul `server/document-templates.js` produit le PDF.
- Le PDF natif n'est jamais généré puis fusionné avec le modèle personnalisé.
- Le fichier PDF, PNG ou JPEG importé constitue la structure visuelle ; seules les zones configurées reçoivent les données métier.
- Chaque zone dynamique masque d'abord son contenu d'exemple avec le fond configuré, puis dessine la donnée réelle. Le logo, les coordonnées et textes fixes hors zone restent intacts.

## Héritage devis vers facture

Si aucune version de facture n'est active, le renderer utilise automatiquement la version active du devis. Il travaille sur une copie en mémoire de sa définition : `QUOTE_NUMBER` devient `INVOICE_NUMBER`, la validité devient l'échéance et les conditions deviennent les informations de règlement. Le fichier et la définition du devis ne sont jamais modifiés.

Les données ne sont pas héritées : numéro, type, date, client, lignes, statut et totaux sont reconstruits depuis la facture courante.

## Stockage et isolation

La table `depannhome_document_templates` contient les versions, leur fichier source et leur définition JSON. Toutes les lectures et écritures sont filtrées par `owner_id`. L'index partiel `depannhome_document_templates_active_idx` garantit une seule version active par entreprise et type de document.

Les anciens PDF ou images stockés dans `depannhome_billing_profiles` sont copiés une fois comme brouillons inactifs. L'ancien fichier commun devis/facture crée deux brouillons indépendants. Les anciens DOCX restent conservés dans les colonnes historiques et téléchargeables, mais doivent être convertis en PDF ou image pour le nouvel éditeur.

## Éditeur

L'éditeur est disponible sur poste PC pour l'administrateur dans **Paramètres → Modèles de documents**. Il permet l'import, le déplacement et le redimensionnement des zones, les textes fixes, couleurs, bordures, marges, l'aperçu, le test automatique et l'activation.

Les coordonnées sont exprimées en points PDF depuis le coin supérieur gauche. Les zones extensibles (`table`, `repeatText`, `photos`) créent automatiquement les pages nécessaires. Les zones marquées `all` sont répétées ; les zones `final` sont placées sur la dernière page.

L'option **Masquer l'exemple du PDF dans cette zone** doit rester active pour les clients, numéros, dates, tableaux, montants, photos et signatures présents dans un document de démonstration. La couleur du fond de remplacement peut être adaptée au modèle.

## Aperçu et test

Les routes `preview` et `test` appellent exactement `renderCustomDocumentTemplate`, utilisé aussi par les PDF finaux. Le test injecte 32 lignes, des textes longs, des observations, des photos, des montants et une signature. Les débordements, collisions entre zones et passages multipages sont signalés dans l'interface.

## Migration

Au démarrage, `initializeDocumentTemplates()` crée la table et ses index de manière idempotente puis préserve les anciens fichiers compatibles comme brouillons. Le contrôle manuel peut être lancé avec `node scripts/verify-document-template-migration.js` depuis un environnement ayant accès au serveur PostgreSQL.
