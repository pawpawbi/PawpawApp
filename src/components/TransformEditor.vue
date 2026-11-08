<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useUnsavedGuard } from '../composables/useUnsavedGuard';
import { errorMessage } from '../errors';
import { NAME, NAME_RULE } from '../shared/ids';
import type { TableKind, TablePreview, TableSchema } from '../shared/types';
import CodeEditor from './CodeEditor.vue';
import DataGrid from './data/DataGrid.vue';

const props = defineProps<{
  /**
   * kind "loaded": the loaded table whose in-place transform to edit.
   * kind "transformed": the transformed table to edit, or null to create a new one.
   */
  table: string | null;
  kind: TableKind;
  /** All tables, for the reference panel. */
  tables: TableSchema[];
}>();
const emit = defineEmits<{ back: []; changed: [] }>();

const isTransformed = props.kind === 'transformed';
/** Set once a new transformed table has been created; later saves change that table. */
const createdName = ref<string | null>(null);
const tableName = computed(() => props.table ?? createdName.value);
const newName = ref('');

const firstTable =
  props.tables.find((t) => !isTransformed || t.name !== props.table)?.name ??
  'table_name';
const defaultSql = () =>
  `SELECT *\nFROM ${props.table && !isTransformed ? props.table : firstTable}`;

const sql = ref('');
const savedSql = ref<string | null>(null);
const preview = ref<TablePreview | null>(null);
const error = ref('');
const notice = ref('');
const busy = ref<'' | 'preview' | 'apply' | 'remove'>('');
const editor = ref<InstanceType<typeof CodeEditor> | null>(null);
const expanded = ref<Set<string>>(
  new Set(props.table && !isTransformed ? [props.table] : []),
);

const hasUnappliedChanges = computed(
  () => sql.value.trim() !== (savedSql.value ?? defaultSql()).trim(),
);
const { confirmLeave } = useUnsavedGuard(
  hasUnappliedChanges,
  'Discard the changes to this query?',
);

function back() {
  if (confirmLeave()) emit('back');
}

// In-place transforms read loaded tables' original data, so only those are listed. Transformed
// tables can read any other table. The table being transformed comes first.
const referenceTables = computed(() => {
  const available = props.tables.filter((t) =>
    isTransformed ? t.name !== tableName.value : t.kind === 'loaded',
  );
  return [
    ...available.filter((t) => t.name === props.table),
    ...available.filter((t) => t.name !== props.table),
  ];
});

onMounted(async () => {
  try {
    if (!isTransformed && props.table) {
      savedSql.value = await window.api.data.getTransform(props.table);
    } else if (props.table) {
      const all = await window.api.data.listTransformed();
      savedSql.value = all.find((t) => t.name === props.table)?.sql ?? null;
    }
  } catch (err) {
    error.value = errorMessage(err);
  }
  sql.value = savedSql.value ?? defaultSql();
  editor.value?.focus();
  runPreview();
});

// --- Naming a new transformed table -------------------------------------------------------------

const takenNames = computed(() => new Set(props.tables.map((t) => t.name)));

/** "Comments & Posts!" → "comments_posts". Empty if nothing usable is left. */
function formatName(raw: string): string {
  let name = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (name && !/^[a-z]/.test(name)) name = `t_${name}`;
  return name.slice(0, 63).replace(/_+$/, '');
}

/** The name, or the name with _2, _3… added if a table already has it. */
function freeName(base: string): string {
  let name = base;
  for (let n = 2; takenNames.value.has(name); n++) name = `${base}_${n}`;
  return name;
}

/** A name from the tables the query reads: comments → comments_transformed,
 * comments and posts → comments_posts. */
const suggestedName = computed(() => {
  const read = [
    ...new Set(
      [...sql.value.matchAll(/\b(?:from|join)\s+"?([A-Za-z_][\w]*)"?/gi)]
        .map((m) => m[1].toLowerCase())
        .filter((name) => takenNames.value.has(name)),
    ),
  ];
  const base =
    read.length === 0
      ? 'new_table'
      : read.length === 1
        ? `${read[0]}_transformed`
        : read.slice(0, 3).join('_');
  return freeName(formatName(base));
});

