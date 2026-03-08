<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AuthPanel from './components/AuthPanel.vue';
import GroceryPanel from './components/GroceryPanel.vue';
import ListSidebar from './components/ListSidebar.vue';
import TaskPanel from './components/TaskPanel.vue';
import WorkspaceSidebar from './components/WorkspaceSidebar.vue';

const TOKEN_KEY = 'todo-saas-token';
const WORKSPACE_KEY = 'todo-saas-workspace-id';
const THEME_KEY = 'todo-saas-theme';
const DEFAULT_LAST_EVENT = 'Sign in to load your workspace';
const NO_WORKSPACE_LAST_EVENT = 'Create or join a workspace to keep going.';
const INVITE_READY_LAST_EVENT = 'Invitation ready to review.';
const WORKSPACE_LOADING_LAST_EVENT = 'Loading your workspace...';

const token = ref(localStorage.getItem(TOKEN_KEY) || '');
const workspaceId = ref(Number(localStorage.getItem(WORKSPACE_KEY)) || 0);
const theme = ref(resolveInitialTheme());
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
const lastEvent = ref(DEFAULT_LAST_EVENT);
const errorMessage = ref('');
const authErrorMode = ref('');
const googleAuthEnabled = ref(false);
const appleAuthEnabled = ref(false);
const inviteToken = ref(new URLSearchParams(window.location.search).get('invite') || '');
const inviteDetails = ref(null);
const pendingInvites = ref([]);
const revokedWorkspaceId = ref(0);
const noWorkspaceName = ref('');
const deleteTaskTarget = ref(null);
const boardPanelRef = ref(null);
const listPanelRef = ref(null);
let socket;
let reconnectTimer;
let allowReconnect = true;

const activeList = computed(() => lists.value.find((list) => list.id === activeListId.value) || null);

function parseDueDate(value) {
  if (!value) return Number.POSITIVE_INFINITY;
  const normalized = String(value).slice(0, 10);
  const timestamp = new Date(`${normalized}T00:00:00`).getTime();
  return Number.isNaN(timestamp) ? Number.POSITIVE_INFINITY : timestamp;
}

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

      const dueA = parseDueDate(a.dueDate);
      const dueB = parseDueDate(b.dueDate);
      if (dueA !== dueB) return dueA - dueB;

      const priorityOrder = (priorityWeight[a.priority] ?? 1) - (priorityWeight[b.priority] ?? 1);
      if (priorityOrder !== 0) return priorityOrder;

      return b.id - a.id;
    });
});
const currentMembership = computed(() => memberships.value.find((item) => item.id === workspaceId.value) || null);
const isAuthenticated = computed(() => Boolean(token.value));
const hasWorkspace = computed(() => Boolean(workspaceId.value));
const memberCount = computed(() => members.value.length);
const ownerCount = computed(() => members.value.filter((member) => member.role === 'owner').length);
const heroEyebrow = computed(() => {
  if (inviteToken.value) return 'Workspace invitation';
  if (!hasWorkspace.value && inviteDetails.value) return 'Pending invitation';
  return 'Authenticated workspace';
});
const heroTitle = computed(() => {
  if ((inviteToken.value || !hasWorkspace.value) && inviteDetails.value?.workspaceName) {
    return inviteDetails.value.workspaceName;
  }

  return workspace.value?.name || inviteDetails.value?.workspaceName || 'Team workspace';
});
const heroStatus = computed(() => {
  if (lastEvent.value && lastEvent.value !== DEFAULT_LAST_EVENT) {
    return lastEvent.value;
  }

  if (!isAuthenticated.value) return DEFAULT_LAST_EVENT;
  if (inviteDetails.value) return INVITE_READY_LAST_EVENT;
  if (!hasWorkspace.value) return NO_WORKSPACE_LAST_EVENT;
  return WORKSPACE_LOADING_LAST_EVENT;
});

function isMobileViewport() {
  return window.matchMedia?.('(max-width: 720px)').matches ?? window.innerWidth <= 720;
}

function scrollToPanel(panelRef) {
  panelRef.value?.scrollIntoView({
    behavior: 'smooth',
    block: 'start'
  });
}

