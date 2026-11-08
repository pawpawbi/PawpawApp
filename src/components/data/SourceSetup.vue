<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref } from 'vue';
import { errorMessage } from '../../errors';
import { plain } from '../../plain';
import type {
  ConnectorInfo,
  DataSource,
  DiscoveredResource,
  LoadedTable,
} from '../../shared/types';
import RunningTimer from '../RunningTimer.vue';
import ConnectorFieldInput from './ConnectorFieldInput.vue';

const props = defineProps<{
  connector: ConnectorInfo;
  /** Set when editing an existing source. */
  source?: DataSource;
}>();
const emit = defineEmits<{
  done: [];
  cancel: [];
  preview: [table: string];
}>();

type Step = 'settings' | 'tables' | 'loading' | 'finished';
const step = ref<Step>('settings');
const busy = ref(false);
const error = ref('');
// True while connecting to the source to find its tables (after saving it), which can be stopped.
const connecting = ref(false);
const progress = ref('');
const showAdvanced = ref(false);

const savedSource = ref<DataSource | undefined>(props.source);
// Left blank for a new source; saving uses the connector's name (shown as the placeholder).
const name = ref(props.source?.name ?? '');
const settings = reactive<Record<string, unknown>>(
  Object.fromEntries(
    props.connector.fields.map((f) => [
      f.key,
      props.source?.options[f.key] ??
        f.default ??
        (f.type === 'checkbox' ? false : f.type === 'files' ? [] : ''),
    ]),
  ),
);

const basicFields = computed(() =>
  props.connector.fields.filter((f) => !f.advanced),
);
const advancedFields = computed(() =>
  props.connector.fields.filter((f) => f.advanced),
);
const isSaved = (key: string) =>
  savedSource.value?.savedSecrets.includes(key) ?? false;

const missing = computed(() =>
  props.connector.fields
    .filter((f) => f.required)
    .filter((f) => {
      const value = settings[f.key];
      const empty =
        value === '' ||
        value === null ||
        value === undefined ||
        (Array.isArray(value) && !value.length);
      return empty && !(f.secret && isSaved(f.key));
    })
    .map((f) => f.label),
);

const resources = ref<DiscoveredResource[]>([]);
const chosen = ref<Set<string>>(new Set());
const filter = ref('');
const visibleResources = computed(() =>
  resources.value.filter((r) =>
    r.name.toLowerCase().includes(filter.value.toLowerCase()),
  ),
);
const loaded = ref<LoadedTable[]>([]);

// True once a load's data has arrived and is being processed: it can't be stopped then.
const received = ref(false);

const unsubscribe = window.api.data.onProgress((p) => {
  if (p.sourceId !== savedSource.value?.id) return;
  progress.value = p.message;
  received.value = p.received === true;
});
onBeforeUnmount(unsubscribe);

async function connect() {
  if (busy.value) return;
  if (missing.value.length) {
    error.value = `Fill in: ${missing.value.join(', ')}.`;
    return;
  }
  busy.value = true;
  error.value = '';
  progress.value = 'Saving…';
  try {
    savedSource.value = await window.api.data.saveSource({
      id: savedSource.value?.id,
      type: props.connector.id,
      name: name.value,
      settings: plain(settings),
    });
    // Secrets are saved now; clear them from the form.
    for (const f of props.connector.fields) if (f.secret) settings[f.key] = '';

    progress.value = 'Connecting…';
    connecting.value = true;
    try {
      resources.value = await window.api.data.discover(savedSource.value.id);
    } finally {
      connecting.value = false;
    }
    const previous = savedSource.value.resources;
    chosen.value = new Set(
      resources.value
        .filter((r) =>
          previous.length ? previous.includes(r.name) : r.selected,
        )
        .map((r) => r.name),
    );
    // Nothing to choose between: go straight to loading.
    if (resources.value.length === 1) {
      chosen.value = new Set([resources.value[0].name]);
      await load();
      return;
    }
    step.value = 'tables';
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    busy.value = false;
  }
}

async function load() {
  if (!savedSource.value || chosen.value.size === 0) return;
  step.value = 'loading';
  error.value = '';
  progress.value = 'Starting…';
  received.value = false;
  try {
    loaded.value = await window.api.data.load(savedSource.value.id, [
      ...chosen.value,
    ]);
    step.value = 'finished';
  } catch (err) {
    error.value = errorMessage(err);
    step.value = resources.value.length > 1 ? 'tables' : 'settings';
  }
}

