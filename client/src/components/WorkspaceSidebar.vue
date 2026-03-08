<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref } from 'vue';

const EMAIL_PREVIEW_LIMIT = 17;
const ACTION_FEEDBACK_DURATION_MS = 5000;
const INVITE_FORM_ERROR_DURATION_MS = 6000;

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
  'rename-workspace',
  'leave-workspace',
  'delete-workspace',
  'create-invite',
  'copy-invite-link',
  'resend-invite',
  'cancel-invite',
  'remove-member',
  'promote-member',
  'update-profile',
  'logout'
]);

const workspaceForm = reactive({
  name: ''
});
const profileForm = reactive({
  name: '',
  currentPassword: '',
  newPassword: '',
  confirmPassword: ''
});
const inviteEmail = ref('');
const inviteFormError = ref('');
const lastInviteUrl = ref('');
const lastInviteNotice = ref('');
const lastInviteNoticeTone = ref('muted');
const activeInviteId = ref(null);
const activeMemberId = ref(null);
const promoteMemberTarget = ref(null);
const removeMemberTarget = ref(null);
const cancelInviteTarget = ref(null);
const latestInviteLinkCardRef = ref(null);
const latestInviteCopied = ref(false);
const modalMode = ref('');
const modalError = ref('');
const inviteActionFeedback = reactive({});
const inviteActionTimers = new Map();
let latestInviteCopyTimer = null;
let inviteFormErrorTimer = null;

const currentWorkspaceName = computed(() => (
  props.workspace?.name
  || props.memberships.find((membership) => Number(membership.id) === Number(props.workspaceId))?.name
  || 'Workspace'
));
const canRenameWorkspace = computed(() => props.role === 'owner');
const canDeleteWorkspace = computed(() => props.role === 'owner' && props.memberCount <= 1);
const canLeaveWorkspace = computed(() => props.role === 'member' || (props.role === 'owner' && props.memberCount > 1));
const ownerMustTransfer = computed(() => props.role === 'owner' && props.memberCount > 1 && props.ownerCount < 2);
const canManageMembers = computed(() => props.role === 'owner');
const canCreateInvite = computed(() => props.role === 'owner' || props.role === 'member');
const canChangePassword = computed(() => Boolean(props.currentUser?.hasPassword));
const profileCreatedAtLabel = computed(() => {
  const createdAt = props.currentUser?.createdAt;
  return createdAt ? new Date(createdAt).toLocaleDateString() : 'Unknown';
});
const profileAuthMethods = computed(() => {
  const methods = [];

  if (props.currentUser?.hasPassword) methods.push('Email + password');
  if (props.currentUser?.hasGoogle) methods.push('Google');
  if (props.currentUser?.hasApple) methods.push('Apple');

  return methods.length ? methods : ['Email'];
});

function resetProfileForm() {
  profileForm.name = props.currentUser?.name || '';
  profileForm.currentPassword = '';
  profileForm.newPassword = '';
  profileForm.confirmPassword = '';
}

function handleAccountProfile() {
  if (props.pending) return;

  resetProfileForm();
  modalMode.value = 'account-profile';
  modalError.value = '';
}

function handleManageWorkspace() {
  modalMode.value = 'manage-workspace';
  modalError.value = '';
}

function handleCreateWorkspace() {
  modalMode.value = 'create-workspace';
  workspaceForm.name = '';
  modalError.value = '';
}

function handleRenameWorkspace() {
  modalMode.value = 'rename-workspace';
  workspaceForm.name = currentWorkspaceName.value;
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
  resetProfileForm();
  modalMode.value = '';
  modalError.value = '';
  promoteMemberTarget.value = null;
  removeMemberTarget.value = null;
  cancelInviteTarget.value = null;
}

function submitCreateWorkspace() {
  if (!workspaceForm.name.trim()) {
    modalError.value = 'Workspace name is required.';
    return;
  }

  emit('create-workspace', workspaceForm.name.trim());
  closeModal();
}

