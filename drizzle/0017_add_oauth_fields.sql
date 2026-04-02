-- Add OAuth provider fields to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS oauth_provider VARCHAR(50);
ALTER TABLE users ADD COLUMN IF NOT EXISTS oauth_provider_id VARCHAR(255);
-- Allow NULL passwordHash for OAuth-only users
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
