<script setup lang="ts">
// The assistant chat. Replies come from the model chosen in Assistant settings, run by the
// main process (src/assistant/), which saves every message to the project and streams
// progress here: text as it's written, each tool it uses, and requests to approve changes.
// Each change it makes can be undone from here.
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { PROVIDERS } from '../assistant/models';
import { errorMessage } from '../errors';
import type {
  ApprovalAnswer,
  AssistantChange,
  AssistantEnd,
  AssistantSettings as Settings,
  ChatMessage,
  WorkflowStage,
} from '../shared/types';
import { pageToShow, projectChanged } from '../ui-signals';
import { INTRO_MESSAGE } from '../workflow';
import AssistantSettings from './AssistantSettings.vue';
import ReplyText from './ReplyText.vue';
import RunningTimer from './RunningTimer.vue';

// Shared with the workspace's step tracker in the top bar.
const stage = defineModel<WorkflowStage>('stage', { required: true });
const messages = ref<ChatMessage[]>([]);
const draft = ref('');
const loading = ref(true);
const replying = ref(false);
const liveText = ref('');
const liveTools = ref<{ id: string; summary: string; status: string }[]>([]);
const error = ref('');
const canRetry = ref(false);
const endNote = ref('');
const settings = ref<Settings | null>(null);
const showSettings = ref(false);
const scroller = ref<HTMLElement | null>(null);
// Changes waiting for the user's approval.
const approvals = ref<
  { id: string; summary: string; always?: boolean; permanent?: boolean }[]
>([]);
// The assistant's changes to this project, by ID, to show Undo or "Undone".
const changes = ref<Record<string, AssistantChange>>({});

async function loadChanges() {
  const list = await window.api.assistant.listChanges().catch(() => []);
  changes.value = Object.fromEntries(list.map((c) => [c.id, c]));
}

// The welcome message is shown until the first reply, which saves it with the conversation.
const intro: ChatMessage = {
  id: 'intro',
  role: 'assistant',
  text: INTRO_MESSAGE,
  createdAt: '',
};
const shown = computed(() =>
  messages.value.length ? messages.value : [intro],
);

// The chosen provider is set up: a key saved, or (for Ollama) a model chosen.
const ready = computed(() => !!settings.value?.ready);
const modelLabel = computed(() =>
  settings.value && ready.value
    ? `${PROVIDERS[settings.value.provider].product} · ${settings.value.models[settings.value.provider]}`
    : '',
);
const canSend = computed(
  () =>
    draft.value.trim() !== '' &&
    !loading.value &&
    !replying.value &&
    ready.value,
);

async function scrollToBottom(behavior: ScrollBehavior = 'smooth') {
  await nextTick();
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight, behavior });
}

let stopListening: (() => void) | null = null;

onMounted(async () => {
  stopListening = window.api.assistant.onEvent((event) => {
    if (event.type === 'text') {
      liveText.value += event.text;
    } else if (event.type === 'tool') {
      // Once its result is saved, the saved message shows the tool instead.
      if (messages.value.some((m) => m.toolCallId === event.id)) return;
      const existing = liveTools.value.find((t) => t.id === event.id);
      if (existing) existing.status = event.status;
      else
        liveTools.value.push({
          id: event.id,
          summary: event.summary,
          status: event.status,
        });
    } else if (event.type === 'message') {
      const m = event.message;
      if (!messages.value.some((x) => x.id === m.id)) messages.value.push(m);
      // A saved message replaces what was shown live.
      if (m.role === 'assistant') liveText.value = '';
      if (m.role === 'tool') {
        liveTools.value = liveTools.value.filter((t) => t.id !== m.toolCallId);
      }
      if (m.changeId) loadChanges();
    } else if (event.type === 'approval') {
      approvals.value.push({
        id: event.id,
        summary: event.summary,
        always: event.always,
        permanent: event.permanent,
      });
    } else if (event.type === 'changed') {
      projectChanged.value++;
    } else if (event.type === 'show') {
      stage.value = event.stage;
      window.api.projects.setStage(event.stage);
      if (event.pageId) pageToShow.value = event.pageId;
    }
    scrollToBottom();
  });

  const [chat, current] = await Promise.all([
    window.api.projects.loadChat(),
    window.api.assistant.getSettings(),
  ]);
  stage.value = chat.stage;
  messages.value = chat.messages;
  settings.value = current;
  await loadChanges();
  loading.value = false;
  await scrollToBottom('auto');
});

