CREATE TABLE "project_asset_deletions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_public_id" uuid NOT NULL,
	"company_id" integer NOT NULL,
	"storage_root" varchar(255) NOT NULL,
	"lifecycle_epoch" bigint NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"phase" varchar(20) DEFAULT 'purge' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"s3_purged_at" timestamp with time zone,
	"invalidation_generation" integer DEFAULT 0 NOT NULL,
	"cloudfront_invalidation_id" text,
	"last_error" text,
	"last_verified_at" timestamp with time zone,
	"attention_required_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "project_asset_deletions_storage_root_unique" UNIQUE("storage_root")
);
--> statement-breakpoint
CREATE INDEX "idx_project_asset_deletions_due" ON "project_asset_deletions" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_project_asset_deletions_lease" ON "project_asset_deletions" USING btree ("lease_expires_at");--> statement-breakpoint

ALTER TABLE "project_asset_deletions"
  ADD CONSTRAINT "project_asset_deletions_status_check"
  CHECK ("status" IN ('pending', 'watching', 'completed'));--> statement-breakpoint
ALTER TABLE "project_asset_deletions"
  ADD CONSTRAINT "project_asset_deletions_phase_check"
  CHECK ("phase" IN ('purge', 'invalidate', 'verify', 'watch', 'complete'));--> statement-breakpoint
ALTER TABLE "project_asset_deletions"
  ADD CONSTRAINT "project_asset_deletions_watch_check"
  CHECK (("phase" = 'watch') = ("status" = 'watching'));--> statement-breakpoint
ALTER TABLE "project_asset_deletions"
  ADD CONSTRAINT "project_asset_deletions_complete_check"
  CHECK (("phase" = 'complete') = ("status" = 'completed'));--> statement-breakpoint
ALTER TABLE "project_asset_deletions"
  ADD CONSTRAINT "project_asset_deletions_watched_completion_check"
  CHECK ("status" NOT IN ('watching', 'completed') OR "completed_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "project_asset_deletions"
  ADD CONSTRAINT "project_asset_deletions_lease_check"
  CHECK (("lease_token" IS NULL) = ("lease_expires_at" IS NULL));--> statement-breakpoint
ALTER TABLE "project_asset_deletions"
  ADD CONSTRAINT "project_asset_deletions_counter_check"
  CHECK (
    "attempt_count" >= 0
    AND "consecutive_failures" >= 0
    AND "invalidation_generation" >= 0
  );--> statement-breakpoint
ALTER TABLE "project_asset_deletions"
  ADD CONSTRAINT "project_asset_deletions_storage_root_check"
  CHECK (
    "storage_root" ~ '^[a-z0-9-]+/[a-f0-9]{20}$'
    AND split_part("storage_root", '/', 1)
      NOT IN ('_bp-staging', '_bp-public', 'models', 'tmp', 'config', 'csi-databases')
  );--> statement-breakpoint

-- Serialize storage-root creation with deletion before either side consults its row/table state.
-- The application takes the same transaction-scoped advisory lock explicitly for a clean 409;
-- this trigger is the DB backstop for every future INSERT sink.
CREATE OR REPLACE FUNCTION bp_guard_retired_project_storage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.data_url, 2026071401));
  IF EXISTS (
    SELECT 1
    FROM project_asset_deletions
    WHERE storage_root = NEW.data_url
  ) THEN
    RAISE EXCEPTION 'project storage root has been retired'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER bp_guard_retired_project_storage
BEFORE INSERT ON projects
FOR EACH ROW
EXECUTE FUNCTION bp_guard_retired_project_storage();
