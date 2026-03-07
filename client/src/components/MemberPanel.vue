<script setup>
import { computed, ref } from 'vue';

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

const emit = defineEmits(['create-invite', 'logout']);
const inviteEmail = ref('');
const lastInviteUrl = ref('');

const canInvite = computed(() => props.role === 'owner');

function submitInvite() {
  if (!inviteEmail.value.trim()) return;
  emit('create-invite', inviteEmail.value.trim(), (inviteUrl) => {
    lastInviteUrl.value = inviteUrl;
  });
  inviteEmail.value = '';
}

async function copyLatestInvite() {
  if (!lastInviteUrl.value) return;
  await navigator.clipboard.writeText(lastInviteUrl.value);
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
      <div v-for="member in members" :key="member.id" class="member-row">
        <span>
          <strong>{{ member.name }}</strong>
          <small>{{ member.email }}</small>
        </span>
        <small>{{ member.role }}</small>
      </div>
    </div>

    <form v-if="canInvite" class="invite-form" @submit.prevent="submitInvite">
      <input v-model="inviteEmail" type="email" placeholder="Invite teammate by email" :disabled="pending" />
      <button type="submit" :disabled="pending || !inviteEmail.trim()">Create invite</button>
    </form>

    <div v-if="lastInviteUrl" class="invite-link-card">
      <p class="subtle">Latest invite link</p>
      <input :value="lastInviteUrl" readonly />
      <button class="ghost-button muted-button" :disabled="pending" @click="copyLatestInvite">Copy link</button>
    </div>

    <div v-if="invites.length" class="member-list">
      <div v-for="invite in invites" :key="invite.id" class="member-row">
        <span>
          <strong>{{ invite.email }}</strong>
          <small>Pending invite • expires {{ new Date(invite.expiresAt).toLocaleString() }}</small>
        </span>
        <small>{{ invite.role }}</small>
      </div>
    </div>
  </aside>
</template>