function submitRenameWorkspace() {
  const nextName = workspaceForm.name.trim();
  if (!nextName) {
    modalError.value = 'Workspace name is required.';
    return;
  }

  if (nextName === currentWorkspaceName.value) {
    closeModal();
    return;
  }

  emit('rename-workspace', nextName);
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

function submitProfile() {
  const nextName = profileForm.name.trim();
  const wantsPasswordChange = Boolean(
    profileForm.currentPassword
    || profileForm.newPassword
    || profileForm.confirmPassword
  );

  if (nextName.length < 2 || nextName.length > 60) {
    modalError.value = 'Name must be between 2 and 60 characters.';
    return;
  }

  if (wantsPasswordChange) {
    if (!canChangePassword.value) {
      modalError.value = 'Password changes are unavailable for this sign-in method.';
      return;
    }

    if (!profileForm.currentPassword) {
      modalError.value = 'Enter your current password.';
      return;
    }

    if (!profileForm.newPassword) {
      modalError.value = 'Enter a new password.';
      return;
    }

    if (!profileForm.confirmPassword) {
      modalError.value = 'Please retype your new password.';
      return;
    }

    if (profileForm.newPassword !== profileForm.confirmPassword) {
      modalError.value = 'New passwords do not match.';
      return;
    }
  }

  if (!wantsPasswordChange && nextName === (props.currentUser?.name || '')) {
    closeModal();
    return;
  }

  modalError.value = '';
  emit(
    'update-profile',
    {
      name: nextName,
      currentPassword: wantsPasswordChange ? profileForm.currentPassword : '',
      newPassword: wantsPasswordChange ? profileForm.newPassword : ''
    },
    () => {
      closeModal();
    },
    (message) => {
      modalError.value = message || 'Could not update your profile.';
    }
  );
}

function applyInviteResult(result = {}) {
  clearInviteFormError();
  lastInviteUrl.value = result.invite?.inviteUrl || '';
  lastInviteNotice.value = result.notice || result.invite?.emailDelivery?.message || 'Invite link ready.';
  lastInviteNoticeTone.value = result.tone || (result.invite?.emailDelivery?.ok ? 'success' : 'warning');

  if (lastInviteUrl.value) {
    queueLatestInviteLinkScroll();
  }
}

function submitInvite() {
  const nextEmail = inviteEmail.value.trim();
  if (!nextEmail) return;

  clearInviteFormError();
  emit('create-invite', nextEmail, (invite) => {
    applyInviteResult({ invite });
    inviteEmail.value = '';
  }, (message) => {
    setInviteFormError(message || 'Could not send invite.');
  });
}

async function copyLatestInvite() {
  if (!lastInviteUrl.value) return;
  await navigator.clipboard.writeText(lastInviteUrl.value);
  startLatestInviteCopyFeedback();
}

function clearLatestInviteLink() {
  lastInviteUrl.value = '';
  lastInviteNotice.value = '';
  lastInviteNoticeTone.value = 'muted';
  latestInviteCopied.value = false;

  if (latestInviteCopyTimer) {
    window.clearTimeout(latestInviteCopyTimer);
    latestInviteCopyTimer = null;
  }
}

function queueLatestInviteLinkScroll() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  if (!window.matchMedia('(max-width: 720px)').matches) return;

  nextTick(() => {
    latestInviteLinkCardRef.value?.scrollIntoView({
      behavior: 'smooth',
      block: 'start'
    });
  });
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
    startInviteActionFeedback(invite.id, 'copy');
  });
}

function resendInvite(invite) {
  emit('resend-invite', invite, (result) => {
    applyInviteResult(result);
    startInviteActionFeedback(invite.id, 'resend');
  });
}

function handleCancelInvite(invite) {
  cancelInviteTarget.value = invite;
  modalMode.value = 'cancel-invite';
  modalError.value = '';
}

function confirmCancelInvite() {
  if (!cancelInviteTarget.value) return;

  const invite = cancelInviteTarget.value;
  emit('cancel-invite', invite, () => {
    clearLatestInviteLink();
    lastInviteNotice.value = `Invite canceled for ${invite.email}.`;
    lastInviteNoticeTone.value = 'warning';
    activeInviteId.value = null;
    closeModal();
  });
}