onBeforeUnmount(() => stopListening?.());

const END_NOTES: Partial<Record<AssistantEnd, string>> = {
  steps:
    'The assistant stopped after a lot of steps. Say "carry on" to let it continue.',
  length: 'The reply was cut off because it got too long.',
  refused: 'The model declined to answer that.',
  stopped: 'Stopped.',
};

async function run(request: () => Promise<AssistantEnd>, text?: string) {
  replying.value = true;
  error.value = '';
  endNote.value = '';
  canRetry.value = false;
  const before = messages.value.length;
  try {
    endNote.value = END_NOTES[await request()] ?? '';
  } catch (e) {
    error.value = errorMessage(e);
    // If the message wasn't saved, give it back to edit; otherwise offer to try again.
    if (messages.value.length === before && text !== undefined) {
      draft.value = text;
    } else {
      canRetry.value = true;
    }
  } finally {
    replying.value = false;
    liveText.value = '';
    liveTools.value = [];
    approvals.value = [];
    await scrollToBottom();
  }
}

async function answer(id: string, choice: ApprovalAnswer) {
  approvals.value = approvals.value.filter((a) => a.id !== id);
  await window.api.assistant.answer(id, choice);
  if (choice === 'allow-all') {
    settings.value = await window.api.assistant.getSettings();
  }
}

/** Undoes a change and every later one, checking with the user first where it matters. */
async function undo(id: string) {
  const list = Object.values(changes.value);
  const later = list
    .slice(list.findIndex((c) => c.id === id) + 1)
    .filter((c) => !c.undone);
  if (
    later.length &&
    !window.confirm(
      `Undo this change and the ${later.length === 1 ? 'change' : `${later.length} changes`} the assistant made after it?`,
    )
  ) {
    return;
  }
  error.value = '';
  try {
    const result = await window.api.assistant.undo(id);
    if (
      result.conflicts.length &&
      window.confirm(
        `These files have been edited since the assistant changed them: ${result.conflicts.join(', ')}. Undo anyway? Those edits will be lost.`,
      )
    ) {
      await window.api.assistant.undo(id, true);
    }
    await loadChanges();
  } catch (e) {
    error.value = errorMessage(e);
  }
}

function send() {
  if (!canSend.value) return;
  const text = draft.value.trim();
  draft.value = '';
  run(() => window.api.assistant.send(text), text);
}

const retry = () => run(() => window.api.assistant.retry());
const stop = () => window.api.assistant.stop();

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    send();
  }
}
</script>

