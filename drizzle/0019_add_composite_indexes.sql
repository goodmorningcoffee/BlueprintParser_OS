-- Composite indexes for efficient chunk queries (page range within a project).
-- The chunk loader fetches 15-page windows: WHERE project_id = ? AND page_number BETWEEN ? AND ?
-- Without these, the DB scans all rows for the project then filters in memory.
CREATE INDEX IF NOT EXISTS idx_pages_project_page ON pages (project_id, page_number);
CREATE INDEX IF NOT EXISTS idx_annotations_project_page ON annotations (project_id, page_number);
