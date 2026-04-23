-- Migration 0028 — Admin Logs tab schema
-- Adds abuse_events (row per security-signal event) and manual_ip_bans
-- (Root_Admin-initiated bans). Scoped to the Logs tab introduced in
-- the Reddit-launch hardening follow-up.

CREATE TABLE IF NOT EXISTS "abuse_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "event_type" varchar(40) NOT NULL,
  "ip" varchar(45) NOT NULL,
  "country" varchar(2),
  "path" varchar(255),
  "user_agent" varchar(500),
  "details" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "seen_at" timestamp with time zone
);

CREATE INDEX IF NOT EXISTS "idx_abuse_events_created" ON "abuse_events" ("created_at");
CREATE INDEX IF NOT EXISTS "idx_abuse_events_unseen" ON "abuse_events" ("seen_at");

CREATE TABLE IF NOT EXISTS "manual_ip_bans" (
  "id" serial PRIMARY KEY NOT NULL,
  "ip" varchar(45) NOT NULL,
  "reason" varchar(500),
  "banned_by_user_id" integer,
  "banned_until" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "manual_ip_bans_ip_unique" UNIQUE("ip")
);
