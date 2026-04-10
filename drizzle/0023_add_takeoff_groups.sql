DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS "takeoff_groups" (
    "id" serial PRIMARY KEY,
    "project_id" integer NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
    "name" varchar(255) NOT NULL,
    "kind" varchar(20) NOT NULL,
    "color" varchar(20),
    "csi_code" varchar(20),
    "sort_order" integer NOT NULL DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT now(),
    "updated_at" timestamp with time zone DEFAULT now()
  );
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "idx_takeoff_groups_project" ON "takeoff_groups" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_takeoff_groups_project_kind" ON "takeoff_groups" ("project_id", "kind");

ALTER TABLE "takeoff_items" ADD COLUMN IF NOT EXISTS "group_id" integer REFERENCES "takeoff_groups"("id") ON DELETE SET NULL;
