# Missions partenaires reçues par e-mail

La **Boîte mail professionnelle** transforme les demandes d’intervention reçues par e-mail en missions partenaires à valider. Elle utilise la même capacité d’abonnement `partnerMissions` que le reste du module (Basic+ et Pro), sans exiger l’option Pro des connecteurs API.

## Fournisseurs et authentification

- **Microsoft 365, Outlook, Hotmail, Live et MSN**, y compris les comptes personnels : OAuth 2.0 avec PKCE et Microsoft Graph, sans IMAP/SMTP ;
- **Google Workspace** : OAuth 2.0 avec PKCE et Gmail API, sans IMAP/SMTP ;
- **Gmail personnel** : parcours simplifié IMAP/SMTP avec mot de passe d’application Google, après activation de la validation en deux étapes ;
- **OVH et autres hébergeurs** : IMAP/SMTP sécurisé avec un mot de passe d’application.

Les jetons et mots de passe d’application sont chiffrés côté serveur en AES-256-GCM avec la clé dérivée de `SESSION_SECRET`. Ils ne sont jamais renvoyés au navigateur. Pour OAuth, déclarer les six variables `GOOGLE_MAIL_*` et `MICROSOFT_MAIL_*` documentées dans `.env.example`, avec des URI de retour strictement identiques chez les fournisseurs.

Google Workspace demande uniquement `openid`, `email`, `profile`, `https://www.googleapis.com/auth/gmail.readonly` et `https://www.googleapis.com/auth/gmail.send`. Gmail API sert à lister et lire les messages et leurs pièces, puis à envoyer les seules réponses demandées. Depann’Home Pro n’appelle aucune opération Gmail de modification, déplacement ou suppression et ne marque jamais un message comme lu.

Le « mot de passe d’application » n’est jamais le mot de passe habituel de la boîte : il s’agit d’un secret distinct généré dans les réglages de sécurité du fournisseur. Pour une adresse `@gmail.com`, l’interface préremplit `imap.gmail.com:993` et `smtp.gmail.com:465` puis normalise le code Google de 16 caractères. Outlook.com et Hotmail imposent OAuth2/Modern Auth et ne doivent donc pas être configurés dans le formulaire IMAP/SMTP manuel. Pour accepter les comptes Microsoft personnels, l’application Microsoft Entra doit autoriser « les comptes dans un annuaire d’organisation et les comptes Microsoft personnels ».

### Configuration Microsoft Entra et Render

- Type de compte : **Comptes dans un annuaire d’organisation et comptes Microsoft personnels**.
- Plateforme d’authentification : **Web**, avec l’URI exacte `https://depannhomepro.com/api/partner-email/oauth/microsoft/callback`.
- Autorisations Microsoft Graph déléguées : `User.Read`, `Mail.Read` et `Mail.Send`, avec consentement accordé lorsque l’organisation l’exige. Les anciennes permissions `IMAP.AccessAsUser.All` et `SMTP.Send` ne sont plus utilisées.
- `MICROSOFT_MAIL_CLIENT_ID` : **ID d’application (client)** de l’inscription Entra.
- `MICROSOFT_MAIL_CLIENT_SECRET` : colonne **Valeur** du secret client, jamais son « ID du secret ». Cette valeur n’est visible qu’à la création du secret.
- `MICROSOFT_MAIL_REDIRECT_URI` : `https://depannhomepro.com/api/partner-email/oauth/microsoft/callback`, strictement identique à l’URI Web Entra.

Après toute modification d’une variable Render, redéployer le service puis lancer une nouvelle connexion : un code d’autorisation Microsoft est à usage unique et expire rapidement.

## Deux modes de traitement

La source e-mail utilise la même interface métier que les missions internes du réseau et les missions externes reçues par API : mêmes onglets **Missions reçues** et **Messagerie**, mêmes cartes, filtres, statuts, actions de validation, planification et Centre de mission. Les e-mails détectés mais non encore importés apparaissent dans cette liste commune avec le statut **À confirmer**.

