CREATE TABLE "login_lockouts" (
	"email" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_attempt" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "op_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" varchar(40) NOT NULL,
	"request" jsonb,
	"response" jsonb
);
--> statement-breakpoint
CREATE TABLE "runtime_counters" (
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"reset_at" timestamp with time zone NOT NULL,
	CONSTRAINT "runtime_counters_scope_key_pk" PRIMARY KEY("scope","key")
);
--> statement-breakpoint
ALTER TABLE "manual_ip_bans" ADD COLUMN "source" varchar(10) DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "manual_ip_bans" ADD COLUMN "violations" integer;--> statement-breakpoint
ALTER TABLE "manual_ip_bans" ADD COLUMN "first_violation_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_op_log_created" ON "op_log" USING btree ("created_at");