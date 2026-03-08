<script setup>
import { computed, reactive, ref, watch } from 'vue';

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

const emit = defineEmits(['create-task', 'save-task', 'show-lists', 'toggle-task', 'delete-task']);

const draft = reactive({
  title: '',
  description: '',
  dueDate: '',
  priority: 'medium'
});
const editingTaskId = ref(null);
const editDraft = reactive({
  title: '',
  description: '',
  dueDate: '',
  priority: 'medium'
});

const completionRate = computed(() => {
  if (!props.tasks.length) return 0;
  const completed = props.tasks.filter((task) => task.completedAt).length;
  return Math.round((completed / props.tasks.length) * 100);
});

watch(
  () => props.activeList?.id,
  () => {
    draft.title = '';
    draft.description = '';
    draft.dueDate = '';
    draft.priority = 'medium';
    editingTaskId.value = null;
  }
);

function submitTask() {
  if (!draft.title.trim() || !props.activeList) return;
  emit('create-task', {
    title: draft.title.trim(),
    description: draft.description.trim(),
    dueDate: draft.dueDate || null,
    priority: draft.priority
  });
  draft.title = '';
  draft.description = '';
  draft.dueDate = '';
  draft.priority = 'medium';
}

function startEditing(task) {
  if (editingTaskId.value === task.id) return;
  editingTaskId.value = task.id;
  editDraft.title = task.title;
  editDraft.description = task.description || '';
  editDraft.dueDate = task.dueDate || '';
  editDraft.priority = task.priority || 'medium';
}

function cancelEditing() {
  editingTaskId.value = null;
}

function submitEdit(taskId) {
  if (!editDraft.title.trim()) return;
  emit('save-task', taskId, {
    title: editDraft.title.trim(),
    description: editDraft.description.trim(),
    dueDate: editDraft.dueDate || null,
    priority: editDraft.priority
  });
  editingTaskId.value = null;
}
</script>

<template>
  <section class="panel task-panel">
    <header class="task-header">
      <div>
        <p class="eyebrow">Task board</p>
        <h2>{{ activeList?.name || 'Select a list' }}</h2>
        <p class="subtle">{{ tasks.length }} total tasks • {{ completionRate }}% complete</p>
      </div>
      <div class="task-header-actions">
        <div class="status-pill" :class="socketState">
          {{ socketState === 'open' ? 'Realtime connected' : socketState === 'connecting' ? 'Connecting' : 'Offline sync' }}
        </div>
        <button type="button" class="ghost-button muted-button mobile-list-jump" @click="emit('show-lists')">Select different list</button>
      </div>
    </header>

    <form class="composer composer-rich" @submit.prevent="submitTask">
      <input
        v-model="draft.title"
        :disabled="!activeList || pending"
        type="text"
        placeholder="Add a task for the team"
      />
      <input
        v-model="draft.dueDate"
        :disabled="!activeList || pending"
        type="date"
      />
      <select v-model="draft.priority" :disabled="!activeList || pending">
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
      </select>
      <button type="submit" :disabled="!activeList || pending || !draft.title.trim()">Add task</button>
      <textarea
        v-model="draft.description"
        class="task-description-input"
        :disabled="!activeList || pending"
        rows="3"
        placeholder="Optional notes or context"
      />
    </form>

    <ul class="task-list">
      <li v-for="task in tasks" :key="task.id" class="task-row" :class="{ done: task.completedAt }">
        <div class="task-row-main">
          <label class="task-main">
            <input
              type="checkbox"
              :checked="Boolean(task.completedAt)"
              :disabled="pending"
              @change="emit('toggle-task', task)"
            />
            <span>
              <strong>{{ task.title }}</strong>
              <small>Created {{ task.createdAtLabel }} by {{ task.createdByName }}</small>
              <small v-if="task.completedAtLabel">Completed {{ task.completedAtLabel }}</small>
            </span>
          </label>

          <div class="task-badges">
            <span class="priority-badge" :class="`priority-${task.priority}`">{{ task.priority }}</span>
            <span v-if="task.dueDateLabel" class="meta-badge">Due {{ task.dueDateLabel }}</span>
          </div>

          <p v-if="task.description" class="task-note">{{ task.description }}</p>

          <form
            v-if="editingTaskId === task.id"
            class="task-editor"
            @submit.prevent="submitEdit(task.id)"
          >
            <input v-model="editDraft.title" type="text" :disabled="pending" />
            <textarea v-model="editDraft.description" rows="3" :disabled="pending" placeholder="Task details"></textarea>
            <div class="task-editor-row">
              <input v-model="editDraft.dueDate" type="date" :disabled="pending" />
              <select v-model="editDraft.priority" :disabled="pending">
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
            <div class="task-editor-actions">
              <button type="submit" class="ghost-button" :disabled="pending || !editDraft.title.trim()">Save</button>
              <button type="button" class="ghost-button muted-button" :disabled="pending" @click="cancelEditing">Cancel</button>
            </div>
          </form>
        </div>

        <div class="task-actions">
          <button class="ghost-button muted-button" :disabled="pending || editingTaskId === task.id" @click="startEditing(task)">
            {{ editingTaskId === task.id ? 'Editing' : 'Edit' }}
          </button>
          <button class="ghost-danger" :disabled="pending" @click="emit('delete-task', task)">Delete</button>
        </div>
      </li>
      <li v-if="!tasks.length" class="task-empty">No tasks yet. Add the first item to start collaborating.</li>
    </ul>
  </section>
</template>