La configuration OAuth ou IMAP/SMTP d’une boîte professionnelle se trouve exclusivement dans **Paramètres → Entreprise · Boîte mail**. Cet espace permet d’activer, pour chaque connexion, la **recherche automatique des missions**. Lorsque cette case est décochée, Depann’Home Pro ne consulte pas périodiquement la boîte ; la recherche manuelle par dates reste disponible dans **Missions partenaires → Boîte mail professionnelle**. Si aucune boîte n’est connectée, **Missions partenaires** affiche un rappel avec un accès direct à cette section.

L’entreprise peut également ouvrir **Consulter les e-mails** pour parcourir toute sa boîte de réception. Cette consultation est directe et paginée : 30 messages sont demandés à la fois, avec un maximum technique de 50. Seuls les en-têtes sont chargés dans la liste ; le corps est demandé à l’ouverture et chaque pièce jointe uniquement lorsque l’utilisateur clique dessus. Les e-mails ordinaires consultés ne sont jamais copiés dans PostgreSQL, ne déplacent pas le curseur de recherche des missions et ne deviennent pas des candidats. Seuls les messages reconnus comme missions restent enregistrés dans le flux métier.

### Sélection manuelle

Après **Rechercher les missions**, les propositions de la boîte concernée apparaissent immédiatement sous celle-ci dans **Espace e-mail** avec leur expéditeur, un extrait, leurs pièces, leur score et les raisons du classement. Elles sont cochées par défaut en mode manuel. L’entreprise peut valider la sélection vers **Missions partenaires → E-mail** ou la supprimer.

Chaque proposition dispose d’actions **Confirmer** et **Supprimer**. Les cases permettent d’en sélectionner plusieurs, puis de confirmer ou supprimer toute la sélection. Supprimer une proposition empêche uniquement la création de la mission dans Depann’Home Pro : l’e-mail reste intact dans la boîte connectée.

La liste facultative des **adresses ou domaines partenaires recherchés** est un filtre strict dans les deux modes. Dès qu’elle contient une valeur, les messages des autres expéditeurs sont écartés. Lorsqu’elle est vide, la recherche reste ouverte à tous les expéditeurs et la sélection manuelle s’appuie sur les autres critères. Dans **Missions partenaires → Espace e-mail**, chaque boîte affiche ses critères enregistrés ; un Poste Admin peut y modifier à tout moment les expéditeurs, domaines et mots-clés, puis les enregistrer directement pour cette boîte.

### Détection automatique stricte

Un message n’est importé automatiquement que s’il remplit les deux conditions suivantes :

1. son score atteint le seuil configuré, compris entre 70 et 100 ;
2. son adresse ou son domaine appartient à la liste des expéditeurs autorisés par l’entreprise.

Même dans ce mode, la mission est créée avec le statut `pending_validation`. Elle doit donc suivre la validation métier habituelle avant planification.

## Classification explicable

Chaque boîte peut définir des **mots-clés obligatoires**. Les expressions alternatives sont séparées par une virgule ou une ligne ; tous les mots d’une expression doivent être présents dans l’objet ou le nouveau contenu du message. Par exemple, `mission partenaire IMH` exige la présence des trois mots, sans tenir compte des majuscules ni des accents. Lors de l’enregistrement, les propositions encore en attente qui ne correspondent plus sont retirées automatiquement.

Les réponses à un fil existant et leur historique cité ne créent jamais une nouvelle proposition de mission. Une signature, une adresse, un numéro de téléphone ou une pièce jointe ne suffisent donc plus à faire remonter une réponse « Bien reçu » contenant une ancienne mission en citation.

Le score augmente notamment avec :

- les termes mission, intervention, sinistre, dossier ou ordre de service ;
- la présence de coordonnées client, d’une adresse ou d’une référence ;
- une pièce métier autorisée ;
- un expéditeur autorisé.

