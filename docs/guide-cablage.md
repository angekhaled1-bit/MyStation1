# Guide des composants et du câblage

FuelPrice Control (nom provisoire) · pilote AFRIQUIA · 16 novembre 2026. Schémas de principe, à confirmer avec les photos et la visite.
Original (avec schémas) : [`sources/guide_composants_cablage.pdf`](sources/guide_composants_cablage.pdf).

## 1. Vue d'ensemble

```
 Cloud (API, base, MQTT) ──MQTT/TLS sortant (4G)──► BOÎTIER ──Ethernet RJ45──► Contrôleur de station ──(existant)──► Interface pompes ──► Pompes 1..n (zone à risque)
                                                     │  ▲                         (console, caisse)
                                     RS-485 A,B,masse│  │ coaxial 50 Ω
                                                     ▼  │
                                               Totem    Antenne 4G (SMA, extérieure)
                                         (carte LED)    Onduleur → alimentation 12-24 V du boîtier
```

Ce que nous ajoutons : cloud, liaison 4G, boîtier, câble vers le contrôleur et, en mode 2, vers le totem. Nous ne modifions pas l'installation existante. Le boîtier se place **hors de la zone à risque** (local technique ou arrière-boutique).

## 2. Composants

| | Composant | Statut | Rôle | Comment / câblage |
|-|-----------|--------|------|-------------------|
| A | Page web et cloud | nous les construisons | Saisie et validation des prix, historique, alertes, programmation. Signe chaque commande et la publie. Jamais d'action directe sur pompe ou totem. | HTTPS navigateur–API ; MQTT/TLS cloud–boîtier, signature de chaque commande. Aucun câblage. |
| B | Liaison 4G (SIM + antenne) | à installer | Relier la station au cloud, indépendamment du réseau de la caisse. Connexion sortante seulement (port 8883). | SIM data (Orange, MTN, Moov), antenne extérieure, coaxial 50 Ω, SMA, câble court, hors armoire métallique. Trafic de quelques Mo/mois. 2e SIM ou Wi-Fi en secours. |
| C | Boîtier passerelle | notre élément | Reçoit, vérifie, garde en mémoire permanente, applique, confirme. | Alim. DC (souvent 9-30 V), SMA, SIM, RJ45, RS-485 (A, B, masse), parfois RS-232. Local technique, coffret fermé, < 100 m du contrôleur. Onduleur, watchdog, aucune interface d'administration exposée. |
| D | Contrôleur de station | existant | Autorise les pompes, enregistre les ventes, tient la table des prix et la distribue. | Prix via API, IFSF FDC-POS, import de fichier ou saisie manuelle selon l'éditeur. Nous ajoutons un câble Ethernet vers un port libre. Séparer de la caisse par pare-feu (sécurité des paiements). Sauvegarder la configuration avant intervention. |
| E | Interface pompes et bus de terrain | existant | Relie le contrôleur à toutes les pompes. | Boucle de courant ou RS-485, protocole propre à chaque marque (ex. DART chez Wayne). **Ne rien brancher dessus** : un seul maître. |
| F | Pompe | existant · zone à risque | Distribue, compte, affiche prix, volume, montant. Le prix est conservé dans le calculateur, appliqué au raccrochage du pistolet. | Rien à brancher ni à ouvrir. Jamais de scellé métrologique brisé. |
| G | Totem | existant | Afficher les prix sur la route. Modules LED + carte de pilotage + alimentation 230 V. | Mode 2 : paire torsadée blindée RS-485 ou Ethernet jusqu'à la carte. Isolation et parafoudre. Protocole souvent propriétaire. |
| H | Alimentation et protections | à installer | Onduleur, parafoudres (alimentation et RS-485), terre, disjoncteur dédié, fusible, câbles blindés, coffret fermé. | |
| I | Convertisseurs et réseau local | si besoin | Serveur série RS-485/Ethernet près du totem ; convertisseur isolé ; commutateur ; pare-feu sorties seulement. | |

## 3. Câbles, liaison par liaison

| Liaison | Câble | Connecteur | Longueur | Remarques |
|---------|-------|-----------|----------|-----------|
| Onduleur → boîtier | 2 fils | Bornier | Court | Tension et polarité de la fiche du boîtier. |
| Antenne 4G → boîtier | Coaxial 50 Ω | SMA | Le plus court possible | Antenne en hauteur, hors armoire métallique. |
| Boîtier → contrôleur (Ethernet) | Cat5e/Cat6 | RJ45 | 100 m max | IP fixe ; port dédié ; pare-feu boîtier/caisse. |
| Boîtier → contrôleur (série) | Série blindé | DB9 ou bornier | ~15 m (RS-232) | Si seul un port série est libre. |
| Boîtier → totem (RS-485) | Paire torsadée blindée | Bornier A, B, masse | 1 200 m en théorie | 120 Ω aux deux extrémités ; blindage à la masse d'un seul côté ; parafoudre. |
| Contrôleur → pompes | Existant | – | – | On n'y touche pas. |

Le nom des fils A et B varie selon les fabricants : si rien ne répond, inverser A et B. Bornes, vitesse, parité et adresse du totem dépendent du modèle et seront relevées sur place.

## 4. Interdit ou réservé

- Ne jamais ouvrir une pompe ni intervenir en zone à risque d'explosion : techniciens agréés seulement.
- Ne jamais briser un scellé de contrôle métrologique.
- Ne jamais brancher un équipement sur le bus des pompes.
- Ne rien modifier sur le contrôleur sans l'accord de l'éditeur et une sauvegarde préalable.

## 5. Photos à prendre lors de la visite

- [ ] Plaque signalétique de chaque modèle de pompe.
- [ ] Face avant de la pompe allumée (afficheur, nombre de chiffres, produits).
- [ ] Intérieur de la pompe si un technicien l'ouvre (de loin, sans toucher).
- [ ] Contrôleur de station : marque, modèle, étiquette, ports, câbles.
- [ ] Écran de caisse/console : logiciel, version, écran de changement de prix.
- [ ] Armoire de l'interface des pompes.
- [ ] Totem : face avant, plaque, carte de pilotage et ports, méthode actuelle de changement.
- [ ] Local technique : place, prises, onduleur, capture de la couverture 4G.

## 6. À confirmer

- Marque et version du contrôleur, interface proposée.
- Protocole du totem et fabricant de sa carte.
- Type de bus et protocole des pompes.
- Obligations réglementaires (prix à la pompe, réseau de la caisse).
- Disponibilité locale, délais et prix des boîtiers candidats.
