DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS llm_configs (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL,
    model VARCHAR(100) NOT NULL,
    encrypted_api_key TEXT,
    base_url TEXT,
    is_demo BOOLEAN NOT NULL DEFAULT false,
    is_default BOOLEAN NOT NULL DEFAULT false,
    config JSONB,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  );
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_llm_configs_company ON llm_configs (company_id);

-- Prevent duplicate active defaults per scope (company + demo/non-demo)
-- Partial unique index: only enforced when user_id IS NULL AND is_default = true
CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_configs_active
  ON llm_configs (company_id, is_demo)
  WHERE user_id IS NULL AND is_default = true;
