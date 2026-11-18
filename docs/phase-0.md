# Phase 0 : pilotage des prix sans boîtier

Objectif : apporter dès maintenant la diffusion des prix, la preuve de conformité et le suivi, **sans poser de matériel en station**. Les stations équipées d'un boîtier et les stations en phase 0 cohabitent dans la même application.

## Déroulé

1. **Grille officielle.** Au siège, une personne saisit la grille (prix par produit, date et heure d'entrée en vigueur, référence du communiqué). Une **autre personne** la valide.
2. **Diffusion.** Un clic sur « Diffuser à toutes les stations » crée une consigne par station, pour l'heure d'entrée en vigueur :
   - station avec boîtier : commande signée envoyée par MQTT (inchangé) ;
   - station en phase 0 : **message au gérant** (SMS ou WhatsApp) avec les nouveaux prix, l'heure et un lien personnel.
3. **En station.** À l'heure dite, le gérant change les prix comme aujourd'hui (pompes et totem en même temps), ouvre le lien, saisit les prix lus sur le totem et sur une pompe, et prend **deux photos** (totem, afficheur de pompe). Il peut aussi signaler un problème.
4. **Au siège.** Le tableau de bord montre pour chaque station : consigne envoyée, lien ouvert, confirmé, écart, problème, avec les photos. La colonne « Grille » indique si les prix confirmés sont **conformes** à la grille en vigueur.

## Règles appliquées

| Règle | Détail |
|-------|--------|
| Grille validée à deux | La personne qui saisit ne peut pas valider. |
| Prix hors grille bloqué | Avec une grille en vigueur, tout changement de prix différent est refusé. Les seuils 5 % / 15 % ne servent plus qu'en l'absence de grille. |
| Pas de confirmation anticipée | Le gérant ne peut confirmer qu'à partir de 15 minutes avant l'heure d'application. |
| Photos obligatoires | Deux photos (JPEG, PNG, WebP ou HEIC, 8 Mo maximum), type vérifié sur le contenu du fichier. |
| Écart signalé | Si un prix lu diffère de la consigne : statut « Partiel » et alerte. Le prix de la station n'est mis à jour que pour les produits conformes sur le totem. |
| Retard | Sans confirmation 30 minutes après l'heure (`MANUAL_LATE_MINUTES`) : alerte et **rappel** au gérant. |
| Une consigne à la fois | Une nouvelle consigne remplace la précédente non confirmée ; l'ancien lien ne fonctionne plus. |
| Lien personnel | Jeton aléatoire, stocké uniquement sous forme d'empreinte, masqué dans le journal des notifications ; il expire avec la consigne (24 h après l'heure d'application par défaut). |

## Envoi des messages

`NOTIFY_PROVIDER` :

- `log` (par défaut) : le message s'affiche dans la console de l'API. Pour la démonstration, copiez le lien depuis cette console.
- `webhook` : l'API envoie `{"to": "+225…", "body": "…"}` en POST à `NOTIFY_WEBHOOK_URL` (avec `Authorization: Bearer NOTIFY_WEBHOOK_TOKEN` si défini). Cela permet de brancher la passerelle SMS d'un opérateur local, un fournisseur WhatsApp Business ou un outil d'automatisation, sans changer le code.

`PUBLIC_WEB_URL` donne l'adresse publique de l'interface, utilisée dans les liens (par défaut `http://localhost:3000`).

## Mise en route d'une station en phase 0

```bash
curl -X POST http://localhost:4000/stations -H 'Authorization: Bearer dev-admin' -H 'Content-Type: application/json' \
  -d '{"code":"CI-ABJ-050","name":"Station exemple","fuels":["SP","GO"],"mode":"manual","managerName":"Nom du gérant","managerPhone":"+2250700000000"}'
```

Une station équipée d'un boîtier peut être repassée en mode manuel (`PATCH /stations/:id` avec `{"mode":"manual"}`) si son boîtier tombe en panne.

## Ce que la phase 0 ne fait pas encore

- Vrais comptes utilisateurs pour le siège (jetons de développement pour l'instant).
- Fournisseur SMS ou WhatsApp choisi et contracté : à faire avec AFRIQUIA (coût par message, numéro émetteur, accord WhatsApp Business).
- Stockage des photos sur un service de fichiers (aujourd'hui sur le disque du serveur, dossier `UPLOAD_DIR`).
- Contrôle des photos : un humain doit les regarder ; aucune lecture automatique des chiffres.
- Limitation du nombre de requêtes sur les liens publics.
