<script setup>
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

function handleCreateList() {
  const name = window.prompt('Name the new list');
  if (!name || !name.trim()) return;
  emit('create-list', name.trim());
}

function handleDeleteList(list) {
  const confirmed = window.confirm(`Delete the list "${list.name}" and all of its tasks?`);
  if (!confirmed) return;
  emit('delete-list', list.id);
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
            <small>{{ list.taskCount }} tasks</small>
          </span>
        </button>
        <span class="list-card-actions">
          <small>{{ list.openCount }} open</small>
          <button class="icon-button" title="Delete list" @click.stop="handleDeleteList(list)">×</button>
        </span>
      </article>
    </div>
  </aside>
</template>
