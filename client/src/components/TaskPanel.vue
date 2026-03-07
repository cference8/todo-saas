<script setup>
import { computed, ref, watch } from 'vue';

const props = defineProps({
  activeList: {
    type: Object,
    default: null
  },
  tasks: {
    type: Array,
    required: true
  },
  pending: {
    type: Boolean,
    default: false
  },
  socketState: {
    type: String,
    required: true
  }
});

const emit = defineEmits(['create-task', 'toggle-task', 'delete-task']);

const draft = ref('');

const completionRate = computed(() => {
  if (!props.tasks.length) return 0;
  const completed = props.tasks.filter((task) => task.completedAt).length;
  return Math.round((completed / props.tasks.length) * 100);
});

watch(
  () => props.activeList?.id,
  () => {
    draft.value = '';
  }
);

function submitTask() {
  if (!draft.value.trim() || !props.activeList) return;
  emit('create-task', draft.value.trim());
  draft.value = '';
}
</script>

<template>
  <section class="panel task-panel">
    <header class="task-header">
      <div>
        <p class="eyebrow">Live board</p>
        <h2>{{ activeList?.name || 'Select a list' }}</h2>
        <p class="subtle">
          {{ tasks.length }} total tasks • {{ completionRate }}% complete
        </p>
      </div>
      <div class="status-pill" :class="socketState">
        {{ socketState === 'open' ? 'Realtime connected' : socketState === 'connecting' ? 'Connecting' : 'Offline sync' }}
      </div>
    </header>

    <form class="composer" @submit.prevent="submitTask">
      <input
        v-model="draft"
        :disabled="!activeList || pending"
        type="text"
        placeholder="Add a task for the team"
      />
      <button type="submit" :disabled="!activeList || pending || !draft.trim()">Add task</button>
    </form>

    <ul class="task-list">
      <li v-for="task in tasks" :key="task.id" class="task-row" :class="{ done: task.completedAt }">
        <label class="task-main">
          <input
            type="checkbox"
            :checked="Boolean(task.completedAt)"
            :disabled="pending"
            @change="emit('toggle-task', task)"
          />
          <span>
            <strong>{{ task.title }}</strong>
            <small>
              Created {{ task.createdAtLabel }} by {{ task.createdByName }}
              <template v-if="task.completedAtLabel"> • Completed {{ task.completedAtLabel }}</template>
            </small>
          </span>
        </label>
        <button class="ghost-danger" :disabled="pending" @click="emit('delete-task', task.id)">Delete</button>
      </li>
      <li v-if="!tasks.length" class="task-empty">No tasks yet. Add the first item to start collaborating.</li>
    </ul>
  </section>
</template>
