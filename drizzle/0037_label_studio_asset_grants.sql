-- Existing Label Studio task URLs contain expiring AWS presigns and BP never retained enough
-- provider task identity to rewrite them safely. Refuse a misleading partial upgrade: operators
-- must retire/recreate those sessions (and reconcile pending creates) before this protocol lands.
-- DEPLOYMENT PREREQUISITE: stop every old application/worker writer, retire provider projects
-- before deleting their local witnesses, and run this migration from one singleton process. The
-- table lock makes the emptiness decision stable inside this transaction; the NOT NULL column and
-- exact INSERT trigger below reject any old binary that resumes afterward without the new witness.
LOCK TABLE labeling_sessions, label_studio_project_intents
IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM labeling_sessions LIMIT 1)
     OR EXISTS (SELECT 1 FROM label_studio_project_intents LIMIT 1) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Label Studio sessions/intents must be retired before migration 0037',
      HINT = 'Delete or reconcile every Label Studio session and provisioning intent, then retry.';
  END IF;
END;
$$;--> statement-breakpoint

-- 0037's zero-row preflight is the compatibility boundary. Every session created from this point
-- onward must retain the UUID of the exact provisioning intent that produced its provider project.
ALTER TABLE label_studio_project_intents
  ADD COLUMN provider_base_url text NOT NULL;--> statement-breakpoint
ALTER TABLE label_studio_project_intents
  ADD COLUMN provider_instance_id text NOT NULL;--> statement-breakpoint
ALTER TABLE labeling_sessions
  ADD COLUMN provider_base_url text NOT NULL;--> statement-breakpoint
ALTER TABLE labeling_sessions
  ADD COLUMN provider_instance_id text NOT NULL;--> statement-breakpoint
ALTER TABLE labeling_sessions
  ALTER COLUMN provisioning_intent_id SET NOT NULL;--> statement-breakpoint

ALTER TABLE label_studio_project_intents
  ADD CONSTRAINT label_studio_project_intents_provider_binding_check
  CHECK (
    provider_base_url = btrim(provider_base_url)
    AND length(provider_base_url) > 0
    AND provider_instance_id = btrim(provider_instance_id)
    AND length(provider_instance_id) > 0
  );--> statement-breakpoint
ALTER TABLE labeling_sessions
  ADD CONSTRAINT labeling_sessions_provider_binding_check
  CHECK (
    provider_base_url = btrim(provider_base_url)
    AND length(provider_base_url) > 0
    AND provider_instance_id = btrim(provider_instance_id)
    AND length(provider_instance_id) > 0
  );--> statement-breakpoint

CREATE UNIQUE INDEX uq_ls_intents_provider_project
  ON label_studio_project_intents (
    provider_base_url,
    provider_instance_id,
    provider_project_id
  )
  WHERE provider_project_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX uq_labeling_sessions_provider_project
  ON labeling_sessions (
    provider_base_url,
    provider_instance_id,
    label_studio_project_id
  );--> statement-breakpoint

ALTER TABLE label_studio_project_intents
  DROP CONSTRAINT label_studio_project_intents_marker_check;--> statement-breakpoint
ALTER TABLE label_studio_project_intents
  ADD CONSTRAINT label_studio_project_intents_marker_check
  CHECK (marker = 'bp-labeling-intent:' || id::text);--> statement-breakpoint

ALTER TABLE label_studio_project_intents
  DROP CONSTRAINT label_studio_project_intents_provider_check;--> statement-breakpoint
ALTER TABLE label_studio_project_intents
  ADD CONSTRAINT label_studio_project_intents_provider_check
  CHECK (
    (state IN ('creating', 'create_uncertain') AND provider_project_id IS NULL)
    OR (state = 'cleanup_pending' AND provider_project_id > 0)
  );--> statement-breakpoint