function canRemoveMember(member) {
  return canManageMembers.value && member.id !== props.currentUser?.id && member.role !== 'owner';
}

function canPromoteMember(member) {
  return canManageMembers.value && member.id !== props.currentUser?.id && member.role !== 'owner';
}

function canManageMember(member) {
  return canRemoveMember(member) || canPromoteMember(member);
}

function handlePromoteMember(member) {
  promoteMemberTarget.value = member;
  modalMode.value = 'promote-member';
  modalError.value = '';
}

function confirmPromoteMember() {
  if (!promoteMemberTarget.value) return;

  const member = promoteMemberTarget.value;
  emit('promote-member', member, () => {
    lastInviteNotice.value = `${member.name} is now an owner.`;
    lastInviteNoticeTone.value = 'success';
    activeMemberId.value = null;
    closeModal();
  });
}

function handleRemoveMember(member) {
  removeMemberTarget.value = member;
  modalMode.value = 'remove-member';
  modalError.value = '';
}

function confirmRemoveMember() {
  if (!removeMemberTarget.value) return;

  const member = removeMemberTarget.value;
  emit('remove-member', member, () => {
    lastInviteNotice.value = `${member.name} was removed from the workspace.`;
    lastInviteNoticeTone.value = 'warning';
    activeMemberId.value = null;
    closeModal();
  });
}

function formatEmailPreview(email) {
  const value = String(email || '');
  return value.length > EMAIL_PREVIEW_LIMIT ? `${value.slice(0, EMAIL_PREVIEW_LIMIT)}...` : value;
}

function inviteActionFeedbackKey(inviteId, action) {
  return `${action}:${inviteId}`;
}

function startInviteActionFeedback(inviteId, action) {
  const key = inviteActionFeedbackKey(inviteId, action);
  inviteActionFeedback[key] = true;

  const existingTimer = inviteActionTimers.get(key);
  if (existingTimer) {
    window.clearTimeout(existingTimer);
  }

  const timer = window.setTimeout(() => {
    delete inviteActionFeedback[key];
    inviteActionTimers.delete(key);
  }, ACTION_FEEDBACK_DURATION_MS);

  inviteActionTimers.set(key, timer);
}

function hasInviteActionFeedback(inviteId, action) {
  return Boolean(inviteActionFeedback[inviteActionFeedbackKey(inviteId, action)]);
}

function getInviteCopyLabel(inviteId) {
  return hasInviteActionFeedback(inviteId, 'copy') ? 'Link copied' : 'Copy link';
}

function getInviteResendLabel(inviteId) {
  return hasInviteActionFeedback(inviteId, 'resend') ? 'Sent!' : 'Resend';
}

function startLatestInviteCopyFeedback() {
  latestInviteCopied.value = true;

  if (latestInviteCopyTimer) {
    window.clearTimeout(latestInviteCopyTimer);
  }

  latestInviteCopyTimer = window.setTimeout(() => {
    latestInviteCopied.value = false;
    latestInviteCopyTimer = null;
  }, ACTION_FEEDBACK_DURATION_MS);
}

function clearInviteFormError() {
  inviteFormError.value = '';

  if (inviteFormErrorTimer) {
    window.clearTimeout(inviteFormErrorTimer);
    inviteFormErrorTimer = null;
  }
}

function setInviteFormError(message) {
  clearInviteFormError();
  inviteFormError.value = message;

  inviteFormErrorTimer = window.setTimeout(() => {
    inviteFormError.value = '';
    inviteFormErrorTimer = null;
  }, INVITE_FORM_ERROR_DURATION_MS);
}

