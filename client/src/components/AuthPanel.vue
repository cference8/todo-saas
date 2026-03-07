<script setup>
import { reactive, ref } from 'vue';

const emit = defineEmits(['submit']);

const mode = ref('login');
const form = reactive({
  name: '',
  email: '',
  password: '',
  workspaceName: ''
});

function submit() {
  emit('submit', {
    mode: mode.value,
    ...form
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
    </div>

    <div class="auth-card">
      <div class="auth-toggle">
        <button :class="{ active: mode === 'login' }" @click="mode = 'login'">Login</button>
        <button :class="{ active: mode === 'register' }" @click="mode = 'register'">Register</button>
      </div>

      <form class="auth-form" @submit.prevent="submit">
        <input v-if="mode === 'register'" v-model="form.name" type="text" placeholder="Your name" />
        <input v-model="form.email" type="email" placeholder="Email" />
        <input v-model="form.password" type="password" placeholder="Password" />
        <input
          v-if="mode === 'register'"
          v-model="form.workspaceName"
          type="text"
          placeholder="Workspace name"
        />
        <button type="submit">{{ mode === 'login' ? 'Enter workspace' : 'Create account' }}</button>
      </form>
    </div>
  </section>
</template>
