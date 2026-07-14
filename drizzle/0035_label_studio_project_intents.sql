CREATE TABLE "label_studio_project_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" integer NOT NULL,
	"company_id" integer NOT NULL,
	"lifecycle_epoch" bigint NOT NULL,
	"marker" varchar(255) NOT NULL,
	"provider_project_id" integer,
	"state" varchar(30) DEFAULT 'creating' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "label_studio_project_intents_project_id_unique" UNIQUE("project_id"),
	CONSTRAINT "label_studio_project_intents_marker_unique" UNIQUE("marker")
);
--> statement-breakpoint
ALTER TABLE "labeling_sessions" ADD COLUMN "provisioning_intent_id" uuid;--> statement-breakpoint
ALTER TABLE "label_studio_project_intents" ADD CONSTRAINT "label_studio_project_intents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label_studio_project_intents" ADD CONSTRAINT "label_studio_project_intents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_label_studio_project_intents_due" ON "label_studio_project_intents" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_label_studio_project_intents_lease" ON "label_studio_project_intents" USING btree ("lease_expires_at");--> statement-breakpoint
ALTER TABLE "labeling_sessions" ADD CONSTRAINT "labeling_sessions_provisioning_intent_id_unique" UNIQUE("provisioning_intent_id");--> statement-breakpoint

ALTER TABLE "label_studio_project_intents"
  ADD CONSTRAINT "label_studio_project_intents_state_check"
  CHECK ("state" IN ('creating', 'create_uncertain', 'cleanup_pending'));--> statement-breakpoint
ALTER TABLE "label_studio_project_intents"
  ADD CONSTRAINT "label_studio_project_intents_provider_check"
  CHECK ("state" <> 'cleanup_pending' OR "provider_project_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "label_studio_project_intents"
  ADD CONSTRAINT "label_studio_project_intents_lease_check"
  CHECK (("lease_token" IS NULL) = ("lease_expires_at" IS NULL));--> statement-breakpoint
ALTER TABLE "label_studio_project_intents"
  ADD CONSTRAINT "label_studio_project_intents_counter_check"
  CHECK (
    "attempt_count" >= 0
    AND "consecutive_failures" >= 0
    AND "lifecycle_epoch" >= 0
  );--> statement-breakpoint
ALTER TABLE "label_studio_project_intents"
  ADD CONSTRAINT "label_studio_project_intents_marker_check"
  CHECK ("marker" ~ '^bp-labeling-intent:[0-9a-f-]{36}$');--> statement-breakpoint

CREATE TRIGGER label_studio_project_intents_demo_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON label_studio_project_intents
FOR EACH ROW EXECUTE FUNCTION bp_guard_direct_project_child('project_id');
