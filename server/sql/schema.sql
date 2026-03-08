CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  site_role TEXT NOT NULL DEFAULT 'USER',
  password_hash TEXT NOT NULL DEFAULT '',
  google_subject TEXT UNIQUE,
  apple_subject TEXT UNIQUE,
  last_login_at TIMESTAMPTZ,
  last_active_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspaces (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id BIGINT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS lists (
  id BIGSERIAL PRIMARY KEY,
  workspace_id BIGINT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'task',
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tasks (
  id BIGSERIAL PRIMARY KEY,
  workspace_id BIGINT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  list_id BIGINT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  quantity TEXT NOT NULL DEFAULT '',
  due_date DATE,
  priority TEXT NOT NULL DEFAULT 'medium',
  completed_at TIMESTAMPTZ,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  completed_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspace_invites (
  id BIGSERIAL PRIMARY KEY,
  workspace_id BIGINT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  token TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  invited_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  accepted_at TIMESTAMPTZ,
  accepted_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT,
  workspace_id BIGINT REFERENCES workspaces(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS system_error_logs (
  id BIGSERIAL PRIMARY KEY,
  level TEXT NOT NULL DEFAULT 'error',
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  stack TEXT NOT NULL DEFAULT '',
  status_code INTEGER,
  request_method TEXT NOT NULL DEFAULT '',
  request_path TEXT NOT NULL DEFAULT '',
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

UPDATE users
SET site_role = 'USER'
WHERE site_role IS NULL
   OR BTRIM(site_role) = '';

UPDATE users
SET site_role = UPPER(site_role)
WHERE site_role <> UPPER(site_role);

UPDATE users
SET site_role = 'USER'
WHERE site_role NOT IN ('USER', 'SUPER_ADMIN');

UPDATE workspace_invites
SET email = LOWER(email)
WHERE email <> LOWER(email);

ALTER TABLE workspace_invites ADD COLUMN IF NOT EXISTS token TEXT;

DELETE FROM workspace_invites
WHERE accepted_at IS NULL
  AND expires_at <= NOW();

DELETE FROM workspace_invites wi
USING (
  SELECT id
  FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY workspace_id, email
             ORDER BY created_at DESC, id DESC
           ) AS row_num
    FROM workspace_invites
    WHERE accepted_at IS NULL
  ) ranked
  WHERE row_num > 1
) duplicates
WHERE wi.id = duplicates.id;

DELETE FROM password_reset_tokens
WHERE used_at IS NOT NULL
   OR expires_at <= NOW();

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_subject
ON users(google_subject)
WHERE google_subject IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_apple_subject
ON users(apple_subject)
WHERE apple_subject IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_invites_token
ON workspace_invites(token)
WHERE token IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_invites_one_pending_email
ON workspace_invites(workspace_id, email)
WHERE accepted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_users_site_role
ON users(site_role);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id
ON password_reset_tokens(user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_password_reset_tokens_token_hash
ON password_reset_tokens(token_hash);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
ON audit_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_user_id
ON audit_logs(actor_user_id);

CREATE INDEX IF NOT EXISTS idx_audit_logs_workspace_id
ON audit_logs(workspace_id);

CREATE INDEX IF NOT EXISTS idx_system_error_logs_created_at
ON system_error_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_system_error_logs_source
ON system_error_logs(source);

CREATE INDEX IF NOT EXISTS idx_system_error_logs_user_id
ON system_error_logs(user_id);
