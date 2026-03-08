<script setup>
import { computed, onMounted, ref } from 'vue';

const props = defineProps({
  currentUser: {
    type: Object,
    default: null
  },
  requester: {
    type: Function,
    required: true
  }
});

const emit = defineEmits(['logout']);

const dashboard = ref(null);
const loading = ref(true);
const refreshing = ref(false);
const errorMessage = ref('');
const lastLoadedAt = ref('');

const overview = computed(() => dashboard.value?.overview || {});
const providers = computed(() => dashboard.value?.providers || {});
const growth = computed(() => dashboard.value?.growth || []);
const users = computed(() => dashboard.value?.users || []);
const workspaces = computed(() => dashboard.value?.workspaces || []);
const recentActivity = computed(() => dashboard.value?.recentActivity || []);
const errorLogs = computed(() => dashboard.value?.errorLogs || []);

const statCards = computed(() => [
  {
    label: 'Users',
    value: overview.value.totalUsers || 0,
    detail: `${overview.value.activeUsers24h || 0} active in 24h`
  },
  {
    label: 'Super Admins',
    value: overview.value.totalSuperAdmins || 0,
    detail: `${overview.value.logins7d || 0} sign-ins in 7 days`
  },
  {
    label: 'Workspaces',
    value: overview.value.totalWorkspaces || 0,
    detail: `${overview.value.newWorkspaces7d || 0} new in 7 days`
  },
  {
    label: 'Tasks',
    value: overview.value.totalTasks || 0,
    detail: `${overview.value.completedTasks || 0} completed`
  },
  {
    label: 'Pending Invites',
    value: overview.value.pendingInvites || 0,
    detail: `${overview.value.openTasks || 0} open tasks remaining`
  },
  {
    label: 'Errors',
    value: overview.value.errors24h || 0,
    detail: `${errorLogs.value.length || 0} recent log entries`
  }
]);

const providerCards = computed(() => [
  {
    label: 'Password',
    value: providers.value.passwordUsers || 0
  },
  {
    label: 'Google',
    value: providers.value.googleUsers || 0
  },
  {
    label: 'Apple',
    value: providers.value.appleUsers || 0
  },
  {
    label: 'Password Only',
    value: providers.value.passwordOnlyUsers || 0
  }
]);

const growthMax = computed(() => {
  const maxValue = growth.value.reduce((highest, day) => {
    return Math.max(highest, Number(day.newUsers || 0), Number(day.newWorkspaces || 0));
  }, 0);

  return maxValue || 1;
});

function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value || 0));
}

function formatDateTime(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date);
}

function formatShortDate(value) {
  if (!value) return '--';
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return '--';

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric'
  }).format(date);
}

function formatRelativeTime(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';

  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.round(diffMs / 60000);

  if (Math.abs(diffMinutes) < 1) return 'Just now';
  if (Math.abs(diffMinutes) < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) return `${diffHours}h ago`;

  const diffDays = Math.round(diffHours / 24);
  return `${diffDays}d ago`;
}

function trendBarHeight(value) {
  const ratio = Number(value || 0) / growthMax.value;
  return `${Math.max(12, ratio * 100)}%`;
}

function providerLabels(user) {
  const labels = [];
  if (user?.hasPassword) labels.push('Password');
  if (user?.hasGoogle) labels.push('Google');
  if (user?.hasApple) labels.push('Apple');
  return labels.length ? labels : ['None'];
}

function workspaceCompletion(workspace) {
  if (!workspace?.taskCount) return 'No tasks yet';
  const ratio = Math.round((Number(workspace.completedTaskCount || 0) / Number(workspace.taskCount || 1)) * 100);
  return `${ratio}% complete`;
}