CREATE TABLE "label_studio_asset_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" integer NOT NULL,
	"company_id" integer NOT NULL,
	"lifecycle_epoch" bigint NOT NULL,
	"provisioning_intent_id" uuid,
	"labeling_session_id" integer,
	"token_hash" varchar(64) NOT NULL,
	"snapshot_version_id" text NOT NULL,
	"state" varchar(20) DEFAULT 'provisioning' NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "label_studio_asset_grants_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "label_studio_asset_grants" ADD CONSTRAINT "label_studio_asset_grants_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label_studio_asset_grants" ADD CONSTRAINT "label_studio_asset_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label_studio_asset_grants" ADD CONSTRAINT "label_studio_asset_grants_provisioning_intent_id_label_studio_project_intents_id_fk" FOREIGN KEY ("provisioning_intent_id") REFERENCES "public"."label_studio_project_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label_studio_asset_grants" ADD CONSTRAINT "label_studio_asset_grants_labeling_session_id_labeling_sessions_id_fk" FOREIGN KEY ("labeling_session_id") REFERENCES "public"."labeling_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_label_studio_asset_grants_project" ON "label_studio_asset_grants" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_label_studio_asset_grants_intent" ON "label_studio_asset_grants" USING btree ("provisioning_intent_id");--> statement-breakpoint
CREATE INDEX "idx_label_studio_asset_grants_session" ON "label_studio_asset_grants" USING btree ("labeling_session_id");--> statement-breakpoint

ALTER TABLE labeling_sessions
  ADD CONSTRAINT labeling_sessions_status_check
  CHECK (status IN ('active', 'retiring'));--> statement-breakpoint

ALTER TABLE label_studio_asset_grants
  ADD CONSTRAINT label_studio_asset_grants_shape_check
  CHECK (
    lifecycle_epoch >= 0
    AND token_hash ~ '^[a-f0-9]{64}$'
    AND length(btrim(snapshot_version_id)) > 0
    AND ((provisioning_intent_id IS NULL) <> (labeling_session_id IS NULL))
    AND state IN ('provisioning', 'active', 'revoked')
    AND (
      (
        state = 'provisioning'
        AND provisioning_intent_id IS NOT NULL
        AND labeling_session_id IS NULL
        AND revoked_at IS NULL
      )
      OR (
        state = 'active'
        AND provisioning_intent_id IS NULL
        AND labeling_session_id IS NOT NULL
        AND revoked_at IS NULL
      )
      OR (state = 'revoked' AND revoked_at IS NOT NULL)
    )
  );--> statement-breakpoint

