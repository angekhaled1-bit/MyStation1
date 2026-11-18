# Revue critique des documents et du code de départ

18 novembre 2026. Relecture du plan d'action, du guide de câblage, de la présentation de cadrage et de la simulation, à la lumière du premier code écrit. Les points marqués **(à vérifier)** reposent sur des connaissances générales du secteur, pas sur des informations propres à AFRIQUIA.

## Les 6 points les plus importants

### 1. Vérifier si AFRIQUIA ou ses fournisseurs n'ont pas déjà la fonction

Beaucoup de contrôleurs de station et de logiciels de caisse sont vendus avec un « back-office siège » qui envoie les prix à toutes les stations. Beaucoup de fabricants de totems vendent aussi des afficheurs pilotables à distance (GSM/4G, avec leur propre logiciel). Si l'un ou l'autre existe déjà dans le réseau AFRIQUIA, le projet change : on se branche sur ce système au lieu de poser un boîtier par station.

**À ajouter au questionnaire (annexe A)** : « Le réseau utilise-t-il déjà un logiciel central (siège) pour les prix ou les ventes ? Les totems ont-ils une option de gestion à distance chez leur fabricant ? »

### 2. Commencer par une « phase 0 » sans matériel

Les prix étant fixés par l'État, ils changent peu souvent et à date connue (souvent une fois par mois, à une heure précise, dans tout le pays **(à vérifier)**). Pour 50 stations, cela fait quelques centaines de changements par an. La plus grosse part de la valeur (diffusion de la consigne, preuve de conformité, historique, relances, alertes) peut être apportée **sans boîtier** :

1. le siège saisit et valide la nouvelle grille dans l'application ;
2. chaque gérant de station reçoit la consigne (SMS, WhatsApp ou application mobile), avec l'heure d'application ;
3. le gérant change les prix comme aujourd'hui et confirme avec une photo du totem et d'une pompe ;
4. le siège voit en direct les stations à jour, en retard ou non conformes.

