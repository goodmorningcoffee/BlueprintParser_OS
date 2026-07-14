-- Close the final direct-database race around legacy namespace admission. Drizzle executes pending
-- migrations in one transaction, so these locks remain held until the validated company constraint
-- and project lifecycle trigger below are installed (and through the rest of this cutover batch).
LOCK TABLE companies, projects IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint

DO $$
DECLARE
  invalid_company record;
  invalid_project record;
BEGIN
  SELECT id, data_key
    INTO invalid_company
    FROM companies
   WHERE data_key !~ '^[a-z0-9-]+$'
      OR data_key IN ('_bp-staging', '_bp-public', 'models', 'tmp', 'config', 'csi-databases')
   ORDER BY id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Invalid legacy company storage namespace before migration 0033',
      DETAIL = format('company %s uses %s', invalid_company.id, invalid_company.data_key);
  END IF;

  SELECT p.id, p.data_url, c.data_key
    INTO invalid_project
    FROM projects AS p
    LEFT JOIN companies AS c ON c.id = p.company_id
   WHERE c.id IS NULL
      OR p.data_url !~ ('^' || c.data_key || '/[a-f0-9]{20}$')
   ORDER BY p.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Invalid legacy project storage root before migration 0033',
      DETAIL = format('project %s uses %s', invalid_project.id, invalid_project.data_url);
  END IF;
END;
$$;--> statement-breakpoint

