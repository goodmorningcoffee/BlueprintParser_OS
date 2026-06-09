-- Migration 0031 — per-user YOLO model-access grants.
-- model_access was company-level only (UNIQUE(model_id, company_id)). Add a
-- nullable user_id so root_admin can grant a model to a WHOLE company (user_id
-- NULL) OR a SPECIFIC user (user_id set). The old (model,company) unique blocks
-- per-user rows, so replace it with partial uniques: one company grant per
-- (model, company), and one grant per (model, company, user). Idempotent.

DO $$ BEGIN
  ALTER TABLE "model_access" ADD COLUMN "user_id" integer REFERENCES "users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Drop the old UNIQUE(model_id, company_id) constraint (whatever it's named).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'model_access'::regclass AND contype = 'u'
  LOOP
    EXECUTE 'ALTER TABLE "model_access" DROP CONSTRAINT ' || quote_ident(r.conname);
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "uq_model_access_company" ON "model_access" ("model_id","company_id") WHERE "user_id" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "uq_model_access_user" ON "model_access" ("model_id","company_id","user_id") WHERE "user_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_model_access_user" ON "model_access" ("user_id");