<template>
  <aside class="chat">
    <div class="chat-header">
      <div class="title">
        <h2>Assistant</h2>
        <small v-if="modelLabel" class="model">{{ modelLabel }}</small>
      </div>
      <button
        class="settings"
        title="Assistant settings"
        aria-label="Assistant settings"
        @click="showSettings = true"
      >
        <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path
            d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68 1.65 1.65 0 0 0 10 3.17V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
          />
        </svg>
      </button>
    </div>

    <div v-if="!loading && !ready" class="setup">
      <p>
        Get started by setting up an assistant from Anthropic, OpenAI or Ollama.
      </p>
      <button class="btn-primary" @click="showSettings = true">
        Set up the assistant
      </button>
    </div>

    <div ref="scroller" class="messages">
      <template v-for="m in shown" :key="m.id">
        <div v-if="m.event" class="activity undone">
          <span class="mark" aria-hidden="true">↶</span>
          {{ m.summary ?? 'Undid changes' }}
        </div>
        <div v-else-if="m.role === 'user'" class="message user">
          {{ m.text }}
        </div>
        <div
          v-else-if="m.role === 'tool'"
          class="activity"
          :class="{
            failed: m.isError,
            change: m.changeId,
            declined: m.declined,
          }"
        >
          <span class="mark" aria-hidden="true">{{
            m.isError ? '!' : m.declined ? '–' : '✓'
          }}</span>
          <span>
            {{ m.summary ?? m.toolName }}{{ m.isError ? ": didn't work" : '' }}
          </span>
          <template v-if="m.changeId && changes[m.changeId]">
            <span v-if="changes[m.changeId].undone" class="undone-tag"
              >Undone</span
            >
            <button
              v-else
              class="undo"
              :disabled="replying"
              :title="
                replying
                  ? 'Wait for the reply to finish'
                  : 'Undo this change and any made after it'
              "
              @click="undo(m.changeId)"
            >
              Undo
            </button>
          </template>
        </div>
        <ReplyText
          v-else-if="m.text"
          class="message assistant"
          :text="m.text"
          copyable
        />
      </template>

      <div
        v-for="t in liveTools"
        :key="t.id"
        class="activity"
        :class="{
          running: t.status === 'running',
          failed: t.status === 'failed',
        }"
      >
        <span class="mark" aria-hidden="true">{{
          t.status === 'running' ? '' : t.status === 'failed' ? '!' : '✓'
        }}</span>
        {{ t.summary }}…
        <RunningTimer
          v-if="t.status === 'running'"
          :can-stop="false"
          :show-after="3"
        />
      </div>
      <div v-for="a in approvals" :key="a.id" class="approval" role="group">
        <p class="approval-text">
          The assistant wants to: <strong>{{ a.summary }}</strong>
        </p>
        <p v-if="a.permanent" class="approval-note">This can't be undone.</p>
        <p v-if="a.always" class="approval-note">
          You're always asked about this, because it changes where a data source
          connects or what it reads.
        </p>
        <div class="approval-actions">
          <button class="allow" @click="answer(a.id, 'allow')">Allow</button>
          <button
            v-if="!a.always"
            class="allow-all"
            @click="answer(a.id, 'allow-all')"
          >
            Allow all changes
          </button>
          <button class="deny" @click="answer(a.id, 'deny')">
            Don't allow
          </button>
        </div>
      </div>
      <ReplyText v-if="liveText" class="message assistant" :text="liveText" />
      <div
        v-else-if="
          replying &&
          !approvals.length &&
          !liveTools.some((t) => t.status === 'running')
        "
        class="message assistant typing"
        aria-label="Assistant is typing"
      >
        <span></span><span></span><span></span>
      </div>

      <p v-if="endNote" class="note">{{ endNote }}</p>
      <div v-if="error" class="box-error chat-error" role="alert">
        {{ error }}
        <button v-if="canRetry" class="retry" @click="retry">Try again</button>
      </div>
    </div>

    <form class="composer" @submit.prevent="send">
      <textarea
        v-model="draft"
        rows="3"
        placeholder="Message the assistant…"
        @keydown="onKeydown"
      ></textarea>
      <div class="composer-footer">
        <small>Shift + Enter for a new line</small>
        <button v-if="replying" type="button" class="send stop" @click="stop">
          Stop
        </button>
        <button v-else type="submit" class="send" :disabled="!canSend">
          Send
        </button>
      </div>
    </form>

    <AssistantSettings
      v-if="showSettings"
      @close="showSettings = false"
      @changed="settings = $event"
    />
  </aside>
</template>

<style scoped>
.chat {
  display: flex;
  flex: none;
  flex-direction: column;
  width: 400px;
  border-right: 1px solid var(--border);
  background: var(--surface);
}

.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 20px 20px 16px;
  border-bottom: 1px solid var(--border);
}

.chat-header h2 {
  font-size: 22px;
}

