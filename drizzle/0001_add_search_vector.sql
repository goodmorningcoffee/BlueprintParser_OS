-- Phase 2: Add full-text search support to pages table
-- Drizzle ORM does not support tsvector columns, so this migration is managed via raw SQL.

ALTER TABLE pages ADD COLUMN IF NOT EXISTS search_vector tsvector;
CREATE INDEX IF NOT EXISTS idx_pages_search ON pages USING GIN (search_vector);
