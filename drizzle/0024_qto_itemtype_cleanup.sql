-- SHIP 2 — Auto-QTO 5-type item taxonomy + dead field cleanup
--
-- Drops two columns that were never wired to any UI since table creation
-- in migration 0015: yolo_model_filter and tag_pattern. Confirmed via
-- grep: zero writers, all existing rows have NULL for both.
--
-- Adds item_type (with default backfill to keep pre-SHIP-2 rows working)
-- and tag_shape_class for the new Type 4 item picker.
ALTER TABLE qto_workflows DROP COLUMN IF EXISTS yolo_model_filter;
ALTER TABLE qto_workflows DROP COLUMN IF EXISTS tag_pattern;

ALTER TABLE qto_workflows
  ADD COLUMN item_type TEXT NOT NULL DEFAULT 'yolo-with-inner-text';

ALTER TABLE qto_workflows
  ADD COLUMN tag_shape_class TEXT;