CREATE TABLE "project_mutation_leases" (
	"token" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" integer NOT NULL,
	"lifecycle_epoch" bigint NOT NULL,
	"kind" varchar(80) NOT NULL,
	"idempotency_key" varchar(255),
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "lifecycle_epoch" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_mutation_leases" ADD CONSTRAINT "project_mutation_leases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_project_mutation_leases_project" ON "project_mutation_leases" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_project_mutation_leases_expiry" ON "project_mutation_leases" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_mutation_leases_idempotency" ON "project_mutation_leases" USING btree ("project_id","idempotency_key");--> statement-breakpoint

-- Database-level backstop for the standing invariant that a public demo is immutable. Application
-- writes still carry a lifecycle capability and use a parent-first transaction; these triggers make
-- an omitted wrapper fail closed and serialize child statements with manageDemo's project-row lock.
CREATE OR REPLACE FUNCTION bp_lock_private_project(target_project_id integer)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  target_is_demo boolean;
BEGIN
  IF target_project_id IS NULL THEN
    RETURN;
  END IF;

  SELECT is_demo
    INTO target_is_demo
    FROM projects
   WHERE id = target_project_id
   FOR SHARE;

  -- Let the owning foreign key report a missing parent.
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF target_is_demo THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Demo projects are read-only',
      CONSTRAINT = 'demo_project_read_only';
  END IF;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION bp_guard_direct_project_child()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_project_id integer;
  new_project_id integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_project_id := NULLIF(to_jsonb(OLD) ->> TG_ARGV[0], '')::integer;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_project_id := NULLIF(to_jsonb(NEW) ->> TG_ARGV[0], '')::integer;
  END IF;

  -- Stable ordering covers the rare cross-project UPDATE without introducing a lock cycle.
  IF old_project_id IS NOT NULL AND new_project_id IS NOT NULL
     AND old_project_id <> new_project_id THEN
    PERFORM bp_lock_private_project(LEAST(old_project_id, new_project_id));
    PERFORM bp_lock_private_project(GREATEST(old_project_id, new_project_id));
  ELSE
    PERFORM bp_lock_private_project(COALESCE(new_project_id, old_project_id));
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION bp_guard_annotation_group_member()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_annotation_project_id integer;
  old_group_project_id integer;
  new_annotation_project_id integer;
  new_group_project_id integer;
  target_project_id integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT project_id INTO old_annotation_project_id
      FROM annotations WHERE id = OLD.annotation_id;
    SELECT project_id INTO old_group_project_id
      FROM annotation_groups WHERE id = OLD.group_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT project_id INTO new_annotation_project_id
      FROM annotations WHERE id = NEW.annotation_id;
    SELECT project_id INTO new_group_project_id
      FROM annotation_groups WHERE id = NEW.group_id;
  END IF;

  -- UPDATE can detach a demo-owned membership while attaching a private one. Check both the old
  -- and new referenced projects, locking every distinct parent in stable order.
  FOR target_project_id IN
    SELECT DISTINCT project_id
      FROM unnest(ARRAY[
        old_annotation_project_id,
        old_group_project_id,
        new_annotation_project_id,
        new_group_project_id
      ]) AS project_ids(project_id)
     WHERE project_id IS NOT NULL
     ORDER BY project_id
  LOOP
    PERFORM bp_lock_private_project(target_project_id);
  END LOOP;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION bp_guard_project_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  unchanged_payload boolean;
  owning_company_data_key text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT data_key INTO owning_company_data_key
      FROM companies
     WHERE id = NEW.company_id;
    -- Let the owning foreign key report a missing company. Otherwise require one exact,
    -- non-nesting root beneath a slash-free and non-system company namespace.
    IF FOUND AND (
      owning_company_data_key !~ '^[a-z0-9-]+$'
      OR owning_company_data_key IN ('_bp-staging', '_bp-public', 'models', 'tmp', 'config', 'csi-databases')
      OR NEW.data_url !~ ('^' || owning_company_data_key || '/[a-f0-9]{20}$')
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'Invalid project storage root',
        CONSTRAINT = 'project_storage_root_guard';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.is_demo THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'Demo projects are read-only',
        CONSTRAINT = 'demo_project_read_only';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.data_url IS DISTINCT FROM OLD.data_url OR NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Project storage root is immutable',
      CONSTRAINT = 'project_storage_root_guard';
  END IF;

  unchanged_payload :=
    (to_jsonb(NEW) - ARRAY['is_demo', 'updated_at', 'lifecycle_epoch']) =
    (to_jsonb(OLD) - ARRAY['is_demo', 'updated_at', 'lifecycle_epoch']);

  IF OLD.is_demo OR NEW.is_demo <> OLD.is_demo THEN
    IF NOT unchanged_payload OR NEW.lifecycle_epoch <> OLD.lifecycle_epoch + 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'Demo projects are read-only',
        CONSTRAINT = 'demo_project_read_only';
    END IF;
    RETURN NEW;
  END IF;

  -- Ordinary private metadata writes never own the lifecycle counter.
  IF NEW.lifecycle_epoch <> OLD.lifecycle_epoch THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Invalid project lifecycle transition',
      CONSTRAINT = 'project_lifecycle_epoch_guard';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- Deployment must inventory/repair legacy namespace collisions before validating this constraint.
-- The singleton outage runner rejects legacy invalid namespaces before this
-- migration, so validate the catalog invariant while writers remain quiescent.
ALTER TABLE companies ADD CONSTRAINT companies_data_key_storage_namespace_guard
CHECK (
  data_key ~ '^[a-z0-9-]+$'
  AND data_key NOT IN ('_bp-staging', '_bp-public', 'models', 'tmp', 'config', 'csi-databases')
);--> statement-breakpoint

CREATE TRIGGER projects_lifecycle_guard
BEFORE INSERT OR UPDATE OR DELETE ON projects
FOR EACH ROW EXECUTE FUNCTION bp_guard_project_lifecycle();--> statement-breakpoint

CREATE TRIGGER pages_demo_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON pages
FOR EACH ROW EXECUTE FUNCTION bp_guard_direct_project_child('project_id');--> statement-breakpoint
CREATE TRIGGER annotations_demo_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON annotations
FOR EACH ROW EXECUTE FUNCTION bp_guard_direct_project_child('project_id');--> statement-breakpoint
CREATE TRIGGER annotation_groups_demo_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON annotation_groups
FOR EACH ROW EXECUTE FUNCTION bp_guard_direct_project_child('project_id');--> statement-breakpoint
CREATE TRIGGER takeoff_items_demo_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON takeoff_items
FOR EACH ROW EXECUTE FUNCTION bp_guard_direct_project_child('project_id');--> statement-breakpoint
CREATE TRIGGER takeoff_groups_demo_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON takeoff_groups
FOR EACH ROW EXECUTE FUNCTION bp_guard_direct_project_child('project_id');--> statement-breakpoint
CREATE TRIGGER qto_workflows_demo_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON qto_workflows
FOR EACH ROW EXECUTE FUNCTION bp_guard_direct_project_child('project_id');--> statement-breakpoint
CREATE TRIGGER labeling_sessions_demo_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON labeling_sessions
FOR EACH ROW EXECUTE FUNCTION bp_guard_direct_project_child('project_id');--> statement-breakpoint
CREATE TRIGGER chat_messages_demo_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON chat_messages
FOR EACH ROW EXECUTE FUNCTION bp_guard_direct_project_child('project_id');--> statement-breakpoint
CREATE TRIGGER processing_jobs_demo_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON processing_jobs
FOR EACH ROW EXECUTE FUNCTION bp_guard_direct_project_child('project_id');--> statement-breakpoint
CREATE TRIGGER project_mutation_leases_demo_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON project_mutation_leases
FOR EACH ROW EXECUTE FUNCTION bp_guard_direct_project_child('project_id');--> statement-breakpoint
CREATE TRIGGER annotation_group_members_demo_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON annotation_group_members
FOR EACH ROW EXECUTE FUNCTION bp_guard_annotation_group_member();
