-- Add is_demo flag to projects for public demo mode
ALTER TABLE projects ADD COLUMN IF NOT EXISTS is_demo boolean DEFAULT false NOT NULL;
