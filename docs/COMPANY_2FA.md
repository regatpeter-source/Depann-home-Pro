# Double authentification des entreprises

## Portée

La double authentification (2FA) d’entreprise est une protection TOTP optionnelle, activée par un **Poste Admin** dans **Paramètres → Sécurité**. Elle concerne uniquement les comptes dont le rôle est `admin`.

Elle ne change pas les flux d’accès des Postes Admin Mobile, Postes administratifs, Techniciens ou Chefs d’équipe, ni l’activation existante des smartphones.

Le 2FA du compte Créateur reste une implémentation distincte, inchangée et prioritaire pour les comptes Créateur.

## Modèle de données

- `depannhome_company_totp_policies` : choix d’activation par entreprise (`owner_id`).
- `depannhome_company_totp_authenticators` : authentificateurs individuels. La table est volontairement séparée de la politique : une évolution peut ajouter plusieurs appareils ou des méthodes de secours sans refaire le modèle.
- `depannhome_company_totp_challenges` : challenges de connexion/enrôlement à durée limitée, avec nombre de tentatives et consommation unique.

Les secrets TOTP sont chiffrés en AES-256-GCM avec une clé dérivée de `SESSION_SECRET` et d’un contexte dédié `company-totp:v1`. Les codes à six chiffres ne sont jamais persistés.

## Flux

1. Un Poste Admin active la politique entreprise.
2. À la prochaine connexion d’un Poste Admin, après identifiant et mot de passe, le serveur présente un QR code et une clé manuelle.
3. L’administrateur scanne le QR code avec Google Authenticator, Microsoft Authenticator, Authy ou une application TOTP compatible, puis confirme son premier code.
4. Aux connexions suivantes, le TOTP est requis après le mot de passe.

Les codes TOTP ont une période de 30 secondes ; une fenêtre d’un intervalle est tolérée pour les décalages d’horloge. Les challenges expirent après cinq minutes, sont utilisables une seule fois et sont limités à cinq codes invalides. Les endpoints de vérification sont également protégés par le limiteur de débit d’authentification global.

## Réinitialisation

Tout Poste Admin authentifié peut réinitialiser l’authentificateur d’un autre Poste Admin de sa propre entreprise depuis la section Sécurité. L’authentificateur est supprimé ; le titulaire recevra un nouveau QR code à sa prochaine connexion.

Cette première version ne fournit volontairement ni code de secours ni deuxième appareil. Si tous les Postes Admin perdent simultanément leur application et aucune session ne reste active, une intervention du support reste nécessaire. Le modèle de table permet l’ajout ultérieur de ces mécanismes sans migration conceptuelle.

## Journalisation

Les événements sont enregistrés dans `depannhome_member_audit` :

- `company_2fa_enabled` / `company_2fa_disabled` ;
- `company_2fa_configured` ;
- `company_2fa_reset` ;
- `company_2fa_validation_failed` ;
- `company_2fa_login_succeeded`.

Les audits restent rattachés à l’entreprise et visibles via les mécanismes d’administration existants.
