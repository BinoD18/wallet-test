-- ============================================================
-- LAFLHAI — Schéma wallet / ledger / catalogue / eSIM / satellite
-- Implémente LAFLHAI-architecture-technique.md sections 1 et 5
-- PostgreSQL 14+
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- pour gen_random_uuid()

-- ---------- users ----------
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number  TEXT UNIQUE NOT NULL,
  email         TEXT,
  country_code  TEXT NOT NULL,               -- ISO 3166-1 alpha-2, ex: 'CI'
  kyc_status    TEXT NOT NULL DEFAULT 'none' -- none | pending | verified | rejected
                CHECK (kyc_status IN ('none','pending','verified','rejected')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- wallets ----------
CREATE TABLE IF NOT EXISTS wallets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  balance     NUMERIC(18,4) NOT NULL DEFAULT 0, -- jamais un float ; recalculé depuis ledger_entries
  currency    TEXT NOT NULL DEFAULT 'XOF' CHECK (currency IN ('XOF','USD','EUR')),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen')),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, currency)
);

-- ---------- ledger_entries : source de vérité, comptabilité en partie double ----------
CREATE TABLE IF NOT EXISTS ledger_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id       UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  type            TEXT NOT NULL CHECK (type IN ('credit','debit')),
  amount          NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  balance_after   NUMERIC(18,4) NOT NULL,
  reference_type  TEXT NOT NULL CHECK (reference_type IN ('topup','purchase','refund','adjustment','reward')),
  reference_id    UUID,           -- FK logique vers orders.id ou payment_transactions.id selon reference_type
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ledger_wallet ON ledger_entries(wallet_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_reference ON ledger_entries(reference_type, reference_id);

-- ---------- provider_accounts ----------
CREATE TABLE IF NOT EXISTS provider_accounts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_name  TEXT NOT NULL,   -- twilio | telnyx | africas_talking | airalo | esim_go | cinetpay ...
  credentials_ref TEXT NOT NULL,  -- pointeur vers un coffre-fort de secrets (jamais de clé en clair ici)
  country_scope  TEXT[],          -- codes ISO pays couverts, NULL = mondial
  active         BOOLEAN NOT NULL DEFAULT true,
  recent_failure_rate NUMERIC(5,4) NOT NULL DEFAULT 0, -- alimenté par les health checks
  reliability_score   NUMERIC(4,3) NOT NULL DEFAULT 1.0,
  circuit_open_until  TIMESTAMPTZ, -- circuit breaker : NULL = fermé (opérationnel)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- product_catalog ----------
CREATE TABLE IF NOT EXISTS product_catalog (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id         UUID NOT NULL REFERENCES provider_accounts(id),
  category            TEXT NOT NULL CHECK (category IN (
                         'voice_intl','voice_mobile','sms','esim_data',
                         'satellite_voice','satellite_data','satellite_iot'
                       )),
  destination_country TEXT,       -- ISO pays, NULL si régional
  region_code         TEXT,       -- ex: 'AFRICA-REGIONAL' pour les packs eSIM régionaux
  unit                TEXT NOT NULL, -- minute | sms | mo
  cost_provider       NUMERIC(12,6) NOT NULL, -- ce que ça coûte à LAFLHAI
  price_user          NUMERIC(12,6) NOT NULL, -- ce que ça coûte à l'utilisateur
  margin_pct          NUMERIC(5,4) GENERATED ALWAYS AS (
                         CASE WHEN price_user > 0
                           THEN (price_user - cost_provider) / price_user
                           ELSE 0 END
                       ) STORED,

  -- Extension eSIM (section 5)
  plan_code           TEXT,
  data_cap_mb         INTEGER,
  validity_days       INTEGER,
  throttle_after_cap  BOOLEAN,
  activation_type     TEXT CHECK (activation_type IN ('qr_code','direct_provision_api')),

  -- Extension satellite (section 5)
  requires_hardware        BOOLEAN NOT NULL DEFAULT false,
  hardware_sku              TEXT,
  activation_lead_time_days INTEGER,
  contract_type              TEXT CHECK (contract_type IN ('prepaid_topup','postpaid_partner')),

  active              BOOLEAN NOT NULL DEFAULT true,
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT now() -- dernier resync tarifs (job périodique)
);
CREATE INDEX IF NOT EXISTS idx_catalog_lookup ON product_catalog(category, destination_country, active);

-- ---------- orders ----------
CREATE TABLE IF NOT EXISTS orders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id),
  product_id          UUID NOT NULL REFERENCES product_catalog(id),
  quantity            NUMERIC(12,4) NOT NULL,
  total_price         NUMERIC(18,4) NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                         'pending','provisioning','ready','activated',
                         'completed','failed','expired','pending_manual_provisioning'
                       )),
  provider_reference  TEXT,  -- SID Twilio, ICCID eSIM, etc.

  -- Explicabilité du routage (section 4)
  selected_provider    UUID REFERENCES provider_accounts(id),
  routing_reason        TEXT,
  alternatives_considered JSONB,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at);

