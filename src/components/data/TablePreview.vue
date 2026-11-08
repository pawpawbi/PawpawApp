<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { errorMessage } from '../../errors';
import { plain } from '../../plain';
import type { DataSource, TablePreview } from '../../shared/types';
import DataGrid from './DataGrid.vue';

const props = defineProps<{
  table: string;
  /** The data source the table came from; shows Refresh and Edit source buttons when set. */
  source?: DataSource;
}>();
const emit = defineEmits<{ back: []; edit: []; refreshed: [] }>();

const PREVIEW_ROWS = 200;
const preview = ref<TablePreview | null>(null);
const error = ref('');
const refreshing = ref(false);
const progress = ref('');
const notice = ref('');

async function loadPreview() {
  try {
    preview.value = await window.api.data.previewTable(
      props.table,
      PREVIEW_ROWS,
    );
  } catch (err) {
    error.value = errorMessage(err);
  }
}

onMounted(loadPreview);

const unsubscribe = window.api.data.onProgress((p) => {
  if (refreshing.value && p.sourceId === props.source?.id)
    progress.value = p.message;
});
onBeforeUnmount(unsubscribe);

/** Reloads the table's data source (all of its tables), then this preview. */
async function refresh() {
  const source = props.source;
  if (!source || refreshing.value) return;
  refreshing.value = true;
  progress.value = 'Starting…';
  error.value = '';
  notice.value = '';
  try {
    const tables = await window.api.data.load(
      source.id,
      plain(source.resources),
    );
    const loaded = tables.find((t) => t.name === props.table);
    if (!loaded) {
      error.value = `${source.name} no longer has a table called ${props.table}.`;
      preview.value = null;
    } else {
      notice.value = loaded.transformError
        ? "Refreshed, but this table's SQL transform failed, so it shows the original data. Fix the transform in Model data."
        : `Refreshed from ${source.name}.`;
      await loadPreview();
    }
    emit('refreshed');
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    refreshing.value = false;
  }
}
</script>

<template>
  <div class="preview">
    <header class="head">
      <button class="btn-ghost" @click="$emit('back')">← Back</button>
      <h2>{{ table }}</h2>
      <span v-if="preview" class="meta">
        {{ preview.row_count.toLocaleString() }} rows ·
        {{ preview.columns.length }} columns
      </span>
      <div v-if="source" class="actions">
        <button
          class="btn-ghost action"
          :disabled="refreshing"
          :title="`Reload all tables from ${source.name}`"
          @click="refresh"
        >
          <svg
            class="icon"
            viewBox="0 0 24 24"
            aria-hidden="true"
            :class="{ spinning: refreshing }"
          >
            <path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5" />
          </svg>
          {{ refreshing ? 'Refreshing…' : 'Refresh' }}
        </button>
        <button
          class="btn-ghost action"
          :disabled="refreshing"
          :title="`Edit the ${source.name} data source`"
          @click="$emit('edit')"
        >
          <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
          </svg>
          Edit source
        </button>
      </div>
    </header>

    <p v-if="refreshing" class="status" aria-live="polite">{{ progress }}</p>
    <p v-if="error" class="box-error" role="alert">{{ error }}</p>
    <p v-else-if="notice" class="box-notice" role="status">{{ notice }}</p>
    <p v-if="!preview && !error" class="loading">Loading preview…</p>
    <DataGrid v-if="preview" class="data" :preview="preview" />
  </div>
</template>

<style scoped>
.preview {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
}

.head {
  display: flex;
  align-items: baseline;
  gap: 14px;
}

.head h2 {
  font-size: 24px;
  overflow-wrap: anywhere;
}

.meta {
  color: var(--ink-muted);
  font-size: 13px;
  white-space: nowrap;
}

.actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
  align-self: center;
}

.action {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.action .icon {
  width: 15px;
  height: 15px;
}

.spinning {
  animation: spin 1s linear infinite;
}

.data {
  max-height: calc(100vh - 220px);
}

.status,
.loading {
  margin: 0;
  color: var(--ink-muted);
}
</style>