Il diminue fortement pour les relances de paiement, newsletters, réponses automatiques, absences, listes de diffusion et adresses `no-reply`. Sans filtre d’expéditeur configuré, un expéditeur inconnu ne peut jamais franchir automatiquement le seuil et reste soumis à la validation humaine. Avec un filtre configuré, tout expéditeur absent de la liste est directement écarté.

## Documents et confidentialité

Les formats admis sont PDF, JPEG, PNG, WebP, Word, Excel et texte brut, avec une limite de 5 Mo par fichier, 10 fichiers et 20 Mo cumulés par message. Les logos et pièces non conformes sont ignorés. Les documents retenus sont ajoutés à la fiche client et au journal de mission avec une visibilité **interne** par défaut.

Dans la consultation intégrale, le corps texte est plafonné à 512 Ko par ouverture. Les pièces jointes ne sont jamais préchargées ; leur téléchargement est limité aux formats métier autorisés et à 5 Mo par fichier, avec les en-têtes HTTP `no-store` et `nosniff`. Cette lecture à la demande limite fortement la consommation de données et de mémoire, même lorsque la boîte contient beaucoup de messages.

Lors de l’import, Depann’Home Pro lit le texte brut, les PDF contenant une couche texte, les PDF scannés par OCR local, les documents DOCX et les classeurs XLSX. Il recherche les coordonnées du client (nom, prénom, téléphone, e-mail, adresse, code postal et ville) ainsi que les références utiles du dossier (mission, sinistre, assureur, expert et gestionnaire). Dans les documents prestataires, le client est identifié par le libellé **Assuré / Assurée** : cette identité est toujours prioritaire sur un éventuel champ générique « Client », qui peut désigner la plateforme ou le donneur d’ordre. Pour les autres données, les valeurs clairement indiquées dans l’e-mail restent prioritaires et les pièces jointes complètent les champs manquants. La fiche est ensuite rapprochée d’un client existant par e-mail, téléphone ou couple nom/adresse, puis créée automatiquement si aucun client ne correspond. Le nom de l’expéditeur n’est jamais utilisé comme nom du client lorsqu’aucun assuré n’a pu être identifié.

Les anciens fichiers DOC/XLS restent conservés comme pièces mais leur contenu n’est pas interprété. L’OCR des PDF scannés est exécuté localement, sans transmettre le document à un service externe, sur les cinq premières pages et avec des limites de pixels et de caractères. Une pièce corrompue ou illisible ne bloque jamais la création de la mission. Chaque pièce e-mail importée apparaît aussi dans **Documents liés au dossier** et reste téléchargeable depuis le journal de mission. Les volumes décompressés, pages PDF, cellules et caractères analysés sont bornés côté serveur.

Un e-mail est dédupliqué avec son identifiant RFC `Message-ID` dans la boîte concernée. Depann’Home Pro ne supprime et ne marque pas automatiquement le message sur le serveur d’origine.

## Réponses et statuts

Une mission importée conserve `Message-ID`, `In-Reply-To` et `References`. L’entreprise peut répondre depuis la carte de mission ; le message est envoyé avec sa propre boîte. Microsoft utilise Graph, Google Workspace utilise Gmail API, tandis que Gmail personnel, OVH et les autres hébergeurs utilisent SMTP. Si elle active les retours automatiques, les changements de statut sont envoyés de la même façon. Une panne d’envoi ne bloque jamais la mise à jour du statut dans Depann’Home Pro.

## Exploitation

Le planificateur contrôle au maximum 20 connexions dues toutes les cinq minutes, chaque connexion étant synchronisée au plus toutes les dix minutes. Une synchronisation manuelle est disponible dans l’interface. Les erreurs exposées à l’utilisateur sont volontairement génériques afin de ne révéler ni serveur interne ni identifiant secret.
