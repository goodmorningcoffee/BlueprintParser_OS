-- Add size and notes columns to takeoff_items
ALTER TABLE takeoff_items ADD COLUMN IF NOT EXISTS size integer NOT NULL DEFAULT 10;
ALTER TABLE takeoff_items ADD COLUMN IF NOT EXISTS notes text;
