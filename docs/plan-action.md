# Plan d'action : le boîtier et la suite du projet

FuelPrice Control (nom provisoire) · pilote AFRIQUIA, environ 50 stations · document du 15 novembre 2026.
Original : [`sources/plan_action_boitier_et_projet.pdf`](sources/plan_action_boitier_et_projet.pdf).

## 1. Où en est le projet

- **Décidé** : NestJS, PostgreSQL, Redis, MQTT sur TLS, Next.js ; super-admin plateforme ; FCFA sans décimales ; prix fixés par l'État ; changement programmé dans le MVP ; hébergement en région Europe (sous réserve de conformité).
- **Proposé, à valider** : boîtier = passerelle industrielle du commerce (option A) ; double validation en option par entreprise ; seuils de variation 5 % (confirmation) et 15 % (blocage).
- **Inconnu et critique** : modèles exacts de totems, de pompes Wayne et Gilbarco, existence d'un contrôleur de station. Tant que ce point n'est pas éclairci, le développement côté boîtier ne peut pas commencer.

> Principe directeur : valider le matériel avant d'investir dans le développement côté boîtier. Le logiciel cloud avance en parallèle grâce au simulateur de boîtier.

## 2. Les 5 actions prioritaires (semaines 1 à 2)

| # | Action | Résultat attendu |
|---|--------|------------------|
| 1 | Rencontrer AFRIQUIA : accord de pilote, interlocuteur prix, 2 à 3 stations de test, réponses au questionnaire (annexe A). | Accord écrit ou courriel ; contact nommé. |
| 2 | Visiter une station : marques et modèles (totem, pompes, contrôleur), plaques signalétiques, alimentation, couverture 4G, emplacement du boîtier (annexe B). | Fiche station remplie avec photos. |
| 3 | Décrire comment les prix se changent aujourd'hui (clavier, tablette, logiciel du contrôleur, caisse). | Procédure actuelle pas à pas. |
| 4 | Demander documentation technique et autorisation d'intégration : fabricant du totem, Wayne, Gilbarco, éditeur du contrôleur. | Protocoles disponibles ou refus clair. |
| 5 | Vérifier le cadre légal : prix réglementés, données personnelles (ARTCI), exigences contractuelles d'AFRIQUIA. | Liste des obligations ; avis d'un juriste local. |

## 3. Le boîtier

Passerelle installée dans chaque station : reçoit les commandes du cloud, les applique au totem (et aux pompes) et renvoie la confirmation. Recommandation pour le pilote : **passerelle industrielle du commerce** plutôt qu'une carte conçue en interne.

### Critères de choix

- [ ] 4G et Wi-Fi avec bascule automatique ; Ethernet disponible.
- [ ] Port Ethernet (contrôleur) et port série RS-485 / RS-232 (totem ou contrôleur). Modbus n'est qu'une hypothèse.
- [ ] MQTT sur TLS avec certificat client (authentification mutuelle).
- [ ] Stockage non volatil pour la file locale et le dernier prix valide ; reprise correcte après coupure.
- [ ] Watchdog ; horloge fiable.
- [ ] Mises à jour logicielles signées ; révocation d'un boîtier compromis.
- [ ] Alimentation adaptée, tenue à la chaleur et à la poussière, boîtier fermé.
- [ ] Disponibilité et support à Abidjan, délai d'importation, prix unitaire (à demander).

### Étapes

| Étape | Quoi | Qui |
|-------|------|-----|
| A | Liste de 2 à 3 modèles candidats ; devis, délais, fiches techniques. | Vous, avec le développeur référent |
| B | Commander 2 à 3 unités d'évaluation (pas 50). | Vous |
| C | Banc d'essai : broker MQTT, coupure de courant, coupure 4G, reprise, file locale. | Développeur référent, avec Claude Code |
| D | Test sur contrôleur ou totem réel, en lecture puis écriture d'un prix de test. | Expert en mission courte, accord AFRIQUIA |
| E | Installation dans 1 station pilote ; surveillance rapprochée. | Technicien local, expert en appui |
| F | Si concluant : lot de déploiement pour les autres stations pilotes. | Vous |

### Les 3 modes de branchement

| Mode | Le boîtier se branche sur | À obtenir | Verdict |
|------|---------------------------|-----------|---------|
| 1. Via le contrôleur de station | Le contrôleur (Ethernet ou série). Rien sur les pompes ni le totem. | Accord et documentation de l'éditeur (API, IFSF FDC-POS, import de fichier) ; compte technique. | **Recommandé.** Le contrôleur reste maître des prix. |
| 2. Totem en direct | La carte du totem : RS-485 (A, B, masse) ou Ethernet. | Marque et modèle, trames ou API, accord du fabricant. | À combiner avec le mode 1 si le contrôleur ne pilote pas le totem. |
| 3. Pompes en direct | Le bus contrôleur–pompes, en zone à risque. | Protocole de chaque marque, installateur agréé, aval réglementaire. | **Déconseillé.** |

