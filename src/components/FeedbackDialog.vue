<script setup lang="ts">
// Feedback to the PawpawBI team, from the Feedback button in the top bar. Sent through the
// PawpawBI server, as the signed-in account or with an address to reply to (src/account.ts).
import { computed, onMounted, ref } from 'vue';
import { errorMessage } from '../errors';

const emit = defineEmits<{ close: [] }>();

/** The longest message the server takes. */
const MAX_MESSAGE = 5000;

const message = ref('');
const email = ref('');
/** The signed-in account's address, or null when not signed in. */
const account = ref<string | null>(null);
const sending = ref(false);
const sent = ref(false);
const error = ref('');
const box = ref<HTMLTextAreaElement | null>(null);

const canSend = computed(() => message.value.trim() !== '' && !sending.value);

onMounted(async () => {
  box.value?.focus();
  account.value =
    (await window.api.account.get().catch(() => null))?.email ?? null;
});

async function send() {
  if (!canSend.value) return;
  sending.value = true;
  error.value = '';
  try {
    await window.api.account.sendFeedback(
      message.value,
      account.value ? undefined : email.value,
    );
    sent.value = true;
  } catch (e) {
    error.value = `Couldn't send your feedback. ${errorMessage(e)}`;
  } finally {
    sending.value = false;
  }
}

/** Closes, unless that would lose what the user wrote (clicking outside the dialog). */
function closeFromOutside() {
  if (sent.value || !message.value.trim()) emit('close');
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('close');
}
</script>

<template>
  <div class="backdrop" @click.self="closeFromOutside" @keydown="onKeydown">
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="feedback-title"
    >
      <header class="head">
        <h2 id="feedback-title">Send feedback</h2>
        <button class="close" aria-label="Close" @click="emit('close')">
          ×
        </button>
      </header>

      <template v-if="sent">
        <p class="box-notice" role="status">
          Thanks for your feedback. We read every message{{
            account || email.trim()
              ? ', and we’ll reply if we have questions'
              : ''
          }}.
        </p>
        <div class="actions">
          <button class="btn-primary" @click="emit('close')">Close</button>
        </div>
      </template>

      <form v-else class="form" @submit.prevent="send">
        <p class="intro">
          Tell us what's working, what isn't, or what you'd like PawpawBI to do.
        </p>
        <textarea
          ref="box"
          v-model="message"
          rows="7"
          aria-label="Your feedback"
          placeholder="Your feedback…"
          :maxlength="MAX_MESSAGE"
        ></textarea>

        <p v-if="account" class="hint">We'll reply to {{ account }}.</p>
        <label v-else class="field">
          <span>Your email address (optional)</span>
          <input
            v-model="email"
            type="email"
            autocomplete="email"
            placeholder="So we can reply"
          />
        </label>

        <p class="hint">
          Sends your message{{
            account ? '' : ', your address if you give one,'
          }}
          and the versions of PawpawBI and Windows you're using. Nothing from
          your project.
        </p>
        <p v-if="error" class="box-error" role="alert">{{ error }}</p>

        <div class="actions">
          <button class="btn-primary" type="submit" :disabled="!canSend">
            {{ sending ? 'Sending…' : 'Send feedback' }}
          </button>
          <button class="btn-ghost" type="button" @click="emit('close')">
            Cancel
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgb(31 28 23 / 0.35);
}

.dialog {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: min(520px, 100%);
  max-height: 100%;
  overflow-y: auto;
  padding: 24px 26px;
  border-radius: var(--radius-lg);
  background: var(--surface);
  box-shadow: var(--shadow-md);
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.head h2 {
  font-size: 22px;
}

.close {
  border: none;
  background: none;
  color: var(--ink-muted);
  font-size: 22px;
  line-height: 1;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.intro {
  margin: 0;
}

textarea,
input {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  font: inherit;
}

textarea {
  resize: vertical;
}

textarea:focus,
input:focus {
  border-color: var(--ink);
  outline: none;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  font-weight: 600;
}

.field input {
  font-weight: 400;
}

.hint {
  margin: 0;
  color: var(--ink-muted);
  font-size: 13px;
  overflow-wrap: anywhere;
}

.actions {
  display: flex;
  gap: 8px;
}
</style>
