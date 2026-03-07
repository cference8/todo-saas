<script setup>
import { reactive, ref } from 'vue';

const props = defineProps({
  currentListId: {
    type: Number,
    required: true
  },
  lists: {
    type: Array,
    required: true
  },
  memberships: {
    type: Array,
    required: true
  },
  workspaceId: {
    type: Number,
    required: true
  },
  pending: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits(['select-list', 'create-list', 'delete-list', 'select-workspace']);
const modalMode = ref('');
const createForm = reactive({
  name: '',
  type: 'task'
});
const deleteTarget = ref(null);
const modalError = ref('');

function handleCreateList() {
  modalMode.value = 'create';
  createForm.name = '';
  createForm.type = 'task';
  modalError.value = '';
}

function handleDeleteList(list) {
  deleteTarget.value = list;
  modalMode.value = 'delete';
  modalError.value = '';
}

function closeModal() {
  modalMode.value = '';
  deleteTarget.value = null;
  modalError.value = '';
}

function submitCreateList() {
  if (!createForm.name.trim()) {
    modalError.value = 'List name is required.';
    return;
  }

  emit('create-list', { name: createForm.name.trim(), type: createForm.type });
  closeModal();
}

function confirmDeleteList() {
  if (!deleteTarget.value) return;
  emit('delete-list', deleteTarget.value.id);
  closeModal();
}
</script>

<template>
  <aside class="panel sidebar-panel">
    <div class="sidebar-header">
      <div>
        <p class="eyebrow">Workspace</p>
        <h1>Todo Control</h1>
      </div>
      <button class="ghost-button" :disabled="pending" @click="handleCreateList">New list</button>
    </div>

    <label class="workspace-switcher-label" for="workspace-switcher">Workspace</label>
    <select
      id="workspace-switcher"
      class="workspace-switcher"
      :value="workspaceId"
      @change="emit('select-workspace', Number($event.target.value))"
    >
      <option v-for="workspace in memberships" :key="workspace.id" :value="workspace.id">
        {{ workspace.name }} • {{ workspace.role }}
      </option>
    </select>

    <div class="sidebar-list">
      <article
        v-for="list in lists"
        :key="list.id"
        class="list-card"
        :class="{ active: list.id === currentListId }"
      >
        <button class="list-card-main" @click="emit('select-list', list.id)">
          <span>
            <strong>{{ list.name }}</strong>
            <small>{{ list.taskCount }} {{ list.type === 'grocery' ? 'items' : 'tasks' }}</small>
          </span>
        </button>
        <span class="list-card-actions">
          <small class="list-type-chip">{{ list.type }}</small>
          <small>{{ list.openCount }} open</small>
          <button class="icon-button" title="Delete list" @click.stop="handleDeleteList(list)">×</button>
        </span>
      </article>
    </div>
  </aside>

  <div v-if="modalMode" class="modal-backdrop" @click.self="closeModal">
    <section class="panel action-modal">
      <template v-if="modalMode === 'create'">
        <div>
          <p class="eyebrow">New list</p>
          <h2>Create a list</h2>
          <p class="subtle">Choose the list name and type. Grocery lists use quantity instead of task priority and due date.</p>
        </div>

        <div class="modal-form">
          <input v-model="createForm.name" type="text" placeholder="List name" :disabled="pending" />
          <div class="type-radio-group">
            <label class="type-radio">
              <input v-model="createForm.type" type="radio" value="task" :disabled="pending" />
              <span>
                <strong>Task list</strong>
                <small>Use due dates and priority.</small>
              </span>
            </label>
            <label class="type-radio">
              <input v-model="createForm.type" type="radio" value="grocery" :disabled="pending" />
              <span>
                <strong>Grocery list</strong>
                <small>Use quantity and shopping notes.</small>
              </span>
            </label>
          </div>
          <p v-if="modalError" class="form-error">{{ modalError }}</p>
        </div>

        <div class="modal-actions">
          <button class="ghost-button muted-button" type="button" :disabled="pending" @click="closeModal">Cancel</button>
          <button class="ghost-button" type="button" :disabled="pending" @click="submitCreateList">Create list</button>
        </div>
      </template>

      <template v-else-if="modalMode === 'delete'">
        <div>
          <p class="eyebrow">Delete list</p>
          <h2>Delete {{ deleteTarget?.name }}?</h2>
          <p class="subtle">This removes the list and all of its items.</p>
        </div>

        <div class="modal-actions">
          <button class="ghost-button muted-button" type="button" :disabled="pending" @click="closeModal">Cancel</button>
          <button class="ghost-danger" type="button" :disabled="pending" @click="confirmDeleteList">Delete list</button>
        </div>
      </template>
    </section>
  </div>
</template>
