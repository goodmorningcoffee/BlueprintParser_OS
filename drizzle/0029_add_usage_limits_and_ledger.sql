-- Migration 0029 — root_admin compute-usage metering
-- (1) Per-company SageMaker/Textract page limits + reset window on `companies`
-- (2) Optional per-user SageMaker sub-cap + reset window on `users`
-- (3) `compute_usage` append-only ledger — source of truth for the caps
--     enforced in src/lib/compute-usage.ts and the root Usage dashboard.
-- Idempotent like 0025–0028: ALTERs guarded by duplicate_column, the new
-- table/indexes by IF NOT EXISTS, so re-runs never crash.

DO $$ BEGIN
  ALTER TABLE "companies" ADD COLUMN "sagemaker_page_limit" integer DEFAULT 500 NOT NULL;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "companies" ADD COLUMN "textract_page_limit" integer DEFAULT 10000 NOT NULL;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "companies" ADD COLUMN "usage_reset_interval" varchar(50) DEFAULT 'manual' NOT NULL;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "companies" ADD COLUMN "usage_window_start" timestamp with time zone;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "users" ADD COLUMN "sagemaker_page_limit" integer;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "users" ADD COLUMN "usage_window_start" timestamp with time zone;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "compute_usage" (
  "id" serial PRIMARY KEY NOT NULL,
  "company_id" integer NOT NULL REFERENCES "companies"("id"),
  "user_id" integer REFERENCES "users"("id"),
  "project_id" integer REFERENCES "projects"("id"),
  "resource" varchar(50) NOT NULL,
  "pages" integer NOT NULL,
  "job_id" varchar(255),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_compute_usage_company" ON "compute_usage" ("company_id","resource","created_at");
CREATE INDEX IF NOT EXISTS "idx_compute_usage_user" ON "compute_usage" ("user_id","resource","created_at");
