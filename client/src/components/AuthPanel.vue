<script setup>
import { reactive, ref, watch } from 'vue';

const props = defineProps({
  invite: {
    type: Object,
    default: null
  },
  googleEnabled: {
    type: Boolean,
    default: false
  },
  errorMessage: {
    type: String,
    default: ''
  },
  errorForMode: {
    type: String,
    default: ''
  },
  pending: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits(['submit', 'google']);

const mode = ref('login');
const form = reactive({
  name: '',
  email: '',
  password: '',
  workspaceName: ''
});

const errorMode = ref('');

watch(
  () => props.invite?.email,
  (email) => {
    if (email) {
      form.email = email;
    }
  },
  { immediate: true }
);

watch(
  () => props.invite?.hasAccount,
  (hasAccount) => {
    if (props.invite) {
      mode.value = hasAccount ? 'login' : 'register';
    }
  },
  { immediate: true }
);

watch(
  () => props.errorForMode,
  (value) => {
    errorMode.value = value || '';
  },
  { immediate: true }
);

function submit() {
  if (mode.value === 'register') {
    const trimmedName = form.name.trim();
    if (trimmedName.length < 2 || trimmedName.length > 60) {
      errorMode.value = 'register';
      emit('submit', {
        mode: 'validation-error',
        error: 'Name must be between 2 and 60 characters.'
      });
      return;
    }
  }

  emit('submit', {
    mode: mode.value,
    inviteToken: mode.value === 'register' ? props.invite?.token || null : null,
    ...form,
    name: form.name.trim()
  });
}
</script>

<template>
  <section class="auth-shell panel">
    <div class="auth-copy">
      <p class="eyebrow">Realtime team workspace</p>
      <h1>Vue + Postgres + WebSockets</h1>
      <p>
        Sign in to your workspace or create a new one. The backend now owns auth,
        membership, and realtime updates instead of Firebase.
      </p>
      <p v-if="invite" class="invite-banner">
        Invitation for <strong>{{ invite.email }}</strong> to join <strong>{{ invite.workspaceName }}</strong>.
      </p>
    </div>

    <div class="auth-card">
      <div class="auth-toggle">
        <button type="button" :class="{ active: mode === 'login' }" @click="mode = 'login'">Login</button>
        <button type="button" :class="{ active: mode === 'register' }" @click="mode = 'register'">Register</button>
      </div>

      <button
        v-if="googleEnabled"
        type="button"
        class="oauth-button"
        :disabled="pending"
        @click="emit('google')"
      >
        Continue with Google
      </button>
      <p v-if="errorMessage && errorForMode === 'google'" class="form-error">{{ errorMessage }}</p>
      <div v-if="googleEnabled" class="auth-separator">
        <span>or use email</span>
      </div>

      <form class="auth-form" @submit.prevent="submit">
        <input
          v-if="mode === 'register'"
          v-model="form.name"
          type="text"
          placeholder="Your name"
          minlength="2"
          maxlength="60"
        />
        <input v-model="form.email" :readonly="Boolean(invite?.email)" type="email" placeholder="Email" />
        <input v-model="form.password" type="password" placeholder="Password" :disabled="pending" />
        <input
          v-if="mode === 'register' && !invite"
          v-model="form.workspaceName"
          type="text"
          placeholder="Workspace name"
        />
        <p v-if="errorMessage && (!errorMode || errorMode === mode)" class="form-error">{{ errorMessage }}</p>
        <button type="submit" :disabled="pending">{{ mode === 'login' ? (invite ? 'Continue to invite' : 'Enter workspace') : (invite ? 'Create account to continue' : 'Create account') }}</button>
      </form>
    </div>
  </section>
</template>
