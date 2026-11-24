# Protocole cloud ↔ boîtier (v1)

Implémentation de référence : [`packages/protocol`](../packages/protocol/src) (partagé par l'API et le boîtier).

## Transport

- MQTT 3.1.1/5 sur TLS (port 8883) en production, **connexion sortante uniquement** depuis la station.
- Authentification mutuelle par certificat client ; ACL du broker : chaque boîtier ne lit et n'écrit que `fpc/v1/t/<client>/g/<son id>/#`.
- Boîtier : `clean: false` (session persistante) et abonnement QoS 1 → le broker conserve les commandes pendant une coupure 4G et les livre à la reconnexion.
- Testament (LWT) retenu sur `…/state` : `{"online": false}` publié par le broker si le boîtier disparaît.

| Topic | Sens | QoS | Retenu |
|-------|------|-----|--------|
| `fpc/v1/t/{client}/g/{boîtier}/cmd` | cloud → boîtier | 1 | non |
| `fpc/v1/t/{client}/g/{boîtier}/ack` | boîtier → cloud | 1 | non |
| `fpc/v1/t/{client}/g/{boîtier}/state` | boîtier → cloud | 1 | oui |

## Signature

`sig = HMAC-SHA256(clé du boîtier, JSON canonique du message sans le champ sig)` en hexadécimal.
JSON canonique : clés triées, aucun espace, pas de `undefined` ni de nombre non fini. Les accusés sont signés de la même façon par le boîtier.

## Commande `set_prices`

```json
{
  "v": 1, "type": "set_prices",
  "cmd_id": "5d0c…-uuid", "seq": 42,
  "tenant": "afriquia", "station": "CI-ABJ-012", "gw": "gw-0007",
  "issued_at": "2026-11-18T08:00:00.000Z",
  "apply_at": "2026-11-19T00:00:00.000Z",
  "expires_at": "2026-11-20T00:00:00.000Z",
  "items": [{ "fuel": "SP", "price": 890, "prev": 875 }, { "fuel": "GO", "price": 725, "prev": 715 }],
  "sig": "9f2c…"
}
```

- Prix : FCFA par litre, entiers strictement positifs.
- `seq` : croissant par boîtier. Une commande de `seq` inférieur ou égal au dernier appliqué est **périmée** (`superseded`).
- `apply_at` : `null` = dès réception. Le boîtier garde la commande en mémoire permanente jusqu'à l'heure dite (horloge NTP requise).
- `expires_at` : au-delà, refus (`expired`). Par défaut `apply_at` (ou l'émission) + 24 h.

## Contrôles du boîtier, dans l'ordre

1. Forme du message → sinon `rejected` (`bad_shape`).
2. Destinataire (`tenant`, `gw`) → sinon `rejected` (`wrong_gateway`).
3. Signature → sinon `rejected` (`bad_signature`), rien n'est écrit ni mémorisé.
4. Doublon (`cmd_id` déjà vu) → renvoi du dernier accusé avec `duplicate: true`, aucune réécriture.
5. Expiration → `expired`.
6. Ordre (`seq`) → `superseded`.
7. Bornes locales (par défaut 500 à 1 500 FCFA/L) → `rejected` (`out_of_bounds`).
8. Écriture en file persistante (fichier temporaire, fsync, renommage atomique) → `received`, puis `scheduled` si programmée.
9. À l'heure : écriture du totem, relecture, `totem_applied` ; écriture des pompes (ou du contrôleur) ; accusé final.

Chaque équipement a 3 essais locaux. Si plusieurs commandes sont échues en même temps, seule la plus récente est appliquée.

## Accusés

```json
{ "v": 1, "cmd_id": "…", "gw": "gw-0007", "status": "partially_applied", "at": "…",
  "devices": [{ "device": "totem", "ok": true }, { "device": "pump-1", "ok": true }, { "device": "pump-2", "ok": false, "error": "…" }],
  "applied": { "SP": 890, "GO": 725 }, "reason": "pump-2 : aucune réponse (délai dépassé)", "sig": "…" }
```

| Statut | Final | Sens |
|--------|-------|------|
| `received` | | Vérifiée et écrite en file locale |
| `scheduled` | | En attente de `apply_at` |
| `totem_applied` | | Totem écrit et relu |
| `applied` | oui | Tous les équipements confirmés |
| `partially_applied` | oui | Au moins un équipement en échec (alerte) |
| `failed` | oui | Aucun équipement mis à jour (alerte) |
| `rejected` | oui | Signature, forme, bornes, destinataire (alerte) |
| `expired` | oui | Reçue trop tard (alerte) |
| `superseded` | oui | Une commande plus récente l'a remplacée |

Côté cloud, un statut ne recule jamais (un `received` en retard n'écrase pas `applied`). Sans aucun accusé, la commande signée est renvoyée telle quelle toutes les 60 s jusqu'à expiration, puis marquée `unconfirmed` avec une alerte.

## État du boîtier (`state`, retenu)

```json
{ "v": 1, "gw": "gw-0007", "online": true, "at": "…", "last_seq": 42, "prices": { "SP": 890, "GO": 725 }, "pending": 0, "fw": "sim-0.1.0" }
```
