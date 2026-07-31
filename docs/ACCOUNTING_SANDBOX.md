# Sandbox Comptabilité et Facturation électronique

## Objet

Le **laboratoire Comptabilité & Facturation électronique** est exclusivement destiné au développement, à la recette et aux démonstrations. Il est réservé à l’administrateur principal et activé explicitement avec :

```dotenv
NODE_ENV=development
ACCOUNTING_SANDBOX_ENABLED=true
```

En production, ou si la variable vaut une autre valeur que `true`, le laboratoire ne crée pas sa table, ses routes retournent `404` et son bouton n’est pas visible dans le module comptable.

## Isolation

Toutes les données sont stockées dans la seule table `depannhome_accounting_sandbox_sessions`, séparée par `owner_id`. Le module ne lit et n’écrit aucune donnée des tables réelles :

- `depannhome_billing_documents` ;
- `depannhome_accounting_settlements` ;
- `depannhome_accounting_aids` ;
- `depannhome_einvoice_transmissions` ;
- `depannhome_clients`, `depannhome_calendar_events` ou `depannhome_technical_reports`.

Les fichiers CSV, Excel et FEC sont assemblés uniquement à partir de cet instantané fictif. Le simulateur PDP ne contient aucun `fetch`, aucune URL externe, aucune clé API ni OAuth.

## Jeu de données et parcours

L’activation génère **Entreprise Démo**, cinq clients fictifs, cinq interventions clôturées avec rapport terminé, des devis acceptés/refusés/en attente, des factures à tous les statuts, des paiements (virement, carte, espèces, chèque, acompte et partiel) ainsi que des avoirs partiel et total.

Les boutons de simulation créent une facture ou un devis, transforment un devis, enregistrent un paiement, produisent un impayé ou un avoir, et injectent les retours PDP `reçue`, `acceptée`, `en traitement`, `rejetée`, `erreur de format`, `destinataire introuvable` et `distribuée`. Les journaux des ventes, règlements et avoirs, les indicateurs et les exports sont recalculés à partir de ce même jeu fictif.

La suppression réinitialise uniquement la session Sandbox du compte, sans impact sur les documents ou paramètres de l’entreprise.