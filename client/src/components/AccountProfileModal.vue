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

const emit = defineEmits(['close', 'update-profile', 'logout']);

const profileForm = reactive({
  name: '',
  currentPassword: '',
  newPassword: '',
  confirmPassword: ''
});
const modalError = ref('');
let previousBodyOverflow = '';
let bodyScrollLocked = false;

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

        <div class="modal-actions modal-actions-single">
          <button class="ghost-danger" type="button" :disabled="pending" @click="emit('logout')">Logout</button>
        </div>
      </form>
    </section>
  </div>
</template>
