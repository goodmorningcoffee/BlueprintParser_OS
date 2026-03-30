DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS "qto_workflows" (
    "id" serial PRIMARY KEY,
    "project_id" integer NOT NULL REFERENCES "projects"("id"),
    "material_type" text NOT NULL,
    "material_label" text,
    "step" text NOT NULL DEFAULT 'pick',
    "schedule_page_number" integer,
    "yolo_model_filter" text,
    "yolo_class_filter" text,
    "tag_pattern" text,
    "parsed_schedule" jsonb,
    "line_items" jsonb,
    "user_edits" jsonb,
    "exported_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT now(),
    "updated_at" timestamp with time zone DEFAULT now()
  );
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "idx_qto_workflows_project" ON "qto_workflows" ("project_id");
