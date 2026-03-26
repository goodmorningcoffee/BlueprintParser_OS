-- Per-user permission to run model inference (costs $)
ALTER TABLE users ADD COLUMN can_run_models boolean DEFAULT false NOT NULL;

-- Admins get it by default (existing admin users)
UPDATE users SET can_run_models = true WHERE role = 'admin';
