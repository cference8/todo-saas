import 'dotenv/config';
import crypto from 'node:crypto';
import { Pool } from 'pg';
import { hashPassword, verifyPassword } from './auth.js';

const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/todo_saas';
const pool = new Pool({ connectionString });
const INVITE_TTL_DAYS = 7;
const LIST_TYPES = new Set(['task', 'grocery']);

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

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL DEFAULT '',
      google_subject TEXT UNIQUE,
      apple_subject TEXT UNIQUE,
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
    ALTER TABLE users ADD COLUMN IF NOT EXISTS google_subject TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_subject TEXT;
    ALTER TABLE users ALTER COLUMN password_hash SET DEFAULT '';
    ALTER TABLE lists ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'task';
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS quantity TEXT NOT NULL DEFAULT '';
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_date DATE;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'medium';
    UPDATE lists SET type = 'task' WHERE type IS NULL OR type NOT IN ('task', 'grocery');
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
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_subject ON users(google_subject) WHERE google_subject IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_apple_subject ON users(apple_subject) WHERE apple_subject IS NOT NULL;
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
       RETURNING id, name, email, created_at AS "createdAt"`,
      [name.trim(), normalizedEmail, passwordHash]
    );
    const user = userResult.rows[0];

    let workspace = null;

    if (!invite) {
      workspace = await createWorkspaceForUser(client, {
        userId: user.id,
        workspaceName
      });
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

export async function authenticateUser({ email, password }) {
  const result = await pool.query(
    `SELECT id,
            name,
            email,
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
    const error = new Error(`This account uses ${providerLabel}. Continue with that provider instead.`);
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
      `SELECT id, name, email, google_subject AS "googleSubject"
       FROM users
       WHERE google_subject = $1`,
      [googleSubject]
    );
    user = existingByGoogle.rows[0] || null;

    if (!user) {
      const existingByEmail = await client.query(
        `SELECT id, name, email, google_subject AS "googleSubject"
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
         RETURNING id, name, email, created_at AS "createdAt"`,
        [user.id, googleSubject, name.trim()]
      );
      user = updateResult.rows[0];
    } else {
      const createdUser = await client.query(
        `INSERT INTO users (name, email, password_hash, google_subject)
         VALUES ($1, $2, '', $3)
         RETURNING id, name, email, created_at AS "createdAt"`,
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

    const workspaces = await getUserWorkspaces(user.id);
    return {
      user,
      workspace,
      workspaces,
      defaultWorkspaceId: workspace?.id || workspaces[0]?.id || null
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
      `SELECT id, name, email, apple_subject AS "appleSubject", google_subject AS "googleSubject"
       FROM users
       WHERE apple_subject = $1`,
      [appleSubject]
    );
    user = existingByApple.rows[0] || null;

    if (!user) {
      const existingByEmail = await client.query(
        `SELECT id, name, email, apple_subject AS "appleSubject", google_subject AS "googleSubject"
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
         RETURNING id, name, email, created_at AS "createdAt"`,
        [user.id, appleSubject, nextName]
      );
      user = updateResult.rows[0];
    } else {
      const nextName = String(name || '').trim() || normalizedEmail.split('@')[0];
      const createdUser = await client.query(
        `INSERT INTO users (name, email, password_hash, apple_subject)
         VALUES ($1, $2, '', $3)
         RETURNING id, name, email, created_at AS "createdAt"`,
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

    const workspaces = await getUserWorkspaces(user.id);
    return {
      user,
      workspace,
      workspaces,
      defaultWorkspaceId: workspace?.id || workspaces[0]?.id || null
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getAuthSession(userId) {
  const [userResult, workspaces, pendingInvites] = await Promise.all([
    pool.query(
      `SELECT id, name, email, created_at AS "createdAt"
       FROM users
       WHERE id = $1`,
      [userId]
    ),
    getUserWorkspaces(userId),
    getPendingInvitesForUser(userId)
  ]);

  if (!userResult.rowCount) {
    const error = new Error('User not found.');
    error.status = 404;
    throw error;
  }

  return {
    user: userResult.rows[0],
    workspaces,
    pendingInvites,
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
    pool.query(
      `SELECT id, name, email, created_at AS "createdAt"
       FROM users
       WHERE id = $1`,
      [userId]
    ),
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
    currentUser: userResult.rows[0],
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
  const token = issueInviteToken();
  const tokenHash = hashInviteToken(token);

  const [membershipResult, workspaceResult, inviterResult] = await Promise.all([
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
    ),
    pool.query(
      `SELECT name, email
       FROM users
       WHERE id = $1`,
      [userId]
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
    invitedByName: inviterResult.rows[0]?.name || '',
    invitedByEmail: inviterResult.rows[0]?.email || '',
    workspace: workspaceResult.rows[0],
    token
  };
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
       SET token_hash = $3,
           invited_by_user_id = $4,
           expires_at = NOW() + ($5 * INTERVAL '1 day')
       WHERE id = $1
         AND workspace_id = $2
       RETURNING id, email, role, created_at AS "createdAt", expires_at AS "expiresAt"`,
      [inviteId, workspaceId, tokenHash, userId, INVITE_TTL_DAYS]
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
    throw error;
  } finally {
    client.release();
  }
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
