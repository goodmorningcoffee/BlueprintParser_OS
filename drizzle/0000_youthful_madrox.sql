-- Idempotent migration: safe to run against existing blueprintparser_current DB

-- Enums (may already exist from blueprintparser_current)
DO $$ BEGIN CREATE TYPE "public"."job_status" AS ENUM('running', 'completed', 'failed'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."project_status" AS ENUM('uploading', 'processing', 'completed', 'error'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

-- Tables that already exist in blueprintparser_current (IF NOT EXISTS)
CREATE TABLE IF NOT EXISTS "companies" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"data_key" varchar(255) NOT NULL,
	"access_key" varchar(255) NOT NULL,
	"email_domain" varchar(255) NOT NULL,
	"subscription" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "companies_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "companies_name_unique" UNIQUE("name"),
	CONSTRAINT "companies_data_key_unique" UNIQUE("data_key")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"username" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"role" varchar(50) DEFAULT 'member' NOT NULL,
	"company_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "users_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"data_url" varchar(255) NOT NULL,
	"num_pages" integer,
	"status" "project_status" DEFAULT 'uploading' NOT NULL,
	"processing_error" text,
	"processing_time" integer,
	"job_id" varchar(255),
	"address" text,
	"latitude" double precision,
	"longitude" double precision,
	"author_id" integer NOT NULL,
	"company_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "projects_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "projects_data_url_unique" UNIQUE("data_url")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pages" (
	"id" serial PRIMARY KEY NOT NULL,
	"page_number" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"raw_text" text,
	"error" text,
	"project_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "annotations" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"min_x" real NOT NULL,
	"max_x" real NOT NULL,
	"min_y" real NOT NULL,
	"max_y" real NOT NULL,
	"page_number" integer NOT NULL,
	"threshold" real,
	"data" jsonb,
	"note" text,
	"creator_id" integer,
	"project_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_token" varchar(255) NOT NULL,
	"user_id" integer NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "sessions_session_token_unique" UNIQUE("session_token")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "processing_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"step_function_arn" text,
	"execution_id" text,
	"status" "job_status" DEFAULT 'running' NOT NULL,
	"model_config" jsonb,
	"started_at" timestamp with time zone DEFAULT now(),
	"completed_at" timestamp with time zone,
	"error" text
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "models" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"type" varchar(50) NOT NULL,
	"s3_path" text NOT NULL,
	"config" jsonb,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);--> statement-breakpoint

-- NEW tables for blueprintparser_2
CREATE TABLE IF NOT EXISTS "chat_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"page_number" integer,
	"role" varchar(20) NOT NULL,
	"content" text NOT NULL,
	"model" varchar(100),
	"user_id" integer,
	"created_at" timestamp with time zone DEFAULT now()
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_api_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"provider" varchar(50) NOT NULL,
	"encrypted_key" text NOT NULL,
	"label" varchar(255),
	"created_at" timestamp with time zone DEFAULT now()
);--> statement-breakpoint

-- NEW columns on existing tables (ADD COLUMN IF NOT EXISTS)
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "features" jsonb;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN IF NOT EXISTS "drawing_number" varchar(100);--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN IF NOT EXISTS "textract_data" jsonb;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN IF NOT EXISTS "keynotes" jsonb;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN IF NOT EXISTS "csi_codes" jsonb;--> statement-breakpoint
ALTER TABLE "annotations" ADD COLUMN IF NOT EXISTS "source" varchar(50) DEFAULT 'user' NOT NULL;--> statement-breakpoint

-- Foreign keys (wrapped in exception blocks for idempotency)
DO $$ BEGIN ALTER TABLE "annotations" ADD CONSTRAINT "annotations_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "annotations" ADD CONSTRAINT "annotations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "pages" ADD CONSTRAINT "pages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "projects" ADD CONSTRAINT "projects_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "projects" ADD CONSTRAINT "projects_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "user_api_keys" ADD CONSTRAINT "user_api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "users" ADD CONSTRAINT "users_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

-- Indexes (IF NOT EXISTS)
CREATE INDEX IF NOT EXISTS "idx_annotations_project" ON "annotations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_annotations_name" ON "annotations" USING btree ("name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_project" ON "chat_messages" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pages_project" ON "pages" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_jobs_project" ON "processing_jobs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_api_keys_user" ON "user_api_keys" USING btree ("user_id");
