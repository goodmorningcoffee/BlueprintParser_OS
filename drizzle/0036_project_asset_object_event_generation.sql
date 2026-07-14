ALTER TABLE "project_asset_deletions" ADD COLUMN "object_event_generation" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_asset_deletions" ADD COLUMN "last_reconciled_event_generation" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_asset_deletions"
  ADD CONSTRAINT "project_asset_deletions_event_generation_check"
  CHECK (
    "object_event_generation" >= 0
    AND "last_reconciled_event_generation" >= 0
    AND "last_reconciled_event_generation" <= "object_event_generation"
  );
