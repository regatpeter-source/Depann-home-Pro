# Rapports techniques

## Moteur générique

Le module `server/technical-reports.js` est un moteur de rapports rattachés à une intervention (`appointment_id`). Chaque rapport porte un `report_type`, un contenu structuré JSON et des médias propres : il peut donc accueillir de nouveaux modèles sans modifier les dossiers clients.

Le premier modèle est `leak_detection`, destiné aux recherches de fuite en plomberie, chauffage, PAC, CVC et réseaux hydrauliques. Il est rendu par l’assistant mobile `js/leak-report-wizard.js` et décrit par `server/leak-report-template.js`. Les 12 étapes sont : informations générales, état des lieux, observations visuelles, humidité, pression, moyens techniques, test à l’eau/colorant, mise en charge, mise en sécurité, ventilation, conclusion et préconisations/signatures.

La première étape est un instantané **en lecture seule** généré lors de la création depuis le planning, le dossier client, le profil entreprise et le compte du technicien. Les données non disponibles dans Depann'Home Pro restent simplement absentes : elles ne sont jamais inventées. Chaque entreprise peut ensuite étendre le modèle en ajoutant une définition d’étape sans modifier les tables de rapports.

## Accès et cycle de vie

- Un rapport est toujours créé depuis une intervention de planning rattachée à un dossier client. Il n’existe pas de création autonome ou de rapport sans client.
- Un technicien ne peut consulter ou créer que les rapports d’une intervention qui lui est affectée. Il peut modifier son rapport tant qu’il n’est pas validé.
- L’administration accède à l’ensemble des rapports de l’entreprise, peut demander une correction par section, valider ou remettre un document validé en brouillon.
- Le cycle est `draft`, `submitted`, `in_correction`, puis `validated`.
- La validation génère un PDF et verrouille le rapport. Le retour en brouillon enlève le PDF courant afin que toute nouvelle validation génère une version à jour.

## Assistant, synchronisation et photos

Une seule section est présentée à la fois sur téléphone. Une barre horizontale défilable permet d’ouvrir directement n’importe quelle section, tandis que les boutons **Section précédente** et **Section suivante** facilitent le parcours séquentiel. Les relevés d’humidité et de pression, ainsi que les matériels techniques, peuvent être ajoutés sans limite fonctionnelle raisonnable. Les modifications sont enregistrées après une courte temporisation, toutes les cinq secondes, lors du changement de section et à la mise en arrière-plan.

## Sections adaptables

Chaque section peut recevoir un titre personnalisé, être dupliquée, déplacée dans le sommaire ou supprimée. Les copies disposent de leurs propres observations et photos ; les photos sont clonées dans le rapport en respectant les mêmes limites de taille et le verrou collaboratif existant. L’ordre, les titres et les copies sont conservés dans le JSON `content` du rapport, ce qui garde les rapports historiques compatibles sans migration de table.

Les photos sont conservées dans le rapport, séparément des pièces jointes habituelles du dossier client. La limite actuelle est de 40 images de 4 Mo maximum par rapport. Le navigateur mobile peut ouvrir la caméra avec `capture="environment"`; chaque photo peut recevoir une légende, une annotation textuelle et un dessin tactile intégré à l’image.

Le verrou collaboratif et le flux SSE décrits dans `docs/COLLABORATION.md` restent la protection de référence : un seul éditeur modifie le rapport, les autres le consultent en lecture seule et le secrétariat reçoit les changements immédiatement.

## PDF adaptatif et compatibilité

Le PDF conserve toujours sa page d’informations générales. Les autres sections sont générées dans l’ordre défini dans le sommaire, avec leurs titres personnalisés, et uniquement si elles contiennent une valeur, un relevé, un matériel ou une photo. Les sections supprimées sont exclues. La pagination est recalculée après cette sélection : un diagnostic simple produit donc naturellement un document court, tandis qu’un diagnostic complet garde toutes les pages utiles.

Avant validation, le bouton **Prévisualiser le rapport** ouvre ce même PDF directement dans une visionneuse intégrée, sans téléchargement. Depuis cette visionneuse, l’utilisateur peut revenir à l’édition, fermer l’aperçu sans perdre ses modifications ou valider le rapport. La validation archive alors le PDF dans le dossier client.

Les rapports créés avec l’ancien formulaire sont convertis à la lecture vers le nouveau contenu structuré. Les routes HTTP, le cycle `draft → submitted → in_correction → validated`, les verrous, les médias et les archives PDF restent inchangés.

## Archivage

À la validation, le PDF est stocké dans PostgreSQL dans le rapport, puis ajouté au dossier client comme pièce jointe de type `Rapport fuite`, ainsi qu’à l’historique d’activité. Cet archivage est transactionnel : en cas d’échec d’ajout au dossier client, le rapport reste non validé.

Le stockage reste compatible avec les systèmes de fichiers éphémères, notamment Render. Les limites des pièces jointes client s’appliquent également au PDF d’archive ; les galeries restent dans le rapport afin de ne pas alourdir le JSONB client.
