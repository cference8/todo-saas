<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';

const props = defineProps({
  currentUser: {
    type: Object,
    default: null
  },
  open: {
    type: Boolean,
    default: false
  },
  pending: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits(['close', 'update-profile']);

const profileForm = reactive({
  name: '',
  currentPassword: '',
  newPassword: '',
  confirmPassword: ''
});
const modalError = ref('');
let previousBodyOverflow = '';
let bodyScrollLocked = false;

const hasPassword = computed(() => Boolean(props.currentUser?.hasPassword));
const hasGoogle = computed(() => Boolean(props.currentUser?.hasGoogle));
const hasApple = computed(() => Boolean(props.currentUser?.hasApple));
const hasSocialLogin = computed(() => hasGoogle.value || hasApple.value);
const socialProviderLabel = computed(() => {
  const providers = [];
  if (hasGoogle.value) providers.push('Google');
  if (hasApple.value) providers.push('Apple');
  return providers.join(' or ');
});
const profileCreatedAtLabel = computed(() => {
  const createdAt = props.currentUser?.createdAt;
  return createdAt ? new Date(createdAt).toLocaleDateString() : 'Unknown';
});
const profileLoginMethods = computed(() => {
  const methods = [];

  if (hasGoogle.value) methods.push('Google connected');
  if (hasApple.value) methods.push('Apple connected');
  methods.push(hasPassword.value ? 'Password set' : 'Password not set');

  return methods;
});
const passwordPanelCopy = computed(() => {
  if (hasPassword.value) {
    return 'Leave these blank to keep your current password.';
  }

  if (hasSocialLogin.value) {
    return `This account signs in with ${socialProviderLabel.value}. Add a password if you also want email + password as a login option.`;
  }

  return 'Set a password for this account.';
});

function resetProfileForm() {
  profileForm.name = props.currentUser?.name || '';
  profileForm.currentPassword = '';
  profileForm.newPassword = '';
  profileForm.confirmPassword = '';
}

function closeModal() {
  modalError.value = '';
  emit('close');
}

function setBodyScrollLocked(locked) {
  if (typeof document === 'undefined') return;

  if (locked) {
    if (bodyScrollLocked) return;
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    bodyScrollLocked = true;
    return;
  }

  if (!bodyScrollLocked) return;
  document.body.style.overflow = previousBodyOverflow;
  bodyScrollLocked = false;
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
    if (!profileForm.newPassword) {
      modalError.value = hasPassword.value ? 'Enter a new password.' : 'Enter a password to add to your account.';
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

    if (hasPassword.value && !profileForm.currentPassword) {
      modalError.value = 'Enter your current password.';
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

watch(
  () => props.open,
  (open) => {
    setBodyScrollLocked(open);

    if (open) {
      modalError.value = '';
      resetProfileForm();
    }
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  setBodyScrollLocked(false);
});
</script>

<template>
  <div v-if="open" class="modal-backdrop modal-backdrop-scrollable" @click.self="closeModal">
    <section class="panel action-modal action-modal-wide action-modal-scrollable">
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
            <small class="eyebrow">Login methods</small>
            <div class="profile-provider-list">
              <span v-for="method in profileLoginMethods" :key="method" class="profile-provider-chip">{{ method }}</span>
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
            <p class="subtle">{{ passwordPanelCopy }}</p>
          </div>

          <div class="modal-form">
            <label v-if="hasPassword" class="modal-form-field">
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
              <span class="modal-form-label">{{ hasPassword ? 'New password' : 'Set password' }}</span>
              <input
                v-model="profileForm.newPassword"
                type="password"
                :placeholder="hasPassword ? 'New password' : 'Create a password'"
                autocomplete="new-password"
                :disabled="pending"
              />
            </label>

            <label class="modal-form-field">
              <span class="modal-form-label">{{ hasPassword ? 'Retype new password' : 'Retype password' }}</span>
              <input
                v-model="profileForm.confirmPassword"
                type="password"
                :placeholder="hasPassword ? 'Retype new password' : 'Retype password'"
                autocomplete="new-password"
                :disabled="pending"
              />
            </label>
          </div>

          <div v-if="!hasPassword" class="profile-password-actions">
            <button class="ghost-button" type="submit" :disabled="pending">Set password</button>
          </div>
        </div>

        <p v-if="modalError" class="form-error">{{ modalError }}</p>

        <div class="modal-actions">
          <button class="ghost-button muted-button" type="button" :disabled="pending" @click="closeModal">Cancel</button>
          <button class="ghost-button" type="submit" :disabled="pending">Save profile</button>
        </div>

      </form>
    </section>
  </div>
</template>
