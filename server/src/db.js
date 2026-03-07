import 'dotenv/config';
import crypto from 'node:crypto';
import { Pool } from 'pg';
import { hashPassword, verifyPassword } from './auth.js';

const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/todo_saas';
const pool = new Pool({ connectionString });
const INVITE_TTL_DAYS = 7;

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
      description TEXT NOT NULL DEFAULT '',
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
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_date DATE;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'medium';
    UPDATE tasks SET priority = 'medium' WHERE priority IS NULL OR priority NOT IN ('low', 'medium', 'high');
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS workspace_invites (
      id BIGSERIAL PRIMARY KEY,
      workspace_id BIGINT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      token_hash TEXT NOT NULL UNIQUE,
      invited_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      accepted_at TIMESTAMPTZ,
      accepted_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_invites_workspace_id ON workspace_invites(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_workspace_invites_email ON workspace_invites(email);
  `);
}

function hashInviteToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function issueInviteToken() {
  return crypto.randomBytes(24).toString('hex');
}

export async function registerUser({ name, email, password, workspaceName, inviteToken = null }) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const normalizedEmail = email.toLowerCase();
    const invite = inviteToken ? await getInviteRecordForUpdate(client, inviteToken) : null;

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
       RETURNING id, name, email, created_at AS "createdAt"`,
      [name.trim(), normalizedEmail, passwordHash]
    );
    const user = userResult.rows[0];

    let workspace;

    if (invite) {
      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (workspace_id, user_id)
         DO UPDATE SET role = EXCLUDED.role`,
        [invite.workspaceId, user.id, invite.role]
      );

      await client.query(
        `UPDATE workspace_invites
         SET accepted_at = NOW(), accepted_by_user_id = $1
         WHERE id = $2`,
        [user.id, invite.id]
      );

      workspace = {
        id: invite.workspaceId,
        name: invite.workspaceName,
        slug: invite.workspaceSlug,
        createdAt: invite.workspaceCreatedAt
      };
    } else {
      const workspaceSlug = `${slugify(workspaceName)}-${String(user.id)}`;
      const workspaceResult = await client.query(
        `INSERT INTO workspaces (name, slug, created_by_user_id)
         VALUES ($1, $2, $3)
         RETURNING id, name, slug, created_at AS "createdAt"`,
        [workspaceName.trim(), workspaceSlug, user.id]
      );
      workspace = workspaceResult.rows[0];

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
    }

    await client.query('COMMIT');
    return { user, workspace, workspaces: await getUserWorkspaces(user.id) };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function authenticateUser({ email, password, inviteToken = null }) {
  const client = await pool.connect();

  try {
    let acceptedWorkspaceId = null;
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

    if (inviteToken) {
      await client.query('BEGIN');
      const invite = await getInviteRecordForUpdate(client, inviteToken);
      acceptedWorkspaceId = invite.workspaceId;

      if (invite.email !== user.email) {
        const error = new Error('This invite was issued for a different email address.');
        error.status = 403;
        throw error;
      }

      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (workspace_id, user_id)
         DO UPDATE SET role = EXCLUDED.role`,
        [invite.workspaceId, user.id, invite.role]
      );

      await client.query(
        `UPDATE workspace_invites
         SET accepted_at = NOW(), accepted_by_user_id = $1
         WHERE id = $2`,
        [user.id, invite.id]
      );

      await client.query('COMMIT');
    }

    const workspaces = await getUserWorkspaces(user.id);
    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email
      },
      workspaces,
      defaultWorkspaceId: acceptedWorkspaceId
        ? workspaces.find((workspace) => workspace.id === acceptedWorkspaceId)?.id ?? workspaces[0]?.id ?? null
        : workspaces[0]?.id ?? null
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
              t.description,
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
    currentUser: userResult.rows[0],
    memberships,
    members,
    invites,
    lists: listsResult.rows,
    tasks: tasksResult.rows.map((task) => ({
      ...task,
      createdAtLabel: fmt(task.createdAt),
      completedAtLabel: fmt(task.completedAt),
      dueDateLabel: task.dueDate ? new Date(`${task.dueDate}T00:00:00`).toLocaleDateString() : null,
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

export async function createTask({ workspaceId, userId, listId, title, description = '', dueDate = null, priority = 'medium' }) {
  const list = await pool.query(
    'SELECT id FROM lists WHERE id = $1 AND workspace_id = $2',
    [listId, workspaceId]
  );
  if (!list.rowCount) return null;

  const result = await pool.query(
    `INSERT INTO tasks (workspace_id, list_id, title, description, due_date, priority, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, list_id AS "listId", title, description, due_date AS "dueDate", priority`,
    [workspaceId, listId, title.trim(), description.trim(), dueDate, priority, userId]
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
  dueDateProvided,
  dueDate,
  priorityProvided,
  priority,
  completedProvided,
  completed
}) {
  const result = await pool.query(
    `UPDATE tasks
     SET title = CASE WHEN $1::boolean THEN $2 ELSE title END,
         description = CASE WHEN $3::boolean THEN $4 ELSE description END,
         due_date = CASE WHEN $5::boolean THEN $6 ELSE due_date END,
         priority = CASE WHEN $7::boolean THEN $8 ELSE priority END,
         completed_at = CASE
           WHEN NOT $9::boolean THEN completed_at
           WHEN $10 THEN NOW()
           ELSE NULL
         END,
         completed_by_user_id = CASE
           WHEN NOT $9::boolean THEN completed_by_user_id
           WHEN $10 THEN $11
           ELSE NULL
         END
     WHERE id = $12 AND workspace_id = $13`,
    [
      titleProvided,
      title,
      descriptionProvided,
      description,
      dueDateProvided,
      dueDate,
      priorityProvided,
      priority,
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
  const token = issueInviteToken();
  const tokenHash = hashInviteToken(token);

  const [membershipResult, workspaceResult] = await Promise.all([
    pool.query(
      `SELECT 1
       FROM workspace_members wm
       JOIN users u ON u.id = wm.user_id
       WHERE wm.workspace_id = $1 AND u.email = $2`,
      [workspaceId, normalizedEmail]
    ),
    pool.query(
      `SELECT id, name, slug
       FROM workspaces
       WHERE id = $1`,
      [workspaceId]
    )
  ]);

  if (membershipResult.rowCount) {
    const error = new Error('That user is already a member of this workspace.');
    error.status = 409;
    throw error;
  }

  const result = await pool.query(
    `INSERT INTO workspace_invites (workspace_id, email, role, token_hash, invited_by_user_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, NOW() + ($6 * INTERVAL '1 day'))
     RETURNING id, email, role, created_at AS "createdAt", expires_at AS "expiresAt"`,
    [workspaceId, normalizedEmail, role, tokenHash, userId, INVITE_TTL_DAYS]
  );

  return {
    ...result.rows[0],
    workspace: workspaceResult.rows[0],
    token
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
            w.slug AS "workspaceSlug"
     FROM workspace_invites wi
     JOIN workspaces w ON w.id = wi.workspace_id
     WHERE wi.token_hash = $1
       AND wi.accepted_at IS NULL
       AND wi.expires_at > NOW()`,
    [hashInviteToken(inviteToken)]
  );

  return invite.rows[0] || null;
}

export async function acceptInviteForUser({ inviteToken, userId, email }) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const invite = await getInviteRecordForUpdate(client, inviteToken);

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
