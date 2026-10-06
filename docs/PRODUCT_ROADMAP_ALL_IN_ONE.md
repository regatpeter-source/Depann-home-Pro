# Depann’Home Pro — feuille de route « logiciel tout-en-un »

Date de l’audit : 6 octobre 2026.

## Objectif

Faire de Depann’Home Pro le poste de travail unique d’une entreprise de dépannage et de service terrain, depuis la prospection jusqu’au règlement et au pilotage, sans reconstruire des domaines réglementés pour lesquels une intégration spécialisée est plus sûre.

Cette feuille de route distingue les fonctions déjà opérationnelles des compléments réellement nécessaires. Une fonction n’est considérée comme présente que lorsqu’un parcours, une persistance serveur et des contrôles d’accès ont été constatés dans le dépôt.

## Socle déjà opérationnel

| Domaine | Couverture actuelle | Principales preuves |
| --- | --- | --- |
| Clients | Fiches, historique, pièces jointes, notes, recherche, import et synchronisation hors ligne | `server/clients.js`, `js/clients.js`, `js/client-sync.js` |
| Interventions | Planning, affectations, statuts, pause/reprise, pointage, carte et proximité terrain | `server/calendar.js`, `js/calendar.js`, `server/operations-map.js` |
| Documents commerciaux | Devis, factures, avoirs, modèles, PDF, émission légale et archives immuables | `server/billing.js`, `server/document-templates.js` |
| Comptabilité | Règlements, journaux, TVA, exports CSV/XLSX/PDF/FEC et contrôles | `server/accounting.js`, `server/accounting-ledger.js` |
| Facturation électronique | UBL, SUPER PDP, transmission, événements et factures fournisseurs entrantes | `server/electronic-invoicing.js`, `server/einvoice-lifecycle.js` |
| Achats | Registre des dépenses, TVA, justificatifs et rapprochement de factures entrantes | `server/purchases.js`, `js/purchases.js` |
| Rapports terrain | Rapports structurés, photos, verrou collaboratif, validation et archivage | `server/technical-reports.js`, `js/leak-report-wizard.js` |
| Partenaires | Missions, dialogue, annuaire, connexions, API, callbacks et bac à sable | `server/partner-missions.js`, `server/partner-dialogue.js` |
| Pilotage | Tableau opérationnel, CA mobile, marge brute estimée et consolidation Groupe | `js/navigation.js`, `server/billing.js`, `server/groups.js` |
| SaaS et sécurité | Rôles, postes, 2FA, multi-entreprises, abonnements, essais et audit | `server/auth.js`, `server/creator.js`, `server/organizations.js` |
| Exploitation | Sauvegarde vérifiée, restauration isolée, santé, incidents et tâches surveillées | `docs/DATABASE_OPERATIONS.md`, `server/health-dashboard.js` |
| Poste de travail | Onglets persistants et détachement par glissement gauche de tous les menus et sous-écrans vers un second écran | `js/desktop-workspace.js`, `js/navigation.js` |

## Écarts fonctionnels réels

### 1. Relation commerciale

La fiche client est solide, mais elle commence après l’acquisition. Il manque un cycle natif :

- prospect et source du contact ;
- opportunité, montant estimé, probabilité et prochaine action ;
- pipeline paramétrable par activité ;
- relances commerciales et motifs de perte ;
- conversion sans ressaisie vers client, devis puis intervention ;
- objectifs et taux de transformation par commercial.

### 2. Portail client, signature et encaissement

Les documents sont envoyés, mais aucun espace client autonome n’est démontré. Il manque :

- accès temporaire sécurisé sans compte complexe ;
- consultation des devis, factures, rapports et rendez-vous autorisés ;
- acceptation ou refus d’un devis avec piste de preuve ;
- signature électronique adaptée au niveau de preuve attendu ;
- paiement d’acompte ou de facture par lien ;
- suivi des demandes, messages et pièces jointes ;
- révocation des liens et journal des consultations.

### 3. Sites, parc installé et contrats

Le champ texte « équipements » d’un client ne constitue pas un parc maintenable. Il manque :

- plusieurs sites et contacts par client ;
- équipements structurés avec marque, modèle, série, date de pose et garantie ;
- photos, documents et interventions par équipement ;
- contrats de maintenance, périodicité, SLA, forfait et renouvellement ;
- génération préventive des interventions ;
- alertes de garantie, entretien ou fin de contrat.

### 4. Stock et logistique terrain

Le registre des achats n’est pas une gestion de stock. Il manque :

- articles, références, unités et fournisseurs ;
- dépôts, véhicules et emplacements ;
- mouvements, inventaires, transferts et corrections auditées ;
- réservation et consommation sur intervention ;
- seuils, propositions de réapprovisionnement et commandes fournisseur ;
- lecture code-barres ou QR ;
- valorisation cohérente du stock et coût matière par intervention.

