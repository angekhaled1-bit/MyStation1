# MyStation1 — FuelPrice Control

Une application qui permet d'effectuer des changements de prix à la pompe et sur les totems de station-service, à distance, avec confirmation de chaque application. Projet pilote AFRIQUIA, environ 50 stations (nom de projet provisoire).

```
Page web (Next.js) ─HTTPS─► API (NestJS, PostgreSQL) ─MQTT/TLS─► Boîtier en station ─► Contrôleur / totem / pompes
                                  ▲   signe chaque commande          vérifie, met en file,   (simulés pour l'instant)
                                  └──────── accusés signés ◄──────── applique, relit, confirme
```

## État actuel

| Partie | État |
|--------|------|
| Documentation projet | [`docs/`](docs/README.md) : plan d'action, guide de câblage, cadrage, protocole, revue critique |
| Protocole partagé | `packages/protocol` : messages, signature HMAC-SHA256, seuils 5 % / 15 %, contrôles de forme |
| API cloud | `apps/api` : stations, récapitulatif, envoi signé, double validation, accusés, relances, alertes, audit |
| Boîtier | `apps/gateway-sim` : logique complète du boîtier avec **totem et pompes simulés** et pannes injectables |
| Interface web | `apps/web` : stations, saisie avec récapitulatif, suivi par station, alertes, historique |
| Pilotes matériels réels | **Pas commencés** : dépendent des modèles relevés lors de la visite de station |
| Comptes utilisateurs | **Provisoires** : jetons fixes, à remplacer avant tout pilote |

## Démarrage rapide (développement)

Prérequis : Node.js 22+, PostgreSQL 16 (ou Docker).

```bash
npm install
docker compose up -d postgres          # ou un PostgreSQL local avec une base « fuelprice »
npm run build
npm run seed -w @fpc/api               # client AFRIQUIA (démo) + 3 stations fictives

npm run broker                         # terminal 1 : broker MQTT de développement (port 1883)
npm run api                            # terminal 2 : API sur http://localhost:4000
GW_ID=gw-0007 GW_SECRET=dev-secret-gw-0007 npm run sim                         # terminal 3 : boîtier station 1
GW_ID=gw-0008 GW_SECRET=dev-secret-gw-0008 SIM_DEAD_PUMPS=pump-2 npm run sim   # terminal 4 : boîtier avec une pompe en panne
npm run web                            # terminal 5 : interface sur http://localhost:3000
```

Le troisième boîtier (`gw-0009`) n'est pas démarré : il apparaît hors ligne, ses commandes restent « Envoyé » puis sont relancées et livrées dès qu'il se connecte.

Pannes simulables sur le boîtier : `SIM_DEAD_PUMPS=pump-2`, `SIM_TOTEM_MUTE_COUNT=1` (totem muet au premier essai), `SIM_TOTEM_READ_MISMATCH=1`. Couper puis relancer le simulateur reproduit une coupure : les commandes en file sont reprises au démarrage (fichier `apps/gateway-sim/data/`).

Jetons de développement (en-tête `Authorization: Bearer …`) : `dev-operator`, `dev-approver`, `dev-admin`.

## API

| Méthode | Chemin | Rôle |
|---------|--------|------|
| GET | `/health` | public |
| GET | `/stations` | prix confirmés, état du boîtier, alertes |
| POST | `/stations` | admin ; renvoie la clé du boîtier une seule fois |
| POST | `/price-changes/preview` | récapitulatif et niveaux de variation |
| POST | `/price-changes` | `{stationIds \| "all", items:[{fuel, price}], applyAt?, confirm?, comment?}` |
| POST | `/price-changes/:id/approve` · `/cancel` | double validation |
| GET | `/price-changes`, `/price-changes/:id`, `/stations/:id/commands`, `/commands/:cmdId` | suivi |
| GET/POST | `/alerts`, `/alerts/:id/resolve` | alertes |

Réponses : `422` variation > 15 % ou prix hors bornes ; `409` variation > 5 % sans `confirm: true`.

## Tests

```bash
npm test                                                        # protocole + boîtier
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/fuelprice_test npm test   # + bout en bout API
```

La base de `TEST_DATABASE_URL` est **entièrement vidée** par le test.