function scrollToLists() {
  if (!isMobileViewport()) return;
  scrollToPanel(listPanelRef);
}

async function handleSelectList(listId) {
  activeListId.value = listId ?? null;
  await nextTick();
  if (isMobileViewport()) {
    scrollToPanel(boardPanelRef);
  }
}

watch(
  theme,
  (nextTheme) => {
    localStorage.setItem(THEME_KEY, nextTheme);
    document.documentElement.dataset.theme = nextTheme;
  },
  { immediate: true }
);

function resolveInitialTheme() {
  const storedTheme = localStorage.getItem(THEME_KEY);
  if (storedTheme === 'light' || storedTheme === 'dark') {
    return storedTheme;
  }

  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function setTheme(nextTheme) {
  if (nextTheme !== 'light' && nextTheme !== 'dark') return;
  theme.value = nextTheme;
}

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

function normalizePendingInvites(items = []) {
  return items.map((invite) => ({
    ...invite,
    id: Number(invite.id),
    workspaceId: Number(invite.workspaceId)
  }));
}

function syncVisibleInvite() {
  if (inviteToken.value) return;
  inviteDetails.value = pendingInvites.value[0] || null;
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
  pendingInvites.value = [];
  syncVisibleInvite();
  currentUser.value = null;
  activeListId.value = null;
  lastEvent.value = DEFAULT_LAST_EVENT;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(WORKSPACE_KEY);
  disconnectSocket();
}

function clearInviteState() {
  inviteToken.value = '';
  inviteDetails.value = null;
  syncVisibleInvite();
  const url = new URL(window.location.href);
  url.searchParams.delete('invite');
  window.history.replaceState({}, '', url);
}

function openDeleteTaskModal(task) {
  if (!task?.id) return;
  deleteTaskTarget.value = {
    id: Number(task.id),
    title: task.title || 'this item',
    kind: activeList.value?.type === 'grocery' ? 'item' : 'task'
  };
}

function closeDeleteTaskModal() {
  deleteTaskTarget.value = null;
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

function clearWorkspaceState() {
  workspace.value = null;
  lists.value = [];
  tasks.value = [];
  members.value = [];
  invites.value = [];
  activeListId.value = null;
}

async function applyWorkspaceMembershipUpdate({ workspaces = [], preferredWorkspaceId = 0, statusMessage = '' }) {
  disconnectSocket();

  const nextMemberships = normalizeMemberships(workspaces);
  memberships.value = nextMemberships;

  const preferredId = Number(preferredWorkspaceId) || 0;
  const hasPreferredWorkspace = preferredId && nextMemberships.some((membership) => membership.id === preferredId);
  const nextWorkspaceId = hasPreferredWorkspace ? preferredId : nextMemberships[0]?.id || 0;

  if (!nextWorkspaceId) {
    workspaceId.value = 0;
    revokedWorkspaceId.value = 0;
    localStorage.removeItem(WORKSPACE_KEY);
    clearWorkspaceState();
    lastEvent.value = statusMessage || NO_WORKSPACE_LAST_EVENT;
    return;
  }

  workspaceId.value = Number(nextWorkspaceId);
  revokedWorkspaceId.value = 0;
  localStorage.setItem(WORKSPACE_KEY, String(workspaceId.value));
  await loadBootstrap();
  connectSocket();
  if (statusMessage) {
    lastEvent.value = statusMessage;
  }
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
  const nextSocket = new WebSocket(wsUrl);
  socket = nextSocket;

  nextSocket.addEventListener('open', () => {
    if (socket !== nextSocket) return;
    socketState.value = 'open';
  });

  nextSocket.addEventListener('close', () => {
    const isCurrentSocket = socket === nextSocket;
    if (isCurrentSocket) {
      socket = undefined;
    }
    socketState.value = 'closed';
    if (!isCurrentSocket) return;
    if (allowReconnect) {
      reconnectTimer = window.setTimeout(connectSocket, 1500);
    }
  });

  nextSocket.addEventListener('message', (event) => {
    if (socket !== nextSocket) return;
    const payload = JSON.parse(event.data);
    if (payload.type === 'snapshot') {
      applySnapshot(payload.data);
      return;
    }

    if (payload.type === 'access_revoked') {
      handleWorkspaceRevoked(payload.data);
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

async function syncSessionAfterWorkspaceLoss(message) {
  disconnectSocket();

  try {
    const session = await request('/api/auth/session');
    currentUser.value = session.user;
    pendingInvites.value = normalizePendingInvites(session.pendingInvites || []);
    syncVisibleInvite();
    await applyWorkspaceMembershipUpdate({
      workspaces: session.workspaces || [],
      preferredWorkspaceId: session.defaultWorkspaceId || session.workspaces?.[0]?.id || 0,
      statusMessage: message
    });
    errorMessage.value = '';
  } catch (error) {
    errorMessage.value = error.message || message;
    clearSession();
  }
}

function handleWorkspaceRevoked(payload = {}) {
  const revokedId = Number(payload.workspaceId || workspaceId.value);
  revokedWorkspaceId.value = revokedId;

  if (workspaceId.value === revokedId) {
    workspaceId.value = 0;
    localStorage.removeItem(WORKSPACE_KEY);
    clearWorkspaceState();
  }

  syncSessionAfterWorkspaceLoss(payload.reason || 'Your access to this workspace was revoked.');
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
    await restoreSession();
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

function startAppleAuth() {
  errorMessage.value = '';
  authErrorMode.value = '';

  const url = new URL('/api/auth/apple', window.location.origin);
  if (inviteToken.value) {
    url.searchParams.set('invite', inviteToken.value);
  }

  window.location.assign(url.toString());
}

async function switchWorkspace(nextWorkspaceId) {
  await withPending(async () => {
    await applyWorkspaceMembershipUpdate({
      workspaces: memberships.value,
      preferredWorkspaceId: Number(nextWorkspaceId)
    });
  });
}

async function updateProfile(payload, onCompleted, onFailed) {
  pending.value = true;
  errorMessage.value = '';
  authErrorMode.value = '';

  try {
    const response = await request('/api/auth/profile', {
      method: 'PATCH',
      body: JSON.stringify({
        name: payload.name,
        currentPassword: payload.currentPassword || '',
        newPassword: payload.newPassword || ''
      })
    });

    currentUser.value = response.user;
    memberships.value = normalizeMemberships(response.workspaces || memberships.value);
    pendingInvites.value = normalizePendingInvites(response.pendingInvites || pendingInvites.value);
    syncVisibleInvite();

    if (workspaceId.value) {
      await loadBootstrap();
    }

    lastEvent.value = 'Profile updated.';

    if (typeof onCompleted === 'function') {
      onCompleted(response.user);
    }
  } catch (error) {
    if (typeof onFailed === 'function') {
      onFailed(error.message);
    } else {
      errorMessage.value = error.message;
    }
  } finally {
    pending.value = false;
  }
}

async function createWorkspace(name) {
  const workspaceName = String(name || '').trim();
  if (!workspaceName) {
    errorMessage.value = 'Workspace name is required.';
    return;
  }

  await withPending(async () => {
    const response = await request('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: workspaceName })
    });

    await applyWorkspaceMembershipUpdate({
      workspaces: response.workspaces || [],
      preferredWorkspaceId: response.workspace?.id || response.defaultWorkspaceId || 0,
      statusMessage: `${workspaceName} is ready.`
    });
    noWorkspaceName.value = '';
  });
}

async function renameWorkspace(name) {
  const workspaceName = String(name || '').trim();
  if (!workspaceName) {
    errorMessage.value = 'Workspace name is required.';
    return;
  }

  if (!workspaceId.value) {
    errorMessage.value = 'No active workspace selected.';
    return;
  }

  await withPending(async () => {
    const response = await request(`/api/workspaces/${workspaceId.value}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: workspaceName })
    });

    await loadBootstrap();
    lastEvent.value = `${response.workspace.name} renamed.`;
  });
}

async function leaveWorkspace() {
  const activeWorkspaceId = Number(workspaceId.value);
  const activeWorkspaceName = workspace.value?.name || 'this workspace';
  if (!activeWorkspaceId) return;

  await withPending(async () => {
    const response = await request(`/api/workspaces/${activeWorkspaceId}/leave`, {
      method: 'POST',
      body: JSON.stringify({})
    });

    await applyWorkspaceMembershipUpdate({
      workspaces: response.workspaces || [],
      preferredWorkspaceId: response.defaultWorkspaceId || 0,
      statusMessage: `You left ${activeWorkspaceName}.`
    });
  });
}

async function deleteWorkspace() {
  const activeWorkspaceId = Number(workspaceId.value);
  const activeWorkspaceName = workspace.value?.name || 'this workspace';
  if (!activeWorkspaceId) return;

  await withPending(async () => {
    const response = await request(`/api/workspaces/${activeWorkspaceId}`, {
      method: 'DELETE',
      body: JSON.stringify({})
    });

    await applyWorkspaceMembershipUpdate({
      workspaces: response.workspaces || [],
      preferredWorkspaceId: response.defaultWorkspaceId || 0,
      statusMessage: `${activeWorkspaceName} was deleted.`
    });
  });
}

async function promoteMember(member, onCompleted) {
  await withPending(async () => {
    await request(`/api/members/${member.id}/owner`, {
      method: 'POST',
      body: JSON.stringify({ workspaceId: workspaceId.value })
    });
    if (typeof onCompleted === 'function') {
      onCompleted();
    }
    await loadBootstrap();
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

async function deleteTask() {
  const taskId = Number(deleteTaskTarget.value?.id);
  if (!taskId) return;

  await withPending(async () => {
    await request(`/api/tasks/${taskId}`, {
      method: 'DELETE',
      body: JSON.stringify({ workspaceId: workspaceId.value })
    });
    await loadBootstrap();
    closeDeleteTaskModal();
  });
}

async function createInvite(email, onCreated, onFailed) {
  pending.value = true;
  errorMessage.value = '';
  authErrorMode.value = '';

  try {
    const response = await request('/api/invites', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: workspaceId.value, email })
    });
    if (typeof onCreated === 'function') {
      onCreated(response.invite);
    }
    await loadBootstrap();
  } catch (error) {
    if (typeof onFailed === 'function') {
      onFailed(error.message);
    } else {
      errorMessage.value = error.message;
    }
  } finally {
    pending.value = false;
  }
}

async function resendInvite(invite, onCompleted) {
  await withPending(async () => {
    const response = await request(`/api/invites/${invite.id}/resend`, {
      method: 'POST',
      body: JSON.stringify({ workspaceId: workspaceId.value })
    });
    if (typeof onCompleted === 'function') {
      onCompleted({
        invite: response.invite,
        notice: response.invite.emailDelivery?.message || `Invite resent to ${invite.email}.`,
        tone: response.invite.emailDelivery?.ok ? 'success' : 'warning'
      });
    }
    await loadBootstrap();
  });
}

async function copyInviteLink(invite, onCompleted) {
  await withPending(async () => {
    const response = await request(`/api/invites/${invite.id}/link`, {
      method: 'POST',
      body: JSON.stringify({ workspaceId: workspaceId.value })
    });
    if (typeof onCompleted === 'function') {
      onCompleted({
        invite: response.invite,
        notice: `Invite link copied for ${invite.email}.`,
        tone: 'success'
      });
    }
  });
}

async function cancelInvite(invite, onCompleted) {
  await withPending(async () => {
    await request(`/api/invites/${invite.id}`, {
      method: 'DELETE',
      body: JSON.stringify({ workspaceId: workspaceId.value })
    });
    if (typeof onCompleted === 'function') {
      onCompleted();
    }
    await loadBootstrap();
  });
}

async function removeMember(member, onCompleted) {
  await withPending(async () => {
    await request(`/api/members/${member.id}`, {
      method: 'DELETE',
      body: JSON.stringify({ workspaceId: workspaceId.value })
    });
    if (typeof onCompleted === 'function') {
      onCompleted();
    }
    await loadBootstrap();
  });
}

async function loadInvite() {
  if (!inviteToken.value) {
    syncVisibleInvite();
    return;
  }

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
    appleAuthEnabled.value = Boolean(response.apple?.enabled);
  } catch {
    googleAuthEnabled.value = false;
    appleAuthEnabled.value = false;
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
  if (!token.value || (!inviteToken.value && !inviteDetails.value?.id)) return;

  try {
    await withPending(async () => {
      const acceptedInviteId = inviteDetails.value?.id || null;
      const response = await request('/api/invites/accept', {
        method: 'POST',
        body: JSON.stringify({
          inviteToken: inviteToken.value || null,
          inviteId: inviteToken.value ? null : acceptedInviteId
        })
      });

      if (acceptedInviteId) {
        pendingInvites.value = pendingInvites.value.filter((invite) => invite.id !== acceptedInviteId);
      }
      clearInviteState();
      workspaceId.value = Number(response.workspaceId);
      localStorage.setItem(WORKSPACE_KEY, String(workspaceId.value));
      await restoreSession();
    });
  } finally {
    if (inviteDetails.value && isResolvedInviteError(errorMessage.value)) {
      const resolvedInviteId = inviteDetails.value.id || null;
      if (resolvedInviteId) {
        pendingInvites.value = pendingInvites.value.filter((invite) => invite.id !== resolvedInviteId);
      }
      clearInviteState();
      await restoreSession();
      errorMessage.value = '';
    }
  }
}

async function restoreSession() {
  if (!token.value) return;

  try {
    const session = await request('/api/auth/session');
    currentUser.value = session.user;
    pendingInvites.value = normalizePendingInvites(session.pendingInvites || []);
    syncVisibleInvite();

    const preferredWorkspaceId = workspaceId.value && workspaceId.value !== revokedWorkspaceId.value ? workspaceId.value : 0;
    await applyWorkspaceMembershipUpdate({
      workspaces: session.workspaces || [],
      preferredWorkspaceId: preferredWorkspaceId || session.defaultWorkspaceId || session.workspaces?.[0]?.id || 0
    });
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
    <header class="app-topbar">
      <div class="app-brand" aria-label="Tasked">
        <img
          :src="theme === 'dark' ? '/imgs/tasked-logo-dark.png' : '/imgs/tasked-logo-light.png'"
          alt="Tasked"
        />
      </div>
      <div class="theme-switch" role="group" aria-label="Color theme">
        <button
          type="button"
          class="theme-button"
          :class="{ active: theme === 'light' }"
          :aria-pressed="theme === 'light'"
          @click="setTheme('light')"
        >
          Light
        </button>
        <button
          type="button"
          class="theme-button"
          :class="{ active: theme === 'dark' }"
          :aria-pressed="theme === 'dark'"
          @click="setTheme('dark')"
        >
          Dark
        </button>
      </div>
    </header>

    <template v-if="!isAuthenticated">
      <AuthPanel
        :invite="inviteDetails"
        :google-enabled="googleAuthEnabled"
        :apple-enabled="appleAuthEnabled"
        :error-message="errorMessage"
        :error-for-mode="authErrorMode"
        :pending="pending"
        :theme="theme"
        @apple="startAppleAuth"
        @google="startGoogleAuth"
        @submit="handleAuth"
      />
    </template>

    <template v-else>
      <section class="hero-bar panel">
        <div>
          <p class="eyebrow">{{ heroEyebrow }}</p>
          <h1>{{ heroTitle }}</h1>
        </div>
        <div class="hero-meta">
          <span>{{ currentUser?.name || 'Unknown user' }}</span>
          <span>{{ heroStatus }}</span>
          <button
            v-if="!hasWorkspace"
            type="button"
            class="ghost-danger hero-meta-logout"
            :disabled="pending"
            @click="clearSession"
          >
            Logout
          </button>
        </div>
      </section>

      <section v-if="inviteDetails" class="panel invite-accept-panel invite-pending-panel">
        <div class="invite-accept-copy">
          <p class="eyebrow">Pending invite</p>
          <h2>Join {{ inviteDetails.workspaceName }}</h2>
          <p class="subtle">Signed in as {{ currentUser?.email }}. Accept the invite to join this workspace.</p>
          <p v-if="errorMessage" class="form-error">{{ errorMessage }}</p>
        </div>
        <div class="invite-accept-actions">
          <p class="subtle">Invitation ready</p>
          <button class="ghost-button" :disabled="pending" @click="acceptInvite">Accept invite</button>
        </div>
      </section>

      <section v-else-if="!hasWorkspace" class="panel invite-accept-panel no-workspace-panel">
        <div class="no-workspace-copy">
          <p class="eyebrow">No workspace selected</p>
          <h2>Your workspace access changed</h2>
          <p class="subtle">You are still signed in, but you no longer have an active workspace selected.</p>
          <p v-if="errorMessage" class="form-error">{{ errorMessage }}</p>
        </div>
        <form class="no-workspace-form" @submit.prevent="createWorkspace(noWorkspaceName)">
          <input v-model="noWorkspaceName" type="text" placeholder="Create a new workspace" :disabled="pending" />
          <button class="ghost-button" type="submit" :disabled="pending || !noWorkspaceName.trim()">Create workspace</button>
        </form>
      </section>

      <p v-else-if="errorMessage" class="error-banner">{{ errorMessage }}</p>

      <section v-if="hasWorkspace" class="layout-grid three-up">
        <WorkspaceSidebar
          :current-user="currentUser"
          :invites="invites"
          :members="members"
          :memberships="memberships"
          :member-count="memberCount"
          :owner-count="ownerCount"
          :role="currentMembership?.role || 'member'"
          :workspace="workspace"
          :workspace-id="workspaceId || 0"
          :pending="pending"
          @cancel-invite="cancelInvite"
          @copy-invite-link="copyInviteLink"
          @create-workspace="createWorkspace"
          @delete-workspace="deleteWorkspace"
          @leave-workspace="leaveWorkspace"
          @logout="clearSession"
          @promote-member="promoteMember"
          @rename-workspace="renameWorkspace"
          @remove-member="removeMember"
          @resend-invite="resendInvite"
          @select-workspace="switchWorkspace"
          @create-invite="createInvite"
          @update-profile="updateProfile"
        />

        <div ref="boardPanelRef" class="layout-anchor">
          <TaskPanel
            v-if="activeList?.type !== 'grocery'"
            :active-list="activeList"
            :tasks="activeTasks"
            :pending="pending"
            :socket-state="socketState"
            @create-task="createTask"
            @save-task="saveTask"
            @show-lists="scrollToLists"
            @toggle-task="toggleTask"
            @delete-task="openDeleteTaskModal"
          />

          <GroceryPanel
            v-else
            :active-list="activeList"
            :tasks="activeTasks"
            :pending="pending"
            :socket-state="socketState"
            @create-task="createTask"
            @save-task="saveTask"
            @show-lists="scrollToLists"
            @toggle-task="toggleTask"
            @delete-task="openDeleteTaskModal"
          />
        </div>

        <div ref="listPanelRef" class="layout-anchor">
          <ListSidebar
            :current-list-id="activeListId || 0"
            :lists="lists"
            :pending="pending"
            @create-list="createList"
            @delete-list="deleteList"
            @select-list="handleSelectList"
          />
        </div>
      </section>
    </template>

    <div v-if="deleteTaskTarget" class="modal-backdrop" @click.self="closeDeleteTaskModal">
      <section class="panel action-modal">
        <div>
          <p class="eyebrow">Delete {{ deleteTaskTarget.kind }}</p>
          <h2>Delete {{ deleteTaskTarget.title }}?</h2>
          <p class="subtle">This permanently removes the {{ deleteTaskTarget.kind }} from the current list.</p>
        </div>

        <div class="modal-actions">
          <button class="ghost-button muted-button" type="button" :disabled="pending" @click="closeDeleteTaskModal">Cancel</button>
          <button class="ghost-danger" type="button" :disabled="pending" @click="deleteTask">
            Delete {{ deleteTaskTarget.kind }}
          </button>
        </div>
      </section>
    </div>
  </main>
</template>
