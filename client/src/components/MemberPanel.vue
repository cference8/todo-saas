<script setup>
import { computed, ref } from 'vue';

const EMAIL_PREVIEW_LIMIT = 17;

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
const lastInviteUrl = ref('');
const lastInviteNotice = ref('');
const lastInviteNoticeTone = ref('muted');
const activeInviteId = ref(null);
const activeMemberId = ref(null);
const promoteMemberTarget = ref(null);

const canInvite = computed(() => props.role === 'owner');

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
            @click="removeMember(member)"
          >
            Remove
          </button>
        </div>
      </div>
    </div>

    <form v-if="canInvite" class="invite-form" @submit.prevent="submitInvite">
      <input v-model="inviteEmail" type="email" placeholder="Invite teammate by email" :disabled="pending" />
      <button type="submit" :disabled="pending || !inviteEmail.trim()">Create invite</button>
    </form>

    <div v-if="lastInviteUrl" class="invite-link-card">
      <p class="subtle">Latest invite link</p>
      <input :value="lastInviteUrl" readonly />
      <p class="invite-feedback" :class="lastInviteNoticeTone">{{ lastInviteNotice }}</p>
      <button class="ghost-button muted-button" :disabled="pending" @click="copyLatestInvite">Copy link</button>
    </div>

    <div v-if="invites.length" class="invite-list">
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
  </aside>

  <div v-if="promoteMemberTarget" class="modal-backdrop" @click.self="closePromoteModal">
    <section class="panel action-modal">
      <div>
        <p class="eyebrow">Promote member</p>
        <h2>Make {{ promoteMemberTarget.name }} an owner?</h2>
        <p class="subtle">Owners can invite people, manage members, and rename this workspace.</p>
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