### 5. Rentabilité réelle des interventions

La marge actuelle compare le chiffre d’affaires aux achats de période. Pour piloter chaque dossier, il manque :

- coût horaire chargé par rôle ou technicien ;
- temps prévu, pointé et facturable ;
- achats et sorties de stock imputés à l’intervention ;
- frais de déplacement et sous-traitance ;
- marge prévue puis réelle par intervention, client, activité et équipe ;
- écarts devis/réalisé et analyse des reprises/SAV.

### 6. Fournisseurs et cycle procure-to-pay

Les achats et factures entrantes existent, mais pas le cycle fournisseur complet :

- fiche fournisseur avec coordonnées, identifiants légaux et conditions ;
- demandes de prix et comparaison ;
- bons de commande et réception partielle ;
- rapprochement commande/réception/facture ;
- échéancier et préparation des règlements ;
- évaluation qualité, délai et litiges.

### 7. Gestion du personnel

Le pointage d’intervention existe, mais pas la gestion RH :

- disponibilités, absences, congés et astreintes ;
- compétences, habilitations et dates d’expiration ;
- notes de frais avec justificatifs et validation ;
- export des temps et variables vers un logiciel de paie ;
- charge/capacité des équipes.

La paie complète doit rester une intégration avec un produit spécialisé, pas devenir un moteur réglementaire interne.

### 8. Trésorerie et relances

Les règlements et échéances sont présents. Les compléments prioritaires sont :

- relances automatiques graduées avant et après échéance ;
- promesses de paiement et litiges ;
- lien de paiement et webhooks signés ;
- import ou connexion bancaire pour rapprochement assisté ;
- prévision de trésorerie basée sur échéances clients et fournisseurs ;
- export SEPA lorsqu’il est pertinent.

### 9. Automatisations transverses

Des tâches et outbox spécialisées existent, mais pas de moteur métier commun. Il manque :

- événements normalisés et transactionnels ;
- règles « déclencheur + conditions + actions » ;
- modèles prêts à l’emploi ;
- actions de notification, e-mail, tâche, statut et webhook ;
- temporisation, idempotence, reprise et journal d’exécution ;
- mode simulation avant activation.

### 10. API, données et pilotage

Les API internes et partenaires sont nombreuses, mais une plateforme publique unifiée reste à construire :

- OpenAPI versionnée ;
- OAuth2 ou clés à portée limitée, rotation et quotas ;
- webhooks produit homogènes ;
- imports/exports planifiés ;
- tableaux personnalisables, budgets et prévisions ;
- indicateurs de conversion, récurrence, SLA, marge et satisfaction.

## Priorités recommandées

## P0 — chaîne commerciale et encaissement (0 à 3 mois)

### P0.1 — Portail client documentaire

**Valeur :** réduction des appels et des renvois manuels, image professionnelle.

**Périmètre MVP :**

1. lien à jeton opaque, expirant, révocable et limité à un dossier ;
2. consultation/téléchargement des seuls documents explicitement publiés ;
3. acceptation ou refus du devis avec identité, date, IP et empreinte du PDF ;
4. historique visible par l’entreprise ;
5. tests d’isolation entre entreprises et clients.

**Critère de sortie :** un client ouvre un devis, l’accepte et l’entreprise retrouve la preuve sans qu’aucune autre donnée du dossier soit exposée.

### P0.2 — Paiement en ligne et acomptes

**Dépendance :** portail client.

**Périmètre MVP :**

1. un seul prestataire de paiement documenté ;
2. lien de paiement pour acompte ou solde ;
3. webhook signé, idempotent et rattaché au bon `owner_id` ;
4. création automatique du règlement existant ;
5. rapprochement comptable et reçu ;
6. remboursement/annulation audités.

**Critère de sortie :** un paiement reçu met à jour une seule fois la facture et son journal, même si le webhook est rejoué.

### P0.3 — CRM prospect vers intervention

**Périmètre MVP :** prospect, opportunité, étape, prochaine action, montant, commercial, conversion vers client et devis.

**Critère de sortie :** aucune ressaisie entre la demande initiale, le client, le devis accepté et l’intervention planifiée.

## P1 — maîtrise opérationnelle (3 à 6 mois)

### P1.1 — Sites, équipements et contrats de maintenance

Créer d’abord le modèle `client → sites → équipements → contrats`, puis rattacher planning, rapports, documents et historique à ces identifiants.

**Critère de sortie :** l’historique complet d’un équipement suit son numéro de série même après plusieurs interventions.

### P1.2 — Coût et marge par intervention

Réutiliser les sessions de travail, achats et documents existants. Ajouter les coûts horaires versionnés et les imputations matière/frais.

**Critère de sortie :** la somme du détail explique exactement la marge affichée, avec distinction entre estimation et réalisé.

