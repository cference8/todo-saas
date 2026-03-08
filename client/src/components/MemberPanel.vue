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
    required: true
  },
  invites: {
    type: Array,
    default: () => []
  },
  role: {
    type: String,
    default: 'member'
  },
  pending: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits([
  'create-invite',
  'copy-invite-link',
  'resend-invite',
  'cancel-invite',
  'remove-member',
  'promote-member',
  'logout'
]);
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
const inviteActionFeedback = reactive({});
const inviteActionTimers = new Map();
let latestInviteCopyTimer = null;
let inviteFormErrorTimer = null;

const canManageMembers = computed(() => props.role === 'owner');
const canCreateInvite = computed(() => props.role === 'owner' || props.role === 'member');

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

function closeCancelInviteModal() {
  cancelInviteTarget.value = null;
}

function handleCancelInvite(invite) {
  cancelInviteTarget.value = invite;
}

function confirmCancelInvite() {
  if (!cancelInviteTarget.value) return;

  const invite = cancelInviteTarget.value;
  emit('cancel-invite', invite, () => {
    clearLatestInviteLink();
    lastInviteNotice.value = `Invite canceled for ${invite.email}.`;
    lastInviteNoticeTone.value = 'warning';
    activeInviteId.value = null;
    closeCancelInviteModal();
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

function closePromoteModal() {
  promoteMemberTarget.value = null;
}

function handlePromoteMember(member) {
  promoteMemberTarget.value = member;
}

function confirmPromoteMember() {
  if (!promoteMemberTarget.value) return;

  const member = promoteMemberTarget.value;
  emit('promote-member', member, () => {
    lastInviteNotice.value = `${member.name} is now an owner.`;
    lastInviteNoticeTone.value = 'success';
    activeMemberId.value = null;
    closePromoteModal();
  });
}

function closeRemoveMemberModal() {
  removeMemberTarget.value = null;
}

function handleRemoveMember(member) {
  removeMemberTarget.value = member;
}

function confirmRemoveMember() {
  if (!removeMemberTarget.value) return;

  const member = removeMemberTarget.value;
  emit('remove-member', member, () => {
    lastInviteNotice.value = `${member.name} was removed from the workspace.`;
    lastInviteNoticeTone.value = 'warning';
    activeMemberId.value = null;
    closeRemoveMemberModal();
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
  <aside class="panel member-panel">
    <div class="member-header">
      <div>
        <p class="eyebrow">Session</p>
        <h2>{{ currentUser?.name || 'Unknown user' }}</h2>
        <p class="subtle">{{ currentUser?.email }}</p>
      </div>
      <button class="ghost-danger" @click="emit('logout')">Logout</button>
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
            @click="handlePromoteMember(member)"
          >
            Make owner
          </button>
          <button
            v-if="canRemoveMember(member)"
            type="button"
            class="ghost-danger"
            :disabled="pending"
            @click="handleRemoveMember(member)"
          >
            Remove
          </button>
        </div>
      </div>
    </div>

    <form v-if="canCreateInvite" class="invite-form" @submit.prevent="submitInvite">
      <input v-model="inviteEmail" type="email" placeholder="Invite teammate by email" :disabled="pending" />
      <button type="submit" :disabled="pending || !inviteEmail.trim()">Send Invite</button>
      <p v-if="inviteFormError" class="form-error">{{ inviteFormError }}</p>
    </form>

    <div v-if="lastInviteUrl" ref="latestInviteLinkCardRef" class="invite-link-card">
      <p class="subtle">Latest invite link</p>
      <p class="invite-feedback" :class="lastInviteNoticeTone">{{ lastInviteNotice }}</p>
      <input :value="lastInviteUrl" readonly />
      <button
        class="ghost-button muted-button"
        :class="{ 'button-feedback-active': latestInviteCopied }"
        :disabled="pending"
        @click="copyLatestInvite"
      >
        {{ latestInviteCopied ? 'Link copied' : 'Copy link' }}
      </button>
      <p class="subtle">Texting the link works too.</p>
    </div>

    <div v-if="invites.length" class="invite-list">
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
  </aside>

  <div v-if="cancelInviteTarget" class="modal-backdrop" @click.self="closeCancelInviteModal">
    <section class="panel action-modal">
      <div>
        <p class="eyebrow">Cancel invite</p>
        <h2>Cancel the invite for {{ cancelInviteTarget.email }}?</h2>
        <p class="subtle">That invite link will stop working. You can send a new invite later if needed.</p>
      </div>

      <div class="modal-actions">
        <button class="ghost-button muted-button" type="button" :disabled="pending" @click="closeCancelInviteModal">Keep invite</button>
        <button class="ghost-danger" type="button" :disabled="pending" @click="confirmCancelInvite">Cancel invite</button>
      </div>
    </section>
  </div>

  <div v-if="removeMemberTarget" class="modal-backdrop" @click.self="closeRemoveMemberModal">
    <section class="panel action-modal">
      <div>
        <p class="eyebrow">Remove member</p>
        <h2>Remove {{ removeMemberTarget.name }} from this workspace?</h2>
        <p class="subtle">They will lose access immediately and will need a new invite to rejoin.</p>
      </div>

      <div class="modal-actions">
        <button class="ghost-button muted-button" type="button" :disabled="pending" @click="closeRemoveMemberModal">Keep member</button>
        <button class="ghost-danger" type="button" :disabled="pending" @click="confirmRemoveMember">Remove member</button>
      </div>
    </section>
  </div>

  <div v-if="promoteMemberTarget" class="modal-backdrop" @click.self="closePromoteModal">
    <section class="panel action-modal">
      <div>
        <p class="eyebrow">Promote member</p>
        <h2>Make {{ promoteMemberTarget.name }} an owner?</h2>
        <p class="subtle">Owners can manage members and rename this workspace.</p>
      </div>

      <div class="modal-actions">
        <button class="ghost-button muted-button" type="button" :disabled="pending" @click="closePromoteModal">Cancel</button>
        <button class="ghost-button" type="button" :disabled="pending" @click="confirmPromoteMember">
          Make owner
        </button>
      </div>
    </section>
  </div>
</template>
