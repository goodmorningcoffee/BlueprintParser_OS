-- 0027 — projects.staging_manifest
--
-- JSONB column carrying the ordered list of files that were uploaded to
-- `${dataUrl}/staging/` and need to be concatenated into `original.pdf`
-- before the processing pipeline runs. Nullable: legacy projects (pre-0027)
-- already have `original.pdf` written directly by the old single-PDF
-- UploadWidget path, so they don't need a manifest.
--
-- Shape: StagingFile[] = [{ filename, stagingKey, size }, ...]
-- See src/types/index.ts and src/lib/db/schema.ts.
--
-- Idempotent via DO $$ EXCEPTION pattern from 0025 + 0026. Safe to re-run.

DO $$ BEGIN
  ALTER TABLE "projects" ADD COLUMN "staging_manifest" jsonb;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
