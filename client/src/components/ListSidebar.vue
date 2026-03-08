<script setup>
import { computed, reactive, ref } from 'vue';

const props = defineProps({
  currentListId: {
    type: Number,
    required: true
  },
  lists: {
    type: Array,
    required: true
  },
  pending: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits([
  'select-list',
  'create-list',
  'delete-list'
]);

const modalMode = ref('');
const createForm = reactive({
  name: '',
  type: 'task'
});
const deleteTarget = ref(null);
const modalError = ref('');

const activeList = computed(() => props.lists.find((list) => list.id === props.currentListId) || null);
const listSummary = computed(() => {
  if (!props.lists.length) {
    return 'No lists yet';
  }

  return `${props.lists.length} ${props.lists.length === 1 ? 'list' : 'lists'} available`;
});

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
  <aside class="panel list-panel">
    <div class="sidebar-header list-panel-header">
      <div>
        <p class="eyebrow">Lists</p>
        <h1>{{ activeList?.name || 'Boards & lists' }}</h1>
        <p class="subtle">{{ listSummary }}</p>
      </div>
      <button class="ghost-button list-create-button" :disabled="pending" @click="handleCreateList">New list</button>
    </div>

    <div class="panel-scroll">
      <div class="sidebar-list">
        <article
          v-for="list in lists"
          :key="list.id"
          class="list-card"
          :class="{ active: list.id === currentListId }"
          role="button"
          tabindex="0"
          :aria-pressed="list.id === currentListId"
          @click="emit('select-list', list.id)"
          @keydown.enter.prevent="emit('select-list', list.id)"
          @keydown.space.prevent="emit('select-list', list.id)"
        >
          <div class="list-card-main">
            <span>
              <strong>{{ list.name }}</strong>
              <small>{{ list.taskCount }} {{ list.type === 'grocery' ? 'items' : 'tasks' }}</small>
            </span>
          </div>
          <div class="list-card-actions">
            <small class="list-type-chip">{{ list.type }}</small>
            <small>{{ list.openCount }} open</small>
            <button type="button" class="icon-button" title="Delete list" @click.stop="handleDeleteList(list)">×</button>
          </div>
        </article>
      </div>
    </div>
  </aside>

  <div v-if="modalMode" class="modal-backdrop" @click.self="closeModal">
    <section class="panel action-modal">
      <template v-if="modalMode === 'create'">
        <form class="modal-form-stack" @submit.prevent="submitCreateList">
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
            <button class="ghost-button" type="submit" :disabled="pending">Create list</button>
          </div>
        </form>
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