### P1.3 — Stock léger multi-emplacements

Commencer par articles, dépôts/véhicules, mouvements et consommation intervention. Reporter la gestion avancée des commandes après fiabilisation des mouvements.

**Critère de sortie :** aucun stock négatif non autorisé ; chaque correction possède un auteur, une raison et une date.

### P1.4 — Relances clients et trésorerie courte

Ajouter scénarios de relance, promesses de paiement et vue des encaissements attendus sur 13 semaines.

## P2 — automatisation et gestion interne (6 à 12 mois)

1. moteur de règles métier commun et outbox généralisée ;
2. fournisseurs, bons de commande, réception et rapprochement à trois voies ;
3. absences, compétences, habilitations et notes de frais ;
4. connexion bancaire et rapprochement assisté ;
5. API publique OpenAPI et webhooks homogènes ;
6. tableaux dirigeant personnalisables et budgets.

## P3 — différenciation (12 mois et plus)

1. application native compagnon pour le suivi en arrière-plan et l’offline renforcé ;
2. optimisation automatique des tournées sous contrôle humain ;
3. prévision de charge, trésorerie et chiffre d’affaires ;
4. maintenance prédictive lorsque suffisamment de données fiables existent ;
5. signature électronique avec prestataire de confiance si le marché l’exige ;
6. portail marque blanche et accès dédiés donneurs d’ordre/clients récurrents.

## Ordre de dépendance

```text
CRM ───────────────┐
                   ├─> Portail client ─> Signature/acceptation ─> Paiement
Clients ─> Sites ─> Équipements ─> Contrats ─> Maintenance préventive
Planning ─> Pointage ─┐
Achats ─> Stock ──────┼─> Coût réel ─> Marge intervention ─> BI
Frais ────────────────┘
Événements métier ─> Outbox commune ─> Automatisations ─> API/Webhooks
```

## Fondations techniques à préserver ou renforcer

### Isolation et autorisations

- toute nouvelle table métier porte `owner_id` et des index tenant/objet ;
- l’autorisation est contrôlée côté serveur, jamais seulement par le menu ;
- un lien public utilise un jeton opaque haché et une portée minimale ;
- chaque mutation sensible est auditée.

### Cohérence transactionnelle

- l’émission légale, les paiements, mouvements de stock et conversions commerciales sont transactionnels ;
- les appels externes passent par une outbox avec idempotence et reprise ;
- les calculs financiers sont figés dans des instantanés versionnés.

### Tâches de fond

Les minuteurs en processus conviennent au socle actuel, mais les automatisations et relances nécessiteront une file durable avec verrou de leadership, reprise après redémarrage et visibilité dans le tableau Santé.

### Fichiers et stockage

Avant le portail et le parc installé, définir une stratégie de stockage objet chiffré avec antivirus, quotas, empreintes, rétention et sauvegarde. PostgreSQL conserve les métadonnées et références ; les fichiers volumineux ne doivent pas faire croître indéfiniment la base.

### Qualité produit

Chaque nouveau module doit fournir :

- migrations additive et réversible lorsque possible ;
- tests unitaires, API, isolation tenant et parcours utilisateur ;
- prise en charge des rôles, appareils et offres ;
- audit, export et politique de rétention ;
- affichage desktop/mobile et accessibilité clavier ;
- documentation d’exploitation et critères de reprise.

## Fonctions à intégrer plutôt qu’à reconstruire

| Domaine | Décision recommandée |
| --- | --- |
| Paiement | Intégrer un PSP ; ne jamais stocker les cartes |
| Signature à forte valeur probante | Intégrer un prestataire de confiance |
| Paie et déclarations sociales | Export/API vers un logiciel de paie |
| Banque | Agrégateur agréé ou imports normalisés |
| SMS | Fournisseur documenté avec consentement et opt-out |
| Cartographie/routage | Conserver des fournisseurs cartographiques documentés |
| Facturation électronique | Étendre uniquement par adaptateurs officiels |

## Indicateurs de succès

- délai demande → devis envoyé ;
- taux devis accepté et motif de perte ;
- délai devis accepté → intervention ;
- taux de paiement à échéance et délai moyen d’encaissement ;
- interventions réalisées du premier coup ;
- temps prévu contre temps pointé ;
- marge réelle par intervention et activité ;
- disponibilité des pièces au premier passage ;
- respect des SLA de contrat ;
- satisfaction client après intervention ;
- temps administratif économisé par automatisation.

## Prochaine livraison recommandée

Le premier lot doit être **Portail client documentaire + acceptation de devis**, car il réutilise les documents, archives, e-mails et audits existants, améliore immédiatement l’expérience client et fournit la fondation technique du paiement en ligne. Le CRM peut être conçu en parallèle, mais sa mise en production doit rester découpée afin de ne pas fragiliser la chaîne financière déjà mature.