Cette phase peut tourner en quelques semaines sur le code existant (il suffit d'un « boîtier humain » qui envoie les accusés). Elle donne des chiffres réels (délais, erreurs) pour justifier l'investissement matériel et elle se poursuit ensuite pour les stations sans boîtier.

### 3. Le risque légal principal : un écart entre le totem et la pompe

Le plan prévoit, faute d'accès au contrôleur, un pilote « totems seulement ». Dans ce cas, le totem affichera le nouveau prix pendant que les pompes factureront l'ancien jusqu'au changement manuel. Un prix affiché différent du prix facturé est en général le cas qui pose problème aux autorités de contrôle et aux clients **(à vérifier auprès du juriste)**.

Conséquences :

- un pilote « totems seulement » doit être couplé à la procédure manuelle de la phase 0 côté pompes, avec la même heure d'application ;
- l'ordre des écritures doit être un choix explicite. Le simulateur écrit aujourd'hui **le totem d'abord, puis les pompes** ; en production il vaudra sans doute mieux commencer par le contrôleur (qui fixe le prix facturé) et ne changer le totem qu'une fois le contrôleur confirmé ;
- un contrôleur qui « accepte » un prix ne l'a pas forcément appliqué aux pompes (il attend que le pistolet soit raccroché). Il faut relire le prix effectif de chaque pompe via le contrôleur avant de dire « appliqué ».

### 4. Contrôler par rapport à la grille officielle plutôt que par pourcentage

Les seuils de 5 % et 15 % protègent contre une faute de frappe, mais un prix réglementé a une meilleure référence : la grille officielle. Recommandation : saisir une fois la grille de la période (prix par produit, éventuellement par zone, date d'effet), la faire valider par deux personnes, puis **interdire tout prix de station différent de la grille** (ou supérieur au plafond, selon la règle applicable). Les seuils restent un garde-fou secondaire.

Autre effet : une baisse de subvention peut faire varier un prix de plus de 15 % d'un coup. Avec la règle actuelle, la saisie serait bloquée sans autre recours que de modifier le seuil du client. Il faut une dérogation explicite, tracée et validée par un second utilisateur.

### 5. Signature : préférer une clé publique à une clé partagée

Le plan et le code utilisent HMAC-SHA256 avec une clé par boîtier, conservée dans la base. Si la base fuit, un attaquant peut signer des commandes pour **toutes** les stations. Avec une signature Ed25519, le cloud garde la clé privée dans un coffre-fort de clés (KMS/HSM) et les boîtiers ne détiennent que la clé publique : une fuite de la base ou un boîtier volé ne permet plus de fabriquer de commandes. Le changement est limité (`packages/protocol/src/sign.ts`) et devrait être fait avant le pilote. Les accusés peuvent rester en HMAC ou s'appuyer sur le certificat client mTLS.

### 6. Choisir le boîtier en pensant au logiciel

La grille de choix du plan est matérielle. Ajouter : **Linux ouvert avec possibilité d'installer un programme (conteneur ou Node.js/Python)**, accès au port série depuis ce programme, synchronisation de l'heure (NTP, et si possible heure du réseau 4G). Sans cela, le logiciel déjà écrit (`apps/gateway-sim`) ne pourra pas être réutilisé et devra être refait dans l'environnement du fabricant (souvent Node-RED ou un langage propriétaire).

## Autres remarques sur les documents

- **Heure du boîtier** : une commande programmée dépend entièrement de l'horloge locale. Le boîtier doit refuser de programmer (ou signaler) si son heure n'est pas synchronisée. La Côte d'Ivoire est en UTC+0 sans heure d'été, ce qui simplifie l'affichage.
- **Calendrier** : réaliste pour le cloud. La partie boîtier dépend de l'accès aux protocoles, qui n'est pas maîtrisé ; prévoir dès maintenant la date à laquelle on bascule sur le périmètre réduit (fin de semaine 4, comme indiqué) et la décision qui en découle.
- **Données personnelles** : peu de données personnelles en jeu (comptes utilisateurs, journaux). L'hébergement en Europe est probablement acceptable mais à confirmer avec l'ARTCI ; le contrat AFRIQUIA peut imposer davantage.
- **Coût récurrent** : SIM 4G, maintenance et remplacement de boîtiers (chaleur, foudre) pour 50 stations sont absents du chiffrage ; ce sont eux qui pèsent sur la durée.
- **Nom et dépôts** : le projet porte trois noms (FuelPrice Control, MyStation, MyStation1) et deux dépôts GitHub. Choisir un nom et un dépôt de référence.
- **Simulation HTML** : elle reste utile pour expliquer la logique à AFRIQUIA ; elle est conservée dans `docs/sources/` et correspond aux scénarios testés dans `apps/gateway-sim/test/`.

## Limites du code actuel (à traiter avant un pilote)

| Sujet | État | À faire |
|-------|------|---------|
| Comptes et connexion | Jetons fixes dans une variable d'environnement | Vrais comptes, mots de passe hachés ou SSO, MFA pour valider, expiration de session |
| Clés des boîtiers | En clair dans la base | Ed25519 + coffre-fort de clés (point 5), rotation, révocation |
| Relances | Minuterie dans le processus de l'API | File Redis (BullMQ) ou verrou si plusieurs instances, comme prévu au plan |
| Phase 0 | **Faite** (voir [phase-0.md](phase-0.md)) | Choisir le fournisseur SMS/WhatsApp ; stockage des photos |
| Application partielle | Alerte seulement | Bouton « relancer cette station » (nouvelle commande) et escalade vers une intervention |
| Grille officielle | **Faite** : validation à deux, blocage des prix hors grille, conformité par station | Dérogation tracée (cas exceptionnels) |
| Notifications | Consignes et rappels aux gérants (console ou webhook) | Alertes du siège par SMS / courriel |
| Pilotes matériels | Totem et pompes simulés | Un pilote par modèle de contrôleur ou de totem, après la visite |
| Ordre totem / pompes | Totem puis pompes | Rendre configurable, contrôleur d'abord par défaut (point 3) |
| Validation des entrées | Manuelle dans les services | Bibliothèque de validation et documentation OpenAPI |
| Exploitation | Aucune | Journaux centralisés, supervision, sauvegardes de la base, mises à jour signées des boîtiers |

## Prochaines étapes proposées

1. Visite de station et questionnaire, avec les deux questions du point 1.
2. Décider si l'on lance la phase 0 (point 2) ; si oui : comptes utilisateurs, grille officielle, application gérant et notifications.
3. Passer la signature en Ed25519 (point 5).
4. Choisir 2 ou 3 boîtiers candidats avec le critère logiciel (point 6) et y porter `apps/gateway-sim`.
