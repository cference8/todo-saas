<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import AuthPanel from './components/AuthPanel.vue';
import MemberPanel from './components/MemberPanel.vue';
import TaskPanel from './components/TaskPanel.vue';
import WorkspaceSidebar from './components/WorkspaceSidebar.vue';

const TOKEN_KEY = 'todo-saas-token';
const WORKSPACE_KEY = 'todo-saas-workspace-id';

const token = ref(localStorage.getItem(TOKEN_KEY) || '');
const workspaceId = ref(Number(localStorage.getItem(WORKSPACE_KEY)) || 0);
const workspace = ref(null);
const lists = ref([]);
const tasks = ref([]);
const members = ref([]);
const memberships = ref([]);
const activeListId = ref(null);
const currentUser = ref(null);
const pending = ref(false);
const socketState = ref('closed');
const lastEvent = ref('Sign in to load your workspace');
const errorMessage = ref('');
let socket;
let reconnectTimer;
let allowReconnect = true;

const activeList = computed(() => lists.value.find((list) => list.id === activeListId.value) || null);
const activeTasks = computed(() => {
  const priorityWeight = { high: 0, medium: 1, low: 2 };
  return tasks.value
    .filter((task) => task.listId === activeListId.value)
    .sort((a, b) => {
      const completionOrder = Number(Boolean(a.completedAt)) - Number(Boolean(b.completedAt));
      if (completionOrder !== 0) return completionOrder;

      const dueA = a.dueDate ? new Date(`${a.dueDate}T00:00:00`).getTime() : Number.POSITIVE_INFINITY;
      const dueB = b.dueDate ? new Date(`${b.dueDate}T00:00:00`).getTime() : Number.POSITIVE_INFINITY;
      if (dueA !== dueB) return dueA - dueB;

      const priorityOrder = (priorityWeight[a.priority] ?? 1) - (priorityWeight[b.priority] ?? 1);
      if (priorityOrder !== 0) return priorityOrder;

      return b.id - a.id;
    });
});
const currentMembership = computed(() => memberships.value.find((item) => item.id === workspaceId.value) || null);
const isAuthenticated = computed(() => Boolean(token.value));

async function request(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  if (token.value) {
    headers.Authorization = `Bearer ${token.value}`;
  }

  if (workspaceId.value && !headers['x-workspace-id']) {
    headers['x-workspace-id'] = String(workspaceId.value);
  }

  const response = await fetch(path, {
    ...options,
    headers
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || 'Request failed');
  }

  return response.status === 204 ? null : response.json();
}

function persistSession(nextToken, nextWorkspaceId) {
  token.value = nextToken;
  workspaceId.value = Number(nextWorkspaceId);
  localStorage.setItem(TOKEN_KEY, nextToken);
  localStorage.setItem(WORKSPACE_KEY, String(nextWorkspaceId));
}

function clearSession() {
  token.value = '';
  workspaceId.value = 0;
  workspace.value = null;
  lists.value = [];
  tasks.value = [];
  members.value = [];
  memberships.value = [];
  currentUser.value = null;
  activeListId.value = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(WORKSPACE_KEY);
  disconnectSocket();
}

function applySnapshot(snapshot) {
  workspace.value = snapshot.workspace;
  currentUser.value = snapshot.currentUser;
  memberships.value = snapshot.memberships || memberships.value;
  members.value = snapshot.members || [];
  lists.value = snapshot.lists || [];
  tasks.value = snapshot.tasks || [];

  const hasActive = snapshot.lists.some((list) => list.id === activeListId.value);
  activeListId.value = hasActive ? activeListId.value : snapshot.defaultListId ?? snapshot.lists[0]?.id ?? null;
  lastEvent.value = `Synced ${new Date().toLocaleTimeString()}`;
  errorMessage.value = '';
}

async function loadBootstrap() {
  const snapshot = await request(`/api/bootstrap?workspaceId=${workspaceId.value}`);
  applySnapshot(snapshot);
}

function disconnectSocket() {
  allowReconnect = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  if (socket) {
    socket.close();
    socket = undefined;
  }
  socketState.value = 'closed';
}

