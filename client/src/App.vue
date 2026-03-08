<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import AuthPanel from './components/AuthPanel.vue';
import GroceryPanel from './components/GroceryPanel.vue';
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
const invites = ref([]);
const memberships = ref([]);
const activeListId = ref(null);
const currentUser = ref(null);
const pending = ref(false);
const socketState = ref('closed');
const lastEvent = ref('Sign in to load your workspace');
const errorMessage = ref('');
const authErrorMode = ref('');
const googleAuthEnabled = ref(false);
const inviteToken = ref(new URLSearchParams(window.location.search).get('invite') || '');
const inviteDetails = ref(null);
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

      if (activeList.value?.type === 'grocery') {
        return b.id - a.id;
      }

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
const hasWorkspace = computed(() => Boolean(workspaceId.value));

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
  workspaceId.value = nextWorkspaceId ? Number(nextWorkspaceId) : 0;
  localStorage.setItem(TOKEN_KEY, nextToken);
  if (nextWorkspaceId) {
    localStorage.setItem(WORKSPACE_KEY, String(nextWorkspaceId));
  } else {
    localStorage.removeItem(WORKSPACE_KEY);
  }
}

function normalizeMemberships(items = []) {
  return items.map((membership) => ({
    ...membership,
    id: Number(membership.id)
  }));
}

function clearSession() {
  token.value = '';
  workspaceId.value = 0;
  workspace.value = null;
  lists.value = [];
  tasks.value = [];
  members.value = [];
  invites.value = [];
  memberships.value = [];
  currentUser.value = null;
  activeListId.value = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(WORKSPACE_KEY);
  disconnectSocket();
}

function clearInviteState() {
  inviteToken.value = '';
  inviteDetails.value = null;
  const url = new URL(window.location.href);
  url.searchParams.delete('invite');
  window.history.replaceState({}, '', url);
}

function clearHashState() {
  if (!window.location.hash) return;

  const url = new URL(window.location.href);
  url.hash = '';
  window.history.replaceState({}, '', url);
}

function isResolvedInviteError(message) {
  return message === 'This invite has already been accepted.' || message === 'Invite not found or expired.';
}

function applySnapshot(snapshot) {
  workspace.value = snapshot.workspace;
  currentUser.value = snapshot.currentUser;
  memberships.value = normalizeMemberships(snapshot.memberships || memberships.value);
  members.value = snapshot.members || [];
  invites.value = snapshot.invites || [];
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
  authErrorMode.value = '';
  try {
    await work();
  } catch (error) {
    errorMessage.value = error.message;
  } finally {
    pending.value = false;
  }
}

async function handleAuth(payload) {
  if (payload.mode === 'validation-error') {
    errorMessage.value = payload.error || 'Please fix the form errors and try again.';
    authErrorMode.value = 'register';
    return;
  }

  await withPending(async () => {
    const endpoint = payload.mode === 'register' ? '/api/auth/register' : '/api/auth/login';
    const response = await request(endpoint, {
      method: 'POST',
      headers: {},
      body: JSON.stringify(payload)
    });

    const nextWorkspaceId = response.defaultWorkspaceId || response.workspaces?.[0]?.id;
    persistSession(response.token, nextWorkspaceId);
    memberships.value = normalizeMemberships(response.workspaces || []);
    currentUser.value = response.user;
    if (nextWorkspaceId) {
      await loadBootstrap();
      connectSocket();
    }
  }).finally(() => {
    if (errorMessage.value) {
      authErrorMode.value = payload.mode;
    }
  });
}

function startGoogleAuth() {
  errorMessage.value = '';
  authErrorMode.value = '';

  const url = new URL('/api/auth/google', window.location.origin);
  if (inviteToken.value) {
    url.searchParams.set('invite', inviteToken.value);
  }

  window.location.assign(url.toString());
}

async function switchWorkspace(nextWorkspaceId) {
  await withPending(async () => {
    workspaceId.value = Number(nextWorkspaceId);
    localStorage.setItem(WORKSPACE_KEY, String(workspaceId.value));
    await loadBootstrap();
    connectSocket();
  });
}