.title {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.model {
  overflow: hidden;
  color: var(--ink-muted);
  font-size: 12px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.settings {
  display: grid;
  flex: none;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--ink-muted);
}

.settings:hover {
  border-color: var(--border);
  color: var(--ink);
}

.settings .icon {
  width: 18px;
  height: 18px;
  stroke-width: 1.75;
}

.messages {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  padding: 20px;
  overflow-y: auto;
}

.message {
  max-width: 90%;
  padding: 10px 14px;
  border-radius: var(--radius);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.message.assistant {
  align-self: flex-start;
  border-bottom-left-radius: 4px;
  background: var(--surface-muted);
  white-space: normal;
}

.message.user {
  align-self: flex-end;
  border-bottom-right-radius: 4px;
  background: var(--ink);
  color: var(--surface);
}

.typing {
  display: flex;
  gap: 4px;
  padding: 14px;
}

.typing span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ink-faint);
  animation: bounce 1s infinite ease-in-out;
}

.typing span:nth-child(2) {
  animation-delay: 0.15s;
}

.typing span:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes bounce {
  0%,
  60%,
  100% {
    transform: translateY(0);
    opacity: 0.5;
  }
  30% {
    transform: translateY(-4px);
    opacity: 1;
  }
}

.composer {
  margin: 0 16px 16px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  transition: border-color 0.15s;
}

.composer:focus-within {
  border-color: var(--ink-faint);
}

.composer textarea {
  display: block;
  width: 100%;
  border: none;
  outline: none;
  background: none;
  resize: none;
}

.composer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 6px;
}

.composer-footer small {
  color: var(--ink-faint);
  font-size: 11px;
}

.send {
  padding: 6px 14px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: var(--surface);
  font-weight: 600;
}

.send:disabled {
  background: var(--surface-muted);
  color: var(--ink-faint);
}

.activity {
  display: flex;
  align-items: center;
  gap: 8px;
  align-self: flex-start;
  color: var(--ink-muted);
  font-size: 12px;
}

.mark {
  display: grid;
  flex: none;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--success-soft);
  color: var(--success);
  font-size: 10px;
  font-weight: 600;
}

.activity.failed .mark {
  background: var(--danger-soft);
  color: var(--danger);
}

.activity.running .mark {
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  background: none;
  animation: spin 0.8s linear infinite;
}

.note {
  margin: 0;
  color: var(--ink-muted);
  font-size: 12px;
}

.chat-error {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  font-size: 13px;
}

.retry {
  padding: 3px 10px;
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
  background: none;
  color: var(--danger);
  font-size: 12px;
  font-weight: 600;
}

.setup {
  margin: 16px 16px 0;
  padding: 12px 14px;
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  background: var(--accent-soft);
}

.setup p {
  margin: 0 0 10px;
  font-size: 13px;
}

.activity.change {
  color: var(--ink);
}

.activity.undone .mark,
.activity.declined .mark {
  background: var(--surface-muted);
  color: var(--ink-muted);
}

.undo {
  padding: 1px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--ink-muted);
  font-size: 11px;
  font-weight: 600;
}

.undo:hover:not(:disabled) {
  border-color: var(--ink-faint);
  color: var(--ink);
}

.undo:disabled {
  opacity: 0.5;
}

.undone-tag {
  color: var(--ink-faint);
  font-size: 11px;
}

.approval {
  padding: 12px 14px;
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  background: var(--accent-soft);
}

.approval-text {
  margin: 0 0 10px;
  font-size: 13px;
}

.approval-note {
  margin: -4px 0 10px;
  color: var(--ink-muted);
  font-size: 12px;
}

.approval-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.approval-actions button {
  padding: 5px 12px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 600;
}

.allow {
  border: none;
  background: var(--accent);
  color: var(--surface);
}

.allow-all,
.deny {
  border: 1px solid var(--border);
  background: var(--surface);
}

.send.stop {
  background: var(--ink);
}
</style>