**Règle de décision après la visite** : contrôleur avec interface ouverte → mode 1. Contrôleur sans pilotage du totem → ajouter le mode 2. Mode 3 en dernier recours seulement. Sans accès à la fin des semaines 3-4 : pilote sur le périmètre réalisable (totems seuls), pompes en phase 2.

Un contrôleur attend en général qu'aucun plein ne soit en cours pour appliquer un prix : le délai réel peut dépasser quelques secondes.

## 4. Qui fait quoi

Le code (cloud, simulateur, logiciel du boîtier, pilotes, tests) peut être produit avec Claude Code sous la responsabilité d'un développeur qui relit et déploie. Ne peuvent pas être remplacés :

- un **technicien ou intégrateur local** (câblage, installation, zone à risque) ;
- un **expert en mission courte** (validation du protocole sur matériel réel, relecture du code critique) ;
- un **développeur référent** (relecture, déploiement, sécurité, maintenance) ;
- **vous** : produit, lien avec AFRIQUIA, fabricants, éditeurs.

## 5. Calendrier indicatif

| Période | Objectif | Critère de réussite |
|---------|----------|---------------------|
| Sem. 1-2 | Terrain et questionnaire | Matériel identifié, accord AFRIQUIA |
| Sem. 3-4 | Choix du boîtier, unités d'évaluation, recrutement, point légal | Modèle retenu ; équipe prête |
| Sem. 5-12 | Cloud : comptes, stations, prix, commandes, relances, alertes, avec simulateur | Démonstration complète sans matériel |
| Sem. 9-16 | Logiciel du boîtier, intégration contrôleur (mode 1) et/ou totem (mode 2) | Un prix de test appliqué sur équipement réel |
| Sem. 17-20 | Tests de panne, sécurité, installation pilote | Stabilité sur plusieurs jours |
| Ensuite | Pilote 2 à 4 semaines, puis extension vers 50 stations | Indicateurs au vert |

## 6. Indicateurs de réussite du pilote

- Taux de mises à jour appliquées du premier coup ; délai moyen validation → application.
- Nombre de relances ; taux de boîtiers hors ligne ; alertes ouvertes.
- Temps moyen de résolution des interventions ; conformité à la grille officielle ; satisfaction d'AFRIQUIA.

## 7. Risques

| Risque | Réponse |
|--------|---------|
| Protocoles totems ou pompes fermés | Documentation et accord tôt ; totems d'abord ; contrôleur de station. |
| Prix erroné diffusé à toutes les stations | Seuils de variation, récapitulatif, double validation, authentification renforcée. |
| Connexion 4G instable | File locale, dernier prix mémorisé, commandes envoyées à l'avance avec heure d'application. |
| Absence de compétence terrain | Technicien local et expert dès la semaine 3. |
| Intervention directe sur le bus des pompes | Éviter le mode 3. |
| Obligations légales | Avis juridique local avant le pilote. |

## Annexe A : questionnaire pour AFRIQUIA

- [ ] Modèles exacts de pompes Wayne et Gilbarco, et années ?
- [ ] Contrôleur de station ou caisse dans chaque station ? Marque, version ? Interface (API, IFSF FDC-POS, import) et conditions ?
- [ ] Le totem est-il piloté par le contrôleur ou par sa propre carte ? Fabricant ?
- [ ] Comment change-t-on les prix aujourd'hui (boîtier, tablette, clavier, logiciel) ?
- [ ] Interface exploitable (RS-485, Ethernet, API) ? Le fabricant autorise-t-il l'intégration ?
- [ ] Qui publie et valide les prix chez AFRIQUIA ? Qui seront les utilisateurs réels ?
- [ ] Alimentation stable, couverture 4G, place pour le boîtier ?
- [ ] Exigences de sécurité, conformité, hébergement des données ?
- [ ] Fréquence des changements de prix et préavis avant l'entrée en vigueur ?
- [ ] Stations pilotes et durée du pilote acceptée ?

## Annexe B : fiche de visite de station

| Élément | À relever |
|---------|-----------|
| Station | Nom, adresse, contact local, horaires d'accès |
| Totem | Marque, modèle, photo de la plaque, nombre de lignes de prix, méthode de changement, ports visibles |
| Pompes | Marque, modèle, année, nombre, afficheurs, plaques en photo |
| Contrôleur / caisse | Marque, version, port RJ45 ou série libre, administrateur, interface proposée |
| Pilotage du totem | Par le contrôleur ou sa propre carte ? Port disponible, marque de la carte |
| Bus des pompes | Type de câble (ne pas y toucher) ; photo de l'armoire |
| Sécurité | Zone à risque ; emplacement du boîtier hors zone |
| Alimentation | Prise près du totem, onduleur, fréquence des coupures |
| Réseau | Couverture 4G (opérateur, barres), Wi-Fi, Ethernet |
| Emplacement du boîtier | Lieu protégé, distance au totem, accès technicien |
| Photos | Totem, pompes, armoire électrique, emplacement envisagé |
