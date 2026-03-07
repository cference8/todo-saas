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
  role: {
    type: String,
    default: 'member'
  },
  pending: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits(['add-member', 'logout']);
const inviteEmail = ref('');

const canInvite = computed(() => props.role === 'owner');

function submitInvite() {
  if (!inviteEmail.value.trim()) return;
  emit('add-member', inviteEmail.value.trim());
  inviteEmail.value = '';
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
      <input v-model="inviteEmail" type="email" placeholder="Invite by registered email" :disabled="pending" />
      <button type="submit" :disabled="pending || !inviteEmail.trim()">Add member</button>
    </form>
  </aside>
</template>
