# Double authentification des postes PC

## Portée

La double authentification TOTP est une protection personnelle et optionnelle accessible dans **Paramètres → Sécurité** à chaque compte connecté depuis un ordinateur avec l’un des rôles suivants :

- Poste Admin (`admin`) ;
- Poste administratif (`pc_standard`) ;
- Commercial / Chargé d’affaires (`commercial`).

Chaque compte active, configure et désactive uniquement sa propre protection. La configuration est indépendante des autres postes, de l’offre active et de l’entreprise sélectionnée dans un groupe ou une organisation multi-entreprises.

Un Commercial utilisant aussi un téléphone ne reçoit le défi TOTP que lors de ses connexions sur ordinateur. Le 2FA du compte Créateur reste une implémentation distincte.

## Modèle de données

- `depannhome_company_totp_authenticators` contient les authentificateurs individuels liés à `user_id` ;
- `depannhome_company_totp_challenges` contient les défis de connexion à durée limitée ;
- `depannhome_company_totp_policies` est une table historique conservée pour compatibilité, mais n’est plus utilisée pour décider si un compte doit présenter un code.

Les secrets TOTP sont chiffrés en AES-256-GCM avec une clé dérivée de `SESSION_SECRET` et d’un contexte dédié `company-totp:v1`. Les codes à six chiffres ne sont jamais persistés.

## Activation personnelle

1. Le titulaire ouvre **Paramètres → Sécurité** depuis son poste PC.
2. Il demande la configuration de son application d’authentification.
3. Il scanne le QR code avec Google Authenticator, Microsoft Authenticator, Authy ou une application TOTP compatible.
4. Il confirme un premier code à six chiffres.
5. Les connexions desktop suivantes de ce compte exigent le mot de passe puis un code TOTP.

La désactivation exige également un code TOTP valide. Aucun Poste Admin ne peut activer, désactiver ou réinitialiser la protection d’un autre compte.

Les codes TOTP ont une période de 30 secondes ; une fenêtre d’un intervalle est tolérée pour les décalages d’horloge. Les défis expirent après cinq minutes, sont utilisables une seule fois et sont limités à cinq codes invalides.

## Perte de l’authentificateur

Si le titulaire perd son application et ne possède plus de session ouverte, une intervention contrôlée du Support est nécessaire. Ce mécanisme de récupération est audité et reste distinct de l’administration courante de l’entreprise.

## Journalisation

Les événements sont enregistrés dans `depannhome_member_audit` :

- `workstation_2fa_enabled` ;
- `workstation_2fa_disabled` ;
- `workstation_2fa_login_succeeded` ;
- `workstation_2fa_validation_failed`.

Les audits restent rattachés à l’entreprise et visibles via les mécanismes d’administration existants.
