# Audit fonctionnel complet — Console Créateur

**Date :** 8 octobre 2026  
**Périmètre :** Console Créateur, API associées, facturation plateforme, sécurité et intégrations  
**Environnement :** serveur local `127.0.0.1:3108`, PostgreSQL isolé dans le schéma `audit_general_20261008`

## Synthèse

La Console Créateur a été parcourue et manipulée de bout en bout avec des données fictives : création d’entreprise, cycle d’abonnement, gestion des postes, facturation, assistance, demandes, partenaires, stockage, réseau, santé, sécurité, connecteurs et sandboxes.

Résultat final :

- les 19 espaces de l’en-tête Créateur s’ouvrent correctement ;
- les principaux parcours de création, modification, transition, génération, téléchargement et suppression ont été exécutés ;
- quatre défauts reproductibles ont été corrigés ;
- la suite complète passe avec **849 tests réussis sur 849** ;
- les diagnostics de l’éditeur et les contrôles de syntaxe ne signalent aucune erreur ;
- aucun e-mail ni appel PDP réel n’a été volontairement émis.

## Méthode et garde-fous

- Base PostgreSQL dédiée et isolée de la production.
- Compte Créateur et entreprise fictive réservés à l’audit.
- Adresses e-mail et URL métier en `.invalid`.
- SMTP dirigé vers `127.0.0.1:9` afin de contrôler les échecs sans livraison externe.
- Sandbox API partenaire dirigée vers le serveur local sur le port 3108.
- Secrets affichés une seule fois non consignés dans ce rapport.
- Tests SUPER PDP distants non lancés, car l’adaptateur cible le service officiel.
- Les fichiers commerciaux DOCX/PDF sans rapport avec l’audit ont été laissés hors des changements livrés.

## Couverture fonctionnelle

| Domaine | Scénarios réalisés | Résultat |
|---|---|---|
| Navigation | Ouverture des 19 espaces Créateur, retours, listes et fiches | Conforme |
| Entreprises | Création Pro, modification du profil et des capacités, suspension, réactivation, archivage, restauration | Conforme |
| Essai et abonnement | Activation à la création, renouvellement d’essai, conversion en abonnement payant | Conforme |
| Postes | Création PC/mobile, modification, désactivation, réactivation, suppression, blocage à la limite de sièges | Conforme |
| Stockage | Mesure, affichage des alertes et quota porté à 3,5 Gio | Conforme |
| Réseau | Modification, archivage et restauration du profil, disponibilité pour les missions | Conforme |
| Affichage général | Publication puis masquage d’une annonce plateforme | Conforme |
| Facturation plateforme | Profil légal, facture de cycle, PDF, paiement, facture acquittée, avoir partiel, PDF d’avoir, remboursement | Conforme |
| Prorata | Ajout d’un poste mobile, calcul remisé, facture complémentaire de 13,50 € | Conforme après correction |
| Traitement des factures | Relance manuelle, reprise idempotente d’une facture en échec | Conforme ; échec SMTP local attendu |
| Assistance | Demande, consentement entreprise, diagnostic, prise en main, sortie, clôture et révocation | Conforme |
| Notifications | Agrégation simultanée offre/support/partenariat, traitement et retour à zéro | Conforme |
| Demandes d’offres | Création depuis l’entreprise, traitement Créateur et clôture sans modification d’abonnement | Conforme |
| Support | Création depuis l’entreprise, contexte technique, note interne et clôture | Conforme |
| Partenariats | Création publique, consultation, acceptation, conversion en partenaire officiel et suppression de la demande | Conforme |
| Partenaires officiels | Création, modification et suppression manuelles | Conforme |
| Catalogue e-facturation | Création, modification, capacités, statut suspendu, détection d’absence d’adaptateur | Conforme après correction HTML |
| Suivi e-facturation | Synthèse globale et vue d’entreprise sans secret | Conforme |
| SUPER PDP plateforme | Consultation du coffre séparé et état non connecté | Conforme en lecture |
| Sandbox SUPER PDP | Validation d’identifiants distincts, chiffrement, réponse sans secret et suppression | Conforme ; test distant volontairement non lancé |
| Sandbox API partenaire | Provisionnement, clé à affichage unique, mission HTTP locale, callbacks, statuts, scénario 401, rotation et remise à zéro | Conforme |
| Connecteurs externes | Création désactivée, modification et suppression, sans test réseau | Conforme |
| Santé système | Diagnostic de 15 contrôles, 11 réussites et 4 avertissements attendus ; résolution des incidents corrigés | Conforme |
| Sécurité 2FA | Enrôlement Créateur, QR code, confirmation TOTP et désactivation contrôlée | Conforme |
| Contrôles d’accès | Entreprise refusée en 403, anonyme ramené à 401, Créateur mobile refusé, desktop autorisé | Conforme après correction |

## Données de validation principales

### Entreprise fictive

- Nom : `Audit Console Créateur 2026`
- Offre : Pro payante
- Capacité finale : 2 postes administratifs et 3 postes mobiles
- Remise : 10 %, libellé `Remise audit`
- Quota : 3,5 Gio
- Profil réseau visible et disponible pour les missions

### Facturation