async function createList(payload) {
  await withPending(async () => {
    const created = await request('/api/lists', {
      method: 'POST',
      body: JSON.stringify({ name: payload.name, type: payload.type, workspaceId: workspaceId.value })
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
        quantity: payload.quantity,
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
        quantity: payload.quantity,
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

async function createInvite(email, onCreated) {
  await withPending(async () => {
    const response = await request('/api/invites', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: workspaceId.value, email })
    });
    if (typeof onCreated === 'function') {
      onCreated(response.invite.inviteUrl);
    }
    await loadBootstrap();
  });
}

async function loadInvite() {
  if (!inviteToken.value) return;

  try {
    const response = await request(`/api/invites/${inviteToken.value}`, { headers: {} });
    inviteDetails.value = {
      ...response.invite,
      token: inviteToken.value
    };
  } catch (error) {
    errorMessage.value = error.message;
    clearInviteState();
  }
}

async function loadAuthProviders() {
  try {
    const response = await request('/api/auth/providers', { headers: {} });
    googleAuthEnabled.value = Boolean(response.google?.enabled);
  } catch {
    googleAuthEnabled.value = false;
  }
}

function handleOAuthRedirectResult() {
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
  if (!hash) return;

  const params = new URLSearchParams(hash);
  const nextToken = params.get('token');
  const authError = params.get('authError');
  const authMode = params.get('authMode');

  if (nextToken) {
    persistSession(nextToken, 0);
    errorMessage.value = '';
    authErrorMode.value = '';
  } else if (authError) {
    errorMessage.value = authError;
    authErrorMode.value = authMode || 'google';
  }

  clearHashState();
}

async function acceptInvite() {
  if (!inviteToken.value || !token.value) return;

  try {
    await withPending(async () => {
      const response = await request('/api/invites/accept', {
        method: 'POST',
        body: JSON.stringify({ inviteToken: inviteToken.value })
      });

      workspaceId.value = Number(response.workspaceId);
      localStorage.setItem(WORKSPACE_KEY, String(workspaceId.value));
      await loadBootstrap();
      connectSocket();
      clearInviteState();
    });
  } finally {
    if (inviteDetails.value && isResolvedInviteError(errorMessage.value)) {
      clearInviteState();

      if (!workspaceId.value && memberships.value.length) {
        workspaceId.value = Number(memberships.value[0].id);
        localStorage.setItem(WORKSPACE_KEY, String(workspaceId.value));
        await loadBootstrap();
        connectSocket();
      }

      errorMessage.value = '';
    }
  }
}

async function restoreSession() {
  if (!token.value) return;

  try {
    const session = await request('/api/auth/session');
    memberships.value = normalizeMemberships(session.workspaces || []);
    currentUser.value = session.user;

    const nextWorkspaceId = workspaceId.value || session.defaultWorkspaceId || session.workspaces?.[0]?.id || 0;
    if (!nextWorkspaceId) {
      localStorage.removeItem(WORKSPACE_KEY);
      workspaceId.value = 0;
      return;
    }

    workspaceId.value = Number(nextWorkspaceId);
    localStorage.setItem(WORKSPACE_KEY, String(workspaceId.value));
    await loadBootstrap();
    connectSocket();
  } catch (error) {
    errorMessage.value = error.message;
    clearSession();
    return;
  }
}

onMounted(() => {
  handleOAuthRedirectResult();
  loadAuthProviders();
  loadInvite();
  restoreSession();
});

onBeforeUnmount(() => {
  disconnectSocket();
});
</script>

<template>
  <main class="app-shell">
    <template v-if="!isAuthenticated">
      <AuthPanel
        :invite="inviteDetails"
        :google-enabled="googleAuthEnabled"
        :error-message="errorMessage"
        :error-for-mode="authErrorMode"
        :pending="pending"
        @google="startGoogleAuth"
        @submit="handleAuth"
      />
    </template>

    <template v-else>
      <section class="hero-bar panel">
        <div>
          <p class="eyebrow">{{ inviteDetails ? 'Workspace invitation' : 'Authenticated workspace' }}</p>
          <h1>{{ inviteDetails?.workspaceName || workspace?.name || 'Team workspace' }}</h1>
        </div>
        <div class="hero-meta">
          <span>{{ currentUser?.name || 'Unknown user' }}</span>
          <span>{{ lastEvent }}</span>
        </div>
      </section>

      <section v-if="inviteDetails" class="panel invite-accept-panel">
        <div>
          <p class="eyebrow">Pending invite</p>
          <h2>Join {{ inviteDetails.workspaceName }}</h2>
          <p class="subtle">Signed in as {{ currentUser?.email }}. Accept the invite to join this workspace.</p>
          <p v-if="errorMessage" class="form-error">{{ errorMessage }}</p>
        </div>
        <button class="ghost-button" :disabled="pending" @click="acceptInvite">Accept invite</button>
      </section>

      <p v-else-if="errorMessage" class="error-banner">{{ errorMessage }}</p>

      <section v-if="hasWorkspace" class="layout-grid three-up">
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
          v-if="activeList?.type !== 'grocery'"
          :active-list="activeList"
          :tasks="activeTasks"
          :pending="pending"
          :socket-state="socketState"
          @create-task="createTask"
          @save-task="saveTask"
          @toggle-task="toggleTask"
          @delete-task="deleteTask"
        />

        <GroceryPanel
          v-else
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
          :invites="invites"
          :members="members"
          :role="currentMembership?.role || 'member'"
          :pending="pending"
          @create-invite="createInvite"
          @logout="clearSession"
        />
      </section>
    </template>
  </main>
</template>
