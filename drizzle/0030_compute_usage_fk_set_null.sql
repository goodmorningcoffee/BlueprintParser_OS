-- Migration 0030 — let the compute_usage ledger survive user/project deletion.
-- 0029 created compute_usage.user_id / project_id with inline REFERENCES, which
-- default to ON DELETE NO ACTION (RESTRICT) — so deleting a user or project that
-- the ledger references fails with a 500. The ledger is append-only billing
-- history, so we NULL the link instead of blocking the delete (companyId + pages
-- are preserved). companyId stays RESTRICT (the tenant root isn't deleted in
-- normal flow). Idempotent: drops whatever FK names 0029 generated, re-adds with
-- ON DELETE SET NULL.

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'compute_usage'::regclass
      AND contype = 'f'
      AND confrelid IN ('users'::regclass, 'projects'::regclass)
  LOOP
    EXECUTE 'ALTER TABLE "compute_usage" DROP CONSTRAINT ' || quote_ident(r.conname);
  END LOOP;
END $$;

DO $$ BEGIN
  ALTER TABLE "compute_usage"
    ADD CONSTRAINT "compute_usage_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "compute_usage"
    ADD CONSTRAINT "compute_usage_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