/** Shown under the name field when the name can't be used, with a suggested fix. */
const nameProblem = ref<{ message: string; suggestion: string } | null>(null);
watch(newName, () => (nameProblem.value = null));

function checkName(raw: string): typeof nameProblem.value {
  if (!raw) {
    return {
      message: 'Enter a name for the table.',
      suggestion: suggestedName.value,
    };
  }
  if (!NAME.test(raw)) {
    return {
      message: NAME_RULE,
      suggestion: freeName(formatName(raw) || suggestedName.value),
    };
  }
  if (takenNames.value.has(raw)) {
    return {
      message: `There's already a table called ${raw}.`,
      suggestion: freeName(raw),
    };
  }
  return null;
}

function useName(name: string) {
  newName.value = name;
  nameProblem.value = null;
}

/** Creates the transformed table, or saves changes to it. */
async function saveTransformed() {
  if (busy.value) return;
  const isNew = tableName.value === null;
  if (isNew) {
    // Clicking Create again while a suggestion is showing (the name hasn't been edited since)
    // means "use the suggestion".
    if (nameProblem.value) useName(nameProblem.value.suggestion);
    nameProblem.value = checkName(newName.value.trim());
    if (nameProblem.value) return;
  }
  busy.value = 'apply';
  error.value = '';
  notice.value = '';
  const name = tableName.value ?? newName.value.trim();
  try {
    const { rows } = await window.api.data.saveTransformed({
      name,
      sql: sql.value,
      isNew,
    });
    savedSql.value = sql.value;
    if (isNew) createdName.value = name;
    emit('changed');
    preview.value = await window.api.data.previewTransform(
      sql.value,
      'transformed',
    );
    notice.value = isNew
      ? `Created ${name} with ${rows.toLocaleString()} rows.`
      : `Saved. ${name} now has ${rows.toLocaleString()} rows.`;
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    busy.value = '';
  }
}

async function runPreview() {
  if (busy.value) return;
  busy.value = 'preview';
  error.value = '';
  notice.value = '';
  removedSql.value = null;
  try {
    preview.value = await window.api.data.previewTransform(
      sql.value,
      props.kind,
    );
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    busy.value = '';
  }
}

async function apply() {
  if (busy.value) return;
  busy.value = 'apply';
  error.value = '';
  notice.value = '';
  removedSql.value = null;
  try {
    const { rows } = await window.api.data.applyTransform(
      props.table!,
      sql.value,
    );
    savedSql.value = sql.value;
    emit('changed');
    // Show the result of exactly what was applied, even if it wasn't previewed first.
    preview.value = await window.api.data.previewTransform(sql.value);
    notice.value = `Applied. ${props.table} now has ${rows.toLocaleString()} rows from this query.`;
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    busy.value = '';
  }
}

/** The query just removed, kept so the removal can be undone. */
const removedSql = ref<string | null>(null);

async function removeTransform() {
  if (busy.value || savedSql.value === null) return;
  busy.value = 'remove';
  error.value = '';
  const previous = savedSql.value;
  try {
    await window.api.data.removeTransform(props.table!);
    savedSql.value = null;
    sql.value = defaultSql();
    emit('changed');
    removedSql.value = previous;
    notice.value = `Transform removed. ${props.table} is back to its original data.`;
    preview.value = await window.api.data.previewTransform(sql.value);
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    busy.value = '';
  }
}

async function undoRemove() {
  const restored = removedSql.value;
  if (busy.value || restored === null) return;
  busy.value = 'apply';
  error.value = '';
  try {
    await window.api.data.applyTransform(props.table!, restored);
    savedSql.value = restored;
    sql.value = restored;
    removedSql.value = null;
    emit('changed');
    notice.value = 'Transform restored.';
    preview.value = await window.api.data.previewTransform(restored);
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    busy.value = '';
  }
}

