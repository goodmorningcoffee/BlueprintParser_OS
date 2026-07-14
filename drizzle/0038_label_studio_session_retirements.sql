ALTER TABLE "labeling_sessions" ADD COLUMN "retirement_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "labeling_sessions" ADD COLUMN "retirement_consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "labeling_sessions" ADD COLUMN "retirement_next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "labeling_sessions" ADD COLUMN "retirement_lease_token" uuid;--> statement-breakpoint
ALTER TABLE "labeling_sessions" ADD COLUMN "retirement_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "labeling_sessions" ADD COLUMN "retirement_last_error" text;--> statement-breakpoint
CREATE INDEX "idx_labeling_sessions_retirement_due" ON "labeling_sessions" USING btree ("status","retirement_next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_labeling_sessions_retirement_lease" ON "labeling_sessions" USING btree ("retirement_lease_expires_at");--> statement-breakpoint

ALTER TABLE labeling_sessions
  ADD CONSTRAINT labeling_sessions_retirement_counter_check
  CHECK (
    retirement_attempt_count >= 0
    AND retirement_consecutive_failures >= 0
  );--> statement-breakpoint

ALTER TABLE labeling_sessions
  ADD CONSTRAINT labeling_sessions_retirement_lease_check
  CHECK (
    (retirement_lease_token IS NULL) = (retirement_lease_expires_at IS NULL)
  );--> statement-breakpoint

ALTER TABLE labeling_sessions
  ADD CONSTRAINT labeling_sessions_active_retirement_shape_check
  CHECK (
    status = 'retiring'
    OR (
      retirement_lease_token IS NULL
      AND retirement_lease_expires_at IS NULL
      AND retirement_attempt_count = 0
      AND retirement_consecutive_failures = 0
      AND retirement_last_error IS NULL
    )
  );--> statement-breakpoint

CREATE OR REPLACE FUNCTION bp_guard_labeling_session_retirement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'retiring'
       OR OLD.retirement_lease_token IS NULL
       OR OLD.retirement_lease_expires_at IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'Only leased retiring Label Studio sessions may be deleted',
        CONSTRAINT = 'labeling_session_retirement_guard';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.label_studio_project_id IS DISTINCT FROM OLD.label_studio_project_id
     OR NEW.provider_base_url IS DISTINCT FROM OLD.provider_base_url
     OR NEW.provider_instance_id IS DISTINCT FROM OLD.provider_instance_id
     OR NEW.label_studio_url IS DISTINCT FROM OLD.label_studio_url
     OR NEW.task_type IS DISTINCT FROM OLD.task_type
     OR NEW.labels IS DISTINCT FROM OLD.labels
     OR NEW.page_range IS DISTINCT FROM OLD.page_range
     OR NEW.tiling_enabled IS DISTINCT FROM OLD.tiling_enabled
     OR NEW.tile_grid IS DISTINCT FROM OLD.tile_grid
     OR NEW.provisioning_intent_id IS DISTINCT FROM OLD.provisioning_intent_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Label Studio session authority is immutable',
      CONSTRAINT = 'labeling_session_retirement_guard';
  END IF;

  IF OLD.status = 'active' AND NEW.status = 'retiring' THEN
    IF NEW.retirement_lease_token IS NOT NULL
       OR NEW.retirement_lease_expires_at IS NOT NULL
       OR NEW.retirement_attempt_count <> 0
       OR NEW.retirement_consecutive_failures <> 0
       OR NEW.retirement_last_error IS NOT NULL
       OR NEW.retirement_next_attempt_at > CURRENT_TIMESTAMP
       OR NEW.updated_at IS DISTINCT FROM CURRENT_TIMESTAMP THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'Invalid Label Studio session retirement',
        CONSTRAINT = 'labeling_session_retirement_guard';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'retiring' AND NEW.status = 'retiring' THEN
    -- The only acquisition transition is an exact claim (or an expired-lease reclaim).
    -- The due-time predicate is a database backstop, not merely a worker query convention.
    IF OLD.retirement_next_attempt_at <= CURRENT_TIMESTAMP
       AND (
         (
           OLD.retirement_lease_token IS NULL
           AND OLD.retirement_lease_expires_at IS NULL
         )
         OR (
           OLD.retirement_lease_token IS NOT NULL
           AND OLD.retirement_lease_expires_at < CURRENT_TIMESTAMP
         )
       )
       AND NEW.retirement_lease_token IS NOT NULL
       AND NEW.retirement_lease_token IS DISTINCT FROM OLD.retirement_lease_token
       AND NEW.retirement_lease_expires_at > CURRENT_TIMESTAMP
       AND NEW.retirement_attempt_count = OLD.retirement_attempt_count + 1
       AND NEW.retirement_consecutive_failures = OLD.retirement_consecutive_failures
       AND NEW.retirement_next_attempt_at IS NOT DISTINCT FROM OLD.retirement_next_attempt_at
       AND NEW.retirement_last_error IS NOT DISTINCT FROM OLD.retirement_last_error
       AND NEW.updated_at IS NOT DISTINCT FROM CURRENT_TIMESTAMP THEN
      RETURN NEW;
    END IF;

    -- A failed provider attempt releases exactly the lease it observed and moves only the
    -- failure/backoff witness. An expired worker may still persist its failure if it retains the
    -- row lock and token; the application's token-qualified UPDATE prevents a replacement claim.
    IF OLD.retirement_lease_token IS NOT NULL
       AND OLD.retirement_lease_expires_at IS NOT NULL
       AND OLD.retirement_attempt_count > 0
       AND OLD.retirement_next_attempt_at <= CURRENT_TIMESTAMP
       AND NEW.retirement_lease_token IS NULL
       AND NEW.retirement_lease_expires_at IS NULL
       AND NEW.retirement_attempt_count = OLD.retirement_attempt_count
       AND NEW.retirement_consecutive_failures = OLD.retirement_consecutive_failures + 1
       AND NEW.retirement_next_attempt_at > CURRENT_TIMESTAMP
       AND BTRIM(COALESCE(NEW.retirement_last_error, '')) <> ''
       AND NEW.updated_at IS NOT DISTINCT FROM CURRENT_TIMESTAMP THEN
      RETURN NEW;
    END IF;

    -- An authenticated retry may make an unleased durable witness due now. It cannot delay the
    -- queue, rewrite counters/errors, or interfere with a live/expired worker fence.
    IF OLD.retirement_lease_token IS NULL
       AND OLD.retirement_lease_expires_at IS NULL
       AND NEW.retirement_lease_token IS NULL
       AND NEW.retirement_lease_expires_at IS NULL
       AND NEW.retirement_attempt_count = OLD.retirement_attempt_count
       AND NEW.retirement_consecutive_failures = OLD.retirement_consecutive_failures
       AND NEW.retirement_next_attempt_at IS NOT DISTINCT FROM CURRENT_TIMESTAMP
       AND NEW.retirement_last_error IS NOT DISTINCT FROM OLD.retirement_last_error
       AND NEW.updated_at IS NOT DISTINCT FROM CURRENT_TIMESTAMP THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Invalid Label Studio session retirement mutation',
      CONSTRAINT = 'labeling_session_retirement_guard';
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = 'Invalid Label Studio session retirement transition',
    CONSTRAINT = 'labeling_session_retirement_guard';
END;
$$;--> statement-breakpoint

CREATE TRIGGER labeling_sessions_retirement_guard
BEFORE UPDATE OR DELETE ON labeling_sessions
FOR EACH ROW EXECUTE FUNCTION bp_guard_labeling_session_retirement();
