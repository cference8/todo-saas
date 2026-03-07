<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import WorkspaceSidebar from './components/WorkspaceSidebar.vue';
import TaskPanel from './components/TaskPanel.vue';

const workspace = ref(null);
const lists = ref([]);
const tasks = ref([]);
const activeListId = ref(null);
const currentUser = ref(null);
const pending = ref(false);
const socketState = ref('connecting');
const lastEvent = ref('Waiting for first sync');
let socket;

const activeList = computed(() => lists.value.find((list) => list.id === activeListId.value) || null);
const activeTasks = computed(() => {
  return tasks.value
    .filter((task) => task.listId === activeListId.value)
    .sort((a, b) => Number(Boolean(a.completedAt)) - Number(Boolean(b.completedAt)) || b.id - a.id);
});

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      'Content-Type': 'application/json'
    },
    ...options
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || 'Request failed');
  }

  return response.status === 204 ? null : response.json();
}

function applySnapshot(snapshot) {
  workspace.value = snapshot.workspace;
  currentUser.value = snapshot.currentUser;
  lists.value = snapshot.lists;
  tasks.value = snapshot.tasks;

  const hasActive = snapshot.lists.some((list) => list.id === activeListId.value);
  activeListId.value = hasActive ? activeListId.value : snapshot.defaultListId ?? snapshot.lists[0]?.id ?? null;
  lastEvent.value = `Synced ${new Date().toLocaleTimeString()}`;
}

async function loadBootstrap() {
  const snapshot = await request('/api/bootstrap');
  applySnapshot(snapshot);
}

function connectSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;
  socketState.value = 'connecting';
  socket = new WebSocket(wsUrl);

  socket.addEventListener('open', () => {
    socketState.value = 'open';
  });

  socket.addEventListener('close', () => {
    socketState.value = 'closed';
    window.setTimeout(connectSocket, 1500);
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
        lastEvent.value = error.message;
      });
    }
  });
}

async function withPending(work) {
  pending.value = true;
  try {
    await work();
  } finally {
    pending.value = false;
  }
}

async function createList(name) {
  await withPending(async () => {
    const created = await request('/api/lists', {
      method: 'POST',
      body: JSON.stringify({ name })
    });
    activeListId.value = created.list.id;
    await loadBootstrap();
  });
}

async function deleteList(listId) {
  await withPending(async () => {
    await request(`/api/lists/${listId}`, { method: 'DELETE' });
    await loadBootstrap();
  });
}

async function createTask(title) {
  await withPending(async () => {
    await request('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ listId: activeListId.value, title })
    });
  });
}

async function toggleTask(task) {
  await withPending(async () => {
    await request(`/api/tasks/${task.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ completed: !task.completedAt })
    });
  });
}

async function deleteTask(taskId) {
  const confirmed = window.confirm('Delete this task?');
  if (!confirmed) return;

  await withPending(async () => {
    await request(`/api/tasks/${taskId}`, { method: 'DELETE' });
  });
}

onMounted(async () => {
  try {
    await loadBootstrap();
    connectSocket();
  } catch (error) {
    lastEvent.value = error.message;
  }
});

onBeforeUnmount(() => {
  if (socket) {
    socket.close();
  }
});
</script>

<template>
  <main class="app-shell">
    <section class="hero-bar panel">
      <div>
        <p class="eyebrow">SaaS-ready upgrade</p>
        <h1>{{ workspace?.name || 'Team workspace' }}</h1>
      </div>
      <div class="hero-meta">
        <span>{{ currentUser?.name || 'Guest user' }}</span>
        <span>{{ lastEvent }}</span>
      </div>
    </section>

    <section class="layout-grid">
      <WorkspaceSidebar
        :current-list-id="activeListId || 0"
        :lists="lists"
        :pending="pending"
        @select-list="activeListId = $event"
        @create-list="createList"
        @delete-list="deleteList"
      />

      <TaskPanel
        :active-list="activeList"
        :tasks="activeTasks"
        :pending="pending"
        :socket-state="socketState"
        @create-task="createTask"
        @toggle-task="toggleTask"
        @delete-task="deleteTask"
      />
    </section>
  </main>
</template>
