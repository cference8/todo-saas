<script setup>
import { computed, reactive, ref, watch } from 'vue';

const props = defineProps({
  invite: {
    type: Object,
    default: null
  },
  googleEnabled: {
    type: Boolean,
    default: false
  },
  appleEnabled: {
    type: Boolean,
    default: false
  },
  theme: {
    type: String,
    default: 'light'
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

const emit = defineEmits(['submit', 'google', 'apple']);

const mode = ref('login');
const form = reactive({
  name: '',
  email: '',
  password: '',
  confirmPassword: '',
  workspaceName: ''
});

const errorMode = ref('');
const showPassword = ref(false);
const lastSuggestedWorkspaceName = ref('');
const googleButtonAsset = computed(() => (
  mode.value === 'register'
    ? `/google-imgs/svg/${props.theme}/web_${props.theme}_rd_SU.svg`
    : `/google-imgs/svg/${props.theme}/web_${props.theme}_rd_SI.svg`
));
const googleButtonLabel = computed(() => (mode.value === 'register' ? 'Sign up with Google' : 'Sign in with Google'));

function defaultWorkspaceNameFor(name) {
  const firstName = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)[0];

  return firstName ? `${firstName}'s Workspace` : '';
}

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
  () => [form.name, Boolean(props.invite)],
  ([name, hasInvite]) => {
    if (hasInvite) {
      return;
    }

    const nextSuggestedWorkspaceName = defaultWorkspaceNameFor(name);
    if (!form.workspaceName || form.workspaceName === lastSuggestedWorkspaceName.value) {
      form.workspaceName = nextSuggestedWorkspaceName;
    }

    lastSuggestedWorkspaceName.value = nextSuggestedWorkspaceName;
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

watch(mode, (value) => {
  if (value !== 'register') {
    form.confirmPassword = '';
  }
});

function emitValidationError(error) {
  errorMode.value = 'register';
  emit('submit', {
    mode: 'validation-error',
    error
  });
}

function submit() {
  if (mode.value === 'register') {
    const trimmedName = form.name.trim();
    if (trimmedName.length < 2 || trimmedName.length > 60) {
      emitValidationError('Name must be between 2 and 60 characters.');
      return;
    }

    if (!form.confirmPassword) {
      emitValidationError('Please retype your password.');
      return;
    }

    if (form.password !== form.confirmPassword) {
      emitValidationError('Passwords do not match.');
      return;
    }

  }

  emit('submit', {
    mode: mode.value,
    inviteToken: mode.value === 'register' ? props.invite?.token || null : null,
    name: form.name.trim(),
    email: form.email.trim(),
    password: form.password,
    workspaceName: mode.value === 'register' && !props.invite ? form.workspaceName.trim() : ''
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

      <div v-if="googleEnabled || appleEnabled" class="oauth-actions">
        <button
          v-if="googleEnabled"
          type="button"
          class="oauth-button google"
          :aria-label="googleButtonLabel"
          :disabled="pending"
          @click="emit('google')"
        >
          <img class="oauth-google-image" :src="googleButtonAsset" alt="" aria-hidden="true" />
        </button>
        <button
          v-if="appleEnabled"
          type="button"
          class="oauth-button apple"
          :disabled="pending"
          @click="emit('apple')"
        >
          Continue with Apple
        </button>
      </div>
      <p v-if="errorMessage && (errorForMode === 'google' || errorForMode === 'apple')" class="form-error">{{ errorMessage }}</p>
      <div v-if="googleEnabled || appleEnabled" class="auth-separator">
        <span>or use email</span>
      </div>

      <form class="auth-form" @submit.prevent="submit">
        <input
          v-if="mode === 'register'"
          v-model="form.name"
          type="text"
          placeholder="Your name"
          autocomplete="name"
          :disabled="pending"
          minlength="2"
          maxlength="60"
          required
        />
        <input
          v-model="form.email"
          :readonly="Boolean(invite?.email)"
          type="email"
          placeholder="Email"
          autocomplete="email"
          :disabled="pending"
          required
        />
        <div class="auth-password-field auth-password-field-with-toggle">
          <input
            v-model="form.password"
            :type="showPassword ? 'text' : 'password'"
            placeholder="Password"
            :disabled="pending"
            :autocomplete="mode === 'register' ? 'new-password' : 'current-password'"
            required
          />
          <button
            type="button"
            class="auth-password-toggle"
            :aria-label="showPassword ? 'Hide password' : 'Show password'"
            :aria-pressed="showPassword"
            :disabled="pending"
            @click="showPassword = !showPassword"
          >
            {{ showPassword ? 'Hide' : 'Show' }}
          </button>
        </div>
        <div v-if="mode === 'register'" class="auth-password-field">
          <input
            v-model="form.confirmPassword"
            :type="showPassword ? 'text' : 'password'"
            placeholder="Retype password"
            :disabled="pending"
            autocomplete="new-password"
            required
          />
        </div>
        <input
          v-if="mode === 'register' && !invite"
          v-model="form.workspaceName"
          type="text"
          placeholder="Workspace name"
          autocomplete="organization"
          :disabled="pending"
        />
        <p v-if="errorMessage && (!errorMode || errorMode === mode)" class="form-error">{{ errorMessage }}</p>
        <button type="submit" class="auth-submit-button" :disabled="pending">
          {{ mode === 'login' ? (invite ? 'Continue to invite' : 'Enter workspace') : (invite ? 'Create account to continue' : 'Create account') }}
        </button>
      </form>
    </div>
  </section>
</template>
