import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import { WebSocketServer } from 'ws';
import {
  createList,
  createTask,
  deleteList,
  deleteTask,
  getSnapshot,
  setTaskCompletion
} from './db.js';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const port = Number(process.env.PORT || 3001);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDistPath = path.resolve(__dirname, '../../client/dist');

app.use(cors());
app.use(express.json());

function broadcast(action, details = {}) {
  const payload = JSON.stringify({
    type: 'event',
    data: {
      action,
      details,
      sentAt: new Date().toISOString()
    }
  });

  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/bootstrap', (_req, res) => {
  res.json(getSnapshot());
});

app.post('/api/lists', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) {
    res.status(400).json({ error: 'List name is required.' });
    return;
  }

  const list = createList(name);
  broadcast('list.created', { listId: list.id });
  res.status(201).json({ list });
});

app.delete('/api/lists/:id', (req, res) => {
  const removed = deleteList(Number(req.params.id));
  if (!removed.ok) {
    if (removed.reason === 'last-list') {
      res.status(400).json({ error: 'You must keep at least one list in the workspace.' });
      return;
    }

    res.status(404).json({ error: 'List not found.' });
    return;
  }

  broadcast('list.deleted', { listId: Number(req.params.id) });
  res.status(204).end();
});

app.post('/api/tasks', (req, res) => {
  const listId = Number(req.body.listId);
  const title = String(req.body.title || '').trim();

  if (!listId || !title) {
    res.status(400).json({ error: 'listId and title are required.' });
    return;
  }

  const task = createTask(listId, title);
  if (!task) {
    res.status(404).json({ error: 'List not found.' });
    return;
  }

  broadcast('task.created', { taskId: task.id, listId });
  res.status(201).json({ task });
});

app.patch('/api/tasks/:id', (req, res) => {
  const updated = setTaskCompletion(Number(req.params.id), Boolean(req.body.completed));
  if (!updated) {
    res.status(404).json({ error: 'Task not found.' });
    return;
  }

  broadcast('task.updated', { taskId: Number(req.params.id) });
  res.status(204).end();
});

app.delete('/api/tasks/:id', (req, res) => {
  const removed = deleteTask(Number(req.params.id));
  if (!removed) {
    res.status(404).json({ error: 'Task not found.' });
    return;
  }

  broadcast('task.deleted', { taskId: Number(req.params.id) });
  res.status(204).end();
});

app.use(express.static(clientDistPath));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDistPath, 'index.html'));
});

wss.on('connection', (socket) => {
  socket.send(
    JSON.stringify({
      type: 'snapshot',
      data: getSnapshot()
    })
  );
});

server.listen(port, () => {
  console.log(`Todo SaaS server listening on http://localhost:${port}`);
});
