<script setup lang="ts">
import {
  computed,
  onActivated,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import { errorMessage } from '../../errors';
import { plain } from '../../plain';
import type {
  ConnectorCatalog,
  ConnectorInfo,
  DataSource,
} from '../../shared/types';
import { timeAgo } from '../../time';
import { projectChanged } from '../../ui-signals';
import RunningTimer from '../RunningTimer.vue';
import ConnectorGallery from './ConnectorGallery.vue';
import SourceSetup from './SourceSetup.vue';
import TablePreview from './TablePreview.vue';

type View =
  | { name: 'overview' }
  | { name: 'gallery' }
  | { name: 'setup'; connector: ConnectorInfo; source?: DataSource }
  | { name: 'preview'; table: string; returnTo: View };

const view = ref<View>({ name: 'overview' });
const catalog = ref<ConnectorCatalog | null>(null);
const sources = ref<DataSource[]>([]);
const loading = ref(true);
const error = ref('');

// Refresh status per source: progress messages while running, or the last error.
const refreshing = ref<Record<string, string>>({});
const refreshErrors = ref<Record<string, string>>({});
const confirmingRemove = ref<string | null>(null);

const QUICK_PICKS = ['local_files', 'postgres', 'google_sheets', 'rest_api'];

// Sources whose load has its data and is processing it (it can't be stopped then).
const processing = ref(new Set<string>());

const unsubscribe = window.api.data.onProgress((p) => {
  if (!(p.sourceId in refreshing.value)) return;
  refreshing.value = { ...refreshing.value, [p.sourceId]: p.message };
  const next = new Set(processing.value);
  if (p.received) next.add(p.sourceId);
  else next.delete(p.sourceId);
  processing.value = next;
});
onBeforeUnmount(unsubscribe);

onMounted(async () => {
  try {
    [catalog.value, sources.value] = await Promise.all([
      window.api.data.catalog(),
      window.api.data.listSources(),
    ]);
  } catch (err) {
    error.value = `Couldn't load the connector list. ${errorMessage(err)}`;
  } finally {
    loading.value = false;
  }
});

const connectorFor = (type: string) =>
  catalog.value?.connectors.find((c) => c.id === type);
const quickPicks = computed(() =>
  QUICK_PICKS.map((id) => connectorFor(id)).filter((c): c is ConnectorInfo =>
    Boolean(c),
  ),
);

/** Picks up the sources as saved. A failure shows at the top of the screen. */
async function reloadSources() {
  try {
    sources.value = await window.api.data.listSources();
  } catch (err) {
    error.value = `Couldn't load the data sources. ${errorMessage(err)}`;
  }
}

// Tables can be deleted on the Model data screen, so reload when coming back to this one, and
// when the assistant changes the project (or a change is undone).
onActivated(() => {
  if (!loading.value) reloadSources();
});
watch(projectChanged, reloadSources);

/** Done or Cancel in the setup. Connecting saves the source even if the user then cancels, so
 * the list is reloaded either way. */
async function leaveSetup() {
  await reloadSources();
  view.value = { name: 'overview' };
}

async function refresh(source: DataSource) {
  refreshing.value = { ...refreshing.value, [source.id]: 'Starting…' };
  const { [source.id]: _, ...otherErrors } = refreshErrors.value;
  refreshErrors.value = otherErrors;
  try {
    await window.api.data.load(source.id, plain(source.resources));
    await reloadSources();
  } catch (err) {
    refreshErrors.value = {
      ...refreshErrors.value,
      [source.id]: errorMessage(err),
    };
  } finally {
    const { [source.id]: __, ...rest } = refreshing.value;
    refreshing.value = rest;
    const next = new Set(processing.value);
    next.delete(source.id);
    processing.value = next;
  }
}

async function remove(source: DataSource) {
  confirmingRemove.value = null;
  try {
    await window.api.data.removeSource(source.id);
    await reloadSources();
  } catch (err) {
    refreshErrors.value = {
      ...refreshErrors.value,
      [source.id]: errorMessage(err),
    };
  }
}

/** Stops a source's load. Its refresh call then fails with "Stopped.". */
const stopLoad = (source: DataSource) => window.api.data.stop(source.id);

function edit(source: DataSource) {
  const connector = connectorFor(source.type);
  if (connector) view.value = { name: 'setup', connector, source };
}

/** The data source that loaded a table. */
const sourceOf = (table: string) =>
  sources.value.find((s) => s.tables.includes(table));

function editTableSource(table: string) {
  const source = sourceOf(table);
  if (source) edit(source);
}

async function previewFromSetup(table: string) {
  const returnTo = view.value;
  // The load just finished, so pick up its tables (this also shows the Edit source button).
  await reloadSources();
  view.value = { name: 'preview', table, returnTo };
}
</script>

<template>
  <div class="get-data">
    <p v-if="loading" class="status">Loading connectors…</p>
    <p v-if="error" class="box-error error" role="alert">{{ error }}</p>

    <template v-if="catalog">
      <ConnectorGallery
        v-if="view.name === 'gallery'"
        :catalog="catalog"
        @choose="view = { name: 'setup', connector: $event }"
        @cancel="view = { name: 'overview' }"
      />

      <SourceSetup
        v-else-if="view.name === 'setup'"
        :connector="view.connector"
        :source="view.source"
        @done="leaveSetup"
        @cancel="leaveSetup"
        @preview="previewFromSetup($event)"
      />

      <TablePreview
        v-else-if="view.name === 'preview'"
        :key="view.table"
        :table="view.table"
        :source="sourceOf(view.table)"
        @back="view = view.returnTo"
        @edit="editTableSource(view.table)"
        @refreshed="reloadSources"
      />

      <!-- Overview -->
      <div v-else class="overview">
        <header class="head">
          <div>
            <h2>Data</h2>
            <p>
              Connect to your data. Each source loads into tables inside this
              project.
            </p>
          </div>
          <button
            v-if="sources.length"
            class="btn-primary"
            @click="view = { name: 'gallery' }"
          >
            + Add data source
          </button>
        </header>

        <div v-if="sources.length === 0" class="empty">
          <h3>Where does your data live?</h3>
          <p>
            Choose a source to get started, or browse all
            {{ catalog.connectors.length }} connectors.
          </p>
          <div class="quick">
            <button
              v-for="c in quickPicks"
              :key="c.id"
              class="quick-card"
              @click="view = { name: 'setup', connector: c }"
            >
              <span class="monogram" aria-hidden="true">{{
                c.name.charAt(0)
              }}</span>
              {{ c.name }}
            </button>
          </div>
          <button class="btn-primary" @click="view = { name: 'gallery' }">
            Browse all connectors
          </button>
        </div>

        <ul v-else class="sources">
          <li v-for="s in sources" :key="s.id" class="source">
            <div class="source-head">
              <span class="monogram" aria-hidden="true">{{
                s.name.charAt(0)
              }}</span>
              <div class="source-text">
                <strong>{{ s.name }}</strong>
                <small>
                  {{ connectorFor(s.type)?.name ?? s.type }} ·
                  <template v-if="refreshing[s.id]"
                    >{{ refreshing[s.id] }}
                    <RunningTimer
                      class="timer"
                      :can-stop="!processing.has(s.id)"
                      @stop="stopLoad(s)"
                  /></template>
                  <template v-else-if="s.lastLoadedAt">
                    {{ s.tables.length }}
                    {{ s.tables.length === 1 ? 'table' : 'tables' }}, loaded
                    {{ timeAgo(s.lastLoadedAt) }}
                  </template>
                  <template v-else>Not loaded yet</template>
                </small>
              </div>

              <div
                v-if="confirmingRemove === s.id"
                class="source-actions confirm"
              >
                <span>Remove this source and its tables?</span>
                <button class="danger" @click="remove(s)">Remove</button>
                <button class="btn-ghost" @click="confirmingRemove = null">
                  Keep
                </button>
              </div>
              <div v-else class="source-actions">
                <button
                  class="btn-ghost"
                  :disabled="s.id in refreshing"
                  @click="refresh(s)"
                >
                  {{
                    s.id in refreshing
                      ? 'Loading…'
                      : s.lastLoadedAt
                        ? 'Refresh'
                        : 'Load'
                  }}
                </button>
                <button
                  class="btn-ghost"
                  :disabled="s.id in refreshing"
                  @click="edit(s)"
                >
                  Edit
                </button>
                <button
                  class="btn-ghost"
                  :disabled="s.id in refreshing"
                  @click="confirmingRemove = s.id"
                >
                  Remove
                </button>
              </div>
            </div>

            <p v-if="refreshErrors[s.id]" class="box-error error" role="alert">
              {{ refreshErrors[s.id] }}
            </p>

            <div v-if="s.tables.length" class="table-chips">
              <button
                v-for="t in s.tables"
                :key="t"
                class="chip"
                @click="
                  view = {
                    name: 'preview',
                    table: t,
                    returnTo: { name: 'overview' },
                  }
                "
              >
                {{ t }}
              </button>
            </div>
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>

<style scoped>
.timer {
  margin-left: 8px;
}

.get-data {
  width: 100%;
  max-width: 1100px;
  margin: 0 auto;
  padding: 32px 36px 48px;
}

.status {
  color: var(--ink-muted);
}

.error {
  margin: 8px 0 0;
  white-space: pre-wrap;
}

.overview {
  display: flex;
  flex-direction: column;
  gap: 22px;
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.head h2 {
  font-size: 30px;
}

.head p {
  margin: 6px 0 0;
  color: var(--ink-muted);
}

.btn-primary {
  white-space: nowrap;
}

.source-actions .btn-ghost {
  font-size: 13px;
}

.danger {
  padding: 6px 12px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--danger);
  color: var(--surface);
  font-size: 13px;
  font-weight: 600;
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 48px 24px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface);
  text-align: center;
}

.empty h3 {
  font-size: 22px;
}

.empty p {
  margin: 0;
  color: var(--ink-muted);
}

.quick {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
  margin: 8px 0;
}

.quick-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px 10px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  font-weight: 600;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}

.quick-card:hover {
  border-color: var(--ink-faint);
  box-shadow: var(--shadow-md);
}

.monogram {
  display: grid;
  place-items: center;
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  color: var(--accent);
  font-family: var(--font-display);
  font-weight: var(--display-weight);
  font-size: 15px;
}

.sources {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.source {
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
}

.source-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}

.source-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 200px;
}

.source-text strong {
  font-weight: 600;
}

.source-text small {
  color: var(--ink-muted);
  font-size: 12px;
}

.source-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.confirm span {
  color: var(--ink-muted);
  font-size: 13px;
}

.table-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.chip {
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  font-family: var(--font-mono);
  font-size: 12px;
}

.chip:hover {
  border-color: var(--accent);
  color: var(--accent);
}
</style>