/** Inserts a table or column name at the cursor. */
const insert = (text: string) => editor.value?.insert(text);

function toggle(table: string) {
  const next = new Set(expanded.value);
  if (next.has(table)) next.delete(table);
  else next.add(table);
  expanded.value = next;
}

/** Column names that need quoting in SQL get double quotes. */
const sqlName = (name: string) =>
  /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
</script>

<template>
  <div class="transform">
    <header class="head">
      <button class="btn-ghost" @click="back">← Back to model</button>
      <template v-if="!isTransformed">
        <h2>
          Transform <span class="table-name">{{ table }}</span>
        </h2>
        <span
          v-if="savedSql !== null"
          class="active-badge"
          title="This table currently shows the result of a SQL transform"
        >
          Transform active
        </span>
      </template>
      <h2 v-else-if="tableName">
        <span class="table-name transformed">{{ tableName }}</span>
        <small class="kind">Transformed table</small>
      </h2>
      <h2 v-else>New transformed table</h2>
    </header>

    <div class="body">
      <aside class="reference" aria-label="Tables and columns">
        <p class="reference-hint">Click a name to insert it.</p>
        <ul>
          <li v-for="t in referenceTables" :key="t.name">
            <div class="ref-table">
              <button
                class="chevron"
                :aria-expanded="expanded.has(t.name)"
                :aria-label="`Show columns of ${t.name}`"
                @click="toggle(t.name)"
              >
                {{ expanded.has(t.name) ? '▾' : '▸' }}
              </button>
              <button
                class="ref-name"
                :title="`Insert ${t.name}`"
                @click="insert(t.name)"
              >
                {{ t.name }}
              </button>
            </div>
            <ul v-if="expanded.has(t.name)" class="ref-columns">
              <li v-for="c in t.columns" :key="c.name">
                <button
                  :title="`${c.name} (${c.type})`"
                  @click="insert(sqlName(c.name))"
                >
                  {{ c.name }}
                </button>
              </li>
            </ul>
          </li>
        </ul>
      </aside>

      <section class="work">
        <div class="editor-wrap">
          <CodeEditor
            ref="editor"
            v-model="sql"
            class="editor"
            aria-label="SQL query"
            min-height="160px"
            @run="runPreview"
          />
          <p v-if="isTransformed" class="editor-note">
            One SELECT query. It can read any other table by name, loaded or
            transformed, as shown in the model (so joins work). DuckDB SQL.
          </p>
          <p v-else class="editor-note">
            One SELECT query. It reads loaded tables' original data by name (so
            joins work). DuckDB SQL.
          </p>
        </div>

        <div v-if="isTransformed && !tableName" class="name-row">
          <label class="name-field">
            Table name
            <input
              v-model="newName"
              type="text"
              :placeholder="`e.g. ${suggestedName}`"
              spellcheck="false"
              @keydown.enter="saveTransformed"
            />
          </label>
          <p v-if="nameProblem" class="name-problem" role="alert">
            {{ nameProblem.message }}
            <button class="suggestion" @click="useName(nameProblem.suggestion)">
              Use {{ nameProblem.suggestion }}
            </button>
          </p>
        </div>

        <div class="actions">
          <button
            class="btn-ghost"
            :disabled="!!busy"
            title="Run (Ctrl+Enter)"
            @click="runPreview"
          >
            {{ busy === 'preview' ? 'Running…' : 'Run preview' }}
          </button>
          <button
            v-if="isTransformed"
            class="btn-primary"
            :disabled="!!busy || (!hasUnappliedChanges && savedSql !== null)"
            @click="saveTransformed"
          >
            {{
              busy === 'apply'
                ? 'Saving…'
                : tableName
                  ? 'Save changes'
                  : 'Create table'
            }}
          </button>
          <button
            v-else
            class="btn-primary"
            :disabled="!!busy || (!hasUnappliedChanges && savedSql !== null)"
            @click="apply"
          >
            {{ busy === 'apply' ? 'Applying…' : 'Apply transform' }}
          </button>
          <button
            v-if="!isTransformed && savedSql !== null"
            class="btn-link danger"
            :disabled="!!busy"
            @click="removeTransform"
          >
            Remove transform
          </button>
          <span
            v-if="hasUnappliedChanges && savedSql !== null"
            class="unapplied"
            >Changes not applied yet</span
          >
        </div>

        <p v-if="error" class="box-error error" role="alert">{{ error }}</p>
        <p v-else-if="notice" class="box-notice notice" role="status">
          {{ notice }}
          <button
            v-if="removedSql !== null"
            class="undo"
            :disabled="!!busy"
            @click="undoRemove"
          >
            Undo
          </button>
        </p>

        <DataGrid v-if="preview" class="results" :preview="preview" />
      </section>
    </div>
  </div>
