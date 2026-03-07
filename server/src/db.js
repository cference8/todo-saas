import 'dotenv/config';
import { Pool } from 'pg';
import { hashPassword, verifyPassword } from './auth.js';

const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/todo_saas';
const pool = new Pool({ connectionString });

function fmt(value) {
  return value ? new Date(value).toLocaleString() : null;
}

function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'workspace';
}

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
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
      created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id BIGSERIAL PRIMARY KEY,
      workspace_id BIGINT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      list_id BIGINT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
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
}

export async function registerUser({ name, email, password, workspaceName }) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rowCount) {
      const error = new Error('An account with this email already exists.');
      error.status = 409;
      throw error;
    }

    const passwordHash = await hashPassword(password);
    const userResult = await client.query(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, name, email, created_at AS "createdAt"`,
      [name.trim(), email.toLowerCase(), passwordHash]
    );
    const user = userResult.rows[0];

    const workspaceSlug = `${slugify(workspaceName)}-${String(user.id)}`;
    const workspaceResult = await client.query(
      `INSERT INTO workspaces (name, slug, created_by_user_id)
       VALUES ($1, $2, $3)
       RETURNING id, name, slug, created_at AS "createdAt"`,
      [workspaceName.trim(), workspaceSlug, user.id]
    );
    const workspace = workspaceResult.rows[0];

    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [workspace.id, user.id]
    );

    await client.query(
      `INSERT INTO lists (workspace_id, name, created_by_user_id)
       VALUES ($1, 'General', $2), ($1, 'Product Ideas', $2)`,
      [workspace.id, user.id]
    );

    await client.query('COMMIT');
    return { user, workspace, workspaces: [{ ...workspace, role: 'owner' }] };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function authenticateUser({ email, password }) {
  const result = await pool.query(
    `SELECT id, name, email, password_hash AS "passwordHash"
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

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    const error = new Error('Invalid email or password.');
    error.status = 401;
    throw error;
  }

  const workspaces = await getUserWorkspaces(user.id);
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email
    },
    workspaces,
    defaultWorkspaceId: workspaces[0]?.id ?? null
  };
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

  const [workspaceResult, userResult, memberships, listsResult, tasksResult, members] = await Promise.all([
    pool.query(
      `SELECT id, name, slug, created_at AS "createdAt"
       FROM workspaces
       WHERE id = $1`,
      [workspaceId]
    ),
    pool.query(
      `SELECT id, name, email, created_at AS "createdAt"
       FROM users
       WHERE id = $1`,
      [userId]
    ),
    getUserWorkspaces(userId),
    pool.query(
      `SELECT l.id, l.name,
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
    getWorkspaceMembers(workspaceId)
  ]);

  return {
    workspace: workspaceResult.rows[0],
    currentUser: userResult.rows[0],
    memberships,
    members,
    lists: listsResult.rows,
    tasks: tasksResult.rows.map((task) => ({
      ...task,
      createdAtLabel: fmt(task.createdAt),
      completedAtLabel: fmt(task.completedAt),
      createdByName: task.createdByName || 'Unknown user',
      completedByName: task.completedByName || null
    })),
    defaultListId: listsResult.rows[0]?.id ?? null
  };
}

export async function createList({ workspaceId, userId, name }) {
  const result = await pool.query(
    `INSERT INTO lists (workspace_id, name, created_by_user_id)
     VALUES ($1, $2, $3)
     RETURNING id, name`,
    [workspaceId, name.trim(), userId]
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

export async function createTask({ workspaceId, userId, listId, title }) {
  const list = await pool.query(
    'SELECT id FROM lists WHERE id = $1 AND workspace_id = $2',
    [listId, workspaceId]
  );
  if (!list.rowCount) return null;

  const result = await pool.query(
    `INSERT INTO tasks (workspace_id, list_id, title, created_by_user_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, list_id AS "listId", title`,
    [workspaceId, listId, title.trim(), userId]
  );
  return result.rows[0];
}

export async function setTaskCompletion({ workspaceId, userId, taskId, completed }) {
  const result = await pool.query(
    `UPDATE tasks
     SET completed_at = $1,
         completed_by_user_id = $2
     WHERE id = $3 AND workspace_id = $4`,
    [completed ? new Date().toISOString() : null, completed ? userId : null, taskId, workspaceId]
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
