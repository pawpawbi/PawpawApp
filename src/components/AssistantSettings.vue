<script setup lang="ts">
// Assistant settings: which provider (the free assistant with a PawpawBI account, or Claude or
// ChatGPT with the user's own API key), the key and model. Keys are stored encrypted on this
// computer by the main process and never come back to this page. The free assistant needs a
// PawpawBI account instead, signed in here; it shows how much of the month's allowance is used,
// never its model.
import { computed, onMounted, ref, watch } from 'vue';
import { DEFAULT_PROVIDER, PROVIDERS, pickModel } from '../assistant/models';
import { errorMessage } from '../errors';
import type {
  AccountState,
  AllowanceUsage,
  AssistantPermissions,
  AssistantProvider,
  AssistantSettings,
} from '../shared/types';
import AccountPanel from './AccountPanel.vue';

const emit = defineEmits<{
  close: [];
  changed: [settings: AssistantSettings];
}>();

const settings = ref<AssistantSettings | null>(null);
const provider = ref<AssistantProvider>(DEFAULT_PROVIDER);
const key = ref('');
const replacing = ref(false);
const models = ref<string[]>([]);
const model = ref('');
const busy = ref<'' | 'key' | 'models'>('');
const error = ref('');

const info = computed(() => PROVIDERS[provider.value]);

async function setPermissions(permissions: AssistantPermissions) {
  await window.api.assistant.setPermissions(permissions);
  await reload();
}
const hasKey = computed(() => settings.value?.hasKey[provider.value] ?? false);
/** Whether models can be listed and chosen: only with a saved key. */
const canList = computed(() => info.value.needsKey && hasKey.value);

// The free assistant: the PawpawBI account and this month's allowance.
const account = ref<AccountState | null>(null);
const usage = ref<AllowanceUsage | null>(null);

async function onAccount(next: AccountState) {
  account.value = next;
  await reload();
  usage.value =
    next.email && next.emailVerified
      ? await window.api.assistant.usage()
      : null;
}

const usageText = computed(() => {
  if (!usage.value) return '';
  const resets = new Date(usage.value.resetsAt).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
  return usage.value.share >= 1
    ? `You've used this month's free assistant. It starts again on ${resets}.`
    : `${Math.round(usage.value.share * 100)}% of this month's allowance used. It starts again on ${resets}.`;
});

async function reload() {
  settings.value = await window.api.assistant.getSettings();
  emit('changed', settings.value);
}

/**
 * Lists the provider's models and saves the model to use. If the user switches provider while
 * the list loads, the late list is dropped so it can't be saved under the new provider.
 */
async function loadModels() {
  const forProvider = provider.value;
  const current = () => provider.value === forProvider;
  models.value = [];
  if (!canList.value) return;
  busy.value = 'models';
  error.value = '';
  try {
    const list = await window.api.assistant.listModels(forProvider);
    if (!current()) return;
    models.value = list;
    model.value = pickModel(
      forProvider,
      list,
      settings.value?.models[forProvider],
    );
    await window.api.assistant.saveSettings(forProvider, model.value);
    await reload();
  } catch (e) {
    if (current()) error.value = errorMessage(e);
  } finally {
    if (current()) busy.value = '';
  }
}

async function save() {
  await window.api.assistant.saveSettings(provider.value, model.value);
  await reload();
}

// The provider choices are enabled once the saved settings are shown.
const loaded = ref(false);

onMounted(async () => {
  await reload();
  provider.value = settings.value!.provider;
  model.value = settings.value!.models[provider.value];
  loaded.value = true;
  await loadModels();
});

watch(provider, async (next) => {
  // Showing the saved choice isn't a change.
  if (next === settings.value?.provider) return;
  key.value = '';
  replacing.value = false;
  error.value = '';
  model.value = settings.value?.models[next] ?? '';
  await save();
  await loadModels();
});

async function saveKey() {
  busy.value = 'key';
  error.value = '';
  try {
    await window.api.assistant.setKey(provider.value, key.value);
    // Check the key works before keeping it.
    try {
      models.value = await window.api.assistant.listModels(provider.value);
    } catch (e) {
      await window.api.assistant.removeKey(provider.value);
      throw e;
    }
    key.value = '';
    replacing.value = false;
    model.value = pickModel(
      provider.value,
      models.value,
      settings.value?.models[provider.value],
    );
    await save();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = '';
  }
}

async function removeKey() {
  if (
    !window.confirm(
      `Remove the ${info.value.name} API key from this computer? The assistant won't work with ${info.value.product} until you add one again.`,
    )
  ) {
    return;
  }
  await window.api.assistant.removeKey(provider.value);
  models.value = [];
  await reload();
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('close');
}
</script>