function humanizeEventType(eventType) {
  return String(eventType || 'activity')
    .replaceAll('.', ' ')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function activityTitle(entry) {
  const actor = entry.actorName || entry.actorEmail || 'System';
  const metadata = entry.metadata || {};

  switch (entry.eventType) {
    case 'auth.register':
      return `${actor} created an account`;
    case 'auth.login':
      return `${actor} signed in`;
    case 'auth.oauth.google':
      return `${actor} signed in with Google`;
    case 'auth.oauth.apple':
      return `${actor} signed in with Apple`;
    case 'auth.password_reset.requested':
      return `Password reset requested for ${actor}`;
    case 'auth.password_reset.completed':
      return `${actor} reset their password`;
    case 'profile.updated':
      return `${actor} updated their profile`;
    case 'workspace.created':
      return `${metadata.workspaceName || 'A workspace'} was created`;
    case 'workspace.renamed':
      return `${metadata.workspaceName || 'A workspace'} was renamed`;
    case 'workspace.left':
      return `${actor} left ${metadata.workspaceName || 'a workspace'}`;
    case 'workspace.deleted':
      return `${metadata.workspaceName || 'A workspace'} was deleted`;
    case 'invite.created':
      return `Invite sent to ${metadata.email || 'a teammate'}`;
    case 'invite.resent':
      return `Invite resent to ${metadata.email || 'a teammate'}`;
    case 'invite.cancelled':
      return `Invite cancelled for ${metadata.email || 'a teammate'}`;
    case 'invite.accepted':
      return `${actor} accepted an invite`;
    case 'member.removed':
      return `${metadata.email || 'A member'} was removed`;
    case 'member.promoted':
      return `${metadata.email || 'A member'} was promoted`;
    case 'list.created':
      return `${metadata.listName || 'A list'} was created`;
    case 'list.deleted':
      return 'A list was deleted';
    case 'task.created':
      return `${metadata.title || 'A task'} was created`;
    case 'task.completed':
      return 'A task was completed';
    case 'task.reopened':
      return 'A task was reopened';
    case 'task.updated':
      return 'A task was updated';
    case 'task.deleted':
      return 'A task was deleted';
    default:
      return humanizeEventType(entry.eventType);
  }
}

function activityContext(entry) {
  const metadata = entry.metadata || {};
  const details = [];

  if (entry.actorEmail) details.push(entry.actorEmail);
  if (metadata.workspaceName) {
    details.push(metadata.workspaceName);
  } else if (entry.workspaceId) {
    details.push(`Workspace #${entry.workspaceId}`);
  }
  if (metadata.email && metadata.email !== entry.actorEmail) {
    details.push(metadata.email);
  }

  return details.join(' • ');
}

function hasErrorDetails(log) {
  return Boolean(log?.stack || Object.keys(log?.metadata || {}).length);
}

function formatErrorDetails(log) {
  const parts = [];

  if (log?.stack) {
    parts.push(log.stack.trim());
  }

  if (Object.keys(log?.metadata || {}).length) {
    parts.push(JSON.stringify(log.metadata, null, 2));
  }

  return parts.join('\n\n');
}

async function loadDashboard({ silent = false } = {}) {
  if (!silent) {
    loading.value = true;
  } else {
    refreshing.value = true;
  }

  errorMessage.value = '';

  try {
    dashboard.value = await props.requester('/api/admin/dashboard');
    lastLoadedAt.value = new Date().toISOString();
  } catch (error) {
    errorMessage.value = error.message || 'Failed to load the admin dashboard.';
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

onMounted(() => {
  loadDashboard();
});
</script>

<template>
  <section class="admin-shell">
    <section class="panel admin-hero">
      <div class="admin-hero-copy">
        <p class="eyebrow">Super Admin</p>
        <h1>Site control center</h1>
        <p class="subtle">
          Usage metrics, user directory, recent activity, and captured server errors live here.
          The workspace app stays hidden for SUPER_ADMIN sessions.
        </p>
      </div>

      <div class="admin-hero-actions">
        <div class="admin-account-card">
          <span class="account-summary-eyebrow">Signed in</span>
          <strong>{{ currentUser?.name || 'Super admin' }}</strong>
          <small>{{ currentUser?.email || 'Unknown email' }}</small>
          <small>Last login {{ formatRelativeTime(currentUser?.lastLoginAt) }}</small>
        </div>

        <div class="admin-action-row">
          <button class="ghost-button" type="button" :disabled="loading || refreshing" @click="loadDashboard({ silent: true })">
            {{ refreshing ? 'Refreshing...' : 'Refresh data' }}
          </button>
          <button class="ghost-button muted-button" type="button" @click="emit('logout')">Log out</button>
        </div>

        <p class="subtle admin-refresh-meta">Last synced {{ lastLoadedAt ? formatDateTime(lastLoadedAt) : 'not yet loaded' }}</p>
      </div>
    </section>

    <p v-if="errorMessage" class="error-banner">{{ errorMessage }}</p>

    <section v-if="loading && !dashboard" class="panel admin-loading-panel">
      <p class="eyebrow">Loading</p>
      <h2>Gathering site data</h2>
      <p class="subtle">Users, workspaces, activity, and error telemetry are loading.</p>
    </section>

    <template v-else-if="dashboard">
      <section class="admin-stat-grid">
        <article v-for="card in statCards" :key="card.label" class="panel admin-stat-card">
          <p class="eyebrow">{{ card.label }}</p>
          <strong>{{ formatNumber(card.value) }}</strong>
          <small>{{ card.detail }}</small>
        </article>
      </section>

      <section class="admin-grid admin-grid-two-up">
        <section class="panel admin-section">
          <div class="admin-section-header">
            <div>
              <p class="eyebrow">Growth</p>
              <h2>7-day signup pulse</h2>
            </div>
            <div class="admin-provider-chips">
              <span v-for="card in providerCards" :key="card.label" class="admin-chip">
                {{ card.label }} {{ formatNumber(card.value) }}
              </span>
            </div>
          </div>

          <div class="admin-trend-grid">
            <article v-for="day in growth" :key="day.day" class="admin-trend-day">
              <div class="admin-trend-bars">
                <span class="admin-trend-bar users" :style="{ height: trendBarHeight(day.newUsers) }" />
                <span class="admin-trend-bar workspaces" :style="{ height: trendBarHeight(day.newWorkspaces) }" />
              </div>
              <strong>{{ formatShortDate(day.day) }}</strong>
              <small>{{ day.newUsers }} users • {{ day.newWorkspaces }} workspaces</small>
            </article>
          </div>
        </section>

        <section class="panel admin-section">
          <div class="admin-section-header">
            <div>
              <p class="eyebrow">Activity</p>
              <h2>Recent events</h2>
            </div>
            <small class="subtle">{{ recentActivity.length }} latest entries</small>
          </div>

          <div v-if="recentActivity.length" class="admin-activity-list">
            <article v-for="entry in recentActivity" :key="entry.id" class="admin-activity-item">
              <div class="admin-activity-copy">
                <strong>{{ activityTitle(entry) }}</strong>
                <small class="subtle">{{ humanizeEventType(entry.eventType) }}</small>
                <small v-if="activityContext(entry)" class="subtle">{{ activityContext(entry) }}</small>
              </div>
              <small class="admin-time">{{ formatRelativeTime(entry.createdAt) }}</small>
            </article>
          </div>

          <p v-else class="subtle">No tracked activity yet.</p>
        </section>
      </section>

      <section class="admin-grid admin-grid-two-up">
        <section class="panel admin-section">
          <div class="admin-section-header">
            <div>
              <p class="eyebrow">Workspace Health</p>
              <h2>Largest workspaces</h2>
            </div>
            <small class="subtle">{{ workspaces.length }} shown</small>
          </div>

          <div v-if="workspaces.length" class="admin-workspace-list">
            <article v-for="workspace in workspaces" :key="workspace.id" class="admin-workspace-card">
              <div>
                <strong>{{ workspace.name }}</strong>
                <small class="subtle">{{ workspace.slug }}</small>
              </div>
              <div class="admin-workspace-metrics">
                <span class="admin-chip">{{ workspace.memberCount }} members</span>
                <span class="admin-chip">{{ workspace.taskCount }} tasks</span>
                <span class="admin-chip">{{ workspaceCompletion(workspace) }}</span>
              </div>
              <small class="subtle">
                Created {{ formatDateTime(workspace.createdAt) }}
                <span v-if="workspace.createdByEmail">by {{ workspace.createdByEmail }}</span>
              </small>
            </article>
          </div>

          <p v-else class="subtle">No workspaces available yet.</p>
        </section>

        <section class="panel admin-section">
          <div class="admin-section-header">
            <div>
              <p class="eyebrow">Error Logs</p>
              <h2>Recent backend failures</h2>
            </div>
            <small class="subtle">{{ errorLogs.length }} recent entries</small>
          </div>

          <div v-if="errorLogs.length" class="admin-error-list">
            <article v-for="log in errorLogs" :key="log.id" class="admin-error-item">
              <div class="admin-error-header">
                <strong>{{ log.message }}</strong>
                <span class="admin-chip">{{ log.source }}</span>
              </div>
              <small class="subtle">
                {{ formatDateTime(log.createdAt) }}
                <span v-if="log.statusCode">• HTTP {{ log.statusCode }}</span>
                <span v-if="log.requestMethod || log.requestPath">• {{ log.requestMethod }} {{ log.requestPath }}</span>
                <span v-if="log.userEmail">• {{ log.userEmail }}</span>
              </small>

              <details v-if="hasErrorDetails(log)" class="admin-error-details">
                <summary>Inspect details</summary>
                <pre>{{ formatErrorDetails(log) }}</pre>
              </details>
            </article>
          </div>

          <p v-else class="subtle">No captured server errors yet.</p>
        </section>
      </section>

      <section class="panel admin-section admin-user-section">
        <div class="admin-section-header">
          <div>
            <p class="eyebrow">Users</p>
            <h2>Full user directory</h2>
          </div>
          <small class="subtle">{{ users.length }} total accounts</small>
        </div>

        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Providers</th>
                <th>Workspace Access</th>
                <th>Tasks Created</th>
                <th>Last Active</th>
                <th>Joined</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="user in users" :key="user.id">
                <td>
                  <div class="admin-table-user">
                    <strong>{{ user.name }}</strong>
                    <small>{{ user.email }}</small>
                  </div>
                </td>
                <td>
                  <span class="admin-chip" :class="{ 'admin-chip-accent': user.siteRole === 'SUPER_ADMIN' }">
                    {{ user.siteRole }}
                  </span>
                </td>
                <td>
                  <div class="admin-badge-row">
                    <span v-for="label in providerLabels(user)" :key="`${user.id}-${label}`" class="admin-chip">
                      {{ label }}
                    </span>
                  </div>
                </td>
                <td>{{ user.workspaceCount }}</td>
                <td>{{ user.taskCount }} / {{ user.completedTaskCount }} done</td>
                <td>{{ formatRelativeTime(user.lastActiveAt || user.lastLoginAt) }}</td>
                <td>{{ formatDateTime(user.createdAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </section>
</template>
