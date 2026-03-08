<script setup>
import { computed, reactive, ref, watch } from 'vue';

const LOGIN_MODE = 'login';
const REGISTER_MODE = 'register';
const FORGOT_PASSWORD_MODE = 'forgot-password';
const RESET_PASSWORD_MODE = 'reset-password';

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
  },
  resetToken: {
    type: String,
    default: ''
  },
  noticeMessage: {
    type: String,
    default: ''
  },
  noticeForMode: {
    type: String,
    default: ''
  },
  noticeTone: {
    type: String,
    default: 'success'
  }
});

const emit = defineEmits(['submit', 'google', 'apple', 'clear-reset']);

const mode = ref(LOGIN_MODE);
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
const isLoginMode = computed(() => mode.value === LOGIN_MODE);
const isRegisterMode = computed(() => mode.value === REGISTER_MODE);
const isForgotPasswordMode = computed(() => mode.value === FORGOT_PASSWORD_MODE);
const isResetPasswordMode = computed(() => mode.value === RESET_PASSWORD_MODE);
const showAuthToggle = computed(() => isLoginMode.value || isRegisterMode.value);
const canShowOAuth = computed(() => (
  showAuthToggle.value &&
  (props.googleEnabled || props.appleEnabled)
));
const googleButtonAsset = computed(() => (
  mode.value === REGISTER_MODE
    ? `/google-imgs/svg/${props.theme}/web_${props.theme}_rd_SU.svg`
    : `/google-imgs/svg/${props.theme}/web_${props.theme}_rd_SI.svg`
));
const googleButtonLabel = computed(() => (mode.value === REGISTER_MODE ? 'Sign up with Google' : 'Sign in with Google'));
const passwordPlaceholder = computed(() => (isResetPasswordMode.value ? 'New password' : 'Password'));
const confirmPasswordPlaceholder = computed(() => (isResetPasswordMode.value ? 'Retype new password' : 'Retype password'));
const helperCopy = computed(() => {
  if (isForgotPasswordMode.value) {
    return 'Enter the email you use to sign in and we will send a password link.';
  }

  if (isResetPasswordMode.value) {
    return 'Choose a new password for your account.';
  }

  return '';
});
const submitButtonLabel = computed(() => {
  if (isForgotPasswordMode.value) return 'Send password link';
  if (isResetPasswordMode.value) return 'Save new password';

  return isLoginMode.value
    ? (props.invite ? 'Continue to invite' : 'Enter workspace')
    : (props.invite ? 'Create account to continue' : 'Create account');
});
const noticeToneClass = computed(() => `form-notice-${props.noticeTone === 'warning' ? 'warning' : 'success'}`);

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
    if (props.invite && !props.resetToken && mode.value !== FORGOT_PASSWORD_MODE) {
      mode.value = hasAccount ? LOGIN_MODE : REGISTER_MODE;
    }
  },
  { immediate: true }
);

