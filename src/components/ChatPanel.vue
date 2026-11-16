<script setup lang="ts">
// The assistant chat. Replies come from the model chosen in Assistant settings, run by the
// main process (src/assistant/), which saves every message to the project and streams
// progress here: text as it's written, each tool it uses, and requests to approve changes.
// Each change it makes can be undone from here.
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import { PROVIDERS } from '../assistant/models';
import { imageUrl, prepareImage } from '../chat-image';
import { errorMessage } from '../errors';
import { plain } from '../plain';
import { MAX_MESSAGE_IMAGES, messageImages } from '../shared/chat-images';
import { parsePickedElement, pickedLabel } from '../shared/picked-element';
import type {
  AccountState,
  ApprovalAnswer,
  AssistantChange,
  AssistantEnd,
  AssistantSettings as Settings,
  ChatMessage,
  PastedImage,
  PickedElement,
  WorkflowStage,
} from '../shared/types';
import {
  assistantRequest,
  pageToShow,
  pickedElement,
  projectChanged,
} from '../ui-signals';
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

// The part of a report page the user selected in Build visuals goes with the next message.
const composer = ref<HTMLTextAreaElement | null>(null);
watch(pickedElement, (element) => {
  if (element) composer.value?.focus();
});

/** What a saved message is about, if the user selected part of a page for it. */
function about(m: ChatMessage) {
  // Read from the project file, so checked first.
  const element = parsePickedElement(m.element);
  return element ? pickedLabel(element) : '';
}

// Images pasted into the message box go with the next message. Each is redrawn within the
// chat's limits first (chat-image.ts).
const pasted = ref<{ id: number; image: PastedImage }[]>([]);
let pastedCount = 0;

async function onPaste(event: ClipboardEvent) {
  const files = [...(event.clipboardData?.items ?? [])]
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .flatMap((item) => item.getAsFile() ?? []);
  if (!files.length) return;
  event.preventDefault();
  error.value = '';
  canRetry.value = false;
  for (const file of files) {
    if (pasted.value.length >= MAX_MESSAGE_IMAGES) {
      error.value = `A message can have up to ${MAX_MESSAGE_IMAGES} images.`;
      return;
    }
    try {
      const image = await prepareImage(file);
      pasted.value.push({ id: ++pastedCount, image });
    } catch {
      error.value =
        "Couldn't read that image. Try copying it again, or save it as a PNG or JPEG first.";
    }
  }
}

// The conversation's images, by file name, fetched from the project as messages show them.
const savedImages = ref<Record<string, string>>({});
const requestedImages = new Set<string>();

watch(
  messages,
  (list) => {
    for (const name of list.flatMap(messageImages)) {
      if (requestedImages.has(name)) continue;
      requestedImages.add(name);
      window.api.assistant
        .image(name)
        .then((image) => {
          if (image) savedImages.value[name] = imageUrl(image);
        })
        .catch(() => undefined);
    }
  },
  { deep: true },
);

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

// The chosen provider is set up: a key saved, or (for the free assistant) signed in to PawpawBI
// with a verified email address.
const ready = computed(() => !!settings.value?.ready);
// The free assistant's model isn't shown: PawpawBI chooses it.
const modelLabel = computed(() => {
  const s = settings.value;
  if (!s || !ready.value) return '';
  const product = PROVIDERS[s.provider].product;
  return s.provider === 'pawpaw'
    ? product
    : `${product} · ${s.models[s.provider]}`;
});
const canSend = computed(
  () =>
    (draft.value.trim() !== '' || pasted.value.length > 0) &&
    !loading.value &&
    !replying.value &&
    ready.value,
);

async function scrollToBottom(behavior: ScrollBehavior = 'smooth') {
  await nextTick();
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight, behavior });
}

let stopListening: (() => void) | null = null;

// The PawpawBI account, for the free assistant: signed up but not verified yet, the chat asks
// the user to open the link emailed to them instead of to sign up.
const account = ref<AccountState | null>(null);
const checking = ref(false);
const stillUnverified = ref(false);
const awaitingVerify = computed(
  () =>
    settings.value?.provider === 'pawpaw' &&
    !ready.value &&
    !!account.value?.available &&
    !!account.value.email &&
    !account.value.emailVerified,
);

/**
 * Back from verifying the email address in the browser: check again (reading the account asks
 * PawpawBI whether it's verified now).
 */
async function recheckReady() {
  if (ready.value || loading.value || checking.value) return;
  checking.value = true;
  try {
    account.value = await window.api.account.get().catch(() => account.value);
    settings.value = await window.api.assistant.getSettings();
  } finally {
    checking.value = false;
  }
}

/** "Check again": as on focus, saying so if the address still isn't verified. */
async function checkVerified() {
  stillUnverified.value = false;
  await recheckReady();
  stillUnverified.value = awaitingVerify.value;
}

/** Signing up or in happens in Assistant settings; the setup prompt follows it on closing. */
async function closeSettings() {
  showSettings.value = false;
  stillUnverified.value = false;
  if (!ready.value) {
    account.value = await window.api.account.get().catch(() => null);
  }
}

onMounted(async () => {
  window.addEventListener('focus', recheckReady);
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

  const [chat, current, signedIn] = await Promise.all([
    window.api.projects.loadChat(),
    window.api.assistant.getSettings(),
    window.api.account.get().catch(() => null),
  ]);
  stage.value = chat.stage;
  messages.value = chat.messages;
  settings.value = current;
  account.value = signedIn;
  await loadChanges();
  loading.value = false;
  await scrollToBottom('auto');
});

