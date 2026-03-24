-- Add audit_log table for security event tracking
CREATE TABLE IF NOT EXISTS "audit_log" (
  "id" serial PRIMARY KEY,
  "action" varchar(100) NOT NULL,
  "user_id" integer,
  "company_id" integer,
  "details" jsonb,
  "ip" varchar(45),
  "created_at" timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_audit_action" ON "audit_log" ("action");
