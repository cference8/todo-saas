import 'dotenv/config';
import crypto from 'node:crypto';
import { Pool } from 'pg';
import { hashPassword, verifyPassword } from './auth.js';

const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/todo_saas';
const pool = new Pool({ connectionString });
const INVITE_TTL_DAYS = 7;
const PASSWORD_RESET_TTL_HOURS = 2;
const LIST_TYPES = new Set(['task', 'grocery']);
const SITE_ROLES = new Set(['USER', 'SUPER_ADMIN']);

function fmt(value) {
  return value ? new Date(value).toLocaleDateString() : null;
}

function normalizeDateOnly(value) {
  if (!value) return null;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, 10) : null;
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  return null;
}

function fmtDateOnly(value) {
  const normalized = normalizeDateOnly(value);
  return normalized ? new Date(`${normalized}T00:00:00`).toLocaleDateString() : null;
}

function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'workspace';
}

function defaultWorkspaceNameFor(name) {
  const firstName = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)[0];

  if (!firstName) {
    return 'My Workspace';
  }

  return `${firstName}'s Workspace`;
}

function normalizeSiteRole(value) {
  const normalized = String(value || '')
    .trim()
    .toUpperCase();

  return SITE_ROLES.has(normalized) ? normalized : 'USER';
}

function isSuperAdminSiteRole(siteRole) {
  return normalizeSiteRole(siteRole) === 'SUPER_ADMIN';
}

function getDefaultWorkspaceId(workspaces = []) {
  return workspaces[0]?.id ?? null;
}

async function getSessionWorkspacesForSiteRole(userId, siteRole) {
  return isSuperAdminSiteRole(siteRole) ? [] : getUserWorkspaces(userId);
}

async function createWorkspaceForUser(client, { userId, workspaceName }) {
  const workspaceSlug = `${slugify(workspaceName)}-${String(userId)}-${crypto.randomBytes(4).toString('hex')}`;
  const workspaceResult = await client.query(
    `INSERT INTO workspaces (name, slug, created_by_user_id)
     VALUES ($1, $2, $3)
     RETURNING id, name, slug, created_at AS "createdAt"`,
    [workspaceName.trim(), workspaceSlug, userId]
  );
  const workspace = workspaceResult.rows[0];

  await client.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [workspace.id, userId]
  );

  await client.query(
    `INSERT INTO lists (workspace_id, name, created_by_user_id)
     VALUES ($1, 'General', $2), ($1, 'Product Ideas', $2)`,
    [workspace.id, userId]
  );

  return workspace;
}

async function getCurrentUserProfile(userId, db = pool) {
  const result = await db.query(
    `SELECT id,
            name,
            email,
            site_role AS "siteRole",
            created_at AS "createdAt",
            last_login_at AS "lastLoginAt",
            last_active_at AS "lastActiveAt",
            (password_hash <> '') AS "hasPassword",
            (google_subject IS NOT NULL) AS "hasGoogle",
            (apple_subject IS NOT NULL) AS "hasApple"
     FROM users
     WHERE id = $1`,
    [userId]
  );

  return result.rows[0] || null;
}

