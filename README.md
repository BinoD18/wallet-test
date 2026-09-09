# laflhai-wallet-service

Backend wallet / ledger / ProviderRouter / CinetPay / eSIM / satellite, implémentant
`LAFLHAI-architecture-technique.md` (sections 1 à 5) sous forme de microservice
Node/TypeScript + PostgreSQL, **indépendant** des deux apps IPTV existantes
(`LaflhaiTV_updated` et `LaflhaiTV-WE-complete-fix-v5`).

## Pourquoi un service séparé plutôt que d'intégrer dans les deux zips

- `LaflhaiTV_updated/gateway-rust` fait de la diffusion satellite temps réel
  (Rust/Axum sur socket Unix) — un domaine métier totalement différent d'un
  wallet de crédit télécom. Le coupler créerait un monolithe fragile.
- `LaflhaiTV-WE-complete-fix-v5/server/verif` est un petit backend PHP dédié
  **uniquement** à la vérification de licences d'app. Il contient déjà un embryon
  de "wallet" (`WATCH-EARN-SPEC.md`) mais en **`localStorage`**, sans BDD, sans
  ledger, sans fournisseur télécom réel — donc rien à réutiliser structurellement.
- Un service HTTP dédié peut être appelé par n'importe quel client (l'app Kotlin
  du projet 1, le WebView Capacitor du projet 2, un futur client web) sans les
  coupler entre eux, exactement dans l'esprit "découplé des fournisseurs" du `.md`.

## Démarrage

```bash
cp .env.example .env      # renseigner DATABASE_URL + clés CinetPay/fournisseurs
npm install
npm run migrate           # crée les tables (sql/schema.sql)
psql $DATABASE_URL -f sql/seed.sql   # amorce provider_accounts + product_catalog
npm run dev                # démarre sur http://localhost:8090
```

## Endpoints principaux

| Méthode | Route | Rôle |
|---|---|---|
| POST | `/api/users` | Crée un utilisateur + son wallet XOF |
| GET | `/api/users/:userId/wallet` | Solde courant |
| GET | `/api/wallets/:walletId/history` | Historique `ledger_entries` |
| POST | `/api/payments/cinetpay/init` | Initialise une recharge (retourne l'URL de paiement) |
| POST | `/webhooks/cinetpay` | `notify_url` — seul point qui crédite le wallet |
| POST | `/api/orders` | Achat d'un produit du catalogue → ProviderRouter → débit + appel fournisseur |
| GET | `/api/esim/plans` | Catalogue eSIM filtrable par pays/région |
| POST | `/api/esim/profiles/:orderId/activate` | Marque un profil eSIM comme activé |
| GET | `/api/satellite/pending-provisioning` | File d'attente provisioning manuel satellite |

## Comment les apps existantes s'y connectent

**App Android (projet 1, `app/`)** : ajouter un client Retrofit/Ktor pointant sur
`https://wallet.laflhai.com/api`, indépendant de l'appel au `gateway-rust` local
(qui reste dédié au flux vidéo satellite).

**App Capacitor (projet 2, `www/`)** : remplacer la logique `localStorage` de
`watch-earn.js` (`laflhai_wallet`, `laflhai_we_history`) par des appels `fetch()`
vers `/api/users/:id/wallet` et `/api/wallets/:id/history` — le format des clés
JSON existantes (`balance`, `totalEarned`, historique `{type, amount, meta, at}`)
se mappe directement sur `wallets` + `ledger_entries`. Migration recommandée en
deux temps : garder `localStorage` en cache offline, synchroniser vers le
service au retour réseau.

## Ce qui reste à faire avant la production

- Remplacer les URLs/tarifs d'exemple par les vraies (Twilio Pricing API,
  Telnyx Pricing API, dashboard Africa's Talking).
- Brancher un vrai coffre-fort de secrets pour `provider_accounts.credentials_ref`
  (actuellement un simple pointeur texte).
- Ajouter l'authentification utilisateur (JWT / session) — non modélisée ici,
  volontairement hors périmètre du `.md` fourni.
- Tests d'intégration sur le webhook CinetPay avec sandbox (`CINETPAY_ENV=sandbox`).