<template>
  <div class="backdrop" @click.self="emit('close')" @keydown="onKeydown">
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="assistant-settings-title"
    >
      <header class="head">
        <h2 id="assistant-settings-title">Assistant settings</h2>
        <button class="close" aria-label="Close" @click="emit('close')">
          ×
        </button>
      </header>

      <fieldset class="providers">
        <legend>AI model provider</legend>
        <label
          v-for="(p, id) in PROVIDERS"
          :key="id"
          class="provider"
          :class="{ chosen: provider === id }"
        >
          <input
            v-model="provider"
            type="radio"
            name="provider"
            :value="id"
            :disabled="!loaded"
          />
          <span class="provider-name">{{ p.product }}</span>
          <span class="provider-by">{{
            p.needsKey ? `Your key, by ${p.name}` : 'Free with an account'
          }}</span>
          <span v-if="settings?.hasKey[id]" class="provider-key"
            >Key saved</span
          >
        </label>
      </fieldset>

      <section v-if="!info.needsKey" class="section">
        <h3>Free with a PawpawBI account</h3>
        <p class="hint first">
          The assistant is included with a free PawpawBI account, with a monthly
          allowance. Or choose Claude or ChatGPT above to use your own API key.
        </p>
        <AccountPanel purpose="assistant" @changed="onAccount" />
        <div v-if="usage" class="allowance">
          <div
            class="meter"
            role="meter"
            aria-label="This month's allowance used"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="Math.round(usage.share * 100)"
          >
            <span :style="{ width: `${usage.share * 100}%` }" />
          </div>
          <p class="hint">{{ usageText }}</p>
        </div>
      </section>

      <section v-else class="section">
        <h3>API key</h3>
        <template v-if="hasKey && !replacing">
          <p class="saved">
            A {{ info.name }} key is saved on this computer.
            <button class="btn-link" @click="replacing = true">Replace</button>
            <button class="btn-link danger" @click="removeKey">Remove</button>
          </p>
        </template>
        <form v-else class="key-form" @submit.prevent="saveKey">
          <input
            v-model="key"
            type="password"
            autocomplete="off"
            spellcheck="false"
            :placeholder="`Paste your ${info.name} API key`"
            aria-label="API key"
          />
          <button
            class="btn-primary"
            type="submit"
            :disabled="!key.trim() || busy === 'key'"
          >
            {{ busy === 'key' ? 'Checking…' : 'Save key' }}
          </button>
        </form>
        <p class="hint">
          Get a key from your
          <a :href="info.url" target="_blank" rel="noreferrer"
            >{{ info.name }} account</a
          >. Usage is billed to that account.
        </p>
      </section>

      <section v-if="canList" class="section">
        <h3>Model</h3>
        <select
          v-model="model"
          :disabled="busy === 'models' || !models.length"
          aria-label="Model"
          @change="save"
        >
          <option v-if="!models.length" :value="model">
            {{ busy === 'models' ? 'Loading models…' : model }}
          </option>
          <option v-for="m in models" :key="m" :value="m">{{ m }}</option>
        </select>
      </section>

      <fieldset class="section permissions">
        <legend>Changes</legend>
        <label class="option">
          <input
            type="radio"
            name="permissions"
            :checked="settings?.permissions !== 'allow'"
            @change="setPermissions('ask')"
          />
          <span>
            <strong>Ask before each change</strong>
            <small
              >The assistant asks you to allow each change it wants to make to
              the project.</small
            >
          </span>
        </label>
        <label class="option">
          <input
            type="radio"
            name="permissions"
            :checked="settings?.permissions === 'allow'"
            @change="setPermissions('allow')"
          />
          <span>
            <strong>Make changes without asking</strong>
            <small
              >Changes still show in the chat, and each can be undone.</small
            >
          </span>
        </label>
      </fieldset>

      <p v-if="error" class="box-error error" role="alert">{{ error }}</p>

      <p v-if="info.needsKey" class="privacy">
        Your messages, and the samples of your data the assistant looks at, are
        sent to {{ info.name }}. Your key is stored encrypted on this computer,
        never in project files.
      </p>
      <p v-else class="privacy">
        Your messages, and the samples of your data the assistant looks at, go
        through PawpawBI. PawpawBI doesn't keep
        them, only how much of your allowance each reply used.
      </p>

      <footer class="foot">
        <button class="btn-primary" @click="emit('close')">Done</button>
      </footer>
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
  gap: 18px;
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

.providers {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin: 0;
  padding: 0;
  border: none;
}

.providers legend {
  margin-bottom: 8px;
  font-weight: 600;
}

.provider {
  position: relative;
  display: flex;
  flex-direction: column;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
}

.provider.chosen {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.provider input {
  position: absolute;
  opacity: 0;
}

.provider:focus-within {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.provider-name {
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: var(--display-weight);
}

.provider-by {
  color: var(--ink-muted);
  font-size: 13px;
}

.provider-key {
  margin-top: 6px;
  color: var(--success);
  font-size: 12px;
  font-weight: 600;
}

.section h3 {
  margin-bottom: 8px;
  font-family: var(--font-body);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0;
}

.saved {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin: 0;
}

.key-form {
  display: flex;
  gap: 8px;
}

.key-form input,
select {
  flex: 1;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  font: inherit;
}

.permissions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  border: none;
}

.permissions legend {
  margin-bottom: 8px;
  font-weight: 600;
}

.option {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  cursor: pointer;
}

.option input {
  margin-top: 3px;
  accent-color: var(--accent);
}

.option span {
  display: flex;
  flex-direction: column;
}

.option small {
  color: var(--ink-muted);
  font-size: 12px;
}

.allowance {
  margin-top: 12px;
}

.meter {
  height: 6px;
  overflow: hidden;
  border-radius: var(--radius-sm);
  background: var(--surface-muted);
}

.meter span {
  display: block;
  height: 100%;
  background: var(--accent);
}

.hint.first {
  margin-top: 0;
}

.hint,
.privacy {
  margin: 8px 0 0;
  color: var(--ink-muted);
  font-size: 13px;
}

.privacy {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--surface-muted);
}

.hint a {
  color: var(--ink);
}

.error {
  padding: 10px 12px;
  font-size: 13px;
}

.foot {
  display: flex;
  justify-content: flex-end;
}
</style>