watch(
  () => props.resetToken,
  (token) => {
    if (token) {
      mode.value = RESET_PASSWORD_MODE;
      errorMode.value = '';
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
  if (value !== REGISTER_MODE && value !== RESET_PASSWORD_MODE) {
    form.confirmPassword = '';
  }

  if (value === FORGOT_PASSWORD_MODE) {
    form.password = '';
    showPassword.value = false;
  }
});

function emitValidationError(error, targetMode = mode.value) {
  errorMode.value = targetMode;
  emit('submit', {
    mode: 'validation-error',
    error,
    forMode: targetMode
  });
}

function openForgotPassword() {
  errorMode.value = '';
  mode.value = FORGOT_PASSWORD_MODE;
}

function returnToLogin() {
  errorMode.value = '';
  form.password = '';
  form.confirmPassword = '';
  mode.value = LOGIN_MODE;

  if (props.resetToken) {
    emit('clear-reset');
  }
}

function submit() {
  if (isForgotPasswordMode.value) {
    if (!form.email.trim()) {
      emitValidationError('Email is required.', FORGOT_PASSWORD_MODE);
      return;
    }

    emit('submit', {
      mode: FORGOT_PASSWORD_MODE,
      email: form.email.trim()
    });
    return;
  }

  if (isResetPasswordMode.value) {
    if (!props.resetToken) {
      emitValidationError('Password reset link is invalid or expired.', RESET_PASSWORD_MODE);
      return;
    }

    if (!form.password) {
      emitValidationError('Enter a new password.', RESET_PASSWORD_MODE);
      return;
    }

    if (!form.confirmPassword) {
      emitValidationError('Please retype your new password.', RESET_PASSWORD_MODE);
      return;
    }

    if (form.password !== form.confirmPassword) {
      emitValidationError('Passwords do not match.', RESET_PASSWORD_MODE);
      return;
    }

    emit('submit', {
      mode: RESET_PASSWORD_MODE,
      resetToken: props.resetToken,
      password: form.password
    });
    return;
  }

  if (isRegisterMode.value) {
    const trimmedName = form.name.trim();
    if (trimmedName.length < 2 || trimmedName.length > 60) {
      emitValidationError('Name must be between 2 and 60 characters.', REGISTER_MODE);
      return;
    }

    if (!form.confirmPassword) {
      emitValidationError('Please retype your password.', REGISTER_MODE);
      return;
    }

    if (form.password !== form.confirmPassword) {
      emitValidationError('Passwords do not match.', REGISTER_MODE);
      return;
    }
  }

  emit('submit', {
    mode: mode.value,
    inviteToken: mode.value === REGISTER_MODE ? props.invite?.token || null : null,
    name: form.name.trim(),
    email: form.email.trim(),
    password: form.password,
    workspaceName: mode.value === REGISTER_MODE && !props.invite ? form.workspaceName.trim() : ''
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
      <div v-if="showAuthToggle" class="auth-toggle">
        <button type="button" :class="{ active: mode === LOGIN_MODE }" @click="mode = LOGIN_MODE">Login</button>
        <button type="button" :class="{ active: mode === REGISTER_MODE }" @click="mode = REGISTER_MODE">Register</button>
      </div>
      <div v-else class="auth-mode-header">
        <p class="eyebrow">{{ isResetPasswordMode ? 'Choose a new password' : 'Reset your password' }}</p>
        <button type="button" class="auth-link-button" :disabled="pending" @click="returnToLogin">Back to login</button>
      </div>

      <p v-if="helperCopy" class="subtle">{{ helperCopy }}</p>

      <div v-if="canShowOAuth" class="oauth-actions">
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
      <div v-if="canShowOAuth" class="auth-separator">
        <span>or use email</span>
      </div>

      <form class="auth-form" @submit.prevent="submit">
        <input
          v-if="isRegisterMode"
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
          v-if="!isResetPasswordMode"
          v-model="form.email"
          :readonly="Boolean(invite?.email)"
          type="email"
          placeholder="Email"
          autocomplete="email"
          :disabled="pending"
          required
        />
        <div v-if="!isForgotPasswordMode" class="auth-password-field auth-password-field-with-toggle">
          <input
            v-model="form.password"
            :type="showPassword ? 'text' : 'password'"
            :placeholder="passwordPlaceholder"
            :disabled="pending"
            :autocomplete="isLoginMode ? 'current-password' : 'new-password'"
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
        <div v-if="isLoginMode" class="auth-inline-actions">
          <button type="button" class="auth-link-button" :disabled="pending" @click="openForgotPassword">Forgot Password?</button>
        </div>
        <div v-if="isRegisterMode || isResetPasswordMode" class="auth-password-field">
          <input
            v-model="form.confirmPassword"
            :type="showPassword ? 'text' : 'password'"
            :placeholder="confirmPasswordPlaceholder"
            :disabled="pending"
            autocomplete="new-password"
            required
          />
        </div>
        <input
          v-if="isRegisterMode && !invite"
          v-model="form.workspaceName"
          type="text"
          placeholder="Workspace name"
          autocomplete="organization"
          :disabled="pending"
        />
        <p
          v-if="noticeMessage && (!noticeForMode || noticeForMode === mode)"
          class="form-notice"
          :class="noticeToneClass"
        >
          {{ noticeMessage }}
        </p>
        <p v-if="errorMessage && (!errorMode || errorMode === mode)" class="form-error">{{ errorMessage }}</p>
        <button type="submit" class="auth-submit-button" :disabled="pending">
          {{ submitButtonLabel }}
        </button>
      </form>
    </div>
  </section>
</template>
