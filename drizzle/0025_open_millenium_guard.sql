-- 0025 — Annotation groups + M:N membership
--
-- New tables for user-created annotation groupings. Annotations
-- (YOLO detections, Shape Parse keynotes, Symbol Search matches,
-- markups, etc.) can be grouped under a shared name/CSI/notes/color.
-- Cardinality is M:N — an annotation can belong to any number of
-- groups, enforced by the composite PK on the junction table.
--
-- Idempotent via CREATE TABLE IF NOT EXISTS + DO $$ EXCEPTION guards
-- matching the 0023_add_takeoff_groups.sql pattern — safe to re-run.
--
-- NOTE: drizzle-kit generated a much larger 0025 bundle because the
-- meta/ snapshot history was wiped; only 0000_snapshot.json and this
-- file's snapshot remained. The bundled version tried to CREATE TABLE
-- on 9 already-existing tables, which would have crashed entrypoint.sh's
-- auto-migrate at container boot. Hand-rewritten 2026-04-18 to the
-- actual diff. The 0025_snapshot.json is correct as-is (reflects full
-- schema state); future db:generate calls can diff against it safely.

DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS "annotation_groups" (
    "id" serial PRIMARY KEY,
    "project_id" integer NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
    "name" varchar(255) NOT NULL,
    "csi_code" varchar(20),
    "notes" text,
    "color" varchar(20),
    "created_by" integer REFERENCES "users"("id"),
    "created_at" timestamp with time zone DEFAULT now(),
    "updated_at" timestamp with time zone DEFAULT now()
  );
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS "annotation_group_members" (
    "annotation_id" integer NOT NULL REFERENCES "annotations"("id") ON DELETE CASCADE,
    "group_id" integer NOT NULL REFERENCES "annotation_groups"("id") ON DELETE CASCADE,
    "added_at" timestamp with time zone DEFAULT now(),
    CONSTRAINT "annotation_group_members_annotation_id_group_id_pk" PRIMARY KEY("annotation_id","group_id")
  );
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "idx_annotation_groups_project" ON "annotation_groups" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_annotation_group_members_group" ON "annotation_group_members" ("group_id");