export async function initDb() {
  await pool.query(`
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

    CREATE INDEX IF NOT EXISTS idx_lists_workspace_id ON lists(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_workspace_id ON tasks(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_list_id ON tasks(list_id);
    CREATE INDEX IF NOT EXISTS idx_workspace_members_user_id ON workspace_members(user_id);
  `);

  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS site_role TEXT NOT NULL DEFAULT 'USER';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS google_subject TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_subject TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;
    ALTER TABLE users ALTER COLUMN password_hash SET DEFAULT '';
    ALTER TABLE lists ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'task';
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS quantity TEXT NOT NULL DEFAULT '';
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_date DATE;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'medium';
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
    UPDATE lists SET type = 'task' WHERE type IS NULL OR type NOT IN ('task', 'grocery');
    UPDATE tasks SET priority = 'medium' WHERE priority IS NULL OR priority NOT IN ('low', 'medium', 'high');
  `);

  await pool.query(`
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

    CREATE INDEX IF NOT EXISTS idx_workspace_invites_workspace_id ON workspace_invites(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_workspace_invites_email ON workspace_invites(email);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_invites_token ON workspace_invites(token) WHERE token IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_invites_one_pending_email
    ON workspace_invites(workspace_id, email)
    WHERE accepted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_users_site_role ON users(site_role);
    CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_password_reset_tokens_token_hash ON password_reset_tokens(token_hash);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_subject ON users(google_subject) WHERE google_subject IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_apple_subject ON users(apple_subject) WHERE apple_subject IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_user_id ON audit_logs(actor_user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_workspace_id ON audit_logs(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_system_error_logs_created_at ON system_error_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_system_error_logs_source ON system_error_logs(source);
    CREATE INDEX IF NOT EXISTS idx_system_error_logs_user_id ON system_error_logs(user_id);
  `);
}

export async function getAuthContext(userId) {
  const result = await pool.query(
    `WITH touched AS (
       UPDATE users
       SET last_active_at = NOW()
       WHERE id = $1
         AND (
           last_active_at IS NULL
           OR last_active_at < NOW() - INTERVAL '15 minutes'
         )
       RETURNING id
     )
     SELECT id,
            email,
            site_role AS "siteRole"
     FROM users
     WHERE id = $1`,
    [userId]
  );

  return result.rows[0] || null;
}

export async function markUserLogin(userId, db = pool) {
  await db.query(
    `UPDATE users
     SET last_login_at = NOW(),
         last_active_at = NOW()
     WHERE id = $1`,
    [userId]
  );
}

export async function recordAuditLog({
  actorUserId = null,
  eventType,
  targetType = '',
  targetId = null,
  workspaceId = null,
  metadata = {}
}) {
  if (!eventType) return;

  await pool.query(
    `INSERT INTO audit_logs (actor_user_id, event_type, target_type, target_id, workspace_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      actorUserId || null,
      String(eventType),
      String(targetType || ''),
      targetId === null || targetId === undefined ? null : String(targetId),
      workspaceId || null,
      JSON.stringify(metadata || {})
    ]
  );
}

export async function recordSystemErrorLog({
  level = 'error',
  source = 'server',
  message,
  stack = '',
  statusCode = null,
  requestMethod = '',
  requestPath = '',
  userId = null,
  metadata = {}
}) {
  if (!message) return;

  await pool.query(
    `INSERT INTO system_error_logs (
       level,
       source,
       message,
       stack,
       status_code,
       request_method,
       request_path,
       user_id,
       metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      String(level || 'error'),
      String(source || 'server'),
      String(message),
      String(stack || ''),
      statusCode || null,
      String(requestMethod || ''),
      String(requestPath || ''),
      userId || null,
      JSON.stringify(metadata || {})
    ]
  );
}

export async function getAdminDashboardSnapshot() {
  const [
    overviewResult,
    providerMixResult,
    growthResult,
    usersResult,
    workspacesResult,
    activityResult,
    errorsResult
  ] = await Promise.all([
    pool.query(
      `SELECT
         (SELECT COUNT(*)::integer FROM users) AS "totalUsers",
         (SELECT COUNT(*)::integer FROM users WHERE site_role = 'SUPER_ADMIN') AS "totalSuperAdmins",
         (SELECT COUNT(*)::integer FROM workspaces) AS "totalWorkspaces",
         (SELECT COUNT(*)::integer FROM lists) AS "totalLists",
         (SELECT COUNT(*)::integer FROM tasks) AS "totalTasks",
         (SELECT COUNT(*)::integer FROM tasks WHERE completed_at IS NOT NULL) AS "completedTasks",
         (SELECT COUNT(*)::integer FROM tasks WHERE completed_at IS NULL) AS "openTasks",
         (SELECT COUNT(*)::integer
          FROM workspace_invites
          WHERE accepted_at IS NULL
            AND expires_at > NOW()) AS "pendingInvites",
         (SELECT COUNT(*)::integer FROM users WHERE created_at >= NOW() - INTERVAL '7 days') AS "newUsers7d",
         (SELECT COUNT(*)::integer FROM workspaces WHERE created_at >= NOW() - INTERVAL '7 days') AS "newWorkspaces7d",
         (SELECT COUNT(*)::integer FROM users WHERE last_login_at >= NOW() - INTERVAL '7 days') AS "logins7d",
         (SELECT COUNT(*)::integer FROM users WHERE last_active_at >= NOW() - INTERVAL '1 day') AS "activeUsers24h",
         (SELECT COUNT(*)::integer FROM users WHERE last_active_at >= NOW() - INTERVAL '7 days') AS "activeUsers7d",
         (SELECT COUNT(*)::integer FROM system_error_logs WHERE created_at >= NOW() - INTERVAL '1 day') AS "errors24h"`
    ),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE password_hash <> '')::integer AS "passwordUsers",
         COUNT(*) FILTER (WHERE google_subject IS NOT NULL)::integer AS "googleUsers",
         COUNT(*) FILTER (WHERE apple_subject IS NOT NULL)::integer AS "appleUsers",
         COUNT(*) FILTER (
           WHERE password_hash <> ''
             AND google_subject IS NULL
             AND apple_subject IS NULL
         )::integer AS "passwordOnlyUsers",
         COUNT(*) FILTER (
           WHERE google_subject IS NOT NULL
             AND apple_subject IS NULL
             AND password_hash = ''
         )::integer AS "googleOnlyUsers",
         COUNT(*) FILTER (
           WHERE apple_subject IS NOT NULL
             AND google_subject IS NULL
             AND password_hash = ''
         )::integer AS "appleOnlyUsers",
         COUNT(*) FILTER (
           WHERE password_hash <> ''
             AND google_subject IS NOT NULL
         )::integer AS "passwordAndGoogleUsers",
         COUNT(*) FILTER (
           WHERE password_hash <> ''
             AND apple_subject IS NOT NULL
         )::integer AS "passwordAndAppleUsers"
       FROM users`
    ),
    pool.query(
      `SELECT TO_CHAR(day_series.day, 'YYYY-MM-DD') AS day,
              COALESCE(signups.new_users, 0)::integer AS "newUsers",
              COALESCE(workspaces.new_workspaces, 0)::integer AS "newWorkspaces"
       FROM generate_series(
         CURRENT_DATE - INTERVAL '6 days',
         CURRENT_DATE,
         INTERVAL '1 day'
       ) AS day_series(day)
       LEFT JOIN (
         SELECT DATE(created_at) AS day,
                COUNT(*) AS new_users
         FROM users
         WHERE created_at >= CURRENT_DATE - INTERVAL '6 days'
         GROUP BY DATE(created_at)
       ) signups ON signups.day = DATE(day_series.day)
       LEFT JOIN (
         SELECT DATE(created_at) AS day,
                COUNT(*) AS new_workspaces
         FROM workspaces
         WHERE created_at >= CURRENT_DATE - INTERVAL '6 days'
         GROUP BY DATE(created_at)
       ) workspaces ON workspaces.day = DATE(day_series.day)
       ORDER BY day_series.day ASC`
    ),
    pool.query(
      `SELECT u.id,
              u.name,
              u.email,
              u.site_role AS "siteRole",
              u.created_at AS "createdAt",
              u.last_login_at AS "lastLoginAt",
              u.last_active_at AS "lastActiveAt",
              (u.password_hash <> '') AS "hasPassword",
              (u.google_subject IS NOT NULL) AS "hasGoogle",
              (u.apple_subject IS NOT NULL) AS "hasApple",
              COALESCE(workspace_counts.workspace_count, 0)::integer AS "workspaceCount",
              COALESCE(task_counts.task_count, 0)::integer AS "taskCount",
              COALESCE(task_counts.completed_task_count, 0)::integer AS "completedTaskCount",
              COALESCE(invite_counts.pending_invite_count, 0)::integer AS "pendingInviteCount"
       FROM users u
       LEFT JOIN (
         SELECT user_id,
                COUNT(*) AS workspace_count
         FROM workspace_members
         GROUP BY user_id
       ) workspace_counts ON workspace_counts.user_id = u.id
       LEFT JOIN (
         SELECT created_by_user_id AS user_id,
                COUNT(*) AS task_count,
                COUNT(*) FILTER (WHERE completed_at IS NOT NULL) AS completed_task_count
         FROM tasks
         WHERE created_by_user_id IS NOT NULL
         GROUP BY created_by_user_id
       ) task_counts ON task_counts.user_id = u.id
       LEFT JOIN (
         SELECT invitee.id AS user_id,
                COUNT(*) AS pending_invite_count
         FROM workspace_invites wi
         JOIN users invitee ON invitee.email = wi.email
         WHERE wi.accepted_at IS NULL
           AND wi.expires_at > NOW()
         GROUP BY invitee.id
       ) invite_counts ON invite_counts.user_id = u.id
       ORDER BY
         CASE WHEN u.site_role = 'SUPER_ADMIN' THEN 0 ELSE 1 END,
         u.created_at DESC,
         u.id DESC`
    ),
    pool.query(
      `SELECT w.id,
              w.name,
              w.slug,
              w.created_at AS "createdAt",
              creator.name AS "createdByName",
              creator.email AS "createdByEmail",
              COALESCE(member_counts.member_count, 0)::integer AS "memberCount",
              COALESCE(list_counts.list_count, 0)::integer AS "listCount",
              COALESCE(task_counts.task_count, 0)::integer AS "taskCount",
              COALESCE(task_counts.completed_task_count, 0)::integer AS "completedTaskCount"
       FROM workspaces w
       LEFT JOIN users creator ON creator.id = w.created_by_user_id
       LEFT JOIN (
         SELECT workspace_id,
                COUNT(*) AS member_count
         FROM workspace_members
         GROUP BY workspace_id
       ) member_counts ON member_counts.workspace_id = w.id
       LEFT JOIN (
         SELECT workspace_id,
                COUNT(*) AS list_count
         FROM lists
         GROUP BY workspace_id
       ) list_counts ON list_counts.workspace_id = w.id
       LEFT JOIN (
         SELECT workspace_id,
                COUNT(*) AS task_count,
                COUNT(*) FILTER (WHERE completed_at IS NOT NULL) AS completed_task_count
         FROM tasks
         GROUP BY workspace_id
       ) task_counts ON task_counts.workspace_id = w.id
       ORDER BY
         COALESCE(task_counts.task_count, 0) DESC,
         COALESCE(member_counts.member_count, 0) DESC,
         w.created_at DESC
       LIMIT 12`
    ),
    pool.query(
      `SELECT al.id,
              al.event_type AS "eventType",
              al.target_type AS "targetType",
              al.target_id AS "targetId",
              al.workspace_id AS "workspaceId",
              al.metadata,
              al.created_at AS "createdAt",
              actor.id AS "actorUserId",
              actor.name AS "actorName",
              actor.email AS "actorEmail"
       FROM audit_logs al
       LEFT JOIN users actor ON actor.id = al.actor_user_id
       ORDER BY al.created_at DESC, al.id DESC
       LIMIT 30`
    ),
    pool.query(
      `SELECT sel.id,
              sel.level,
              sel.source,
              sel.message,
              sel.stack,
              sel.status_code AS "statusCode",
              sel.request_method AS "requestMethod",
              sel.request_path AS "requestPath",
              sel.metadata,
              sel.created_at AS "createdAt",
              u.id AS "userId",
              u.email AS "userEmail"
       FROM system_error_logs sel
       LEFT JOIN users u ON u.id = sel.user_id
       ORDER BY sel.created_at DESC, sel.id DESC
       LIMIT 40`
    )
  ]);

  return {
    overview: overviewResult.rows[0] || {},
    providers: providerMixResult.rows[0] || {},
    growth: growthResult.rows,
    users: usersResult.rows,
    workspaces: workspacesResult.rows,
    recentActivity: activityResult.rows,
    errorLogs: errorsResult.rows
  };
}

function hashInviteToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function issueInviteToken() {
  return crypto.randomBytes(24).toString('hex');
}

function hashPasswordResetToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function issuePasswordResetToken() {
  return crypto.randomBytes(24).toString('hex');
}

export async function registerUser({ name, email, password, workspaceName, inviteToken = null }) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const normalizedEmail = email.toLowerCase();
    const invite = inviteToken ? await getInviteRecordForRegistration(client, inviteToken) : null;

    if (invite && invite.email !== normalizedEmail) {
      const error = new Error('This invite was issued for a different email address.');
      error.status = 403;
      throw error;
    }

    const existing = await client.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (existing.rowCount) {
      const error = new Error('An account with this email already exists.');
      error.status = 409;
      throw error;
    }

    const passwordHash = await hashPassword(password);
    const userResult = await client.query(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, name, email, site_role AS "siteRole", created_at AS "createdAt"`,
      [name.trim(), normalizedEmail, passwordHash]
    );
    const user = userResult.rows[0];

    let workspace = null;
    const defaultWorkspaceName = String(workspaceName || '').trim() || defaultWorkspaceNameFor(name);

    if (!invite) {
      workspace = await createWorkspaceForUser(client, {
        userId: user.id,
        workspaceName: defaultWorkspaceName
      });
    }

    await client.query('COMMIT');
    const workspaces = await getSessionWorkspacesForSiteRole(user.id, user.siteRole);
    return { user, workspace, workspaces, defaultWorkspaceId: getDefaultWorkspaceId(workspaces) };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function authenticateUser({ email, password }) {
  const result = await pool.query(
    `SELECT id,
            name,
            email,
            site_role AS "siteRole",
            password_hash AS "passwordHash",
            google_subject AS "googleSubject",
            apple_subject AS "appleSubject"
     FROM users
     WHERE email = $1`,
    [email.toLowerCase()]
  );

  const user = result.rows[0];
  if (!user) {
    const error = new Error('Invalid email or password.');
    error.status = 401;
    throw error;
  }

  if (!user.passwordHash) {
    const providers = [];
    if (user.googleSubject) providers.push('Google');
    if (user.appleSubject) providers.push('Apple');
    const providerLabel = providers.length ? providers.join(' or ') : 'social sign-in';
    const error = new Error(`This account uses ${providerLabel}. Continue with that provider or use Forgot password to set a password.`);
    error.status = 401;
    throw error;
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    const error = new Error('Invalid email or password.');
    error.status = 401;
    throw error;
  }

  const workspaces = await getSessionWorkspacesForSiteRole(user.id, user.siteRole);
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      siteRole: user.siteRole
    },
    workspaces,
    defaultWorkspaceId: getDefaultWorkspaceId(workspaces)
  };
}

export async function createPasswordResetRequest({ email }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) {
    const error = new Error('Email is required.');
    error.status = 400;
    throw error;
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const userResult = await client.query(
      `SELECT id,
              name,
              email,
              password_hash AS "passwordHash",
              google_subject AS "googleSubject",
              apple_subject AS "appleSubject"
       FROM users
       WHERE email = $1
       FOR UPDATE`,
      [normalizedEmail]
    );
    const user = userResult.rows[0];

    if (!user) {
      await client.query('COMMIT');
      return null;
    }

    await client.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [user.id]);

    const token = issuePasswordResetToken();
    const tokenHash = hashPasswordResetToken(token);
    const resetResult = await client.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 hour'))
       RETURNING id, expires_at AS "expiresAt", created_at AS "createdAt"`,
      [user.id, tokenHash, PASSWORD_RESET_TTL_HOURS]
    );

    await client.query('COMMIT');

    return {
      ...resetResult.rows[0],
      userId: user.id,
      email: user.email,
      name: user.name,
      kind: user.passwordHash ? 'reset' : 'setup',
      providerLabel: user.googleSubject && user.appleSubject
        ? 'Google or Apple'
        : (user.googleSubject ? 'Google' : (user.appleSubject ? 'Apple' : 'your current sign-in method')),
      token
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});

    if (error.code === '23505' && error.constraint === 'idx_password_reset_tokens_token_hash') {
      const tokenConflictError = new Error('Failed to issue a password link. Please try again.');
      tokenConflictError.status = 409;
      throw tokenConflictError;
    }

    throw error;
  } finally {
    client.release();
  }
}