</template>

<style scoped>
.transform {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
  padding: 28px 36px 32px;
}

.head {
  display: flex;
  align-items: center;
  gap: 14px;
}

.head h2 {
  font-size: 26px;
}

.table-name {
  color: var(--accent);
}

.table-name.transformed {
  color: var(--transformed);
}

.kind {
  margin-left: 10px;
  color: var(--ink-muted);
  font-family: var(--font-body);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0;
}

.name-field {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}

.name-field input {
  width: 280px;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  font-family: var(--font-mono);
  font-size: 13px;
}

.name-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.name-problem {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin: 0;
  color: var(--danger);
  font-size: 13px;
}

.suggestion {
  padding: 3px 10px;
  border: 1px solid var(--transformed);
  border-radius: var(--radius-sm);
  background: var(--transformed-soft);
  color: var(--transformed);
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
}

.active-badge {
  padding: 3px 10px;
  border-radius: var(--radius-sm);
  background: var(--success-soft);
  color: var(--success);
  font-size: 12px;
  font-weight: 600;
}

.body {
  display: flex;
  flex: 1;
  gap: 18px;
  min-height: 0;
}

.reference {
  flex: none;
  width: 220px;
  overflow-y: auto;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.reference ul {
  margin: 0;
  padding: 0;
  list-style: none;
}

.reference-hint {
  margin: 0 0 8px;
  color: var(--ink-faint);
  font-size: 11px;
}

.ref-table {
  display: flex;
  align-items: center;
}

.ref-table button,
.ref-columns button {
  border: none;
  background: none;
  text-align: left;
}

.chevron {
  width: 20px;
  padding: 2px 0;
  color: var(--ink-faint);
}

.ref-name {
  flex: 1;
  overflow: hidden;
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  font-weight: 600;
  font-size: 13px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.ref-columns {
  margin: 0 0 6px 20px !important;
}

.ref-columns button {
  width: 100%;
  overflow: hidden;
  padding: 3px 6px;
  border-radius: var(--radius-sm);
  color: var(--ink-muted);
  font-family: var(--font-mono);
  font-size: 12px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.ref-name:hover,
.ref-columns button:hover {
  background: var(--surface-muted);
  color: var(--ink);
}

.work {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  min-height: 0;
}

.editor {
  height: 200px;
}

.editor-note {
  margin: 6px 0 0;
  color: var(--ink-faint);
  font-size: 12px;
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.unapplied {
  color: var(--ink-muted);
  font-size: 12px;
}

.error {
  font-family: var(--font-mono);
  font-size: 12px;
  white-space: pre-wrap;
}

.notice {
  display: flex;
  align-items: center;
  gap: 12px;
}

.undo {
  margin-left: auto;
  padding: 4px 12px;
  border: 1px solid var(--success);
  border-radius: var(--radius-sm);
  background: none;
  color: var(--success);
  font-weight: 600;
}

.undo:hover:not(:disabled) {
  background: var(--success-soft);
}

.results {
  flex: 1;
  min-height: 160px;
}
</style>