/** Stops connecting or loading. The call that's running then fails with "Stopped.". */
function stop() {
  if (savedSource.value) window.api.data.stop(savedSource.value.id);
}

function toggle(name: string) {
  const next = new Set(chosen.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  chosen.value = next;
}

function selectAll(selected: boolean) {
  chosen.value = new Set(selected ? resources.value.map((r) => r.name) : []);
}

const totalRows = computed(() =>
  loaded.value.reduce((sum, t) => sum + t.rows, 0),
);
const formatNumber = (n: number) => n.toLocaleString();
</script>

<template>
  <div class="setup">
    <header class="head">
      <span class="monogram" aria-hidden="true">{{
        connector.name.charAt(0)
      }}</span>
      <div class="head-text">
        <h2>{{ source ? `Edit ${source.name}` : connector.name }}</h2>
        <p>{{ connector.description }}</p>
      </div>
      <a
        v-if="connector.docsUrl"
        class="docs"
        :href="connector.docsUrl"
        target="_blank"
        rel="noreferrer"
        >Docs ↗</a
      >
    </header>

    <ol class="steps" aria-label="Progress">
      <li :class="{ current: step === 'settings', done: step !== 'settings' }">
        Connect
      </li>
      <li
        :class="{
          current: step === 'tables',
          done: step === 'loading' || step === 'finished',
        }"
      >
        Choose tables
      </li>
      <li :class="{ current: step === 'loading', done: step === 'finished' }">
        Load
      </li>
    </ol>

    <p v-if="error" class="box-error error" role="alert">{{ error }}</p>

    <!-- 1. Settings -->
    <form v-if="step === 'settings'" class="form" @submit.prevent="connect">
      <div class="field-name">
        <label for="source-name">Name</label>
        <input
          id="source-name"
          v-model="name"
          type="text"
          :placeholder="connector.name"
        />
      </div>

      <ConnectorFieldInput
        v-for="field in basicFields"
        :key="field.key"
        v-model="settings[field.key]"
        :field="field"
        :saved="field.secret && isSaved(field.key)"
      />

      <template v-if="advancedFields.length">
        <button
          type="button"
          class="btn-link toggle"
          @click="showAdvanced = !showAdvanced"
        >
          {{ showAdvanced ? 'Hide' : 'Show' }} advanced settings
        </button>
        <ConnectorFieldInput
          v-for="field in showAdvanced ? advancedFields : []"
          :key="field.key"
          v-model="settings[field.key]"
          :field="field"
          :saved="field.secret && isSaved(field.key)"
        />
      </template>

      <p v-if="connector.packages.length" class="note">
        The first time you use this connector, PawpawBI downloads the components
        it needs. This needs an internet connection.
      </p>
      <p class="note">
        Passwords and keys are encrypted on this computer and are never saved in
        the project file.
      </p>

      <div class="actions">
        <button
          type="button"
          class="btn-ghost"
          :disabled="busy"
          @click="$emit('cancel')"
        >
          Cancel
        </button>
        <RunningTimer v-if="connecting" @stop="stop" />
        <button type="submit" class="btn-primary" :disabled="busy">
          {{ busy ? progress || 'Connecting…' : 'Connect' }}
        </button>
      </div>
    </form>

    <!-- 2. Choose tables -->
    <div v-else-if="step === 'tables'" class="tables">
      <div class="tables-head">
        <p>
          <strong>{{ resources.length }}</strong> tables available. Choose the
          ones to load.
        </p>
        <div class="tables-tools">
          <input
            v-if="resources.length > 8"
            v-model="filter"
            type="search"
            placeholder="Filter tables…"
          />
          <button class="btn-link" @click="selectAll(true)">Select all</button>
          <button class="btn-link" @click="selectAll(false)">None</button>
        </div>
      </div>
      <ul class="resource-list">
        <li v-for="r in visibleResources" :key="r.name">
          <label>
            <input
              type="checkbox"
              :checked="chosen.has(r.name)"
              @change="toggle(r.name)"
            />
            {{ r.name }}
          </label>
        </li>
      </ul>
      <div class="actions">
        <button class="btn-ghost" @click="step = 'settings'">Back</button>
        <button class="btn-primary" :disabled="chosen.size === 0" @click="load">
          Load {{ chosen.size }} {{ chosen.size === 1 ? 'table' : 'tables' }}
        </button>
      </div>
    </div>

    <!-- 3. Loading -->
    <div v-else-if="step === 'loading'" class="loading" aria-live="polite">
      <span class="spinner" aria-hidden="true"></span>
      <strong>Loading data</strong>
      <p>{{ progress }}</p>
      <RunningTimer :can-stop="!received" @stop="stop" />
    </div>

    <!-- 4. Finished -->
    <div v-else class="finished">
      <div class="success">
        <strong
          >Loaded {{ formatNumber(totalRows) }} rows into {{ loaded.length }}
          {{ loaded.length === 1 ? 'table' : 'tables' }}</strong
        >
        <p>Save the project to keep this data.</p>
      </div>
      <ul class="loaded-list">
        <li v-for="t in loaded" :key="t.name">
          <button class="loaded" @click="$emit('preview', t.name)">
            <span>{{ t.name }}</span>
            <small>{{ formatNumber(t.rows) }} rows</small>
            <small
              v-if="t.transformError"
              class="transform-error"
              :title="t.transformError"
            >
              SQL transform failed, showing original data
            </small>
            <span class="preview-link">Preview →</span>
          </button>
        </li>
      </ul>
      <div class="actions">
        <button class="btn-primary" @click="$emit('done')">Done</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.setup {
  display: flex;
  flex-direction: column;
  gap: 20px;
  max-width: 640px;
}