-- Publishing acquires the project row before this trigger runs. Every Label Studio child write
-- takes that same row FOR SHARE, so the publication/witness race is serialized in either order:
-- an existing witness blocks publication, and a committed publication rejects the later child.
CREATE OR REPLACE FUNCTION bp_guard_project_label_studio_publication()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT OLD.is_demo AND NEW.is_demo
     AND (
       EXISTS (
         SELECT 1 FROM labeling_sessions WHERE project_id = OLD.id LIMIT 1
       )
       OR EXISTS (
         SELECT 1
           FROM label_studio_project_intents
          WHERE project_id = OLD.id
          LIMIT 1
       )
       OR EXISTS (
         SELECT 1 FROM label_studio_asset_grants WHERE project_id = OLD.id LIMIT 1
       )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Label Studio provider state must be retired before publication',
      CONSTRAINT = 'label_studio_publication_guard';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER projects_label_studio_publication_guard
BEFORE UPDATE ON projects
FOR EACH ROW EXECUTE FUNCTION bp_guard_project_label_studio_publication();--> statement-breakpoint

CREATE OR REPLACE FUNCTION bp_guard_label_studio_intent_authority()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_company_id integer;
  current_lifecycle_epoch bigint;
  current_is_demo boolean;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (
       NEW.id IS DISTINCT FROM OLD.id
       OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.company_id IS DISTINCT FROM OLD.company_id
       OR NEW.lifecycle_epoch IS DISTINCT FROM OLD.lifecycle_epoch
       OR NEW.marker IS DISTINCT FROM OLD.marker
       OR NEW.provider_base_url IS DISTINCT FROM OLD.provider_base_url
       OR NEW.provider_instance_id IS DISTINCT FROM OLD.provider_instance_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Label Studio provider intent authority is immutable',
      CONSTRAINT = 'label_studio_intent_authority_guard';
  END IF;

  -- Take the repository-wide parent lock before consulting the child authority. FOR SHARE, rather
  -- than KEY SHARE, serializes lifecycle/demo changes to non-key project columns.
  SELECT company_id, lifecycle_epoch, is_demo
    INTO current_company_id, current_lifecycle_epoch, current_is_demo
    FROM projects
   WHERE id = NEW.project_id
   FOR SHARE;
  IF NOT FOUND
     OR current_is_demo
     OR current_company_id IS DISTINCT FROM NEW.company_id
     OR current_lifecycle_epoch IS DISTINCT FROM NEW.lifecycle_epoch THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Label Studio provider intent project authority mismatch',
      CONSTRAINT = 'label_studio_intent_authority_guard';
  END IF;

  IF NEW.marker IS DISTINCT FROM 'bp-labeling-intent:' || NEW.id::text THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Label Studio provider intent marker mismatch',
      CONSTRAINT = 'label_studio_intent_authority_guard';
  END IF;

  IF (NEW.state IN ('creating', 'create_uncertain') AND NEW.provider_project_id IS NOT NULL)
     OR (NEW.state = 'cleanup_pending'
         AND (NEW.provider_project_id IS NULL OR NEW.provider_project_id <= 0)) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Invalid Label Studio provider intent state',
      CONSTRAINT = 'label_studio_intent_transition_guard';
  END IF;

  -- The two durable owner tables cannot express cross-table uniqueness with an index. Serialize
  -- every learned provider identity on one transaction-scoped key, then reject an intent that
  -- aliases any live session. hash collisions only add harmless serialization; the exact columns
  -- below decide authority. This also closes the session-finalize/next-intent race after the old
  -- intent row is deleted but before its replacement transaction can observe the committed session.
  IF NEW.provider_project_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(
        jsonb_build_array(
          NEW.provider_base_url,
          NEW.provider_instance_id,
          NEW.provider_project_id
        )::text,
        0
      )
    );
    IF EXISTS (
      SELECT 1
        FROM labeling_sessions
       WHERE provider_base_url = NEW.provider_base_url
         AND provider_instance_id = NEW.provider_instance_id
         AND label_studio_project_id = NEW.provider_project_id
       LIMIT 1
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'Label Studio provider identity is already owned by a session',
        CONSTRAINT = 'label_studio_provider_identity_collision_guard';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  -- The provider identity may be learned exactly once. Retries may write the same value, but no
  -- cleanup owner can ever be retargeted or forgotten after a provider ID is known.
  IF OLD.provider_project_id IS NOT NULL
     AND NEW.provider_project_id IS DISTINCT FROM OLD.provider_project_id THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Label Studio provider identity is immutable',
      CONSTRAINT = 'label_studio_intent_transition_guard';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state
     AND NOT (
       (OLD.state = 'creating'
        AND NEW.state IN ('create_uncertain', 'cleanup_pending'))
       OR (OLD.state = 'create_uncertain' AND NEW.state = 'cleanup_pending')
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Invalid Label Studio provider intent transition',
      CONSTRAINT = 'label_studio_intent_transition_guard';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER label_studio_project_intents_authority_guard
BEFORE INSERT OR UPDATE ON label_studio_project_intents
FOR EACH ROW EXECUTE FUNCTION bp_guard_label_studio_intent_authority();--> statement-breakpoint

CREATE OR REPLACE FUNCTION bp_guard_labeling_session_creation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_company_id integer;
  current_lifecycle_epoch bigint;
  current_is_demo boolean;
  owner_project_id integer;
  owner_company_id integer;
  owner_lifecycle_epoch bigint;
  owner_provider_project_id integer;
  owner_provider_base_url text;
  owner_provider_instance_id text;
  owner_state varchar(30);
BEGIN
  IF NEW.status <> 'active' OR NEW.provisioning_intent_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Invalid Label Studio session creation',
      CONSTRAINT = 'labeling_session_creation_guard';
  END IF;

  SELECT company_id, lifecycle_epoch, is_demo
    INTO current_company_id, current_lifecycle_epoch, current_is_demo
    FROM projects
   WHERE id = NEW.project_id
   FOR SHARE;
  IF NOT FOUND
     OR current_is_demo
     OR current_company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Label Studio session project authority mismatch',
      CONSTRAINT = 'labeling_session_creation_guard';
  END IF;

  SELECT project_id, company_id, lifecycle_epoch, provider_project_id,
         provider_base_url, provider_instance_id, state
    INTO owner_project_id, owner_company_id, owner_lifecycle_epoch,
         owner_provider_project_id, owner_provider_base_url,
         owner_provider_instance_id, owner_state
    FROM label_studio_project_intents
   WHERE id = NEW.provisioning_intent_id
   FOR KEY SHARE;
  IF NOT FOUND
     OR owner_project_id IS DISTINCT FROM NEW.project_id
     OR owner_company_id IS DISTINCT FROM NEW.company_id
     OR owner_lifecycle_epoch IS DISTINCT FROM current_lifecycle_epoch
     OR owner_provider_project_id IS DISTINCT FROM NEW.label_studio_project_id
     OR owner_provider_base_url IS DISTINCT FROM NEW.provider_base_url
     OR owner_provider_instance_id IS DISTINCT FROM NEW.provider_instance_id
     OR owner_state IS DISTINCT FROM 'cleanup_pending' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Label Studio session provisioning authority mismatch',
      CONSTRAINT = 'labeling_session_creation_guard';
  END IF;

  -- Use the same lock as intent assignment. The session may overlap only the exact provisioning
  -- intent it is atomically consuming; a different intent or session can never share this remote
  -- project identity, even across concurrent finalization/assignment transactions.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      jsonb_build_array(
        NEW.provider_base_url,
        NEW.provider_instance_id,
        NEW.label_studio_project_id
      )::text,
      0
    )
  );
  IF EXISTS (
    SELECT 1
      FROM label_studio_project_intents
     WHERE provider_base_url = NEW.provider_base_url
       AND provider_instance_id = NEW.provider_instance_id
       AND provider_project_id = NEW.label_studio_project_id
       AND id <> NEW.provisioning_intent_id
     LIMIT 1
  ) OR EXISTS (
    SELECT 1
      FROM labeling_sessions
     WHERE provider_base_url = NEW.provider_base_url
       AND provider_instance_id = NEW.provider_instance_id
       AND label_studio_project_id = NEW.label_studio_project_id
     LIMIT 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Label Studio provider identity has another durable owner',
      CONSTRAINT = 'label_studio_provider_identity_collision_guard';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER labeling_sessions_creation_guard
BEFORE INSERT ON labeling_sessions
FOR EACH ROW EXECUTE FUNCTION bp_guard_labeling_session_creation();--> statement-breakpoint

CREATE OR REPLACE FUNCTION bp_guard_label_studio_asset_grant_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_company_id integer;
  current_lifecycle_epoch bigint;
  owner_project_id integer;
  owner_company_id integer;
  owner_lifecycle_epoch bigint;
BEGIN
  SELECT company_id, lifecycle_epoch
    INTO current_company_id, current_lifecycle_epoch
    FROM projects
   WHERE id = NEW.project_id
   FOR SHARE;
  IF NOT FOUND
     OR current_company_id IS DISTINCT FROM NEW.company_id
     OR current_lifecycle_epoch IS DISTINCT FROM NEW.lifecycle_epoch THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Label Studio asset grant project authority mismatch',
      CONSTRAINT = 'label_studio_asset_grant_owner_guard';
  END IF;

  IF NEW.provisioning_intent_id IS NOT NULL THEN
    SELECT project_id, company_id, lifecycle_epoch
      INTO owner_project_id, owner_company_id, owner_lifecycle_epoch
      FROM label_studio_project_intents
     WHERE id = NEW.provisioning_intent_id
     FOR KEY SHARE;
    IF NOT FOUND
       OR owner_project_id IS DISTINCT FROM NEW.project_id
       OR owner_company_id IS DISTINCT FROM NEW.company_id
       OR owner_lifecycle_epoch IS DISTINCT FROM NEW.lifecycle_epoch THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'Label Studio asset grant intent authority mismatch',
        CONSTRAINT = 'label_studio_asset_grant_owner_guard';
    END IF;
  ELSIF NEW.labeling_session_id IS NOT NULL THEN
    SELECT project_id, company_id
      INTO owner_project_id, owner_company_id
      FROM labeling_sessions
     WHERE id = NEW.labeling_session_id
     FOR KEY SHARE;
    IF NOT FOUND
       OR owner_project_id IS DISTINCT FROM NEW.project_id
       OR owner_company_id IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'Label Studio asset grant session authority mismatch',
        CONSTRAINT = 'label_studio_asset_grant_owner_guard';
    END IF;
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Label Studio asset grant owner is required',
      CONSTRAINT = 'label_studio_asset_grant_owner_guard';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER label_studio_asset_grants_owner_guard
BEFORE INSERT OR UPDATE ON label_studio_asset_grants
FOR EACH ROW EXECUTE FUNCTION bp_guard_label_studio_asset_grant_owner();--> statement-breakpoint

CREATE OR REPLACE FUNCTION bp_guard_label_studio_asset_grant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  activation_is_exact boolean;
  revocation_is_fenced boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state <> 'revoked' THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'Only revoked Label Studio asset grants may be deleted',
        CONSTRAINT = 'label_studio_asset_grant_transition_guard';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'provisioning'
       OR NEW.provisioning_intent_id IS NULL
       OR NEW.labeling_session_id IS NOT NULL
       OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'Invalid Label Studio asset grant creation',
        CONSTRAINT = 'label_studio_asset_grant_transition_guard';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.lifecycle_epoch IS DISTINCT FROM OLD.lifecycle_epoch
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.snapshot_version_id IS DISTINCT FROM OLD.snapshot_version_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Label Studio asset grant authority is immutable',
      CONSTRAINT = 'label_studio_asset_grant_transition_guard';
  END IF;

  IF OLD.state = 'provisioning' AND NEW.state = 'active' THEN
    IF OLD.provisioning_intent_id IS NULL
       OR NEW.provisioning_intent_id IS NOT NULL
       OR NEW.labeling_session_id IS NULL
       OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'Invalid Label Studio asset grant activation',
        CONSTRAINT = 'label_studio_asset_grant_transition_guard';
    END IF;

    SELECT TRUE
      INTO activation_is_exact
      FROM label_studio_project_intents AS provisioning_intent
      JOIN labeling_sessions AS activation_session
        ON activation_session.id = NEW.labeling_session_id
     WHERE provisioning_intent.id = OLD.provisioning_intent_id
       AND provisioning_intent.project_id = OLD.project_id
       AND provisioning_intent.company_id = OLD.company_id
       AND provisioning_intent.lifecycle_epoch = OLD.lifecycle_epoch
       AND provisioning_intent.state = 'cleanup_pending'
       AND provisioning_intent.provider_project_id IS NOT NULL
       AND activation_session.project_id = OLD.project_id
       AND activation_session.company_id = OLD.company_id
       AND activation_session.status = 'active'
       AND activation_session.provisioning_intent_id = provisioning_intent.id
       AND activation_session.label_studio_project_id = provisioning_intent.provider_project_id
       AND activation_session.provider_base_url = provisioning_intent.provider_base_url
       AND activation_session.provider_instance_id = provisioning_intent.provider_instance_id
     FOR SHARE OF provisioning_intent, activation_session;
    IF activation_is_exact IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'Label Studio asset grant activation authority mismatch',
        CONSTRAINT = 'label_studio_asset_grant_transition_guard';
    END IF;
  ELSIF OLD.state = 'provisioning' AND NEW.state = 'revoked' THEN
    IF NEW.provisioning_intent_id IS DISTINCT FROM OLD.provisioning_intent_id
       OR NEW.labeling_session_id IS NOT NULL
       OR NEW.revoked_at IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'Invalid Label Studio provisioning grant revocation',
        CONSTRAINT = 'label_studio_asset_grant_transition_guard';
    END IF;
  ELSIF OLD.state = 'active' AND NEW.state = 'revoked' THEN
    IF NEW.provisioning_intent_id IS NOT NULL
       OR NEW.labeling_session_id IS DISTINCT FROM OLD.labeling_session_id
       OR NEW.revoked_at IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'Invalid Label Studio active grant revocation',
        CONSTRAINT = 'label_studio_asset_grant_transition_guard';
    END IF;

    SELECT TRUE
      INTO revocation_is_fenced
      FROM labeling_sessions AS retiring_session
     WHERE retiring_session.id = OLD.labeling_session_id
       AND retiring_session.project_id = OLD.project_id
       AND retiring_session.company_id = OLD.company_id
       AND retiring_session.status = 'retiring'
     FOR SHARE;
    IF revocation_is_fenced IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'Label Studio asset grant revocation requires retirement',
        CONSTRAINT = 'label_studio_asset_grant_transition_guard';
    END IF;
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Invalid Label Studio asset grant transition',
      CONSTRAINT = 'label_studio_asset_grant_transition_guard';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER label_studio_asset_grants_transition_guard
BEFORE INSERT OR UPDATE OR DELETE ON label_studio_asset_grants
FOR EACH ROW EXECUTE FUNCTION bp_guard_label_studio_asset_grant();--> statement-breakpoint

CREATE TRIGGER label_studio_asset_grants_demo_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON label_studio_asset_grants
FOR EACH ROW EXECUTE FUNCTION bp_guard_direct_project_child('project_id');
