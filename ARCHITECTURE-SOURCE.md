# LAFLHAI — Architecture technique du portefeuille télécom mondial

## 1. Schéma du wallet / ledger

### Principe de conception
Le wallet doit être **découplé des fournisseurs télécom**. On ne stocke jamais "X minutes Twilio" directement : on stocke un solde en **crédit LAFLHAI** (une unité de valeur interne, adossée à une devise pivot comme le XOF ou l'USD), et chaque achat de service (appel, SMS, data, satellite) est une **transaction de débit** qui déclenche un appel au fournisseur choisi par la couche d'abstraction. C'est ce qui permet de changer de fournisseur SMS demain sans toucher au cœur du produit.

### Tables principales

**`users`**
- `id`, `phone_number`, `email`, `country_code`, `kyc_status`, `created_at`

**`wallets`**
- `id`, `user_id` (FK), `balance` (decimal, jamais de float), `currency` (XOF/USD/EUR), `status` (active/frozen), `updated_at`

**`ledger_entries`** — comptabilité en partie double, source de vérité
- `id`, `wallet_id`, `type` (credit / debit), `amount`, `balance_after`, `reference_type` (topup, purchase, refund, adjustment), `reference_id`, `created_at`
- Règle d'or : le `balance` de `wallets` n'est **jamais** modifié directement en code métier — il est recalculé/vérifié à partir de la somme des `ledger_entries`. Ça évite les incohérences en cas de bug ou de double-appel API.

**`provider_accounts`**
- `id`, `provider_name` (twilio, telnyx, airalo, cinetpay...), `credentials_ref` (pointeur vers un coffre-fort de secrets, jamais en clair en DB), `country_scope`, `active`

**`product_catalog`**
- `id`, `provider_id` (FK), `category` (voice_intl, voice_mobile, sms, esim_data, satellite), `destination_country`, `unit` (minute, sms, mo), `cost_provider` (ce que ça coûte à LAFLHAI), `price_user` (ce que ça coûte à l'utilisateur), `margin_pct`

**`orders`**
- `id`, `user_id`, `product_id`, `quantity`, `total_price`, `status` (pending, completed, failed), `provider_reference` (id de la ressource créée chez le fournisseur, ex. eSIM ICCID ou SID Twilio), `created_at`

**`usage_events`**
- `id`, `order_id` ou `user_id`, `event_type` (call_made, sms_sent, data_consumed), `provider_event_id`, `quantity_consumed`, `cost_incurred`, `occurred_at`
- Alimenté par les **webhooks** des fournisseurs (Twilio Status Callbacks, etc.), pas par polling.

**`payment_transactions`**
- `id`, `user_id`, `wallet_id`, `provider` (cinetpay, orange_money, mtn_momo, visa...), `provider_transaction_id`, `amount`, `currency`, `status`, `raw_payload` (JSON brut pour audit), `created_at`

### Couche d'abstraction fournisseurs
Un contrat unique côté backend, par exemple :

```
interface TelecomProvider {
  placeCall(from, to, walletId): CallResult
  sendSms(to, body, walletId): SmsResult
  provisionEsim(planId, walletId): EsimResult
  getRates(destinationCountry): RateSheet
}
```

Chaque fournisseur (`TwilioProvider`, `TelnyxProvider`, `AiraloProvider`...) implémente ce contrat. Le routage vers le "moins cher / plus fiable pour cette destination" se fait dans un `ProviderRouter` central — c'est ce composant qui permet d'ajouter Telnyx en primaire et Twilio en fallback sans toucher au reste de l'app.

---

## 2. Comparatif fournisseurs pour l'Afrique de l'Ouest (Côte d'Ivoire en référence)

Un point important à ajouter à ta liste initiale : **Africa's Talking** est un acteur né au Kenya, spécialisé Afrique (SMS, voix, USSD, airtime, paiement), qui mérite d'être benchmarké aux côtés de Twilio/Telnyx/Vonage — ses tarifs sont souvent nettement plus bas sur les corridors africains et il gère l'USSD, ce qu'aucun des trois autres ne fait bien.

| Fournisseur | SMS sortant (Côte d'Ivoire, indicatif) | Voix | Points forts | Points faibles |
|---|---|---|---|---|
| Twilio | ≈ 0,245 $/SMS (tarif catalogue) | tarif catalogue, souvent le plus élevé du marché | Doc excellente, écosystème énorme, très fiable | Le plus cher sur les corridors africains |
| Telnyx | à partir de 0,004 $/SMS en tarif de base US, mais le prix réel par destination africaine se calcule via leur pricing en ligne — généralement inférieur à Twilio sur la voix (à partir de 0,005 $/min sortant en tarif catalogue de référence) | à partir de ≈ 0,005 $/min catalogue | Tarifs de gros, API moderne, pas d'engagement minimum en pay-as-you-go | Moins de "marque" que Twilio, support communautaire en entrée de gamme |
| Africa's Talking | de l'ordre de 0,01 $/SMS sur les corridors africains selon les comparatifs disponibles | compétitif, spécialisé Afrique | USSD, airtime, mobile money intégrés nativement, pensé pour l'Afrique | Couverture hors Afrique plus limitée |

**Recommandation pratique :** ne fige pas un seul fournisseur voix/SMS. Mets Telnyx ou Africa's Talking en primaire pour les corridors africains (meilleur coût), et garde Twilio en fallback qualité/fiabilité pour l'international hors Afrique — ton `ProviderRouter` doit être conçu pour ça dès le départ. Les tarifs SMS/voix bougent souvent (guerre des prix, taxes locales sur SMS type Côte d'Ivoire), donc prévois un job qui resynchronise `product_catalog` avec les tarifs API des fournisseurs plutôt que de les coder en dur.

---

## 3. Intégration CinetPay / mobile money

### Flux recommandé (paiement "Seamless" ou redirection)

1. **Init côté backend** — L'utilisateur choisit un montant de recharge dans l'app. Le backend appelle l'API CinetPay pour initialiser un paiement (`payment.initialize`) avec un `merchant_transaction_id` unique généré par toi (idéalement l'ID de la ligne `payment_transactions` en attente).
2. **Checkout** — CinetPay renvoie une URL de paiement (ou déclenche le SDK front pour un paiement "seamless" sans redirection, qui détecte automatiquement l'opérateur mobile money du numéro saisi).
3. **Webhook `notify_url`** — CinetPay appelle ton backend en asynchrone pour confirmer le statut (`ACCEPTED` / `REFUSED`). **Ne jamais créditer le wallet sur la redirection `success_url` seule** — c'est le webhook signé qui fait foi, car l'utilisateur peut fermer son navigateur avant la redirection.
4. **Vérification** — Dès réception du webhook, rappelle l'API CinetPay en `check status` pour confirmer le montant et l'ID avant de créditer (évite le rejeu/falsification de webhook).
5. **Créditer le wallet** — Une fois confirmé : insertion d'un `ledger_entries` de type `credit`, mise à jour du solde, notification à l'utilisateur.

### Exemple d'intégration (Node/TypeScript, SDK officiel `cinetpay-js`)

```typescript
import { CinetPayClient } from 'cinetpay-js'

const client = new CinetPayClient({
  credentials: {
    CI: {
      apiKey: process.env.CINETPAY_API_KEY_CI!,
      apiPassword: process.env.CINETPAY_API_PASSWORD_CI!,
    },
  },
})

// 1. Initialiser le paiement (route backend appelée par l'app mobile)
const payment = await client.payment.initialize({
  currency: 'XOF',
  merchantTransactionId: rechargeId, // ID interne de ta table payment_transactions
  amount: montantRecharge,
  designation: 'Recharge crédit LAFLHAI',
  clientEmail: user.email,
  successUrl: 'https://laflhai.com/wallet/success',
  failedUrl: 'https://laflhai.com/wallet/failed',
  notifyUrl: 'https://api.laflhai.com/webhooks/cinetpay', // le vrai point de vérité
})

// 2. Renvoyer payment.paymentUrl (ou le token) au frontend pour ouvrir le checkout
```

```typescript
// 3. Endpoint webhook — vérification obligatoire avant de créditer
app.post('/webhooks/cinetpay', async (req, res) => {
  const { cpm_trans_id } = req.body
  const status = await client.payment.checkStatus(cpm_trans_id)

  if (status.status === 'ACCEPTED') {
    await creditWallet(status.merchantTransactionId, status.amount)
  }
  res.sendStatus(200) // toujours répondre 200 rapidement, traiter en tâche de fond si lourd
})
```

### Points d'attention spécifiques à l'Afrique de l'Ouest
- **Multi-devise/multi-pays** : le SDK CinetPay gère des credentials distincts par pays (`CI`, `SN`, etc.) — prévois cette dimension dans `provider_accounts` dès le départ si LAFLHAI vise plusieurs pays de la zone UEMOA.
- **Environnement sandbox vs production** : les clés `sk_test_` vs `sk_live_` pointent vers des URLs d'API différentes — verrouille ça par variable d'environnement pour éviter un débit réel en environnement de test.
- **Canaux disponibles** : Orange Money, MTN Mobile Money, Moov Money, cartes Visa/Mastercard, Wave selon les pays — le paramètre `channels` de l'API te permet de restreindre ou d'ouvrir tous les moyens de paiement.
- **Idempotence** : toujours vérifier qu'un `merchant_transaction_id` n'a pas déjà été crédité avant d'insérer un `ledger_entries` — un webhook peut être renvoyé plusieurs fois par CinetPay.

---

## 4. Le `ProviderRouter` — logique de sélection automatique

### Rôle
Le `ProviderRouter` est le composant qui décide, pour une requête donnée ("appeler ce numéro", "envoyer ce SMS", "activer cette eSIM"), **quel fournisseur backend appeler réellement**. C'est la pièce qui rend LAFLHAI indépendant de chaque API tierce : un fournisseur qui augmente ses prix, tombe en panne, ou perd sa licence dans un pays ne doit jamais bloquer le produit.

### Entrées de décision
Pour chaque requête, le router a besoin de :
- `category` (voice_intl, voice_mobile, sms, esim_data, satellite)
- `destination_country` (code ISO)
- contraintes de qualité éventuelles (ex. l'utilisateur a payé un tier "premium" nécessitant garantie de délivrabilité)

### Algorithme de sélection (exemple concret)

```
function selectProvider(category, destinationCountry, tier):
    candidates = ProviderCatalog.find(category, destinationCountry)
        .filter(p => p.active AND p.healthCheck.isUp())

    if candidates.isEmpty():
        throw NoProviderAvailableError

    # 1. Filtrer par tier de qualité si demandé
    if tier == "premium":
        candidates = candidates.filter(p => p.reliability_score >= 0.98)

    # 2. Trier par coût réel (cost_provider), pas par prix affiché à l'utilisateur
    candidates.sortBy(p => p.cost_provider ascending)

    # 3. Appliquer une pondération santé/latence récente (pas seulement le prix)
    primary = candidates[0]
    if primary.recent_failure_rate > 0.05:
        primary = candidates[1] or fallback_provider

    return primary
```

### Points concrets à implémenter
- **Health checks actifs** : chaque `ProviderAdapter` expose un statut (dernier taux d'échec sur 15 min, latence moyenne), mis à jour via les webhooks de statut d'appel/SMS (Twilio Status Callbacks, Telnyx Call Control events). Si Telnyx a un taux d'échec anormal sur la Côte d'Ivoire, le router bascule automatiquement sur Africa's Talking ou Twilio sans intervention humaine.
- **Circuit breaker** : si un fournisseur échoue 3 fois de suite sur une fenêtre courte, on le sort temporairement du pool (`active = false` avec expiration automatique), plutôt que de continuer à taper dans le vide et faire attendre l'utilisateur.
- **Cache des tarifs** : `getRates()` ne doit pas être appelé en temps réel à chaque transaction (latence + rate limit) — synchronise `product_catalog.cost_provider` via un job planifié (toutes les 6h ou 24h selon la volatilité du fournisseur) plutôt qu'à la demande.
- **Explicabilité** : logue systématiquement *pourquoi* un fournisseur a été choisi (`selected_provider`, `reason`, `alternatives_considered`) dans `orders` — indispensable le jour où un utilisateur se plaint d'une qualité d'appel et que tu dois debugger.
- **A/B ou split volontaire** : rien n'empêche de router 90% du trafic SMS Côte d'Ivoire vers Telnyx et 10% vers Africa's Talking en continu, pour garder un fournisseur "chaud" en fallback testé en conditions réelles plutôt qu'un fallback jamais utilisé qui peut avoir des soucis de config non détectés.

---

## 5. Modélisation eSIM / satellite dans `product_catalog`

Les forfaits eSIM et satellite sont structurellement différents des minutes/SMS (qui sont facturés à l'usage) : ce sont des **produits en package**, souvent avec une durée de validité et un plafond de données. Il faut enrichir `product_catalog` plutôt que de forcer ces produits dans le même moule que la voix.

### Extension de `product_catalog` pour les eSIM

| Champ | Exemple | Notes |
|---|---|---|
| `category` | `esim_data` | |
| `provider_id` | Airalo ou eSIM Go | |
| `plan_code` | `CI-7D-3GB` | code interne du package |
| `destination_country` ou `region_code` | `CI` ou `AFRICA-REGIONAL` | Airalo/eSIM Go vendent souvent des packs régionaux |
| `data_cap_mb` | 3000 | plafond en Mo |
| `validity_days` | 7 | durée avant expiration |
| `throttle_after_cap` | true/false | coupure ou ralentissement après plafond |
| `activation_type` | `qr_code` / `direct_provision_api` | selon le fournisseur |
| `cost_provider` / `price_user` | | comme les autres produits |

**Cycle de vie spécifique à gérer dans `orders`** : un ordre eSIM n'est pas "instantané" comme un SMS. Il passe par des états supplémentaires — `provisioning` (appel à l'API du fournisseur pour générer le profil eSIM), `ready` (QR code / LPA disponible), `activated` (l'utilisateur a scanné/installé), `expired`. Prévois un champ `esim_iccid` et `esim_lpa_string` dans une table `esim_profiles` liée à `orders`, car Airalo et eSIM Go renvoient ces identifiants au provisioning et tu en as besoin pour le support client (remplacement, réémission de QR code).

### Extension pour le satellite

Le satellite ne se comporte ni comme la voix classique ni comme l'eSIM — c'est un **accès matériel** (terminal/SIM satellite physique ou module IoT) plus une **souscription de service**, rarement un simple appel API self-service (voir section fournisseurs plus haut). Modélisation suggérée :

| Champ | Exemple | Notes |
|---|---|---|
| `category` | `satellite_voice`, `satellite_data`, `satellite_iot` | |
| `provider_id` | agrégateur (Skylo, Syniverse, KORE...) plutôt que Iridium en direct | |
| `plan_code` | `SAT-VOICE-100MIN` | |
| `requires_hardware` | true | terminal/module physique à fournir ou faire fournir |
| `hardware_sku` | référence du terminal si LAFLHAI le distribue | |
| `activation_lead_time_days` | ex. 2-5 jours | contrairement au reste, pas instantané |
| `contract_type` | `prepaid_topup` / `postpaid_partner` | selon l'accord avec l'agrégateur |

**Implication produit importante** : contrairement à l'appel classique ou au SMS, un achat de crédit satellite dans l'app ne peut probablement pas déclencher une activation instantanée en phase 1 — il faut prévoir dans `orders` un statut `pending_manual_provisioning` et un flux (même semi-manuel au début) pour ne pas bloquer le reste du produit sur cette dépendance externe la plus lente et la moins API-isée du catalogue.

---

## Prochaines étapes possibles
- Prototyper le `ProviderRouter` avec Telnyx + Africa's Talking en primaire
- Définir la politique de marge (`margin_pct`) par catégorie de produit
- Spécifier le format exact des webhooks Twilio/Telnyx pour alimenter `usage_events`
- Négocier avec un agrégateur satellite (plutôt qu'Iridium/Inmarsat en direct) pour la phase 2
