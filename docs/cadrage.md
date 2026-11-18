# Présentation de cadrage (résumé)

Projet pilote AFRIQUIA · 16 novembre 2026 · document de travail.
Original : [`sources/presentation_cadrage.pptx`](sources/presentation_cadrage.pptx).

**FuelPrice Control** : piloter à distance les prix carburant de chaque station, de la page web jusqu'au totem et aux pompes. Saisie, validation et envoi des prix vers environ 50 stations, avec confirmation de chaque application.

## Avantages

- **Rapidité** : changement programmé avec heure d'application.
- **Fiabilité** : seuils de variation 5 % / 15 %, double validation en option.
- **Conformité** : historique complet, suivi de la conformité à la grille officielle.
- **Maîtrise** : alertes, boîtiers hors ligne repérés, indicateurs.

## Architecture

Cloud (page web, API, base, signe chaque commande) → Internet 4G (MQTT/TLS, sortant uniquement) → Boîtier (seul équipement posé, hors zone à risque) → Contrôleur de station (Ethernet, reste maître des prix) → Pompes et totem (via le contrôleur ; totem aussi en RS-485 selon le modèle).

Rien n'est branché sur le bus des pompes. Les modèles exacts restent à confirmer.

## Ressources

- **Matériel** : 2 à 3 passerelles d'évaluation, SIM et antenne 4G, onduleur, parafoudre, coffret.
- **Équipe** : développeur référent, technicien local agréé, expert en mission courte.
- **Accords** : pilote AFRIQUIA et 2 à 3 stations de test, documentation fabricants et éditeur, avis juridique.
- **Budget** : à chiffrer.

## Décisions demandées

1. Accord de pilote : un interlocuteur prix, 2 à 3 stations de test.
2. Accès au terrain : visite et documentation.
3. Budget et équipe : matériel d'évaluation, technicien, expert.

Risques et calendrier : voir [plan-action.md](plan-action.md).