function connectSocket() {
  if (!token.value || !workspaceId.value) return;

  allowReconnect = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  if (socket) {
    socket.close();
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token.value)}&workspaceId=${workspaceId.value}`;
  socketState.value = 'connecting';
  socket = new WebSocket(wsUrl);

  socket.addEventListener('open', () => {
    socketState.value = 'open';
  });

  socket.addEventListener('close', () => {
    socketState.value = 'closed';
    if (allowReconnect) {
      reconnectTimer = window.setTimeout(connectSocket, 1500);
    }
  });

  socket.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === 'snapshot') {
      applySnapshot(payload.data);
      return;
    }

    if (payload.type === 'event') {
      lastEvent.value = `${payload.data.action} • ${new Date(payload.data.sentAt).toLocaleTimeString()}`;
      loadBootstrap().catch((error) => {
        errorMessage.value = error.message;
      });
    }
  });
}

async function withPending(work) {
  pending.value = true;
  errorMessage.value = '';
  try {
    await work();
  } catch (error) {
    errorMessage.value = error.message;
    throw error;
  } finally {
    pending.value = false;
  }
}

async function handleAuth(payload) {
  await withPending(async () => {
    const endpoint = payload.mode === 'register' ? '/api/auth/register' : '/api/auth/login';
    const response = await request(endpoint, {
      method: 'POST',
      headers: {},
      body: JSON.stringify(payload)
    });

    const nextWorkspaceId = response.defaultWorkspaceId || response.workspaces?.[0]?.id;
    persistSession(response.token, nextWorkspaceId);
    memberships.value = response.workspaces || [];
    currentUser.value = response.user;
    await loadBootstrap();
    connectSocket();
  });
}

async function switchWorkspace(nextWorkspaceId) {
  await withPending(async () => {
    workspaceId.value = Number(nextWorkspaceId);
    localStorage.setItem(WORKSPACE_KEY, String(workspaceId.value));
    await loadBootstrap();
    connectSocket();
  });
}

async function createList(name) {
  await withPending(async () => {
    const created = await request('/api/lists', {
      method: 'POST',
      body: JSON.stringify({ name, workspaceId: workspaceId.value })
    });
    activeListId.value = created.list.id;
    await loadBootstrap();
  });
}

async function deleteList(listId) {
  await withPending(async () => {
    await request(`/api/lists/${listId}`, {
      method: 'DELETE',
      body: JSON.stringify({ workspaceId: workspaceId.value })
    });
    await loadBootstrap();
  });
}

async function createTask(payload) {
  await withPending(async () => {
    await request('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: workspaceId.value,
        listId: activeListId.value,
        title: payload.title,
        description: payload.description,
        dueDate: payload.dueDate,
        priority: payload.priority
      })
    });
    await loadBootstrap();
  });
}

async function toggleTask(task) {
  await withPending(async () => {
    await request(`/api/tasks/${task.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ workspaceId: workspaceId.value, completed: !task.completedAt })
    });
    await loadBootstrap();
  });
}

async function saveTask(taskId, payload) {
  await withPending(async () => {
    await request(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        title: payload.title,
        description: payload.description,
        dueDate: payload.dueDate,
        priority: payload.priority
      })
    });
    await loadBootstrap();
  });
}

async function deleteTask(taskId) {
  const confirmed = window.confirm('Delete this task?');
  if (!confirmed) return;

  await withPending(async () => {
    await request(`/api/tasks/${taskId}`, {
      method: 'DELETE',
      body: JSON.stringify({ workspaceId: workspaceId.value })
    });
    await loadBootstrap();
  });
}

async function addMember(email) {
  await withPending(async () => {
    await request('/api/members', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: workspaceId.value, email })
    });
    await loadBootstrap();
  });
}

async function restoreSession() {
  if (!token.value || !workspaceId.value) return;

  try {
    await loadBootstrap();
    connectSocket();
  } catch (error) {
    errorMessage.value = error.message;
    clearSession();
  }
}

onMounted(() => {
  restoreSession();
});

onBeforeUnmount(() => {
  disconnectSocket();
});
</script>

<template>
  <main class="app-shell">
    <template v-if="!isAuthenticated">
      <AuthPanel @submit="handleAuth" />
    </template>

    <template v-else>
      <section class="hero-bar panel">
        <div>
          <p class="eyebrow">Authenticated workspace</p>
          <h1>{{ workspace?.name || 'Team workspace' }}</h1>
        </div>
        <div class="hero-meta">
          <span>{{ currentUser?.name || 'Unknown user' }}</span>
          <span>{{ lastEvent }}</span>
        </div>
      </section>

      <p v-if="errorMessage" class="error-banner">{{ errorMessage }}</p>

      <section class="layout-grid three-up">
        <WorkspaceSidebar
          :current-list-id="activeListId || 0"
          :lists="lists"
          :memberships="memberships"
          :workspace-id="workspaceId || 0"
          :pending="pending"
          @select-list="activeListId = $event"
          @create-list="createList"
          @delete-list="deleteList"
          @select-workspace="switchWorkspace"
        />

        <TaskPanel
          :active-list="activeList"
          :tasks="activeTasks"
          :pending="pending"
          :socket-state="socketState"
          @create-task="createTask"
          @save-task="saveTask"
          @toggle-task="toggleTask"
          @delete-task="deleteTask"
        />

        <MemberPanel
          :current-user="currentUser"
          :members="members"
          :role="currentMembership?.role || 'member'"
          :pending="pending"
          @add-member="addMember"
          @logout="clearSession"
        />
      </section>
    </template>
  </main>
</template>
