<script setup>
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue';

const props = defineProps({
  open: { type: Boolean, default: false },
  messages: { type: Array, default: () => [] },
  lists: { type: Array, default: () => [] },
  members: { type: Array, default: () => [] },
  currentUser: { type: Object, default: null },
  unreadCount: { type: Number, default: 0 },
  hasMore: { type: Boolean, default: false },
  loadingMore: { type: Boolean, default: false },
  pending: { type: Boolean, default: false },
});

const emit = defineEmits(['open', 'close', 'send', 'load-more']);

const inputText = ref('');
const selectedListId = ref(null);
const listPickerOpen = ref(false);
const messagesEl = ref(null);
const inputEl = ref(null);
const isAtBottom = ref(true);

const selectedList = computed(() => props.lists.find((l) => l.id === selectedListId.value) || null);

function getInitials(name = '') {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

function formatTime(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now - date;
  const oneDay = 86400000;

  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < oneDay) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diff < 2 * oneDay) return `Yesterday ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// Group consecutive messages from the same user (within 5 minutes)
const groupedMessages = computed(() => {
  const groups = [];
  let lastUserId = null;
  let lastTime = null;

  for (const msg of props.messages) {
    const msgTime = new Date(msg.createdAt).getTime();
    const sameUser = msg.userId === lastUserId;
    const closeInTime = lastTime && (msgTime - lastTime) < 5 * 60 * 1000;

    if (sameUser && closeInTime) {
      groups[groups.length - 1].messages.push(msg);
    } else {
      groups.push({ userId: msg.userId, userName: msg.userName, messages: [msg] });
    }

    lastUserId = msg.userId;
    lastTime = msgTime;
  }

  return groups;
});

async function scrollToBottom(behavior = 'smooth') {
  await nextTick();
  if (messagesEl.value) {
    messagesEl.value.scrollTo({ top: messagesEl.value.scrollHeight, behavior });
  }
}

function onScroll() {
  if (!messagesEl.value) return;
  const { scrollTop, scrollHeight, clientHeight } = messagesEl.value;
  isAtBottom.value = scrollHeight - scrollTop - clientHeight < 60;

  if (scrollTop < 80 && props.hasMore && !props.loadingMore) {
    emit('load-more');
  }
}

function send() {
  const text = inputText.value.trim();
  if (!text || props.pending) return;
  emit('send', { text, listId: selectedListId.value || null });
  inputText.value = '';
  selectedListId.value = null;
  listPickerOpen.value = false;
}

function onKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}

function toggleOpen() {
  if (props.open) {
    emit('close');
  } else {
    emit('open');
  }
}

function clearList() {
  selectedListId.value = null;
  listPickerOpen.value = false;
}

function selectList(id) {
  selectedListId.value = id;
  listPickerOpen.value = false;
}

watch(() => props.open, async (isOpen) => {
  if (isOpen) {
    await scrollToBottom('instant');
    await nextTick();
    inputEl.value?.focus();
  }
});

watch(() => props.messages.length, async (newLen, oldLen) => {
  if (newLen > oldLen && isAtBottom.value) {
    await scrollToBottom();
  }
});

function onClickOutsideListPicker(e) {
  if (listPickerOpen.value && !e.target.closest('.chat-list-picker-wrap')) {
    listPickerOpen.value = false;
  }
}

onMounted(() => {
  document.addEventListener('click', onClickOutsideListPicker);
});

onBeforeUnmount(() => {
  document.removeEventListener('click', onClickOutsideListPicker);
});
</script>

<template>
  <!-- FAB trigger button (always visible) -->
  <div class="chat-fab-wrap">
    <button
      class="chat-fab"
      :class="{ 'chat-fab--open': open }"
      type="button"
      :aria-label="open ? 'Close team chat' : 'Open team chat'"
      @click="toggleOpen"
    >
      <svg v-if="!open" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
      <svg v-else xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
      <span v-if="!open && unreadCount > 0" class="chat-fab-badge">{{ unreadCount > 99 ? '99+' : unreadCount }}</span>
    </button>

    <!-- Chat panel -->
    <Transition name="chat-panel">
      <div v-if="open" class="chat-panel" role="dialog" aria-label="Team chat">
        <!-- Header -->
        <div class="chat-header">
          <div class="chat-header-info">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            <span class="chat-header-title">Team Chat</span>
          </div>
          <div class="chat-header-members">
            <div v-for="member in members.slice(0, 5)" :key="member.id" class="chat-avatar chat-avatar--sm" :title="member.name">
              {{ getInitials(member.name) }}
            </div>
            <span v-if="members.length > 5" class="chat-member-overflow">+{{ members.length - 5 }}</span>
          </div>
          <button type="button" class="chat-close-btn" aria-label="Close chat" @click="emit('close')">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <!-- Messages -->
        <div ref="messagesEl" class="chat-messages" @scroll="onScroll">
          <!-- Load more -->
          <div class="chat-load-more-wrap">
            <button
              v-if="hasMore"
              type="button"
              class="chat-load-more-btn"
              :disabled="loadingMore"
              @click="emit('load-more')"
            >
              {{ loadingMore ? 'Loading…' : 'Load earlier messages' }}
            </button>
          </div>

          <div v-if="groupedMessages.length === 0" class="chat-empty">
            <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.3">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            <p>No messages yet.</p>
            <p class="chat-empty-sub">Say hi to your team!</p>
          </div>

          <div v-for="group in groupedMessages" :key="group.messages[0].id" class="chat-group">
            <div
              class="chat-avatar"
              :class="{ 'chat-avatar--self': group.userId === currentUser?.id }"
              :title="group.userName"
            >
              {{ getInitials(group.userName) }}
            </div>
            <div class="chat-group-body">
              <div class="chat-group-meta">
                <span class="chat-username" :class="{ 'chat-username--self': group.userId === currentUser?.id }">
                  {{ group.userId === currentUser?.id ? 'You' : group.userName }}
                </span>
                <span class="chat-time">{{ formatTime(group.messages[0].createdAt) }}</span>
              </div>
              <div v-for="msg in group.messages" :key="msg.id" class="chat-bubble-wrap">
                <div class="chat-bubble" :class="{ 'chat-bubble--self': msg.userId === currentUser?.id }">
                  <p class="chat-bubble-text">{{ msg.text }}</p>
                  <div v-if="msg.listName" class="chat-list-tag">
                    <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
                    </svg>
                    {{ msg.listName }}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Input area -->
        <div class="chat-input-area">
          <!-- Selected list tag -->
          <div v-if="selectedList" class="chat-selected-list">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
            </svg>
            <span>{{ selectedList.name }}</span>
            <button type="button" class="chat-clear-list" aria-label="Remove list tag" @click="clearList">×</button>
          </div>

          <div class="chat-input-row">
            <!-- List picker -->
            <div class="chat-list-picker-wrap">
              <button
                type="button"
                class="chat-attach-btn"
                :class="{ active: listPickerOpen || selectedListId }"
                aria-label="Tag a list"
                :title="selectedList ? `Tagged: ${selectedList.name}` : 'Tag a list'"
                @click.stop="listPickerOpen = !listPickerOpen"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
                </svg>
              </button>

              <Transition name="list-picker">
                <div v-if="listPickerOpen && lists.length > 0" class="chat-list-picker">
                  <p class="chat-list-picker-label">Tag a list</p>
                  <button
                    v-for="list in lists"
                    :key="list.id"
                    type="button"
                    class="chat-list-option"
                    :class="{ active: selectedListId === list.id }"
                    @click="selectList(list.id)"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
                      <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
                    </svg>
                    {{ list.name }}
                  </button>
                </div>
              </Transition>
            </div>

            <textarea
              ref="inputEl"
              v-model="inputText"
              class="chat-input"
              placeholder="Message your team…"
              rows="1"
              maxlength="2000"
              :disabled="pending"
              @keydown="onKeydown"
              @input="$event.target.style.height = 'auto'; $event.target.style.height = Math.min($event.target.scrollHeight, 120) + 'px'"
            />

            <button
              type="button"
              class="chat-send-btn"
              :disabled="!inputText.trim() || pending"
              aria-label="Send message"
              @click="send"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* ─── FAB ─────────────────────────────────────────────────────────────────── */
.chat-fab-wrap {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 12px;
}

.chat-fab {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--button-primary-text, #fff);
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.22);
  transition: transform 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
  position: relative;
  flex-shrink: 0;
}

.chat-fab:hover {
  transform: scale(1.08);
  background: var(--accent-hover);
  box-shadow: 0 6px 28px rgba(0, 0, 0, 0.28);
}

.chat-fab:active {
  transform: scale(0.96);
}

.chat-fab--open {
  background: var(--surface-subtle);
  color: var(--text-primary);
}

.chat-fab-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  border-radius: 10px;
  background: var(--danger);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  border: 2px solid var(--panel);
}

/* ─── Panel ───────────────────────────────────────────────────────────────── */
.chat-panel {
  position: absolute;
  bottom: 68px;
  right: 0;
  width: 380px;
  max-width: calc(100vw - 32px);
  height: 520px;
  max-height: calc(100vh - 120px);
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 16px;
  box-shadow: var(--panel-shadow);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  backdrop-filter: blur(12px);
}

/* Transition */
.chat-panel-enter-active {
  transition: opacity 0.22s ease, transform 0.22s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.chat-panel-leave-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
}
.chat-panel-enter-from,
.chat-panel-leave-to {
  opacity: 0;
  transform: scale(0.92) translateY(16px);
  transform-origin: bottom right;
}

/* ─── Header ──────────────────────────────────────────────────────────────── */
.chat-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--divider);
  background: var(--surface-subtle);
  flex-shrink: 0;
}

.chat-header-info {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 1;
  min-width: 0;
  color: var(--text-primary);
}

.chat-header-title {
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
}

.chat-header-members {
  display: flex;
  align-items: center;
}

.chat-member-overflow {
  font-size: 11px;
  color: var(--text-soft);
  margin-left: 6px;
}

.chat-close-btn {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--text-soft);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s ease, color 0.15s ease;
  flex-shrink: 0;
}

.chat-close-btn:hover {
  background: var(--button-muted-hover);
  color: var(--text-primary);
}

/* ─── Avatar ──────────────────────────────────────────────────────────────── */
.chat-avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--accent-soft-bg);
  color: var(--accent-soft-text);
  font-size: 12px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border: 2px solid var(--panel);
}

.chat-avatar--sm {
  width: 26px;
  height: 26px;
  font-size: 10px;
  margin-left: -6px;
  border-width: 1.5px;
}

.chat-avatar--self {
  background: var(--accent);
  color: var(--button-primary-text, #fff);
}

/* ─── Messages ────────────────────────────────────────────────────────────── */
.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px 14px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  scroll-behavior: smooth;
}

.chat-messages::-webkit-scrollbar {
  width: 4px;
}
.chat-messages::-webkit-scrollbar-thumb {
  background: var(--divider-strong);
  border-radius: 4px;
}

.chat-load-more-wrap {
  display: flex;
  justify-content: center;
  padding-bottom: 8px;
}

.chat-load-more-btn {
  font-size: 12px;
  color: var(--text-soft);
  background: transparent;
  border: 1px solid var(--divider-strong);
  border-radius: 20px;
  padding: 5px 14px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.chat-load-more-btn:hover:not(:disabled) {
  background: var(--button-muted-hover);
  color: var(--text-primary);
}

.chat-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 32px 16px;
  color: var(--text-soft);
  text-align: center;
}

.chat-empty p {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
}

.chat-empty-sub {
  font-size: 13px !important;
  font-weight: 400 !important;
  opacity: 0.7;
}

.chat-group {
  display: flex;
  gap: 10px;
  margin-top: 10px;
}

.chat-group-body {
  flex: 1;
  min-width: 0;
}

.chat-group-meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 4px;
}

.chat-username {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.chat-username--self {
  color: var(--accent-soft-text);
}

.chat-time {
  font-size: 11px;
  color: var(--text-soft);
}

.chat-bubble-wrap {
  margin-bottom: 2px;
}

.chat-bubble {
  display: inline-block;
  max-width: 100%;
  background: var(--surface-card);
  border-radius: 0 12px 12px 12px;
  padding: 8px 12px;
}

.chat-bubble--self {
  background: var(--accent-soft-bg);
  border-radius: 12px 0 12px 12px;
}

.chat-bubble-text {
  margin: 0;
  font-size: 14px;
  line-height: 1.5;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}

.chat-list-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 5px;
  font-size: 11px;
  color: var(--accent-soft-text);
  background: var(--accent-soft-bg);
  border-radius: 6px;
  padding: 3px 8px;
  font-weight: 500;
}

/* ─── Input area ──────────────────────────────────────────────────────────── */
.chat-input-area {
  border-top: 1px solid var(--divider);
  padding: 12px 12px 14px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.chat-input-row {
  display: flex;
  align-items: flex-end;
  gap: 6px;
}

.chat-selected-list {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--accent-soft-text);
  background: var(--accent-soft-bg);
  border-radius: 8px;
  padding: 4px 8px;
  font-weight: 500;
  align-self: flex-start;
}

.chat-clear-list {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0 0 0 2px;
  opacity: 0.7;
  transition: opacity 0.15s;
}

.chat-clear-list:hover {
  opacity: 1;
}

.chat-list-picker-wrap {
  position: relative;
}

.chat-attach-btn {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  border: 1px solid var(--field-border);
  background: var(--field-bg);
  color: var(--text-soft);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}

.chat-attach-btn:hover,
.chat-attach-btn.active {
  background: var(--accent-soft-bg);
  color: var(--accent-soft-text);
  border-color: var(--accent);
}

/* List picker dropdown */
.chat-list-picker {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  min-width: 200px;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 10px;
  box-shadow: var(--panel-shadow);
  padding: 6px;
  z-index: 10;
  backdrop-filter: blur(12px);
}

.chat-list-picker-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-soft);
  padding: 4px 8px;
  margin: 0 0 4px;
}

.chat-list-option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  cursor: pointer;
  text-align: left;
  transition: background 0.12s ease;
}

.chat-list-option:hover,
.chat-list-option.active {
  background: var(--accent-soft-bg);
  color: var(--accent-soft-text);
}

/* Picker transition */
.list-picker-enter-active {
  transition: opacity 0.15s ease, transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.list-picker-leave-active {
  transition: opacity 0.1s ease, transform 0.1s ease;
}
.list-picker-enter-from,
.list-picker-leave-to {
  opacity: 0;
  transform: scale(0.95) translateY(6px);
  transform-origin: bottom left;
}

.chat-input {
  flex: 1;
  min-width: 0;
  padding: 8px 10px;
  font-size: 14px;
  line-height: 1.5;
  background: var(--field-bg);
  border: 1px solid var(--field-border);
  border-radius: 10px;
  color: var(--text-primary);
  resize: none;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
  font-family: inherit;
  min-height: 36px;
  max-height: 120px;
  overflow-y: auto;
}

.chat-input::placeholder {
  color: var(--text-soft);
}

.chat-input:focus {
  border-color: var(--accent);
  box-shadow: var(--focus-ring);
}

.chat-send-btn {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  border: none;
  background: var(--accent);
  color: var(--button-primary-text, #fff);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background 0.15s ease, transform 0.1s ease, opacity 0.15s ease;
}

.chat-send-btn:hover:not(:disabled) {
  background: var(--accent-hover);
  transform: scale(1.05);
}

.chat-send-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ─── Mobile ──────────────────────────────────────────────────────────────── */
@media (max-width: 1100px) {
  .chat-fab {
    display: none;
  }
}

@media (max-width: 480px) {
  .chat-fab-wrap {
    bottom: 20px;
    right: 16px;
  }

  .chat-panel {
    position: fixed;
    bottom: 0;
    right: 0;
    left: 0;
    width: 100%;
    max-width: 100%;
    height: 72vh;
    max-height: 72vh;
    border-radius: 20px 20px 0 0;
    border-bottom: none;
  }

  .chat-panel-enter-from,
  .chat-panel-leave-to {
    opacity: 0;
    transform: translateY(100%);
    transform-origin: bottom center;
  }
}
</style>