onBeforeUnmount(() => {
  stopListening?.();
  window.removeEventListener('focus', recheckReady);
  pickedElement.value = null;
});

const END_NOTES: Partial<Record<AssistantEnd, string>> = {
  steps:
    'The assistant stopped after a lot of steps. Say "carry on" to let it continue.',
  length: 'The reply was cut off because it got too long.',
  refused: 'The model declined to answer that.',
  stopped: 'Stopped.',
};

async function run(
  request: () => Promise<AssistantEnd>,
  text?: string,
  element: PickedElement | null = null,
  images: { id: number; image: PastedImage }[] = [],
) {
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
      pickedElement.value ??= element;
      if (!pasted.value.length) pasted.value = images;
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
  const element = plain(pickedElement.value);
  pickedElement.value = null;
  const images = plain(pasted.value);
  pasted.value = [];
  run(
    () =>
      window.api.assistant.send(
        text,
        element,
        images.map((p) => p.image),
      ),
    text,
    element,
    images,
  );
}

// A request from elsewhere in the app ("Fix with assistant"), sent as the user's message. What
// the user is writing (and any selected element or pasted images) stays for their next message.
// When it can't be sent yet (a reply is running, or the assistant isn't set up), it goes in the
// message box instead.
watch(assistantRequest, (text) => {
  if (!text) return;
  assistantRequest.value = null;
  if (!loading.value && !replying.value && ready.value) {
    run(() => window.api.assistant.send(text), text);
  } else {
    draft.value = draft.value.trim()
      ? `${draft.value.trimEnd()}\n\n${text}`
      : text;
    composer.value?.focus();
  }
});

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

    <div v-if="!loading && awaitingVerify" class="setup">
      <p>
        <strong>Verify your email address to start.</strong> We emailed a link
        to {{ account!.email }}. Open it, then come back here.
      </p>
      <p v-if="stillUnverified" class="setup-note" role="status">
        Your address isn't verified yet. Check your spam folder{{
          account!.consoleUrl ? ', or send a new link' : ''
        }}.
      </p>
      <div class="setup-actions">
        <button class="btn-primary" :disabled="checking" @click="checkVerified">
          {{ checking ? 'Checking…' : 'Check again' }}
        </button>
        <a
          v-if="account!.consoleUrl"
          :href="`${account!.consoleUrl}/#/account`"
          target="_blank"
          rel="noreferrer"
          >Send a new link</a
        >
      </div>
    </div>

    <div v-else-if="!loading && !ready" class="setup">
      <p>
        The assistant is free with a PawpawBI account. Sign up or sign in to
        start, or use your own Claude or ChatGPT key.
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
          <span v-if="about(m)" class="about">About {{ about(m) }}</span>
          <template v-for="name in messageImages(m)" :key="name">
            <img
              v-if="savedImages[name]"
              class="pasted-image"
              :src="savedImages[name]"
              alt="An image you pasted"
            />
          </template>
          <span v-if="m.text">{{ m.text }}</span>
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
      <div v-if="pickedElement" class="picked">
        <span class="picked-label">
          About {{ pickedLabel(pickedElement) }}
        </span>
        <button
          type="button"
          class="picked-remove"
          title="Don't include the selected part of the page"
          aria-label="Don't include the selected part of the page"
          @click="pickedElement = null"
        >
          ×
        </button>
      </div>
      <ul v-if="pasted.length" class="thumbs" aria-label="Images to send">
        <li v-for="(p, i) in pasted" :key="p.id" class="thumb">
          <img :src="imageUrl(p.image)" :alt="`Image ${i + 1}`" />
          <button
            type="button"
            class="thumb-remove"
            :title="`Remove image ${i + 1}`"
            :aria-label="`Remove image ${i + 1}`"
            @click="pasted.splice(i, 1)"
          >
            ×
          </button>
        </li>
      </ul>
      <textarea
        ref="composer"
        v-model="draft"
        rows="3"
        @paste="onPaste"
        :placeholder="
          pickedElement
            ? 'What would you like to change about it?'
            : 'Message the assistant…'
        "
        @keydown="onKeydown"
      ></textarea>
      <div class="composer-footer">
        <small>Shift + Enter for a new line. Paste to add an image.</small>
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
      @close="closeSettings"
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

.message.user .about {
  display: block;
  margin-bottom: 4px;
  font-size: 12px;
  opacity: 0.75;
}

.pasted-image {
  display: block;
  max-width: 100%;
  max-height: 180px;
  margin-bottom: 6px;
  border-radius: var(--radius-sm);
  background: var(--surface);
}

.pasted-image:last-child {
  margin-bottom: 0;
}

.thumbs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0 0 8px;
  padding: 0;
  list-style: none;
}

.thumb {
  position: relative;
  width: 56px;
  height: 56px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-muted);
}

.thumb img {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: inherit;
  object-fit: cover;
}

.thumb-remove {
  position: absolute;
  top: -7px;
  right: -7px;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--surface);
  color: var(--ink-muted);
  font-size: 12px;
  line-height: 1;
}

.thumb-remove:hover {
  border-color: var(--ink-faint);
  color: var(--ink);
}

.picked {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  padding: 4px 4px 4px 10px;
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  font-size: 12px;
}

.picked-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.picked-remove {
  flex: none;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--ink-muted);
  font-size: 15px;
  line-height: 1;
}

.picked-remove:hover {
  color: var(--ink);
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

.setup .setup-note {
  color: var(--ink-muted);
  font-size: 12px;
}

.setup-actions {
  display: flex;
  align-items: center;
  gap: 14px;
}

.setup-actions a {
  color: var(--accent);
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
