import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = path.resolve(process.cwd(), 'data');
const dbPath = path.join(dataDir, 'todo-saas.db');

fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS workspaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS workspace_members (
    workspace_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'owner',
    PRIMARY KEY (workspace_id, user_id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    created_by_user_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    list_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    completed_at TEXT,
    created_by_user_id INTEGER,
    completed_by_user_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (completed_by_user_id) REFERENCES users(id) ON DELETE SET NULL
  );
`);

function seed() {
  const workspaceCount = db.prepare('SELECT COUNT(*) AS count FROM workspaces').get().count;
  if (workspaceCount) return;

  const insertWorkspace = db.prepare('INSERT INTO workspaces (name, slug) VALUES (?, ?)');
  const insertUser = db.prepare('INSERT INTO users (name, email) VALUES (?, ?)');
  const insertMember = db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)');
  const insertList = db.prepare('INSERT INTO lists (workspace_id, name, created_by_user_id) VALUES (?, ?, ?)');
  const insertTask = db.prepare(`
    INSERT INTO tasks (workspace_id, list_id, title, created_by_user_id, completed_at, completed_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const workspace = insertWorkspace.run('Ference Studio', 'ference-studio');
  const user = insertUser.run('Chris', 'chris@example.com');
  insertMember.run(workspace.lastInsertRowid, user.lastInsertRowid, 'owner');

  const backlog = insertList.run(workspace.lastInsertRowid, 'Backlog', user.lastInsertRowid);
  const launch = insertList.run(workspace.lastInsertRowid, 'Launch Prep', user.lastInsertRowid);

  insertTask.run(workspace.lastInsertRowid, backlog.lastInsertRowid, 'Replace Firebase with your own backend', user.lastInsertRowid, null, null);
  insertTask.run(workspace.lastInsertRowid, backlog.lastInsertRowid, 'Create pricing and billing tables later', user.lastInsertRowid, null, null);
  insertTask.run(workspace.lastInsertRowid, launch.lastInsertRowid, 'Wire up Vue client bootstrapping', user.lastInsertRowid, new Date().toISOString(), user.lastInsertRowid);
}

seed();

const defaultWorkspaceId = db.prepare('SELECT id FROM workspaces ORDER BY id LIMIT 1').get().id;
const defaultUserId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;

function fmt(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString();
}

export function getSnapshot() {
  const workspace = db.prepare('SELECT id, name, slug, created_at AS createdAt FROM workspaces WHERE id = ?').get(defaultWorkspaceId);
  const currentUser = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(defaultUserId);
  const lists = db.prepare(`
    SELECT
      lists.id,
      lists.name,
      COUNT(tasks.id) AS taskCount,
      SUM(CASE WHEN tasks.completed_at IS NULL AND tasks.id IS NOT NULL THEN 1 ELSE 0 END) AS openCount
    FROM lists
    LEFT JOIN tasks ON tasks.list_id = lists.id
    WHERE lists.workspace_id = ?
    GROUP BY lists.id
    ORDER BY lists.id DESC
  `).all(defaultWorkspaceId).map((list) => ({
    ...list,
    taskCount: Number(list.taskCount || 0),
    openCount: Number(list.openCount || 0)
  }));

  const tasks = db.prepare(`
    SELECT
      tasks.id,
      tasks.list_id AS listId,
      tasks.title,
      tasks.completed_at AS completedAt,
      tasks.created_at AS createdAt,
      creator.name AS createdByName,
      completer.name AS completedByName
    FROM tasks
    LEFT JOIN users AS creator ON creator.id = tasks.created_by_user_id
    LEFT JOIN users AS completer ON completer.id = tasks.completed_by_user_id
    WHERE tasks.workspace_id = ?
    ORDER BY tasks.id DESC
  `).all(defaultWorkspaceId).map((task) => ({
    ...task,
    createdAtLabel: fmt(task.createdAt),
    completedAtLabel: fmt(task.completedAt),
    createdByName: task.createdByName || 'Unknown user',
    completedByName: task.completedByName || null
  }));

  return {
    workspace,
    currentUser,
    lists,
    tasks,
    defaultListId: lists[0]?.id ?? null
  };
}

export function createList(name) {
  const result = db.prepare(
    'INSERT INTO lists (workspace_id, name, created_by_user_id) VALUES (?, ?, ?)'
  ).run(defaultWorkspaceId, name, defaultUserId);

  return db.prepare('SELECT id, name FROM lists WHERE id = ?').get(result.lastInsertRowid);
}

export function deleteList(listId) {
  const listCount = db.prepare('SELECT COUNT(*) AS count FROM lists WHERE workspace_id = ?').get(defaultWorkspaceId).count;
  if (listCount <= 1) {
    return { ok: false, reason: 'last-list' };
  }

  const result = db.prepare('DELETE FROM lists WHERE id = ? AND workspace_id = ?').run(listId, defaultWorkspaceId);
  return result.changes > 0 ? { ok: true } : { ok: false, reason: 'not-found' };
}

export function createTask(listId, title) {
  const list = db.prepare(
    'SELECT id FROM lists WHERE id = ? AND workspace_id = ?'
  ).get(listId, defaultWorkspaceId);

  if (!list) {
    return null;
  }

  const result = db.prepare(
    'INSERT INTO tasks (workspace_id, list_id, title, created_by_user_id) VALUES (?, ?, ?, ?)'
  ).run(defaultWorkspaceId, listId, title, defaultUserId);

  return db.prepare('SELECT id, list_id AS listId, title FROM tasks WHERE id = ?').get(result.lastInsertRowid);
}

export function setTaskCompletion(taskId, completed) {
  const completedAt = completed ? new Date().toISOString() : null;
  const completedBy = completed ? defaultUserId : null;

  const result = db.prepare(
    'UPDATE tasks SET completed_at = ?, completed_by_user_id = ? WHERE id = ? AND workspace_id = ?'
  ).run(completedAt, completedBy, taskId, defaultWorkspaceId);

  return result.changes > 0;
}

export function deleteTask(taskId) {
  const result = db.prepare('DELETE FROM tasks WHERE id = ? AND workspace_id = ?').run(taskId, defaultWorkspaceId);
  return result.changes > 0;
}
