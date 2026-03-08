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

const emit = defineEmits(['create-task', 'save-task', 'toggle-task', 'delete-task']);

const draft = reactive({
  title: '',
  description: '',
  quantity: ''
});
const editingTaskId = ref(null);
const editDraft = reactive({
  title: '',
  description: '',
  quantity: ''
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
    draft.quantity = '';
    editingTaskId.value = null;
  }
);

function submitItem() {
  if (!draft.title.trim() || !props.activeList) return;
  emit('create-task', {
    title: draft.title.trim(),
    description: draft.description.trim(),
    quantity: draft.quantity.trim(),
    dueDate: null,
    priority: 'medium'
  });
  draft.title = '';
  draft.description = '';
  draft.quantity = '';
}

function startEditing(task) {
  if (editingTaskId.value === task.id) return;
  editingTaskId.value = task.id;
  editDraft.title = task.title;
  editDraft.description = task.description || '';
  editDraft.quantity = task.quantity || '';
}

function cancelEditing() {
  editingTaskId.value = null;
}

function submitEdit(taskId) {
  if (!editDraft.title.trim()) return;
  emit('save-task', taskId, {
    title: editDraft.title.trim(),
    description: editDraft.description.trim(),
    quantity: editDraft.quantity.trim(),
    dueDate: null,
    priority: 'medium'
  });
  editingTaskId.value = null;
}
</script>

<template>
  <section class="panel task-panel">
    <header class="task-header">
      <div>
        <p class="eyebrow">Grocery board</p>
        <h2>{{ activeList?.name || 'Select a list' }}</h2>
        <p class="subtle">{{ tasks.length }} total items • {{ completionRate }}% checked off</p>
      </div>
      <div class="status-pill" :class="socketState">
        {{ socketState === 'open' ? 'Realtime connected' : socketState === 'connecting' ? 'Connecting' : 'Offline sync' }}
      </div>
    </header>

    <form class="composer composer-grocery" @submit.prevent="submitItem">
      <input
        v-model="draft.title"
        :disabled="!activeList || pending"
        type="text"
        placeholder="Add a grocery item"
      />
      <input
        v-model="draft.quantity"
        :disabled="!activeList || pending"
        type="text"
        placeholder="Qty / size"
      />
      <button type="submit" :disabled="!activeList || pending || !draft.title.trim()">Add item</button>
      <textarea
        v-model="draft.description"
        class="task-description-input"
        :disabled="!activeList || pending"
        rows="3"
        placeholder="Optional brand, aisle, or note"
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
              <small v-if="task.completedAtLabel">Checked off {{ task.completedAtLabel }}</small>
            </span>
          </label>

          <div class="task-badges">
            <span v-if="task.quantity" class="meta-badge">Qty {{ task.quantity }}</span>
          </div>

          <p v-if="task.description" class="task-note">{{ task.description }}</p>

          <form
            v-if="editingTaskId === task.id"
            class="task-editor"
            @submit.prevent="submitEdit(task.id)"
          >
            <input v-model="editDraft.title" type="text" :disabled="pending" />
            <input v-model="editDraft.quantity" type="text" :disabled="pending" placeholder="Qty / size" />
            <textarea v-model="editDraft.description" rows="3" :disabled="pending" placeholder="Brand, aisle, or note"></textarea>
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
      <li v-if="!tasks.length" class="task-empty">No grocery items yet. Add the first item to start the list.</li>
    </ul>
  </section>
</template>