onBeforeUnmount(() => {
  for (const timer of inviteActionTimers.values()) {
    window.clearTimeout(timer);
  }
  inviteActionTimers.clear();

  if (latestInviteCopyTimer) {
    window.clearTimeout(latestInviteCopyTimer);
    latestInviteCopyTimer = null;
  }

  if (inviteFormErrorTimer) {
    window.clearTimeout(inviteFormErrorTimer);
    inviteFormErrorTimer = null;
  }
});
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
      <section
        class="workspace-section workspace-account-card clickable"
        role="button"
        :tabindex="pending ? -1 : 0"
        :aria-disabled="pending"
        @click="handleAccountProfile"
        @keydown.enter.prevent="handleAccountProfile"
        @keydown.space.prevent="handleAccountProfile"
      >
        <p class="eyebrow">Account</p>
        <strong>{{ currentUser?.name || 'Unknown user' }}</strong>
        <small class="subtle">{{ currentUser?.email }}</small>
        <small class="workspace-account-card-hint">View and edit profile</small>
      </section>

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
          <button type="button" class="ghost-button muted-button" :disabled="pending" @click="handleManageWorkspace">Manage workspace</button>
        </div>
      </section>

      <section class="workspace-section">
        <div class="workspace-section-header">
          <div>
            <p class="eyebrow">Members</p>
            <h2>People in this workspace</h2>
          </div>
          <small class="subtle">{{ memberCount }} total</small>
        </div>

        <form v-if="canCreateInvite" class="invite-form" @submit.prevent="submitInvite">
          <input v-model="inviteEmail" type="email" placeholder="Add a teammate by email" :disabled="pending" />
          <button type="submit" :disabled="pending || !inviteEmail.trim()">Send Invite</button>
          <p v-if="inviteFormError" class="form-error">{{ inviteFormError }}</p>
        </form>

        <div class="member-list">
          <div
            v-for="member in members"
            :key="member.id"
            class="member-row"
            :class="{ active: activeMemberId === member.id, clickable: canManageMember(member) }"
            :role="canManageMember(member) ? 'button' : undefined"
            :tabindex="canManageMember(member) ? 0 : undefined"
            @click="canManageMember(member) && toggleMemberActions(member.id)"
            @keydown.enter.prevent="canManageMember(member) && toggleMemberActions(member.id)"
            @keydown.space.prevent="canManageMember(member) && toggleMemberActions(member.id)"
          >
            <div v-if="canManageMember(member)" class="member-summary">
              <strong>{{ member.name }}</strong>
              <small class="member-email" :title="member.email">{{ formatEmailPreview(member.email) }}</small>
            </div>
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
                @click.stop="handlePromoteMember(member)"
              >
                Make owner
              </button>
              <button
                v-if="canRemoveMember(member)"
                type="button"
                class="ghost-danger"
                :disabled="pending"
                @click.stop="handleRemoveMember(member)"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      </section>

      <section v-if="lastInviteUrl" class="workspace-section">
        <div ref="latestInviteLinkCardRef" class="invite-link-card">
          <p class="subtle">Latest invite link</p>
          <input :value="lastInviteUrl" readonly />
          <p class="invite-feedback" :class="lastInviteNoticeTone">{{ lastInviteNotice }}</p>
          <button
            class="ghost-button muted-button"
            :class="{ 'button-feedback-active': latestInviteCopied }"
            :disabled="pending"
            @click="copyLatestInvite"
          >
            {{ latestInviteCopied ? 'Link copied' : 'Copy link' }}
          </button>
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
            :class="{ active: activeInviteId === invite.id, clickable: true }"
            role="button"
            tabindex="0"
            @click="toggleInviteActions(invite.id)"
            @keydown.enter.prevent="toggleInviteActions(invite.id)"
            @keydown.space.prevent="toggleInviteActions(invite.id)"
          >
            <div class="invite-row-header">
              <div class="invite-summary">
                <strong class="invite-email">{{ invite.email }}</strong>
              </div>
              <small class="member-role invite-role">{{ invite.role }}</small>
            </div>
            <div class="invite-row-meta">
              <span class="invite-status">Pending invite</span>
              <span>Expires {{ new Date(invite.expiresAt).toLocaleString() }}</span>
            </div>
            <div v-if="activeInviteId === invite.id" class="invite-actions">
              <button
                type="button"
                class="ghost-button muted-button"
                :class="{ 'button-feedback-active': hasInviteActionFeedback(invite.id, 'copy') }"
                :disabled="pending"
                @click.stop="copyInviteLink(invite)"
              >
                {{ getInviteCopyLabel(invite.id) }}
              </button>
              <button
                type="button"
                class="ghost-button muted-button"
                :class="{ 'button-feedback-active': hasInviteActionFeedback(invite.id, 'resend') }"
                :disabled="pending"
                @click.stop="resendInvite(invite)"
              >
                {{ getInviteResendLabel(invite.id) }}
              </button>
              <button type="button" class="ghost-danger" :disabled="pending" @click.stop="handleCancelInvite(invite)">Cancel</button>
            </div>
          </div>
        </div>
      </section>
    </div>
  </aside>

  <div v-if="modalMode" class="modal-backdrop" @click.self="closeModal">
    <section class="panel action-modal" :class="{ 'action-modal-wide': modalMode === 'account-profile' }">
      <template v-if="modalMode === 'account-profile'">
        <form class="modal-form-stack" @submit.prevent="submitProfile">
          <div>
            <p class="eyebrow">Account profile</p>
            <h2>{{ currentUser?.name || 'Your account' }}</h2>
            <p class="subtle">Review your profile details and update your display name or password.</p>
          </div>

          <div class="profile-summary-grid">
            <div class="profile-summary-card">
              <small class="eyebrow">Email</small>
              <strong>{{ currentUser?.email || 'Unknown email' }}</strong>
            </div>

            <div class="profile-summary-card">
              <small class="eyebrow">Sign in with</small>
              <div class="profile-provider-list">
                <span v-for="method in profileAuthMethods" :key="method" class="profile-provider-chip">{{ method }}</span>
              </div>
            </div>

            <div class="profile-summary-card">
              <small class="eyebrow">Member since</small>
              <strong>{{ profileCreatedAtLabel }}</strong>
            </div>
          </div>

          <div class="modal-form">
            <label class="modal-form-field">
              <span class="modal-form-label">Display name</span>
              <input
                v-model="profileForm.name"
                type="text"
                placeholder="Your name"
                autocomplete="name"
                :disabled="pending"
                minlength="2"
                maxlength="60"
              />
            </label>
          </div>

          <div class="profile-password-panel">
            <div>
              <p class="eyebrow">Password</p>
              <p class="subtle">
                {{ canChangePassword
                  ? 'Leave these blank to keep your current password.'
                  : 'This account uses social sign-in, so password changes are unavailable here.' }}
              </p>
            </div>

            <div v-if="canChangePassword" class="modal-form">
              <label class="modal-form-field">
                <span class="modal-form-label">Current password</span>
                <input
                  v-model="profileForm.currentPassword"
                  type="password"
                  placeholder="Current password"
                  autocomplete="current-password"
                  :disabled="pending"
                />
              </label>

              <label class="modal-form-field">
                <span class="modal-form-label">New password</span>
                <input
                  v-model="profileForm.newPassword"
                  type="password"
                  placeholder="New password"
                  autocomplete="new-password"
                  :disabled="pending"
                />
              </label>

              <label class="modal-form-field">
                <span class="modal-form-label">Retype new password</span>
                <input
                  v-model="profileForm.confirmPassword"
                  type="password"
                  placeholder="Retype new password"
                  autocomplete="new-password"
                  :disabled="pending"
                />
              </label>
            </div>
          </div>

          <p v-if="modalError" class="form-error">{{ modalError }}</p>

          <div class="modal-actions">
            <button class="ghost-button muted-button" type="button" :disabled="pending" @click="closeModal">Cancel</button>
            <button class="ghost-button" type="submit" :disabled="pending">Save profile</button>
          </div>
        </form>
      </template>

      <template v-else-if="modalMode === 'manage-workspace'">
        <div>
          <p class="eyebrow">Workspace actions</p>
          <h2>Manage {{ currentWorkspaceName }}</h2>
          <p class="subtle">Choose the next action for this workspace or start a new one.</p>
        </div>

        <div class="workspace-option-grid">
          <button
            v-if="canRenameWorkspace"
            type="button"
            class="workspace-option-card"
            :disabled="pending"
            @click="handleRenameWorkspace"
          >
            <strong>Rename workspace</strong>
            <small>Update the workspace name for everyone.</small>
          </button>

          <button
            type="button"
            class="workspace-option-card"
            :disabled="pending"
            @click="handleCreateWorkspace"
          >
            <strong>New workspace</strong>
            <small>Create a separate workspace with fresh default lists.</small>
          </button>

          <button
            v-if="canLeaveWorkspace"
            type="button"
            class="workspace-option-card"
            :disabled="pending"
            @click="handleLeaveWorkspace"
          >
            <strong>Leave workspace</strong>
            <small>{{ ownerMustTransfer ? 'Promote another owner before leaving.' : 'Remove this workspace from your account.' }}</small>
          </button>

          <button
            v-else-if="canDeleteWorkspace"
            type="button"
            class="workspace-option-card workspace-option-card-danger"
            :disabled="pending"
            @click="handleDeleteWorkspace"
          >
            <strong>Delete workspace</strong>
            <small>Permanently remove the workspace and all of its data.</small>
          </button>
        </div>

        <div class="modal-actions modal-actions-single">
          <button class="ghost-button muted-button" type="button" :disabled="pending" @click="closeModal">Close</button>
        </div>
      </template>

      <template v-else-if="modalMode === 'rename-workspace'">
        <form class="modal-form-stack" @submit.prevent="submitRenameWorkspace">
          <div>
            <p class="eyebrow">Rename workspace</p>
            <h2>Update {{ currentWorkspaceName }}</h2>
            <p class="subtle">Owners can rename this workspace for everyone.</p>
          </div>

          <div class="modal-form">
            <input v-model="workspaceForm.name" type="text" placeholder="Workspace name" :disabled="pending" />
            <p v-if="modalError" class="form-error">{{ modalError }}</p>
          </div>

          <div class="modal-actions">
            <button class="ghost-button muted-button" type="button" :disabled="pending" @click="closeModal">Cancel</button>
            <button class="ghost-button" type="submit" :disabled="pending">Save name</button>
          </div>
        </form>
      </template>

      <template v-else-if="modalMode === 'create-workspace'">
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

      <template v-else-if="modalMode === 'promote-member' && promoteMemberTarget">
        <div>
          <p class="eyebrow">Promote member</p>
          <h2>Make {{ promoteMemberTarget.name }} an owner?</h2>
          <p class="subtle">Owners can manage members and rename this workspace.</p>
        </div>

        <div class="modal-actions">
          <button class="ghost-button muted-button" type="button" :disabled="pending" @click="closeModal">Cancel</button>
          <button class="ghost-button" type="button" :disabled="pending" @click="confirmPromoteMember">
            Make owner
          </button>
        </div>
      </template>

      <template v-else-if="modalMode === 'remove-member' && removeMemberTarget">
        <div>
          <p class="eyebrow">Remove member</p>
          <h2>Remove {{ removeMemberTarget.name }} from this workspace?</h2>
          <p class="subtle">They will lose access immediately and will need a new invite to rejoin.</p>
        </div>

        <div class="modal-actions">
          <button class="ghost-button muted-button" type="button" :disabled="pending" @click="closeModal">Keep member</button>
          <button class="ghost-danger" type="button" :disabled="pending" @click="confirmRemoveMember">Remove member</button>
        </div>
      </template>

      <template v-else-if="modalMode === 'cancel-invite' && cancelInviteTarget">
        <div>
          <p class="eyebrow">Cancel invite</p>
          <h2>Cancel the invite for {{ cancelInviteTarget.email }}?</h2>
          <p class="subtle">That invite link will stop working. You can send a new invite later if needed.</p>
        </div>

        <div class="modal-actions">
          <button class="ghost-button muted-button" type="button" :disabled="pending" @click="closeModal">Keep invite</button>
          <button class="ghost-danger" type="button" :disabled="pending" @click="confirmCancelInvite">Cancel invite</button>
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
