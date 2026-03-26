-- Make task_type nullable for new generic sessions
ALTER TABLE labeling_sessions ALTER COLUMN task_type DROP NOT NULL;
ALTER TABLE labeling_sessions ALTER COLUMN task_type SET DEFAULT 'generic';

-- Add tiling tracking
ALTER TABLE labeling_sessions ADD COLUMN tiling_enabled boolean DEFAULT false;
ALTER TABLE labeling_sessions ADD COLUMN tile_grid integer;
