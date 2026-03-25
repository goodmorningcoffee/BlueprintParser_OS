-- Label Studio integration: tracking table for labeling sessions
CREATE TABLE IF NOT EXISTS labeling_sessions (
  id serial PRIMARY KEY,
  project_id integer NOT NULL REFERENCES projects(id),
  company_id integer NOT NULL REFERENCES companies(id),
  label_studio_project_id integer NOT NULL,
  label_studio_url varchar(500),
  task_type varchar(50) NOT NULL,
  labels jsonb,
  page_range varchar(100),
  status varchar(50) NOT NULL DEFAULT 'active',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_labeling_sessions_project ON labeling_sessions(project_id);