export async function resetPasswordWithToken({ resetToken, password }) {
  const token = String(resetToken || '').trim();
  if (!token || !password) {
    const error = new Error('Reset token and password are required.');
    error.status = 400;
    throw error;
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const resetResult = await client.query(
      `SELECT prt.id,
              prt.user_id AS "userId",
              prt.used_at AS "usedAt",
              prt.expires_at AS "expiresAt",
              u.name,
              u.email,
              u.site_role AS "siteRole"
       FROM password_reset_tokens prt
       JOIN users u ON u.id = prt.user_id
       WHERE prt.token_hash = $1
       FOR UPDATE`,
      [hashPasswordResetToken(token)]
    );
    const resetRecord = resetResult.rows[0];

    if (!resetRecord || resetRecord.usedAt || resetRecord.expiresAt <= new Date()) {
      const error = new Error('Password reset link is invalid or expired.');
      error.status = 404;
      throw error;
    }

    const nextPasswordHash = await hashPassword(password);

    await client.query(
      `UPDATE users
       SET password_hash = $2
       WHERE id = $1`,
      [resetRecord.userId, nextPasswordHash]
    );

    await client.query(
      `UPDATE password_reset_tokens
       SET used_at = NOW()
       WHERE user_id = $1
         AND used_at IS NULL`,
      [resetRecord.userId]
    );

    await client.query('COMMIT');

    const workspaces = await getSessionWorkspacesForSiteRole(resetRecord.userId, resetRecord.siteRole);
    return {
      user: {
        id: resetRecord.userId,
        name: resetRecord.name,
        email: resetRecord.email,
        siteRole: resetRecord.siteRole
      },
      workspaces,
      defaultWorkspaceId: getDefaultWorkspaceId(workspaces)
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function authenticateWithGoogle({ email, googleSubject, name, inviteToken = null }) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const normalizedEmail = email.toLowerCase();
    const invite = inviteToken ? await getInviteRecordForRegistration(client, inviteToken) : null;

    if (invite && invite.email !== normalizedEmail) {
      const error = new Error('This invite was issued for a different email address.');
      error.status = 403;
      throw error;
    }

    let user = null;
    const existingByGoogle = await client.query(
      `SELECT id, name, email, site_role AS "siteRole", google_subject AS "googleSubject"
       FROM users
       WHERE google_subject = $1`,
      [googleSubject]
    );
    user = existingByGoogle.rows[0] || null;

    if (!user) {
      const existingByEmail = await client.query(
        `SELECT id, name, email, site_role AS "siteRole", google_subject AS "googleSubject"
         FROM users
         WHERE email = $1`,
        [normalizedEmail]
      );
      user = existingByEmail.rows[0] || null;
    }

    let workspace = null;

    if (user) {
      if (user.googleSubject && user.googleSubject !== googleSubject) {
        const error = new Error('This account is already linked to a different Google profile.');
        error.status = 409;
        throw error;
      }

      const updateResult = await client.query(
        `UPDATE users
         SET google_subject = COALESCE(google_subject, $2),
             name = CASE WHEN BTRIM(name) = '' THEN $3 ELSE name END
         WHERE id = $1
         RETURNING id, name, email, site_role AS "siteRole", created_at AS "createdAt"`,
        [user.id, googleSubject, name.trim()]
      );
      user = updateResult.rows[0];
    } else {
      const createdUser = await client.query(
        `INSERT INTO users (name, email, password_hash, google_subject)
         VALUES ($1, $2, '', $3)
         RETURNING id, name, email, site_role AS "siteRole", created_at AS "createdAt"`,
        [name.trim(), normalizedEmail, googleSubject]
      );
      user = createdUser.rows[0];

      if (!invite) {
        workspace = await createWorkspaceForUser(client, {
          userId: user.id,
          workspaceName: defaultWorkspaceNameFor(name)
        });
      }
    }

    await client.query('COMMIT');

    const workspaces = await getSessionWorkspacesForSiteRole(user.id, user.siteRole);
    return {
      user,
      workspace,
      workspaces,
      defaultWorkspaceId: workspace?.id || getDefaultWorkspaceId(workspaces)
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function authenticateWithApple({ email, appleSubject, name, inviteToken = null }) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const normalizedEmail = email.toLowerCase();
    const invite = inviteToken ? await getInviteRecordForRegistration(client, inviteToken) : null;

    if (invite && invite.email !== normalizedEmail) {
      const error = new Error('This invite was issued for a different email address.');
      error.status = 403;
      throw error;
    }

    let user = null;
    const existingByApple = await client.query(
      `SELECT id, name, email, site_role AS "siteRole", apple_subject AS "appleSubject", google_subject AS "googleSubject"
       FROM users
       WHERE apple_subject = $1`,
      [appleSubject]
    );
    user = existingByApple.rows[0] || null;

    if (!user) {
      const existingByEmail = await client.query(
        `SELECT id, name, email, site_role AS "siteRole", apple_subject AS "appleSubject", google_subject AS "googleSubject"
         FROM users
         WHERE email = $1`,
        [normalizedEmail]
      );
      user = existingByEmail.rows[0] || null;
    }

    let workspace = null;

    if (user) {
      if (user.appleSubject && user.appleSubject !== appleSubject) {
        const error = new Error('This account is already linked to a different Apple profile.');
        error.status = 409;
        throw error;
      }

      const nextName = String(name || '').trim();
      const updateResult = await client.query(
        `UPDATE users
         SET apple_subject = COALESCE(apple_subject, $2),
             name = CASE WHEN BTRIM(name) = '' AND $3 <> '' THEN $3 ELSE name END
         WHERE id = $1
         RETURNING id, name, email, site_role AS "siteRole", created_at AS "createdAt"`,
        [user.id, appleSubject, nextName]
      );
      user = updateResult.rows[0];
    } else {
      const nextName = String(name || '').trim() || normalizedEmail.split('@')[0];
      const createdUser = await client.query(
        `INSERT INTO users (name, email, password_hash, apple_subject)
         VALUES ($1, $2, '', $3)
         RETURNING id, name, email, site_role AS "siteRole", created_at AS "createdAt"`,
        [nextName, normalizedEmail, appleSubject]
      );
      user = createdUser.rows[0];

      if (!invite) {
        workspace = await createWorkspaceForUser(client, {
          userId: user.id,
          workspaceName: defaultWorkspaceNameFor(user.name)
        });
      }
    }

    await client.query('COMMIT');

    const workspaces = await getSessionWorkspacesForSiteRole(user.id, user.siteRole);
    return {
      user,
      workspace,
      workspaces,
      defaultWorkspaceId: workspace?.id || getDefaultWorkspaceId(workspaces)
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getAuthSession(userId) {
  const user = await getCurrentUserProfile(userId);

  if (!user) {
    const error = new Error('User not found.');
    error.status = 404;
    throw error;
  }

  if (isSuperAdminSiteRole(user.siteRole)) {
    return {
      user,
      workspaces: [],
      pendingInvites: [],
      defaultWorkspaceId: null
    };
  }

  const [workspaces, pendingInvites] = await Promise.all([
    getUserWorkspaces(userId),
    getPendingInvitesForUser(userId)
  ]);

  return {
    user,
    workspaces,
    pendingInvites,
    defaultWorkspaceId: getDefaultWorkspaceId(workspaces)
  };
}

export async function updateUserProfile({ userId, name, currentPassword = '', newPassword = '' }) {
  const nextName = String(name || '').trim();
  if (!nextName) {
    const error = new Error('Name is required.');
    error.status = 400;
    throw error;
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const userResult = await client.query(
      `SELECT id,
              name,
              password_hash AS "passwordHash",
              google_subject AS "googleSubject",
              apple_subject AS "appleSubject"
       FROM users
       WHERE id = $1
       FOR UPDATE`,
      [userId]
    );

    const user = userResult.rows[0];
    if (!user) {
      const error = new Error('User not found.');
      error.status = 404;
      throw error;
    }

    const wantsPasswordChange = Boolean(currentPassword || newPassword);
    let nextPasswordHash = null;

    if (wantsPasswordChange) {
      if (!newPassword) {
        const error = new Error(user.passwordHash
          ? 'Current password and new password are required to change your password.'
          : 'New password is required to set your password.');
        error.status = 400;
        throw error;
      }

      if (user.passwordHash) {
        if (!currentPassword) {
          const error = new Error('Current password and new password are required to change your password.');
          error.status = 400;
          throw error;
        }

        const validPassword = await verifyPassword(currentPassword, user.passwordHash);
        if (!validPassword) {
          const error = new Error('Current password is incorrect.');
          error.status = 401;
          throw error;
        }
      } else if (!user.googleSubject && !user.appleSubject) {
        const error = new Error('Password setup is unavailable for this account.');
        error.status = 400;
        throw error;
      }

      nextPasswordHash = await hashPassword(newPassword);
    }

    if (wantsPasswordChange) {
      await client.query(
        `UPDATE users
         SET name = $2,
             password_hash = $3
         WHERE id = $1`,
        [userId, nextName, nextPasswordHash]
      );
    } else {
      await client.query(
        `UPDATE users
         SET name = $2
         WHERE id = $1`,
        [userId, nextName]
      );
    }

    const updatedUser = await getCurrentUserProfile(userId, client);
    await client.query('COMMIT');

    return {
      user: updatedUser,
      nameChanged: nextName !== user.name
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function getUserWorkspaces(userId) {
  const result = await pool.query(
    `SELECT w.id, w.name, w.slug, wm.role
     FROM workspaces w
     JOIN workspace_members wm ON wm.workspace_id = w.id
     WHERE wm.user_id = $1
     ORDER BY w.id ASC`,
    [userId]
  );
  return result.rows;
}

export async function createWorkspace({ userId, name }) {
  const workspaceName = String(name || '').trim();
  if (!workspaceName) {
    const error = new Error('Workspace name is required.');
    error.status = 400;
    throw error;
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const workspace = await createWorkspaceForUser(client, {
      userId,
      workspaceName
    });
    await client.query('COMMIT');
    return workspace;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});

    throw error;
  } finally {
    client.release();
  }
}

export async function renameWorkspace({ workspaceId, actorUserId, name }) {
  const workspaceName = String(name || '').trim();
  if (!workspaceName) {
    const error = new Error('Workspace name is required.');
    error.status = 400;
    throw error;
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const membershipResult = await client.query(
      `SELECT wm.role,
              w.name AS "previousName"
       FROM workspace_members wm
       JOIN workspaces w ON w.id = wm.workspace_id
       WHERE wm.workspace_id = $1 AND wm.user_id = $2
       FOR UPDATE`,
      [workspaceId, actorUserId]
    );

    if (!membershipResult.rowCount) {
      const error = new Error('Workspace not found for this user.');
      error.status = 404;
      throw error;
    }

    if (membershipResult.rows[0].role !== 'owner') {
      const error = new Error('Only workspace owners can rename a workspace.');
      error.status = 403;
      throw error;
    }

    const result = await client.query(
      `UPDATE workspaces
       SET name = $2
       WHERE id = $1
       RETURNING id, name, slug, created_at AS "createdAt"`,
      [workspaceId, workspaceName]
    );

    if (!result.rowCount) {
      const error = new Error('Workspace not found.');
      error.status = 404;
      throw error;
    }

    await client.query('COMMIT');
    return {
      ...result.rows[0],
      previousName: membershipResult.rows[0].previousName
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});

    throw error;
  } finally {
    client.release();
  }
}

export async function getWorkspaceMembers(workspaceId) {
  const result = await pool.query(
    `SELECT u.id, u.name, u.email, wm.role, wm.joined_at AS "joinedAt"
     FROM workspace_members wm
     JOIN users u ON u.id = wm.user_id
     WHERE wm.workspace_id = $1
     ORDER BY wm.joined_at ASC`,
    [workspaceId]
  );
  return result.rows;
}

export async function removeWorkspaceMember({ workspaceId, actorUserId, targetUserId }) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    if (actorUserId === targetUserId) {
      const error = new Error('Owners cannot remove themselves from the workspace.');
      error.status = 400;
      throw error;
    }

    const actorMembership = await client.query(
      `SELECT role
       FROM workspace_members
       WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, actorUserId]
    );
    if (!actorMembership.rowCount || actorMembership.rows[0].role !== 'owner') {
      const error = new Error('Only workspace owners can remove members.');
      error.status = 403;
      throw error;
    }

    const targetMembership = await client.query(
      `SELECT wm.user_id AS "userId",
              wm.role,
              u.email,
              u.name
       FROM workspace_members wm
       JOIN users u ON u.id = wm.user_id
       WHERE wm.workspace_id = $1 AND wm.user_id = $2
       FOR UPDATE`,
      [workspaceId, targetUserId]
    );
    if (!targetMembership.rowCount) {
      const error = new Error('Member not found in this workspace.');
      error.status = 404;
      throw error;
    }

    const target = targetMembership.rows[0];
    if (target.role === 'owner') {
      const error = new Error('Owners cannot remove other owners from the workspace.');
      error.status = 400;
      throw error;
    }

    await client.query(
      `DELETE FROM workspace_members
       WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, targetUserId]
    );

    await client.query('COMMIT');
    return target;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function promoteWorkspaceMemberToOwner({ workspaceId, actorUserId, targetUserId }) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const actorMembership = await client.query(
      `SELECT role
       FROM workspace_members
       WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, actorUserId]
    );
    if (!actorMembership.rowCount || actorMembership.rows[0].role !== 'owner') {
      const error = new Error('Only workspace owners can appoint another owner.');
      error.status = 403;
      throw error;
    }

    const targetMembership = await client.query(
      `SELECT wm.user_id AS "userId",
              wm.role,
              u.email,
              u.name
       FROM workspace_members wm
       JOIN users u ON u.id = wm.user_id
       WHERE wm.workspace_id = $1 AND wm.user_id = $2
       FOR UPDATE`,
      [workspaceId, targetUserId]
    );
    if (!targetMembership.rowCount) {
      const error = new Error('Member not found in this workspace.');
      error.status = 404;
      throw error;
    }

    const target = targetMembership.rows[0];
    if (target.role === 'owner') {
      const error = new Error('That member is already an owner.');
      error.status = 409;
      throw error;
    }

    await client.query(
      `UPDATE workspace_members
       SET role = 'owner'
       WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, targetUserId]
    );

    await client.query('COMMIT');
    return {
      ...target,
      role: 'owner'
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function leaveWorkspace({ workspaceId, userId }) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const membershipResult = await client.query(
      `SELECT wm.user_id AS "userId",
              wm.role,
              w.name AS "workspaceName"
       FROM workspace_members wm
       JOIN workspaces w ON w.id = wm.workspace_id
       WHERE wm.workspace_id = $1 AND wm.user_id = $2
       FOR UPDATE`,
      [workspaceId, userId]
    );

    if (!membershipResult.rowCount) {
      const error = new Error('Workspace not found for this user.');
      error.status = 404;
      throw error;
    }

    const membership = membershipResult.rows[0];
    if (membership.role === 'owner') {
      const ownerCountResult = await client.query(
        `SELECT COUNT(*)::int AS count
         FROM workspace_members
         WHERE workspace_id = $1 AND role = 'owner'`,
        [workspaceId]
      );

      if (ownerCountResult.rows[0].count <= 1) {
        const error = new Error('Appoint another owner before leaving this workspace.');
        error.status = 400;
        throw error;
      }
    }

    await client.query(
      `DELETE FROM workspace_members
       WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId]
    );

    await client.query('COMMIT');
    return {
      workspaceId: Number(workspaceId),
      userId: Number(userId),
      workspaceName: membership.workspaceName
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteWorkspace({ workspaceId, actorUserId }) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const membershipResult = await client.query(
      `SELECT wm.role,
              w.name AS "workspaceName"
       FROM workspace_members wm
       JOIN workspaces w ON w.id = wm.workspace_id
       WHERE wm.workspace_id = $1 AND wm.user_id = $2
       FOR UPDATE`,
      [workspaceId, actorUserId]
    );

    if (!membershipResult.rowCount) {
      const error = new Error('Workspace not found for this user.');
      error.status = 404;
      throw error;
    }

    if (membershipResult.rows[0].role !== 'owner') {
      const error = new Error('Only workspace owners can delete a workspace.');
      error.status = 403;
      throw error;
    }

    const membersResult = await client.query(
      `SELECT wm.user_id AS "userId",
              u.email
       FROM workspace_members wm
       JOIN users u ON u.id = wm.user_id
       WHERE wm.workspace_id = $1
       ORDER BY wm.joined_at ASC`,
      [workspaceId]
    );

    if (membersResult.rowCount > 1) {
      const error = new Error('Shared workspaces cannot be deleted. Appoint another owner and leave the workspace instead.');
      error.status = 400;
      throw error;
    }

    const deleteResult = await client.query(
      `DELETE FROM workspaces
       WHERE id = $1
       RETURNING id, name`,
      [workspaceId]
    );

    if (!deleteResult.rowCount) {
      const error = new Error('Workspace not found.');
      error.status = 404;
      throw error;
    }

    await client.query('COMMIT');
    return {
      workspaceId: Number(workspaceId),
      workspaceName: deleteResult.rows[0].name,
      members: membersResult.rows.map((member) => ({
        userId: Number(member.userId),
        email: member.email
      }))
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function getWorkspaceInvites(workspaceId) {
  const result = await pool.query(
    `SELECT wi.id,
            wi.email,
            wi.role,
            wi.created_at AS "createdAt",
            wi.expires_at AS "expiresAt",
            inviter.name AS "invitedByName"
     FROM workspace_invites wi
     LEFT JOIN users inviter ON inviter.id = wi.invited_by_user_id
     WHERE wi.workspace_id = $1
       AND wi.accepted_at IS NULL
       AND wi.expires_at > NOW()
     ORDER BY wi.created_at DESC`,
    [workspaceId]
  );
  return result.rows;
}

export async function getPendingInvitesForUser(userId) {
  const result = await pool.query(
    `SELECT wi.id,
            wi.email,
            wi.role,
            wi.created_at AS "createdAt",
            wi.expires_at AS "expiresAt",
            wi.workspace_id AS "workspaceId",
            w.name AS "workspaceName",
            w.slug AS "workspaceSlug",
            inviter.name AS "invitedByName"
     FROM workspace_invites wi
     JOIN users invitee ON invitee.email = wi.email
     JOIN workspaces w ON w.id = wi.workspace_id
     LEFT JOIN users inviter ON inviter.id = wi.invited_by_user_id
     WHERE invitee.id = $1
       AND wi.accepted_at IS NULL
       AND wi.expires_at > NOW()
       AND NOT EXISTS (
         SELECT 1
         FROM workspace_members wm
         WHERE wm.workspace_id = wi.workspace_id
           AND wm.user_id = $1
       )
     ORDER BY wi.created_at DESC`,
    [userId]
  );

  return result.rows;
}

export async function ensureMembership(userId, workspaceId) {
  const result = await pool.query(
    `SELECT wm.role, w.name, w.slug
     FROM workspace_members wm
     JOIN workspaces w ON w.id = wm.workspace_id
     WHERE wm.user_id = $1 AND wm.workspace_id = $2`,
    [userId, workspaceId]
  );

  return result.rows[0] || null;
}

export async function getSnapshot({ userId, workspaceId }) {
  const membership = await ensureMembership(userId, workspaceId);
  if (!membership) {
    const error = new Error('Workspace not found for this user.');
    error.status = 404;
    throw error;
  }

  const [workspaceResult, userResult, memberships, listsResult, tasksResult, members, invites] = await Promise.all([
    pool.query(
      `SELECT id, name, slug, created_at AS "createdAt"
       FROM workspaces
       WHERE id = $1`,
      [workspaceId]
    ),
    getCurrentUserProfile(userId),
    getUserWorkspaces(userId),
    pool.query(
      `SELECT l.id, l.name,
              l.type,
              COUNT(t.id)::int AS "taskCount",
              COALESCE(SUM(CASE WHEN t.completed_at IS NULL AND t.id IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS "openCount"
       FROM lists l
       LEFT JOIN tasks t ON t.list_id = l.id
       WHERE l.workspace_id = $1
       GROUP BY l.id
       ORDER BY l.id DESC`,
      [workspaceId]
    ),
    pool.query(
      `SELECT t.id,
              t.list_id AS "listId",
              t.title,
              t.description,
              t.quantity,
              t.due_date AS "dueDate",
              t.priority,
              t.completed_at AS "completedAt",
              t.created_at AS "createdAt",
              creator.name AS "createdByName",
              completer.name AS "completedByName"
       FROM tasks t
       LEFT JOIN users creator ON creator.id = t.created_by_user_id
       LEFT JOIN users completer ON completer.id = t.completed_by_user_id
       WHERE t.workspace_id = $1
       ORDER BY t.id DESC`,
      [workspaceId]
    ),
    getWorkspaceMembers(workspaceId),
    getWorkspaceInvites(workspaceId)
  ]);

  return {
    workspace: workspaceResult.rows[0],
    currentUser: userResult,
    memberships,
    members,
    invites,
    lists: listsResult.rows,
    tasks: tasksResult.rows.map((task) => {
      const dueDate = normalizeDateOnly(task.dueDate);
      return {
        ...task,
        dueDate,
        createdAtLabel: fmt(task.createdAt),
        completedAtLabel: fmt(task.completedAt),
        dueDateLabel: fmtDateOnly(dueDate),
        createdByName: task.createdByName || 'Unknown user',
        completedByName: task.completedByName || null
      };
    }),
    defaultListId: listsResult.rows[0]?.id ?? null
  };
}

export async function createList({ workspaceId, userId, name, type = 'task' }) {
  if (!LIST_TYPES.has(type)) {
    const error = new Error('Invalid list type.');
    error.status = 400;
    throw error;
  }

  const result = await pool.query(
    `INSERT INTO lists (workspace_id, name, type, created_by_user_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, type`,
    [workspaceId, name.trim(), type, userId]
  );
  return result.rows[0];
}

export async function deleteList({ workspaceId, listId }) {
  const countResult = await pool.query('SELECT COUNT(*)::int AS count FROM lists WHERE workspace_id = $1', [workspaceId]);
  if (countResult.rows[0].count <= 1) {
    return { ok: false, reason: 'last-list' };
  }

  const result = await pool.query('DELETE FROM lists WHERE id = $1 AND workspace_id = $2', [listId, workspaceId]);
  return result.rowCount ? { ok: true } : { ok: false, reason: 'not-found' };
}

export async function createTask({
  workspaceId,
  userId,
  listId,
  title,
  description = '',
  quantity = '',
  dueDate = null,
  priority = 'medium'
}) {
  const list = await pool.query(
    'SELECT id, type FROM lists WHERE id = $1 AND workspace_id = $2',
    [listId, workspaceId]
  );
  if (!list.rowCount) return null;
  const listType = list.rows[0].type;
  const normalizedDueDate = listType === 'task' ? dueDate : null;
  const normalizedPriority = listType === 'task' ? priority : 'medium';
  const normalizedQuantity = listType === 'grocery' ? quantity.trim() : '';

  const result = await pool.query(
    `INSERT INTO tasks (workspace_id, list_id, title, description, quantity, due_date, priority, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, list_id AS "listId", title, description, quantity, due_date AS "dueDate", priority`,
    [workspaceId, listId, title.trim(), description.trim(), normalizedQuantity, normalizedDueDate, normalizedPriority, userId]
  );
  return result.rows[0];
}

export async function updateTask({
  workspaceId,
  userId,
  taskId,
  titleProvided,
  title,
  descriptionProvided,
  description,
  quantityProvided,
  quantity,
  dueDateProvided,
  dueDate,
  priorityProvided,
  priority,
  completedProvided,
  completed
}) {
  const listResult = await pool.query(
    `SELECT l.type
     FROM tasks t
     JOIN lists l ON l.id = t.list_id
     WHERE t.id = $1 AND t.workspace_id = $2`,
    [taskId, workspaceId]
  );

  if (!listResult.rowCount) {
    return false;
  }

  const listType = listResult.rows[0].type;
  const result = await pool.query(
    `UPDATE tasks
     SET title = CASE WHEN $1::boolean THEN $2 ELSE title END,
         description = CASE WHEN $3::boolean THEN $4 ELSE description END,
         quantity = CASE WHEN $5::boolean THEN $6 ELSE quantity END,
         due_date = CASE WHEN $7::boolean THEN $8 ELSE due_date END,
         priority = CASE WHEN $9::boolean THEN $10 ELSE priority END,
         completed_at = CASE
           WHEN NOT $11::boolean THEN completed_at
           WHEN $12 THEN NOW()
           ELSE NULL
         END,
         completed_by_user_id = CASE
           WHEN NOT $11::boolean THEN completed_by_user_id
           WHEN $12 THEN $13
           ELSE NULL
         END
     WHERE id = $14 AND workspace_id = $15`,
    [
      titleProvided,
      title,
      descriptionProvided,
      description,
      quantityProvided && listType === 'grocery',
      listType === 'grocery' ? quantity : '',
      dueDateProvided && listType === 'task',
      listType === 'task' ? dueDate : null,
      priorityProvided && listType === 'task',
      listType === 'task' ? priority : 'medium',
      completedProvided,
      completed,
      completed ? userId : null,
      taskId,
      workspaceId
    ]
  );
  return result.rowCount > 0;
}

export async function deleteTask({ workspaceId, taskId }) {
  const result = await pool.query('DELETE FROM tasks WHERE id = $1 AND workspace_id = $2', [taskId, workspaceId]);
  return result.rowCount > 0;
}

export async function addWorkspaceMember({ workspaceId, email, role = 'member' }) {
  const userResult = await pool.query('SELECT id, name, email FROM users WHERE email = $1', [email.toLowerCase()]);
  if (!userResult.rowCount) {
    const error = new Error('No registered user exists with that email.');
    error.status = 404;
    throw error;
  }

  const user = userResult.rows[0];
  await pool.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, user_id)
     DO UPDATE SET role = EXCLUDED.role`,
    [workspaceId, user.id, role]
  );

  return user;
}

export async function createWorkspaceInvite({ workspaceId, userId, email, role = 'member' }) {
  const normalizedEmail = email.toLowerCase();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(
      `DELETE FROM workspace_invites
       WHERE workspace_id = $1
         AND email = $2
         AND accepted_at IS NULL
         AND expires_at <= NOW()`,
      [workspaceId, normalizedEmail]
    );

    const token = issueInviteToken();
    const tokenHash = hashInviteToken(token);
    const [membershipResult, workspaceResult, inviterResult, pendingInviteResult] = await Promise.all([
      client.query(
        `SELECT 1
         FROM workspace_members wm
         JOIN users u ON u.id = wm.user_id
         WHERE wm.workspace_id = $1 AND u.email = $2`,
        [workspaceId, normalizedEmail]
      ),
      client.query(
        `SELECT id, name, slug
         FROM workspaces
         WHERE id = $1`,
        [workspaceId]
      ),
      client.query(
        `SELECT name, email
         FROM users
         WHERE id = $1`,
        [userId]
      ),
      client.query(
        `SELECT id
         FROM workspace_invites
         WHERE workspace_id = $1
           AND email = $2
           AND accepted_at IS NULL
           AND expires_at > NOW()
         LIMIT 1`,
        [workspaceId, normalizedEmail]
      )
    ]);

    if (membershipResult.rowCount) {
      const error = new Error('That user is already a member of this workspace.');
      error.status = 409;
      throw error;
    }

    if (pendingInviteResult.rowCount) {
      const error = new Error('There is already a pending invite for that email.');
      error.status = 409;
      throw error;
    }

    const result = await client.query(
      `INSERT INTO workspace_invites (workspace_id, email, role, token, token_hash, invited_by_user_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW() + ($7 * INTERVAL '1 day'))
       RETURNING id, email, role, created_at AS "createdAt", expires_at AS "expiresAt"`,
      [workspaceId, normalizedEmail, role, token, tokenHash, userId, INVITE_TTL_DAYS]
    );

    await client.query('COMMIT');

    return {
      ...result.rows[0],
      invitedByName: inviterResult.rows[0]?.name || '',
      invitedByEmail: inviterResult.rows[0]?.email || '',
      workspace: workspaceResult.rows[0],
      token
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});

    if (error.code === '23505' && error.constraint === 'idx_workspace_invites_one_pending_email') {
      const pendingInviteError = new Error('There is already a pending invite for that email.');
      pendingInviteError.status = 409;
      throw pendingInviteError;
    }

    if (error.code === '23505' && error.constraint === 'idx_workspace_invites_token') {
      const tokenConflictError = new Error('Failed to issue an invite link. Please try again.');
      tokenConflictError.status = 409;
      throw tokenConflictError;
    }

    throw error;
  } finally {
    client.release();
  }
}

export async function cancelWorkspaceInvite({ workspaceId, inviteId }) {
  const result = await pool.query(
    `DELETE FROM workspace_invites
     WHERE id = $1
       AND workspace_id = $2
       AND accepted_at IS NULL
       AND expires_at > NOW()
     RETURNING id, email`,
    [inviteId, workspaceId]
  );

  return result.rows[0] || null;
}

export async function resendWorkspaceInvite({ workspaceId, inviteId, userId }) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const [workspaceResult, inviterResult] = await Promise.all([
      client.query(
        `SELECT id, name, slug
         FROM workspaces
         WHERE id = $1`,
        [workspaceId]
      ),
      client.query(
        `SELECT name, email
         FROM users
         WHERE id = $1`,
        [userId]
      )
    ]);
    if (!workspaceResult.rowCount) {
      const error = new Error('Workspace not found.');
      error.status = 404;
      throw error;
    }

    const inviteResult = await client.query(
      `SELECT id, email, role, accepted_at AS "acceptedAt"
       FROM workspace_invites
       WHERE id = $1
         AND workspace_id = $2
       FOR UPDATE`,
      [inviteId, workspaceId]
    );

    const invite = inviteResult.rows[0];
    if (!invite || invite.acceptedAt) {
      const error = new Error('Invite not found or no longer pending.');
      error.status = 404;
      throw error;
    }

    const membershipResult = await client.query(
      `SELECT 1
       FROM workspace_members wm
       JOIN users u ON u.id = wm.user_id
       WHERE wm.workspace_id = $1 AND u.email = $2`,
      [workspaceId, invite.email]
    );
    if (membershipResult.rowCount) {
      const error = new Error('That user is already a member of this workspace.');
      error.status = 409;
      throw error;
    }

    const token = issueInviteToken();
    const tokenHash = hashInviteToken(token);
    const result = await client.query(
      `UPDATE workspace_invites
       SET token = $3,
           token_hash = $4,
           invited_by_user_id = $5,
           expires_at = NOW() + ($6 * INTERVAL '1 day')
       WHERE id = $1
         AND workspace_id = $2
       RETURNING id, email, role, created_at AS "createdAt", expires_at AS "expiresAt"`,
      [inviteId, workspaceId, token, tokenHash, userId, INVITE_TTL_DAYS]
    );

    await client.query('COMMIT');

    return {
      ...result.rows[0],
      invitedByName: inviterResult.rows[0]?.name || '',
      invitedByEmail: inviterResult.rows[0]?.email || '',
      workspace: workspaceResult.rows[0],
      token
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});

    if (error.code === '23505' && error.constraint === 'idx_workspace_invites_token') {
      const tokenConflictError = new Error('Failed to issue an invite link. Please try again.');
      tokenConflictError.status = 409;
      throw tokenConflictError;
    }

    throw error;
  } finally {
    client.release();
  }
}

export async function getWorkspaceInviteLink({ workspaceId, inviteId }) {
  const [workspaceResult, inviteResult] = await Promise.all([
    pool.query(
      `SELECT id, name, slug
       FROM workspaces
       WHERE id = $1`,
      [workspaceId]
    ),
    pool.query(
      `SELECT wi.id,
              wi.email,
              wi.role,
              wi.token,
              wi.accepted_at AS "acceptedAt",
              wi.created_at AS "createdAt",
              wi.expires_at AS "expiresAt"
       FROM workspace_invites wi
       WHERE wi.id = $1
         AND wi.workspace_id = $2`,
      [inviteId, workspaceId]
    )
  ]);

  if (!workspaceResult.rowCount) {
    const error = new Error('Workspace not found.');
    error.status = 404;
    throw error;
  }

  const invite = inviteResult.rows[0];
  if (!invite || invite.acceptedAt || invite.expiresAt <= new Date()) {
    const error = new Error('Invite not found or no longer pending.');
    error.status = 404;
    throw error;
  }

  const membershipResult = await pool.query(
    `SELECT 1
     FROM workspace_members wm
     JOIN users u ON u.id = wm.user_id
     WHERE wm.workspace_id = $1 AND u.email = $2`,
    [workspaceId, invite.email]
  );
  if (membershipResult.rowCount) {
    const error = new Error('That user is already a member of this workspace.');
    error.status = 409;
    throw error;
  }

  if (!invite.token) {
    const error = new Error('This invite was created before reusable links were supported. Resend it to generate a new link.');
    error.status = 409;
    throw error;
  }

  return {
    ...invite,
    workspace: workspaceResult.rows[0]
  };
}

export async function getInviteByToken(inviteToken) {
  const invite = await pool.query(
    `SELECT wi.id,
            wi.email,
            wi.role,
            wi.workspace_id AS "workspaceId",
            wi.created_at AS "createdAt",
            wi.expires_at AS "expiresAt",
            w.name AS "workspaceName",
            w.slug AS "workspaceSlug",
            EXISTS(
              SELECT 1
              FROM users u
              WHERE u.email = wi.email
            ) AS "hasAccount"
     FROM workspace_invites wi
     JOIN workspaces w ON w.id = wi.workspace_id
     WHERE wi.token_hash = $1
       AND wi.accepted_at IS NULL
       AND wi.expires_at > NOW()`,
    [hashInviteToken(inviteToken)]
  );

  return invite.rows[0] || null;
}

export async function acceptInviteForUser({ inviteToken = null, inviteId = null, userId, email }) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const invite = inviteId
      ? await getInviteRecordForUpdateById(client, inviteId)
      : await getInviteRecordForUpdate(client, inviteToken);

    if (invite.email !== email.toLowerCase()) {
      const error = new Error('This invite was issued for a different email address.');
      error.status = 403;
      throw error;
    }

    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, user_id)
       DO UPDATE SET role = EXCLUDED.role`,
      [invite.workspaceId, userId, invite.role]
    );

    await client.query(
      `UPDATE workspace_invites
       SET accepted_at = NOW(), accepted_by_user_id = $1
       WHERE id = $2`,
      [userId, invite.id]
    );

    await client.query('COMMIT');
    return invite.workspaceId;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function getInviteRecordForUpdate(client, inviteToken) {
  const result = await client.query(
    `SELECT wi.id,
            wi.email,
            wi.role,
            wi.workspace_id AS "workspaceId",
            wi.expires_at AS "expiresAt",
            w.name AS "workspaceName",
            w.slug AS "workspaceSlug",
            w.created_at AS "workspaceCreatedAt"
     FROM workspace_invites wi
     JOIN workspaces w ON w.id = wi.workspace_id
     WHERE wi.token_hash = $1
     FOR UPDATE`,
    [hashInviteToken(inviteToken)]
  );

  const invite = result.rows[0];
  if (!invite || invite.expiresAt <= new Date()) {
    const error = new Error('Invite not found or expired.');
    error.status = 404;
    throw error;
  }

  const consumed = await client.query(
    `SELECT accepted_at AS "acceptedAt"
     FROM workspace_invites
     WHERE id = $1`,
    [invite.id]
  );

  if (consumed.rows[0]?.acceptedAt) {
    const error = new Error('This invite has already been accepted.');
    error.status = 409;
    throw error;
  }

  return invite;
}

async function getInviteRecordForUpdateById(client, inviteId) {
  const result = await client.query(
    `SELECT wi.id,
            wi.email,
            wi.role,
            wi.workspace_id AS "workspaceId",
            wi.expires_at AS "expiresAt",
            w.name AS "workspaceName",
            w.slug AS "workspaceSlug",
            w.created_at AS "workspaceCreatedAt"
     FROM workspace_invites wi
     JOIN workspaces w ON w.id = wi.workspace_id
     WHERE wi.id = $1
     FOR UPDATE`,
    [inviteId]
  );

  const invite = result.rows[0];
  if (!invite || invite.expiresAt <= new Date()) {
    const error = new Error('Invite not found or expired.');
    error.status = 404;
    throw error;
  }

  const consumed = await client.query(
    `SELECT accepted_at AS "acceptedAt"
     FROM workspace_invites
     WHERE id = $1`,
    [invite.id]
  );

  if (consumed.rows[0]?.acceptedAt) {
    const error = new Error('This invite has already been accepted.');
    error.status = 409;
    throw error;
  }

  return invite;
}

async function getInviteRecordForRegistration(client, inviteToken) {
  const result = await client.query(
    `SELECT wi.id,
            wi.email,
            wi.role,
            wi.workspace_id AS "workspaceId",
            w.name AS "workspaceName",
            w.slug AS "workspaceSlug",
            w.created_at AS "workspaceCreatedAt"
     FROM workspace_invites wi
     JOIN workspaces w ON w.id = wi.workspace_id
     WHERE wi.token_hash = $1
       AND wi.accepted_at IS NULL
       AND wi.expires_at > NOW()`,
    [hashInviteToken(inviteToken)]
  );

  const invite = result.rows[0];
  if (!invite) {
    const error = new Error('Invite not found or expired.');
    error.status = 404;
    throw error;
  }

  return invite;
}