-- ---------- esim_profiles (section 5) ----------
CREATE TABLE IF NOT EXISTS esim_profiles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  esim_iccid    TEXT,
  esim_lpa_string TEXT,
  status        TEXT NOT NULL DEFAULT 'provisioning' CHECK (status IN (
                   'provisioning','ready','activated','expired'
                 )),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- usage_events ----------
CREATE TABLE IF NOT EXISTS usage_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           UUID REFERENCES orders(id),
  user_id            UUID REFERENCES users(id),
  event_type         TEXT NOT NULL CHECK (event_type IN ('call_made','sms_sent','data_consumed')),
  provider_event_id  TEXT,      -- id de l'événement chez le fournisseur (idempotence webhook)
  quantity_consumed  NUMERIC(12,4) NOT NULL,
  cost_incurred      NUMERIC(12,6) NOT NULL,
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_usage_provider_event ON usage_events(provider_event_id)
  WHERE provider_event_id IS NOT NULL;

-- ---------- payment_transactions ----------
CREATE TABLE IF NOT EXISTS payment_transactions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES users(id),
  wallet_id              UUID NOT NULL REFERENCES wallets(id),
  provider               TEXT NOT NULL, -- cinetpay | orange_money | mtn_momo | visa ...
  provider_transaction_id TEXT,
  amount                 NUMERIC(18,4) NOT NULL,
  currency               TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                            'pending','accepted','refused','failed'
                          )),
  raw_payload            JSONB,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payment_tx_user ON payment_transactions(user_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_provider_tx ON payment_transactions(provider, provider_transaction_id)
  WHERE provider_transaction_id IS NOT NULL;

-- ---------- watch_earn_rewards : idempotence des récompenses "Watch & Earn" ----------
-- (module publicitaire côté app, hors périmètre télécom du .md, mais partage le même ledger)
CREATE TABLE IF NOT EXISTS watch_earn_rewards (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ad_id        TEXT NOT NULL,
  watched_sec  INTEGER NOT NULL,
  amount       NUMERIC(12,4) NOT NULL,
  reward_date  DATE NOT NULL DEFAULT CURRENT_DATE, -- colonne simple plutôt qu'un index sur (created_at::date),
                                                     -- qui n'est pas IMMUTABLE (dépend du fuseau horaire de session)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Empêche un double crédit pour la même pub le même jour côté serveur
CREATE UNIQUE INDEX IF NOT EXISTS uq_watch_earn_user_ad_day
  ON watch_earn_rewards (user_id, ad_id, reward_date);

-- ---------- provider_health_log : historique des health checks (alimente le router) ----------
CREATE TABLE IF NOT EXISTS provider_health_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id  UUID NOT NULL REFERENCES provider_accounts(id),
  is_up        BOOLEAN NOT NULL,
  latency_ms   INTEGER,
  checked_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_provider_health ON provider_health_log(provider_id, checked_at);
