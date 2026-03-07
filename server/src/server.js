import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import { WebSocketServer } from 'ws';
import { issueAuthToken, verifyAuthToken } from './auth.js';
import {
  acceptInviteForUser,
  authenticateUser,
  createList,
  createTask,
  createWorkspaceInvite,
  deleteList,
  deleteTask,
  ensureMembership,
  getInviteByToken,
  getSnapshot,
  initDb,
  registerUser,
  updateTask
} from './db.js';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const port = Number(process.env.PORT || 3001);
const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDistPath = path.resolve(__dirname, '../../client/dist');
const socketGroups = new Map();

app.use(cors({ origin: clientOrigin, credentials: true }));
app.use(express.json());

function sendError(res, error) {
  const status = error.status || 500;
  res.status(status).json({ error: error.message || 'Internal server error.' });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }

  try {
    req.auth = verifyAuthToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

async function requireWorkspace(req, res, next) {
  const workspaceId = Number(req.headers['x-workspace-id'] || req.query.workspaceId || req.body?.workspaceId);
  if (!workspaceId) {
    res.status(400).json({ error: 'workspaceId is required.' });
    return;
  }

  const membership = await ensureMembership(req.auth.userId, workspaceId);
  if (!membership) {
    res.status(403).json({ error: 'You do not have access to this workspace.' });
    return;
  }

  req.workspaceId = workspaceId;
  req.membership = membership;
  next();
}

function broadcastToWorkspace(workspaceId, action, details = {}) {
  const clients = socketGroups.get(String(workspaceId));
  if (!clients?.size) return;

  const payload = JSON.stringify({
    type: 'event',
    data: {
      action,
      details,
      sentAt: new Date().toISOString()
    }
  });

  for (const client of clients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}

function attachSocketToWorkspace(workspaceId, socket) {
  const key = String(workspaceId);
  const group = socketGroups.get(key) || new Set();
  group.add(socket);
  socketGroups.set(key, group);

  socket.on('close', () => {
    group.delete(socket);
    if (!group.size) {
      socketGroups.delete(key);
    }
  });
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim();
    const password = String(req.body.password || '');
    const workspaceName = String(req.body.workspaceName || '').trim();
    const inviteToken = req.body.inviteToken ? String(req.body.inviteToken) : null;

    if (!name || !email || !password || (!inviteToken && !workspaceName)) {
      res.status(400).json({ error: 'name, email, password, and workspaceName are required unless joining by invite.' });
      return;
    }

    const { user, workspace, workspaces } = await registerUser({ name, email, password, workspaceName, inviteToken });
    const token = issueAuthToken({ userId: user.id, email: user.email });
    res.status(201).json({ token, user, workspaces, defaultWorkspaceId: workspace.id });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim();
    const password = String(req.body.password || '');
    const inviteToken = req.body.inviteToken ? String(req.body.inviteToken) : null;
    if (!email || !password) {
      res.status(400).json({ error: 'email and password are required.' });
      return;
    }

    const authResult = await authenticateUser({ email, password, inviteToken });
    const token = issueAuthToken({ userId: authResult.user.id, email: authResult.user.email });
    res.json({ token, user: authResult.user, workspaces: authResult.workspaces, defaultWorkspaceId: authResult.defaultWorkspaceId });
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/bootstrap', requireAuth, async (req, res) => {
  try {
    const workspaceId = Number(req.query.workspaceId);
    if (!workspaceId) {
      res.status(400).json({ error: 'workspaceId is required.' });
      return;
    }

    const snapshot = await getSnapshot({ userId: req.auth.userId, workspaceId });
    res.json(snapshot);
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/invites/:token', async (req, res) => {
  try {
    const invite = await getInviteByToken(String(req.params.token || ''));
    if (!invite) {
      res.status(404).json({ error: 'Invite not found or expired.' });
      return;
    }

    res.json({
      invite: {
        email: invite.email,
        role: invite.role,
        workspaceId: invite.workspaceId,
        workspaceName: invite.workspaceName,
        workspaceSlug: invite.workspaceSlug,
        expiresAt: invite.expiresAt
      }
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/invites', requireAuth, requireWorkspace, async (req, res) => {
  try {
    if (req.membership.role !== 'owner') {
      res.status(403).json({ error: 'Only workspace owners can create invites.' });
      return;
    }

    const email = String(req.body.email || '').trim();
    if (!email) {
      res.status(400).json({ error: 'email is required.' });
      return;
    }

    const invite = await createWorkspaceInvite({ workspaceId: req.workspaceId, userId: req.auth.userId, email });
    const baseUrl = String(req.headers.origin || process.env.CLIENT_ORIGIN || clientOrigin);
    const inviteUrl = new URL(baseUrl);
    inviteUrl.searchParams.set('invite', invite.token);

    broadcastToWorkspace(req.workspaceId, 'invite.created', { email: invite.email });
    res.status(201).json({
      invite: {
        id: invite.id,
        email: invite.email,
        role: invite.role,
        createdAt: invite.createdAt,
        expiresAt: invite.expiresAt,
        inviteUrl: inviteUrl.toString()
      }
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/invites/accept', requireAuth, async (req, res) => {
  try {
    const inviteToken = String(req.body.inviteToken || '').trim();
    if (!inviteToken) {
      res.status(400).json({ error: 'inviteToken is required.' });
      return;
    }

    const workspaceId = await acceptInviteForUser({
      inviteToken,
      userId: req.auth.userId,
      email: req.auth.email
    });

    res.status(201).json({ workspaceId });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/lists', requireAuth, requireWorkspace, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) {
      res.status(400).json({ error: 'List name is required.' });
      return;
    }

    const list = await createList({ workspaceId: req.workspaceId, userId: req.auth.userId, name });
    broadcastToWorkspace(req.workspaceId, 'list.created', { listId: list.id });
    res.status(201).json({ list });
  } catch (error) {
    sendError(res, error);
  }
});

app.delete('/api/lists/:id', requireAuth, requireWorkspace, async (req, res) => {
  try {
    const removed = await deleteList({ workspaceId: req.workspaceId, listId: Number(req.params.id) });
    if (!removed.ok) {
      if (removed.reason === 'last-list') {
        res.status(400).json({ error: 'You must keep at least one list in the workspace.' });
        return;
      }

      res.status(404).json({ error: 'List not found.' });
      return;
    }

    broadcastToWorkspace(req.workspaceId, 'list.deleted', { listId: Number(req.params.id) });
    res.status(204).end();
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/tasks', requireAuth, requireWorkspace, async (req, res) => {
  try {
    const listId = Number(req.body.listId);
    const title = String(req.body.title || '').trim();
    const description = String(req.body.description || '').trim();
    const dueDate = req.body.dueDate ? String(req.body.dueDate) : null;
    const priority = String(req.body.priority || 'medium').trim().toLowerCase();
    if (!listId || !title) {
      res.status(400).json({ error: 'listId and title are required.' });
      return;
    }

    if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      res.status(400).json({ error: 'dueDate must be in YYYY-MM-DD format.' });
      return;
    }

    if (!['low', 'medium', 'high'].includes(priority)) {
      res.status(400).json({ error: 'priority must be low, medium, or high.' });
      return;
    }

    const task = await createTask({ workspaceId: req.workspaceId, userId: req.auth.userId, listId, title, description, dueDate, priority });
    if (!task) {
      res.status(404).json({ error: 'List not found.' });
      return;
    }

    broadcastToWorkspace(req.workspaceId, 'task.created', { taskId: task.id, listId });
    res.status(201).json({ task });
  } catch (error) {
    sendError(res, error);
  }
});

app.patch('/api/tasks/:id', requireAuth, requireWorkspace, async (req, res) => {
  try {
    const hasOwn = (key) => Object.prototype.hasOwnProperty.call(req.body, key);
    const titleProvided = hasOwn('title');
    const descriptionProvided = hasOwn('description');
    const dueDateProvided = hasOwn('dueDate');
    const priorityProvided = hasOwn('priority');
    const completedProvided = hasOwn('completed');

    const title = titleProvided ? String(req.body.title || '').trim() : undefined;
    const description = descriptionProvided ? String(req.body.description || '').trim() : undefined;
    const dueDate = dueDateProvided ? (req.body.dueDate ? String(req.body.dueDate) : null) : undefined;
    const priority = priorityProvided ? String(req.body.priority || '').trim().toLowerCase() : undefined;
    const completed = completedProvided ? Boolean(req.body.completed) : undefined;

    if (!titleProvided && !descriptionProvided && !dueDateProvided && !priorityProvided && !completedProvided) {
      res.status(400).json({ error: 'No task changes were provided.' });
      return;
    }

    if (titleProvided && !title) {
      res.status(400).json({ error: 'title cannot be empty.' });
      return;
    }

    if (dueDateProvided && dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      res.status(400).json({ error: 'dueDate must be in YYYY-MM-DD format.' });
      return;
    }

    if (priorityProvided && !['low', 'medium', 'high'].includes(priority)) {
      res.status(400).json({ error: 'priority must be low, medium, or high.' });
      return;
    }

    const updated = await updateTask({
      workspaceId: req.workspaceId,
      userId: req.auth.userId,
      taskId: Number(req.params.id),
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
    });

    if (!updated) {
      res.status(404).json({ error: 'Task not found.' });
      return;
    }

    broadcastToWorkspace(req.workspaceId, 'task.updated', { taskId: Number(req.params.id) });
    res.status(204).end();
  } catch (error) {
    sendError(res, error);
  }
});

app.delete('/api/tasks/:id', requireAuth, requireWorkspace, async (req, res) => {
  try {
    const removed = await deleteTask({ workspaceId: req.workspaceId, taskId: Number(req.params.id) });
    if (!removed) {
      res.status(404).json({ error: 'Task not found.' });
      return;
    }

    broadcastToWorkspace(req.workspaceId, 'task.deleted', { taskId: Number(req.params.id) });
    res.status(204).end();
  } catch (error) {
    sendError(res, error);
  }
});

app.use(express.static(clientDistPath));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDistPath, 'index.html'));
});

server.on('upgrade', async (request, socket, head) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    const token = url.searchParams.get('token');
    const workspaceId = Number(url.searchParams.get('workspaceId'));
    if (!token || !workspaceId) {
      socket.destroy();
      return;
    }

    const auth = verifyAuthToken(token);
    const membership = await ensureMembership(auth.userId, workspaceId);
    if (!membership) {
      socket.destroy();
      return;
    }

    request.auth = auth;
    request.workspaceId = workspaceId;

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } catch {
    socket.destroy();
  }
});

wss.on('connection', async (socket, request) => {
  attachSocketToWorkspace(request.workspaceId, socket);
  const snapshot = await getSnapshot({ userId: request.auth.userId, workspaceId: request.workspaceId });
  socket.send(JSON.stringify({ type: 'snapshot', data: snapshot }));
});

initDb()
  .then(() => {
    server.listen(port, () => {
      console.log(`Todo SaaS server listening on http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize database', error);
    process.exit(1);
  });
