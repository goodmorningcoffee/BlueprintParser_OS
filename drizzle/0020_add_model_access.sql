-- Add company ownership to models
ALTER TABLE models ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);
UPDATE models SET company_id = 1 WHERE company_id IS NULL;
ALTER TABLE models ALTER COLUMN company_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_models_company ON models(company_id);

-- Model access control: which companies can use which models
CREATE TABLE IF NOT EXISTS model_access (
  id SERIAL PRIMARY KEY,
  model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  granted_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(model_id, company_id)
);
CREATE INDEX IF NOT EXISTS idx_model_access_company ON model_access(company_id);
CREATE INDEX IF NOT EXISTS idx_model_access_model ON model_access(model_id);

-- Grant access to all existing companies for the 3 legacy models
INSERT INTO model_access (model_id, company_id, enabled, granted_by)
SELECT m.id, c.id, true, 1
FROM models m CROSS JOIN companies c
WHERE m.company_id = 1
ON CONFLICT (model_id, company_id) DO NOTHING;
