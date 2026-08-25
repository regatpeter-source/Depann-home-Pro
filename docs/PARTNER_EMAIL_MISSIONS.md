# Missions partenaires reçues par e-mail

La **Boîte mail professionnelle** transforme les demandes d’intervention reçues par e-mail en missions partenaires à valider. Elle utilise la même capacité d’abonnement `partnerMissions` que le reste du module (Basic+ et Pro), sans exiger l’option Pro des connecteurs API.

## Fournisseurs et authentification

- **Microsoft 365, Outlook, Hotmail, Live et MSN**, y compris les comptes personnels : OAuth 2.0 avec PKCE ;
- **Google Workspace / Gmail**, y compris les comptes personnels : OAuth 2.0 avec PKCE ;
- **OVH et autres hébergeurs** : IMAP/SMTP sécurisé avec un mot de passe d’application.

Les jetons et mots de passe d’application sont chiffrés côté serveur en AES-256-GCM avec la clé dérivée de `SESSION_SECRET`. Ils ne sont jamais renvoyés au navigateur. Pour OAuth, déclarer les six variables `GOOGLE_MAIL_*` et `MICROSOFT_MAIL_*` documentées dans `.env.example`, avec des URI de retour strictement identiques chez les fournisseurs.

Le « mot de passe d’application » n’est jamais le mot de passe habituel de la boîte : il s’agit d’un secret distinct généré dans les réglages de sécurité du fournisseur. Outlook.com et Hotmail imposent désormais OAuth2/Modern Auth et ne doivent donc pas être configurés dans le formulaire IMAP/SMTP manuel. Pour accepter les comptes Microsoft personnels, l’application Microsoft Entra doit autoriser « les comptes dans un annuaire d’organisation et les comptes Microsoft personnels ».

### Configuration Microsoft Entra et Render

- Type de compte : **Comptes dans un annuaire d’organisation et comptes Microsoft personnels**.
- Plateforme d’authentification : **Web**, avec l’URI exacte `https://depannhomepro.com/api/partner-email/oauth/microsoft/callback`.
- Autorisations déléguées : `User.Read`, `IMAP.AccessAsUser.All` et `SMTP.Send`, avec consentement accordé lorsque l’organisation l’exige.
- `MICROSOFT_MAIL_CLIENT_ID` : **ID d’application (client)** de l’inscription Entra.
- `MICROSOFT_MAIL_CLIENT_SECRET` : colonne **Valeur** du secret client, jamais son « ID du secret ». Cette valeur n’est visible qu’à la création du secret.
- `MICROSOFT_MAIL_REDIRECT_URI` : `https://depannhomepro.com/api/partner-email/oauth/microsoft/callback`, strictement identique à l’URI Web Entra.

Après toute modification d’une variable Render, redéployer le service puis lancer une nouvelle connexion : un code d’autorisation Microsoft est à usage unique et expire rapidement.

## Deux modes de traitement

La source e-mail utilise la même interface métier que les missions internes du réseau et les missions externes reçues par API : mêmes onglets **Missions reçues** et **Messagerie**, mêmes cartes, filtres, statuts, actions de validation, planification et Centre de mission. Les e-mails détectés mais non encore importés apparaissent dans cette liste commune avec le statut **À confirmer**.

La configuration OAuth ou IMAP/SMTP d’une boîte professionnelle se trouve exclusivement dans **Paramètres → Réseau**. Si aucune boîte n’est connectée, **Missions partenaires** affiche un rappel avec un accès direct à cette section. Dès qu’une boîte existe, le rappel disparaît et seule l’action opérationnelle **Synchroniser** reste proposée dans les missions.

### Sélection manuelle

Chaque nouvel e-mail apparaît dans **E-mails à vérifier** avec son expéditeur, un extrait, ses pièces, un score et les raisons du classement. L’entreprise choisit explicitement les messages à transformer en missions ou à ignorer.

### Détection automatique stricte

Un message n’est importé automatiquement que s’il remplit les deux conditions suivantes :

1. son score atteint le seuil configuré, compris entre 70 et 100 ;
2. son adresse ou son domaine appartient à la liste des expéditeurs autorisés par l’entreprise.

Même dans ce mode, la mission est créée avec le statut `pending_validation`. Elle doit donc suivre la validation métier habituelle avant planification.

## Classification explicable

Le score augmente notamment avec :

- les termes mission, intervention, sinistre, dossier ou ordre de service ;
- la présence de coordonnées client, d’une adresse ou d’une référence ;
- une pièce métier autorisée ;
- un expéditeur autorisé.

Il diminue fortement pour les relances de paiement, newsletters, réponses automatiques, absences, listes de diffusion et adresses `no-reply`. Un expéditeur inconnu ne peut jamais franchir automatiquement le seuil : le motif « Validation humaine requise » reste visible.

## Documents et confidentialité

Les formats admis sont PDF, JPEG, PNG, WebP, Word, Excel et texte brut, avec une limite de 5 Mo par fichier, 10 fichiers et 20 Mo cumulés par message. Les logos et pièces non conformes sont ignorés. Les documents retenus sont ajoutés à la fiche client et au journal de mission avec une visibilité **interne** par défaut.

Lors de l’import, Depann’Home Pro lit le texte brut, les PDF contenant une couche texte, les documents DOCX et les classeurs XLSX. Il recherche les coordonnées du client (nom, prénom, téléphone, e-mail, adresse, code postal et ville) ainsi que les références utiles du dossier (mission, sinistre, assureur, expert et gestionnaire). Dans les documents prestataires, le client est identifié par le libellé **Assuré / Assurée** : cette identité est toujours prioritaire sur un éventuel champ générique « Client », qui peut désigner la plateforme ou le donneur d’ordre. Pour les autres données, les valeurs clairement indiquées dans l’e-mail restent prioritaires et les pièces jointes complètent les champs manquants. La fiche est ensuite rapprochée d’un client existant par e-mail, téléphone ou couple nom/adresse, puis créée automatiquement si aucun client ne correspond. Le nom de l’expéditeur n’est jamais utilisé comme nom du client lorsqu’aucun assuré n’a pu être identifié.

Les anciens fichiers DOC/XLS restent conservés comme pièces mais leur contenu n’est pas interprété. Les images et PDF scannés sans couche texte ne font pas l’objet d’un OCR : ils sont archivés normalement et l’import continue avec les informations disponibles. Une pièce corrompue ou illisible ne bloque jamais la création de la mission. Les volumes décompressés, pages PDF, cellules et caractères analysés sont bornés côté serveur.

Un e-mail est dédupliqué avec son identifiant RFC `Message-ID` dans la boîte concernée. Depann’Home Pro ne supprime et ne marque pas automatiquement le message sur le serveur d’origine.

## Réponses et statuts

Une mission importée conserve `Message-ID`, `In-Reply-To` et `References`. L’entreprise peut répondre depuis la carte de mission ; le message est envoyé avec sa propre boîte dans le fil d’origine. Si elle active les retours automatiques, les changements de statut sont envoyés de la même façon. Une panne SMTP ne bloque jamais la mise à jour du statut dans Depann’Home Pro.

## Exploitation

Le planificateur contrôle au maximum 20 connexions dues toutes les cinq minutes, chaque connexion étant synchronisée au plus toutes les dix minutes. Une synchronisation manuelle est disponible dans l’interface. Les erreurs exposées à l’utilisateur sont volontairement génériques afin de ne révéler ni serveur interne ni identifiant secret.