- `DHP-2026-000001` : 153,00 €, paiement `VIR-AUDIT-20261008`
- `AVO-DHP-2026-000001` : avoir partiel de 53,00 €, remboursement `REM-AUDIT-20261008`
- `DHP-2026-000002` : complément prorata de 13,50 €
- Les erreurs `ECONNREFUSED 127.0.0.1:9` sont attendues et prouvent l’absence de livraison SMTP externe.

### Sandbox partenaire

- Une mission fictive a été acceptée, passée en cours puis terminée.
- Les statuts ont produit trois callbacks locaux livrés avec succès.
- Le scénario d’erreur 401 a été reproduit et journalisé sans exposer la clé.
- La clé a été renouvelée, puis la sandbox a été réinitialisée.
- La remise à zéro a supprimé sa configuration, ses missions, clients, historiques, messages, outbox et journaux de test.

## Défauts découverts et corrigés

### 1. Faux brouillon après un enregistrement Créateur

**Symptôme :** après une mutation réussie, l’onglet restait marqué « Modifications non enregistrées ».

**Cause :** le module Créateur ne notifiait jamais l’espace de travail desktop après ses appels API mutatifs.

**Correction :** nettoyage central du brouillon après toute réponse réussie non `GET`/`HEAD`, et nettoyage explicite lors de l’annulation d’une fiche e-facturation.

**Validation dynamique :** indicateur présent avant sauvegarde, absent après réponse HTTP 200/201/204.

### 2. Échec PostgreSQL lors d’un prorata

**Symptôme :** augmentation de capacité en erreur 500 avec PostgreSQL `42P08`, détail `date versus text`.

**Cause :** le paramètre SQL `$1` était déduit à la fois comme texte et comme date.

**Correction :** conversion explicite avec `TO_CHAR($1::date,'YYYY-MM-DD')`.

**Validation dynamique :** passage de 2 à 3 postes mobiles et génération correcte de la facture prorata de 13,50 €.

### 3. Validation HTML invalide du code plateforme

**Symptôme :** Chromium signalait que le motif `[a-z0-9][a-z0-9_-]{1,59}` était invalide avec la syntaxe Unicode `v`.

**Cause :** tiret non échappé dans une classe de caractères HTML moderne.

**Correction :** motif généré `[a-z0-9][a-z0-9_\-]{1,59}`.

**Validation dynamique :** le code `audit-code_ok` est reconnu valide sans erreur de compilation du motif.

### 4. Statut incorrect pour un accès Créateur anonyme

**Symptôme :** une requête sans session recevait 403 comme un utilisateur authentifié sans rôle Créateur.

**Cause :** `requireCreator` ne déléguait pas l’absence d’utilisateur à `requireAuthentication`.

**Correction :** réponse 401 commune pour l’anonyme, 403 conservé pour une entreprise authentifiée ou un Créateur sur mobile.

**Validation :** tests unitaires couvrant anonyme, session remplacée, entreprise, mobile Créateur et desktop Créateur.

## Points de vigilance non bloquants

### Test officiel SUPER PDP non isolable

L’adaptateur utilise actuellement l’origine officielle `https://api.superpdp.tech`. Une variable locale simulant l’origine n’est pas consommée. Le bouton de test aurait donc envoyé les identifiants fictifs au service réel ; il n’a pas été actionné.

**Recommandation :** prévoir une origine substituable uniquement dans un mode de test strict, avec refus de démarrage en production si elle diffère de l’origine officielle.

### Anti-rejeu des codes TOTP

Les défis de connexion sont consommés une seule fois, mais le pas temporel TOTP accepté n’est pas mémorisé dans l’authentificateur. Le même code peut donc être accepté par deux défis distincts pendant sa fenêtre de validité.

**Recommandation :** stocker atomiquement le dernier pas TOTP accepté pour les authentificateurs Créateur et entreprise, et refuser tout pas inférieur ou égal. Cette évolution nécessite une migration et des tests PostgreSQL concurrents ; elle n’a pas été intégrée silencieusement dans cet audit fonctionnel.

### Partenaire issu d’une demande acceptée

La conversion d’une demande acceptée crée volontairement une fiche partenaire officielle durable. Après suppression de la demande, l’API protège cette fiche contre une suppression immédiate. La fiche fictive reste uniquement dans le schéma d’audit isolé.

## Validation automatisée

Commande de validation globale : `npm run check`.

Résultat final :

- **849 tests** ;
- **849 réussis** ;
- **0 échec** ;
- **0 test ignoré ou annulé** ;
- contrôles `node --check` réussis ;
- diagnostics éditeur : aucune erreur sur les fichiers modifiés.

Une première exécution PostgreSQL a été involontairement forcée en lecture seule par l’outil d’inspection de l’audit ; elle a été relancée avec le `PGOPTIONS` normal du schéma isolé et tous les tests ont alors réussi.

## Conclusion

La Console Créateur est fonctionnelle sur l’ensemble du périmètre audité. Les parcours critiques de gestion d’entreprise, sièges, abonnement, facturation, assistance, demandes, sécurité et intégrations sont cohérents et correctement isolés. Les quatre défauts fonctionnels reproduits ont été corrigés et couverts par des tests. Les deux améliorations de sécurité/testabilité restantes sont explicites et ne remettent pas en cause les parcours validés localement.
