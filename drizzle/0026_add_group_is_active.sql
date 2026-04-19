-- 0026 — annotation_groups.is_active flag
--
-- Boolean column letting a group temporarily disable its select-all
-- expansion + outline rendering without dropping memberships.
-- Default true so every existing row is "active" on upgrade.
--
-- Idempotent via DO $$ EXCEPTION pattern from 0025. Safe to re-run.

DO $$ BEGIN
  ALTER TABLE "annotation_groups" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
