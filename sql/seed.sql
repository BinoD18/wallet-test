-- Données d'amorçage — fournisseurs + tarifs indicatifs pour la Côte d'Ivoire (§2 du .md)
-- À ajuster/remplacer par le job syncCatalogOnce() une fois les vraies clés API branchées.

INSERT INTO provider_accounts (provider_name, credentials_ref, country_scope, active, reliability_score)
VALUES
  ('twilio', 'vault://providers/twilio', NULL, true, 0.995),
  ('telnyx', 'vault://providers/telnyx', NULL, true, 0.99),
  ('africas_talking', 'vault://providers/africas_talking', ARRAY['CI','SN','KE','NG','GH'], true, 0.985)
ON CONFLICT DO NOTHING;

-- Tarifs SMS/voix Côte d'Ivoire, comparatif §2
INSERT INTO product_catalog (provider_id, category, destination_country, unit, cost_provider, price_user)
SELECT id, 'sms', 'CI', 'sms', 0.245, 0.35 FROM provider_accounts WHERE provider_name = 'twilio'
UNION ALL
SELECT id, 'sms', 'CI', 'sms', 0.01, 0.05 FROM provider_accounts WHERE provider_name = 'telnyx'
UNION ALL
SELECT id, 'sms', 'CI', 'sms', 0.01, 0.05 FROM provider_accounts WHERE provider_name = 'africas_talking'
UNION ALL
SELECT id, 'voice_intl', 'CI', 'minute', 0.15, 0.25 FROM provider_accounts WHERE provider_name = 'twilio'
UNION ALL
SELECT id, 'voice_intl', 'CI', 'minute', 0.005, 0.05 FROM provider_accounts WHERE provider_name = 'telnyx'
UNION ALL
SELECT id, 'voice_intl', 'CI', 'minute', 0.02, 0.06 FROM provider_accounts WHERE provider_name = 'africas_talking';
