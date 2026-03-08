<script setup>
import { computed, reactive, ref } from 'vue';

const EMAIL_PREVIEW_LIMIT = 17;

const props = defineProps({
  currentUser: {
    type: Object,
    default: null
  },
  members: {
    type: Array,
    default: () => []
  },
  invites: {
    type: Array,
    default: () => []
  },
  memberships: {
    type: Array,
    required: true
  },
  memberCount: {
    type: Number,
    default: 0
  },
  ownerCount: {
    type: Number,
    default: 0
  },
  role: {
    type: String,
    default: 'member'
  },
  workspace: {
    type: Object,
    default: null
  },
  workspaceId: {
    type: Number,
    required: true
  },
  pending: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits([
  'select-workspace',
  'create-workspace',
  'leave-workspace',
  'delete-workspace',
  'create-invite',
  'copy-invite-link',
  'resend-invite',
  'cancel-invite',
  'remove-member',
  'promote-member',
  'logout'
]);

const workspaceForm = reactive({
  name: ''
});
const inviteEmail = ref('');
const lastInviteUrl = ref('');
const lastInviteNotice = ref('');
const lastInviteNoticeTone = ref('muted');
const activeInviteId = ref(null);
const activeMemberId = ref(null);
const modalMode = ref('');
const modalError = ref('');

const currentWorkspaceName = computed(() => (
  props.workspace?.name
  || props.memberships.find((membership) => Number(membership.id) === Number(props.workspaceId))?.name
  || 'Workspace'
));
const canDeleteWorkspace = computed(() => props.role === 'owner' && props.memberCount <= 1);
const canLeaveWorkspace = computed(() => props.role === 'member' || (props.role === 'owner' && props.memberCount > 1));
const ownerMustTransfer = computed(() => props.role === 'owner' && props.memberCount > 1 && props.ownerCount < 2);
const canInvite = computed(() => props.role === 'owner');

function handleCreateWorkspace() {
  modalMode.value = 'create-workspace';
  workspaceForm.name = '';
  modalError.value = '';
}

function handleLeaveWorkspace() {
  modalMode.value = 'leave-workspace';
  modalError.value = '';
}

function handleDeleteWorkspace() {
  modalMode.value = 'delete-workspace';
  modalError.value = '';
}

function closeModal() {
  modalMode.value = '';
  modalError.value = '';
}

function submitCreateWorkspace() {
  if (!workspaceForm.name.trim()) {
    modalError.value = 'Workspace name is required.';
    return;
  }

  emit('create-workspace', workspaceForm.name.trim());
  closeModal();
}

function confirmLeaveWorkspace() {
  emit('leave-workspace');
  closeModal();
}

function confirmDeleteWorkspace() {
  emit('delete-workspace');
  closeModal();
}

function applyInviteResult(result = {}) {
  lastInviteUrl.value = result.invite?.inviteUrl || '';
  lastInviteNotice.value = result.notice || result.invite?.emailDelivery?.message || 'Invite link ready.';
  lastInviteNoticeTone.value = result.tone || (result.invite?.emailDelivery?.ok ? 'success' : 'warning');
}

function submitInvite() {
  if (!inviteEmail.value.trim()) return;
  emit('create-invite', inviteEmail.value.trim(), (invite) => {
    applyInviteResult({ invite });
  });
  inviteEmail.value = '';
}

async function copyLatestInvite() {
  if (!lastInviteUrl.value) return;
  await navigator.clipboard.writeText(lastInviteUrl.value);
}

function toggleInviteActions(inviteId) {
  activeInviteId.value = activeInviteId.value === inviteId ? null : inviteId;
}

function toggleMemberActions(memberId) {
  activeMemberId.value = activeMemberId.value === memberId ? null : memberId;
}

function copyInviteLink(invite) {
  emit('copy-invite-link', invite, async (result) => {
    applyInviteResult(result);
    if (result?.invite?.inviteUrl) {
      await navigator.clipboard.writeText(result.invite.inviteUrl);
    }
    activeInviteId.value = null;
  });
}

function resendInvite(invite) {
  emit('resend-invite', invite, (result) => {
    applyInviteResult(result);
    activeInviteId.value = null;
  });
}

function cancelInvite(invite) {
  const confirmed = window.confirm(`Cancel the invite for ${invite.email}?`);
  if (!confirmed) return;

  emit('cancel-invite', invite, () => {
    lastInviteNotice.value = `Invite canceled for ${invite.email}.`;
    lastInviteNoticeTone.value = 'warning';
    activeInviteId.value = null;
  });
}

function canRemoveMember(member) {
  return canInvite.value && member.id !== props.currentUser?.id && member.role !== 'owner';
}

function canPromoteMember(member) {
  return canInvite.value && member.id !== props.currentUser?.id && member.role !== 'owner';
}

function canManageMember(member) {
  return canRemoveMember(member) || canPromoteMember(member);
}

function promoteMember(member) {
  const confirmed = window.confirm(`Promote ${member.name} to owner?`);
  if (!confirmed) return;

  emit('promote-member', member, () => {
    lastInviteNotice.value = `${member.name} is now an owner.`;
    lastInviteNoticeTone.value = 'success';
    activeMemberId.value = null;
  });
}

function removeMember(member) {
  const confirmed = window.confirm(`Remove ${member.name} from this workspace?`);
  if (!confirmed) return;

  emit('remove-member', member, () => {
    lastInviteNotice.value = `${member.name} was removed from the workspace.`;
    lastInviteNoticeTone.value = 'warning';
    activeMemberId.value = null;
  });
}

function formatEmailPreview(email) {
  const value = String(email || '');
  return value.length > EMAIL_PREVIEW_LIMIT ? `${value.slice(0, EMAIL_PREVIEW_LIMIT)}...` : value;
}
</script>

<template>
  <aside class="panel sidebar-panel workspace-panel">
    <div class="sidebar-header">
      <div>
        <p class="eyebrow">Workspace</p>
        <h1>{{ currentWorkspaceName }}</h1>
        <p class="subtle">{{ memberCount }} members • {{ role }}</p>
      </div>
      <button class="ghost-danger" :disabled="pending" @click="emit('logout')">Logout</button>
    </div>

    <div class="panel-scroll">
      <section class="workspace-section">
        <label class="workspace-switcher-label" for="workspace-switcher">Switch workspace</label>
        <select
          id="workspace-switcher"
          class="workspace-switcher"
          :value="workspaceId"
          @change="emit('select-workspace', Number($event.target.value))"
        >
          <option v-for="workspaceOption in memberships" :key="workspaceOption.id" :value="workspaceOption.id">
            {{ workspaceOption.name }} • {{ workspaceOption.role }}
          </option>
        </select>

        <div class="workspace-actions">
          <button type="button" class="ghost-button muted-button" :disabled="pending" @click="handleCreateWorkspace">New workspace</button>
          <button v-if="canLeaveWorkspace" type="button" class="ghost-danger" :disabled="pending" @click="handleLeaveWorkspace">
            Leave workspace
          </button>
          <button v-else-if="canDeleteWorkspace" type="button" class="ghost-danger" :disabled="pending" @click="handleDeleteWorkspace">
            Delete workspace
          </button>
        </div>
      </section>

      <section class="workspace-section workspace-account-card">
        <p class="eyebrow">Account</p>
        <strong>{{ currentUser?.name || 'Unknown user' }}</strong>
        <small class="subtle">{{ currentUser?.email }}</small>
      </section>

      <section class="workspace-section">
        <div class="workspace-section-header">
          <div>
            <p class="eyebrow">Members</p>
            <h2>People in this workspace</h2>
          </div>
          <small class="subtle">{{ memberCount }} total</small>
        </div>

        <div class="member-list">
          <div
            v-for="member in members"
            :key="member.id"
            class="member-row"
            :class="{ active: activeMemberId === member.id }"
          >
            <button
              v-if="canManageMember(member)"
              type="button"
              class="member-summary"
              :disabled="pending"
              @click="toggleMemberActions(member.id)"
            >
              <strong>{{ member.name }}</strong>
              <small class="member-email" :title="member.email">{{ formatEmailPreview(member.email) }}</small>
            </button>
            <span v-else>
              <strong>{{ member.name }}</strong>
              <small class="member-email" :title="member.email">{{ formatEmailPreview(member.email) }}</small>
            </span>
            <small class="member-role">{{ member.role }}</small>
            <div v-if="activeMemberId === member.id" class="member-actions">
              <button
                v-if="canPromoteMember(member)"
                type="button"
                class="ghost-button muted-button"
                :disabled="pending"
                @click="promoteMember(member)"
              >
                Make owner
              </button>
              <button
                v-if="canRemoveMember(member)"
                type="button"
                class="ghost-danger"
                :disabled="pending"
                @click="removeMember(member)"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      </section>

      <section v-if="canInvite" class="workspace-section">
        <div class="workspace-section-header">
          <div>
            <p class="eyebrow">Invite</p>
            <h2>Add a teammate</h2>
          </div>
        </div>

        <form class="invite-form" @submit.prevent="submitInvite">
          <input v-model="inviteEmail" type="email" placeholder="Invite teammate by email" :disabled="pending" />
          <button type="submit" :disabled="pending || !inviteEmail.trim()">Create invite</button>
        </form>
      </section>

      <section v-if="lastInviteUrl" class="workspace-section">
        <div class="invite-link-card">
          <p class="subtle">Latest invite link</p>
          <input :value="lastInviteUrl" readonly />
          <p class="invite-feedback" :class="lastInviteNoticeTone">{{ lastInviteNotice }}</p>
          <button class="ghost-button muted-button" :disabled="pending" @click="copyLatestInvite">Copy link</button>
        </div>
      </section>

      <section v-if="invites.length" class="workspace-section">
        <div class="workspace-section-header">
          <div>
            <p class="eyebrow">Invites</p>
            <h2>Pending invitations</h2>
          </div>
          <small class="subtle">{{ invites.length }} open</small>
        </div>

        <div class="invite-list">
          <div
            v-for="invite in invites"
            :key="invite.id"
            class="invite-row"
            :class="{ active: activeInviteId === invite.id }"
          >
            <div class="invite-row-header">
              <button type="button" class="invite-summary" :disabled="pending" @click="toggleInviteActions(invite.id)">
                <strong class="invite-email">{{ invite.email }}</strong>
              </button>
              <small class="member-role invite-role">{{ invite.role }}</small>
            </div>
            <div class="invite-row-meta">
              <span class="invite-status">Pending invite</span>
              <span>Expires {{ new Date(invite.expiresAt).toLocaleString() }}</span>
            </div>
            <div v-if="activeInviteId === invite.id" class="invite-actions">
              <button type="button" class="ghost-button muted-button" :disabled="pending" @click="copyInviteLink(invite)">Copy link</button>
              <button type="button" class="ghost-button muted-button" :disabled="pending" @click="resendInvite(invite)">Resend</button>
              <button type="button" class="ghost-danger" :disabled="pending" @click="cancelInvite(invite)">Cancel</button>
            </div>
          </div>
        </div>
      </section>
    </div>
  </aside>

  <div v-if="modalMode" class="modal-backdrop" @click.self="closeModal">
    <section class="panel action-modal">
      <template v-if="modalMode === 'create-workspace'">
        <form class="modal-form-stack" @submit.prevent="submitCreateWorkspace">
          <div>
            <p class="eyebrow">New workspace</p>
            <h2>Create another workspace</h2>
            <p class="subtle">You will become the owner and start with fresh default lists.</p>
          </div>

          <div class="modal-form">
            <input v-model="workspaceForm.name" type="text" placeholder="Workspace name" :disabled="pending" />
            <p v-if="modalError" class="form-error">{{ modalError }}</p>
          </div>

          <div class="modal-actions">
            <button class="ghost-button muted-button" type="button" :disabled="pending" @click="closeModal">Cancel</button>
            <button class="ghost-button" type="submit" :disabled="pending">Create workspace</button>
          </div>
        </form>
      </template>

      <template v-else-if="modalMode === 'leave-workspace'">
        <div>
          <p class="eyebrow">Leave workspace</p>
          <h2>Leave {{ currentWorkspaceName }}?</h2>
          <p v-if="ownerMustTransfer" class="subtle">
            Promote another member in this workspace before leaving. Shared workspaces must keep an owner.
          </p>
          <p v-else class="subtle">
            You will lose access immediately. You can only rejoin if an owner invites you again.
          </p>
        </div>

        <div class="modal-actions">
          <button class="ghost-button muted-button" type="button" :disabled="pending" @click="closeModal">Cancel</button>
          <button class="ghost-danger" type="button" :disabled="pending || ownerMustTransfer" @click="confirmLeaveWorkspace">
            Leave workspace
          </button>
        </div>
      </template>

      <template v-else-if="modalMode === 'delete-workspace'">
        <div>
          <p class="eyebrow">Delete workspace</p>
          <h2>Delete {{ currentWorkspaceName }}?</h2>
          <p class="subtle">This permanently removes all lists, tasks, invites, and member access for this workspace.</p>
        </div>

        <div class="modal-actions">
          <button class="ghost-button muted-button" type="button" :disabled="pending" @click="closeModal">Cancel</button>
          <button class="ghost-danger" type="button" :disabled="pending" @click="confirmDeleteWorkspace">Delete workspace</button>
        </div>
      </template>
    </section>
  </div>
</template>
