-- Add takeoff_items table for quantity takeoff counting
CREATE TABLE IF NOT EXISTS "takeoff_items" (
  "id" serial PRIMARY KEY,
  "project_id" integer NOT NULL REFERENCES "projects"("id"),
  "name" varchar(255) NOT NULL,
  "shape" varchar(50) NOT NULL,
  "color" varchar(20) NOT NULL,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_takeoff_items_project" ON "takeoff_items" ("project_id");

-- Backfill search vectors for any pages missing them
UPDATE pages SET search_vector = to_tsvector('english', raw_text)
WHERE raw_text IS NOT NULL AND search_vector IS NULL;