.head {
  display: flex;
  align-items: flex-start;
  gap: 14px;
}

.monogram {
  display: grid;
  place-items: center;
  flex: none;
  width: 48px;
  height: 48px;
  border-radius: var(--radius);
  background: var(--accent-soft);
  color: var(--accent);
  font-family: var(--font-display);
  font-weight: var(--display-weight);
  font-size: 22px;
}

.head-text {
  flex: 1;
}

.head h2 {
  font-size: 24px;
}

.head p {
  margin: 4px 0 0;
  color: var(--ink-muted);
}

.docs {
  color: var(--ink-muted);
  font-size: 13px;
  white-space: nowrap;
}

.steps {
  display: flex;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
  counter-reset: step;
}

.steps li {
  flex: 1;
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  background: var(--surface-muted);
  color: var(--ink-faint);
  font-size: 12px;
  font-weight: 600;
  counter-increment: step;
}

.steps li::before {
  content: counter(step) '. ';
}

.steps li.current {
  background: var(--accent-soft);
  color: var(--accent);
}

.steps li.done {
  color: var(--ink-muted);
}

.error {
  white-space: pre-wrap;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.field-name {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-name label {
  font-weight: 600;
  font-size: 13px;
}

.field-name input {
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font: inherit;
}

.toggle {
  align-self: flex-start;
}

.note {
  margin: 0;
  color: var(--ink-faint);
  font-size: 12px;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.tables {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.tables-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.tables-head p {
  margin: 0;
}

.tables-tools {
  display: flex;
  align-items: center;
  gap: 12px;
}

.tables-tools input {
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font: inherit;
}

.resource-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 4px;
  max-height: 360px;
  margin: 0;
  padding: 10px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  list-style: none;
}

.resource-list label {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 6px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  overflow-wrap: anywhere;
}

.resource-list label:hover {
  background: var(--surface-muted);
}

.resource-list input {
  accent-color: var(--accent);
}

.loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 48px 24px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  text-align: center;
}

.loading p {
  margin: 0;
  color: var(--ink-muted);
  overflow-wrap: anywhere;
}

.spinner {
  width: 28px;
  height: 28px;
  border: 3px solid var(--surface-muted);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.finished {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.success {
  padding: 14px 16px;
  border-radius: var(--radius);
  background: var(--success-soft);
  color: var(--success);
}

.success p {
  margin: 2px 0 0;
  font-size: 13px;
}

.loaded-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.loaded {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  text-align: left;
}

.loaded:hover {
  border-color: var(--ink-faint);
}

.loaded span:first-child {
  flex: 1;
  font-weight: 600;
}

.loaded small {
  color: var(--ink-muted);
}

.loaded small.transform-error {
  color: var(--danger);
}

.preview-link {
  color: var(--accent);
  font-size: 13px;
  font-weight: 600;
}
</style>
