-- Global application settings (key-value store for root admin config)
CREATE TABLE IF NOT EXISTS app_settings (
  key VARCHAR(100) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed default header links for the demo page nav
INSERT INTO app_settings (key, value) VALUES
  ('header_links', '{"home":"https://blueprintparser.com","hded":"https://hded.blueprintparser.com","modelExchange":"https://models.blueprintparser.com","planExchange":"https://planexchange.blueprintparser.com","labelFleet":"https://labelfleet.xyz"}'::jsonb)
ON CONFLICT (key) DO NOTHING;
